/**
 * Entitlement governance (first-operator governance phase) — SERVER ONLY.
 *
 * The only production-capable way an `AccountEntitlement` row is written. Three
 * acts, each one transaction, each writing exactly one `AccountEntitlementAct`
 * alongside the current-state row it changes:
 *
 *   - `bootstrapFirstEntitlement` — the once-ever first grant of a
 *     bootstrappable capability (`entitlement:govern` only). No actor, because
 *     there is nobody yet who could be one; so it is as narrow as it can be made.
 *   - `grantEntitlementAsGovernor` / `revokeEntitlementAsGovernor` — an
 *     `entitlement:govern` holder changes one of the closed governed
 *     capabilities, and is named on the act.
 *
 * Four properties shape everything below:
 *
 *   1. **No ambient authority.** Nothing here reads the environment, a clock, an
 *      email address, or a configured account. The target and the actor are
 *      explicit account ids, and the actor's authority is re-resolved from
 *      persisted entitlements inside the transaction that acts on it.
 *
 *   2. **One winner, by construction.** The bootstrap act carries a unique
 *      once-ever marker, so two concurrent bootstraps cannot both commit — the
 *      loser's insert fails on the index, and it reports
 *      `FIRST_GRANT_ALREADY_CLAIMED`. Governed changes lock the Account rows
 *      they touch, in a fixed order, so two concurrent changes to one target
 *      serialize instead of both reading "not yet held".
 *
 *   3. **The act and the projection commit together or not at all.** Both are
 *      written in one interactive transaction; there is no path that writes one.
 *
 *   4. **Refusals are closed codes.** `EntitlementGovernanceRefusedError` names
 *      a classification only — never an id, an address, or a database message.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { AccountCapability } from "../../contracts/account/account";
import {
  AccountEntitlementActRecord,
  BootstrapFirstEntitlementInput,
  FIRST_GRANT_REQUIRED_VERIFICATION,
  GovernedEntitlementChangeInput,
  isEntitlementGovernedCapability,
  isFirstGrantBootstrapCapability,
  type AccountEntitlementActRecord as ActRecord,
  type EntitlementActAction,
  type EntitlementActBasis,
} from "../../contracts/account/entitlement-governance";
import {
  ENTITLEMENT_GOVERN_CAPABILITY,
  canGovernEntitlements,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import { getPrisma } from "../db/client";
import {
  cryptoEntitlementGovernanceIdProvider,
  type EntitlementGovernanceIdProvider,
} from "./account-ids";
import { resolveInternalAuthorizationSubject } from "./internal-authorization-service";
import {
  EntitlementGovernancePersistenceFailureError,
  EntitlementGovernanceRefusedError,
  InvalidEntitlementGovernanceInputError,
} from "./entitlement-governance-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Prisma.TransactionClient;

export interface EntitlementGovernanceDeps {
  db?: Db;
  ids?: EntitlementGovernanceIdProvider;
}

export interface BootstrapFirstEntitlementOutcome {
  /** `GRANTED` wrote the act and the entitlement; `ALREADY_BOOTSTRAPPED` wrote nothing. */
  outcome: "GRANTED" | "ALREADY_BOOTSTRAPPED";
  act: ActRecord;
}

export interface GovernedEntitlementOutcome {
  act: ActRecord;
}

/** What an operator sees before deciding to execute. Ids and classifications only. */
export interface EntitlementGovernanceInspection {
  capability: string;
  account: {
    exists: boolean;
    status: string | null;
    emailVerifiedVia: string | null;
    holdsCapability: boolean;
  };
  activeHolderCount: number;
  /** The account the once-ever first grant went to, or null if it has not happened. */
  firstGrantAccountId: string | null;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/**
 * Did this write lose the race for the once-ever marker — and not some other
 * unique key? Only that collision means "another bootstrap won"; any other is a
 * persistence failure and must not be reported as a governance answer.
 */
function isFirstGrantMarkerConflict(error: unknown): boolean {
  if (prismaCode(error) !== "P2002") return false;
  const meta = (error as { meta?: { target?: unknown } }).meta;
  return JSON.stringify(meta?.target ?? "").includes("firstGrantForCapability");
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidEntitlementGovernanceInputError {
  return new InvalidEntitlementGovernanceInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

function actRowToRecord(row: {
  id: string;
  accountId: string;
  capability: string;
  action: string;
  basis: string;
  actorAccountId: string | null;
  actedAt: Date;
}): ActRecord {
  return AccountEntitlementActRecord.parse({
    actId: row.id,
    accountId: row.accountId,
    capability: row.capability,
    action: row.action,
    basis: row.basis,
    actorAccountId: row.actorAccountId,
    actedAt: row.actedAt.toISOString(),
  });
}

/**
 * Lock Account rows `FOR UPDATE`, in id order, so two transactions that touch
 * the same pair never wait on each other in opposite orders.
 */
async function lockAccounts(tx: Tx, accountIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(accountIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM Account WHERE id = ${id} FOR UPDATE`;
  }
}

async function countActiveHolders(tx: Tx | Db, capability: string): Promise<number> {
  return tx.accountEntitlement.count({ where: { capability, status: "ACTIVE" } });
}

/** Write the current-state row and its act. Callers have already decided. */
async function writeChange(
  tx: Tx,
  ids: EntitlementGovernanceIdProvider,
  change: {
    accountId: string;
    capability: string;
    action: EntitlementActAction;
    basis: EntitlementActBasis;
    actorAccountId: string | null;
    actedAt: Date;
  },
): Promise<ActRecord> {
  const key = { accountId: change.accountId, capability: change.capability };
  const act = await tx.accountEntitlementAct.create({
    data: {
      id: ids.nextEntitlementActId(),
      accountId: change.accountId,
      capability: change.capability,
      action: change.action,
      basis: change.basis,
      actorAccountId: change.actorAccountId,
      firstGrantForCapability: change.basis === "BOOTSTRAP_FIRST_GRANT" ? change.capability : null,
      actedAt: change.actedAt,
    },
  });
  if (change.action === "GRANT") {
    await tx.accountEntitlement.upsert({
      where: { accountId_capability: key },
      create: {
        id: ids.nextEntitlementId(),
        ...key,
        status: "ACTIVE",
        grantedAt: change.actedAt,
      },
      update: { status: "ACTIVE", grantedAt: change.actedAt, revokedAt: null },
    });
  } else {
    await tx.accountEntitlement.update({
      where: { accountId_capability: key },
      data: { status: "REVOKED", revokedAt: change.actedAt },
    });
  }
  return actRowToRecord(act);
}

/**
 * The once-ever first grant of a bootstrappable capability.
 *
 * Refused unless, inside one transaction with the target Account locked:
 *   - the capability is on `FIRST_GRANT_BOOTSTRAP_CAPABILITIES`;
 *   - the target exists, is ACTIVE, and proved its own address
 *     (`emailVerifiedVia = SELF_SERVICE_TOKEN`);
 *   - no first grant of the capability has ever happened;
 *   - nobody actively holds the capability.
 *
 * **Idempotent for the same account.** A rerun after a successful bootstrap —
 * marker held by this account, entitlement still ACTIVE — returns
 * `ALREADY_BOOTSTRAPPED` and writes nothing. If the first grant went to another
 * account, or this account's grant has since been revoked, the answer is
 * `FIRST_GRANT_ALREADY_CLAIMED`: the bootstrap is once-ever, not "whenever no
 * holder remains".
 */
export async function bootstrapFirstEntitlement(
  input: unknown,
  deps: EntitlementGovernanceDeps = {},
): Promise<BootstrapFirstEntitlementOutcome> {
  const parsed = BootstrapFirstEntitlementInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { accountId, capability, actedAt } = parsed.data;
  /* Before any read: a capability off the allow-list learns nothing about who
     holds what. */
  if (!isFirstGrantBootstrapCapability(capability)) {
    throw new EntitlementGovernanceRefusedError("CAPABILITY_NOT_BOOTSTRAPPABLE");
  }

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoEntitlementGovernanceIdProvider;

  try {
    return await db.$transaction(async (tx) => {
      await lockAccounts(tx, [accountId]);
      const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { id: true, status: true, emailVerifiedAt: true, emailVerifiedVia: true },
      });
      if (account === null) throw new EntitlementGovernanceRefusedError("ACCOUNT_NOT_FOUND");

      const marker = await tx.accountEntitlementAct.findUnique({
        where: { firstGrantForCapability: capability },
      });
      if (marker !== null && marker.accountId !== accountId) {
        throw new EntitlementGovernanceRefusedError("FIRST_GRANT_ALREADY_CLAIMED");
      }

      if (account.status !== "ACTIVE") {
        throw new EntitlementGovernanceRefusedError("ACCOUNT_DISABLED");
      }
      if (
        account.emailVerifiedAt === null ||
        account.emailVerifiedVia !== FIRST_GRANT_REQUIRED_VERIFICATION
      ) {
        throw new EntitlementGovernanceRefusedError("EMAIL_NOT_SELF_VERIFIED");
      }

      if (marker !== null) {
        const held = await tx.accountEntitlement.findUnique({
          where: { accountId_capability: { accountId, capability } },
          select: { status: true },
        });
        if (held?.status === "ACTIVE") {
          return { outcome: "ALREADY_BOOTSTRAPPED" as const, act: actRowToRecord(marker) };
        }
        throw new EntitlementGovernanceRefusedError("FIRST_GRANT_ALREADY_CLAIMED");
      }

      if ((await countActiveHolders(tx, capability)) > 0) {
        throw new EntitlementGovernanceRefusedError("CAPABILITY_ALREADY_HELD");
      }

      const act = await writeChange(tx, ids, {
        accountId,
        capability,
        action: "GRANT",
        basis: "BOOTSTRAP_FIRST_GRANT",
        actorAccountId: null,
        actedAt: new Date(actedAt),
      });
      return { outcome: "GRANTED" as const, act };
    });
  } catch (error) {
    if (error instanceof EntitlementGovernanceRefusedError) throw error;
    /* The loser of a concurrent bootstrap: its marker insert hit the unique
       index the winner's committed act already occupies. */
    if (isFirstGrantMarkerConflict(error)) {
      throw new EntitlementGovernanceRefusedError("FIRST_GRANT_ALREADY_CLAIMED");
    }
    throw new EntitlementGovernancePersistenceFailureError("bootstrap-first-entitlement", error);
  }
}

function parseGoverned(input: unknown) {
  const parsed = GovernedEntitlementChangeInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  return parsed.data;
}

/**
 * Inside the transaction: refuse unless the actor actively holds
 * `entitlement:govern` and the target is an existing ACTIVE account.
 */
async function assertGovernedPreconditions(
  tx: Tx,
  actorAccountId: string,
  accountId: string,
): Promise<void> {
  await lockAccounts(tx, [actorAccountId, accountId]);
  const decision = canGovernEntitlements(
    await resolveInternalAuthorizationSubject(actorAccountId, { db: tx }),
  );
  if (!isInternallyAuthorized(decision)) {
    throw new EntitlementGovernanceRefusedError("ACTOR_NOT_AUTHORIZED", decision.reasonCodes);
  }
  const target = await tx.account.findUnique({
    where: { id: accountId },
    select: { status: true },
  });
  if (target === null) throw new EntitlementGovernanceRefusedError("ACCOUNT_NOT_FOUND");
  if (target.status !== "ACTIVE") throw new EntitlementGovernanceRefusedError("ACCOUNT_DISABLED");
}

/**
 * An `entitlement:govern` holder grants one governed capability.
 *
 * The capability must be on `ENTITLEMENT_GOVERNED_CAPABILITIES`; anything else
 * is refused before the database is read. Self-grant is permitted: a single
 * operator holding `entitlement:govern` may give itself the policy-governance
 * grants, and the act names it as both actor and target.
 *
 * **Not idempotent.** A grant of a capability already ACTIVE is refused as
 * `ENTITLEMENT_ALREADY_ACTIVE` and writes no act, so the history never records
 * a grant that changed nothing.
 */
export async function grantEntitlementAsGovernor(
  input: unknown,
  deps: EntitlementGovernanceDeps = {},
): Promise<GovernedEntitlementOutcome> {
  const { actorAccountId, accountId, capability, actedAt } = parseGoverned(input);
  if (!isEntitlementGovernedCapability(capability)) {
    throw new EntitlementGovernanceRefusedError("CAPABILITY_NOT_GOVERNABLE");
  }
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoEntitlementGovernanceIdProvider;

  try {
    return await db.$transaction(async (tx) => {
      await assertGovernedPreconditions(tx, actorAccountId, accountId);
      const existing = await tx.accountEntitlement.findUnique({
        where: { accountId_capability: { accountId, capability } },
        select: { status: true },
      });
      if (existing?.status === "ACTIVE") {
        throw new EntitlementGovernanceRefusedError("ENTITLEMENT_ALREADY_ACTIVE");
      }
      const act = await writeChange(tx, ids, {
        accountId,
        capability,
        action: "GRANT",
        basis: "GOVERNED",
        actorAccountId,
        actedAt: new Date(actedAt),
      });
      return { act };
    });
  } catch (error) {
    if (error instanceof EntitlementGovernanceRefusedError) throw error;
    throw new EntitlementGovernancePersistenceFailureError("grant-entitlement-as-governor", error);
  }
}

/**
 * An `entitlement:govern` holder revokes one governed capability.
 *
 * `entitlement:govern` itself is not on the governed surface, so no governed
 * act can remove it. Asking anyway is answered by the invariant the surface
 * protects: `LAST_ENTITLEMENT_GOVERNOR` when the target is the last active
 * holder — the state that, with no re-bootstrap and no emergency path, could
 * never be recovered from — and `CAPABILITY_NOT_GOVERNABLE` otherwise. The
 * check is evaluated against persisted holders so it stays true if the surface
 * ever widens.
 */
export async function revokeEntitlementAsGovernor(
  input: unknown,
  deps: EntitlementGovernanceDeps = {},
): Promise<GovernedEntitlementOutcome> {
  const { actorAccountId, accountId, capability, actedAt } = parseGoverned(input);
  const isMeta = capability === ENTITLEMENT_GOVERN_CAPABILITY;
  if (!isMeta && !isEntitlementGovernedCapability(capability)) {
    throw new EntitlementGovernanceRefusedError("CAPABILITY_NOT_GOVERNABLE");
  }
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoEntitlementGovernanceIdProvider;

  try {
    return await db.$transaction(async (tx) => {
      await assertGovernedPreconditions(tx, actorAccountId, accountId);
      const existing = await tx.accountEntitlement.findUnique({
        where: { accountId_capability: { accountId, capability } },
        select: { status: true },
      });
      if (existing?.status !== "ACTIVE") {
        throw new EntitlementGovernanceRefusedError("ENTITLEMENT_NOT_ACTIVE");
      }
      if (isMeta) {
        if ((await countActiveHolders(tx, ENTITLEMENT_GOVERN_CAPABILITY)) <= 1) {
          throw new EntitlementGovernanceRefusedError("LAST_ENTITLEMENT_GOVERNOR");
        }
        throw new EntitlementGovernanceRefusedError("CAPABILITY_NOT_GOVERNABLE");
      }
      const act = await writeChange(tx, ids, {
        accountId,
        capability,
        action: "REVOKE",
        basis: "GOVERNED",
        actorAccountId,
        actedAt: new Date(actedAt),
      });
      return { act };
    });
  } catch (error) {
    if (error instanceof EntitlementGovernanceRefusedError) throw error;
    throw new EntitlementGovernancePersistenceFailureError("revoke-entitlement-as-governor", error);
  }
}

/**
 * Read-only state for an operator preflight. Writes nothing, locks nothing, and
 * returns ids and classifications only — never an email or a name.
 */
export async function inspectEntitlementGovernance(
  input: { accountId: string; capability: string },
  deps: { db?: Db } = {},
): Promise<EntitlementGovernanceInspection> {
  const db = deps.db ?? getPrisma();
  const capability = AccountCapability.safeParse(input.capability).success
    ? input.capability
    : null;
  const account = await db.account.findUnique({
    where: { id: input.accountId },
    select: { status: true, emailVerifiedVia: true },
  });
  if (capability === null) {
    return {
      capability: input.capability,
      account: {
        exists: account !== null,
        status: account?.status ?? null,
        emailVerifiedVia: account?.emailVerifiedVia ?? null,
        holdsCapability: false,
      },
      activeHolderCount: 0,
      firstGrantAccountId: null,
    };
  }
  const [held, activeHolderCount, marker] = await Promise.all([
    db.accountEntitlement.findUnique({
      where: { accountId_capability: { accountId: input.accountId, capability } },
      select: { status: true },
    }),
    countActiveHolders(db, capability),
    db.accountEntitlementAct.findUnique({
      where: { firstGrantForCapability: capability },
      select: { accountId: true },
    }),
  ]);
  return {
    capability,
    account: {
      exists: account !== null,
      status: account?.status ?? null,
      emailVerifiedVia: account?.emailVerifiedVia ?? null,
      holdsCapability: held?.status === "ACTIVE",
    },
    activeHolderCount,
    firstGrantAccountId: marker?.accountId ?? null,
  };
}

/** One account's entitlement history, oldest first. Read-only. */
export async function listEntitlementActs(
  accountId: string,
  deps: { db?: Db } = {},
): Promise<ActRecord[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.accountEntitlementAct.findMany({
    where: { accountId },
    orderBy: [{ actedAt: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(actRowToRecord);
}
