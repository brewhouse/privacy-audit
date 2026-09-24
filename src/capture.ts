import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, Page, Request } from "playwright";
import { clickConsentControl, detectConsentUi, forceCmpBanner, runAutoconsent } from "./consent.js";
import { sameSite } from "./domain.js";
import { lookupVendor } from "./vendor-map.js";
import type {
  CapturePass,
  CapturedCookie,
  CapturedRequest,
  CapturedScript,
  ConsentModeSignals,
  GpcProbe,
  PageCapture,
} from "./types.js";

const NAV_TIMEOUT = 30000;
const SETTLE_MS = 3500; // let deferred/GTM-injected requests fire

// Present as a regulated-region (UK) visitor so geo-targeted consent banners are more
// likely to display. Kept English (en-GB) so label-based control detection still works.
// Note: this changes browser locale/timezone, not the egress IP — IP-geolocated CMPs may
// still withhold the banner from our scan location (reported as such).
// ignoreHTTPSErrors so a cert problem (e.g. a cert that omits the www host) doesn't blank
// the whole scan — otherwise pages fail to load and the site falsely scores 100/100.
const CAPTURE_CONTEXT = { locale: "en-GB", timezoneId: "Europe/London", ignoreHTTPSErrors: true } as const;
// We write the HAR ourselves (see RequestRecorder), so context close no longer flushes
// anything and stays fast even on pages with never-ending connections.
const CONTEXT_CLOSE_TIMEOUT_MS = 15000;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Close a context, bounding the wait as a safety net. We no longer record the HAR via
 * Playwright (we build it ourselves), so close should be fast — but a stuck page or
 * service worker could still delay teardown, and we don't want that to discard the page.
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

const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|$)/i;

/** Turn a URL pathname into a filesystem-safe, traceable slug ("/" → "home"). */
function slugifyPath(pathname: string): string {
  const slug = pathname
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "home";
}

interface HarPair {
  name: string;
  value: string;
}
interface HarReqMeta {
  startedDateTime: string;
  start: number;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  postDataSize: number;
  time?: number;
  status?: number;
  statusText?: string;
  resHeaders?: Record<string, string>;
  mimeType?: string;
  failed?: string;
}

function toPairs(h: Record<string, string>): HarPair[] {
  return Object.entries(h).map(([name, value]) => ({ name, value }));
}
function queryString(url: string): HarPair[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/**
 * Accumulates network activity for the page lifecycle and builds a self-contained HAR.
 *
 * We build the HAR ourselves from request/response events (metadata only — no response
 * bodies) rather than using Playwright's recordHar, whose flush on context close can hang
 * indefinitely when a response never completes (e.g. a map embed holding a connection
 * open). Here nothing is flushed at close time, so teardown can't hang; requests still
 * in flight are recorded as entries without a response.
 */
class RequestRecorder {
  private records: CapturedRequest[] = [];
  private har = new Map<Request, HarReqMeta>();
  /** Navigation start, so every request carries an offset for the consent timeline. */
  private t0 = Date.now();
  constructor(private firstPartyHost: string) {}

  /** Reset the timeline origin — call immediately before `page.goto`. */
  markNavigationStart() {
    this.t0 = Date.now();
  }

  attach(page: Page) {
    page.on("request", (req) => {
      const url = req.url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      const host = hostnameOf(url);
      if (host) {
        const type = req.resourceType();
        this.records.push({
          url,
          domain: host,
          resourceType: type,
          isThirdParty: !sameSite(host, this.firstPartyHost),
          isFont: type === "font" || FONT_EXT.test(url),
          firstSeenMs: Math.max(0, Date.now() - this.t0),
        });
      }
      const post = req.postData();
      this.har.set(req, {
        startedDateTime: new Date().toISOString(),
        start: Date.now(),
        method: req.method(),
        url,
        reqHeaders: req.headers(),
        postDataSize: post ? Buffer.byteLength(post) : 0,
      });
    });
    page.on("response", (res) => {
      const m = this.har.get(res.request());
      if (!m) return;
      m.status = res.status();
      m.statusText = res.statusText();
      m.resHeaders = res.headers();
      m.mimeType = res.headers()["content-type"] || "";
    });
    const finish = (req: Request) => {
      const m = this.har.get(req);
      if (m && m.time === undefined) m.time = Date.now() - m.start;
    };
    page.on("requestfinished", finish);
    page.on("requestfailed", (req) => {
      const m = this.har.get(req);
      if (m) {
        m.time = Date.now() - m.start;
        m.failed = req.failure()?.errorText ?? "failed";
      }
    });
  }

  drain(): CapturedRequest[] {
    const out = this.records;
    this.records = [];
    return out;
  }

  /** Build a HAR 1.2 document from everything seen so far (metadata only, no bodies). */
  toHar(pageUrl: string): string {
    const entries = [...this.har.values()].map((m) => ({
      startedDateTime: m.startedDateTime,
      time: m.time ?? 0,
      request: {
        method: m.method,
        url: m.url,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: toPairs(m.reqHeaders),
        queryString: queryString(m.url),
        headersSize: -1,
        bodySize: m.postDataSize,
      },
      response: {
        status: m.status ?? 0,
        statusText: m.statusText ?? (m.failed ? `(failed: ${m.failed})` : "(pending)"),
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: m.resHeaders ? toPairs(m.resHeaders) : [],
        content: { size: 0, mimeType: m.mimeType ?? "", comment: "response body omitted" },
        redirectURL: m.resHeaders?.location ?? "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: m.time ?? 0, receive: 0 },
      pageref: "page_1",
    }));
    return JSON.stringify(
      {
        log: {
          version: "1.2",
          creator: { name: "PlaneteriaPrivacyAudit", version: "0.1.0" },
          pages: [{ startedDateTime: new Date().toISOString(), id: "page_1", title: pageUrl, pageTimings: {} }],
          entries,
        },
      },
      null,
      2,
    );
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
export async function detectConsentMode(page: Page): Promise<ConsentModeSignals> {
  try {
    return await page.evaluate(() => {
      const dl: any[] = (window as any).dataLayer || [];
      let present = false;
      let defaultDenied = false;
      let defaultGranted = false;

      // gtag('consent', ...) pushes the function's `arguments` object — array-LIKE but not a
      // real Array, so Array.isArray() is false for it. Normalize both shapes or every
      // consent default is missed (and the site looks un-gated when it is not).
      const toArgs = (e: any): any[] | null => {
        if (Array.isArray(e)) return e;
        if (e && typeof e === "object" && typeof e.length === "number") return Array.prototype.slice.call(e);
        return null;
      };

      for (const raw of dl) {
        const entry = toArgs(raw);
        if (!entry || entry[0] !== "consent") continue;
        present = true;
        // Only the DEFAULT state answers "are tags gated before consent?" — an 'update'
        // call is the post-choice grant and must not be read as the default (§6).
        if (entry[1] !== "default") continue;
        const params = entry[2] || {};
        for (const v of Object.values(params)) {
          if (v === "denied") defaultDenied = true;
          if (v === "granted") defaultGranted = true;
        }
      }
      if ((window as any).google_tag_data?.ics) present = true;
      return { present, defaultDenied, defaultGranted };
    });
  } catch {
    return { present: false, defaultDenied: false, defaultGranted: false };
  }
}

/**
 * Find linked privacy / cookie policies and the US state-privacy opt-out link.
 *
 * The opt-out link is what CCPA/CPRA-style laws expect where personal information is sold
 * or shared for cross-context behavioral advertising — conventionally labelled "Do Not
 * Sell or Share My Personal Information" or "Your Privacy Choices". Its absence is a
 * concrete, automatable observation, so we report it rather than leaving US-law coverage
 * to the manual step.
 */
export async function detectPolicyLinks(page: Page): Promise<{ privacyPolicyUrl: string | null; cookiePolicyUrl: string | null; usOptOutLinkUrl: string | null }> {
  try {
    return await page.evaluate(() => {
      const cookieLabel = /cookie[\s-]?(policy|notice|statement|preferences?)/i;
      const cookieHref = /cookie-?(policy|notice)/i;
      const privacyLabel = /privacy[\s-]?(policy|notice|statement)|data\s?protection|datenschutz/i;
      const privacyHref = /privacy|datenschutz/i;
      // Fallback: policy hubs not literally labelled "privacy" that conventionally hold the
      // privacy statement (e.g. "Website Policies" -> /website-policies/, "Legal"). Used only
      // when no explicit privacy link is found. Kept conservative (no bare "terms"/"policies").
      // A bare "Policies" / "Policies & Notices" footer hub is the common home for the
      // privacy statement on municipal and agency sites (observed on transit-agency
      // audits), so it counts as a last-resort candidate — but only as a short link
      // label, never from arbitrary body copy.
      const genericPolicyLabel = /^\s*polic(y|ies)\b|\b(website|site)\s+polic(y|ies)\b|\blegal\s+(notice|information)\b/i;
      const genericPolicyHref = /(website|site)-?polic(y|ies)|\/polic(y|ies)(?:[/#?]|$)|\/legal(?:[/#?]|$)/i;
      // US state-privacy opt-out ("Do Not Sell or Share…", "Your Privacy Choices",
      // "Limit the Use of My Sensitive Personal Information"). "sell"/"share" must be
      // directly followed by "my" (optionally via "or share my") — real CCPA/CPRA controls
      // always phrase it as "sell MY ...". Without that anchor, "do not sell" false-positives
      // on ordinary body copy (e.g. an ORCA retail page reading "Stores do not sell pass
      // products.", whose nearby "read more" link then gets misreported as the opt-out
      // control — confirmed live on info.myorca.com).
      const usOptOutLabel =
        /do\s+not\s+sell\s+(or\s+share\s+)?my\b|do\s+not\s+share\s+my\b|your\s+privacy\s+choices|limit\s+the\s+use\s+of\s+my\s+sensitive|opt[-\s]?out\s+of\s+(sale|sharing)/i;
      const usOptOutHref = /do-?not-?sell|privacy-?choices|ccpa|cpra|opt-?out/i;
      let privacy: string | null = null;
      let cookie: string | null = null;
      let genericPolicy: string | null = null;
      let usOptOut: string | null = null;
      for (const a of Array.from(document.querySelectorAll("a[href],button"))) {
        const text = (a.textContent || "").trim();
        const href = a instanceof HTMLAnchorElement ? a.href : "";
        // A "Your Privacy Choices" control is often a button that opens a CMP panel
        // rather than a link, so accept either; record "#" when there is no URL.
        if (!usOptOut && (usOptOutLabel.test(text) || (href && usOptOutHref.test(href)))) {
          usOptOut = href || "(in-page control)";
        }
        if (!href || href.startsWith("javascript:")) continue;
        if (!cookie && (cookieLabel.test(text) || cookieHref.test(href))) cookie = href;
        else if (!privacy && (privacyLabel.test(text) || privacyHref.test(href))) privacy = href;
        else if (!genericPolicy && (genericPolicyLabel.test(text) || genericPolicyHref.test(href))) genericPolicy = href;
        if (privacy && cookie && usOptOut) break;
      }
      return { privacyPolicyUrl: privacy ?? genericPolicy, cookiePolicyUrl: cookie, usOptOutLinkUrl: usOptOut };
    });
  } catch {
    return { privacyPolicyUrl: null, cookiePolicyUrl: null, usOptOutLinkUrl: null };
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
  /**
   * Run the Global Privacy Control pass on this page. It costs an extra page load, so the
   * caller enables it only for the representative page rather than site-wide.
   */
  doGpc?: boolean;
  log: (m: string) => void;
}

/** Non-essential services (by vendor map) seen in a pass — the unit the GPC test compares. */
function nonEssentialServices(requests: CapturedRequest[]): Set<string> {
  const out = new Set<string>();
  for (const r of requests) {
    if (!r.isThirdParty) continue;
    const v = lookupVendor(r.url);
    if (v && !v.cookieless && (v.category === "analytics" || v.category === "marketing" || v.category === "non-essential")) {
      out.add(v.name);
    }
  }
  return out;
}

/**
 * Global Privacy Control pass (§4.3 "gpcHonored").
 *
 * Loads the page in a fresh context that both sends the `Sec-GPC: 1` request header and
 * exposes `navigator.globalPrivacyControl === true`, then compares which non-essential
 * services still fire against the no-GPC baseline. Reporting "not tested" while the field
 * exists in the report is worse than not having the field, so this actually runs it.
 *
 * `honored` is null when the baseline had nothing non-essential to suppress — there is
 * nothing to conclude, which is different from "not honored".
 */
async function runGpcPass(
  browser: Browser,
  url: string,
  baseline: Set<string>,
  opts: CaptureOptions,
): Promise<GpcProbe> {
  const firstPartyHost = hostnameOf(url);
  let ctx: BrowserContext | null = null;
  try {
    ctx = await browser.newContext({ ...CAPTURE_CONTEXT, extraHTTPHeaders: { "Sec-GPC": "1" } });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "globalPrivacyControl", { get: () => true, configurable: true });
    });
    const recorder = new RequestRecorder(firstPartyHost);
    const page = await ctx.newPage();
    recorder.attach(page);
    recorder.markNavigationStart();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await settle(page);
    const withGpc = nonEssentialServices(recorder.drain());
    const persisted = [...baseline].filter((n) => withGpc.has(n)).sort();
    const suppressed = [...baseline].filter((n) => !withGpc.has(n)).sort();
    return {
      tested: true,
      honored: baseline.size === 0 ? null : persisted.length === 0,
      suppressed,
      persisted,
    };
  } catch (err) {
    opts.log(`  capture error (GPC pass): ${(err as Error).message}`);
    return { tested: false, honored: null, suppressed: [], persisted: [] };
  } finally {
    if (ctx) await closeContextBounded(ctx, CONTEXT_CLOSE_TIMEOUT_MS, opts.log);
  }
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
  // Index prefix keeps files ordered and unique; the path slug makes them traceable.
  const slug = `${String(index).padStart(3, "0")}-${slugifyPath(pathname)}`;
  const harPath = path.join(evidenceDir, `${slug}.har`);
  const screenshotPath = path.join(evidenceDir, `${slug}.png`);

  const empty: CapturePass = { requests: [], cookies: [], scripts: [] };
  const capture: PageCapture = {
    url,
    path: pathname,
    capturedAt: new Date().toISOString(),
    preConsent: { ...empty },
    afterAccept: { ...empty },
    afterReject: { ...empty },
    consentUi: { bannerPresent: false, acceptAll: false, rejectAll: false, settings: false, cmpIdentified: null },
    consentMode: { present: false, defaultDenied: false, defaultGranted: false },
    harPath: null,
    screenshotPath: null,
    privacyPolicyUrl: null,
    cookiePolicyUrl: null,
    usOptOutLinkUrl: null,
    gpc: { tested: false, honored: null, suppressed: [], persisted: [] },
  };

  // ---- Pass 1 + 2: pre-consent and after-accept (shared context) ----
  let ctx: BrowserContext | null = null;
  let recorder: RequestRecorder | null = null;
  try {
    ctx = await browser.newContext({ ...CAPTURE_CONTEXT });
    recorder = new RequestRecorder(firstPartyHost);
    const page = await ctx.newPage();
    recorder.attach(page);
    recorder.markNavigationStart();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await settle(page);

    // Pre-consent snapshot — captured BEFORE any interaction (§4.2).
    capture.preConsent = {
      requests: recorder.drain(),
      cookies: await readCookies(ctx, firstPartyHost),
      scripts: await readScripts(page),
    };
    const policies = await detectPolicyLinks(page);
    capture.privacyPolicyUrl = policies.privacyPolicyUrl;
    capture.cookiePolicyUrl = policies.cookiePolicyUrl;
    capture.usOptOutLinkUrl = policies.usOptOutLinkUrl;
    capture.consentUi = await detectConsentUi(page);
    // If a CMP is present but its banner didn't render (no controls seen), ask it to show
    // and re-scan — captures accept/reject/preferences labels for the report when possible.
    const ui = capture.consentUi;
    if (ui.cmpIdentified && !(ui.acceptAll || ui.rejectAll || ui.settings)) {
      await forceCmpBanner(page);
      await page.waitForTimeout(1200);
      const retry = await detectConsentUi(page);
      if (retry.acceptAll || retry.rejectAll || retry.settings) capture.consentUi = retry;
    }
    capture.consentMode = await detectConsentMode(page);

    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 20000 }).catch(() => {});
    capture.screenshotPath = screenshotPath;

    // Accept consent, then re-capture (§4.4).
    const accept = await runAutoconsent(page, "optIn", opts.log);
    if (accept.cmp && !capture.consentUi.cmpIdentified) capture.consentUi.cmpIdentified = accept.cmp;
    if (!accept.performed) {
      // autoconsent didn't act (no matching rule, or a shadow-DOM banner it can't reach) —
      // fall back to clicking a real accept control ourselves.
      await clickConsentControl(page, "optIn");
    }
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
    // Write our own HAR from captured events (never blocks), then close the context.
    if (recorder) {
      await writeFile(harPath, recorder.toHar(url)).then(
        () => {
          capture.harPath = harPath;
        },
        (e) => opts.log(`  HAR write failed: ${(e as Error).message}`),
      );
    }
    if (ctx) await closeContextBounded(ctx, CONTEXT_CLOSE_TIMEOUT_MS, opts.log);
  }

  // ---- Pass 3: reject in a FRESH context (§4.4) ----
  if (opts.doReject && !capture.error) {
    let rctx: BrowserContext | null = null;
    try {
      rctx = await browser.newContext({ ...CAPTURE_CONTEXT });
      const recorder = new RequestRecorder(firstPartyHost);
      const page = await rctx.newPage();
      recorder.attach(page);
      recorder.markNavigationStart();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await settle(page);
      recorder.drain(); // discard pre-consent; we already have it
      const reject = await runAutoconsent(page, "optOut", opts.log);
      if (!reject.performed) {
        await clickConsentControl(page, "optOut");
      }
      await settle(page);
      capture.afterReject = {
        requests: recorder.drain(),
        cookies: await readCookies(rctx, firstPartyHost),
        scripts: [],
      };
    } catch (err) {
      opts.log(`  capture error (reject pass): ${(err as Error).message}`);
    } finally {
      if (rctx) await closeContextBounded(rctx, CONTEXT_CLOSE_TIMEOUT_MS, opts.log);
    }
  }

  // ---- Pass 4: Global Privacy Control (opt-in, representative page only) ----
  if (opts.doGpc && !capture.error) {
    capture.gpc = await runGpcPass(browser, url, nonEssentialServices(capture.preConsent.requests), opts);
  }

  return capture;
}
