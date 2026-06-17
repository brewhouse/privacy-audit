import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { detectConsentUi, runAutoconsent } from "./consent.js";
import type {
  CapturePass,
  CapturedCookie,
  CapturedRequest,
  CapturedScript,
  ConsentModeSignals,
  PageCapture,
} from "./types.js";

const NAV_TIMEOUT = 30000;
const SETTLE_MS = 3500; // let deferred/GTM-injected requests fire

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Close a context, bounding the wait. Closing a context with recordHar flushes the HAR
 * to disk, which can hang indefinitely if a response never completes (e.g. a map embed
 * holding a long-lived connection). Bounding it means we keep the page's captured data
 * (already in memory) instead of letting the whole page time out and be discarded.
 */
async function closeContextBounded(ctx: BrowserContext, ms: number, log: (m: string) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ctx.close(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`context close timed out after ${ms}ms`)), ms);
      }),
    ]);
  } catch (err) {
    log(`  context close: ${(err as Error).message} (HAR may be partial)`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A registrable-domain-ish comparison: same site if eTLD+1 matches (best-effort). */
function sameSite(a: string, b: string): boolean {
  const reg = (h: string) => h.split(".").slice(-2).join(".");
  return reg(a) === reg(b);
}

const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|$)/i;

/** Accumulates network requests for one capture pass via a request listener. */
class RequestRecorder {
  private records: CapturedRequest[] = [];
  constructor(private firstPartyHost: string) {}

  attach(page: Page) {
    page.on("request", (req) => {
      const url = req.url();
      const host = hostnameOf(url);
      if (!host || url.startsWith("data:") || url.startsWith("blob:")) return;
      const isThirdParty = !sameSite(host, this.firstPartyHost);
      const type = req.resourceType();
      this.records.push({
        url,
        domain: host,
        resourceType: type,
        isThirdParty,
        isFont: type === "font" || FONT_EXT.test(url),
      });
    });
  }

  drain(): CapturedRequest[] {
    const out = this.records;
    this.records = [];
    return out;
  }
}

/** Read cookies from the context and classify first/third party. */
async function readCookies(ctx: BrowserContext, firstPartyHost: string): Promise<CapturedCookie[]> {
  const cookies = await ctx.cookies();
  return cookies.map((c) => {
    const domain = c.domain.replace(/^\./, "");
    return {
      name: c.name,
      domain,
      party: sameSite(domain, firstPartyHost) ? "first" : "third",
      expiry: c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
    };
  });
}

/** Collect <script> sources and guess their injection origin (theme vs GTM vs plugin). */
async function readScripts(page: Page): Promise<CapturedScript[]> {
  try {
    return await page.$$eval("script", (els) =>
      els.map((s) => {
        const src = (s as HTMLScriptElement).src || null;
        const text = s.textContent || "";
        let hint: "theme" | "gtm" | "plugin" | "unknown" = "unknown";
        if (src) {
          if (/googletagmanager\.com\/gtm/.test(src)) hint = "gtm";
          else if (/\/wp-content\/themes\//.test(src)) hint = "theme";
          else if (/\/wp-content\/plugins\//.test(src)) hint = "plugin";
        } else if (/dataLayer|gtag\(/.test(text)) {
          hint = "gtm";
        } else if (text.trim()) {
          hint = "theme";
        }
        return { src, inline: !src, injectionHint: hint };
      }),
    );
  } catch {
    return [];
  }
}

/**
 * Detect Google Consent Mode v2 signals and the default state (CLAUDE.md §4.3, §6).
 * Presence ≠ gated: we record whether any default was set to "denied" vs "granted".
 */
async function detectConsentMode(page: Page): Promise<ConsentModeSignals> {
  try {
    return await page.evaluate(() => {
      const dl: any[] = (window as any).dataLayer || [];
      let present = false;
      let defaultDenied = false;
      let defaultGranted = false;
      for (const entry of dl) {
        // gtag('consent', 'default'|'update', {...}) lands in dataLayer as an arguments array.
        if (Array.isArray(entry) && entry[0] === "consent") {
          present = true;
          const params = entry[2] || {};
          for (const v of Object.values(params)) {
            if (v === "denied") defaultDenied = true;
            if (v === "granted") defaultGranted = true;
          }
        }
      }
      if ((window as any).google_tag_data?.ics) present = true;
      return { present, defaultDenied, defaultGranted };
    });
  } catch {
    return { present: false, defaultDenied: false, defaultGranted: false };
  }
}

async function settle(page: Page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS });
  } catch {
    /* networkidle may never fire on chatty pages; the timeout is the cap */
  }
  await page.waitForTimeout(500);
}

export interface CaptureOptions {
  outputDir: string;
  /** When false, skip the reject pass (v1 MVP without §4.4 reject test). */
  doReject: boolean;
  log: (m: string) => void;
}

/**
 * Capture one page across all consent passes (CLAUDE.md §4.2–§4.4).
 *
 *   pass 1 (fresh context): load, record pre-consent state, write HAR + screenshot
 *   pass 2 (same context):  autoconsent opt-in, re-record after accept
 *   pass 3 (fresh context): autoconsent opt-out, re-record after reject
 */
export async function capturePage(
  browser: Browser,
  url: string,
  index: number,
  opts: CaptureOptions,
): Promise<PageCapture> {
  const firstPartyHost = hostnameOf(url);
  const pathname = (() => {
    try {
      return new URL(url).pathname || "/";
    } catch {
      return url;
    }
  })();

  const evidenceDir = path.join(opts.outputDir, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const slug = `page-${String(index).padStart(3, "0")}`;
  const harPath = path.join(evidenceDir, `${slug}.har`);
  const screenshotPath = path.join(evidenceDir, `${slug}.png`);

  const empty: CapturePass = { requests: [], cookies: [], scripts: [] };
  const capture: PageCapture = {
    url,
    path: pathname,
    preConsent: { ...empty },
    afterAccept: { ...empty },
    afterReject: { ...empty },
    consentUi: { bannerPresent: false, acceptAll: false, rejectAll: false, settings: false, cmpIdentified: null },
    consentMode: { present: false, defaultDenied: false, defaultGranted: false },
    harPath: null,
    screenshotPath: null,
  };

  // ---- Pass 1 + 2: pre-consent and after-accept (shared context, HAR recorded) ----
  let ctx: BrowserContext | null = null;
  try {
    ctx = await browser.newContext({ recordHar: { path: harPath, content: "embed" } });
    const recorder = new RequestRecorder(firstPartyHost);
    const page = await ctx.newPage();
    recorder.attach(page);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await settle(page);

    // Pre-consent snapshot — captured BEFORE any interaction (§4.2).
    capture.preConsent = {
      requests: recorder.drain(),
      cookies: await readCookies(ctx, firstPartyHost),
      scripts: await readScripts(page),
    };
    capture.consentUi = await detectConsentUi(page);
    capture.consentMode = await detectConsentMode(page);

    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 20000 }).catch(() => {});
    capture.screenshotPath = screenshotPath;

    // Accept consent, then re-capture (§4.4).
    const accept = await runAutoconsent(page, "optIn", opts.log);
    if (accept.cmp && !capture.consentUi.cmpIdentified) capture.consentUi.cmpIdentified = accept.cmp;
    await settle(page);
    capture.afterAccept = {
      requests: recorder.drain(),
      cookies: await readCookies(ctx, firstPartyHost),
      scripts: [],
    };
  } catch (err) {
    capture.error = (err as Error).message;
    opts.log(`  capture error (accept pass): ${capture.error}`);
  } finally {
    if (ctx) {
      await closeContextBounded(ctx, 25000, opts.log); // flushes HAR to disk
      capture.harPath = harPath;
    }
  }

  // ---- Pass 3: reject in a FRESH context (§4.4) ----
  if (opts.doReject && !capture.error) {
    let rctx: BrowserContext | null = null;
    try {
      rctx = await browser.newContext();
      const recorder = new RequestRecorder(firstPartyHost);
      const page = await rctx.newPage();
      recorder.attach(page);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await settle(page);
      recorder.drain(); // discard pre-consent; we already have it
      await runAutoconsent(page, "optOut", opts.log);
      await settle(page);
      capture.afterReject = {
        requests: recorder.drain(),
        cookies: await readCookies(rctx, firstPartyHost),
        scripts: [],
      };
    } catch (err) {
      opts.log(`  capture error (reject pass): ${(err as Error).message}`);
    } finally {
      if (rctx) await closeContextBounded(rctx, 25000, opts.log);
    }
  }

  return capture;
}
