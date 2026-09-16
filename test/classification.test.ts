import assert from "node:assert/strict";
import { before, after, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
// Import the COMPILED build (see the note in wpconsent.test.ts): page.evaluate callbacks
// must be plain tsc output. `npm test` runs the build first.
import { buildReport } from "../dist/aggregate.js";
import { detectPolicyLinks } from "../dist/capture.js";
import { isIpHost, registrableDomain, sameSite } from "../dist/domain.js";
import { lookupVendor } from "../dist/vendor-map.js";
import type { CapturedCookie, CapturedRequest, ConsentUiInfo, PageCapture } from "../dist/types.js";

/**
 * Regressions for the gaps found by benchmarking our report against CookieInspector's
 * scan of the same site (August 2026): truncated IP hosts, party-based cookie
 * misclassification, missing US-privacy coverage, and the absent per-item risk grades.
 */

const EMPTY = { requests: [] as CapturedRequest[], cookies: [] as CapturedCookie[], scripts: [] };

function req(url: string, opts: { thirdParty?: boolean; ms?: number } = {}): CapturedRequest {
  const domain = new URL(url).hostname;
  return {
    url,
    domain,
    resourceType: "script",
    isThirdParty: opts.thirdParty ?? true,
    isFont: false,
    firstSeenMs: opts.ms ?? 100,
  };
}

function capture(over: Partial<PageCapture> = {}): PageCapture {
  const consentUi: ConsentUiInfo = {
    bannerPresent: false,
    acceptAll: false,
    rejectAll: false,
    settings: false,
    cmpIdentified: null,
  };
  return {
    url: "https://example.com/",
    path: "/",
    capturedAt: new Date().toISOString(),
    preConsent: { ...EMPTY },
    afterAccept: { ...EMPTY },
    afterReject: { ...EMPTY },
    consentUi,
    consentMode: { present: false, defaultDenied: false, defaultGranted: false },
    harPath: null,
    screenshotPath: null,
    ...over,
  };
}

describe("registrable domains", () => {
  test("bare IP hosts are kept whole, not truncated to the last two octets", () => {
    // The bug: "44.238.122.172" was reported to a client as the third party "122.172".
    assert.equal(registrableDomain("44.238.122.172"), "44.238.122.172");
    assert.equal(registrableDomain("35.160.46.251"), "35.160.46.251");
    assert.equal(isIpHost("18.210.229.244"), true);
    assert.equal(isIpHost("example.com"), false);
  });

  test("multi-label public suffixes keep the registrable label", () => {
    assert.equal(registrableDomain("www.example.co.uk"), "example.co.uk");
    assert.equal(registrableDomain("cdn.tracker.com.au"), "tracker.com.au");
    assert.equal(registrableDomain("a.b.example.com"), "example.com");
  });

  test("distinct IPs are not treated as the same site", () => {
    assert.equal(sameSite("44.238.122.172", "35.160.122.172"), false);
    assert.equal(sameSite("www.example.com", "cdn.example.com"), true);
  });

  test("an IP third party is inventoried under its full address", () => {
    const cap = capture({
      preConsent: { ...EMPTY, requests: [req("https://44.238.122.172/pixel.js")] },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    const names = report.inventory.map((i) => i.technology);
    assert.ok(names.includes("44.238.122.172"), `full IP in inventory, got ${names.join(", ")}`);
    assert.ok(!names.includes("122.172"), "no truncated IP row");
    assert.ok(report.beforeConsentDomains.includes("44.238.122.172"));
  });
});

describe("cookie classification", () => {
  test("a marketing cookie is marketing on both the vendor domain and the first-party domain", () => {
    const cap = capture({
      preConsent: {
        ...EMPTY,
        cookies: [
          { name: "sa-user-id", domain: "srv.stackadapt.com", party: "third", expiry: null },
          { name: "sa-user-id", domain: "www.example.com", party: "first", expiry: null },
        ],
      },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    const cats = report.cookies.filter((c) => c.name === "sa-user-id").map((c) => c.category);
    assert.deepEqual(cats, ["marketing", "marketing"], "same cookie, same category regardless of party");
  });

  test("first-party ad-tech cookies are no longer downgraded to 'functional'", () => {
    const cap = capture({
      preConsent: {
        ...EMPTY,
        cookies: [
          { name: "_rdt_uuid", domain: "example.com", party: "first", expiry: null }, // Reddit
          { name: "__spdt", domain: "www.example.com", party: "first", expiry: null }, // Simpli.fi
        ],
      },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    for (const name of ["_rdt_uuid", "__spdt"]) {
      const c = report.cookies.find((x) => x.name === name);
      assert.equal(c?.category, "marketing", `${name} categorized as marketing`);
      assert.equal(c?.risk, "high", `${name} graded high risk (marketing, pre-consent)`);
    }
  });

  test("an unrecognized first-party cookie is 'unknown', not a guess", () => {
    const cap = capture({
      preConsent: { ...EMPTY, cookies: [{ name: "site_layout_pref", domain: "example.com", party: "first", expiry: null }] },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    assert.equal(report.cookies[0].category, "unknown");
    assert.equal(report.cookies[0].risk, "low");
  });

  test("cookies set only after consent carry no risk grade", () => {
    const cap = capture({
      consentUi: { bannerPresent: true, acceptAll: true, rejectAll: true, settings: true, cmpIdentified: "WPConsent" },
      afterAccept: { ...EMPTY, cookies: [{ name: "_fbp", domain: "example.com", party: "first", expiry: null }] },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    const fbp = report.cookies.find((c) => c.name === "_fbp");
    assert.equal(fbp?.beforeConsent, false);
    assert.equal(fbp?.risk, "none", "post-consent cookie is not graded as exposure");
  });
});

describe("US state-privacy coverage", () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser.close();
  });

  async function linksFor(html: string) {
    const page: Page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      return await detectPolicyLinks(page);
    } finally {
      await page.close();
    }
  }

  test("finds a 'Your Privacy Choices' link", async () => {
    const r = await linksFor(
      `<body><footer><a href="https://example.com/privacy-choices/">Your Privacy Choices</a></footer></body>`,
    );
    assert.match(String(r.usOptOutLinkUrl), /privacy-choices/);
  });

  test("finds a 'Do Not Sell or Share My Personal Information' link", async () => {
    const r = await linksFor(`<body><footer><a href="/dns">Do Not Sell or Share My Personal Information</a></footer></body>`);
    assert.match(String(r.usOptOutLinkUrl), /\/dns$/);
  });

  test("reports null when no opt-out control exists", async () => {
    const r = await linksFor(`<body><footer><a href="/privacy/">Privacy Policy</a></footer></body>`);
    assert.equal(r.usOptOutLinkUrl, null);
  });

  test("does NOT mistake ordinary body copy containing 'do not sell' for the CCPA control", async () => {
    // Regression: info.myorca.com/retail reads "Stores do not sell pass products." — a
    // nearby unrelated link was getting reported as the opt-out control because the old
    // regex matched "do not sell" with no requirement that it be about the visitor's own
    // ("my") information.
    const r = await linksFor(
      `<body><main><p>Stores do not sell pass products. <a href="/news/orca-card-transition/">Learn more</a></p></main></body>`,
    );
    assert.equal(r.usOptOutLinkUrl, null);
  });

  test("finds a privacy statement behind a bare 'Policies' footer hub", async () => {
    // Municipal/agency sites commonly park the privacy statement under /policies/.
    const r = await linksFor(`<body><footer><a href="https://example.com/policies/">Policies</a></footer></body>`);
    assert.match(String(r.privacyPolicyUrl), /\/policies\//);
  });

  test("does NOT mistake a 'Legal Glossary' link for the privacy-policy hub", async () => {
    // Regression: saclaw.org's nav has a "LEGAL GLOSSARY" link to /legal-glossary/. The old
    // genericPolicyLabel matched any bare "legal", and genericPolicyHref treated the hyphen
    // in "/legal-glossary/" as a valid boundary after "/legal" — together they reported the
    // glossary page as the site's privacy policy instead of the real /policies/ hub.
    const r = await linksFor(
      `<body><footer>
        <a href="https://example.com/legal-glossary/">LEGAL GLOSSARY</a>
        <a href="https://example.com/services/continuing-legal-education-mcle/">Continuing Legal Education (MCLE)</a>
        <a href="https://example.com/policies/">Policies</a>
      </footer></body>`,
    );
    assert.match(String(r.privacyPolicyUrl), /\/policies\//, `expected /policies/, got ${r.privacyPolicyUrl}`);
  });

  test("missing opt-out link is a finding when ad tech is present", () => {
    const cap = capture({
      preConsent: { ...EMPTY, requests: [req("https://connect.facebook.net/en_US/fbevents.js")] },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    const finding = report.findings.find((f) => f.title === "No US state-privacy opt-out link");
    assert.ok(finding, "finding raised");
    assert.equal(finding?.severity, "high", "high when the ad tech also fires before consent");
    assert.equal(report.usOptOutLinkUrl, null);
  });

  test("no opt-out finding when the site runs no advertising trackers", () => {
    const cap = capture({
      preConsent: { ...EMPTY, requests: [req("https://fonts.googleapis.com/css2?family=Inter")] },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    assert.ok(
      !report.findings.some((f) => f.title === "No US state-privacy opt-out link"),
      "a site with no ad tech is not nagged about a sale/sharing opt-out",
    );
  });

  test("GPC reads as 'not tested' rather than 'not honored' when the pass did not run", () => {
    const report = buildReport("https://example.com/", [capture()], "test");
    assert.equal(report.consentMechanism.gpcTested, false);
    assert.equal(report.consentMechanism.gpcHonored, null);
    assert.ok(!report.findings.some((f) => f.title === "Global Privacy Control signal not honored"));
  });

  test("GPC that fails to suppress trackers is reported", () => {
    const cap = capture({
      preConsent: { ...EMPTY, requests: [req("https://connect.facebook.net/en_US/fbevents.js")] },
      gpc: { tested: true, honored: false, suppressed: [], persisted: ["Meta Pixel"] },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    assert.equal(report.consentMechanism.gpcTested, true);
    assert.equal(report.consentMechanism.gpcHonored, false);
    const f = report.findings.find((x) => x.title === "Global Privacy Control signal not honored");
    assert.deepEqual(f?.resources, ["Meta Pixel"]);
  });
});

describe("report shape", () => {
  test("per-page risks rank the worst page first", () => {
    const clean = capture({ url: "https://example.com/quiet", path: "/quiet" });
    const dirty = capture({
      url: "https://example.com/",
      path: "/",
      preConsent: {
        ...EMPTY,
        requests: [
          req("https://connect.facebook.net/en_US/fbevents.js"),
          req("https://www.google-analytics.com/g/collect?v=2"),
          req("https://snap.licdn.com/li.lms-analytics/insight.min.js"),
        ],
      },
    });
    const report = buildReport("https://example.com/", [clean, dirty], "test");
    assert.equal(report.pageRisks.length, 2);
    assert.equal(report.pageRisks[0].path, "/", "worst page first");
    assert.ok(report.pageRisks[0].score < report.pageRisks[1].score);
    assert.equal(report.pageRisks[0].trackersBeforeConsent, 3);
    assert.ok(report.pageRisks[0].issues.includes("Third-party tracking before consent"));
  });

  test("pages tied at the floor score are still ordered by raw exposure", () => {
    // On a badly-exposed site every page bottoms out at 0; a table of identical scores
    // must still tell the client which page leaks most.
    const heavy = capture({
      url: "https://example.com/heavy",
      path: "/heavy",
      preConsent: {
        ...EMPTY,
        requests: [
          req("https://connect.facebook.net/en_US/fbevents.js"),
          req("https://www.google-analytics.com/g/collect?v=2"),
          req("https://snap.licdn.com/li.lms-analytics/insight.min.js"),
          req("https://bat.bing.com/bat.js"),
          req("https://tags.srv.stackadapt.com/js_tracking"),
        ],
      },
    });
    const lighter = capture({
      url: "https://example.com/lighter",
      path: "/lighter",
      preConsent: {
        ...EMPTY,
        requests: [
          req("https://connect.facebook.net/en_US/fbevents.js"),
          req("https://www.google-analytics.com/g/collect?v=2"),
          req("https://snap.licdn.com/li.lms-analytics/insight.min.js"),
          req("https://bat.bing.com/bat.js"),
        ],
      },
    });
    const report = buildReport("https://example.com/", [lighter, heavy], "test");
    assert.equal(report.pageRisks[0].score, report.pageRisks[1].score, "both bottom out at the floor");
    assert.equal(report.pageRisks[0].path, "/heavy", "more trackers ranks worse at equal score");
  });

  test("breakdown gives total / before-consent / after-only for each section", () => {
    const cap = capture({
      consentUi: { bannerPresent: true, acceptAll: true, rejectAll: true, settings: true, cmpIdentified: "WPConsent" },
      preConsent: { ...EMPTY, requests: [req("https://fonts.googleapis.com/css2?family=Inter")] },
      afterAccept: { ...EMPTY, requests: [req("https://connect.facebook.net/en_US/fbevents.js")] },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    const b = report.summary.breakdown;
    assert.equal(b.services.total, 2, "Google Fonts + Meta Pixel");
    assert.equal(b.services.beforeConsent, 1, "only Google Fonts fired pre-consent");
    assert.equal(b.services.afterConsentOnly, 1);
  });

  test("inventory carries a risk grade and a pre-consent timing", () => {
    const cap = capture({
      preConsent: { ...EMPTY, requests: [req("https://connect.facebook.net/en_US/fbevents.js", { ms: 240 })] },
    });
    const report = buildReport("https://example.com/", [cap], "test");
    const pixel = report.inventory.find((i) => i.technology === "Meta Pixel");
    assert.equal(pixel?.risk, "high");
    assert.equal(pixel?.firstSeenMs, 240, "timing recorded for the consent timeline");
  });
});

describe("vendor map coverage", () => {
  test("ad-tech previously reported as 'Unclassified' is now named", () => {
    const cases: Array<[string, string, string]> = [
      ["https://tags.srv.stackadapt.com/js_tracking", "StackAdapt", "marketing"],
      ["https://www.redditstatic.com/ads/pixel.js", "Reddit Pixel", "marketing"],
      ["https://px.mountain.com/tt", "MNTN (Mountain) CTV ads", "marketing"],
      ["https://pixel.byspotify.com/p.gif", "Spotify Ads Pixel", "marketing"],
      ["https://snap.licdn.com/li.lms-analytics/insight.min.js", "LinkedIn Insight Tag", "marketing"],
      ["https://api.segment.io/v1/t", "Segment", "analytics"],
      ["https://data.pendo.io/data/guide.js", "Pendo", "analytics"],
      ["https://api.mapbox.com/styles/v1", "Mapbox", "functional"],
    ];
    for (const [url, name, category] of cases) {
      const v = lookupVendor(url);
      assert.equal(v?.name, name, `${url} → ${name}`);
      assert.equal(v?.category, category, `${url} category`);
    }
  });

  test("specific Google hosts still win over the generic googleapis.com entry", () => {
    assert.equal(lookupVendor("https://fonts.googleapis.com/css2?family=Inter")?.name, "Google Fonts");
    assert.equal(lookupVendor("https://maps.googleapis.com/maps/api/js")?.name, "Google Maps");
    assert.equal(lookupVendor("https://www.google.com/recaptcha/api.js")?.name, "reCAPTCHA");
  });
});
