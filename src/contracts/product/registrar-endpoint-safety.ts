/**
 * Registrar endpoint validation (Phase 0E.6.1) — SSRF and egress safety.
 *
 * The endpoint is the one place where our process is told "go talk to this".
 * Getting it wrong turns a publication pipeline into a request forgery tool, so
 * the rules here are deliberately restrictive and refuse anything unusual rather
 * than trying to normalise it.
 *
 * Pure and dependency-free: no DNS resolution, no I/O, no configuration reading.
 *
 * **Production endpoint allow-listing is still required before deployment.**
 * This module proves an endpoint is *shaped* safely; it cannot know which hosts
 * are legitimate Registrars. That list belongs to deployment configuration and
 * is deliberately absent from this phase.
 */

/** Schemes we will speak. Nothing else — no file:, ftp:, data:, gopher:. */
export const ALLOWED_ENDPOINT_SCHEMES: readonly string[] = ["https:", "http:"];

/** Hostnames treated as loopback, where plain `http:` is permitted for tests. */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1", "[::1]"];

export interface EndpointIssue {
  rule: string;
  reason: string;
}

/** True when the host is loopback, and therefore never leaves this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.includes(h) || h === "[::1]" || h.startsWith("127.");
}

/**
 * Validate an endpoint URL, returning issues (empty when safe).
 *
 * Issues name the RULE that failed, never the offending URL — an endpoint may
 * contain a host or path a caller should not see echoed back into logs.
 */
export function findEndpointIssues(url: string): EndpointIssue[] {
  const issues: EndpointIssue[] = [];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ rule: "unparsable", reason: "the endpoint is not an absolute URL" }];
  }

  if (!ALLOWED_ENDPOINT_SCHEMES.includes(parsed.protocol)) {
    issues.push({ rule: "scheme", reason: "only https: (or loopback http:) endpoints are permitted" });
    // Nothing further is meaningful for an unsupported scheme.
    return issues;
  }

  const loopback = isLoopbackHost(parsed.hostname);

  // Plain HTTP would put the capsule and the Authorization header on the wire in
  // clear text. Permitted only where the wire never leaves the machine.
  if (parsed.protocol === "http:" && !loopback) {
    issues.push({
      rule: "insecure-scheme",
      reason: "http: is permitted only for loopback endpoints in tests",
    });
  }

  // Credentials in the URL would be logged by proxies and are never our auth
  // mechanism — authentication travels in headers.
  if (parsed.username !== "" || parsed.password !== "") {
    issues.push({ rule: "embedded-credentials", reason: "the endpoint must not embed credentials" });
  }

  // A fragment is never sent and its presence signals a copied browser URL.
  if (parsed.hash !== "") {
    issues.push({ rule: "fragment", reason: "the endpoint must not contain a fragment" });
  }

  if (parsed.hostname === "") {
    issues.push({ rule: "host", reason: "the endpoint must name a host" });
  }

  return issues;
}
