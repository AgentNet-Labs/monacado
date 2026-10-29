/**
 * Governed CommercialPolicy bootstrap (first-operator governance phase) — SERVER ONLY.
 *
 * Puts `MONACADO_STANDARD_POLICY_V1` into force as a persisted, activated
 * commercial policy and returns its id — the value `MONACADO_CHECKOUT_POLICY_ID`
 * names. Before this there was no operator path that did so: the governed
 * services existed, but composing them was left to whoever held the grant.
 *
 * Five properties shape it:
 *
 *   1. **Governed.** The actor must actively hold `commercial-policy:govern`,
 *      checked before any policy row is read, and the version it records and
 *      activates names that actor — through the existing governed services,
 *      which re-check the same grant.
 *
 *   2. **Idempotent against an equivalent policy.** If exactly one ACTIVE
 *      version anywhere already carries the standard economics, its policy id is
 *      returned and nothing is written.
 *
 *   3. **Never overrides.** Any ACTIVE version with different economics is a
 *      conflict, refused; so are two equivalent ones, because "which is the
 *      standard policy" would then have two answers.
 *
 *   4. **One policy under concurrency.** The policy it creates carries
 *      `bootstrapKey = 'STANDARD_V1'`, which is unique. A concurrent run that
 *      loses the insert adopts the winner's policy instead of minting another.
 *
 *   5. **Resumable.** The governed services each run their own transaction, so
 *      create → record → activate are three steps. A run interrupted between
 *      them leaves a keyed policy with no version or a DRAFT one; the next run
 *      finds it by key and finishes the job rather than starting a second.
 *
 * No rate is compiled in here: every economic value is read from
 * `MONACADO_STANDARD_POLICY_V1`, by reference.
 */

import "../server-only";
import {
  MONACADO_STANDARD_POLICY_V1,
  type CommercialPolicyVersionRecord,
} from "../../contracts/marketplace/commercial-policy";
import {
  canGovernCommercialPolicy,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import { getPrisma } from "../db/client";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import {
  cryptoCommercialPolicyIdProvider,
  type CommercialPolicyIdProvider,
} from "./commercial-policy-ids";
import {
  activateCommercialPolicyVersion,
  getCommercialPolicyVersion,
  recordCommercialPolicyVersion,
} from "./commercial-policy-service";
import {
  DuplicateCommercialPolicyVersionError,
  InvalidCommercialPolicyVersionTransitionError,
} from "./commercial-policy-errors";

type Db = ReturnType<typeof getPrisma>;

/** The single bootstrap key this module writes. Mirrored by a CHECK in the migration. */
export const STANDARD_COMMERCIAL_POLICY_BOOTSTRAP_KEY = "STANDARD_V1" as const;

/** Operational label only — never an input to economics. */
export const STANDARD_COMMERCIAL_POLICY_LABEL = "Monacado standard commercial policy" as const;

export const COMMERCIAL_POLICY_BOOTSTRAP_REFUSALS = [
  "ACTOR_NOT_AUTHORIZED",
  /** An ACTIVE version with economics other than STANDARD_V1 exists. */
  "CONFLICTING_ACTIVE_POLICY",
  /** More than one ACTIVE version carries the standard economics. */
  "AMBIGUOUS_EQUIVALENT_POLICY",
  /** The keyed policy's version 1 exists with economics other than STANDARD_V1. */
  "BOOTSTRAP_POLICY_DIVERGED",
  /** The keyed policy's version was retired; the bootstrap never resurrects it. */
  "BOOTSTRAP_POLICY_RETIRED",
] as const;
export type CommercialPolicyBootstrapRefusal = (typeof COMMERCIAL_POLICY_BOOTSTRAP_REFUSALS)[number];

export class CommercialPolicyBootstrapRefusedError extends Error {
  readonly refusal: CommercialPolicyBootstrapRefusal;
  constructor(refusal: CommercialPolicyBootstrapRefusal) {
    super(`Commercial policy bootstrap refused: ${refusal}`);
    this.name = "CommercialPolicyBootstrapRefusedError";
    this.refusal = refusal;
  }
}

export interface CommercialPolicyBootstrapDeps {
  db?: Db;
  ids?: CommercialPolicyIdProvider;
}

export interface CommercialPolicyBootstrapOutcome {
  /** `ALREADY_ACTIVE` wrote nothing; `ACTIVATED` put the standard policy in force. */
  outcome: "ALREADY_ACTIVE" | "ACTIVATED";
  policyId: string;
  policyVersion: string;
}

/** What `commercial-policy:bootstrap` would find. Read-only; ids and statuses only. */
export interface CommercialPolicyBootstrapInspection {
  actorAuthorized: boolean;
  activeEquivalentPolicyIds: string[];
  activeConflictingCount: number;
  bootstrapPolicyId: string | null;
  bootstrapVersionStatus: string | null;
}

const STANDARD = MONACADO_STANDARD_POLICY_V1;

function isStandardEconomics(row: {
  currency: string;
  retainedPercentageBasisPoints: number;
  retainedFixedAmountMinorUnits: bigint;
  roundingPolicy: string;
}): boolean {
  return (
    row.currency === STANDARD.currency &&
    row.retainedPercentageBasisPoints === STANDARD.retainedPercentageBasisPoints &&
    row.retainedFixedAmountMinorUnits === BigInt(STANDARD.retainedFixedAmountMinorUnits) &&
    row.roundingPolicy === STANDARD.roundingPolicy
  );
}

async function actorMayGovern(db: Db, actorAccountId: string): Promise<boolean> {
  const subject = await resolveInternalAuthorizationSubject(actorAccountId, { db });
  return isInternallyAuthorized(canGovernCommercialPolicy(subject));
}

async function readActive(db: Db) {
  const active = await db.commercialPolicyVersionRow.findMany({
    where: { status: "ACTIVE" },
    select: {
      policyId: true,
      policyVersion: true,
      currency: true,
      retainedPercentageBasisPoints: true,
      retainedFixedAmountMinorUnits: true,
      roundingPolicy: true,
    },
  });
  return {
    equivalent: active.filter(isStandardEconomics),
    conflicting: active.filter((row) => !isStandardEconomics(row)),
  };
}

async function readKeyedPolicy(db: Db) {
  return db.commercialPolicy.findUnique({
    where: { bootstrapKey: STANDARD_COMMERCIAL_POLICY_BOOTSTRAP_KEY },
    select: { id: true },
  });
}

/** The keyed policy, created if absent. The loser of a concurrent create adopts the winner's. */
async function ensureKeyedPolicy(db: Db, ids: CommercialPolicyIdProvider): Promise<string> {
  const existing = await readKeyedPolicy(db);
  if (existing !== null) return existing.id;
  try {
    const created = await db.commercialPolicy.create({
      data: {
        id: ids.nextPolicyId(),
        label: STANDARD_COMMERCIAL_POLICY_LABEL,
        bootstrapKey: STANDARD_COMMERCIAL_POLICY_BOOTSTRAP_KEY,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    const winner = await readKeyedPolicy(db);
    if (winner !== null) return winner.id;
    throw error;
  }
}

async function readStandardVersion(
  db: Db,
  policyId: string,
): Promise<CommercialPolicyVersionRecord | null> {
  const row = await db.commercialPolicyVersionRow.findUnique({
    where: { policyId_policyVersion: { policyId, policyVersion: STANDARD.policyVersion } },
    select: { policyId: true },
  });
  return row === null
    ? null
    : getCommercialPolicyVersion(policyId, STANDARD.policyVersion, { db });
}

function assertStandard(version: CommercialPolicyVersionRecord): void {
  if (
    version.currency !== STANDARD.currency ||
    version.retainedPercentageBasisPoints !== STANDARD.retainedPercentageBasisPoints ||
    version.retainedFixedAmountMinorUnits !== STANDARD.retainedFixedAmountMinorUnits ||
    version.roundingPolicy !== STANDARD.roundingPolicy
  ) {
    throw new CommercialPolicyBootstrapRefusedError("BOOTSTRAP_POLICY_DIVERGED");
  }
}

/**
 * Put the standard commercial policy in force, or report the one already in
 * force. Returns the policy id either way.
 */
export async function bootstrapStandardCommercialPolicy(
  input: { actorAccountId: string; now: string },
  deps: CommercialPolicyBootstrapDeps = {},
): Promise<CommercialPolicyBootstrapOutcome> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoCommercialPolicyIdProvider;

  /* Before any policy row is read, as `assertCommercialPolicyAuthority` does. */
  if (!(await actorMayGovern(db, input.actorAccountId))) {
    throw new CommercialPolicyBootstrapRefusedError("ACTOR_NOT_AUTHORIZED");
  }

  const before = await readActive(db);
  if (before.conflicting.length > 0) {
    throw new CommercialPolicyBootstrapRefusedError("CONFLICTING_ACTIVE_POLICY");
  }
  if (before.equivalent.length > 1) {
    throw new CommercialPolicyBootstrapRefusedError("AMBIGUOUS_EQUIVALENT_POLICY");
  }
  if (before.equivalent.length === 1) {
    const [only] = before.equivalent;
    return { outcome: "ALREADY_ACTIVE", policyId: only!.policyId, policyVersion: only!.policyVersion };
  }

  const policyId = await ensureKeyedPolicy(db, ids);

  let version = await readStandardVersion(db, policyId);
  if (version === null) {
    try {
      version = await recordCommercialPolicyVersion(
        {
          policyId,
          policyVersion: STANDARD.policyVersion,
          currency: STANDARD.currency,
          retainedPercentageBasisPoints: STANDARD.retainedPercentageBasisPoints,
          retainedFixedAmountMinorUnits: STANDARD.retainedFixedAmountMinorUnits,
          roundingPolicy: STANDARD.roundingPolicy,
          effectiveFrom: input.now,
          recordedByAccountId: input.actorAccountId,
          recordedAt: input.now,
        },
        { db },
      );
    } catch (error) {
      /* A concurrent run recorded it first. */
      if (!(error instanceof DuplicateCommercialPolicyVersionError)) throw error;
      version = await readStandardVersion(db, policyId);
      if (version === null) throw error;
    }
  }
  assertStandard(version);

  if (version.status === "RETIRED") {
    throw new CommercialPolicyBootstrapRefusedError("BOOTSTRAP_POLICY_RETIRED");
  }
  if (version.status === "DRAFT") {
    try {
      await activateCommercialPolicyVersion(
        {
          policyId,
          policyVersion: STANDARD.policyVersion,
          activatedByAccountId: input.actorAccountId,
          activatedAt: input.now,
        },
        { db },
      );
    } catch (error) {
      /* A concurrent run activated it first; the re-read below confirms. */
      if (!(error instanceof InvalidCommercialPolicyVersionTransitionError)) throw error;
    }
  }

  /* Re-read the whole field, so a run that raced another never reports a
     policy that is not, in fact, the one standard policy in force. */
  const after = await readActive(db);
  if (after.conflicting.length > 0) {
    throw new CommercialPolicyBootstrapRefusedError("CONFLICTING_ACTIVE_POLICY");
  }
  if (after.equivalent.length !== 1 || after.equivalent[0]!.policyId !== policyId) {
    throw new CommercialPolicyBootstrapRefusedError("AMBIGUOUS_EQUIVALENT_POLICY");
  }
  return { outcome: "ACTIVATED", policyId, policyVersion: STANDARD.policyVersion };
}

/** Read-only preflight for `commercial-policy:bootstrap`. Writes nothing. */
export async function inspectStandardCommercialPolicy(
  input: { actorAccountId: string },
  deps: { db?: Db } = {},
): Promise<CommercialPolicyBootstrapInspection> {
  const db = deps.db ?? getPrisma();
  const actorAuthorized = await actorMayGovern(db, input.actorAccountId);
  /* An unauthorized actor learns nothing about what is in force. */
  if (!actorAuthorized) {
    return {
      actorAuthorized,
      activeEquivalentPolicyIds: [],
      activeConflictingCount: 0,
      bootstrapPolicyId: null,
      bootstrapVersionStatus: null,
    };
  }
  const { equivalent, conflicting } = await readActive(db);
  const keyed = await readKeyedPolicy(db);
  const keyedVersion = keyed === null ? null : await readStandardVersion(db, keyed.id);
  return {
    actorAuthorized,
    activeEquivalentPolicyIds: equivalent.map((row) => row.policyId),
    activeConflictingCount: conflicting.length,
    bootstrapPolicyId: keyed?.id ?? null,
    bootstrapVersionStatus: keyedVersion?.status ?? null,
  };
}
