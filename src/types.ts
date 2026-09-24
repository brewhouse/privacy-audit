/**
 * Output JSON schema — the integration contract from CLAUDE.md §5.
 * These field names map directly onto the Word report sections and MUST stay stable.
 */

export type Category = "necessary" | "functional" | "analytics" | "marketing" | "non-essential" | "unknown";
export type InjectionSource = "theme" | "gtm" | "plugin" | "unknown";
export type InPolicy = "yes" | "no" | "review";
export type Party = "first" | "third";
export type Severity = "high" | "medium" | "low";
export type ConsentModeState = "present" | "partial" | "absent";
/** Per-item exposure grade, shown alongside each tracker / cookie / domain row. */
export type RiskLevel = "high" | "medium" | "low" | "none";

export interface ScanMeta {
  domain: string;
  scannedAt: string; // ISO-8601 with timezone offset
  method: string;
  pagesScanned: string[];
}

export interface Summary {
  thirdPartyServices: number;
  trackersBeforeConsent: number;
  cookiesBeforeConsent: number;
  domainsBeforeConsent: number;
  thirdPartyFonts: number;
  privacyScore: number; // 0–100, 100 = best (no issues); our own weighting, see §6
  /** Total / before-consent / after-consent-only splits per section. */
  breakdown: Breakdown;
}

/** total = everything observed; beforeConsent = fired pre-choice; afterOnly = the rest. */
export interface SectionCounts {
  total: number;
  beforeConsent: number;
  afterConsentOnly: number;
}

export interface Breakdown {
  services: SectionCounts;
  cookies: SectionCounts;
  firstPartyCookies: SectionCounts;
  thirdPartyCookies: SectionCounts;
  domains: SectionCounts;
}

export interface InventoryItem {
  technology: string;
  vendor: string;
  purpose: string;
  dataRecipient: string;
  category: Category;
  firesBeforeConsent: boolean;
  injectionSource: InjectionSource;
  inPolicy: InPolicy;
  pages: string[];
  /** Exposure grade for this service (derived from category + whether it fires pre-consent). */
  risk: RiskLevel;
  /**
   * Cookieless, privacy-first analytics. Still listed and still marked as firing before
   * consent, but excluded from the violation counts and the score (see vendor-map.ts).
   */
  cookieless: boolean;
  /** Earliest time (ms after navigation start) this service was seen on the representative page. */
  firstSeenMs: number | null;
}

export interface CookieRecord {
  name: string;
  domain: string;
  party: Party;
  beforeConsent: boolean;
  expiry: string | null;
  category: Category;
  /** Exposure grade for this cookie (derived from category + whether it is set pre-consent). */
  risk: RiskLevel;
}

export interface ConsentMechanism {
  bannerPresent: boolean;
  acceptAll: boolean;
  rejectAll: boolean;
  settings: boolean;
  blocksBeforeConsent: boolean;
  cmpIdentified: string | null;
  consentModeV2: ConsentModeState;
  gpcHonored: boolean | null;
  /** Whether a GPC pass actually ran (distinguishes "not honored" from "not tested"). */
  gpcTested: boolean;
}

export interface RuntimeEvent {
  type: "request" | "cookie";
  name: string;
  destination: string;
}

export interface RuntimeSplit {
  beforeConsent: RuntimeEvent[];
  afterAccept: RuntimeEvent[];
  afterReject: RuntimeEvent[];
}

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  pages: string[];
  resources: string[];
}

/** Per-page risk row — lets the report rank pages worst-first instead of reporting one site-wide score. */
export interface PageRisk {
  url: string;
  path: string;
  /** 0–100, 100 = best — same scale and weighting as summary.privacyScore, scoped to this page. */
  score: number;
  /** Titles of the findings that apply to this page. */
  issues: string[];
  trackersBeforeConsent: number;
  cookiesBeforeConsent: number;
  domainsBeforeConsent: number;
}

export interface AuditReport {
  scan: ScanMeta;
  summary: Summary;
  inventory: InventoryItem[];
  cookies: CookieRecord[];
  consentMechanism: ConsentMechanism;
  runtime: RuntimeSplit;
  findings: Finding[];
  /** Site-wide distinct third-party hosts contacted before consent (backs the summary count). */
  beforeConsentDomains: string[];
  /** URL of a privacy policy link found on the site, or null if none was found. */
  privacyPolicyUrl: string | null;
  /** URL of a cookie policy link found on the site, or null if none was found. */
  cookiePolicyUrl: string | null;
  /**
   * URL of a US state-privacy opt-out link ("Do Not Sell or Share My Personal
   * Information" / "Your Privacy Choices"), or null if none was found.
   */
  usOptOutLinkUrl: string | null;
  /** Per-page risk scores, worst-first. */
  pageRisks: PageRisk[];
}

// ---- Internal capture types (not part of the output contract) ----

export interface CapturedRequest {
  url: string;
  domain: string;
  resourceType: string;
  isThirdParty: boolean;
  isFont: boolean;
  /** Milliseconds after navigation start when the request was issued (for the consent timeline). */
  firstSeenMs: number;
}

export interface CapturedCookie {
  name: string;
  domain: string;
  party: Party;
  expiry: string | null;
}

export interface CapturedScript {
  src: string | null; // null for inline
  inline: boolean;
  injectionHint: InjectionSource;
}

/** Consent-mode signals scraped from the page's dataLayer / gtag calls. */
export interface ConsentModeSignals {
  present: boolean;
  defaultDenied: boolean; // any default state set to "denied"
  defaultGranted: boolean; // any default state set to "granted"
}

/** A single capture pass (pre-consent, post-accept, or post-reject) for one page. */
export interface CapturePass {
  requests: CapturedRequest[];
  cookies: CapturedCookie[];
  scripts: CapturedScript[];
}

/**
 * Result of the Global Privacy Control pass: the page re-loaded in a fresh context that
 * sends `Sec-GPC: 1` and exposes `navigator.globalPrivacyControl === true`.
 */
export interface GpcProbe {
  tested: boolean;
  /** true when non-essential trackers seen without GPC were suppressed under GPC. */
  honored: boolean | null;
  /** Services that stopped firing under GPC. */
  suppressed: string[];
  /** Services that kept firing under GPC. */
  persisted: string[];
}

export interface ConsentUiInfo {
  bannerPresent: boolean;
  acceptAll: boolean;
  rejectAll: boolean;
  settings: boolean;
  cmpIdentified: string | null;
}

/** Everything captured for a single page across all passes. */
export interface PageCapture {
  url: string;
  path: string; // pathname, used in report `pages` arrays
  capturedAt: string; // ISO-8601 timestamp of when this page was captured
  preConsent: CapturePass;
  afterAccept: CapturePass;
  afterReject: CapturePass;
  consentUi: ConsentUiInfo;
  consentMode: ConsentModeSignals;
  harPath: string | null;
  screenshotPath: string | null;
  privacyPolicyUrl?: string | null;
  cookiePolicyUrl?: string | null;
  usOptOutLinkUrl?: string | null;
  gpc?: GpcProbe;
  error?: string;
}
