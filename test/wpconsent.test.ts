import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
// Import the COMPILED build: page.evaluate callbacks must be plain tsc output, not tsx/
// esbuild output (esbuild's keepNames injects a __name helper that is undefined in the
// page context). Run `npm run build` first — `npm test` does this automatically.
import { buildReport } from "../dist/aggregate.js";
import { detectPolicyLinks } from "../dist/capture.js";
import { detectConsentUi } from "../dist/consent.js";
import { lookupVendor } from "../dist/vendor-map.js";
import type { CapturePass, PageCapture } from "../dist/types.js";

/**
 * Regression test for §10 amendment — WPConsent CMP detection.
 *
 * The live WPConsent banner is injected only when its display checks pass (geo/consent
 * state), so it does not render for the scanner. We test against a saved HTML snapshot of
 * a rendered WPConsent banner (markup anchored to the live DOM: #wpconsent-root /
 * #wpconsent-container, the window.WPConsent global, and the plugin script path).
 */

// Snapshot of a rendered WPConsent banner.
const WPCONSENT_FIXTURE = `<!doctype html><html><head>
<script src="https://example.test/wp-content/plugins/wpconsent-premium/build/frontend-pro.js"></script>
<script>window.WPConsent = { acceptAll(){}, savePreferences(){}, showPreferences(){} }; window.wp_consent_type = "optin";</script>
</head><body>
<div id="wpconsent-root">
  <div id="wpconsent-container" class="wpconsent-banner" role="dialog" aria-label="Cookie consent"
       style="position:fixed;bottom:0;left:0;width:100%;padding:24px;background:#fff;">
    <p>We use cookies to improve your experience.</p>
    <button class="wpconsent-settings-buttons-accept-all">Accept All</button>
    <button class="wpconsent-settings-buttons-reject">Reject</button>
    <button class="wpconsent-settings-buttons-preferences">Preferences</button>
  </div>
</div>
</body></html>`;

// A site with NO consent mechanism but a stray footer "Privacy Settings" link.
const NO_BANNER_FIXTURE = `<!doctype html><html><body>
<main><h1>Welcome</h1></main>
<footer><a href="/privacy">Privacy Settings</a> · <a href="/contact">Contact</a></footer>
</body></html>`;

// Pressidium Cookie Consent — global present, banner rendered with "Accept necessary".
const PRESSIDIUM_FIXTURE = `<!doctype html><html><head>
<script src="https://example.test/wp-content/plugins/pressidium-cookie-consent/public/bundle.client.js"></script>
<script>window.pressidiumCookieConsent = {}; window.initCookieConsent = function(){};</script>
</head><body>
<div id="cc--main" class="cookie-consent" role="dialog" aria-label="Cookie Consent"
     style="position:fixed;bottom:0;right:0;width:380px;padding:24px;background:#fff;">
  <h2>Cookie Consent</h2>
  <p>We use cookies to ensure the website's proper operation.</p>
  <a href="/cookie-settings">Cookie Settings</a> | <a href="/cookie-policy">Cookie Policy</a>
  <button>Accept all</button>
  <button>Accept necessary</button>
</div></body></html>`;

// Bespoke, theme-coded banner (no CMP, no cookie/consent keyword in class/id/aria) — the
// consent keywords live only in the visible TEXT. Modeled on zailaboratory.com's custom
// Tailwind banner. Must be caught by the text-based fallback.
const BESPOKE_TEXT_BANNER_FIXTURE = `<!doctype html><html><body>
<main><h1>Home</h1><p>Welcome to our site.</p></main>
<div class="border-t fixed w-full bottom-0 left-0 bg-white py-16 z-[100]">
  <div class="container mx-auto">
    <div class="lg:flex lg:space-x-16 justify-between items-start">
      <button aria-label="close">&times;</button>
      <p>This website uses cookies to ensure the best possible functionality and user experience.
         To consent to our use of cookies please click "Accept Cookies."</p>
      <div class="flex space-x-4">
        <button>Accept Cookies</button>
        <button>Reject Cookies</button>
      </div>
    </div>
  </div>
</div></body></html>`;

// A page with a cookie-policy paragraph in the footer but NO banner and NO accept control —
// the text fallback must NOT treat prose + an unrelated link as a consent banner.
const COOKIE_PROSE_NO_CONTROL_FIXTURE = `<!doctype html><html><body>
<main><h1>Cookie Policy</h1>
<p>This website uses cookies to improve your experience. Read more about how we use cookies.</p>
<a href="/learn-more">Learn more</a></main></body></html>`;

// A OneTrust banner — guards against regressing existing CMP detection.
const ONETRUST_FIXTURE = `<!doctype html><html><head>
<script>window.OneTrust = {};</script></head><body>
<div id="onetrust-banner-sdk" role="alertdialog" class="otCookie consent"
     style="position:fixed;bottom:0;width:100%;padding:24px;">
  <button>Accept All Cookies</button><button>Reject All</button><button>Cookie Settings</button>
</div></body></html>`;

const EMPTY: CapturePass = { requests: [], cookies: [], scripts: [] };

function captureWith(consentUi: PageCapture["consentUi"]): PageCapture {
  return {
    url: "https://www.planeteria.com/",
    path: "/",
    capturedAt: new Date().toISOString(),
    preConsent: { ...EMPTY }, // nothing fires before consent → banner blocks correctly
    afterAccept: { ...EMPTY },
    afterReject: { ...EMPTY },
    consentUi,
    consentMode: { present: false, defaultDenied: false, defaultGranted: false },
    harPath: null,
    screenshotPath: null,
  };
}

describe("WPConsent CMP detection", () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser.close();
  });

  // Fresh page per fixture — window globals (e.g. window.WPConsent) persist across
  // setContent in the same page, so each test needs an isolated execution context.
  async function uiFor(html: string) {
    const page: Page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      return await detectConsentUi(page);
    } finally {
      await page.close();
    }
  }

  test("detects WPConsent by name, with reject/accept/preferences and banner present", async () => {
    const ui = await uiFor(WPCONSENT_FIXTURE);
    assert.equal(ui.cmpIdentified, "WPConsent", "CMP identified as WPConsent");
    assert.equal(ui.bannerPresent, true, "banner present");
    assert.equal(ui.rejectAll, true, 'reject-all recognized ("Reject")');
    assert.equal(ui.acceptAll, true, "accept-all recognized");
    assert.equal(ui.settings, true, 'preferences recognized ("Preferences")');
  });

  test("does NOT false-positive on a stray footer Settings link", async () => {
    const ui = await uiFor(NO_BANNER_FIXTURE);
    assert.equal(ui.bannerPresent, false, "no banner reported");
    assert.equal(ui.cmpIdentified, null, "no CMP identified");
  });

  test("detects Pressidium Cookie Consent, incl. 'Accept necessary' as reject", async () => {
    const ui = await uiFor(PRESSIDIUM_FIXTURE);
    assert.equal(ui.cmpIdentified, "Pressidium Cookie Consent", "CMP identified as Pressidium");
    assert.equal(ui.bannerPresent, true, "banner present");
    assert.equal(ui.acceptAll, true, "accept-all recognized");
    assert.equal(ui.rejectAll, true, '"Accept necessary" recognized as reject');
    assert.equal(ui.settings, true, '"Cookie Settings" recognized');
  });

  test("detects a bespoke text-only banner (no CMP, keyword only in body text)", async () => {
    const ui = await uiFor(BESPOKE_TEXT_BANNER_FIXTURE);
    assert.equal(ui.bannerPresent, true, "banner present via text fallback");
    assert.equal(ui.cmpIdentified, null, "no named CMP (it's custom)");
    assert.equal(ui.acceptAll, true, '"Accept Cookies" recognized');
    assert.equal(ui.rejectAll, true, '"Reject Cookies" recognized (whole button group captured)');
    assert.equal(ui.settings, false, "no settings/preferences control");
  });

  test("does NOT treat cookie-policy prose without an accept control as a banner", async () => {
    const ui = await uiFor(COOKIE_PROSE_NO_CONTROL_FIXTURE);
    assert.equal(ui.bannerPresent, false, "prose + 'Learn more' is not a consent banner");
    assert.equal(ui.cmpIdentified, null);
  });

  test("still detects an existing CMP (OneTrust)", async () => {
    const ui = await uiFor(ONETRUST_FIXTURE);
    assert.equal(ui.cmpIdentified, "OneTrust");
    assert.equal(ui.bannerPresent, true);
    assert.equal(ui.rejectAll, true);
  });

  test("a correctly-configured WPConsent banner is not penalized as 'no consent mechanism'", () => {
    const report = buildReport(
      "https://www.planeteria.com/",
      [captureWith({ bannerPresent: true, acceptAll: true, rejectAll: true, settings: true, cmpIdentified: "WPConsent" })],
      "test",
    );
    assert.equal(report.consentMechanism.bannerPresent, true);
    assert.equal(report.consentMechanism.cmpIdentified, "WPConsent");
    assert.equal(report.consentMechanism.blocksBeforeConsent, true, "blocks before consent (nothing fired pre-consent)");
    const titles = report.findings.map((f) => f.title);
    assert.ok(!titles.includes("No consent mechanism"), "no 'No consent mechanism' finding");
    assert.ok(!titles.includes("Non-blocking consent banner"), "no 'Non-blocking consent banner' finding");
  });

  test("decline finding is suppressed when the site blocks before consent (reject-automation artifact)", () => {
    const cap = captureWith({ bannerPresent: true, acceptAll: true, rejectAll: true, settings: true, cmpIdentified: "WPConsent" });
    // Nothing fires before consent (site blocks on load), but the reject pass "leaked" GA —
    // i.e. autoconsent failed to reject this CMP and granted instead. Must NOT be flagged.
    cap.afterReject = {
      requests: [
        { url: "https://www.google-analytics.com/g/collect?v=2", domain: "www.google-analytics.com", resourceType: "image", isThirdParty: true, isFont: false },
      ],
      cookies: [],
      scripts: [],
    };
    const report = buildReport("https://example.com/", [cap], "test");
    assert.equal(report.consentMechanism.blocksBeforeConsent, true, "site blocks before consent");
    const titles = report.findings.map((f) => f.title);
    assert.ok(!titles.includes("Consent banner does not block on decline"), "no false 'does not block on decline' finding");
  });

  test("consent-platform cookies (wpconsent_*) are excluded from pre-consent counts", () => {
    const cap = captureWith({ bannerPresent: true, acceptAll: true, rejectAll: true, settings: true, cmpIdentified: "WPConsent" });
    cap.preConsent = {
      requests: [],
      scripts: [],
      cookies: [
        { name: "wpconsent_geolocation", domain: "example.com", party: "first", expiry: null },
        { name: "_ga", domain: "example.com", party: "first", expiry: null },
      ],
    };
    const report = buildReport("https://example.com/", [cap], "test");
    const wpc = report.cookies.find((c) => c.name === "wpconsent_geolocation");
    assert.equal(wpc?.category, "necessary", "consent-platform cookie categorized necessary");
    assert.equal(report.summary.cookiesBeforeConsent, 1, "only the non-necessary cookie is counted");
  });

  test("no-banner site: late-arriving cookies/requests count as before-consent (union of passes)", () => {
    // No consent mechanism at all. The pre-consent snapshot missed the ad-tech cookie-sync
    // cascade, which landed in the later passes. With no gate, those fired without consent
    // and must be counted before-consent.
    const cap = captureWith({ bannerPresent: false, acceptAll: false, rejectAll: false, settings: false, cmpIdentified: null });
    cap.preConsent = {
      requests: [{ url: "https://www.google-analytics.com/g/collect?v=2", domain: "www.google-analytics.com", resourceType: "image", isThirdParty: true, isFont: false }],
      cookies: [{ name: "_ga", domain: "example.com", party: "first", expiry: null }],
      scripts: [],
    };
    cap.afterAccept = {
      requests: [{ url: "https://adnxs.com/sync", domain: "adnxs.com", resourceType: "image", isThirdParty: true, isFont: false }],
      cookies: [{ name: "uuid2", domain: "adnxs.com", party: "third", expiry: null }],
      scripts: [],
    };
    cap.afterReject = {
      requests: [{ url: "https://casalemedia.com/sync", domain: "casalemedia.com", resourceType: "image", isThirdParty: true, isFont: false }],
      cookies: [{ name: "CMID", domain: "casalemedia.com", party: "third", expiry: null }],
      scripts: [],
    };
    const report = buildReport("https://example.com/", [cap], "test");
    const before = report.cookies.filter((c) => c.beforeConsent).map((c) => c.name);
    assert.ok(before.includes("uuid2"), "afterAccept sync cookie counted before consent");
    assert.ok(before.includes("CMID"), "afterReject sync cookie counted before consent");
    assert.equal(report.summary.cookiesBeforeConsent, 3, "_ga + uuid2 + CMID all pre-consent");
    assert.ok(report.beforeConsentDomains.includes("adnxs.com"), "adnxs contacted before consent");
    assert.ok(report.beforeConsentDomains.includes("casalemedia.com"), "casalemedia contacted before consent");
  });

  test("banner present: passes are NOT unified (before/after split preserved)", () => {
    // The union only applies when there is no consent mechanism. With a banner, a cookie that
    // appears only after accept must stay after-consent — that split is the whole point.
    const cap = captureWith({ bannerPresent: true, acceptAll: true, rejectAll: true, settings: true, cmpIdentified: "WPConsent" });
    cap.afterAccept = {
      requests: [],
      cookies: [{ name: "uuid2", domain: "adnxs.com", party: "third", expiry: null }],
      scripts: [],
    };
    const report = buildReport("https://example.com/", [cap], "test");
    const uuid2 = report.cookies.find((c) => c.name === "uuid2");
    assert.equal(uuid2?.beforeConsent, false, "post-accept cookie stays after-consent when a banner exists");
  });

  test("vendor map classifies ReachLocal/LocaliQ retargeting hosts as marketing", () => {
    assert.equal(lookupVendor("https://2ca5e9c4.rlets.com/track")?.category, "marketing", "rlets.com is marketing");
    assert.equal(lookupVendor("https://www.localiq.com/pixel")?.category, "marketing", "localiq.com is marketing");
  });

  test("vendor map classifies MyFonts/Monotype as a functional web-font service", () => {
    const mf = lookupVendor("https://hello.myfonts.net/count/2693fd");
    assert.equal(mf?.category, "functional", "myfonts.net is functional, not unknown");
    assert.equal(mf?.vendor, "Monotype");
  });

  // Policy-link detection — a privacy policy is often linked under a generic label.
  async function policiesFor(html: string) {
    const page: Page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      return await detectPolicyLinks(page);
    } finally {
      await page.close();
    }
  }

  test("detects a privacy policy linked under a generic 'Website Policies' label", async () => {
    // Modeled on cpedv.org: the privacy statement lives at /website-policies/, linked as
    // "Website Policies" — no "privacy" in the anchor text or href.
    const p = await policiesFor(
      `<!doctype html><html><body><footer>
        <a href="https://ex.test/website-policies/">Website Policies</a>
        <a href="https://ex.test/contact/">Contact</a>
      </footer></body></html>`,
    );
    assert.equal(p.privacyPolicyUrl, "https://ex.test/website-policies/", "generic policy hub found as privacy policy");
    assert.equal(p.cookiePolicyUrl, null, "no cookie-specific policy present");
  });

  test("prefers an explicit privacy link over a generic policy hub", async () => {
    const p = await policiesFor(
      `<!doctype html><html><body><footer>
        <a href="https://ex.test/legal/">Legal</a>
        <a href="https://ex.test/privacy-policy/">Privacy Policy</a>
      </footer></body></html>`,
    );
    assert.equal(p.privacyPolicyUrl, "https://ex.test/privacy-policy/", "explicit privacy link wins");
  });

  test("does not treat a bare Terms link as a privacy policy", async () => {
    const p = await policiesFor(
      `<!doctype html><html><body><footer>
        <a href="https://ex.test/terms/">Terms of Service</a>
        <a href="https://ex.test/about/">About</a>
      </footer></body></html>`,
    );
    assert.equal(p.privacyPolicyUrl, null, "terms-only site has no detected privacy policy");
  });
});
