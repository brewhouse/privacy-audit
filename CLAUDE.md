# Privacy & Tracking Audit Crawler — Build Brief

> Drop this file into the project root as `CLAUDE.md` (or paste it as the first prompt). It is the full spec — Claude Code should not need outside context to start scaffolding.

## 1. Goal

Build an internal command-line tool for a web agency (Planeteria Media) that audits a website's third-party tracking and consent behavior **across all pages**, by loading each page in a real browser and recording what fires **before** versus **after** the visitor consents. The tool outputs structured JSON that feeds an existing branded Word report. It must not depend on third-party cloud scanners.

## 2. Why we're building it

We currently run audits with a hosted scanner (CookieInspector), but its free crawl covers only 1 page and its paid crawl up to ~5. Most trackers load site-wide, but page-specific ones (a map on Contact, a video pixel on a landing page, reCAPTCHA on a form) live on deeper pages and get missed. For audits tied to a legal demand, we also need the review run with tooling we control (no client site routed through an external SaaS) and raw, timestamped evidence preserved.

## 3. Recommended stack

**Use Node.js + TypeScript.** Rationale: the two hardest pieces — consent automation and crawl orchestration — are JS-native, so a single-language project avoids cross-runtime glue.

Packages:
- **playwright** — headless browser; capture network requests, cookies, and responses per page.
- **crawlee** — crawl orchestration over Playwright (sitemap + link discovery, request queue, concurrency, dedup, retries, robots.txt).
- **@duckduckgo/autoconsent** — programmatically detect a consent banner and execute opt-in / opt-out in a Playwright-driven browser (100+ CMPs). This is what produces the before/after-consent split. (A thin `playwright-autoconsent` wrapper exists if helpful.)
- **Tracker classification** — start with a small self-maintained vendor map (see Appendix A) covering the common ~50 trackers. **Do not bundle the DuckDuckGo Tracker Radar dataset for commercial use without licensing it** — the dataset is CC BY-NC-SA (non-commercial); the collector/detector *code* is Apache-2.0. Treat Tracker Radar as a reference to seed our own map, not a shipped dependency.
- Output: plain JSON (see §5). A separate step renders it into the Word report (we already have a `docx`-based report builder; the JSON field names below map to its sections).

## 4. What the tool must do (pipeline)

1. **Enumerate URLs.** Pull `/sitemap_index.xml` and `/sitemap.xml` (WordPress/Yoast/RankMath expose these); fall back to recursive same-origin link discovery. Respect robots.txt. Dedupe. Allow a `--max-pages` cap and a `--sample-by-template` mode (one representative per URL pattern) for large sites.
2. **Per page, capture pre-consent state.** Load in a fresh browser context (no stored cookies). Before any interaction, record: every third-party network request (URL, domain, resource type), every cookie set (name, domain, first/third party, expiry), and inline/external script sources. Note the **injection source** where detectable (hardcoded in theme HTML vs injected via GTM vs other).
3. **Detect consent UI.** Record whether a banner is present, whether it exposes accept-all / reject-all / settings, and whether a CMP is identifiable. Detect Google Consent Mode v2 signals and, if present, the default consent state (look for denied vs granted; G-100/G-111).
4. **Accept consent** via autoconsent, then re-capture; **then reject** (fresh context) and re-capture. The reject pass is the real test of whether the banner blocks.
5. **Classify** each third-party domain/cookie by vendor + category (analytics / marketing / functional / necessary) using the vendor map.
6. **Aggregate across pages.** Dedupe site-wide trackers, flag page-specific ones, and for each tracker mark whether it was observed before consent on any page.
7. **Emit JSON** (§5) plus raw evidence: a HAR per page, a full-page screenshot per page, and an ISO-8601 timestamp. Evidence preservation matters for legal-context audits.

## 5. Output JSON schema (integration contract)

This shape maps directly onto the report sections. Keep field names stable.

```jsonc
{
  "scan": {
    "domain": "https://www.example.com",
    "scannedAt": "2026-06-15T15:27:00-07:00",
    "method": "runtime headless (Playwright + autoconsent)",
    "pagesScanned": ["https://www.example.com/", "https://www.example.com/contact"]
  },
  "summary": {
    "thirdPartyServices": 7,
    "trackersBeforeConsent": 1,
    "cookiesBeforeConsent": 4,
    "domainsBeforeConsent": 2,
    "thirdPartyFonts": 0,
    "privacyScore": 70                    // 0–100, 100 = best (no issues); our own weighting, see §6
  },
  "inventory": [
    {
      "technology": "Google Analytics (GA4)",
      "vendor": "Google",
      "purpose": "Analytics",
      "dataRecipient": "Google",
      "category": "analytics",            // necessary|functional|analytics|marketing
      "firesBeforeConsent": true,
      "injectionSource": "gtm",           // theme|gtm|plugin|unknown
      "inPolicy": "review",               // yes|no|review
      "pages": ["/"]
    }
  ],
  "cookies": [
    { "name": "_ga", "domain": "example.com", "party": "first",
      "beforeConsent": true, "expiry": "2027-07-20", "category": "analytics" }
  ],
  "consentMechanism": {
    "bannerPresent": true,
    "acceptAll": true,
    "rejectAll": false,
    "settings": false,
    "blocksBeforeConsent": false,
    "cmpIdentified": null,                // string name or null
    "consentModeV2": "partial",           // present|partial|absent
    "gpcHonored": null                    // true|false|null if untested
  },
  "runtime": {
    "beforeConsent": [ { "type": "request|cookie", "name": "...", "destination": "..." } ],
    "afterAccept":  [ ... ],
    "afterReject":  [ ... ]
  },
  "findings": [
    {
      "severity": "high",                 // high|medium|low
      "title": "Third-party tracking before consent",
      "detail": "Non-essential analytics set cookies and transmitted data before consent.",
      "pages": ["/"],
      "resources": ["_ga", "_gid", "www.google-analytics.com"]
    }
  ],
  "beforeConsentDomains": ["google-analytics.com", "googletagmanager.com"],  // site-wide registrable domains before consent (backs summary.domainsBeforeConsent)
  "privacyPolicyUrl": "https://www.example.com/privacy-policy",              // detected privacy policy link, or null
  "cookiePolicyUrl": null                                                    // detected cookie policy link, or null
}
```

## 6. Domain rules & gotchas (do not skip — these aren't inferable from the libraries)

- **Exclude strictly-necessary items from risk.** Cookies/requests from the consent platform itself, security, CDN, and payment do **not** count as pre-consent violations. The privacy score (100 = best; penalties deducted for issues) and `*BeforeConsent` counts must ignore them.
- **Severity is technical exposure, not a legal determination.** Never label a site "non-compliant" or "illegal" in output. Use "fires before consent," "non-blocking banner," etc. Recommendations split into *technical* and *for legal counsel*.
- **reCAPTCHA** is often argued to be necessary for spam/security, but v3 loads site-wide on every page. Report its timing; categorize as functional, flag for human judgment rather than auto-marking high risk.
- **Legacy Universal Analytics tags** (cookies like `_gat_gtag_UA_########`) are retired by Google — flag for removal as dead weight that still fires pre-consent.
- **Dev/QA tools on production** (e.g. BugHerd / `sidebar.bugherd.com`) should be flagged — they're third parties that usually shouldn't be on a live site.
- **Banner "non-blocking" detection:** the test is whether non-essential requests/cookies fire on load *despite* a banner being present, and whether rejecting suppresses them. Capture before any click.
- **Consent Mode v2 present ≠ gated.** A site can have Consent Mode signals while defaulting to "granted," so tags still fire. Detect the default state, don't just detect presence.
- **Known limitation to document, not solve in v1:** interaction-triggered trackers (chat widget opening, video play) won't appear unless those interactions are scripted.

## 7. Build phases

- **v1 (MVP):** sitemap enumeration → Playwright per-page capture → autoconsent accept → before/after JSON → vendor-map classification → write JSON + HAR + screenshots. Single domain, `--max-pages` cap.
- **v2:** reject-pass test; Consent Mode default-state detection; richer vendor map; risk scoring; CLI flags for sampling.
- **v3:** scheduled re-scan (monitoring) with diff vs. previous run; hook JSON into the Word report generator.

## 8. Constraints & ethics

- Only scan sites the operator is authorized to audit (our own and managed client sites). Respect robots.txt and use modest concurrency.
- For audits tied to a legal demand: run locally only (no external services), and always preserve raw HAR + screenshots + timestamps.
- No site changes — this tool is read-only observation.

## 9. Acceptance for v1

Given a WordPress site URL, the tool crawls all sitemap pages, and for each produces: the third-party request/cookie list before consent, the same after accepting, a consent-mechanism summary, classified inventory, and a findings list — written to a single JSON matching §5, plus per-page HAR and screenshots, with timestamps.

## Appendix A — vendor map seed (extend as needed)

```jsonc
{
  "google-analytics.com": { "vendor": "Google", "name": "Google Analytics", "category": "analytics" },
  "googletagmanager.com": { "vendor": "Google", "name": "Google Tag Manager", "category": "functional" },
  "maps.googleapis.com":  { "vendor": "Google", "name": "Google Maps", "category": "functional" },
  "google.com/recaptcha": { "vendor": "Google", "name": "reCAPTCHA", "category": "functional" },
  "connect.facebook.net": { "vendor": "Meta", "name": "Meta Pixel", "category": "marketing" },
  "snap.licdn.com":       { "vendor": "LinkedIn", "name": "LinkedIn Insight", "category": "marketing" },
  "static.addtoany.com":  { "vendor": "AddToAny", "name": "AddToAny", "category": "functional" },
  "bugherd.com":          { "vendor": "BugHerd", "name": "BugHerd (QA)", "category": "non-essential" }
}
```
