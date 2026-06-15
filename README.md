# Privacy & Tracking Audit Crawler

Internal CLI for Planeteria Media that audits a website's third-party tracking and
consent behavior **across all pages**. It loads each page in a real headless browser
and records what fires **before** versus **after** the visitor consents, then emits
structured JSON (plus raw HAR + screenshot evidence) that feeds our branded Word report.

No third-party cloud scanners — everything runs locally on tooling we control. See
[`CLAUDE.md`](./CLAUDE.md) for the full build brief; this README covers usage.

## Install

```bash
npm install          # also runs `playwright install chromium`
npm run build
```

For development without building:

```bash
npm run dev -- https://www.example.com --verbose
```

## Usage

```bash
# Audit a site (defaults: up to 25 pages, accept + reject passes, respects robots.txt)
privacy-audit https://www.example.com

# Larger sites — sample one page per URL template, cap at 40
privacy-audit https://www.example.com --sample-by-template --max-pages 40 -v

# Fast pass without the reject (opt-out) test
privacy-audit https://www.example.com --no-reject
```

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `-m, --max-pages <n>` | `25` | Maximum pages to scan |
| `--sample-by-template` | off | One representative page per URL pattern (large sites) |
| `--no-reject` | reject on | Skip the opt-out pass |
| `--no-robots` | respect | Ignore robots.txt (only on sites you control) |
| `-o, --out <dir>` | `output` | Output base directory |
| `-v, --verbose` | off | Verbose progress logging |

The path to `report.json` is printed on **stdout**; progress goes to **stderr**, so you
can pipe the report straight into the Word report generator.

## Output

Each run writes a timestamped directory under `output/`:

```
output/www.example.com-2026-06-15T1527/
  report.json              # the §5 schema — integration contract for the Word report
  evidence/
    page-001.har           # full network log per page
    page-001.png           # full-page screenshot per page
    ...
```

`report.json` matches the schema in `CLAUDE.md` §5 (fields are stable). It contains the
scan metadata, summary + risk score, classified inventory, cookies, consent-mechanism
analysis, the before/accept/reject runtime split, and findings.

## How it works (pipeline)

1. **Enumerate** — pull `/sitemap_index.xml` + `/sitemap.xml` (recursing indexes),
   fall back to same-origin link discovery, respect robots.txt, dedupe.
   ([`enumerate.ts`](./src/enumerate.ts))
2. **Capture per page** — fresh browser context, record pre-consent requests/cookies/
   scripts, then autoconsent **opt-in** and re-capture, then a fresh-context **opt-out**
   pass. Detects the consent banner, its controls, and Google Consent Mode v2 default
   state. Writes HAR + screenshot. ([`capture.ts`](./src/capture.ts),
   [`consent.ts`](./src/consent.ts))
3. **Classify** — map each third-party domain/cookie to vendor + category from our own
   vendor map. ([`vendor-map.ts`](./src/vendor-map.ts))
4. **Aggregate** — dedupe site-wide trackers, flag page-specific ones, mark before-consent
   firing, compute findings + risk score. ([`aggregate.ts`](./src/aggregate.ts))
5. **Emit** — `report.json` + raw evidence with ISO-8601 timestamps.

## Important domain rules (from §6)

- Strictly-necessary items (consent platform, security, CDN, payment) are **excluded**
  from the risk score and the `*BeforeConsent` counts.
- Severity reflects **technical exposure**, never a legal determination. The tool never
  labels a site "non-compliant."
- reCAPTCHA is reported with its timing but flagged for human judgment, not auto-high.
- Legacy Universal Analytics tags are flagged for removal.
- Consent Mode v2 *present* ≠ *gated* — we detect the default state, not just presence.

## Known limitations (v1)

- Interaction-triggered trackers (chat widget opening, video play) aren't captured unless
  those interactions are scripted.
- GPC honoring is not tested (`gpcHonored: null`).
- The vendor map is intentionally small and hand-curated — extend
  [`vendor-map.ts`](./src/vendor-map.ts) as new vendors appear. **Do not** bundle the
  DuckDuckGo Tracker Radar dataset (CC BY-NC-SA, non-commercial).

## Ethics & scope

Only scan sites you are authorized to audit (our own and managed client sites). Respect
robots.txt and use modest concurrency. For audits tied to a legal demand, run locally
only and preserve the raw HAR + screenshots + timestamps. This tool is **read-only**.
