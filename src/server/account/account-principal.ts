/**
 * Session-to-principal projection (Phase 0E.7.4.2A) — SERVER ONLY.
 *
 * Turns a raw session token into the strict `AuthenticatedPrincipal` that a later
 * route adapter translates into the Phase 0E.7.4.1 caller context.
 *
 * The rule that matters: **`INTERNAL_OPERATOR` is reached only through an active
 * persisted entitlement**, and it is a classification rather than an
 * authorization — every internal surface still checks the specific capability it
 * requires. An ordinary authenticated account resolves to
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
  type AccountCapability,
  type AuthenticatedPrincipal as Principal,
} from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { listAccountCapabilities } from "./account-entitlement-service";
import { resolveAccountSession } from "./account-session-service";

type Db = ReturnType<typeof getPrisma>;

/**
 * The capabilities that promote an authenticated account to `INTERNAL_OPERATOR`.
 *
 * An explicit set, as this module's own note anticipated when there was one
 * member: Phase 0M.8 introduced the second (`activation:review`), and holding
 * **any** internal operational capability is what makes an account an internal
 * operator.
 *
 * `actorType` is a classification, never an authorization. Every internal
 * surface checks the *specific* capability it requires — the publication-worker
 * status route checks `publication-worker:status:read`, and the activation
 * review checks `activation:review` — so appearing in this set grants no access
 * to anything but the capability actually held.
 */
export const INTERNAL_OPERATOR_CAPABILITIES = [
  "publication-worker:status:read",
  "activation:review",
] as const satisfies readonly AccountCapability[];

/**
 * Retained under its original name for the 0E.7.4.2A callers that reference it.
 * Prefer `INTERNAL_OPERATOR_CAPABILITIES` for new code.
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
  const isInternalOperator = capabilities.some((c) =>
    (INTERNAL_OPERATOR_CAPABILITIES as readonly AccountCapability[]).includes(c),
  );

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
