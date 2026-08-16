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
  canCreateStorefrontRecord,
  canEditStorefrontPresentation,
  isStorefrontLive,
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
 * `authorizedForOwnerParticipant` is supplied by the caller and passed straight
 * through; nothing here could derive it, and 0M.3A forbids inferring it.
 */
async function resolveAuthorizationFacts(
  tx: Tx,
  input: {
    ownerParticipantId: string;
    authorizedByParticipantId: string;
    actorAuthorizedForOwnerParticipant: boolean;
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

  const actorParticipant = await tx.marketplaceParticipant.findUnique({
    where: { id: input.authorizedByParticipantId },
  });
  if (actorParticipant === null) throw new GovernanceParticipantNotFoundError();

  const account = await tx.account.findUnique({ where: { id: actorParticipant.accountId } });
  if (account === null) throw new GovernanceParticipantNotFoundError();

  const entitlements = await tx.accountEntitlement.findMany({
    where: { accountId: account.id, status: "ACTIVE" },
    orderBy: { capability: "asc" },
  });

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

  return {
    owner: toStorefrontOwnerFacts({ owner, roles }),
    actor: toStorefrontActorFacts({
      accountId: account.id,
      accountStatus: account.status,
      authorizedForOwnerParticipant: input.actorAuthorizedForOwnerParticipant,
      assignment,
      internalCapabilities: entitlements.map((e) => e.capability),
    }),
  };
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
        authorizedByParticipantId: data.authorizedByParticipantId,
        actorAuthorizedForOwnerParticipant: data.actorAuthorizedForOwnerParticipant,
        /* No Storefront exists yet, so there is no assignment to resolve. */
        internalStorefrontId: null,
      });

      requireAllowed(canCreateStorefrontRecord({ owner: facts.owner, actor: facts.actor }));

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
          authorizedByParticipantId: data.authorizedByParticipantId,
          authorizedByActorId: data.authorizedByActorId,
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
        authorizedByParticipantId: data.authorizedByParticipantId,
        actorAuthorizedForOwnerParticipant: data.actorAuthorizedForOwnerParticipant,
        internalStorefrontId: data.internalStorefrontId,
      });

      const superOwners = await activeSuperOwnerCount(tx, data.internalStorefrontId);

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

      if (
        next.lifecycle !== current.lifecycle &&
        !isValidStorefrontLifecycleTransition(current.lifecycle, next.lifecycle)
      ) {
        throw new StorefrontNotAuthorizedError("storefront:record:create", [
          "STOREFRONT_LIFECYCLE_TRANSITION_NOT_PERMITTED",
        ]);
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
          authorizedByParticipantId: data.authorizedByParticipantId,
          authorizedByActorId: data.authorizedByActorId,
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
        authorizedByParticipantId: data.authorizedByParticipantId,
        actorAuthorizedForOwnerParticipant: data.actorAuthorizedForOwnerParticipant,
        internalStorefrontId: data.internalStorefrontId,
      });

      /* Appointing and revoking ADMIN are SUPER_OWNER-exclusive authorities
         (0M.3A). The owner's own first SUPER_OWNER appointment is permitted
         through the create-record decision, since there is no SUPER_OWNER yet to
         grant it. */
      const superOwners = await activeSuperOwnerCount(tx, data.internalStorefrontId);
      const isOwnerBootstrappingFirstSuperOwner =
        data.role === "SUPER_OWNER" &&
        superOwners === 0 &&
        data.authorizedByParticipantId === stable.ownerParticipantId;

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
        authorizedByParticipantId: data.authorizedByParticipantId,
        actorAuthorizedForOwnerParticipant: data.actorAuthorizedForOwnerParticipant,
        internalStorefrontId: data.internalStorefrontId,
      });

      const actingAsOwner = data.authorizedByParticipantId === stable.ownerParticipantId;
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
