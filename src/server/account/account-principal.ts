/**
 * Session-to-principal projection (Phase 0E.7.4.2A) — SERVER ONLY.
 *
 * Turns a raw session token into the strict `AuthenticatedPrincipal` that a later
 * route adapter translates into the Phase 0E.7.4.1 caller context.
 *
 * The rule that matters: **`INTERNAL_OPERATOR` is reached only through an active
 * persisted entitlement.** An ordinary authenticated account resolves to
 * `ACCOUNT` — a valid principal that simply holds no internal capability. Keeping
 * the two apart is what stops "successfully logged in" from drifting into
 * "authorized to read operational data", which is the single most common way an
 * internal surface becomes a public one.
 *
 * Capabilities are read from the database on every resolution, never from a token
 * claim or a cache, so a revocation fails closed on the very next request.
 *
 * The projection is an allow-list: `actorId`, `actorType`, `accountId`,
 * `sessionId`, and `capabilities`. There is no field for an email, a name, a
 * password hash, a raw or hashed token, a cookie, a database row, or a claims bag
 * — so none can leak by accident.
 */

import "../server-only";
import {
  AuthenticatedPrincipal,
  type AuthenticatedPrincipal as Principal,
} from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { listAccountCapabilities } from "./account-entitlement-service";
import { resolveAccountSession } from "./account-session-service";

type Db = ReturnType<typeof getPrisma>;

/**
 * The capability that promotes an authenticated account to `INTERNAL_OPERATOR`.
 *
 * One capability, named once. When a second internal capability is introduced,
 * this becomes an explicit set rather than a growing list of implicit checks.
 */
export const INTERNAL_OPERATOR_CAPABILITY = "publication-worker:status:read" as const;

/**
 * Resolve a session token into a safe principal.
 *
 * Returns `undefined` for every "not signed in" condition — unknown, expired,
 * revoked, or an account since disabled — matching `resolveAccountSession`.
 * Distinguishing them would tell the holder of a stale token why it is stale.
 */
export async function resolveAuthenticatedPrincipal(
  token: string,
  options: { now: string; touch?: boolean; db?: Db },
): Promise<Principal | undefined> {
  const resolved = await resolveAccountSession(token, options);
  if (resolved === undefined) return undefined;

  const capabilities = await listAccountCapabilities(resolved.accountId, { ...(options.db !== undefined ? { db: options.db } : {}) });
  const isInternalOperator = capabilities.includes(INTERNAL_OPERATOR_CAPABILITY);

  return AuthenticatedPrincipal.parse({
    // The account id IS the actor id: one stable, opaque, durable identity that
    // authorization keys on. Never the display name, never the email.
    actorId: resolved.accountId,
    actorType: isInternalOperator ? "INTERNAL_OPERATOR" : "ACCOUNT",
    accountId: resolved.accountId,
    sessionId: resolved.session.sessionId,
    capabilities,
  });
}
