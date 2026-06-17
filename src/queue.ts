import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performAudit } from "./audit.js";
import { renderReportDocx } from "./report-docx.js";
import { loadStorageConfig, ObjectStorage } from "./storage.js";
import type { AuditReport } from "./types.js";

/**
 * In-process job queue for hosted audits (CLAUDE.md §8 — modest concurrency).
 *
 * POST enqueues a job and returns an id immediately; a concurrency-limited worker
 * runs the crawl, uploads report.json + report.docx + evidence to object storage,
 * and records the URLs on the job. GET polls by id. Jobs live in memory — fine for
 * a single instance; move to Redis/BullMQ if you scale to multiple workers.
 */

export type JobStatus = "queued" | "running" | "done" | "error";

export interface JobOptions {
  maxPages: number;
  sampleByTemplate: boolean;
  doReject: boolean;
  respectRobots: boolean;
  client?: string;
}

export interface JobResult {
  report: AuditReport;
  urls: { reportJson: string; reportDocx: string; evidence: Array<{ name: string; url: string }> };
}

export interface Job {
  id: string;
  domain: string;
  options: JobOptions;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: { done: number; total: number; url: string };
  result?: JobResult;
  error?: string;
}

const CONCURRENCY = Math.max(1, Number(process.env.AUDIT_CONCURRENCY) || 1);
// Wall-clock cap per job. On expiry the run is aborted and the worker slot freed,
// so a single hung crawl can never block the queue indefinitely.
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 20 * 60 * 1000;
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS) || 120_000;

export class AuditQueue {
  private jobs = new Map<string, Job>();
  private waiting: string[] = [];
  private active = 0;
  private storage: ObjectStorage | null;

  constructor() {
    const cfg = loadStorageConfig();
    this.storage = cfg ? new ObjectStorage(cfg) : null;
  }

  get storageConfigured(): boolean {
    return this.storage !== null;
  }

  enqueue(domain: string, options: JobOptions): Job {
    const job: Job = {
      id: randomUUID(),
      domain,
      options,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.waiting.push(job.id);
    this.pump();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Public view of a job (omits nothing sensitive; report is large but intended for the caller). */
  view(job: Job) {
    return {
      id: job.id,
      domain: job.domain,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: job.progress,
      error: job.error,
      result: job.result,
    };
  }

  private pump() {
    while (this.active < CONCURRENCY && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const job = this.jobs.get(id);
      if (!job) continue;
      this.active += 1;
      this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    const workDir = await mkdtemp(path.join(tmpdir(), `audit-${job.id}-`));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
    try {
      const { report, evidenceDir, reportJsonPath } = await performAudit(job.domain, {
        maxPages: job.options.maxPages,
        sampleByTemplate: job.options.sampleByTemplate,
        doReject: job.options.doReject,
        respectRobots: job.options.respectRobots,
        outputDir: workDir,
        log: () => {},
        signal: controller.signal,
        pageTimeoutMs: PAGE_TIMEOUT_MS,
        onProgress: (done, total, url) => {
          job.progress = { done, total, url };
        },
      });

      // Render the Word report alongside the JSON.
      const docxPath = path.join(workDir, "report.docx");
      await writeFile(docxPath, await renderReportDocx(report, { clientName: job.options.client }));

      if (!this.storage) {
        // No object storage configured: return the report inline, no evidence URLs.
        job.result = { report, urls: { reportJson: "", reportDocx: "", evidence: [] } };
      } else {
        const prefix = `audits/${job.id}`;
        const reportJsonUrl = await this.storage.uploadFile(reportJsonPath, `${prefix}/report.json`);
        const reportDocxUrl = await this.storage.uploadFile(docxPath, `${prefix}/report.docx`);
        const evidence: Array<{ name: string; url: string }> = [];
        const files = await readdir(evidenceDir).catch(() => [] as string[]);
        for (const name of files) {
          const url = await this.storage.uploadFile(path.join(evidenceDir, name), `${prefix}/evidence/${name}`);
          evidence.push({ name, url });
        }
        job.result = { report, urls: { reportJson: reportJsonUrl, reportDocx: reportDocxUrl, evidence } };
      }

      job.status = "done";
    } catch (err) {
      job.status = "error";
      const dur =
        JOB_TIMEOUT_MS >= 60_000
          ? `${Math.round(JOB_TIMEOUT_MS / 60_000)} min`
          : `${Math.round(JOB_TIMEOUT_MS / 1000)}s`;
      job.error = controller.signal.aborted
        ? `Audit timed out after ${dur} and was aborted.`
        : (err as Error).message;
    } finally {
      clearTimeout(timer);
      job.finishedAt = new Date().toISOString();
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
