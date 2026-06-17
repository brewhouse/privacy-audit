import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { AuditQueue, type JobOptions } from "./queue.js";
import { normalizeDomain } from "./audit.js";
import { LOGIN_PAGE_HTML, WEB_FORM_HTML } from "./web.js";

/**
 * HTTP API + staff UI for hosted audits (Render).
 *
 *   GET  /             staff UI — login page, or the audit form once signed in
 *   POST /login        admin username/password -> sets a signed session cookie
 *   GET  /logout       clears the session cookie
 *   POST /audit        enqueue an audit (session cookie OR bearer token)
 *   GET  /audit/:id    poll job status + result
 *   GET  /healthz      liveness
 *
 * Auth:
 *   - Staff sign in with ADMIN_USERNAME / ADMIN_PASSWORD; a stateless HMAC-signed
 *     session cookie (12 h) then authorizes the browser. No token to paste.
 *   - Programmatic clients may still send Authorization: Bearer $AUDIT_API_TOKEN
 *     (optional — only enabled if AUDIT_API_TOKEN is set).
 *
 * Scope guard (CLAUDE.md §8): if ALLOWED_DOMAINS is set, only those host suffixes may
 * be audited. Leave it empty to allow any URL (the login is then the only guard).
 */

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const API_TOKEN = process.env.AUDIT_API_TOKEN || "";
// Stable across restarts when derived from the password; falls back to random if unset.
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD || randomBytes(32).toString("hex");
const SESSION_COOKIE = "pa_session";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const MAX_PAGES_LIMIT = Number(process.env.MAX_PAGES_LIMIT) || 100;

// ---- session cookie (stateless, HMAC-signed) ----

function signSession(): string {
  const payload = String(Date.now());
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(value: string | null): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const ts = Number(payload);
  return Number.isFinite(ts) && Date.now() - ts <= SESSION_MAX_AGE_MS;
}

function getCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setSessionCookie(reply: FastifyReply) {
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${signSession()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}`,
  );
}

function clearSessionCookie(reply: FastifyReply) {
  reply.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return (req.headers["x-api-token"] as string) || "";
}

function isAuthorized(req: FastifyRequest): boolean {
  if (verifySession(getCookie(req, SESSION_COOKIE))) return true;
  if (API_TOKEN && safeEqual(bearerToken(req), API_TOKEN)) return true;
  return false;
}

function hostAllowed(domain: string): boolean {
  if (ALLOWED_DOMAINS.length === 0) return true;
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

interface LoginBody {
  username?: string;
  password?: string;
}

export function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
  const queue = new AuditQueue();
  const adminConfigured = Boolean(ADMIN_USERNAME && ADMIN_PASSWORD);

  // Gate the /audit routes (session cookie OR bearer token).
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/audit")) return;
    if (!isAuthorized(req)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Staff UI: login page, or the audit form once signed in.
  app.get("/", async (req, reply) => {
    const authed = verifySession(getCookie(req, SESSION_COOKIE));
    return reply.type("text/html").send(authed ? WEB_FORM_HTML : LOGIN_PAGE_HTML);
  });

  app.post<{ Body: LoginBody }>("/login", async (req, reply) => {
    if (!adminConfigured) {
      return reply.code(503).send({ error: "Admin login not configured (set ADMIN_USERNAME and ADMIN_PASSWORD)." });
    }
    const { username = "", password = "" } = req.body || {};
    if (safeEqual(username, ADMIN_USERNAME) && safeEqual(password, ADMIN_PASSWORD)) {
      setSessionCookie(reply);
      return reply.send({ ok: true });
    }
    return reply.code(401).send({ error: "Invalid username or password." });
  });

  app.get("/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return reply.redirect("/");
  });

  app.get("/healthz", async () => ({
    status: "ok",
    storage: queue.storageConfigured ? "configured" : "none",
    auth: adminConfigured ? "admin-login" : API_TOKEN ? "token-only" : "unconfigured",
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
