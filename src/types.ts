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
}

export interface CookieRecord {
  name: string;
  domain: string;
  party: Party;
  beforeConsent: boolean;
  expiry: string | null;
  category: Category;
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
}

// ---- Internal capture types (not part of the output contract) ----

export interface CapturedRequest {
  url: string;
  domain: string;
  resourceType: string;
  isThirdParty: boolean;
  isFont: boolean;
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
  error?: string;
}
