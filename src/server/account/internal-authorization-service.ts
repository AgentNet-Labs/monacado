/**
 * Internal authorization resolution (Phase 0M.8) — SERVER ONLY.
 *
 * The one place an `InternalAuthorizationSubject` is built, and it is built from
 * **persisted state only**: the account row for identity status, and
 * `listAccountCapabilities` for active entitlements.
 *
 * Three properties shape it:
 *
 *   1. **Read on every evaluation.** Capabilities come from `AccountEntitlement`
 *      each time, never from a token claim and never from a cache, so a
 *      revocation fails closed on the very next call. This is the same rule
 *      `resolveAuthenticatedPrincipal` follows, and for the same reason.
 *
 *   2. **An unknown account resolves to `null`, not to an empty subject.** The
 *      pure decision denies `INTERNAL_ACCOUNT_REQUIRED` on `null`, which is a
 *      different answer from "known account holding nothing" — and collapsing
 *      them would report a deleted reviewer as merely unentitled.
 *
 *   3. **Nothing marketplace-shaped is read.** No participant, role, storefront,
 *      or ownership query happens here, because the subject has no field one
 *      could be written into.
 */

import "../server-only";
import {
  InternalAuthorizationSubject,
  type InternalAuthorizationSubject as Subject,
} from "../../contracts/account/internal-authorization";
import { getPrisma } from "../db/client";
import { listAccountCapabilities } from "./account-entitlement-service";

type Db = ReturnType<typeof getPrisma>;

export interface InternalAuthorizationDeps {
  db?: Db;
}

/**
 * Resolve one account's internal authorization subject from the database.
 *
 * Returns `null` when no such account exists. Never throws for an unknown
 * account: "who is asking does not exist" is a condition the caller's decision
 * already has a reason code for.
 */
export async function resolveInternalAuthorizationSubject(
  accountId: string,
  deps: InternalAuthorizationDeps = {},
): Promise<Subject | null> {
  const db = deps.db ?? getPrisma();

  const account = await db.account.findUnique({
    where: { id: accountId },
    // An allow-list projection: the email, display name, and password hash are
    // not selected, so they cannot reach an authorization decision even by
    // accident.
    select: { id: true, status: true },
  });
  if (account === null) return null;

  const capabilities = await listAccountCapabilities(accountId, {
    ...(deps.db !== undefined ? { db: deps.db } : {}),
  });

  return InternalAuthorizationSubject.parse({
    accountId: account.id,
    accountStatus: account.status,
    capabilities,
  });
}
