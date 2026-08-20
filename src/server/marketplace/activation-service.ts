/**
 * Governed participant activation service (Phase 0M.8) — SERVER ONLY.
 *
 * The phase 0M.5 pointed at. Its `advanceParticipantStatus` refuses
 * `UNDER_REVIEW` and `ACTIVE` "not because the 0M.1 transition table forbids
 * them, but because reaching them is a governed activation decision that belongs
 * on a `ParticipantActivation` row, and this phase writes none". This is the
 * service that writes them.
 *
 * Seven properties shape everything below:
 *
 *   1. **Submission and decision are separate acts, in separate calls.**
 *      `UNDER_REVIEW` is a state of its own (0M.1 §4.1), and a reviewer needs to
 *      see what was submitted before deciding it. One call that both submitted
 *      and approved would make "submitted" unobservable.
 *
 *   2. **No status reaches ACTIVE without an activation row.** Both writes
 *      happen in one transaction, so a participant can never be `ACTIVE` with no
 *      record of who decided it, and an activation can never be decided while
 *      the status it justified failed to move.
 *
 *   3. **Reviewer authority is a persisted internal entitlement, and does not
 *      extend to one's own participant.** Activation
 *      review is Monacado's own operational act, so it is authorized by the
 *      `activation:review` `AccountEntitlement` and evaluated by
 *      `canReviewParticipantActivation` against state read from the database on
 *      every call. No caller asserts its own authorization, and no marketplace
 *      role, participant ownership, or account ownership confers it.
 *      **Separation of duties then narrows it further:** an entitled account
 *      may review other participants and may never decide the activation of the
 *      participant it owns.
 *
 *   4. **Provider readiness is read as evidence and never written.** Approval
 *      requires `ENABLED`, which only the provider supplies. Nothing here
 *      touches `ParticipantPaymentAccount`, so a Monacado approval cannot
 *      fabricate a provider state — that is the 0M.1 §5 separation enforced
 *      structurally rather than described.
 *
 *   5. **`RESTRICTED` and `SUSPENDED` are unreachable**, behind their own phase
 *      gate. They have no machine-readable restriction scope, which `0M.R1`
 *      owns; refusing is the only answer that fabricates nothing.
 *
 *   6. **Append-only.** A decided activation is never re-decided; a second
 *      review is a second submission and a second row, so the first survives.
 *
 *   7. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected.
 *
 * No money moves here. No charge, order, payout, settlement, tax, ledger,
 * notification, or risk record is created — the durable activation and payment
 * state IS the audit evidence for this phase.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  DecideParticipantActivationInput,
  SubmitParticipantActivationInput,
  evaluateActivationApproval,
  isActivationPhaseWritableParticipantStatus,
  isCoherentDecisionReason,
  participantStatusAfterDecision,
  requiresRestrictionScope,
  roleStatusOnActivationApproval,
  roleStatusOnActivationSubmission,
} from "../../contracts/marketplace/activation-review";
import {
  deriveProfileCompleteness,
  type ParticipantActivationRecord,
} from "../../contracts/marketplace/participant-record";
import { canSubmitActivation } from "../../contracts/marketplace/capability";
import {
  ACTIVATION_REVIEW_CAPABILITY,
  canReviewParticipantActivation,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import {
  isValidParticipantTransition,
  isValidRoleAssignmentTransition,
} from "../../contracts/marketplace/lifecycle";
import type {
  ParticipantStatus,
  PaymentReadinessStatus,
  RoleAssignmentStatus,
} from "../../contracts/marketplace/participant";
import { getPrisma } from "../db/client";
import { cryptoParticipantIdProvider, type ParticipantIdProvider } from "./participant-ids";
import {
  ActivationAlreadyDecidedError,
  ActivationNotPermittedInPhaseError,
  ActivationNotSubmittedError,
  ActivationPrerequisitesNotMetError,
  ActivationReviewerNotAuthorizedError,
  ActivationSelfReviewNotPermittedError,
  CorruptParticipantRecordError,
  IncoherentActivationDecisionError,
  InvalidParticipantInputError,
  InvalidParticipantTransitionError,
  ParticipantNotFoundError,
  ParticipantPersistenceFailureError,
  RestrictionScopeNotAvailableInPhaseError,
} from "./participant-errors";
import { activationRowToRecord, toMarketplaceSubject } from "./participant-mapper";
import { readReadinessIn } from "./payment-account-service";
import { AmbiguousPaymentReadinessError } from "./payment-account-errors";

type Db = ReturnType<typeof getPrisma>;

export interface ActivationServiceDeps {
  db?: Db;
  ids?: ParticipantIdProvider;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const isUniqueViolation = (error: unknown): boolean => prismaCode(error) === "P2002";

/** Errors that must escape a catch block UNWRAPPED — see participant-service. */
function isDomainError(error: unknown): boolean {
  return (
    error instanceof ParticipantNotFoundError ||
    error instanceof CorruptParticipantRecordError ||
    error instanceof ActivationNotSubmittedError ||
    error instanceof ActivationAlreadyDecidedError ||
    error instanceof ActivationPrerequisitesNotMetError ||
    error instanceof ActivationReviewerNotAuthorizedError ||
    error instanceof ActivationSelfReviewNotPermittedError ||
    error instanceof IncoherentActivationDecisionError ||
    error instanceof ActivationNotPermittedInPhaseError ||
    error instanceof RestrictionScopeNotAvailableInPhaseError ||
    error instanceof InvalidParticipantTransitionError ||
    error instanceof AmbiguousPaymentReadinessError
  );
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidParticipantInputError {
  return new InvalidParticipantInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

export interface ActivationSnapshot {
  participantStatus: ParticipantStatus;
  activation: ParticipantActivationRecord;
}

/**
 * Submit an eligible participant for activation review.
 *
 * Authorization is the committed `canSubmitActivation` decision, evaluated
 * against a subject materialized from persisted state — not a local restatement
 * of its rules. It refuses a disabled account, a non-participant, an incomplete
 * profile, an already-submitted review, an already-admitted participant, and a
 * participant holding no activatable role, each with its own bounded reason code.
 *
 * Three writes, one transaction:
 *
 *   - the participant moves `PROFILE_COMPLETE → UNDER_REVIEW`, checked against
 *     the 0M.1 table rather than assumed;
 *   - every activatable role at `DRAFT` moves to `PENDING_ACTIVATION`, which is
 *     that status's own meaning — "included in a submitted activation";
 *   - one undecided `ParticipantActivation` row is appended.
 *
 * At most one undecided activation per participant is enforced by the
 * `undecidedForParticipantId` unique index rather than a read-then-write check,
 * so two concurrent submissions cannot both succeed.
 *
 * **Payment readiness is deliberately not a gate here.** 0M.1 §5: provider
 * onboarding and Monacado review are independent, and requiring one to start the
 * other would make a provider outage a Monacado review outage.
 */
export async function submitParticipantForActivation(
  input: unknown,
  deps: ActivationServiceDeps = {},
): Promise<ActivationSnapshot> {
  const parsed = SubmitParticipantActivationInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { participantId, submittedAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantIdProvider;
  const at = new Date(submittedAt);
  const activationId = ids.nextActivationId();

  try {
    return await db.$transaction(async (tx) => {
      const participant = await tx.marketplaceParticipant.findUnique({
        where: { id: participantId },
      });
      if (participant === null) throw new ParticipantNotFoundError();

      const subject = await materializeSubjectInTx(tx, participant.accountId);
      const decision = canSubmitActivation(subject);
      if (decision.decision !== "ALLOW") {
        throw new ActivationPrerequisitesNotMetError([...decision.reasonCodes]);
      }

      const from = participant.status as ParticipantStatus;
      assertPhaseWritable("UNDER_REVIEW");
      if (!isValidParticipantTransition(from, "UNDER_REVIEW")) {
        throw new InvalidParticipantTransitionError(from, "UNDER_REVIEW");
      }

      await tx.marketplaceParticipant.update({
        where: { id: participantId },
        data: { status: "UNDER_REVIEW" },
      });

      await advanceRoles(tx, participantId, roleStatusOnActivationSubmission, null);

      await tx.participantActivation.create({
        data: {
          id: activationId,
          participantId,
          submittedAt: at,
          decision: null,
          decidedAt: null,
          decidedByActorId: null,
          decisionReasonCode: null,
          // Set while undecided and NULL once decided: the unique index on this
          // column is what enforces at most one undecided activation, since
          // MySQL has no partial indexes.
          undecidedForParticipantId: participantId,
        },
      });

      return await readActivationSnapshotInTx(tx, participantId, activationId);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) throw new ActivationAlreadyDecidedError(error);
    throw new ParticipantPersistenceFailureError("submitParticipantForActivation", error);
  }
}

/**
 * Decide one submitted activation.
 *
 * **Reviewer authority is a persisted internal entitlement.** Activation review
 * is a Monacado internal operational authority, not a marketplace participant
 * role, so it is the `activation:review` `AccountEntitlement` — evaluated by
 * `canReviewParticipantActivation` against a subject resolved from the database
 * on every call, never from a token claim and never from a cache, so a
 * revocation fails closed on the very next decision.
 *
 * **The caller supplies who is acting, never what they may do.**
 * `DecideParticipantActivationInput` has no authorization field at all, so there
 * is nothing to assert; `reviewerAccountId` names the acting internal account
 * and is the only identity involved.
 *
 * **Nothing else confers the authority.** Not holding SELLER, PROMOTER, or
 * BUYER; not owning the participant under review; not owning the account that
 * owns it; not `publication-worker:status:read`; not merely being
 * authenticated. `canReviewParticipantActivation` has no parameter capable of
 * carrying a role, a participant, or an ownership relation, so it cannot grant on
 * one — the same structural guarantee that keeps private profile data out of
 * `toMarketplaceSubject`. One human may legitimately hold both a participant
 * identity and this entitlement; the entitlement is still granted explicitly and
 * checked independently.
 *
 * **Separation of duties: an entitled reviewer may not decide their own.**
 * Holding `activation:review` is **necessary but not sufficient** — an account
 * may review other participants and may never decide the activation of the
 * participant it owns. Deciding one's own admission is the decision a governed
 * review exists to prevent, and no entitlement makes it self-governed. The
 * comparison reads the persisted `MarketplaceParticipant.accountId` foreign key;
 * nothing is inferred from an email, a name, a caller claim, or an identifier
 * prefix.
 *
 * Order of checks, and the order is the point:
 *
 *   1. **Reviewer authorization**, before any participant state is read. An
 *      unauthorized caller learns nothing about the participant — not whether it
 *      exists, not its status, and not what is outstanding on it.
 *   2. **Self-review**, from the persisted ownership FK, before the pending
 *      activation is looked up — so a self-reviewer does not learn whether a
 *      review is even outstanding. It carries its own bounded error, because
 *      "you may not review activations" and "you may not review *this* one" are
 *      different answers, and an operator told the first would go looking for a
 *      grant they already hold.
 *   3. **Decision/reason coherence.** An `APPROVED` row reading
 *      `PROVIDER_DECLINED` is an audit record that argues with itself.
 *   4. **An undecided activation exists**, and is claimed by its own id so a
 *      concurrent decision cannot double-decide it.
 *   5. **For `APPROVED` only**, every prerequisite — via
 *      `evaluateActivationApproval`, which collects all outstanding refusals
 *      rather than the first, and includes provider readiness `ENABLED`.
 *
 * `MORE_INFORMATION_REQUIRED` returns the participant to `PROFILE_INCOMPLETE`,
 * which the 0M.1 table permits from `UNDER_REVIEW` and which is what asking for
 * more information means without suspending anyone. `REJECTED` leaves the status
 * where it is: the lifecycle has no rejected state, `CLOSED` is terminal and
 * means the participant gave up, and closing on Monacado's behalf would end an
 * admission the participant may legitimately resubmit.
 */
export async function decideParticipantActivation(
  input: unknown,
  deps: ActivationServiceDeps = {},
): Promise<ActivationSnapshot> {
  const parsed = DecideParticipantActivationInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { participantId, decision, decisionReasonCode, reviewerAccountId, decidedAt } =
    parsed.data;

  const db = deps.db ?? getPrisma();

  // Authorization first, from persisted state, and outside the transaction that
  // reads the participant: an unauthorized caller must not reach a query about
  // the target at all.
  const reviewer = await resolveInternalAuthorizationSubject(reviewerAccountId, { db });
  const authorization = canReviewParticipantActivation(reviewer);
  if (!isInternallyAuthorized(authorization)) {
    throw new ActivationReviewerNotAuthorizedError([...authorization.reasonCodes]);
  }

  if (!isCoherentDecisionReason(decision, decisionReasonCode)) {
    throw new IncoherentActivationDecisionError(decision, decisionReasonCode);
  }

  const at = new Date(decidedAt);

  try {
    return await db.$transaction(async (tx) => {
      const participant = await tx.marketplaceParticipant.findUnique({
        where: { id: participantId },
      });
      if (participant === null) throw new ParticipantNotFoundError();

      // Separation of duties, from the persisted FK and nothing else.
      //
      // `MarketplaceParticipant.accountId` is the authoritative Account <-> participant
      // relationship — unique, non-null, and the same column every other
      // ownership question in this track reads. Ownership is never inferred from
      // an email, a display name, a caller claim, or the shape of an identifier:
      // prefix incompatibility is not a security control, and both sides here
      // are `mon:acct:` forms anyway.
      //
      // Checked before the pending activation is looked up, so a self-reviewer
      // does not even learn whether a review is outstanding.
      if (participant.accountId === reviewerAccountId) {
        throw new ActivationSelfReviewNotPermittedError();
      }

      const pending = await tx.participantActivation.findUnique({
        where: { undecidedForParticipantId: participantId },
      });
      if (pending === null) throw new ActivationNotSubmittedError();

      if (decision === "APPROVED") {
        await assertApprovable(tx, participantId, participant.status as ParticipantStatus);
      }

      // Claim the row by its own id AND by its still-undecided marker, so a
      // concurrent decision updates zero rows rather than overwriting the first.
      const claimed = await tx.participantActivation.updateMany({
        where: { id: pending.id, undecidedForParticipantId: participantId },
        data: {
          decision,
          decidedAt: at,
          // The audit actor IS the authorized reviewer — one identity, resolved
          // once above. There is no second supplied value that could name
          // someone other than whoever was actually checked.
          decidedByActorId: reviewerAccountId,
          decisionReasonCode,
          undecidedForParticipantId: null,
        },
      });
      if (claimed.count !== 1) throw new ActivationAlreadyDecidedError();

      const nextStatus = participantStatusAfterDecision(decision);
      if (nextStatus !== null) {
        assertPhaseWritable(nextStatus);
        const from = participant.status as ParticipantStatus;
        if (!isValidParticipantTransition(from, nextStatus)) {
          throw new InvalidParticipantTransitionError(from, nextStatus);
        }
        await tx.marketplaceParticipant.update({
          where: { id: participantId },
          data: { status: nextStatus },
        });
      }

      if (decision === "APPROVED") {
        await advanceRoles(tx, participantId, roleStatusOnActivationApproval, at);
      }

      return await readActivationSnapshotInTx(tx, participantId, pending.id);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ParticipantPersistenceFailureError("decideParticipantActivation", error);
  }
}

/** Every activation for a participant, newest submission first. Append-only history. */
export async function getParticipantActivationHistory(
  participantId: string,
  deps: ActivationServiceDeps = {},
): Promise<ParticipantActivationRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.participantActivation.findMany({
      where: { participantId },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    });
    return rows.map(activationRowToRecord);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ParticipantPersistenceFailureError("getParticipantActivationHistory", error);
  }
}

// — Internals —

/**
 * The two phase gates, applied to any status this service is about to write.
 *
 * `RESTRICTED`/`SUSPENDED` are checked first and reported with the stronger
 * error: they are not merely a decision this phase declines to make, they have
 * no machine-readable content to write at all.
 */
function assertPhaseWritable(status: ParticipantStatus): void {
  if (requiresRestrictionScope(status)) {
    throw new RestrictionScopeNotAvailableInPhaseError(status);
  }
  if (!isActivationPhaseWritableParticipantStatus(status)) {
    throw new ActivationNotPermittedInPhaseError(status);
  }
}

/**
 * Every approval prerequisite, evaluated together.
 *
 * Reviewer authority is NOT among them — it is settled before this is reached,
 * against persisted entitlement state, and has its own bounded vocabulary.
 *
 * Reads provider readiness; writes none. Profile completeness is derived from
 * the stored markers and gates by 0M.5's own `deriveProfileCompleteness`, never
 * from a second copy of the rule and never from a stored column that does not
 * exist.
 */
async function assertApprovable(
  tx: Prisma.TransactionClient,
  participantId: string,
  participantStatus: ParticipantStatus,
): Promise<void> {
  const profile = await tx.participantProfile.findUnique({ where: { participantId } });
  const profileComplete =
    profile !== null &&
    deriveProfileCompleteness(
      {
        identityComplete: profile.identityComplete,
        businessStructureComplete: profile.businessStructureComplete,
        representativesComplete: profile.representativesComplete,
        commercialProfileComplete: profile.commercialProfileComplete,
        riskComplete: profile.riskComplete,
        payoutConfigurationComplete: profile.payoutConfigurationComplete,
        documentsComplete: profile.documentsComplete,
      },
      {
        emailVerifiedAt: profile.emailVerifiedAt?.toISOString() ?? null,
        termsAcceptedAt: profile.termsAcceptedAt?.toISOString() ?? null,
        termsVersion: profile.termsVersion,
      },
    ) === "COMPLETE";

  const roles = await tx.marketplaceRoleAssignment.findMany({
    where: { participantId },
    orderBy: { role: "asc" },
  });

  const paymentReadiness: PaymentReadinessStatus = await readReadinessIn(tx, participantId);

  const approval = evaluateActivationApproval({
    participantStatus,
    profileComplete,
    roles: roles.map((r) => ({
      role: r.role as "SELLER" | "PROMOTER" | "BUYER",
      status: r.status as RoleAssignmentStatus,
    })),
    paymentReadiness,
  });

  if (approval.decision !== "ALLOW") {
    throw new ActivationPrerequisitesNotMetError([...approval.refusalCodes]);
  }
}

/** Move each role through `next`, honouring the 0M.1 role transition table. */
async function advanceRoles(
  tx: Prisma.TransactionClient,
  participantId: string,
  next: (current: RoleAssignmentStatus) => RoleAssignmentStatus | null,
  activatedAt: Date | null,
): Promise<void> {
  const roles = await tx.marketplaceRoleAssignment.findMany({ where: { participantId } });
  for (const role of roles) {
    const from = role.status as RoleAssignmentStatus;
    const to = next(from);
    if (to === null || !isValidRoleAssignmentTransition(from, to)) continue;
    await tx.marketplaceRoleAssignment.update({
      where: { id: role.id },
      data: {
        status: to,
        ...(to === "ACTIVE" && activatedAt !== null ? { activatedAt } : {}),
      },
    });
  }
}

/** Materialize the subject `canSubmitActivation` takes, from persisted state. */
async function materializeSubjectInTx(tx: Prisma.TransactionClient, accountId: string) {
  const account = await tx.account.findUnique({ where: { id: accountId } });
  const participant = await tx.marketplaceParticipant.findUnique({ where: { accountId } });
  const roles =
    participant === null
      ? []
      : await tx.marketplaceRoleAssignment.findMany({
          where: { participantId: participant.id },
          orderBy: { role: "asc" },
        });
  const entitlements = await tx.accountEntitlement.findMany({
    where: { accountId, status: "ACTIVE" },
    orderBy: { capability: "asc" },
  });

  // Readiness is supplied from storage rather than the 0M.5 constant. It plays
  // no part in `canSubmitActivation` — 0M.1 §5 keeps submission independent of
  // the provider — but the subject must be truthful about it regardless.
  const paymentReadiness =
    participant === null ? undefined : await readReadinessIn(tx, participant.id);

  return toMarketplaceSubject({
    account,
    participant,
    roles,
    internalCapabilities: entitlements.map((e) => e.capability),
    paymentReadiness,
  });
}

async function readActivationSnapshotInTx(
  tx: Prisma.TransactionClient,
  participantId: string,
  activationId: string,
): Promise<ActivationSnapshot> {
  const participant = await tx.marketplaceParticipant.findUnique({ where: { id: participantId } });
  if (participant === null) throw new ParticipantNotFoundError();

  const row = await tx.participantActivation.findUnique({ where: { id: activationId } });
  if (row === null) throw new ActivationNotSubmittedError();

  return {
    participantStatus: participant.status as ParticipantStatus,
    activation: activationRowToRecord(row),
  };
}
