/**
 * The verification link (Phase 1.4) — SERVER ONLY.
 *
 * Where a verification email points, and the one place that URL is built.
 *
 * ## The origin is configuration, exactly as `1.0` settled it
 *
 * `MONACADO_APP_ORIGIN` — the same variable `checkout-runtime-config.ts` reads,
 * and validated by the same `normalizeOrigin`, imported rather than restated. A
 * second origin variable would be a second answer to "where does this deployment
 * answer", and the copy is always the one that goes stale after a domain move.
 *
 * It is never derived from a request. A `Host` header is attacker-controlled, and
 * an origin taken from one turns every verification email into a link to whatever
 * host asked for it — which is a working credential-harvesting page sent from
 * Monacado's own domain.
 *
 * ## What is in the URL, and what is deliberately not
 *
 * The token, and nothing else. **No participant id, no contact id, no challenge
 * id, and no address.** The token is already a 256-bit single-use credential — it
 * is sufficient on its own, and every additional identifier is one more internal
 * fact deposited in browser history, `Referer` headers, and any proxy log between
 * the recipient and Monacado.
 *
 * The token travels in the query string, which is where a link-borne credential
 * has to live, and is why the challenge is consumed on first use and expires in
 * 24 hours rather than being a durable secret.
 */

import "../server-only";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { PolicyError } from "./policy-errors";

export type Env = Record<string, string | undefined>;

/** The Monacado page that consumes a challenge. Absolute path, no id in it. */
export const VERIFY_EMAIL_PATH = "/verify-email";

/** The query parameter carrying the opaque token. */
export const VERIFICATION_TOKEN_PARAM = "token";

/**
 * The origin this deployment's verification links point at.
 *
 * Throws rather than defaulting. A default here would be a link to `localhost`
 * arriving in somebody's inbox, or — worse — a link to a host this deployment
 * does not control.
 */
export function readVerificationLinkOrigin(env: Env = process.env): string {
  const raw = (env.MONACADO_APP_ORIGIN ?? "").trim();
  if (normalizeOrigin(raw) === undefined) {
    throw new PolicyError(
      "PUBLIC_ORIGIN_NOT_CONFIGURED",
      "MONACADO_APP_ORIGIN is not a usable origin, so no verification link can be built",
    );
  }
  /* The RAW value, not the normalised one: normalisation fills in the implicit
     port so two origins can be COMPARED, and `https://monacado.test:443/…` in an
     email is a link that looks wrong to the person asked to trust it. */
  return raw.replace(/\/+$/, "");
}

/**
 * The link one challenge is proved by.
 *
 * `URL` does the escaping, so a token is encoded rather than concatenated — the
 * token alphabet is base64url and needs none today, and relying on that would be
 * relying on a constant somewhere else not changing.
 */
export function buildVerificationUrl(origin: string, token: string): string {
  const url = new URL(VERIFY_EMAIL_PATH, `${origin}/`);
  url.searchParams.set(VERIFICATION_TOKEN_PARAM, token);
  return url.toString();
}
