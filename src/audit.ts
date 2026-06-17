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
  /** Hard cap per page; on expiry the page is recorded as errored and the crawl continues. */
  pageTimeoutMs?: number;
  /** Abort the whole run (e.g. job timeout). Force-closes the browser to unblock pending ops. */
  signal?: AbortSignal;
}

// Backstop only — every capture sub-step (nav, screenshot, autoconsent, HAR close) is
// individually bounded, so this just guards against an unforeseen hang. Must exceed the
// sum of those bounds across both the accept and reject passes (~2× HAR close).
const DEFAULT_PAGE_TIMEOUT_MS = 300_000;

/** Reject if `p` doesn't settle within `ms` — guards against any operation hanging forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** A placeholder capture for a page that errored/timed out, so the report still builds. */
function erroredCapture(url: string, error: string): PageCapture {
  let pathname: string;
  try {
    pathname = new URL(url).pathname || "/";
  } catch {
    pathname = url;
  }
  const empty = { requests: [], cookies: [], scripts: [] };
  return {
    url,
    path: pathname,
    preConsent: { ...empty },
    afterAccept: { ...empty },
    afterReject: { ...empty },
    consentUi: { bannerPresent: false, acceptAll: false, rejectAll: false, settings: false, cmpIdentified: null },
    consentMode: { present: false, defaultDenied: false, defaultGranted: false },
    harPath: null,
    screenshotPath: null,
    error,
  };
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

  const pageTimeout = opts.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const browser = await chromium.launch({ headless: true });

  // On abort (e.g. job-level timeout), force-close the browser so any in-flight
  // Playwright call rejects and the run unwinds instead of hanging.
  const onAbort = () => {
    void browser.close().catch(() => {});
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

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
      if (opts.signal?.aborted) throw new Error("Audit aborted");
      i += 1;
      opts.log(`[${i}/${urls.length}] ${url}`);
      opts.onProgress?.(i, urls.length, url);
      try {
        const cap = await withTimeout(
          capturePage(browser, url, i, { outputDir: opts.outputDir, doReject: opts.doReject, log: opts.log }),
          pageTimeout,
          `page ${i} (${url})`,
        );
        captures.push(cap);
      } catch (err) {
        // One bad/slow page must not wedge the whole crawl — record it and move on.
        const msg = (err as Error).message;
        opts.log(`  page failed: ${msg}`);
        captures.push(erroredCapture(url, msg));
      }
    }
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    await browser.close().catch(() => {});
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
