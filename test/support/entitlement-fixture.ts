/**
 * Entitlement test fixture (first-operator governance phase) — TEST ONLY.
 *
 * The unrestricted entitlement writers that `account-entitlement-service.ts`
 * exported until this phase, moved here unchanged in behaviour. They have no
 * actor, no authority check, and write no `AccountEntitlementAct`, which is
 * exactly what a test needs to arrange "this account holds X" — and exactly what
 * no production-capable path may do. Production changes go through
 * `src/server/account/entitlement-governance-service.ts`.
 *
 * Two guards keep it a fixture:
 *
 *   - nothing under `src/` may import it, and the only script that may is the
 *     disposable-local `scripts/db-check.ts` — both asserted by
 *     `test/entitlement-governance.integration.test.ts`;
 *   - every write refuses unless `DATABASE_URL` names a loopback host, so even
 *     `db:check` pointed at a remote database writes nothing.
 */

import "../../src/server/server-only";
import {
  GrantAccountEntitlementInput,
  RevokeAccountEntitlementInput,
  AccountEntitlementRecord,
  type AccountEntitlementRecord as SafeEntitlement,
} from "../../src/contracts/account/account";
import { getPrisma } from "../../src/server/db/client";
import { cryptoAccountIdProvider, type AccountIdProvider } from "../../src/server/account/account-ids";
import {
  AccountNotFoundError,
  AccountPersistenceFailureError,
  InvalidAccountInputError,
  UnsupportedCapabilityError,
} from "../../src/server/account/account-errors";

type Db = ReturnType<typeof getPrisma>;

/** Refuse unless the configured database is on this machine. */
export function assertLoopbackDatabase(env: Record<string, string | undefined> = process.env): void {
  let host = "";
  try {
    host = new URL(env.DATABASE_URL ?? "").hostname;
  } catch {
    host = "";
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error("entitlement fixture refused: DATABASE_URL is not a loopback database");
  }
}

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
 * existing grant unchanged rather than conflicting or re-dating it — a fixture
 * that runs twice must not be a failure, and the original `grantedAt`
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
    // An unrecognised capability is refused specifically, so a typo in a fixture
    // fails loudly instead of granting nothing and reporting success.
    if (parsed.error.issues.some((i) => i.path[0] === "capability")) {
      throw new UnsupportedCapabilityError();
    }
    throw new InvalidAccountInputError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const req = parsed.data;
  assertLoopbackDatabase();

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
 * either way, and failing would tempt a fixture to skip the call.
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
  assertLoopbackDatabase();
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

