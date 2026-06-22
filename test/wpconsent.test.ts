import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
// Import the COMPILED build: page.evaluate callbacks must be plain tsc output, not tsx/
// esbuild output (esbuild's keepNames injects a __name helper that is undefined in the
// page context). Run `npm run build` first — `npm test` does this automatically.
import { buildReport } from "../dist/aggregate.js";
import { detectConsentUi } from "../dist/consent.js";
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
});
