/**
 * Session cookie primitives (Phase 0E.7.4.2A) — SERVER ONLY.
 *
 * Pure string helpers: they build and read a `Set-Cookie` / `Cookie` header value
 * and nothing more. There is no framework import, no `next/headers`, no request
 * or response object, and **no `process.env`** — `secure` is a required argument
 * so the decision belongs to the caller at the edge rather than to an ambient
 * environment read buried in a helper.
 *
 * The cookie carries **only the opaque token**. No account id, email, name,
 * status, role, capability, or expiry is encoded into it: everything about the
 * session is resolved server-side from the token's digest, so a cookie cannot
 * assert anything a client could tamper with.
 *
 * No UI, no login page, and no route uses these yet — they exist so the deferred
 * route adapter has a single, reviewed place to set and clear a session.
 */

import "../server-only";

/** Fixed name. `__Host-` is deliberately avoided; see `Path`/`Domain` below. */
export const SESSION_COOKIE_NAME = "monacado_session";

export interface SessionCookieOptions {
  /**
   * Required, never inferred. `true` in any real deployment; a caller may pass
   * `false` only for plain-http loopback development, which makes that an
   * explicit, greppable decision rather than an accident of configuration.
   */
  secure: boolean;
  /** Seconds. Should match the session's own TTL so the two expire together. */
  maxAgeSeconds: number;
}

/**
 * Build a `Set-Cookie` value carrying the session token.
 *
 * - `HttpOnly` — script cannot read it, so an XSS bug cannot exfiltrate it.
 * - `SameSite=Strict` — stricter than the Lax floor. This cookie authorizes
 *   internal operational reads; there is no cross-site flow that legitimately
 *   needs it, so nothing is lost by refusing to send it on cross-site requests,
 *   and CSRF surface is removed rather than mitigated.
 * - `Path=/` — one session for the origin.
 * - **no `Domain`** — host-only by omission, so the cookie is never shared with a
 *   sibling subdomain that might be less trusted.
 */
export function buildSessionCookie(token: string, options: SessionCookieOptions): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Build a `Set-Cookie` value that clears the session.
 *
 * Every attribute matches the cookie it clears, because a browser only replaces a
 * cookie when name, path, and domain agree — a mismatched clear silently leaves
 * the original in place.
 */
export function buildClearedSessionCookie(options: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Read the session token out of a `Cookie` header value.
 *
 * Returns `undefined` when absent or empty. Deliberately does not validate the
 * token's shape: whether a token is real is decided by resolving it against the
 * store, and a shape check here would only add a second place to disagree.
 */
export function readSessionCookie(cookieHeader: string | undefined | null): string | undefined {
  if (typeof cookieHeader !== "string" || cookieHeader === "") return undefined;
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator === -1) continue;
    if (segment.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = segment.slice(separator + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}
