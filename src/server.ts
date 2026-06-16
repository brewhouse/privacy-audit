import Fastify from "fastify";
import { AuditQueue, type JobOptions } from "./queue.js";
import { normalizeDomain } from "./audit.js";

/**
 * HTTP API for hosted audits (Render).
 *
 *   POST /audit          enqueue an audit; returns { id, status } immediately
 *   GET  /audit/:id      poll job status + result (report + evidence URLs when done)
 *   GET  /healthz        liveness
 *
 * Security (CLAUDE.md §8 — only scan authorized sites):
 *   - Bearer token auth via AUDIT_API_TOKEN. All /audit routes require it.
 *   - Domain allowlist via ALLOWED_DOMAINS (comma-separated host suffixes). A request
 *     to audit a host not on the allowlist is rejected. Leave unset only on a fully
 *     trusted/internal deployment.
 */

const API_TOKEN = process.env.AUDIT_API_TOKEN || "";
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const MAX_PAGES_LIMIT = Number(process.env.MAX_PAGES_LIMIT) || 100;

function hostAllowed(domain: string): boolean {
  if (ALLOWED_DOMAINS.length === 0) return true; // no allowlist configured
  let host: string;
  try {
    host = new URL(normalizeDomain(domain)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_DOMAINS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

interface AuditBody {
  domain?: string;
  maxPages?: number;
  sampleByTemplate?: boolean;
  reject?: boolean;
  robots?: boolean;
  client?: string;
}

export function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
  const queue = new AuditQueue();

  // Token auth on /audit routes.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/audit")) return;
    if (!API_TOKEN) {
      return reply.code(503).send({ error: "Server missing AUDIT_API_TOKEN; refusing audit requests." });
    }
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-api-token"] as string) || "";
    if (token !== API_TOKEN) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/healthz", async () => ({
    status: "ok",
    storage: queue.storageConfigured ? "configured" : "none",
    allowlist: ALLOWED_DOMAINS.length ? ALLOWED_DOMAINS : "open",
  }));

  app.post<{ Body: AuditBody }>("/audit", async (req, reply) => {
    const body = req.body || {};
    if (!body.domain || typeof body.domain !== "string") {
      return reply.code(400).send({ error: "Missing 'domain'." });
    }
    if (!hostAllowed(body.domain)) {
      return reply.code(403).send({ error: "Domain not in allowlist. Only authorized sites may be audited." });
    }

    const options: JobOptions = {
      maxPages: Math.min(MAX_PAGES_LIMIT, Math.max(1, Number(body.maxPages) || 25)),
      sampleByTemplate: body.sampleByTemplate === true,
      doReject: body.reject !== false,
      respectRobots: body.robots !== false,
      client: body.client,
    };

    const job = queue.enqueue(normalizeDomain(body.domain), options);
    return reply.code(202).send({ id: job.id, status: job.status, poll: `/audit/${job.id}` });
  });

  app.get<{ Params: { id: string } }>("/audit/:id", async (req, reply) => {
    const job = queue.get(req.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return reply.send(queue.view(job));
  });

  return app;
}

// Start when run directly (dist/server.js as the container entrypoint).
const isMain = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const app = buildServer();
  const port = Number(process.env.PORT) || 3000;
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
