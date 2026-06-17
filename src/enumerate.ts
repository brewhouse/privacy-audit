import { XMLParser } from "fast-xml-parser";
import type { Browser } from "playwright";

/**
 * URL enumeration (CLAUDE.md §4.1).
 *
 * Strategy:
 *   1. Pull /sitemap_index.xml and /sitemap.xml (WordPress/Yoast/RankMath expose these),
 *      following nested sitemap indexes.
 *   2. Fall back to recursive same-origin link discovery if no sitemap is found.
 *   3. Respect robots.txt. Dedupe. Honor --max-pages and --sample-by-template.
 */

export interface EnumerateOptions {
  maxPages: number;
  sampleByTemplate: boolean;
  respectRobots: boolean;
  /** Verbose logger. */
  log: (msg: string) => void;
}

const xml = new XMLParser({ ignoreAttributes: false });

/** Normalize for dedup: drop hash, trailing slash (except root), and default ports. */
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "PlaneteriaPrivacyAudit/0.1 (+authorized audit)" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000), // never let a stalled sitemap fetch hang the run
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Minimal robots.txt parser — collects Disallow rules for our UA and `*`. */
async function loadRobots(origin: string): Promise<{ disallow: string[]; sitemaps: string[] }> {
  const txt = await fetchText(`${origin}/robots.txt`);
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  if (!txt) return { disallow, sitemaps };

  let applies = false;
  for (const line of txt.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, "").trim();
    if (!clean) continue;
    const [rawKey, ...rest] = clean.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase().includes("planeteria");
    } else if (key === "disallow" && applies && value) {
      disallow.push(value);
    } else if (key === "sitemap" && value) {
      sitemaps.push(value);
    }
  }
  return { disallow, sitemaps };
}

function isDisallowed(url: string, disallow: string[]): boolean {
  if (disallow.length === 0) return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return disallow.some((rule) => rule !== "/" && path.startsWith(rule));
}

/** Recursively expand a sitemap or sitemap index into a flat URL list. */
async function parseSitemap(url: string, seen: Set<string>, log: (m: string) => void): Promise<string[]> {
  if (seen.has(url)) return [];
  seen.add(url);
  const body = await fetchText(url);
  if (!body) return [];

  let doc: any;
  try {
    doc = xml.parse(body);
  } catch {
    return [];
  }

  const out: string[] = [];

  // Sitemap index → recurse into child sitemaps
  if (doc.sitemapindex?.sitemap) {
    const entries = Array.isArray(doc.sitemapindex.sitemap)
      ? doc.sitemapindex.sitemap
      : [doc.sitemapindex.sitemap];
    log(`  sitemap index: ${entries.length} child sitemaps`);
    for (const e of entries) {
      if (e.loc) out.push(...(await parseSitemap(String(e.loc), seen, log)));
    }
    return out;
  }

  // URL set → leaf URLs
  if (doc.urlset?.url) {
    const entries = Array.isArray(doc.urlset.url) ? doc.urlset.url : [doc.urlset.url];
    for (const e of entries) {
      if (e.loc) out.push(String(e.loc));
    }
    log(`  sitemap: ${out.length} URLs from ${url}`);
  }
  return out;
}

/** Collapse URLs to one representative per template (path shape with numeric/slug segments masked). */
function sampleByTemplate(urls: string[]): string[] {
  const templateOf = (u: string): string => {
    try {
      const path = new URL(u).pathname;
      return path
        .split("/")
        .map((seg) => (/^\d+$/.test(seg) || seg.length > 24 ? ":var" : seg))
        .join("/");
    } catch {
      return u;
    }
  };
  const byTemplate = new Map<string, string>();
  for (const u of urls) {
    const t = templateOf(u);
    if (!byTemplate.has(t)) byTemplate.set(t, u);
  }
  return [...byTemplate.values()];
}

/** Same-origin BFS link discovery using a real browser (fallback when no sitemap). */
async function discoverByCrawl(
  browser: Browser,
  startUrl: string,
  origin: string,
  disallow: string[],
  respectRobots: boolean,
  limit: number,
  log: (m: string) => void,
): Promise<string[]> {
  log("no sitemap found — falling back to same-origin link discovery");
  const queue = [startUrl];
  const visited = new Set<string>();
  const found: string[] = [];
  const ctx = await browser.newContext();

  while (queue.length && found.length < limit) {
    const current = queue.shift()!;
    const norm = normalizeUrl(current);
    if (!norm || visited.has(norm)) continue;
    visited.add(norm);
    if (respectRobots && isDisallowed(norm, disallow)) continue;

    const page = await ctx.newPage();
    try {
      await page.goto(norm, { waitUntil: "domcontentloaded", timeout: 20000 });
      found.push(norm);
      const hrefs: string[] = await page.$$eval("a[href]", (els) =>
        els.map((a) => (a as HTMLAnchorElement).href),
      );
      for (const href of hrefs) {
        const n = normalizeUrl(href);
        if (n && n.startsWith(origin) && !visited.has(n)) queue.push(n);
      }
    } catch (err) {
      log(`  crawl error at ${norm}: ${(err as Error).message}`);
    } finally {
      await page.close();
    }
  }
  await ctx.close();
  return found;
}

export async function enumerateUrls(
  browser: Browser,
  domain: string,
  opts: EnumerateOptions,
): Promise<string[]> {
  const startUrl = normalizeUrl(domain);
  if (!startUrl) throw new Error(`Invalid domain: ${domain}`);
  const origin = new URL(startUrl).origin;

  const robots = opts.respectRobots
    ? await loadRobots(origin)
    : { disallow: [], sitemaps: [] };
  if (robots.disallow.length) {
    opts.log(`robots.txt: ${robots.disallow.length} Disallow rules in effect`);
  }

  // 1. Sitemaps — explicit robots entries first, then conventional locations.
  const seen = new Set<string>();
  const candidates = [
    ...robots.sitemaps,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap.xml`,
  ];
  let urls: string[] = [];
  for (const sm of candidates) {
    urls.push(...(await parseSitemap(sm, seen, opts.log)));
  }

  // 2. Fallback to link discovery.
  if (urls.length === 0) {
    urls = await discoverByCrawl(
      browser,
      startUrl,
      origin,
      robots.disallow,
      opts.respectRobots,
      opts.maxPages,
      opts.log,
    );
  }

  // 3. Normalize, filter to same origin, drop disallowed, dedupe.
  const deduped = new Set<string>();
  for (const u of urls) {
    const n = normalizeUrl(u);
    if (!n || !n.startsWith(origin)) continue;
    if (opts.respectRobots && isDisallowed(n, robots.disallow)) continue;
    deduped.add(n);
  }
  let result = [...deduped];

  // Always include the homepage.
  if (!result.includes(startUrl)) result.unshift(startUrl);

  // 4. Sampling + cap.
  if (opts.sampleByTemplate) {
    const before = result.length;
    result = sampleByTemplate(result);
    opts.log(`sample-by-template: ${before} → ${result.length} representative URLs`);
  }
  if (result.length > opts.maxPages) {
    opts.log(`capping ${result.length} → ${opts.maxPages} pages (--max-pages)`);
    result = result.slice(0, opts.maxPages);
  }

  return result;
}
