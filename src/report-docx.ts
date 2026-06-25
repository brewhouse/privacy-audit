import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import type {
  AuditReport,
  Finding,
  RuntimeEvent,
  Severity,
} from "./types.js";

/**
 * Word report generator — renders the §5 AuditReport JSON into Planeteria's branded
 * audit document, matching the section layout of Website_Privacy_Tracking_Audit_TEMPLATE.docx.
 *
 * Built fresh with docx-js (rather than filling the template's XML) because the inventory,
 * cookie, runtime and findings tables have variable row counts that string-replacement
 * can't handle cleanly. Branding (fonts/colors) mirrors the template's styles.
 */

// --- Branding (lifted from the template's styles) ---
const FONT = "Arial";
const NAVY = "1F3A5F"; // Heading 1
const BLUE = "2E6DA4"; // Heading 2 / borders
const GOLD = "E0B000"; // accent border
const GOLD_FILL = "FFF8E1"; // notice box fill
const GOLD_TEXT = "8A6D00";
const HEADER_FILL = "DCE6F1"; // table header
const GREEN_FILL = "E2EFDA"; // "good" / suppressed
const RED_FILL = "FCE4E4"; // "concern" / fires before consent
const YELLOW_FILL = "FFF2CC"; // caution
const GREY = "BFBFBF";

const CONTENT_WIDTH = 9360; // US Letter, 1" margins

const ROW_CAP = 40; // cap long runtime lists in the doc; full data lives in report.json/HAR

export interface DocxOptions {
  clientName?: string;
  agencyName?: string;
  reportVersion?: string;
}

// ---------- small helpers ----------

// privacyScore: 100 = best. Lower scores mean more exposure.
function riskLevel(score: number): { label: string; fill: string } {
  if (score <= 40) return { label: "Elevated", fill: RED_FILL };
  if (score <= 70) return { label: "Moderate", fill: YELLOW_FILL };
  return { label: "Low", fill: GREEN_FILL };
}

function severityFill(sev: Severity): string {
  return sev === "high" ? RED_FILL : sev === "medium" ? YELLOW_FILL : "EEF3F8";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function clientNameFromDomain(domain: string): string {
  try {
    const host = new URL(domain).hostname.replace(/^www\./, "");
    const base = host.split(".")[0] || host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return domain;
  }
}

function h1(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}
function h2(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
}
function para(text: string, opts: { bold?: boolean; italics?: boolean; color?: string; size?: number } = {}): Paragraph {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, color: opts.color, size: opts.size })],
  });
}
function bullet(text: string): Paragraph {
  return new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun(text)] });
}

const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: GREY };
const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function cell(text: string, width: number, opts: { bold?: boolean; fill?: string; color?: string; align?: typeof AlignmentType[keyof typeof AlignmentType] } = {}): TableCell {
  return new TableCell({
    borders: cellBorders,
    width: { size: width, type: WidthType.DXA },
    shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        alignment: opts.align,
        children: [new TextRun({ text, bold: opts.bold, color: opts.color, size: 18 })],
      }),
    ],
  });
}

/** Build a bordered table with a styled header row. `widths` must sum to CONTENT_WIDTH. */
function dataTable(headers: string[], widths: number[], rows: TableCell[][]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((hh, i) => cell(hh, widths[i], { bold: true, fill: HEADER_FILL, color: NAVY })),
  });
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: [headerRow, ...rows.map((r) => new TableRow({ children: r }))],
  });
}

/** Key/value two-column table for summaries. */
function kvTable(pairs: Array<[string, string, string?]>): Table {
  const widths = [3360, 6000];
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: pairs.map(
      ([k, v, fill]) =>
        new TableRow({
          children: [cell(k, widths[0], { bold: true, fill: HEADER_FILL, color: NAVY }), cell(v, widths[1], { fill })],
        }),
    ),
  });
}

function yesNo(b: boolean): string {
  return b ? "Yes" : "No";
}

// ---------- section builders ----------

function titleBlock(report: AuditReport, o: Required<DocxOptions>): Paragraph[] {
  return [
    new Paragraph({
      spacing: { before: 1200, after: 120 },
      children: [new TextRun({ text: "Website Privacy & Tracking Audit", bold: true, size: 56, color: NAVY })],
    }),
    new Paragraph({
      spacing: { after: 600 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GOLD, space: 4 } },
      children: [new TextRun({ text: "Technical assessment of third-party tracking and consent behavior", italics: true, size: 24, color: BLUE })],
    }),
    para(`Prepared for:  ${o.clientName}`, { bold: true }),
    para(`Website:  ${report.scan.domain}`),
    para(`Prepared by:  ${o.agencyName}`),
    para(`Date:  ${formatDate(report.scan.scannedAt)}`),
    para(`Report version:  ${o.reportVersion}`),
    new Paragraph({ pageBreakBefore: true, children: [] }),
  ];
}

function noticeBox(): Table {
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders: {
              top: { style: BorderStyle.SINGLE, size: 8, color: GOLD },
              bottom: { style: BorderStyle.SINGLE, size: 8, color: GOLD },
              left: { style: BorderStyle.SINGLE, size: 8, color: GOLD },
              right: { style: BorderStyle.SINGLE, size: 8, color: GOLD },
            },
            shading: { fill: GOLD_FILL, type: ShadingType.CLEAR, color: "auto" },
            margins: { top: 120, bottom: 120, left: 200, right: 200 },
            width: { size: CONTENT_WIDTH, type: WidthType.DXA },
            children: [
              new Paragraph({
                spacing: { after: 60 },
                children: [new TextRun({ text: "Important notice", bold: true, color: GOLD_TEXT })],
              }),
              new Paragraph({
                children: [
                  new TextRun({
                    text:
                      "This document is a technical assessment of observed runtime behavior, not legal advice and not a compliance determination. " +
                      "It describes what tracking technologies fired before and after consent at the time of testing. Whether any practice is " +
                      "lawful depends on the applicable jurisdictions and the organization’s own arrangements, and should be reviewed with legal counsel. " +
                      "Findings reflect the pages tested on the date shown; interaction-triggered behavior (chat, video, etc.) may not be captured.",
                    color: GOLD_TEXT,
                    size: 20,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function executiveSummary(report: AuditReport): (Paragraph | Table)[] {
  const s = report.summary;
  const risk = riskLevel(s.privacyScore);
  const top = [...report.findings]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 3);

  const out: (Paragraph | Table)[] = [
    h1("Executive Summary"),
    h2("Key findings at a glance"),
    kvTable([
      ["Privacy score (100 = best)", `${s.privacyScore} / 100 — ${risk.label} risk`, risk.fill],
      ["Third-party services", String(s.thirdPartyServices)],
      ["Trackers firing before consent", String(s.trackersBeforeConsent), s.trackersBeforeConsent > 0 ? RED_FILL : GREEN_FILL],
      ["Cookies set before consent", String(s.cookiesBeforeConsent), s.cookiesBeforeConsent > 0 ? RED_FILL : GREEN_FILL],
      ["Distinct third-party domains before consent", String(s.domainsBeforeConsent)],
      ["Third-party fonts", String(s.thirdPartyFonts)],
      ["Pages scanned", String(report.scan.pagesScanned.length)],
    ]),
  ];
  if ((report.beforeConsentDomains ?? []).length) {
    out.push(
      para(
        `“Distinct third-party domains before consent” (${s.domainsBeforeConsent}) is a site-wide total across all ${report.scan.pagesScanned.length} page(s) tested — the full list is in the appendix. Section 4 shows runtime detail for one representative page only.`,
        { italics: true, color: "666666", size: 18 },
      ),
    );
  }
  out.push(new Paragraph({ spacing: { after: 120 }, children: [] }), h2("Top priorities"));

  if (top.length === 0) {
    out.push(para("No material tracking-before-consent issues were observed on the pages tested.", { italics: true }));
  } else {
    top.forEach((f) =>
      out.push(
        new Paragraph({
          numbering: { reference: "numbers", level: 0 },
          children: [new TextRun({ text: `${f.title} `, bold: true }), new TextRun({ text: `— ${f.detail}` })],
        }),
      ),
    );
  }
  return out;
}

function severityRank(s: Severity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

function scopeAndMethod(report: AuditReport): (Paragraph | Table)[] {
  const pages = report.scan.pagesScanned;
  const out: (Paragraph | Table)[] = [
    h1("1. Scope & Methodology"),
    h2("1.1 What we assessed"),
    para(
      `We audited ${report.scan.domain} for third-party tracking and consent behavior across ${pages.length} page(s). ` +
        "For each page we recorded what loaded before any consent choice, then after accepting, then after declining.",
    ),
    para("Pages scanned:", { bold: true }),
    ...pages.slice(0, ROW_CAP).map((p) => bullet(p)),
  ];
  if (pages.length > ROW_CAP) out.push(para(`…and ${pages.length - ROW_CAP} more (see report.json).`, { italics: true }));

  out.push(
    h2("1.2 How we tested"),
    para(`Method: ${report.scan.method}.`),
    bullet("Each page loaded in a fresh, cookie-free browser context (no prior state)."),
    bullet("Pre-consent network requests, cookies, and scripts were captured before any interaction."),
    bullet("Consent was then accepted via automated consent handling (DuckDuckGo autoconsent), and the page re-captured."),
    bullet("A separate fresh context tested the decline/opt-out path — the decisive check of whether the banner blocks."),
    bullet("Raw evidence (HAR network logs + full-page screenshots + ISO-8601 timestamps) was preserved per page."),
    para(`Scan timestamp: ${report.scan.scannedAt}`, { italics: true, color: "666666" }),
  );
  return out;
}

function inventorySection(report: AuditReport): (Paragraph | Table)[] {
  const widths = [2000, 1300, 1700, 1360, 1000, 2000];
  const rows = report.inventory.map((it) => [
    cell(it.technology, widths[0]),
    cell(it.vendor, widths[1]),
    cell(it.purpose, widths[2]),
    cell(it.category, widths[3]),
    cell(yesNo(it.firesBeforeConsent), widths[4], { fill: it.firesBeforeConsent ? RED_FILL : GREEN_FILL, align: AlignmentType.CENTER }),
    cell(it.pages.join(", "), widths[5]),
  ]);
  const out: (Paragraph | Table)[] = [
    h1("2. Tracking Technology Inventory"),
    para(`${report.inventory.length} third-party service(s) were identified and classified by vendor and purpose.`),
  ];
  if (rows.length) {
    out.push(dataTable(["Tool", "Vendor", "Purpose", "Category", "Before consent", "Pages"], widths, rows));
    out.push(
      para(
        `“Before consent” marks every service that loads before a consent choice. The summary’s “trackers before consent” (${report.summary.trackersBeforeConsent}) counts only the analytics / marketing / non-essential subset — the categories that count as a privacy concern — which is why it is lower than the number of rows here.`,
        { italics: true, color: "666666", size: 18 },
      ),
    );
  } else {
    out.push(para("No third-party services were detected.", { italics: true }));
  }
  return out;
}

function consentSection(report: AuditReport): (Paragraph | Table)[] {
  const c = report.consentMechanism;
  return [
    h1("3. Consent Mechanism Review"),
    kvTable([
      ["Consent banner present", yesNo(c.bannerPresent)],
      ["Offers “accept all”", yesNo(c.acceptAll)],
      ["Offers “reject all”", yesNo(c.rejectAll), c.bannerPresent && !c.rejectAll ? YELLOW_FILL : undefined],
      ["Offers settings / preferences", yesNo(c.settings)],
      ["Blocks non-essential scripts before consent", yesNo(c.blocksBeforeConsent), c.blocksBeforeConsent ? GREEN_FILL : RED_FILL],
      ["CMP identified", c.cmpIdentified ?? "Not identified"],
      ["Google Consent Mode v2", c.consentModeV2],
      ["GPC honored", c.gpcHonored === null ? "Not tested" : yesNo(c.gpcHonored)],
    ]),
    para(
      c.bannerPresent && !c.blocksBeforeConsent
        ? "A consent banner is present but does not block non-essential scripts before a choice is made (a “non-blocking” banner)."
        : c.bannerPresent
          ? "A consent banner is present and non-essential scripts were not observed firing before consent on the pages tested."
          : "No consent banner was detected on the pages tested.",
      { italics: true },
    ),
    para(
      "Note: Consent Mode v2 being present does not mean tags are gated — the default state matters. A “present” status here indicates signals were detected without a “denied” default.",
      { italics: true, color: "666666", size: 18 },
    ),
    para(
      "Banner / CMP detection is automated (heuristic DOM scan cross-checked against autoconsent). A detected container is only reported as a banner if it exposes a consent control or a recognized CMP, to avoid false positives from generic notices or Consent Mode code. Automated detection can still err in both directions — manual verification in a browser is recommended before relying on this section for a legal demand.",
      { italics: true, color: "666666", size: 18 },
    ),
    ...(c.cmpIdentified && !c.acceptAll && !c.rejectAll && !c.settings
      ? [
          para(
            `A consent platform (${c.cmpIdentified}) was detected, but its banner did not display to the scan. Consent banners are commonly geo-targeted to regulated regions (EU/UK), so accept/reject/preferences controls could not be observed from the scan location — visitors outside the targeted regions likewise see no prompt. Verify the banner and its controls from a targeted region.`,
            { italics: true, color: "666666", size: 18 },
          ),
        ]
      : []),
  ];
}

function runtimeEventTable(events: RuntimeEvent[], fill?: string): Table | Paragraph {
  if (events.length === 0) return para("None observed.", { italics: true });
  const widths = [1400, 3000, 4960];
  const shown = events.slice(0, ROW_CAP);
  const rows = shown.map((e) => [cell(e.type, widths[0], { fill }), cell(e.name, widths[1]), cell(e.destination, widths[2])]);
  return dataTable(["Type", "Name", "Destination"], widths, rows);
}

function runtimeSection(report: AuditReport): (Paragraph | Table)[] {
  const r = report.runtime;
  const rep = report.scan.pagesScanned[0] ?? "the representative page";
  const note = (events: RuntimeEvent[]) =>
    events.length > ROW_CAP ? para(`…and ${events.length - ROW_CAP} more (see report.json / HAR).`, { italics: true }) : null;

  const out: (Paragraph | Table)[] = [
    h1("4. Runtime Behavior Findings"),
    para(`Runtime events below are for the representative page (${rep}). Site-wide aggregation is in Sections 2 and 6.`, { italics: true, color: "666666", size: 18 }),
    h2("4.1 Before consent (on page load, no interaction)"),
    runtimeEventTable(r.beforeConsent, RED_FILL),
  ];
  const n1 = note(r.beforeConsent); if (n1) out.push(n1);

  out.push(h2("4.2 After accepting consent"), runtimeEventTable(r.afterAccept, GREEN_FILL));
  const n2 = note(r.afterAccept); if (n2) out.push(n2);

  out.push(
    h2("4.3 After declining consent"),
    para("This is the decisive check: anything non-essential here fired despite the visitor declining.", { italics: true }),
    runtimeEventTable(r.afterReject, YELLOW_FILL),
  );
  const n3 = note(r.afterReject); if (n3) out.push(n3);
  return out;
}

function policyAlignmentSection(report: AuditReport): (Paragraph | Table)[] {
  const review = report.inventory.filter((i) => i.inPolicy === "review");
  const out: (Paragraph | Table)[] = [h1("5. Privacy Policy Alignment")];

  // State the one concrete finding we can make automatically: was a policy link found?
  out.push(
    report.privacyPolicyUrl
      ? para(`A linked privacy / cookie policy was found on the site: ${report.privacyPolicyUrl}`, { bold: true })
      : para("No linked privacy / cookie policy was found on the pages scanned — confirm one is published and linked in the footer.", {
          bold: true,
          color: "7a1f1f",
        }),
  );
  out.push(
    para(
      "Whether each tool below is actually disclosed in that policy is a manual reconciliation step for the client and their counsel — the audit flags the tools to check, it does not interpret policy text.",
    ),
  );
  if (review.length) {
    out.push(para("Tools to reconcile against the policy:", { bold: true }));
    review.forEach((i) => out.push(bullet(`${i.technology} (${i.vendor}) — ${i.purpose}`)));
  } else {
    out.push(para("No tools were flagged for policy reconciliation.", { italics: true }));
  }
  return out;
}

function riskFindingsSection(report: AuditReport): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [h1("6. Risk Findings")];
  if (report.findings.length === 0) {
    out.push(para("No material risk findings were identified on the pages tested.", { italics: true }));
    return out;
  }
  const widths = [1200, 2900, 5260];
  const rows = report.findings.map((f) => [
    cell(f.severity.toUpperCase(), widths[0], { bold: true, fill: severityFill(f.severity), align: AlignmentType.CENTER }),
    cell(f.title, widths[1], { bold: true }),
    cell(findingDetail(f), widths[2]),
  ]);
  out.push(dataTable(["Severity", "Finding", "Detail"], widths, rows));
  out.push(para("Severity reflects technical exposure observed at runtime, not a legal determination.", { italics: true, color: "666666", size: 18 }));
  return out;
}

function findingDetail(f: Finding): string {
  let d = f.detail;
  if (f.pages.length) d += `  Pages: ${f.pages.slice(0, 8).join(", ")}${f.pages.length > 8 ? "…" : ""}.`;
  if (f.resources.length) d += `  Resources: ${f.resources.slice(0, 8).join(", ")}${f.resources.length > 8 ? "…" : ""}.`;
  return d;
}

/** True when non-essential trackers actually fire before consent — the real remediation
 *  driver. Findings like dev/QA tooling or reCAPTCHA can exist without anything firing
 *  pre-consent, in which case "block trackers before consent" advice would be misleading. */
function hasPreConsentTracking(report: AuditReport): boolean {
  const titles = new Set(report.findings.map((f) => f.title));
  return (
    report.summary.trackersBeforeConsent > 0 ||
    titles.has("Third-party tracking before consent") ||
    titles.has("Non-blocking consent banner") ||
    titles.has("No consent mechanism") ||
    titles.has("Consent banner does not block on decline") ||
    titles.has("Trackers persist after opt-out attempt")
  );
}

function recommendationsSection(report: AuditReport): (Paragraph | Table)[] {
  const titles = new Set(report.findings.map((f) => f.title));
  const preConsent = hasPreConsentTracking(report);
  const tech: string[] = [];

  // Finding-specific recommendations (only when that finding exists).
  if (preConsent) tech.push("Block non-essential scripts (analytics, advertising, embeds) until the visitor opts in.");
  if (titles.has("Consent Mode v2 signals present but not gating"))
    tech.push("Configure Google Consent Mode v2 to default to “denied” and honor GPC signals.");
  if (titles.has("Legacy Universal Analytics tags"))
    tech.push("Remove retired Universal Analytics tags/cookies that still load — dead weight.");
  if (titles.has("Development / QA tooling on production"))
    tech.push("Remove development / QA tooling (e.g. BugHerd) from the production site — it should not be on a live site even if gated.");
  // Pre-consent-blocking advice only when something actually fires before consent.
  if (preConsent) {
    tech.push("Manually block any scripts hardcoded in the theme that the consent platform does not auto-detect.");
    tech.push("Re-test in the browser to confirm nothing non-essential fires before consent, and document the result.");
  }

  if (tech.length === 0) {
    // Fully clean — maintenance, not remediation.
    tech.push("No non-essential trackers were observed firing before consent — the current consent setup is working. Maintain it.");
    tech.push("As new analytics, advertising, or embedded tools are added, add matching blocking/consent rules so they stay gated until consent.");
    tech.push("Re-scan periodically (e.g. quarterly) and after major site or marketing-stack changes to confirm the gating still holds.");
  } else if (!preConsent) {
    // Findings exist (e.g. dev/QA tooling) but nothing fires before consent — make that clear.
    tech.push("No non-essential trackers were observed firing before consent; once the item(s) above are addressed, re-scan periodically to confirm the gating still holds.");
  }

  const out: (Paragraph | Table)[] = [h1("7. Recommendations"), h2("7.1 Technical (implementation)")];
  tech.forEach((t) => out.push(bullet(t)));

  out.push(
    h2("7.2 Policy (for the client’s legal counsel)"),
    bullet("Confirm the consent approach fits the jurisdictions the business operates in."),
    bullet("Update the privacy / cookie policy so disclosed tools match those actually in use."),
    bullet("Determine whether any tools require a data processing agreement or additional disclosures."),
  );
  return out;
}

function nextStepsSection(report: AuditReport): (Paragraph | Table)[] {
  let steps: string[];
  if (hasPreConsentTracking(report)) {
    steps = [
      "Review this assessment with the client and their legal counsel.",
      "Prioritize blocking non-essential trackers before consent.",
      "Implement the technical recommendations and reconcile the privacy policy.",
      "Schedule a re-scan to verify the fixes and preserve a new evidence baseline.",
    ];
  } else if (report.findings.length === 0) {
    steps = [
      "No non-essential trackers were observed firing before consent on the pages tested — no remediation is required at this time.",
      "Re-scan periodically (e.g. quarterly) and after adding any new analytics, advertising, or embedded tools.",
      "Keep the consent platform and its blocking / consent-mode rules updated as the site evolves.",
      "Retain this report and the raw evidence (HAR + screenshots) as a compliance baseline.",
    ];
  } else {
    // Findings remain but nothing fires before consent (e.g. dev/QA tooling still installed).
    steps = [
      "No non-essential trackers were observed firing before consent — the consent setup is gating correctly.",
      "Address the remaining item(s) in the findings above (e.g. remove development / QA tooling from production).",
      "Re-scan after the change, then periodically; retain this report and evidence as a baseline.",
    ];
  }
  const out: (Paragraph | Table)[] = [h1("8. Proposed Next Steps")];
  steps.forEach((s) => out.push(new Paragraph({ numbering: { reference: "numbers2", level: 0 }, children: [new TextRun(s)] })));
  return out;
}

/** Static table of contents — rendered as plain text so it always shows (an auto TOC
 *  field renders blank until Word updates it, which looks unfinished in a deliverable). */
function contentsSection(report: AuditReport): Paragraph[] {
  const items = [
    "Important Notice",
    "Executive Summary",
    "1. Scope & Methodology",
    "2. Tracking Technology Inventory",
    "3. Consent Mechanism Review",
    "4. Runtime Behavior Findings",
    "5. Privacy Policy Alignment",
    "6. Risk Findings",
    "7. Recommendations",
    "8. Proposed Next Steps",
  ];
  if ((report.beforeConsentDomains ?? []).length) items.push("Appendix — Third-party domains contacted before consent");
  return [
    h1("Contents"),
    ...items.map((i) => new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: i, color: BLUE })] })),
  ];
}

/** Appendix listing the full site-wide set of domains contacted before consent, so the
 *  summary's count is backed up in the document (not just in evidence). */
function appendixSection(report: AuditReport): (Paragraph | Table)[] {
  const domains = report.beforeConsentDomains ?? [];
  if (!domains.length) return [];
  const out: (Paragraph | Table)[] = [
    new Paragraph({ pageBreakBefore: true, children: [] }),
    h1("Appendix — Third-party domains contacted before consent"),
    para(
      `The ${domains.length} distinct third-party host(s) below were contacted before any consent choice, aggregated across all ${report.scan.pagesScanned.length} page(s) tested. Strictly-necessary infrastructure (consent platform, CDN, security, payment) is excluded. Full request-level detail is in the per-page HAR evidence.`,
    ),
  ];
  const widths = [4680, 4680];
  const rows: TableCell[][] = [];
  for (let i = 0; i < domains.length; i += 2) {
    rows.push([cell(domains[i], widths[0]), cell(domains[i + 1] ?? "", widths[1])]);
  }
  out.push(dataTable(["Domain", "Domain"], widths, rows));
  return out;
}

// ---------- top-level document ----------

export function buildReportDocument(report: AuditReport, options: DocxOptions = {}): Document {
  const o: Required<DocxOptions> = {
    clientName: options.clientName ?? clientNameFromDomain(report.scan.domain),
    agencyName: options.agencyName ?? "Planeteria Media",
    reportVersion: options.reportVersion ?? "1.0",
  };

  return new Document({
    styles: {
      default: { document: { run: { font: FONT, size: 22 } } },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 30, bold: true, font: FONT, color: NAVY },
          paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 0 },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 24, bold: true, font: FONT, color: BLUE },
          paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 1 },
        },
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
        { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
        { reference: "numbers2", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      ],
    },
    sections: [
      {
        properties: {
          page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: GOLD, space: 2 } },
                children: [new TextRun({ text: `${o.agencyName} · Privacy & Tracking Audit`, size: 16, color: "888888" })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: "Confidential — technical assessment, not legal advice    ", size: 16, color: "888888" }),
                  new TextRun({ text: "Page ", size: 16, color: "888888" }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "888888" }),
                ],
              }),
            ],
          }),
        },
        children: [
          ...titleBlock(report, o),
          ...contentsSection(report),
          new Paragraph({ pageBreakBefore: true, children: [] }),
          h1("Important Notice"),
          noticeBox(),
          new Paragraph({ pageBreakBefore: true, children: [] }),
          ...executiveSummary(report),
          new Paragraph({ pageBreakBefore: true, children: [] }),
          ...scopeAndMethod(report),
          ...inventorySection(report),
          ...consentSection(report),
          ...runtimeSection(report),
          ...policyAlignmentSection(report),
          ...riskFindingsSection(report),
          ...recommendationsSection(report),
          ...nextStepsSection(report),
          ...appendixSection(report),
        ],
      },
    ],
  });
}

/** Render the report to a .docx Buffer. */
export async function renderReportDocx(report: AuditReport, options: DocxOptions = {}): Promise<Buffer> {
  const doc = buildReportDocument(report, options);
  return Packer.toBuffer(doc);
}
