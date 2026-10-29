/**
 * Account entitlements (Phase 0E.7.4.2A) — SERVER ONLY.
 *
 * An entitlement is an **explicit persisted grant** of one capability from a
 * closed vocabulary to one account id. That is the whole model.
 *
 * What it deliberately is not:
 *
 *   - not a role — there are no role names, and no role-to-permission mapping;
 *   - not derived from an email address or its domain — a mailbox is not an
 *     authorization decision, and domain matching hands anyone who controls a
 *     lookalike address the same access;
 *   - not read from the environment — an allow-list in configuration is a grant
 *     nobody reviewed and nothing audits;
 *   - not hard-coded — there is no account id or address anywhere in this
 *     repository that receives access by being named.
 *
 * **Revocation fails closed immediately.** Authorization reads this row on every
 * request rather than trusting a claim cached in a token, so a revoked capability
 * is gone on the next call rather than at the end of some session lifetime.
 *
 * **Read-only (first-operator governance phase).** This module no longer writes.
 * The unrestricted `grantAccountEntitlement` / `revokeAccountEntitlement` it once
 * exported had no actor, no authority check, and no record, so they now live
 * only in the test fixture `test/support/entitlement-fixture.ts`. Every
 * production-capable change goes through `entitlement-governance-service.ts`,
 * which writes an `AccountEntitlementAct` in the same transaction.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  AccountCapability,
  type AccountCapability as Capability,
} from "../../contracts/account/account";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export interface EntitlementServiceDeps {
  db?: Db;
}

/**
 * Does this account currently hold this capability?
 *
 * Keyed on the persisted **account id**, never on an email, a domain, a header,
 * an environment value, or anything the caller supplied about themselves.
 * Returns `false` for an unknown account — absence is not an error here, it is
 * the answer.
 */
export async function accountHasCapability(
  accountId: string,
  capability: string,
  deps: EntitlementServiceDeps = {},
): Promise<boolean> {
  const parsedCapability = AccountCapability.safeParse(capability);
  if (!parsedCapability.success) return false;
  if (typeof accountId !== "string" || accountId === "") return false;

  const db = deps.db ?? getPrisma();
  const row = await db.accountEntitlement.findFirst({
    where: { accountId, capability: parsedCapability.data, status: "ACTIVE" },
    select: { id: true },
  });
  return row !== null;
}

/** Every capability this account currently holds, allow-listed and deduplicated. */
export async function listAccountCapabilities(
  accountId: string,
  deps: { db?: Db | Prisma.TransactionClient } = {},
): Promise<Capability[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.accountEntitlement.findMany({
    where: { accountId, status: "ACTIVE" },
    select: { capability: true },
    orderBy: { capability: "asc" },
  });
  const capabilities: Capability[] = [];
  for (const row of rows) {
    // Allow-listed on the way out: a value that is no longer part of the
    // vocabulary grants nothing, even if a row still carries it.
    const parsed = AccountCapability.safeParse(row.capability);
    if (parsed.success && !capabilities.includes(parsed.data)) capabilities.push(parsed.data);
  }
  return capabilities;
}
