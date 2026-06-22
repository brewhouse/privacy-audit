import { lookupVendor } from "./vendor-map.js";
import type {
  AuditReport,
  Category,
  ConsentMechanism,
  ConsentModeState,
  CookieRecord,
  Finding,
  InjectionSource,
  InventoryItem,
  PageCapture,
  RuntimeEvent,
  RuntimeSplit,
  Summary,
} from "./types.js";

/**
 * Aggregation, classification, findings & risk scoring (CLAUDE.md §4.5–§4.6, §6).
 *
 * Key §6 rules enforced here:
 *  - Strictly-necessary items (consent platform, security, CDN, payment, `necessary`)
 *    are excluded from risk and from the *BeforeConsent counts.
 *  - Severity reflects technical exposure, never a legal determination.
 *  - reCAPTCHA / functional items are reported but flagged for human judgment, not auto-high.
 *  - Legacy Universal Analytics tags are flagged for removal.
 */

// Categories that count as a pre-consent tracking concern.
const VIOLATION_CATEGORIES: ReadonlySet<Category> = new Set(["analytics", "marketing", "non-essential"]);

// Hostnames that are strictly necessary and never count toward risk (§6).
const NECESSARY_HOST_HINTS = [
  // consent platforms
  "cookiebot.com", "onetrust.com", "cookielaw.org", "complianz", "borlabs",
  // CDN / security / infra
  "cloudflare.com", "cloudflareinsights.com", "jsdelivr.net", "unpkg.com",
  "gravatar.com", "wp.com", "w.org",
  // payment
  "stripe.com", "paypal.com", "braintreegateway.com",
];

function isNecessaryHost(host: string): boolean {
  return NECESSARY_HOST_HINTS.some((h) => host.includes(h));
}

const LEGACY_UA_COOKIE = /^_gat_gtag_UA_|^__utm|^_gat_UA-/i;

interface InventoryAccumulator extends InventoryItem {
  /** dedup helper: vendor+name key already in `pages` set */
  _pages: Set<string>;
}

/** Pick the most informative injection source seen for a vendor across pages/scripts. */
function pickInjectionSource(capture: PageCapture, vendorName: string): InjectionSource {
  const allScripts = [...capture.preConsent.scripts];
  // GTM-injected vendors rarely have a matching <script src>; default to gtm if GTM present.
  const gtmPresent = allScripts.some((s) => s.injectionHint === "gtm");
  for (const s of allScripts) {
    if (s.src && s.src.includes(vendorName.toLowerCase())) return s.injectionHint;
  }
  if (gtmPresent) return "gtm";
  if (allScripts.some((s) => s.injectionHint === "plugin")) return "plugin";
  if (allScripts.some((s) => s.injectionHint === "theme")) return "theme";
  return "unknown";
}

/** Registrable-domain-ish grouping key for unclassified third parties (best-effort eTLD+1). */
function regDomain(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/**
 * Build the deduped, site-wide inventory of third-party services.
 *
 * Every third-party domain that fires is listed — known vendors are classified via the
 * vendor map; anything unmatched is still surfaced (grouped by registrable domain) so the
 * named inventory mirrors the raw network logs. Unmatched infra (CDN/etc.) is marked
 * `necessary`; everything else `unknown` and flagged for human classification.
 */
function buildInventory(captures: PageCapture[]): InventoryItem[] {
  const byKey = new Map<string, InventoryAccumulator>();

  const ensure = (key: string, seed: () => Omit<InventoryAccumulator, "_pages" | "pages">): InventoryAccumulator => {
    let item = byKey.get(key);
    if (!item) {
      item = { ...seed(), pages: [], _pages: new Set<string>() } as InventoryAccumulator;
      byKey.set(key, item);
    }
    return item;
  };

  for (const cap of captures) {
    // A request seen in the pre-consent pass fires before consent.
    const preHosts = new Set(cap.preConsent.requests.filter((r) => r.isThirdParty).map((r) => r.url));

    for (const req of cap.preConsent.requests.concat(cap.afterAccept.requests)) {
      if (!req.isThirdParty) continue;
      const firesBefore = preHosts.has(req.url);
      const vendor = lookupVendor(req.url);

      let item: InventoryAccumulator;
      if (vendor) {
        item = ensure(`${vendor.vendor}::${vendor.name}`, () => ({
          technology: vendor.name,
          vendor: vendor.vendor,
          purpose: vendor.purpose!,
          dataRecipient: vendor.dataRecipient!,
          category: vendor.category,
          firesBeforeConsent: false,
          injectionSource: pickInjectionSource(cap, vendor.name),
          inPolicy: "review", // human/legal step decides yes/no
        }));
      } else {
        // Unclassified third party — surface it rather than dropping it.
        const dom = regDomain(req.domain);
        const necessary = isNecessaryHost(req.domain);
        item = ensure(`unclassified::${dom}`, () => ({
          technology: dom,
          vendor: necessary ? "Infrastructure / CDN" : "Unclassified",
          purpose: necessary ? "Strictly necessary" : "Unclassified third party",
          dataRecipient: dom,
          category: necessary ? "necessary" : "unknown",
          firesBeforeConsent: false,
          injectionSource: pickInjectionSource(cap, dom),
          inPolicy: "review",
        }));
      }
      if (firesBefore) item.firesBeforeConsent = true;
      item._pages.add(cap.path);
    }
  }

  return [...byKey.values()]
    .map(({ _pages, ...item }) => ({ ...item, pages: [..._pages].sort() }))
    .sort((a, b) => a.technology.localeCompare(b.technology));
}

/** Deduped site-wide cookie list with before-consent flag and category. */
function buildCookies(captures: PageCapture[]): CookieRecord[] {
  const byKey = new Map<string, CookieRecord>();
  for (const cap of captures) {
    const preNames = new Set(cap.preConsent.cookies.map((c) => `${c.name}@${c.domain}`));
    for (const c of cap.preConsent.cookies.concat(cap.afterAccept.cookies)) {
      const key = `${c.name}@${c.domain}`;
      const vendor = lookupVendor(`https://${c.domain}`);
      const category: Category = LEGACY_UA_COOKIE.test(c.name)
        ? "analytics"
        : (vendor?.category ?? (c.party === "first" ? "functional" : "marketing"));
      const existing = byKey.get(key);
      const beforeConsent = preNames.has(key);
      if (existing) {
        existing.beforeConsent = existing.beforeConsent || beforeConsent;
      } else {
        byKey.set(key, {
          name: c.name,
          domain: c.domain,
          party: c.party,
          beforeConsent,
          expiry: c.expiry,
          category,
        });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Site-wide consent mechanism summary, merged across pages (§4.3). */
function buildConsentMechanism(captures: PageCapture[], inventory: InventoryItem[]): ConsentMechanism {
  const accept = captures.some((c) => c.consentUi.acceptAll);
  const reject = captures.some((c) => c.consentUi.rejectAll);
  const settings = captures.some((c) => c.consentUi.settings);
  const cmp = captures.map((c) => c.consentUi.cmpIdentified).find((x) => x) ?? null;

  // detectConsentUi already reports bannerPresent only for a recognized CMP or a real
  // consent container (controls are read only inside that container), so a stray notice
  // can't false-positive and a recognized CMP is never reported as "no banner".
  const anyBanner = captures.some((c) => c.consentUi.bannerPresent);

  // Non-blocking: a banner exists but tracking still fired before consent.
  const trackersBeforeConsent = inventory.some(
    (i) => i.firesBeforeConsent && VIOLATION_CATEGORIES.has(i.category),
  );
  const blocksBeforeConsent = anyBanner && !trackersBeforeConsent;

  // Consent Mode v2 default state (present ≠ gated, §6).
  let consentModeV2: ConsentModeState = "absent";
  const cm = captures.map((c) => c.consentMode);
  if (cm.some((s) => s.present)) {
    consentModeV2 = cm.some((s) => s.defaultDenied) ? "partial" : "present";
    // "present" here means signals exist but default appears granted (not gating).
  }

  return {
    bannerPresent: anyBanner,
    acceptAll: accept,
    rejectAll: reject,
    settings,
    blocksBeforeConsent,
    cmpIdentified: cmp,
    consentModeV2,
    gpcHonored: null, // not tested in v1
  };
}

/** Flatten one page's passes into the runtime before/after event lists (uses page 0). */
function buildRuntime(captures: PageCapture[]): RuntimeSplit {
  const rep = captures[0];
  if (!rep) return { beforeConsent: [], afterAccept: [], afterReject: [] };
  const toEvents = (cap: typeof rep.preConsent): RuntimeEvent[] => {
    const reqs: RuntimeEvent[] = cap.requests
      .filter((r) => r.isThirdParty)
      .map((r) => ({ type: "request" as const, name: r.domain, destination: r.url }));
    const cookies: RuntimeEvent[] = cap.cookies.map((c) => ({
      type: "cookie" as const,
      name: c.name,
      destination: c.domain,
    }));
    return [...reqs, ...cookies];
  };
  return {
    beforeConsent: toEvents(rep.preConsent),
    afterAccept: toEvents(rep.afterAccept),
    afterReject: toEvents(rep.afterReject),
  };
}

/** Compute findings + the 0–100 risk score (0 = best). */
function buildFindingsAndRisk(
  captures: PageCapture[],
  inventory: InventoryItem[],
  cookies: CookieRecord[],
  consent: ConsentMechanism,
): { findings: Finding[]; privacyScore: number } {
  const findings: Finding[] = [];
  // `risk` is an internal penalty (0 = clean, higher = worse). We invert it to a
  // privacyScore (100 = best) at the end so the report reads as a positive grade.
  let risk = 0;

  const pagesWithPath = (pred: (i: InventoryItem) => boolean) =>
    [...new Set(inventory.filter(pred).flatMap((i) => i.pages))].sort();

  // 1. Non-essential tracking before consent (analytics/marketing).
  const preTrackers = inventory.filter(
    (i) =>
      i.firesBeforeConsent &&
      (i.category === "analytics" || i.category === "marketing"),
  );
  if (preTrackers.length) {
    risk += Math.min(60, preTrackers.length * 15);
    findings.push({
      severity: "high",
      title: "Third-party tracking before consent",
      detail:
        "Non-essential analytics/marketing services set cookies and transmitted data before the visitor consented.",
      pages: pagesWithPath((i) => preTrackers.includes(i)),
      resources: preTrackers.map((i) => i.technology),
    });
  }

  // 2. No effective consent gating — applies whether the banner is missing entirely
  //    (no mechanism) or present but non-blocking. A site with no banner at all is at
  //    least as exposed as one with a broken banner, so both are penalized.
  const ungated = inventory.filter((i) => i.firesBeforeConsent && VIOLATION_CATEGORIES.has(i.category));
  if (ungated.length && !consent.blocksBeforeConsent) {
    risk += 20;
    const noBanner = !consent.bannerPresent;
    findings.push({
      severity: "high",
      title: noBanner ? "No consent mechanism" : "Non-blocking consent banner",
      detail: noBanner
        ? "No consent banner or CMP was detected, yet non-essential trackers fire on load — visitors have no way to refuse before data is collected."
        : "A consent banner is present, but non-essential requests/cookies fire on load before any choice is made.",
      pages: pagesWithPath((i) => ungated.includes(i)),
      resources: ungated.map((i) => i.technology),
    });
  }

  // 2b. Decline-path evidence (our differentiator over load-time-only scanners): did
  //     non-essential trackers still fire after an opt-out attempt? Only meaningful when
  //     the reject pass ran (afterReject populated).
  const TRACKING_COOKIE = /^_ga|^_gid|^_gat|^_fbp|^_gcl|^_uet|^IDE$|^MUID$/i;
  const declineResources = new Set<string>();
  const declinePages = new Set<string>();
  for (const cap of captures) {
    let hit = false;
    for (const r of cap.afterReject.requests) {
      if (!r.isThirdParty) continue;
      const v = lookupVendor(r.url);
      if (v && VIOLATION_CATEGORIES.has(v.category)) {
        declineResources.add(v.name);
        hit = true;
      }
    }
    for (const c of cap.afterReject.cookies) {
      if (TRACKING_COOKIE.test(c.name)) {
        declineResources.add(c.name);
        hit = true;
      }
    }
    if (hit) declinePages.add(cap.path);
  }
  if (declineResources.size) {
    if (consent.bannerPresent) risk += 20; // a banner that doesn't actually gate on reject
    findings.push({
      severity: "high",
      title: consent.bannerPresent ? "Consent banner does not block on decline" : "Trackers persist after opt-out attempt",
      detail: consent.bannerPresent
        ? "After choosing reject / opt-out, non-essential trackers still fired — the banner does not actually gate them. This is the decisive consent test."
        : "An opt-out was attempted and the page re-loaded; non-essential trackers still fired, consistent with no consent mechanism being present. (Decline-path test — stronger evidence than load-time observation alone.)",
      pages: [...declinePages].sort(),
      resources: [...declineResources],
    });
  }

  // 3. Consent Mode v2 present but defaulting to granted (not gating).
  if (consent.consentModeV2 === "present") {
    risk += 10;
    findings.push({
      severity: "medium",
      title: "Consent Mode v2 signals present but not gating",
      detail:
        "Google Consent Mode v2 signals were detected without a 'denied' default, so tags may still fire before consent.",
      pages: captures.filter((c) => c.consentMode.present).map((c) => c.path),
      resources: ["consent mode default state"],
    });
  }

  // 4. Legacy Universal Analytics tags (dead weight, §6). No separate score penalty —
  //    it's already counted as a pre-consent analytics tracker in finding 1; this finding
  //    is the removal recommendation.
  const legacyCookies = cookies.filter((c) => LEGACY_UA_COOKIE.test(c.name));
  if (legacyCookies.length) {
    findings.push({
      severity: "medium",
      title: "Legacy Universal Analytics tags",
      detail:
        "Retired Universal Analytics cookies/tags are still present and fire on load. Flag for removal as dead weight.",
      pages: [],
      resources: legacyCookies.map((c) => c.name),
    });
  }

  // 5. Dev/QA tools on production (§6).
  const devTools = inventory.filter((i) => i.category === "non-essential");
  if (devTools.length) {
    risk += Math.min(15, devTools.length * 10);
    findings.push({
      severity: "medium",
      title: "Development / QA tooling on production",
      detail:
        "Third-party dev/QA tools were detected on the live site; these usually should not ship to production.",
      pages: pagesWithPath((i) => i.category === "non-essential"),
      resources: devTools.map((i) => i.technology),
    });
  }

  // 6. reCAPTCHA timing — report, flag for human judgment, do not auto-high (§6).
  const recaptcha = inventory.find((i) => i.technology === "reCAPTCHA");
  if (recaptcha?.firesBeforeConsent) {
    findings.push({
      severity: "low",
      title: "reCAPTCHA loads site-wide before consent",
      detail:
        "reCAPTCHA (v3) loads on every page before consent. Often argued necessary for spam/security — categorize as functional and flag for human judgment.",
      pages: recaptcha.pages,
      resources: ["www.google.com/recaptcha"],
    });
  }

  return { findings, privacyScore: 100 - Math.min(100, risk) };
}

function buildSummary(
  inventory: InventoryItem[],
  cookies: CookieRecord[],
  captures: PageCapture[],
  privacyScore: number,
): Summary {
  const violatingBefore = inventory.filter(
    (i) => i.firesBeforeConsent && VIOLATION_CATEGORIES.has(i.category),
  );
  const cookiesBefore = cookies.filter(
    (c) => c.beforeConsent && c.category !== "necessary",
  );
  const domainsBefore = new Set<string>();
  for (const cap of captures) {
    for (const r of cap.preConsent.requests) {
      if (r.isThirdParty && !isNecessaryHost(r.domain)) domainsBefore.add(r.domain);
    }
  }
  const fonts = new Set<string>();
  for (const cap of captures) {
    for (const r of cap.preConsent.requests.concat(cap.afterAccept.requests)) {
      if (r.isFont && r.isThirdParty) fonts.add(r.domain);
    }
  }

  return {
    thirdPartyServices: inventory.length,
    trackersBeforeConsent: violatingBefore.length,
    cookiesBeforeConsent: cookiesBefore.length,
    domainsBeforeConsent: domainsBefore.size,
    thirdPartyFonts: fonts.size,
    privacyScore,
  };
}

/**
 * Surface legacy Universal Analytics as its own inventory line (it fires on load as a
 * retired analytics tag). Detected from its cookies; counted as a pre-consent tracker so
 * the score reflects it, and listed for parity with manual scanners.
 */
function addLegacyUaService(inventory: InventoryItem[], captures: PageCapture[]): void {
  const pages = new Set<string>();
  let firesBefore = false;
  for (const cap of captures) {
    if (cap.preConsent.cookies.some((c) => LEGACY_UA_COOKIE.test(c.name))) {
      pages.add(cap.path);
      firesBefore = true;
    } else if (cap.afterAccept.cookies.some((c) => LEGACY_UA_COOKIE.test(c.name))) {
      pages.add(cap.path);
    }
  }
  if (pages.size === 0 || inventory.some((i) => i.technology === "Universal Analytics (legacy)")) return;
  inventory.push({
    technology: "Universal Analytics (legacy)",
    vendor: "Google",
    purpose: "Analytics (retired)",
    dataRecipient: "Google",
    category: "analytics",
    firesBeforeConsent: firesBefore,
    injectionSource: "gtm",
    inPolicy: "review",
    pages: [...pages].sort(),
  });
}

/** Top-level: assemble the full AuditReport from per-page captures. */
export function buildReport(
  domain: string,
  captures: PageCapture[],
  method: string,
): AuditReport {
  const inventory = buildInventory(captures);
  addLegacyUaService(inventory, captures);
  const cookies = buildCookies(captures);
  const consentMechanism = buildConsentMechanism(captures, inventory);
  const runtime = buildRuntime(captures);
  const { findings, privacyScore } = buildFindingsAndRisk(captures, inventory, cookies, consentMechanism);
  const summary = buildSummary(inventory, cookies, captures, privacyScore);

  return {
    scan: {
      domain,
      scannedAt: new Date().toISOString(),
      method,
      pagesScanned: captures.map((c) => c.url),
    },
    summary,
    inventory,
    cookies,
    consentMechanism,
    runtime,
    findings,
  };
}
