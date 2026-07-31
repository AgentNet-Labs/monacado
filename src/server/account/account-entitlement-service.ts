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
 */

import "../server-only";
import {
  AccountCapability,
  AccountEntitlementRecord,
  GrantAccountEntitlementInput,
  RevokeAccountEntitlementInput,
  type AccountCapability as Capability,
  type AccountEntitlementRecord as SafeEntitlement,
} from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { cryptoAccountIdProvider, type AccountIdProvider } from "./account-ids";
import {
  AccountNotFoundError,
  AccountPersistenceFailureError,
  InvalidAccountInputError,
  UnsupportedCapabilityError,
} from "./account-errors";

type Db = ReturnType<typeof getPrisma>;

export interface EntitlementServiceDeps {
  db?: Db;
  ids?: AccountIdProvider;
}

function entitlementRowToRecord(row: {
  id: string;
  accountId: string;
  capability: string;
  status: string;
  grantedAt: Date;
  revokedAt: Date | null;
}): SafeEntitlement {
  return AccountEntitlementRecord.parse({
    entitlementId: row.id,
    accountId: row.accountId,
    capability: row.capability,
    status: row.status,
    grantedAt: row.grantedAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
  });
}

/**
 * Grant a capability to an account.
 *
 * **Idempotent.** Granting a capability the account already holds returns the
 * existing grant unchanged rather than conflicting or re-dating it — a bootstrap
 * operation that runs twice must not be a failure, and the original `grantedAt`
 * is the fact worth keeping.
 *
 * Re-granting a previously revoked capability reactivates the same row and clears
 * `revokedAt`, because the unique index keeps one row per account+capability.
 */
export async function grantAccountEntitlement(
  input: unknown,
  deps: EntitlementServiceDeps = {},
): Promise<SafeEntitlement> {
  const parsed = GrantAccountEntitlementInput.safeParse(input);
  if (!parsed.success) {
    // An unrecognised capability is refused specifically, so a typo in a bootstrap
    // script fails loudly instead of granting nothing and reporting success.
    if (parsed.error.issues.some((i) => i.path[0] === "capability")) {
      throw new UnsupportedCapabilityError();
    }
    throw new InvalidAccountInputError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const req = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoAccountIdProvider;

  const account = await db.account.findUnique({ where: { id: req.accountId } });
  if (account === null) throw new AccountNotFoundError();

  try {
    const existing = await db.accountEntitlement.findUnique({
      where: { accountId_capability: { accountId: req.accountId, capability: req.capability } },
    });
    if (existing !== null && existing.status === "ACTIVE") {
      return entitlementRowToRecord(existing);
    }
    const row = await db.accountEntitlement.upsert({
      where: { accountId_capability: { accountId: req.accountId, capability: req.capability } },
      create: {
        id: ids.nextEntitlementId(),
        accountId: req.accountId,
        capability: req.capability,
        status: "ACTIVE",
        grantedAt: new Date(req.grantedAt),
      },
      update: { status: "ACTIVE", grantedAt: new Date(req.grantedAt), revokedAt: null },
    });
    return entitlementRowToRecord(row);
  } catch (error) {
    throw new AccountPersistenceFailureError("grant-entitlement", error);
  }
}

/**
 * Revoke a capability.
 *
 * Idempotent in the same spirit: revoking something not held is not an error,
 * because the caller's intent — "this account must not hold this" — is satisfied
 * either way, and failing would tempt a bootstrap script to skip the call.
 */
export async function revokeAccountEntitlement(
  input: unknown,
  deps: EntitlementServiceDeps = {},
): Promise<{ revoked: boolean }> {
  const parsed = RevokeAccountEntitlementInput.safeParse(input);
  if (!parsed.success) {
    if (parsed.error.issues.some((i) => i.path[0] === "capability")) {
      throw new UnsupportedCapabilityError();
    }
    throw new InvalidAccountInputError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const req = parsed.data;
  const db = deps.db ?? getPrisma();

  try {
    const result = await db.accountEntitlement.updateMany({
      where: { accountId: req.accountId, capability: req.capability, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date(req.revokedAt) },
    });
    return { revoked: result.count === 1 };
  } catch (error) {
    throw new AccountPersistenceFailureError("revoke-entitlement", error);
  }
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
  deps: EntitlementServiceDeps = {},
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
