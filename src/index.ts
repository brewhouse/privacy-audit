#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { chromium } from "playwright";
import { buildReport } from "./aggregate.js";
import { capturePage } from "./capture.js";
import { enumerateUrls } from "./enumerate.js";
import { renderReportDocx } from "./report-docx.js";
import type { AuditReport, PageCapture } from "./types.js";

const METHOD = "runtime headless (Playwright + autoconsent)";

interface ScanOptions {
  maxPages: string;
  sampleByTemplate: boolean;
  reject: boolean;
  robots: boolean;
  out: string;
  verbose: boolean;
  docx: boolean;
  client?: string;
  reportVersion: string;
}

function makeLogger(verbose: boolean) {
  return (msg: string) => {
    if (verbose) console.error(msg);
  };
}

/** Build an output dir like output/www.example.com-2026-06-15T1527/ */
function runDir(base: string, domain: string): string {
  const host = (() => {
    try {
      return new URL(domain).hostname;
    } catch {
      return domain.replace(/[^a-z0-9.-]/gi, "_");
    }
  })();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  return path.join(base, `${host}-${stamp}`);
}

async function writeDocx(report: AuditReport, outPath: string, client: string | undefined, version: string) {
  const buf = await renderReportDocx(report, { clientName: client, reportVersion: version });
  await writeFile(outPath, buf);
}

async function runScan(domainArg: string, opts: ScanOptions) {
  const log = makeLogger(opts.verbose);

  let domain = domainArg.trim();
  if (!/^https?:\/\//i.test(domain)) domain = `https://${domain}`;

  const maxPages = Math.max(1, parseInt(opts.maxPages, 10) || 25);
  const outputDir = runDir(opts.out, domain);
  await mkdir(outputDir, { recursive: true });

  console.error(`\n▶ Privacy & Tracking Audit — ${domain}`);
  console.error(`  output: ${outputDir}`);
  console.error(`  passes: pre-consent → accept${opts.reject ? " → reject" : ""}\n`);

  const browser = await chromium.launch({ headless: true });
  const captures: PageCapture[] = [];

  try {
    console.error("• Enumerating URLs…");
    const urls = await enumerateUrls(browser, domain, {
      maxPages,
      sampleByTemplate: opts.sampleByTemplate,
      respectRobots: opts.robots,
      log,
    });
    console.error(`  ${urls.length} page(s) to scan.\n`);

    let i = 0;
    for (const url of urls) {
      i += 1;
      console.error(`• [${i}/${urls.length}] ${url}`);
      const cap = await capturePage(browser, url, i, { outputDir, doReject: opts.reject, log });
      if (cap.error) console.error(`  ⚠ ${cap.error}`);
      captures.push(cap);
    }
  } finally {
    await browser.close();
  }

  console.error("\n• Aggregating & classifying…");
  const report = buildReport(domain, captures, METHOD);

  const reportPath = path.join(outputDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  let docxPath: string | null = null;
  if (opts.docx) {
    console.error("• Rendering Word report…");
    docxPath = path.join(outputDir, "report.docx");
    await writeDocx(report, docxPath, opts.client, opts.reportVersion);
  }

  console.error("\n✔ Done.");
  console.error(`  report:     ${reportPath}`);
  if (docxPath) console.error(`  word:       ${docxPath}`);
  console.error(`  evidence:   ${path.join(outputDir, "evidence")} (HAR + screenshots)`);
  console.error(
    `\n  ${report.summary.thirdPartyServices} third-party services · ` +
      `${report.summary.trackersBeforeConsent} tracker(s) before consent · ` +
      `risk ${report.summary.riskScore}/100\n`,
  );

  console.log(reportPath);
}

async function runReport(jsonPath: string, opts: { out?: string; client?: string; reportVersion: string }) {
  const raw = await readFile(jsonPath, "utf8");
  const report = JSON.parse(raw) as AuditReport;
  const outPath = opts.out ?? jsonPath.replace(/\.json$/i, "") + ".docx";
  await writeDocx(report, outPath, opts.client, opts.reportVersion);
  console.error(`✔ Word report written: ${outPath}`);
  console.log(outPath);
}

function main() {
  const program = new Command();
  program
    .name("privacy-audit")
    .description("Audit a website's third-party tracking and consent behavior across all pages.");

  program
    .command("scan", { isDefault: true })
    .description("Crawl a site, capture before/after-consent behavior, and emit report JSON (+ evidence).")
    .argument("<domain>", "Site to audit, e.g. https://www.example.com")
    .option("-m, --max-pages <n>", "Maximum pages to scan", "25")
    .option("--sample-by-template", "Scan one representative page per URL template", false)
    .option("--no-reject", "Skip the reject (opt-out) pass")
    .option("--no-robots", "Do not respect robots.txt (use only on sites you control)")
    .option("-o, --out <dir>", "Output base directory", "output")
    .option("--docx", "Also render the branded Word report (report.docx)", false)
    .option("--client <name>", "Client/company name for the Word report")
    .option("--report-version <v>", "Report version for the Word report", "1.0")
    .option("-v, --verbose", "Verbose progress logging", false)
    .action((domain: string, opts: ScanOptions) => runScan(domain, opts));

  program
    .command("report")
    .description("Render the branded Word report from an existing report.json.")
    .argument("<report.json>", "Path to a report.json produced by a scan")
    .option("-o, --out <file>", "Output .docx path (defaults next to the JSON)")
    .option("--client <name>", "Client/company name for the Word report")
    .option("--report-version <v>", "Report version", "1.0")
    .action((jsonPath: string, opts: { out?: string; client?: string; reportVersion: string }) => runReport(jsonPath, opts));

  program.showHelpAfterError();
  return program.parseAsync();
}

main().catch((err) => {
  console.error(`\n✖ Failed: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
