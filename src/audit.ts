import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { buildReport } from "./aggregate.js";
import { capturePage } from "./capture.js";
import { enumerateUrls } from "./enumerate.js";
import type { AuditReport, PageCapture } from "./types.js";

export const AUDIT_METHOD = "runtime headless (Playwright + autoconsent)";

export interface AuditRunOptions {
  maxPages: number;
  sampleByTemplate: boolean;
  doReject: boolean;
  respectRobots: boolean;
  outputDir: string;
  log: (m: string) => void;
  /** Optional per-page progress callback for the server/job queue. */
  onProgress?: (done: number, total: number, url: string) => void;
}

export interface AuditRunResult {
  report: AuditReport;
  outputDir: string;
  evidenceDir: string;
  reportJsonPath: string;
  captures: PageCapture[];
}

export function normalizeDomain(input: string): string {
  const d = input.trim();
  return /^https?:\/\//i.test(d) ? d : `https://${d}`;
}

/**
 * Core audit pipeline shared by the CLI and the hosted server:
 * launch browser → enumerate → per-page capture → aggregate → write report.json.
 * Evidence (HAR + screenshots) is written into `${outputDir}/evidence` by capturePage.
 */
export async function performAudit(domainInput: string, opts: AuditRunOptions): Promise<AuditRunResult> {
  const domain = normalizeDomain(domainInput);
  await mkdir(opts.outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const captures: PageCapture[] = [];
  try {
    const urls = await enumerateUrls(browser, domain, {
      maxPages: opts.maxPages,
      sampleByTemplate: opts.sampleByTemplate,
      respectRobots: opts.respectRobots,
      log: opts.log,
    });

    let i = 0;
    for (const url of urls) {
      i += 1;
      opts.log(`[${i}/${urls.length}] ${url}`);
      opts.onProgress?.(i, urls.length, url);
      const cap = await capturePage(browser, url, i, {
        outputDir: opts.outputDir,
        doReject: opts.doReject,
        log: opts.log,
      });
      captures.push(cap);
    }
  } finally {
    await browser.close();
  }

  const report = buildReport(domain, captures, AUDIT_METHOD);
  const reportJsonPath = path.join(opts.outputDir, "report.json");
  await writeFile(reportJsonPath, JSON.stringify(report, null, 2), "utf8");

  return {
    report,
    outputDir: opts.outputDir,
    evidenceDir: path.join(opts.outputDir, "evidence"),
    reportJsonPath,
    captures,
  };
}
