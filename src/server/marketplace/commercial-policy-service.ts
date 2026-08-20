/**
 * Versioned commercial-policy service (Phase 0M.R1) — SERVER ONLY.
 *
 * The narrow application boundary over persisted policy. Six operations: create
 * a policy identity, record an immutable version, activate one (retiring the
 * incumbent in the same transaction), read an exact version, read the effective
 * version, and list a policy's history.
 *
 * Five properties shape everything below:
 *
 *   1. **The database is authoritative; the contract stays the shape.** Every
 *      read returns a persisted version, and `toWholesaleAcquisitionPolicy` maps
 *      it onto the committed `MonacadoWholesaleAcquisitionPolicy`. No arithmetic
 *      is implemented here — `0M.4A`'s calculators consume that value unchanged,
 *      and there is still exactly one implementation of the economics.
 *
 *   2. **No rate is compiled in.** No default, no fallback, no "if nothing is
 *      active use 7.5%". A policy with no active version raises
 *      `NoActiveCommercialPolicyError`, because a fallback rate is precisely the
 *      hard-coded economics `0M.4A` forbids and asserts against.
 *
 *   3. **History is immutable.** Recording a version writes a new row; the only
 *      columns ever updated afterwards are `status`, `retiredAt`,
 *      `retiredByAccountId`, and the active marker. `updateCommercialPolicyVersionEconomics`
 *      does not exist — the way to change a rate is to record a new version.
 *
 *   4. **"The effective policy" has exactly one answer**, enforced by the
 *      `activeForPolicyId` unique index rather than by a service remembering to
 *      retire the incumbent first. Two ACTIVE rows cannot exist, so the read
 *      cannot have to choose.
 *
 *   5. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected.
 *
 * No route, no UI, no seeding. Recording the standard policy is an explicit
 * caller act — see `MONACADO_STANDARD_POLICY_V1` and the phase documentation.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  ActivateCommercialPolicyVersionInput,
  CreateCommercialPolicyInput,
  INITIAL_COMMERCIAL_POLICY_VERSION_STATUS,
  RecordCommercialPolicyVersionInput,
  isValidCommercialPolicyVersionTransition,
  toWholesaleAcquisitionPolicy,
  type CommercialPolicyRecord,
  type CommercialPolicyVersionRecord,
  type CommercialPolicyVersionStatus,
} from "../../contracts/marketplace/commercial-policy";
import type { MonacadoWholesaleAcquisitionPolicy } from "../../contracts/marketplace/listing-source";
import { getPrisma } from "../db/client";
import {
  cryptoCommercialPolicyIdProvider,
  type CommercialPolicyIdProvider,
} from "./commercial-policy-ids";
import {
  AmbiguousActiveCommercialPolicyError,
  CommercialPolicyNotFoundError,
  CommercialPolicyPersistenceFailureError,
  CommercialPolicyVersionNotFoundError,
  CorruptCommercialPolicyRecordError,
  DuplicateCommercialPolicyVersionError,
  InvalidCommercialPolicyInputError,
  InvalidCommercialPolicyVersionTransitionError,
  NoActiveCommercialPolicyError,
} from "./commercial-policy-errors";
import {
  policyRowToRecord,
  policyVersionRowToRecord,
} from "./commercial-policy-mapper";

type Db = ReturnType<typeof getPrisma>;

export interface CommercialPolicyServiceDeps {
  db?: Db;
  ids?: CommercialPolicyIdProvider;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const isUniqueViolation = (error: unknown): boolean => prismaCode(error) === "P2002";
const isForeignKeyViolation = (error: unknown): boolean => prismaCode(error) === "P2003";

function isDomainError(error: unknown): boolean {
  return (
    error instanceof CommercialPolicyNotFoundError ||
    error instanceof CommercialPolicyVersionNotFoundError ||
    error instanceof NoActiveCommercialPolicyError ||
    error instanceof AmbiguousActiveCommercialPolicyError ||
    error instanceof InvalidCommercialPolicyVersionTransitionError ||
    error instanceof CorruptCommercialPolicyRecordError
  );
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidCommercialPolicyInputError {
  return new InvalidCommercialPolicyInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

/** Create one enduring policy identity. It has no versions and no economics yet. */
export async function createCommercialPolicy(
  input: unknown,
  deps: CommercialPolicyServiceDeps = {},
): Promise<CommercialPolicyRecord> {
  const parsed = CreateCommercialPolicyInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoCommercialPolicyIdProvider;

  try {
    const row = await db.commercialPolicy.create({
      data: { id: ids.nextPolicyId(), label: parsed.data.label },
    });
    return policyRowToRecord(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new CommercialPolicyPersistenceFailureError("createCommercialPolicy", error);
  }
}

/**
 * Record one immutable version.
 *
 * Created `DRAFT` and at no other status — the input has no `status` parameter,
 * so a caller cannot mint an already-effective rate without the explicit
 * activation that supersedes whatever came before.
 *
 * The `(policyId, policyVersion)` unique index refuses a duplicate label, so a
 * version can never come to name two different sets of numbers.
 */
export async function recordCommercialPolicyVersion(
  input: unknown,
  deps: CommercialPolicyServiceDeps = {},
): Promise<CommercialPolicyVersionRecord> {
  const parsed = RecordCommercialPolicyVersionInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const v = parsed.data;

  const db = deps.db ?? getPrisma();

  try {
    await db.commercialPolicyVersionRow.create({
      data: {
        policyId: v.policyId,
        policyVersion: v.policyVersion,
        status: INITIAL_COMMERCIAL_POLICY_VERSION_STATUS,
        currency: v.currency,
        retainedPercentageBasisPoints: v.retainedPercentageBasisPoints,
        retainedFixedAmountMinorUnits: BigInt(v.retainedFixedAmountMinorUnits),
        roundingPolicy: v.roundingPolicy,
        effectiveFrom: new Date(v.effectiveFrom),
        recordedByAccountId: v.recordedByAccountId,
        recordedAt: new Date(v.recordedAt),
        // A DRAFT version is never the active one.
        activeForPolicyId: null,
      },
    });
    return await readVersionIn(db, v.policyId, v.policyVersion);
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) throw new DuplicateCommercialPolicyVersionError(error);
    if (isForeignKeyViolation(error)) throw new CommercialPolicyNotFoundError();
    throw new CommercialPolicyPersistenceFailureError("recordCommercialPolicyVersion", error);
  }
}

/**
 * Activate a drafted version, retiring the incumbent in the same transaction.
 *
 * One operation rather than two, because the intermediate state — two ACTIVE
 * versions of one policy — is exactly the ambiguity the effective lookup must
 * never encounter. The `activeForPolicyId` unique index makes it impossible
 * rather than merely unlikely: the retire and the activate commit together or
 * neither does.
 *
 * The incumbent's economics are untouched. Only its status, retirement instant,
 * retiring actor, and active marker change — so every transaction that ran under
 * it still reproduces exactly.
 */
export async function activateCommercialPolicyVersion(
  input: unknown,
  deps: CommercialPolicyServiceDeps = {},
): Promise<CommercialPolicyVersionRecord> {
  const parsed = ActivateCommercialPolicyVersionInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { policyId, policyVersion, activatedByAccountId, activatedAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  const at = new Date(activatedAt);

  try {
    return await db.$transaction(async (tx) => {
      const target = await tx.commercialPolicyVersionRow.findUnique({
        where: { policyId_policyVersion: { policyId, policyVersion } },
      });
      if (target === null) throw new CommercialPolicyVersionNotFoundError();

      const from = target.status as CommercialPolicyVersionStatus;
      if (!isValidCommercialPolicyVersionTransition(from, "ACTIVE")) {
        throw new InvalidCommercialPolicyVersionTransitionError(from, "ACTIVE");
      }

      // Retire the incumbent first, so the unique marker is free. Its economics
      // are not touched — only its standing.
      const incumbent = await tx.commercialPolicyVersionRow.findUnique({
        where: { activeForPolicyId: policyId },
      });
      if (incumbent !== null) {
        await tx.commercialPolicyVersionRow.update({
          where: { seq: incumbent.seq },
          data: {
            status: "RETIRED",
            retiredAt: at,
            retiredByAccountId: activatedByAccountId,
            activeForPolicyId: null,
          },
        });
      }

      await tx.commercialPolicyVersionRow.update({
        where: { seq: target.seq },
        data: { status: "ACTIVE", activeForPolicyId: policyId },
      });

      return await readVersionIn(tx, policyId, policyVersion);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) throw new AmbiguousActiveCommercialPolicyError(error);
    throw new CommercialPolicyPersistenceFailureError("activateCommercialPolicyVersion", error);
  }
}

/**
 * Read one exact version.
 *
 * **The lookup a historical transaction uses.** It takes a `(policyId,
 * policyVersion)` pair and returns those numbers regardless of what is active
 * now — which is the whole reason versions are immutable. A retired version
 * resolves normally.
 */
export async function getCommercialPolicyVersion(
  policyId: string,
  policyVersion: string,
  deps: CommercialPolicyServiceDeps = {},
): Promise<CommercialPolicyVersionRecord> {
  const db = deps.db ?? getPrisma();
  try {
    return await readVersionIn(db, policyId, policyVersion);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new CommercialPolicyPersistenceFailureError("getCommercialPolicyVersion", error);
  }
}

/**
 * Read the currently effective version.
 *
 * **The lookup a new transaction uses**, and deliberately a different function
 * from the one above so a caller cannot reach for "current" where "exact" was
 * meant. Refuses when no version is active; there is no fallback rate.
 */
export async function getEffectiveCommercialPolicyVersion(
  policyId: string,
  deps: CommercialPolicyServiceDeps = {},
): Promise<CommercialPolicyVersionRecord> {
  const db = deps.db ?? getPrisma();
  try {
    const policy = await db.commercialPolicy.findUnique({ where: { id: policyId } });
    if (policy === null) throw new CommercialPolicyNotFoundError();

    const rows = await db.commercialPolicyVersionRow.findMany({
      where: { policyId, status: "ACTIVE" },
    });
    if (rows.length === 0) throw new NoActiveCommercialPolicyError();
    // Unreachable while the unique marker holds; refused rather than resolved,
    // because choosing between two would invent the rule the index prevents.
    if (rows.length > 1) throw new AmbiguousActiveCommercialPolicyError();

    return policyVersionRowToRecord(rows[0]!);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new CommercialPolicyPersistenceFailureError(
      "getEffectiveCommercialPolicyVersion",
      error,
    );
  }
}

/**
 * The effective version as the committed economics contract.
 *
 * The convenience the calculators actually want, and the only place storage and
 * economics meet. Callers that need a *historical* policy use
 * `getCommercialPolicyVersion` and map it themselves — a function named "the
 * current policy" must never be the one a historical reconstruction reaches for.
 */
export async function getEffectiveWholesaleAcquisitionPolicy(
  policyId: string,
  deps: CommercialPolicyServiceDeps = {},
): Promise<MonacadoWholesaleAcquisitionPolicy> {
  return toWholesaleAcquisitionPolicy(
    await getEffectiveCommercialPolicyVersion(policyId, deps),
  );
}

/** Every version of one policy, newest effective instant first. Append-only history. */
export async function listCommercialPolicyVersions(
  policyId: string,
  deps: CommercialPolicyServiceDeps = {},
): Promise<CommercialPolicyVersionRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.commercialPolicyVersionRow.findMany({
      where: { policyId },
      orderBy: [{ effectiveFrom: "desc" }, { seq: "desc" }],
    });
    return rows.map(policyVersionRowToRecord);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new CommercialPolicyPersistenceFailureError("listCommercialPolicyVersions", error);
  }
}

async function readVersionIn(
  tx: Db | Prisma.TransactionClient,
  policyId: string,
  policyVersion: string,
): Promise<CommercialPolicyVersionRecord> {
  const row = await tx.commercialPolicyVersionRow.findUnique({
    where: { policyId_policyVersion: { policyId, policyVersion } },
  });
  if (row === null) throw new CommercialPolicyVersionNotFoundError();
  return policyVersionRowToRecord(row);
}
