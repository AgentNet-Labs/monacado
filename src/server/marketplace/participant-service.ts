/**
 * Marketplace participant drafting service (Phase 0M.5) — SERVER ONLY.
 *
 * The narrow application boundary over participant persistence. Six operations:
 * create a draft participant, assign a role, update the private profile, read a
 * participant, advance its draft status, and materialize the `MarketplaceSubject`
 * the twelve 0M.1 capability decisions take.
 *
 * Four properties shape everything below:
 *
 *   1. **Drafting only, enforced structurally.** `advanceParticipantStatus`
 *      refuses UNDER_REVIEW, ACTIVE, RESTRICTED, SUSPENDED, and CLOSED — not
 *      because the 0M.1 transition table forbids them, but because reaching each
 *      is a governed act that belongs on its own evidence row, and this phase
 *      writes none. A phase that could set ACTIVE without recording who decided
 *      it would make the audit table decorative.
 *
 *      **Phase 0M.8 did not lift this gate.** It added `activation-service`,
 *      which writes UNDER_REVIEW and ACTIVE *together with* the activation row,
 *      in one transaction. The draft path stays exactly as narrow as it was, so
 *      there remains no way to reach either status without the audit evidence —
 *      which is stronger than widening this function would have been.
 *
 *      **Phase 1.17 found the gate was narrower than this claim.** CLOSED was a
 *      member of the draft-writable set, admitted by 0M.5 for the one case where
 *      it needs no decision — a draft giving up — and the gate reads only the
 *      TARGET, so it authorised every other case too: any caller could
 *      irreversibly close an ACTIVE, RESTRICTED, SUSPENDED, or UNDER_REVIEW
 *      participant with no actor, no authorization, and no record. Closure is now
 *      `closeParticipant` in `participant-closure-service`, authorized by the
 *      participant's own account and recorded on `ParticipantClosure`. The same
 *      target-only blindness let this function withdraw a participant from
 *      review; gate 2 on the function below closes that half.
 *
 *   2. **The 0M.1 logic is used, never restated.** Transitions come from
 *      `isValidParticipantTransition` / `isValidRoleAssignmentTransition`,
 *      initial role status from `initialRoleAssignmentStatus`, and capability
 *      answers from `capability.ts`. A second copy of a rule is a second rule.
 *
 *   3. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected —
 *      the same construction the account and publication services use, and what
 *      makes a deterministic fixture assertable.
 *
 *   4. **Private profile content is not a parameter.** The profile input carries
 *      section markers and onboarding gates; there is no field for a legal name,
 *      an address, a document, or a provider identifier, so none can be written
 *      and none can later be projected.
 *
 * No activation approval, no payment provider, no Node, no capsule, no
 * publication. Phase 1.29 added `beginParticipantOnboarding`, the one operation
 * here with a participant-facing route; it reaches the database only through
 * `marketplace-application-service`, with the account taken from the session.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  AssignParticipantRoleInput,
  BeginParticipantOnboardingInput,
  CreateDraftParticipantInput,
  UpdateParticipantProfileInput,
  isDraftWritableParticipantStatus,
  type MarketplaceParticipantRecord,
  type MarketplaceRoleAssignmentRecord,
  type ParticipantActivationRecord,
  type ParticipantProfileRecord,
} from "../../contracts/marketplace/participant-record";
import {
  INITIAL_PARTICIPANT_STATUS,
  initialRoleAssignmentStatus,
  isValidParticipantTransition,
} from "../../contracts/marketplace/lifecycle";
import type {
  MarketplaceRole,
  MarketplaceSubject,
  ParticipantStatus,
} from "../../contracts/marketplace/participant";
import { getPrisma } from "../db/client";
import {
  cryptoParticipantIdProvider,
  type ParticipantIdProvider,
} from "./participant-ids";
import {
  AccountNotFoundForParticipantError,
  ActivationNotPermittedInPhaseError,
  CorruptParticipantRecordError,
  DuplicateParticipantError,
  InvalidParticipantInputError,
  InvalidParticipantTransitionError,
  ParticipantNotFoundError,
  ParticipantOnboardingClosedError,
  ParticipantPersistenceFailureError,
} from "./participant-errors";
import {
  activationRowToRecord,
  participantRowToRecord,
  profileRowToRecord,
  roleAssignmentRowToRecord,
  toMarketplaceSubject,
} from "./participant-mapper";
import { readReadinessIn } from "./payment-account-service";
import { AmbiguousPaymentReadinessError } from "./payment-account-errors";

type Db = ReturnType<typeof getPrisma>;

export interface ParticipantServiceDeps {
  db?: Db;
  ids?: ParticipantIdProvider;
}

const isUniqueViolation = (error: unknown): boolean => prismaCode(error) === "P2002";
const isForeignKeyViolation = (error: unknown): boolean => prismaCode(error) === "P2003";

/**
 * Errors that must escape a catch block UNWRAPPED.
 *
 * A corrupt stored record is the consequential one: wrapping it in a generic
 * persistence failure would report "the database call failed" when what actually
 * happened is "the database holds something no code path should have been able
 * to write". Those need different responses, and the second must not be
 * disguised as the first.
 */
function isDomainError(error: unknown): boolean {
  return (
    error instanceof ParticipantNotFoundError ||
    error instanceof CorruptParticipantRecordError ||
    // Phase 0M.8: two stored payment accounts and no reduction rule. Wrapping it
    // as a persistence failure would report "the database call failed" when what
    // happened is "the readiness feeding a money decision is ambiguous".
    error instanceof AmbiguousPaymentReadinessError
  );
}

function prismaCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidParticipantInputError {
  return new InvalidParticipantInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

/** A participant with everything the read surface exposes. Never the profile. */
export interface ParticipantSnapshot {
  participant: MarketplaceParticipantRecord;
  roles: MarketplaceRoleAssignmentRecord[];
  /**
   * The most recent activation, or `null`. Always `null` in Phase 0M.5 — no
   * activation is submitted or decided here. Present so 0M.8 has a read path
   * that already exists rather than one invented alongside the write path.
   */
  latestActivation: ParticipantActivationRecord | null;
}

/**
 * Create one draft participant for an existing account.
 *
 * Created `DRAFT` — the only status `INITIAL_PARTICIPANT_STATUS` permits.
 * Requested roles are granted in the same transaction at their own initial
 * status: SELLER and PROMOTER start DRAFT because they confer commercial
 * capability and pass through activation; BUYER starts ACTIVE because guest
 * checkout is a first-class path, and a buyer role needing approval would be
 * stricter than buying with no account at all.
 *
 * Uniqueness is enforced by the unique index on `accountId`, not by a
 * read-then-write check, so two concurrent creations cannot both succeed.
 */
export async function createDraftParticipant(
  input: unknown,
  deps: ParticipantServiceDeps = {},
): Promise<ParticipantSnapshot> {
  const parsed = CreateDraftParticipantInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { accountId, initialRoles, now } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantIdProvider;

  // Deduplicate requested roles: asking for SELLER twice is one grant, not a
  // unique-constraint failure the caller has to interpret.
  const roles = Array.from(new Set(initialRoles)) as MarketplaceRole[];
  const participantId = ids.nextParticipantId();
  const at = new Date(now);

  try {
    return await db.$transaction(async (tx) => {
      await tx.marketplaceParticipant.create({
        data: {
          id: participantId,
          accountId,
          status: INITIAL_PARTICIPANT_STATUS,
        },
      });

      for (const role of roles) {
        await grantRoleInTx(tx, ids, participantId, role, at);
      }

      return await readSnapshotInTx(tx, participantId);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateParticipantError(error);
    if (isForeignKeyViolation(error)) throw new AccountNotFoundForParticipantError(error);
    if (isDomainError(error)) throw error;
    throw new ParticipantPersistenceFailureError("createDraftParticipant", error);
  }
}

/**
 * Grant one role to an existing participant.
 *
 * **Idempotent.** Granting a role the participant already holds returns the
 * current state unchanged rather than failing: roles are additive grants, and
 * re-granting one is not an error a caller should have to distinguish from a
 * genuine conflict. It never revives a REVOKED role — that terminal state stands
 * until an explicit future operation addresses it, and quietly resurrecting it
 * here would erase the revocation.
 */
export async function assignParticipantRole(
  input: unknown,
  deps: ParticipantServiceDeps = {},
): Promise<ParticipantSnapshot> {
  const parsed = AssignParticipantRoleInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { participantId, role, now } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantIdProvider;
  const at = new Date(now);

  try {
    return await db.$transaction(async (tx) => {
      const participant = await tx.marketplaceParticipant.findUnique({
        where: { id: participantId },
      });
      if (participant === null) throw new ParticipantNotFoundError();

      const existing = await tx.marketplaceRoleAssignment.findUnique({
        where: { participantId_role: { participantId, role } },
      });

      if (existing === null) {
        await grantRoleInTx(tx, ids, participantId, role, at);
      }

      return await readSnapshotInTx(tx, participantId);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) throw new DuplicateParticipantError(error);
    throw new ParticipantPersistenceFailureError("assignParticipantRole", error);
  }
}

/**
 * Begin, or extend, the signed-in account's own marketplace onboarding
 * (Phase 1.29).
 *
 * Creates the account's participant if it has none, then grants each requested
 * SELLER or PROMOTER role it does not yet hold — in one transaction, so the
 * status check and the grants see the same participant. Both roles start DRAFT
 * via `initialRoleAssignmentStatus`; this writes no activation, no profile, and
 * no status other than the participant's initial DRAFT.
 *
 * **Idempotent** in the same sense as `assignParticipantRole`: a role already
 * held is left exactly as it is, including a REVOKED one, which is never revived.
 *
 * **Only while drafting.** An existing participant outside
 * `DRAFT_WRITABLE_PARTICIPANT_STATUSES` is refused with
 * `ParticipantOnboardingClosedError`: adding a role to a participant under
 * review, admitted, restricted, suspended, or closed would change what Monacado
 * reviewed or decided, and that is a governed act rather than a self-service one.
 */
export async function beginParticipantOnboarding(
  input: unknown,
  deps: ParticipantServiceDeps = {},
): Promise<ParticipantSnapshot> {
  const parsed = BeginParticipantOnboardingInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { accountId, roles, now } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantIdProvider;
  const requested = Array.from(new Set(roles));
  const at = new Date(now);

  try {
    return await db.$transaction(async (tx) => {
      let participant = await tx.marketplaceParticipant.findUnique({ where: { accountId } });
      if (participant === null) {
        participant = await tx.marketplaceParticipant.create({
          data: { id: ids.nextParticipantId(), accountId, status: INITIAL_PARTICIPANT_STATUS },
        });
      } else if (!isDraftWritableParticipantStatus(participant.status as ParticipantStatus)) {
        throw new ParticipantOnboardingClosedError();
      }

      const held = await tx.marketplaceRoleAssignment.findMany({
        where: { participantId: participant.id },
        select: { role: true },
      });
      const heldRoles = new Set(held.map((r) => r.role));
      for (const role of requested) {
        if (!heldRoles.has(role)) await grantRoleInTx(tx, ids, participant.id, role, at);
      }

      return await readSnapshotInTx(tx, participant.id);
    });
  } catch (error) {
    if (error instanceof ParticipantOnboardingClosedError || isDomainError(error)) throw error;
    // Two first-time requests racing for the same account: the unique index on
    // `accountId` refuses the second, exactly as for `createDraftParticipant`.
    if (isUniqueViolation(error)) throw new DuplicateParticipantError(error);
    if (isForeignKeyViolation(error)) throw new AccountNotFoundForParticipantError(error);
    throw new ParticipantPersistenceFailureError("beginParticipantOnboarding", error);
  }
}

/**
 * Create or update the private profile.
 *
 * Upsert rather than create-then-update: a profile is subordinate state that
 * exists whenever someone first records progress against it, and making the
 * caller track whether it exists yet would be a distinction with no meaning.
 *
 * Supplied markers and gates are merged onto the stored row; omitted ones are
 * left alone, so setting one section never silently clears another.
 *
 * The returned record's `completeness` is derived, never stored.
 */
export async function updateParticipantProfile(
  input: unknown,
  deps: ParticipantServiceDeps = {},
): Promise<ParticipantProfileRecord> {
  const parsed = UpdateParticipantProfileInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { participantId, markers, gates } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantIdProvider;

  const markerData = {
    ...(markers?.identityComplete !== undefined
      ? { identityComplete: markers.identityComplete }
      : {}),
    ...(markers?.businessStructureComplete !== undefined
      ? { businessStructureComplete: markers.businessStructureComplete }
      : {}),
    ...(markers?.representativesComplete !== undefined
      ? { representativesComplete: markers.representativesComplete }
      : {}),
    ...(markers?.commercialProfileComplete !== undefined
      ? { commercialProfileComplete: markers.commercialProfileComplete }
      : {}),
    ...(markers?.riskComplete !== undefined ? { riskComplete: markers.riskComplete } : {}),
    ...(markers?.payoutConfigurationComplete !== undefined
      ? { payoutConfigurationComplete: markers.payoutConfigurationComplete }
      : {}),
    ...(markers?.documentsComplete !== undefined
      ? { documentsComplete: markers.documentsComplete }
      : {}),
  };

  const gateData = {
    ...(gates?.emailVerifiedAt !== undefined
      ? { emailVerifiedAt: gates.emailVerifiedAt === null ? null : new Date(gates.emailVerifiedAt) }
      : {}),
    ...(gates?.termsAcceptedAt !== undefined
      ? { termsAcceptedAt: gates.termsAcceptedAt === null ? null : new Date(gates.termsAcceptedAt) }
      : {}),
    ...(gates?.termsVersion !== undefined ? { termsVersion: gates.termsVersion } : {}),
  };

  try {
    const row = await db.participantProfile.upsert({
      where: { participantId },
      create: {
        id: ids.nextProfileId(),
        participantId,
        ...markerData,
        ...gateData,
      },
      update: { ...markerData, ...gateData },
    });
    return profileRowToRecord(row);
  } catch (error) {
    if (isForeignKeyViolation(error)) throw new ParticipantNotFoundError();
    if (isDomainError(error)) throw error;
    throw new ParticipantPersistenceFailureError("updateParticipantProfile", error);
  }
}

/** Read one participant with its roles and latest activation. Never the profile. */
export async function getParticipant(
  participantId: string,
  deps: ParticipantServiceDeps = {},
): Promise<ParticipantSnapshot> {
  const db = deps.db ?? getPrisma();
  try {
    return await readSnapshotInTx(db, participantId);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ParticipantPersistenceFailureError("getParticipant", error);
  }
}

/**
 * Read the private profile.
 *
 * A separate call from `getParticipant` on purpose. The profile is private
 * operational state; bundling it into the ordinary read would put it in every
 * caller's hands by default, and the one that eventually builds a public
 * projection would be holding it without ever having asked.
 *
 * Returns `null` when no profile has been started — an ordinary answer, not a
 * fault.
 */
export async function getParticipantProfile(
  participantId: string,
  deps: ParticipantServiceDeps = {},
): Promise<ParticipantProfileRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.participantProfile.findUnique({ where: { participantId } });
    return row === null ? null : profileRowToRecord(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ParticipantPersistenceFailureError("getParticipantProfile", error);
  }
}

/**
 * Move a participant between DRAFT-phase statuses.
 *
 * Three gates, in this order, and the order is the point:
 *
 *   1. **Is the target writable through the DRAFT path at all?** UNDER_REVIEW,
 *      ACTIVE, RESTRICTED, SUSPENDED, and CLOSED are refused with
 *      `ActivationNotPermittedInPhaseError` — a boundary, not a domain rule, and
 *      named differently so nobody reads it as "impossible". UNDER_REVIEW and
 *      ACTIVE are reached through `activation-service` (0M.8), which records who
 *      decided them; RESTRICTED and SUSPENDED through the governed mitigation
 *      services, which record the evidence behind them; CLOSED through
 *      `closeParticipant` (1.17), which records the participant's own decision.
 *   2. **Is the SOURCE one this path may move at all?** Phase 1.17. A status
 *      gate that reads only the target is a gate on half the transition, and
 *      both halves of what this function could reach turned out to matter:
 *      `CLOSED` was writable from every admitted state, and `UNDER_REVIEW` is a
 *      source from which `PROFILE_INCOMPLETE` is a legal target — so this
 *      function could reproduce the exact effect of a
 *      `MORE_INFORMATION_REQUIRED` decision with no reviewer, no entitlement,
 *      and no `ParticipantActivation` decision row. That did not merely bypass
 *      the review; it STRANDED the participant, because the undecided activation
 *      keeps its `undecidedForParticipantId` marker and afterwards resubmission
 *      hits a unique violation, approval finds no activation under review, and
 *      `MORE_INFORMATION_REQUIRED` fails its own transition check. A participant
 *      under review is moved by the review, and by nothing else.
 *   3. **Does the 0M.1 transition table permit it?** Checked last, so an attempt
 *      to jump DRAFT → PROFILE_COMPLETE is reported as the illegal transition it
 *      is rather than being masked by a phase gate.
 */
export async function advanceParticipantStatus(
  participantId: string,
  to: ParticipantStatus,
  deps: ParticipantServiceDeps = {},
): Promise<ParticipantSnapshot> {
  const db = deps.db ?? getPrisma();

  if (!isDraftWritableParticipantStatus(to)) {
    throw new ActivationNotPermittedInPhaseError(to);
  }

  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.marketplaceParticipant.findUnique({ where: { id: participantId } });
      if (row === null) throw new ParticipantNotFoundError();

      const from = row.status as ParticipantStatus;
      if (from === "UNDER_REVIEW") {
        /* Reported as the phase boundary it is: leaving review is a governed
           decision, and `decideParticipantActivation` is where it lives. */
        throw new ActivationNotPermittedInPhaseError(to);
      }
      if (!isValidParticipantTransition(from, to)) {
        throw new InvalidParticipantTransitionError(from, to);
      }

      await tx.marketplaceParticipant.update({
        where: { id: participantId },
        data: { status: to },
      });

      return await readSnapshotInTx(tx, participantId);
    });
  } catch (error) {
    if (isDomainError(error) || error instanceof InvalidParticipantTransitionError) {
      throw error;
    }
    throw new ParticipantPersistenceFailureError("advanceParticipantStatus", error);
  }
}

/**
 * Materialize the `MarketplaceSubject` for one account.
 *
 * This is the function that makes the twelve 0M.1 capability decisions reachable
 * from persisted state — until now they took a subject nothing could build.
 *
 * An unknown account yields the guest subject rather than an error: "not signed
 * in" is a condition a caller handles, and raising here would make every
 * anonymous request an exception. An account with no participant yields a
 * subject with `participant: null`, which is the authenticated non-participant.
 *
 * Internal capabilities are read from `AccountEntitlement`, kept entirely
 * separate from marketplace roles, and passed through only so `capability.ts`
 * can be shown to ignore them.
 */
export async function materializeMarketplaceSubject(
  accountId: string,
  deps: ParticipantServiceDeps = {},
): Promise<MarketplaceSubject> {
  const db = deps.db ?? getPrisma();

  try {
    const account = await db.account.findUnique({ where: { id: accountId } });
    if (account === null) {
      return toMarketplaceSubject({
        account: null,
        participant: null,
        roles: [],
        internalCapabilities: [],
      });
    }

    const participant = await db.marketplaceParticipant.findUnique({
      where: { accountId },
    });

    const roles =
      participant === null
        ? []
        : await db.marketplaceRoleAssignment.findMany({
            where: { participantId: participant.id },
            orderBy: { role: "asc" },
          });

    const entitlements = await db.accountEntitlement.findMany({
      where: { accountId, status: "ACTIVE" },
      orderBy: { capability: "asc" },
    });

    // Phase 0M.8: the provider's observed answer, read from storage rather than
    // reported from the 0M.5 constant. A participant with no linked account
    // still yields NOT_STARTED — now because nothing is stored, rather than
    // because nothing could be.
    const paymentReadiness =
      participant === null ? undefined : await readReadinessIn(db, participant.id);

    return toMarketplaceSubject({
      account,
      participant,
      roles,
      internalCapabilities: entitlements.map((e) => e.capability),
      paymentReadiness,
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ParticipantPersistenceFailureError("materializeMarketplaceSubject", error);
  }
}

/** Shared read used inside and outside a transaction. */
/**
 * Write one role assignment at the role's own initial status.
 *
 * The status is `initialRoleAssignmentStatus`'s answer, never a caller's. A role
 * created ACTIVE was activated at the moment it was granted — only BUYER reaches
 * that branch.
 */
async function grantRoleInTx(
  tx: Prisma.TransactionClient,
  ids: ParticipantIdProvider,
  participantId: string,
  role: MarketplaceRole,
  at: Date,
): Promise<void> {
  const status = initialRoleAssignmentStatus(role);
  await tx.marketplaceRoleAssignment.create({
    data: {
      id: ids.nextRoleAssignmentId(),
      participantId,
      role,
      status,
      grantedAt: at,
      activatedAt: status === "ACTIVE" ? at : null,
    },
  });
}

async function readSnapshotInTx(
  tx: Db | Prisma.TransactionClient,
  participantId: string,
): Promise<ParticipantSnapshot> {
  const row = await tx.marketplaceParticipant.findUnique({ where: { id: participantId } });
  if (row === null) throw new ParticipantNotFoundError();

  const roleRows = await tx.marketplaceRoleAssignment.findMany({
    where: { participantId },
    orderBy: { role: "asc" },
  });

  const activationRow = await tx.participantActivation.findFirst({
    where: { participantId },
    orderBy: { submittedAt: "desc" },
  });

  return {
    participant: participantRowToRecord(row),
    roles: roleRows.map(roleAssignmentRowToRecord),
    latestActivation: activationRow === null ? null : activationRowToRecord(activationRow),
  };
}
