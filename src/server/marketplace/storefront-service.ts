/**
 * Storefront persistence and governance service (Phase 0M.3C) — SERVER ONLY.
 *
 * The narrow application boundary over Storefront persistence: create a draft,
 * read the record and its versions, mint a new immutable version from an
 * authorized material update, and administer governance assignments.
 *
 * Five properties shape everything below:
 *
 *   1. **Immutable history.** A material change inserts a new version row and
 *      moves the stable record's pointer in one transaction. No historical row
 *      is ever updated, and a stable record can never point at a version that
 *      does not exist.
 *
 *   2. **The 0M.3A authority decisions are used, never restated.**
 *      `canCreateStorefrontRecord` and `canEditStorefrontPresentation` decide;
 *      this service assembles the facts they need and honours the answer. A
 *      second copy of an authorization rule is a second rule.
 *
 *   3. **Material change is 0M.3A's classification.** `materialChangesBetween`
 *      decides whether an update is a change at all. An update that changes
 *      nothing material mints no version.
 *
 *   4. **Go-live approval is never stored.** It is a supplied decision input to
 *      readiness evaluation, exactly as the source model requires.
 *
 *   5. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected.
 *
 * No HTTP route, no UI, no Node issuance, no publication.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  AssignStorefrontGovernanceInput,
  CreateDraftStorefrontInput,
  SetGovernanceAssignmentStatusInput,
  UpdateStorefrontInput,
  type StorefrontGovernanceAssignmentRecord,
} from "../../contracts/marketplace/storefront-record";
import {
  INITIAL_STOREFRONT_LIFECYCLE_STATE,
  canActivateStorefrontRecord,
  canCreateStorefrontRecord,
  canEditStorefrontPresentation,
  canCloseStorefrontRecord,
  canIncreaseStorefrontExposure,
  canReduceStorefrontExposure,
  canSuspendStorefrontRecord,
  canResumeStorefrontRecord,
  isStorefrontLive,
  isExposureIncrease,
  isExposureReduction,
  isValidStorefrontLifecycleTransition,
  materialChangesBetween,
  type MaterialStorefrontField,
  type StorefrontAuthorityDecision,
  type StorefrontGoLiveApprovalStatus,
  type StorefrontSourceRecord,
  type StorefrontSourceVersion,
} from "../../contracts/marketplace/storefront-source";
import { getPrisma } from "../db/client";
import {
  assertStorefrontMayBecomeOperational,
  assertParticipantMayAuthorMarketplaceState,
} from "./participant-standing-service";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { assertParticipantLifecycleIsLive } from "./participant-closure-service";
import { ParticipantLifecycleTerminatedError } from "./participant-closure-errors";
import { readActingAccountRows } from "./acting-subject-service";
import { readReadinessIn } from "./payment-account-service";
import { resolveCommerceApproval } from "./participant-commerce-approval-service";
import {
  cryptoStorefrontIdProvider,
  type StorefrontIdProvider,
} from "./storefront-ids";
import {
  CorruptStorefrontRecordError,
  DuplicatePublicHandleError,
  DuplicateSourceVersionError,
  GovernanceAssignmentNotFoundError,
  GovernanceParticipantNotFoundError,
  InvalidStorefrontInputError,
  NoMaterialChangeError,
  OwnerParticipantNotFoundError,
  StorefrontNotAuthorizedError,
  StorefrontNotFoundError,
  StorefrontPersistenceFailureError,
  StorefrontVersionNotFoundError,
  SuperOwnerAlreadyActiveError,
} from "./storefront-errors";
import {
  governanceRowToRecord,
  storefrontRowToSourceRecord,
  superOwnerCardinality,
  toStorefrontActorFacts,
  toStorefrontOwnerFacts,
  versionRowToSourceVersion,
} from "./storefront-mapper";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface StorefrontServiceDeps {
  db?: Db;
  ids?: StorefrontIdProvider;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";
const isForeignKeyViolation = (e: unknown): boolean => prismaCode(e) === "P2003";

/** The unique-index target named in a Prisma P2002, when it reports one. */
const uniqueTarget = (error: unknown): string => {
  const meta = (error as { meta?: { target?: unknown } }).meta;
  return typeof meta?.target === "string" ? meta.target : JSON.stringify(meta?.target ?? "");
};

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidStorefrontInputError {
  return new InvalidStorefrontInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

/** Errors that must escape a catch block unwrapped rather than be disguised. */
function isDomainError(error: unknown): boolean {
  return (
    /* Phase 1.15 — a governed standing refusal is a DOMAIN answer, not an
       outage. Wrapped as a persistence failure it would read to a caller as
       though the database had broken, and the bounded denial code the seam
       produced would be lost. */
    error instanceof ParticipantActionNotPermittedError ||
    /* Phase 1.19 — and a terminated participation is the same kind of answer.
       It arrives from `assertParticipantLifecycleIsLive` on the authoring
       paths, and reporting "the database broke" for "this participant has
       closed" would lose a bounded, actionable refusal. */
    error instanceof ParticipantLifecycleTerminatedError ||
    error instanceof StorefrontNotFoundError ||
    error instanceof StorefrontVersionNotFoundError ||
    error instanceof StorefrontNotAuthorizedError ||
    error instanceof NoMaterialChangeError ||
    error instanceof GovernanceAssignmentNotFoundError ||
    error instanceof CorruptStorefrontRecordError
  );
}

export interface StorefrontSnapshot {
  record: StorefrontSourceRecord;
  currentVersion: StorefrontSourceVersion;
}

// — Authorization facts —

/**
 * Assemble the 0M.3A owner and actor facts from persisted state.
 *
 * **The actor is the authenticated account, and everything about them is read
 * (Phase 1.18).** This function used to take `authorizedByParticipantId` and
 * look the account up *from it*, so a caller named which participant it was and
 * the service believed the claim; `actorAuthorizedForOwnerParticipant` then
 * arrived as a caller-supplied boolean beside it. Knowing one opaque
 * participant id was therefore enough to act as its holder on every Storefront
 * write, go-live and governance appointment included.
 *
 * `authorizedForOwnerParticipant` is now derived from the two records that can
 * actually establish it:
 *
 *   1. **the actor IS the owner** — self-ownership, the only basis available
 *      when the Storefront does not exist yet; or
 *   2. **an ACTIVE `StorefrontGovernanceAssignment`** naming this actor on this
 *      Storefront — an appointment by the owner *is* the owner's recorded
 *      authorization for someone else to act.
 *
 * 0M.3A's rule that authorization "must never be inferred from an email domain,
 * a display name, or any private profile datum" is preserved exactly: none of
 * those is read here, and none is readable — the actor projection has no field
 * for one. What the model deferred was *organization membership persistence*,
 * and it is still deferred: a member of an organization-owned Storefront who is
 * neither the owner nor a governance assignee has no authoritative record, so
 * they are **denied**. That is fail-closed, and it is the honest answer for an
 * authority the database cannot evidence.
 */
async function resolveAuthorizationFacts(
  tx: Tx,
  input: {
    ownerParticipantId: string;
    actingAccountId: string;
    internalStorefrontId: string | null;
  },
) {
  const owner = await tx.marketplaceParticipant.findUnique({
    where: { id: input.ownerParticipantId },
  });
  if (owner === null) throw new OwnerParticipantNotFoundError();

  const roles = await tx.marketplaceRoleAssignment.findMany({
    where: { participantId: owner.id },
    orderBy: { role: "asc" },
  });

  /* The acting account's OWN rows, through the shared Phase 1.18 reader. The
     account id names who is asking; nothing a caller sends names what they may
     do. */
  const acting = await readActingAccountRows(tx, input.actingAccountId);
  if (acting === null || acting.participant === null) {
    throw new GovernanceParticipantNotFoundError();
  }
  const actorParticipant = acting.participant;

  const assignment =
    input.internalStorefrontId === null
      ? null
      : await tx.storefrontGovernanceAssignment.findUnique({
          where: {
            internalStorefrontId_participantId: {
              internalStorefrontId: input.internalStorefrontId,
              participantId: actorParticipant.id,
            },
          },
        });

  /* Derived, never supplied. Self-ownership, or the owner's own recorded
     appointment of this actor on this Storefront. A SUSPENDED or REVOKED
     assignment is not an authorization — it is the record of one that has
     been withdrawn. */
  const authorizedForOwnerParticipant =
    actorParticipant.id === owner.id ||
    (assignment !== null && assignment.status === "ACTIVE");

  return {
    actorParticipantId: actorParticipant.id,
    owner: toStorefrontOwnerFacts({ owner, roles }),
    actor: toStorefrontActorFacts({
      accountId: acting.account.id,
      accountStatus: acting.account.status,
      authorizedForOwnerParticipant,
      assignment,
      internalCapabilities: [...acting.internalCapabilities],
    }),
  };
}

/**
 * The acting account must be enabled before it administers governance.
 *
 * The two governance commands hand-roll their authority test rather than
 * reaching `actorProblem` through `requireAllowed`, and `actorProblem` is where
 * every other Storefront path answers "is this account enabled at all"
 * (`ACCOUNT_DISABLED`). The status was resolved onto the actor facts and then
 * simply never read here.
 *
 * The consequence was the wrong way round: a DISABLED account whose participant
 * owned the Storefront — or held an ACTIVE SUPER_OWNER assignment — was refused
 * presentation edits, activation, and stand-down, yet could still appoint and
 * revoke governance. That is the one authority that restores all the others, so
 * disabling an account removed every power except the power to hand them back.
 *
 * Standing is asked beside it, for the reason `createDraftStorefront` asks it:
 * a suspension withholds authoring marketplace state, and an appointment is
 * marketplace state. Authority first, standing second — the same order, and the
 * same two questions, as every other governed write in this phase.
 *
 * **Phase 1.19 splits the two questions apart, because they answer different
 * acts.** See `requireGovernanceActorEnabled` below.
 */
/**
 * The acting account must be enabled. Asked of **every** governance act.
 *
 * This is the identity question — *is there an actor at all* — and it is never
 * relaxed. A DISABLED account performs no governance write of any kind, in
 * either direction. Disabling an account withdraws the actor; it is not a
 * marketplace sanction with an exposure direction, and there is no act it
 * merely narrows.
 */
function requireGovernanceActorEnabled(
  facts: { actor: { accountStatus: string } },
  capability: string,
): void {
  if (facts.actor.accountStatus !== "ACTIVE") {
    throw new StorefrontNotAuthorizedError(capability, ["ACCOUNT_DISABLED"]);
  }
}

/**
 * The acting participant must additionally be able to AUTHOR marketplace state.
 *
 * Asked only of governance acts that **increase exposure** — appointing an
 * assignment, elevating a role, restoring a revoked one. Those bring new
 * marketplace authority into existence, which is exactly what
 * `assertParticipantMayAuthorMarketplaceState` gates.
 *
 * **It is deliberately NOT asked of acts that reduce exposure**, and Phase 1.19
 * corrects the phase before it for asking. Both governance commands shared one
 * helper, so the authoring gate reached revocation too — and
 * `participant-standing-service` states the opposite rule in terms that leave
 * no room:
 *
 * > "SCOPED TO AUTHORING, not to standing down. It gates the acts that bring
 * > new marketplace state into existence; it never gates suspending, ending,
 * > withdrawing, closing... A suspended participant must still be able to
 * > stop."
 *
 * The consequence was the wrong way round in the same shape the account-status
 * omission had been: a suspended owner could not revoke a compromised ADMIN or
 * SUPER_OWNER, so a sanction meant to reduce a participant's reach instead
 * froze somebody else's authority over their Storefront in place. "Cannot
 * activate" had come to mean "cannot withdraw".
 *
 * This is the same asymmetry `assertStorefrontMayBecomeOperational` already
 * draws for the Storefront itself — go-live and widening are gated, standing
 * down never is — applied to the governance layer that sits above it.
 */
async function requireGovernanceAdministrationStanding(
  tx: Tx,
  facts: { actor: { accountStatus: string }; actorParticipantId: string },
  capability: string,
): Promise<void> {
  requireGovernanceActorEnabled(facts, capability);
  await requireActorMayAuthor(tx, facts.actorParticipantId);
}

/**
 * The ACTING participant may bring new marketplace state into existence.
 *
 * **The actor, never the owner.** Phase 1.19's second correction, and the
 * omission it closes is specific: `StorefrontActorFacts` has no
 * `participantStatus` member — deliberately, under 0M.3A, so that no pure
 * decision can come to depend on one — and nothing in the service supplied the
 * missing question either. The only standing call on the version path asked
 * `current.ownerParticipantId`. So an ACTIVE governance assignee whose own
 * participation was later suspended, or ended outright, kept exercising the
 * delegated authority the assignment had granted: the row said ACTIVE and
 * nothing re-asked whether its holder still could.
 *
 * Two independent questions, and an assignment answers only the first:
 *
 *   1. **Does this actor hold authority over this Storefront?** An ACTIVE
 *      `StorefrontGovernanceAssignment` answers that, durably.
 *   2. **May this actor exercise it, in this direction, right now?** That is
 *      asked here, at the act, against the authoritative rows — because it is a
 *      fact that changes after the appointment is recorded.
 *
 * Both terminal and suspended participation are refused, in that order:
 * `CLOSED` is an independent authoritative fact no mitigation act can produce,
 * so it is asked through its own seam rather than folded into standing.
 *
 * This does **not** replace the owner's own eligibility, which is asked
 * separately and answers a different question — whether the *Storefront* may be
 * operational at all. A delegated governor cannot make an ineligible owner's
 * shop live, and an eligible owner cannot lend operational authority to a
 * suspended or closed delegate. Both predicates must pass; neither substitutes.
 *
 * Restrictions are deliberately not consulted, inheriting
 * `assertParticipantMayAuthorMarketplaceState`'s rule: a RESTRICTED participant
 * must keep drafting, or the restriction becomes unanswerable.
 */
async function requireActorMayAuthor(tx: Tx, actorParticipantId: string): Promise<void> {
  await assertParticipantLifecycleIsLive(tx, actorParticipantId);
  await assertParticipantMayAuthorMarketplaceState(tx, actorParticipantId);
}

function requireAllowed(decision: StorefrontAuthorityDecision): void {
  if (decision.decision === "ALLOW") return;
  throw new StorefrontNotAuthorizedError(decision.capability, [...decision.reasonCodes]);
}

async function activeSuperOwnerCount(tx: Tx, internalStorefrontId: string): Promise<number> {
  return tx.storefrontGovernanceAssignment.count({
    where: { internalStorefrontId, role: "SUPER_OWNER", status: "ACTIVE" },
  });
}

// — Reads —

async function readSnapshotInTx(tx: Tx, internalStorefrontId: string): Promise<StorefrontSnapshot> {
  const row = await tx.storefront.findUnique({ where: { internalStorefrontId } });
  if (row === null) throw new StorefrontNotFoundError();

  const currentVersion = await tx.storefrontSourceRecordVersionRow.findUnique({
    where: {
      storefrontSourceRecordId_sourceRecordVersion: {
        storefrontSourceRecordId: row.storefrontSourceRecordId,
        sourceRecordVersion: row.currentSourceRecordVersion,
      },
    },
  });
  /* A stable record pointing at a nonexistent version would mean a partially
     written transaction; the write path makes it impossible, and reading it
     back must fail loudly rather than return half a Storefront. */
  if (currentVersion === null) throw new CorruptStorefrontRecordError(["currentSourceRecordVersion"]);

  return {
    record: storefrontRowToSourceRecord(row, currentVersion),
    currentVersion: versionRowToSourceVersion(currentVersion),
  };
}

/** Read one Storefront with its current authoritative source version. */
export async function getStorefront(
  internalStorefrontId: string,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontSnapshot> {
  const db = deps.db ?? getPrisma();
  try {
    return await readSnapshotInTx(db, internalStorefrontId);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new StorefrontPersistenceFailureError("getStorefront", error);
  }
}

/**
 * Read the current authoritative source version.
 *
 * This is the function a future publication phase hands to
 * `storefrontSourceRecordToCapsuleProjection` — the whole point of the phase.
 */
export async function getCurrentSourceVersion(
  internalStorefrontId: string,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontSourceVersion> {
  return (await getStorefront(internalStorefrontId, deps)).currentVersion;
}

/** Read one exact historical source version. Never "the latest". */
export async function getSourceVersion(
  internalStorefrontId: string,
  sourceRecordVersion: string,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontSourceVersion> {
  const db = deps.db ?? getPrisma();
  try {
    const stable = await db.storefront.findUnique({ where: { internalStorefrontId } });
    if (stable === null) throw new StorefrontNotFoundError();

    const row = await db.storefrontSourceRecordVersionRow.findUnique({
      where: {
        storefrontSourceRecordId_sourceRecordVersion: {
          storefrontSourceRecordId: stable.storefrontSourceRecordId,
          sourceRecordVersion,
        },
      },
    });
    if (row === null) throw new StorefrontVersionNotFoundError();
    return versionRowToSourceVersion(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new StorefrontPersistenceFailureError("getSourceVersion", error);
  }
}

/** Every source version, oldest first — deterministic creation order. */
export async function listSourceVersions(
  internalStorefrontId: string,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontSourceVersion[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.storefrontSourceRecordVersionRow.findMany({
      where: { internalStorefrontId },
      orderBy: { seq: "asc" },
    });
    if (rows.length === 0) throw new StorefrontNotFoundError();
    return rows.map(versionRowToSourceVersion);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new StorefrontPersistenceFailureError("listSourceVersions", error);
  }
}

export async function listGovernanceAssignments(
  internalStorefrontId: string,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontGovernanceAssignmentRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.storefrontGovernanceAssignment.findMany({
      where: { internalStorefrontId },
      orderBy: [{ role: "asc" }, { assignedAt: "asc" }],
    });
    return rows.map(governanceRowToRecord);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new StorefrontPersistenceFailureError("listGovernanceAssignments", error);
  }
}

// — Writes —

/**
 * Create one draft Storefront and its first immutable source version.
 *
 * The first version is `DRAFT` + `PRIVATE`, and neither is a caller choice:
 * 0M.3A's lifecycle starts at DRAFT, and a Storefront publicly visible before
 * anyone reviewed it would defeat the go-live gate.
 *
 * Handle uniqueness is enforced by the unique index rather than a read-then-write
 * check, so two concurrent creations cannot both succeed.
 */
export async function createDraftStorefront(
  input: unknown,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontSnapshot> {
  const parsed = CreateDraftStorefrontInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoStorefrontIdProvider;
  const internalStorefrontId = ids.nextInternalStorefrontId();
  const storefrontSourceRecordId = ids.nextStorefrontSourceRecordId();
  const at = new Date(data.now);

  try {
    return await db.$transaction(async (tx) => {
      const facts = await resolveAuthorizationFacts(tx, {
        ownerParticipantId: data.ownerParticipantId,
        actingAccountId: data.actingAccountId,
        /* No Storefront exists yet, so there is no assignment to resolve. */
        internalStorefrontId: null,
      });

      requireAllowed(canCreateStorefrontRecord({ owner: facts.owner, actor: facts.actor }));

      /* Phase 1.16 — an active suspension withholds authoring, whatever the
         projected status says. A participant suspended before admission keeps
         their onboarding stage, so `permitsDrafting` above still passes; the
         authoritative row is the only place the answer exists. */
      await assertParticipantMayAuthorMarketplaceState(tx, data.ownerParticipantId);

      await tx.storefront.create({
        data: {
          internalStorefrontId,
          storefrontSourceRecordId,
          currentSourceRecordVersion: "1",
          ownerParticipantId: data.ownerParticipantId,
          publicHandle: data.publicHandle,
          lifecycle: INITIAL_STOREFRONT_LIFECYCLE_STATE,
          visibility: "PRIVATE",
        },
      });

      await tx.storefrontSourceRecordVersionRow.create({
        data: {
          storefrontSourceRecordId,
          sourceRecordVersion: "1",
          supersedesSourceRecordVersion: null,
          internalStorefrontId,
          sourceSystem: "monacado",
          sourceRecordType: "Storefront",
          sourceClass: "governed-database-record",
          ownerParticipantId: data.ownerParticipantId,
          lifecycle: INITIAL_STOREFRONT_LIFECYCLE_STATE,
          visibility: "PRIVATE",
          publicHandle: data.publicHandle,
          presentationDisplayName: data.presentation.displayName,
          presentationTagline: data.presentation.tagline,
          presentationSummary: data.presentation.summary,
          authorizedByParticipantId: facts.actorParticipantId,
          authorizedByActorId: data.actingAccountId,
          recordedAt: at,
        },
      });

      return await readSnapshotInTx(tx, internalStorefrontId);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (error instanceof OwnerParticipantNotFoundError) throw error;
    if (error instanceof GovernanceParticipantNotFoundError) throw error;
    if (isUniqueViolation(error)) {
      if (uniqueTarget(error).includes("publicHandle")) {
        throw new DuplicatePublicHandleError(error);
      }
      throw new DuplicateSourceVersionError(error);
    }
    if (isForeignKeyViolation(error)) throw new OwnerParticipantNotFoundError(error);
    throw new StorefrontPersistenceFailureError("createDraftStorefront", error);
  }
}

/**
 * Mint a new immutable source version from an authorized material update.
 *
 * The sequence, and each step matters:
 *
 *   1. read the current version — the comparison basis;
 *   2. assemble 0M.3A authority facts and honour the decision;
 *   3. build the next material state and ask `materialChangesBetween` whether it
 *      is a change at all — an update asserting nothing mints nothing;
 *   4. check any lifecycle move against the 0M.3A transition table;
 *   5. insert the new version and advance the pointer **in one transaction**.
 *
 * Historical rows are never touched. The stable record's denormalized lifecycle,
 * visibility, and handle move with the pointer in the same transaction, so they
 * cannot disagree with the version they point at.
 */
export async function createStorefrontSourceVersion(
  input: unknown,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontSnapshot> {
  const parsed = UpdateStorefrontInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;

  const db = deps.db ?? getPrisma();
  const at = new Date(data.now);

  try {
    return await db.$transaction(async (tx) => {
      const stable = await tx.storefront.findUnique({
        where: { internalStorefrontId: data.internalStorefrontId },
      });
      if (stable === null) throw new StorefrontNotFoundError();

      const currentRow = await tx.storefrontSourceRecordVersionRow.findUnique({
        where: {
          storefrontSourceRecordId_sourceRecordVersion: {
            storefrontSourceRecordId: stable.storefrontSourceRecordId,
            sourceRecordVersion: stable.currentSourceRecordVersion,
          },
        },
      });
      if (currentRow === null) {
        throw new CorruptStorefrontRecordError(["currentSourceRecordVersion"]);
      }
      const current = versionRowToSourceVersion(currentRow);

      const facts = await resolveAuthorizationFacts(tx, {
        ownerParticipantId: current.ownerParticipantId,
        actingAccountId: data.actingAccountId,
        internalStorefrontId: data.internalStorefrontId,
      });

      const superOwners = await activeSuperOwnerCount(tx, data.internalStorefrontId);

      const next = {
        ownerParticipantId: current.ownerParticipantId,
        lifecycle: data.lifecycle ?? current.lifecycle,
        visibility: data.visibility ?? current.visibility,
        publicHandle: data.publicHandle ?? current.publicHandle,
        presentation: data.presentation ?? current.presentation,
      };

      const changed: MaterialStorefrontField[] = materialChangesBetween(
        {
          ownerParticipantId: current.ownerParticipantId,
          lifecycle: current.lifecycle,
          visibility: current.visibility,
          publicHandle: current.publicHandle,
          presentation: current.presentation,
        },
        next,
      );
      if (changed.length === 0) throw new NoMaterialChangeError();

      /* — Governance authorization, routed by what this version actually DOES. —
       *
       * Phase 1.15, Ruling 2. Every lifecycle and visibility move used to be
       * authorized by `canEditStorefrontPresentation`, a PRESENTATION decision
       * that admits an `ADMIN` and reads neither the owner's standing nor
       * Monacado's go-live determination. The authoritative source model (§7) is
       * explicit that an `ADMIN` may not "activate the Storefront" or "make it
       * publicly visible", and records the boundary as data in
       * `SUPER_OWNER_EXCLUSIVE_AUTHORITIES`. The decisions enforcing it already
       * existed and were simply never called.
       *
       * Branches, narrowest first:
       *
       *   - taking the Storefront live, or resuming it — `SUPER_OWNER` only,
       *     exactly one active `SUPER_OWNER` appointed, owner admitted and
       *     payable, and go-live APPROVED;
       *   - widening exposure toward the public — the same authority, for the
       *     same reason: §7 names making a Storefront publicly visible as an
       *     act an `ADMIN` may not perform;
       *   - standing DOWN — added by Phase 1.18; see the note on that branch.
       *     §7 reserves suspend, close, and visibility deactivation to
       *     `SUPER_OWNER` too, and this path used to fall through to the
       *     presentation gate;
       *   - everything else — presentation — stays exactly as it was. `ADMIN`
       *     keeps every operational authority it legitimately holds, and
       *     standing down still never requires an intact commerce gate: a
       *     `SUPER_OWNER` whose payment capability was just restricted can still
       *     close or hide the shop.
       *
       * `SUPER_OWNER` inherits every `ADMIN` permission, so a version that both
       * edits presentation and goes live is correctly judged by the stronger
       * gate rather than by both. */
      const becomingOperational =
        next.lifecycle === "ACTIVE" && current.lifecycle !== "ACTIVE";
      const wideningExposure = isExposureIncrease(current.visibility, next.visibility);

      /* Payment readiness is READ for the go-live branch rather than taken from
         the mapper's default. `toStorefrontOwnerFacts` reports the initial value
         by construction, documented on the premise that "no payment record
         exists (0M.8 owns that axis)" — which was true when it was written and
         is not now. Left as-is, the authority the source model specifies could
         never pass, which would be a different defect rather than a fix.

         Go-live approval is likewise resolved rather than assumed: the
         presentation branch keeps passing the conservative NOT_APPROVED, because
         editing does not depend on it. */
      const operationalRequest = async () => ({
        owner: {
          ...facts.owner,
          paymentReadiness: await readReadinessIn(tx, current.ownerParticipantId),
        },
        actor: facts.actor,
        storefrontId: data.internalStorefrontId,
        lifecycle: current.lifecycle,
        visibility: current.visibility,
        activeSuperOwnerCardinality: superOwnerCardinality(superOwners),
        goLiveApproval: await resolveCommerceApproval(tx, current.ownerParticipantId),
      });

      /* Phase 1.18 — stand-down reaches the decisions written for it.
       *
       * 0M.3A names `storefront:suspend`, `storefront:close` and
       * `storefront:visibility:deactivate` as SUPER_OWNER-exclusive, and Phase
       * 0M.3C wrote `canSuspendStorefrontRecord`, `canCloseStorefrontRecord` and
       * `canReduceStorefrontExposure` to enforce that. None of the three had a
       * call site: every non-go-live, non-widening version fell to the
       * presentation gate, which admits an ADMIN and inspects only the CURRENT
       * lifecycle. An ADMIN could therefore suspend or close a Storefront, and
       * `superOwnerConsistencyProblem` — the fail-closed check for contradictory
       * SUPER_OWNER facts — never ran at all.
       *
       * ADMIN keeps exactly what 0M.3A gives it: presentation and the other
       * operational authorities, which is still the final branch below. */
      const standingDown =
        next.lifecycle !== current.lifecycle &&
        (next.lifecycle === "SUSPENDED" || next.lifecycle === "CLOSED");
      const reducingExposure = isExposureReduction(current.visibility, next.visibility);

      if (becomingOperational) {
        const request = await operationalRequest();
        requireAllowed(
          current.lifecycle === "SUSPENDED"
            ? canResumeStorefrontRecord(request)
            : canActivateStorefrontRecord(request),
        );
      } else if (wideningExposure) {
        requireAllowed(
          canIncreaseStorefrontExposure({
            ...(await operationalRequest()),
            targetVisibility: next.visibility,
          }),
        );
      } else if (standingDown) {
        const request = await operationalRequest();
        requireAllowed(
          next.lifecycle === "CLOSED"
            ? canCloseStorefrontRecord(request)
            : canSuspendStorefrontRecord(request),
        );
      } else if (reducingExposure) {
        requireAllowed(
          canReduceStorefrontExposure({
            ...(await operationalRequest()),
            targetVisibility: next.visibility,
          }),
        );
      } else {
        requireAllowed(
          canEditStorefrontPresentation({
            owner: facts.owner,
            actor: facts.actor,
            storefrontId: data.internalStorefrontId,
            lifecycle: current.lifecycle,
            visibility: current.visibility,
            activeSuperOwnerCardinality: superOwnerCardinality(superOwners),
            /* Supplied, never stored. Editing does not depend on it, and passing
               the conservative value keeps the decision honest. */
            goLiveApproval: "NOT_APPROVED",
          }),
        );
      }

      if (
        next.lifecycle !== current.lifecycle &&
        !isValidStorefrontLifecycleTransition(current.lifecycle, next.lifecycle)
      ) {
        throw new StorefrontNotAuthorizedError("storefront:record:create", [
          "STOREFRONT_LIFECYCLE_TRANSITION_NOT_PERMITTED",
        ]);
      }

      /* Phase 1.15 — `storefront:activate` reaches the act it is named for.
       *
       * Until now this scope had NO reader of any kind, and the operation it
       * names was the least protected one in the repository: every lifecycle and
       * visibility move ran through `canEditStorefrontPresentation`, a
       * PRESENTATION decision that reads the actor's governance assignment and
       * never the owner's standing. A suspended owner could take a shop live.
       *
       * Two branches, and only these two: becoming operationally reachable
       * (`→ ACTIVE`), and widening exposure toward the public. Standing a
       * Storefront down — suspending, closing, or narrowing visibility — is never
       * gated, on the Storefront source model's own reasoning: an owner who
       * cannot be paid must still be able to stop trading.
       *
       * Gates the operational EFFECT, not the authorship. The source version is
       * still minted and presentation edits still land; what is refused is the
       * field value that makes the shop reachable. A restricted owner may still
       * correct the work that caused the restriction, which is exactly why
       * `RESTRICTED` is a drafting status.
       *
       * NOTE — this does not touch WHICH GOVERNANCE ROLE may act. That question
       * is answered above, and is now fully wired: Phase 1.15 routed activation
       * and resumption to `canActivateStorefrontRecord` / `canResumeStorefrontRecord`,
       * and Phase 1.18 routed stand-down to `canSuspendStorefrontRecord`,
       * `canCloseStorefrontRecord`, and `canReduceStorefrontExposure`. All are
       * SUPER_OWNER-exclusive. Governance authority and participant standing stay
       * independent gates, asked in that order. */
      /* Phase 1.19 — the ACTOR's own standing, on the authoring directions only.
       *
       * Classified by the discriminators this function already computes, rather
       * than by a new vocabulary: `standingDown` and `reducingExposure` are the
       * reductions; becoming operational, widening, and the presentation branch
       * all bring new marketplace state into existence and are therefore
       * authoring. There is no genuinely neutral mode — every call here mints an
       * immutable source version — so the split is exhaustive with two members.
       *
       * The asymmetry is the accepted one, now reaching the actor as well as the
       * owner: a participant whose authoring standing is withheld may still stop.
       * Suspending, closing, and narrowing visibility stay available to whoever
       * holds the authority for them, which on all three is SUPER_OWNER-exclusive
       * and unchanged. Making "cannot activate" mean "cannot withdraw" is exactly
       * what this phase corrected one layer up, and it must not reappear here. */
      const reducesExposure = standingDown || reducingExposure;
      if (!reducesExposure) {
        await requireActorMayAuthor(tx, facts.actorParticipantId);
      }

      /* And the OWNER's separate question — may this Storefront be operational
         at all. Unchanged, and deliberately not merged with the check above:
         one asks whether the actor may act, the other whether the shop may go
         live. A delegated governor passing the first does not answer the
         second. */
      if (becomingOperational || wideningExposure) {
        await assertStorefrontMayBecomeOperational(tx, current.ownerParticipantId);
      }

      await tx.storefrontSourceRecordVersionRow.create({
        data: {
          storefrontSourceRecordId: stable.storefrontSourceRecordId,
          sourceRecordVersion: data.sourceRecordVersion,
          supersedesSourceRecordVersion: current.sourceRecordVersion,
          internalStorefrontId: data.internalStorefrontId,
          sourceSystem: "monacado",
          sourceRecordType: "Storefront",
          sourceClass: "governed-database-record",
          ownerParticipantId: next.ownerParticipantId,
          lifecycle: next.lifecycle,
          visibility: next.visibility,
          publicHandle: next.publicHandle,
          presentationDisplayName: next.presentation.displayName,
          presentationTagline: next.presentation.tagline,
          presentationSummary: next.presentation.summary,
          authorizedByParticipantId: facts.actorParticipantId,
          authorizedByActorId: data.actingAccountId,
          recordedAt: at,
        },
      });

      await tx.storefront.update({
        where: { internalStorefrontId: data.internalStorefrontId },
        data: {
          currentSourceRecordVersion: data.sourceRecordVersion,
          lifecycle: next.lifecycle,
          visibility: next.visibility,
          publicHandle: next.publicHandle,
        },
      });

      return await readSnapshotInTx(tx, data.internalStorefrontId);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (error instanceof OwnerParticipantNotFoundError) throw error;
    if (error instanceof GovernanceParticipantNotFoundError) throw error;
    if (isUniqueViolation(error)) {
      if (uniqueTarget(error).includes("publicHandle")) {
        throw new DuplicatePublicHandleError(error);
      }
      throw new DuplicateSourceVersionError(error);
    }
    throw new StorefrontPersistenceFailureError("createStorefrontSourceVersion", error);
  }
}

/**
 * Appoint a participant to a governance role, or change an existing appointment.
 *
 * Idempotent per participant: a second appointment updates the existing row
 * rather than duplicating the grant, which is what the `(storefront, participant)`
 * unique index expresses.
 *
 * `activeSuperOwnerForStorefrontId` mirrors the storefront id when the row is an
 * ACTIVE SUPER_OWNER and is NULL otherwise, so the database refuses a second
 * active SUPER_OWNER outright. MySQL has no partial indexes; this is the same
 * technique the receipt and activation tables use.
 */
export async function assignStorefrontGovernance(
  input: unknown,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontGovernanceAssignmentRecord> {
  const parsed = AssignStorefrontGovernanceInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoStorefrontIdProvider;
  const at = new Date(data.now);

  try {
    return await db.$transaction(async (tx) => {
      const stable = await tx.storefront.findUnique({
        where: { internalStorefrontId: data.internalStorefrontId },
      });
      if (stable === null) throw new StorefrontNotFoundError();

      const facts = await resolveAuthorizationFacts(tx, {
        ownerParticipantId: stable.ownerParticipantId,
        actingAccountId: data.actingAccountId,
        internalStorefrontId: data.internalStorefrontId,
      });

      /* Appointing and revoking ADMIN are SUPER_OWNER-exclusive authorities
         (0M.3A). The owner's own first SUPER_OWNER appointment is permitted
         through the create-record decision, since there is no SUPER_OWNER yet to
         grant it. */
      await requireGovernanceAdministrationStanding(
        tx,
        facts,
        "storefront:governance:appoint-admin",
      );

      const superOwners = await activeSuperOwnerCount(tx, data.internalStorefrontId);
      const isOwnerBootstrappingFirstSuperOwner =
        data.role === "SUPER_OWNER" &&
        superOwners === 0 &&
        facts.actorParticipantId === stable.ownerParticipantId;

      if (!isOwnerBootstrappingFirstSuperOwner) {
        if (facts.actor.governanceRole !== "SUPER_OWNER" ||
            facts.actor.governanceAssignmentStatus !== "ACTIVE") {
          throw new StorefrontNotAuthorizedError("storefront:governance:appoint-admin", [
            "SUPER_OWNER_REQUIRED",
          ]);
        }
      }

      const existing = await tx.storefrontGovernanceAssignment.findUnique({
        where: {
          internalStorefrontId_participantId: {
            internalStorefrontId: data.internalStorefrontId,
            participantId: data.participantId,
          },
        },
      });

      const activeMarker =
        data.role === "SUPER_OWNER" ? data.internalStorefrontId : null;

      const row = existing
        ? await tx.storefrontGovernanceAssignment.update({
            where: { id: existing.id },
            data: {
              role: data.role,
              status: "ACTIVE",
              assignedAt: at,
              revokedAt: null,
              activeSuperOwnerForStorefrontId: activeMarker,
            },
          })
        : await tx.storefrontGovernanceAssignment.create({
            data: {
              id: ids.nextGovernanceAssignmentId(),
              internalStorefrontId: data.internalStorefrontId,
              participantId: data.participantId,
              role: data.role,
              status: "ACTIVE",
              assignedAt: at,
              activeSuperOwnerForStorefrontId: activeMarker,
            },
          });

      return governanceRowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (error instanceof OwnerParticipantNotFoundError) throw error;
    if (error instanceof GovernanceParticipantNotFoundError) throw error;
    if (isUniqueViolation(error)) {
      if (uniqueTarget(error).includes("activeSuperOwner")) {
        throw new SuperOwnerAlreadyActiveError(error);
      }
      throw new StorefrontPersistenceFailureError("assignStorefrontGovernance", error);
    }
    if (isForeignKeyViolation(error)) throw new GovernanceParticipantNotFoundError(error);
    throw new StorefrontPersistenceFailureError("assignStorefrontGovernance", error);
  }
}

/**
 * Suspend, revoke, or restore a governance assignment.
 *
 * Revocation is a **state change, not a delete** — "never appointed" and
 * "appointed and removed" are different facts, and an audit trail that conflated
 * them could not answer who used to hold authority. The active-SUPER_OWNER
 * marker is cleared whenever the row stops being an active SUPER_OWNER, which is
 * what frees the seat for a successor.
 *
 * **One command, two exposure directions (Phase 1.19).** `SUSPENDED` and
 * `REVOKED` reduce exposure; `ACTIVE` restores it. The authority rule —
 * the Storefront owner, or an active SUPER_OWNER — is identical either way and
 * is never relaxed. What differs is the standing question: restoring an
 * assignment asks the authoring question that appointing asks, because it has
 * the same effect; withdrawing one does not, because a participant who has been
 * suspended must still be able to withdraw authority they granted.
 *
 * Nothing here lets a suspended participant activate a Storefront, appoint
 * anyone, elevate a role, or publish commerce. Those are separate acts with
 * their own gates, and every one of them still asks.
 */
export async function setGovernanceAssignmentStatus(
  input: unknown,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontGovernanceAssignmentRecord> {
  const parsed = SetGovernanceAssignmentStatusInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;

  const db = deps.db ?? getPrisma();
  const at = new Date(data.now);

  try {
    return await db.$transaction(async (tx) => {
      const stable = await tx.storefront.findUnique({
        where: { internalStorefrontId: data.internalStorefrontId },
      });
      if (stable === null) throw new StorefrontNotFoundError();

      const existing = await tx.storefrontGovernanceAssignment.findUnique({
        where: {
          internalStorefrontId_participantId: {
            internalStorefrontId: data.internalStorefrontId,
            participantId: data.participantId,
          },
        },
      });
      if (existing === null) throw new GovernanceAssignmentNotFoundError();

      const facts = await resolveAuthorizationFacts(tx, {
        ownerParticipantId: stable.ownerParticipantId,
        actingAccountId: data.actingAccountId,
        internalStorefrontId: data.internalStorefrontId,
      });

      /* Phase 1.19 — the exposure direction decides which questions are asked.

         `SUSPENDED` and `REVOKED` withdraw an assignment; `ACTIVE` restores
         one. Restoring is indistinguishable in effect from appointing — it
         puts governance authority back into somebody's hands — so it asks the
         authoring question. Withdrawing asks only that the actor exists.

         A suspended owner must be able to revoke a compromised ADMIN. Trapping
         them would make a sanction on one participant into a freeze on another
         participant's authority over their Storefront, which is the opposite
         of what a suspension is for. */
      const reducesExposure = data.status !== "ACTIVE";
      if (reducesExposure) {
        requireGovernanceActorEnabled(facts, "storefront:governance:revoke-admin");
      } else {
        await requireGovernanceAdministrationStanding(
          tx,
          facts,
          "storefront:governance:revoke-admin",
        );
      }

      const actingAsOwner = facts.actorParticipantId === stable.ownerParticipantId;
      const actingAsSuperOwner =
        facts.actor.governanceRole === "SUPER_OWNER" &&
        facts.actor.governanceAssignmentStatus === "ACTIVE";
      if (!actingAsOwner && !actingAsSuperOwner) {
        throw new StorefrontNotAuthorizedError("storefront:governance:revoke-admin", [
          "SUPER_OWNER_REQUIRED",
        ]);
      }

      const stillActiveSuperOwner = existing.role === "SUPER_OWNER" && data.status === "ACTIVE";

      const row = await tx.storefrontGovernanceAssignment.update({
        where: { id: existing.id },
        data: {
          status: data.status,
          revokedAt: data.status === "REVOKED" ? at : null,
          activeSuperOwnerForStorefrontId: stillActiveSuperOwner
            ? data.internalStorefrontId
            : null,
        },
      });
      return governanceRowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (error instanceof OwnerParticipantNotFoundError) throw error;
    if (error instanceof GovernanceParticipantNotFoundError) throw error;
    if (isUniqueViolation(error)) throw new SuperOwnerAlreadyActiveError(error);
    throw new StorefrontPersistenceFailureError("setGovernanceAssignmentStatus", error);
  }
}

// — Readiness —

export interface StorefrontReadiness {
  activeSuperOwnerCardinality: ReturnType<typeof superOwnerCardinality>;
  /** Derived, never stored — the same rule 0M.3A applies. */
  live: boolean;
}

/**
 * Evaluate go-live readiness for a supplied Monacado approval.
 *
 * `goLiveApproval` is a **parameter, not a column**. 0M.3A makes it a supplied
 * decision, and there is no Storefront field for it — storing the approver's
 * determination inside the approved thing is the coupling that model avoids.
 *
 * `live` is derived through the source model's own `isStorefrontLive`; there is
 * no stored `isLive`, and this function computes nothing itself.
 *
 * **The supplied `goLiveApproval` is not an authorization answer (Phase 1.18).**
 * This function reads two rows and writes nothing; the boolean it returns is a
 * view, and a caller passing `"APPROVED"` changes no record and unlocks no act.
 * The only path on which a go-live approval actually gates a Storefront is
 * `createStorefrontSourceVersion`, which derives it from
 * `ParticipantCommerceApproval` through `resolveCommerceApproval`, inside the
 * transaction that writes. The parameter therefore stays supplied, exactly as
 * 0M.3A §9 specifies — Phase 1.18 removes forgeable authorization conclusions,
 * not boolean syntax.
 *
 * A future route must NOT hand this straight to a client, or the returned `live`
 * becomes a client-authored claim. Such a route derives the approval first, the
 * way the write path does.
 */
export async function evaluateStorefrontReadiness(
  internalStorefrontId: string,
  goLiveApproval: StorefrontGoLiveApprovalStatus,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontReadiness> {
  const db = deps.db ?? getPrisma();
  try {
    const { currentVersion } = await readSnapshotInTx(db, internalStorefrontId);
    const superOwners = await activeSuperOwnerCount(db, internalStorefrontId);

    return {
      activeSuperOwnerCardinality: superOwnerCardinality(superOwners),
      live: isStorefrontLive({
        lifecycle: currentVersion.lifecycle,
        visibility: currentVersion.visibility,
        goLiveApproval,
      }),
    };
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new StorefrontPersistenceFailureError("evaluateStorefrontReadiness", error);
  }
}
