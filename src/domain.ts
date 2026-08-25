/**
 * Host → registrable-domain helpers.
 *
 * Two shapes of host break a naive `split(".").slice(-2)`, and both showed up in real
 * audits:
 *
 *  - **Bare IP addresses.** `44.238.122.172` became "122.172", which is not a domain at
 *    all — it shipped to a client as an unidentifiable inventory row ("122.172 —
 *    Unclassified") and could not be looked up or remediated. IPs have no registrable
 *    domain; they are their own identity.
 *  - **Multi-label public suffixes.** `www.example.co.uk` became "co.uk", collapsing every
 *    unrelated `.co.uk` third party into one bogus row.
 *
 * We deliberately do not bundle the full Public Suffix List (a large, frequently-changing
 * dataset). MULTI_LABEL_SUFFIXES covers the suffixes actually seen in audits; anything
 * unlisted falls back to the eTLD+1 approximation, which is correct for single-label TLDs
 * (.com, .net, .org, .io …) — the overwhelming majority of tracker hosts.
 */

/** IPv4 dotted-quad, e.g. 44.238.122.172 */
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/** Two-label public suffixes we've encountered (host.<sld>.<cc>). */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za",
  "com.br", "com.mx", "com.ar", "com.co", "com.pe", "com.tr", "com.sg", "com.hk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "go.kr",
  "co.in", "net.in", "org.in", "gov.in", "ac.in",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "co.il", "org.il", "gov.il", "ac.il",
  "com.pl", "net.pl", "org.pl", "gov.pl",
  "co.id", "or.id", "go.id",
  "com.ua", "gov.ua",
  "com.vn", "com.my", "com.ph", "com.tw", "com.sa", "com.eg", "com.ng",
  "co.th", "in.th", "go.th",
  "gov.ca", "gc.ca", "qc.ca", "on.ca", "bc.ca", "ab.ca",
  "co.us", "ca.us", "ny.us", "oh.us", "gov.us",
]);

/** True when the host is a bare IP literal rather than a domain name. */
export function isIpHost(host: string): boolean {
  if (!host) return false;
  // IPv6 arrives from URL.hostname bracketed, e.g. "[2606:4700::1111]".
  if (host.startsWith("[") && host.endsWith("]")) return true;
  return IPV4.test(host);
}

/**
 * Best-effort registrable domain (eTLD+1).
 *
 * IPs, `localhost`, and single-label hosts are returned unchanged — they *are* the
 * identity, and truncating them produces a meaningless label.
 */
export function registrableDomain(host: string): string {
  const h = (host || "").toLowerCase().replace(/\.$/, "");
  if (!h) return h;
  if (isIpHost(h)) return h;
  const parts = h.split(".");
  if (parts.length <= 2) return h; // "example.com", "localhost", "intranet"
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

/** Same-site comparison by registrable domain. IPs match only themselves. */
export function sameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}
