import { createRequire } from "node:module";
import type { Page } from "playwright";
import type { ConsentUiInfo } from "./types.js";

/**
 * Consent detection & automation (CLAUDE.md §4.3–§4.4).
 *
 * Two layers:
 *   1. @duckduckgo/autoconsent — detects a CMP across 100+ providers and executes
 *      opt-in / opt-out programmatically. This is what produces the before/after split.
 *   2. A heuristic DOM scan — independently records whether a banner is present and
 *      which controls (accept-all / reject-all / settings) it exposes, so the report's
 *      consentMechanism section is populated even when no autoconsent rule matches.
 *
 * NOTE: autoconsent's host-side wiring is version-sensitive. The integration below
 * follows autoconsent's documented messaging protocol (init → detect → opt-in/opt-out).
 * If the installed bundle exposes a different path, adjust `resolveAutoconsentBundle()`.
 * The heuristic layer keeps the tool functional regardless.
 */

const require = createRequire(import.meta.url);

function resolveAutoconsentBundle(): string | null {
  try {
    // IIFE content-script bundle, injected into the page via addScriptTag.
    return require.resolve("@duckduckgo/autoconsent/dist/autoconsent.playwright.js");
  } catch {
    return null;
  }
}

/**
 * CMP rule set the in-page bundle needs. autoconsent's `initialize(config, rules)`
 * detects nothing without these, so the host must supply them in the initResp.
 * Loaded once and reused across pages.
 */
let cachedRules: unknown | null = null;
function loadAutoconsentRules(): unknown | null {
  if (cachedRules) return cachedRules;
  try {
    cachedRules = require("@duckduckgo/autoconsent/rules/rules.json");
    return cachedRules;
  } catch {
    return null;
  }
}

export type ConsentAction = "optIn" | "optOut";

export interface ConsentResult {
  /** Whether autoconsent successfully performed the requested action. */
  performed: boolean;
  /** CMP name autoconsent identified, if any. */
  cmp: string | null;
}

interface AutoconsentMessage {
  type: string;
  cmp?: string;
  [k: string]: unknown;
}

/**
 * Inject autoconsent and run the requested action against the current page.
 * Resolves once autoconsent reports done/error or a timeout elapses.
 */
export async function runAutoconsent(
  page: Page,
  action: ConsentAction,
  log: (m: string) => void,
): Promise<ConsentResult> {
  const bundle = resolveAutoconsentBundle();
  if (!bundle) {
    log("  autoconsent bundle not resolvable — skipping automated consent");
    return { performed: false, cmp: null };
  }
  const rules = loadAutoconsentRules();

  const result: ConsentResult = { performed: false, cmp: null };

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, 12000);

    // Bridge: autoconsent (in-page) calls this binding to talk to us (host).
    // Must be registered BEFORE the bundle is injected, since the bundle calls
    // window.autoconsentSendMessage({type:"init"}) the moment it runs.
    const setup = async () => {
      await page.exposeBinding("autoconsentSendMessage", async (_src, raw: AutoconsentMessage) => {
        const msg = raw ?? { type: "" };
        switch (msg.type) {
          case "init":
            // Reply with config + rules; autoconsent then detects + acts via `autoAction`.
            await page
              .evaluate(
                ({ act, ruleSet }) => {
                  (window as any).autoconsentReceiveMessage?.({
                    type: "initResp",
                    config: {
                      enabled: true,
                      autoAction: act, // "optIn" | "optOut"
                      disabledCmps: [],
                      enablePrehide: false,
                      detectRetries: 20,
                    },
                    rules: ruleSet,
                  });
                },
                { act: action, ruleSet: rules },
              )
              .catch(() => {});
            break;
          case "cmpDetected":
          case "popupFound":
            if (msg.cmp) result.cmp = String(msg.cmp);
            break;
          case "optInResult":
          case "optOutResult":
            if (msg.result === true) result.performed = true;
            break;
          case "autoconsentDone":
            result.performed = true;
            clearTimeout(timer);
            finish();
            break;
          case "autoconsentError":
            log(`  autoconsent error: ${JSON.stringify(msg)}`);
            clearTimeout(timer);
            finish();
            break;
        }
      });

      // Inject the bundle; on construction it sends "init" through the binding above.
      await page.addScriptTag({ path: bundle });
    };

    setup().catch((err) => {
      log(`  autoconsent injection failed: ${(err as Error).message}`);
      clearTimeout(timer);
      finish();
    });
  });

  return result;
}

/**
 * Heuristic banner scan — independent of autoconsent. Looks for a visible
 * consent/cookie container and classifies its buttons by accessible text.
 */
export async function detectConsentUi(page: Page): Promise<ConsentUiInfo> {
  try {
    return await page.evaluate(() => {
      const ACCEPT = /\b(accept|allow|agree|got it|i understand|ok|enable|yes)\b/i;
      const REJECT = /\b(reject|decline|deny|refuse|disagree|necessary only|essential only|no thanks)\b/i;
      const SETTINGS = /\b(settings|preferences|manage|customi[sz]e|options|choices|configure)\b/i;
      const BANNER_HINT = /(cookie|consent|gdpr|privacy|cmp|onetrust|cookiebot|complianz|borlabs)/i;

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };

      // Find a plausible banner container.
      let banner: Element | null = null;
      const containers = Array.from(
        document.querySelectorAll(
          '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i],[role="dialog"],[role="alertdialog"]',
        ),
      );
      for (const c of containers) {
        if (isVisible(c) && BANNER_HINT.test(c.id + " " + c.className + " " + (c.getAttribute("aria-label") ?? ""))) {
          banner = c;
          break;
        }
      }

      const scope: ParentNode = banner ?? document;
      const controls = Array.from(scope.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'));
      const texts = controls
        .filter((el) => isVisible(el))
        .map((el) => (el.textContent || (el as HTMLInputElement).value || "").trim())
        .filter(Boolean);

      // Identify the CMP from globals/markup.
      let cmp: string | null = null;
      const w = window as any;
      if (w.OneTrust || document.getElementById("onetrust-banner-sdk")) cmp = "OneTrust";
      else if (w.Cookiebot || document.getElementById("CybotCookiebotDialog")) cmp = "Cookiebot";
      else if (w.Complianz || document.querySelector("#cmplz-cookiebanner-container")) cmp = "Complianz";
      else if (document.querySelector("#BorlabsCookieBox")) cmp = "Borlabs Cookie";
      else if (w.__tcfapi) cmp = "IAB TCF CMP";

      return {
        bannerPresent: banner !== null,
        acceptAll: texts.some((t) => ACCEPT.test(t)),
        rejectAll: texts.some((t) => REJECT.test(t)),
        settings: texts.some((t) => SETTINGS.test(t)),
        cmpIdentified: cmp,
      };
    });
  } catch {
    return { bannerPresent: false, acceptAll: false, rejectAll: false, settings: false, cmpIdentified: null };
  }
}
