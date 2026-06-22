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
 * CMP signatures — data-driven so adding a provider is one entry, not a code branch.
 * A signature matches if ANY of its signals is present (each signal is independent and
 * robust on its own). Signals are evaluated in the page context.
 *
 * Ordered most-specific first; the generic IAB TCF API check is last so a named CMP wins.
 * Signals anchored to live DOM (verified 2026-06-22):
 *   - WPConsent: window.WPConsent global (rich API object), #wpconsent-root /
 *     #wpconsent-container, and the plugin script path. The banner UI is injected
 *     dynamically only when display checks pass, so the global/container/script are the
 *     reliable signals — NOT the rendered buttons.
 */
export interface CmpSignature {
  name: string;
  globals: string[];
  selectors: string[];
}

export const CMP_SIGNATURES: CmpSignature[] = [
  {
    name: "WPConsent",
    globals: ["WPConsent", "wpconsent"],
    selectors: ["#wpconsent-root", "#wpconsent-container", 'script[src*="wpconsent"]'],
  },
  {
    name: "Pressidium Cookie Consent",
    globals: ["pressidiumCookieConsent", "onPressidiumCookieConsentUpdated"],
    selectors: ['script[src*="pressidium-cookie-consent"]', '[id*="cookie-consent-client"]'],
  },
  {
    // Open-source CookieConsent by Orest Bida (also the engine Pressidium wraps); checked
    // after Pressidium so the specific plugin wins. Used standalone on many sites.
    name: "CookieConsent (Orest Bida)",
    globals: ["initCookieConsent", "CookieConsent"],
    selectors: ['script[src*="cookieconsent"]', "#cc-main", "#cc--main", ".cc-window"],
  },
  {
    name: "OneTrust",
    globals: ["OneTrust"],
    selectors: ["#onetrust-banner-sdk", 'script[src*="onetrust"]', 'script[src*="cookielaw.org"]'],
  },
  { name: "Cookiebot", globals: ["Cookiebot"], selectors: ["#CybotCookiebotDialog", 'script[src*="cookiebot"]'] },
  { name: "Complianz", globals: ["Complianz", "complianz"], selectors: ["#cmplz-cookiebanner-container", ".cmplz-cookiebanner"] },
  { name: "Borlabs Cookie", globals: ["BorlabsCookie"], selectors: ["#BorlabsCookieBox", "._brlbs-bar"] },
  { name: "CookieYes", globals: [], selectors: ["#cookie-law-info-bar", 'script[src*="cookieyes"]'] },
  { name: "Osano", globals: ["Osano"], selectors: [".osano-cm-window", 'script[src*="osano"]'] },
  { name: "Usercentrics", globals: ["UC_UI"], selectors: ['script[src*="usercentrics"]', "#usercentrics-root"] },
  { name: "Termly", globals: [], selectors: ['script[src*="termly"]', "#termly-code-snippet-support"] },
  // Generic fallback: any IAB TCF v2 CMP exposes the __tcfapi function (see §10 future note).
  { name: "IAB TCF CMP", globals: ["__tcfapi"], selectors: [] },
];

/**
 * Heuristic banner scan — independent of autoconsent. Identifies the CMP via signatures,
 * finds a visible consent container, and classifies its controls by accessible label.
 *
 * bannerPresent is true whenever a CMP is recognized OR a consent container is found — it
 * can never report "no banner" while reporting accept/reject/preferences controls, because
 * controls are only read from within a consent container. Controls are scoped to that
 * container (not the whole document) so a stray footer "Settings"/"Privacy" link can't
 * masquerade as a banner.
 */
export async function detectConsentUi(page: Page): Promise<ConsentUiInfo> {
  try {
    return await page.evaluate((signatures: CmpSignature[]) => {
      const ACCEPT = /\b(accept|allow|agree|got it|i understand|enable|yes)\b/i;
      // "necessary"/"essential" catches reject-equivalents like "Accept necessary" / "Only essential".
      const REJECT = /\b(reject|decline|deny|refuse|disagree|necessary|essential|no thanks|opt[- ]?out)\b/i;
      const SETTINGS = /\b(settings|preferences|manage|customi[sz]e|options|choices|configure)\b/i;
      const CONTAINER_HINT = /(cookie|consent|gdpr|\bcmp\b|onetrust|cookiebot|complianz|borlabs|wpconsent|cookieyes|termly|osano|usercentrics)/i;

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };

      // CMP detection — data-driven, any signal matches.
      let cmp: string | null = null;
      for (const sig of signatures) {
        const hasGlobal = sig.globals.some((k) => Boolean((window as any)[k]));
        const hasSelector = sig.selectors.some((sel) => {
          try {
            return Boolean(document.querySelector(sel));
          } catch {
            return false;
          }
        });
        if (hasGlobal || hasSelector) {
          cmp = sig.name;
          break;
        }
      }

      // Find a visible consent container.
      let banner: Element | null = null;
      const containers = Array.from(
        document.querySelectorAll(
          '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i],[aria-label*="cookie" i],[role="dialog"],[role="alertdialog"]',
        ),
      );
      for (const c of containers) {
        if (!isVisible(c)) continue;
        const sig = `${c.id} ${c.className} ${c.getAttribute("aria-label") ?? ""}`;
        if (CONTAINER_HINT.test(sig)) {
          banner = c;
          break;
        }
      }

      // Classify controls ONLY within the consent container, by label/role.
      let acceptAll = false;
      let rejectAll = false;
      let settings = false;
      if (banner) {
        const controls = Array.from(banner.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'));
        const texts = controls
          .filter((el) => isVisible(el))
          .map((el) => (el.textContent || (el as HTMLInputElement).value || "").trim())
          .filter(Boolean);
        acceptAll = texts.some((t) => ACCEPT.test(t));
        rejectAll = texts.some((t) => REJECT.test(t));
        settings = texts.some((t) => SETTINGS.test(t));
      }

      return {
        bannerPresent: cmp !== null || banner !== null,
        acceptAll,
        rejectAll,
        settings,
        cmpIdentified: cmp,
      };
    }, CMP_SIGNATURES);
  } catch {
    return { bannerPresent: false, acceptAll: false, rejectAll: false, settings: false, cmpIdentified: null };
  }
}
