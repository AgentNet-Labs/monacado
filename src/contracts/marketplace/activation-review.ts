/**
 * Governed participant activation review contracts (Phase 0M.8).
 *
 * 0M.1 defined `activation:submit` and the `ParticipantActivation` audit record;
 * 0M.5 migrated the table and deliberately wrote no row into it. This is the
 * other half — what a governed review *decides*, on what evidence, and what a
 * decision is permitted to move.
 *
 * Six properties shape everything below:
 *
 *   1. **Submission and decision are separate acts.** 0M.1 §4.1 makes
 *      `UNDER_REVIEW` a state of its own, and `canSubmitActivation` is a
 *      capability distinct from deciding. Collapsing them would make "submitted"
 *      unobservable and leave the audit row with nothing to record between the
 *      two.
 *
 *   2. **Reviewer authority is a persisted internal entitlement, resolved from
 *      the database.** Activation review is a **Monacado internal operational
 *      authority**, not a marketplace participant role, so it lives in
 *      `ACCOUNT_CAPABILITIES` as `activation:review` and is evaluated by
 *      `canReviewParticipantActivation`. No caller asserts its own
 *      authorization: this module has no field through which one could, and the
 *      decide input carries only *which account is acting*, never *what it is
 *      allowed to do*.
 *
 *   3. **A participant can never review themselves into activation.** Not by an
 *      identifier check but by the authority model: the reviewing account must
 *      hold an explicitly granted `activation:review` entitlement, and holding a
 *      marketplace role, owning the participant, or owning the account confers
 *      nothing — `canReviewParticipantActivation` has no parameter capable of
 *      carrying any of them.
 *
 *   4. **`APPROVED` is the only decision that may move a participant to ACTIVE**,
 *      and it may do so only when every prerequisite holds — including payment
 *      readiness `ENABLED`, which Monacado cannot supply for itself.
 *
 *   5. **`RESTRICTED` and `SUSPENDED` are unreachable.** Both mean "admitted,
 *      some capability withheld" (0M.1 §4.1) and nothing yet expresses *which*
 *      capability — `capability.ts` tests only `status !== "ACTIVE"`. Writing
 *      either would record a status with no machine-readable meaning. The
 *      restriction scope belongs to `0M.R1`; this phase refuses both behind a
 *      phase gate, exactly as 0M.5 refused `ACTIVE`.
 *
 *   6. **Reason codes are classifications, never values.** The same rule
 *      `CAPABILITY_REASON_CODES` follows: no name, address, provider message, or
 *      identifier can appear in one, so a decision is safe to return from a
 *      future route without a filtering step someone can forget.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { AccountId } from "../account/account";
import { MARKETPLACE_PARTICIPANT_ID_RE } from "./identity";
import {
  ParticipantStatus,
  PaymentReadinessStatus,
  isActivatableRole,
  type MarketplaceRole,
  type RoleAssignmentStatus,
} from "./participant";
import { ActivationDecision } from "./participant-record";

const ParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "participantId must be mon:mpart:<opaque>");

/**
 * The reviewing internal account.
 *
 * **This is both the authorization principal and the audit actor**, deliberately
 * one value rather than two. The identity foundation already rules that "the
 * account id IS the actor id: one stable, opaque, durable identity that
 * authorization keys on" (`account-principal.ts`), and `AuthenticatedPrincipal`
 * types `actorId` as `AccountId` accordingly.
 *
 * Taking one identity is what binds the recorded actor to the authorized
 * reviewer by construction. Two supplied identities — one to authorize against,
 * one to write into the audit row — could disagree, and the audit trail would
 * then name someone other than whoever was actually checked.
 *
 * Opaque and stable. Never an email address and never a display name, which is
 * the rule the publication-remediation decision already follows.
 */
const ReviewerAccountId = AccountId;

// — Phase-writable participant statuses —

/**
 * The participant statuses Phase 0M.8 may write.
 *
 * 0M.5's `DRAFT_WRITABLE_PARTICIPANT_STATUSES` plus the two the governed review
 * exists to reach. `RESTRICTED` and `SUSPENDED` remain absent — see property 5
 * above. `CLOSED` stays writable for the same reason 0M.5 allowed it: closing is
 * the participant giving up, not Monacado ruling.
 */
export const ACTIVATION_PHASE_WRITABLE_PARTICIPANT_STATUSES = [
  "DRAFT",
  "PROFILE_INCOMPLETE",
  "PROFILE_COMPLETE",
  "UNDER_REVIEW",
  "ACTIVE",
  "CLOSED",
] as const satisfies readonly ParticipantStatus[];

export function isActivationPhaseWritableParticipantStatus(status: ParticipantStatus): boolean {
  return (
    ACTIVATION_PHASE_WRITABLE_PARTICIPANT_STATUSES as readonly ParticipantStatus[]
  ).includes(status);
}

/**
 * The statuses this phase refuses even though the 0M.1 transition table permits
 * them. Named so a test can assert the set rather than infer it.
 */
export const RESTRICTION_SCOPE_REQUIRED_STATUSES = [
  "RESTRICTED",
  "SUSPENDED",
] as const satisfies readonly ParticipantStatus[];

export function requiresRestrictionScope(status: ParticipantStatus): boolean {
  return (RESTRICTION_SCOPE_REQUIRED_STATUSES as readonly ParticipantStatus[]).includes(status);
}

// — Decision reason codes —

/**
 * The closed vocabulary a governed decision may record.
 *
 * `ParticipantActivation.decisionReasonCode` is `VARCHAR(64)` and 0M.1 §9 called
 * for "bounded decision reason codes" without enumerating them. This is that
 * enumeration. Each is a classification of *why the reviewer decided as they
 * did*; none carries a value, so the column cannot become a free-text note about
 * a person.
 */
export const ACTIVATION_DECISION_REASON_CODES = [
  // — APPROVED —
  /** Every prerequisite held and the reviewer admitted the participant. */
  "PREREQUISITES_SATISFIED",

  // — MORE_INFORMATION_REQUIRED —
  /** An onboarding section the reviewer needs is outstanding. */
  "PROFILE_SECTION_OUTSTANDING",
  /** The provider is still waiting on the participant. */
  "PROVIDER_ONBOARDING_INCOMPLETE",
  /** The reviewer requires verification beyond what has been supplied. */
  "ADDITIONAL_VERIFICATION_REQUESTED",

  // — REJECTED —
  /** The participant is not eligible for the marketplace under current policy. */
  "NOT_ELIGIBLE_UNDER_POLICY",
  /** The provider has declined or disabled the account. */
  "PROVIDER_DECLINED",
  /** The submission was withdrawn or duplicated. */
  "SUBMISSION_WITHDRAWN",
] as const;
export const ActivationDecisionReasonCode = z.enum(ACTIVATION_DECISION_REASON_CODES);
export type ActivationDecisionReasonCode = z.infer<typeof ActivationDecisionReasonCode>;

// — Approval prerequisite evaluation —

/**
 * The closed vocabulary of reasons an approval was refused.
 *
 * Deliberately separate from `CAPABILITY_REASON_CODES`: this answers "why may
 * this activation not be approved *now*", which is a reviewer-facing question,
 * and merging the two vocabularies would put review outcomes into every
 * capability denial a route returns.
 */
export const ACTIVATION_APPROVAL_REFUSAL_CODES = [
  /** The participant is not `UNDER_REVIEW`; there is no submitted review to decide. */
  "NO_ACTIVATION_UNDER_REVIEW",
  /** Required private profile sections or onboarding gates are outstanding. */
  "PROFILE_NOT_COMPLETE",
  /** No SELLER or PROMOTER role that could be activated is held. */
  "NO_ACTIVATABLE_ROLE",
  /** The provider has not reported `ENABLED`. */
  "PAYMENT_NOT_ENABLED",
  /** The provider has withheld capability on a previously enabled account. */
  "PAYMENT_RESTRICTED",
  /**
   * The current ACTIVE marketplace policy has not been accepted for every
   * audience the participant's roles require (Phase 1.3).
   *
   * A participant may not be admitted to trade without having undertaken the
   * terms that govern trading. Separate from `PROFILE_NOT_COMPLETE` because it
   * is a different remedy: one is finishing a form, the other is agreeing to
   * something.
   */
  "MARKETPLACE_POLICY_NOT_ACCEPTED",
  /**
   * No verified support address remains (Phase 1.3).
   *
   * An activated seller with no reachable support contact is a seller whose
   * buyers have nowhere to go. Fails closed: an address that once verified and
   * has since degraded counts as absent, because a bouncing address is not a
   * support contact.
   */
  "NO_VERIFIED_SUPPORT_CONTACT",
] as const;

/*
 * There is deliberately no `REVIEWER_NOT_AUTHORIZED` member.
 *
 * Reviewer authority is decided *before* this evaluator runs, by
 * `canReviewParticipantActivation` against persisted entitlement state, and it
 * carries its own bounded `INTERNAL_AUTHORIZATION_REASON_CODES`. Keeping the two
 * vocabularies apart is what stops an unauthorized caller from learning anything
 * about the participant: an authorization failure is answered without this
 * evaluator being reached at all, so it cannot leak "…and their profile is also
 * incomplete" alongside the refusal.
 */
export const ActivationApprovalRefusalCode = z.enum(ACTIVATION_APPROVAL_REFUSAL_CODES);
export type ActivationApprovalRefusalCode = z.infer<typeof ActivationApprovalRefusalCode>;

/**
 * Everything an approval decision may consider.
 *
 * An allow-list, like every other decision input in this track. There is no
 * field for a legal name, an address, a document, a provider message, a risk
 * score, or a restriction scope — so an approval rule cannot come to depend on
 * one, and the risk inputs `0M.R1` will own cannot be smuggled in early.
 */
export const ActivationApprovalInput = z.strictObject({
  participantStatus: ParticipantStatus,
  profileComplete: z.boolean(),
  roles: z
    .array(
      z.strictObject({
        role: z.enum(["SELLER", "PROMOTER", "BUYER"]),
        status: z.enum(["DRAFT", "PENDING_ACTIVATION", "ACTIVE", "SUSPENDED", "REVOKED"]),
      }),
    )
    .max(3),
  paymentReadiness: PaymentReadinessStatus,
  /**
   * Audiences whose acceptance of the ACTIVE policy is still outstanding
   * (Phase 1.3).
   *
   * Supplied rather than looked up: this evaluator is pure, and reading the
   * database from inside it would make the one function reviewers depend on
   * untestable without one.
   */
  outstandingPolicyAudiences: z.array(z.enum(["SELLER", "PROMOTER"])).max(2),
  /**
   * Whether a usable, verified support contact exists (Phase 1.3).
   *
   * `resolveEffectiveSupportContact`'s answer, carried in. The precedence rule
   * lives in exactly one place and this is not it.
   */
  hasVerifiedSupportContact: z.boolean(),
});
export type ActivationApprovalInput = z.infer<typeof ActivationApprovalInput>;

export const ActivationApprovalDecision = z
  .strictObject({
    decision: z.enum(["ALLOW", "DENY"]),
    refusalCodes: z
      .array(ActivationApprovalRefusalCode)
      .max(ACTIVATION_APPROVAL_REFUSAL_CODES.length),
  })
  .refine(
    (d) => (d.decision === "ALLOW" ? d.refusalCodes.length === 0 : d.refusalCodes.length > 0),
    "ALLOW carries no refusal codes; DENY carries at least one",
  );
export type ActivationApprovalDecision = z.infer<typeof ActivationApprovalDecision>;

/**
 * May this activation be approved?
 *
 * **Collects every refusal rather than returning the first.** A reviewer told
 * only "profile incomplete", who then fixes it and is told "payment not
 * enabled", has been made to discover the requirements one round trip at a time.
 * `canSubmitActivation` returns a single code because it answers a caller's
 * yes/no; this answers a reviewer's "what is outstanding".
 *
 * Three things it deliberately does not do:
 *
 *   - **It never decides reviewer authority.** That is settled first, against
 *     persisted entitlement state, and this evaluator is not reached unless it
 *     passed. It therefore has no parameter a caller could use to assert its own
 *     authorization, and an unauthorized caller learns nothing about the
 *     participant from a refusal.
 *   - **It never infers payment readiness.** `ENABLED` is required and is the
 *     provider's answer; there is no branch where Monacado's approval supplies
 *     it. That is the 0M.1 §5 separation, enforced here rather than described.
 *   - **It never consults risk.** No score, classification, reserve, or
 *     restriction scope is a parameter. Those are `0M.R1`, and a phase that
 *     accepted them "just as an optional input" would have implemented the
 *     boundary it was told not to cross.
 *   - **It never reads the database.** Phase 1.3 added policy acceptance and
 *     support-contact requirements as *supplied* inputs rather than lookups, so
 *     the one function reviewers depend on stays pure and testable without one.
 */
export function evaluateActivationApproval(input: ActivationApprovalInput): ActivationApprovalDecision {
  const parsed = ActivationApprovalInput.parse(input);
  const refusalCodes: ActivationApprovalRefusalCode[] = [];

  if (parsed.participantStatus !== "UNDER_REVIEW") {
    refusalCodes.push("NO_ACTIVATION_UNDER_REVIEW");
  }
  if (!parsed.profileComplete) {
    refusalCodes.push("PROFILE_NOT_COMPLETE");
  }

  const activatable = parsed.roles.filter(
    (r) => isActivatableRole(r.role as MarketplaceRole) && r.status !== "REVOKED",
  );
  if (activatable.length === 0) refusalCodes.push("NO_ACTIVATABLE_ROLE");

  if (parsed.paymentReadiness === "RESTRICTED") {
    refusalCodes.push("PAYMENT_RESTRICTED");
  } else if (parsed.paymentReadiness !== "ENABLED") {
    refusalCodes.push("PAYMENT_NOT_ENABLED");
  }

  /* Phase 1.3 — a participant may not be admitted to trade without having
     undertaken the terms that govern trading. */
  if (parsed.outstandingPolicyAudiences.length > 0) {
    refusalCodes.push("MARKETPLACE_POLICY_NOT_ACCEPTED");
  }

  /* Phase 1.3 — an activated seller with no reachable support contact is a
     seller whose buyers have nowhere to go. Fails closed. */
  if (!parsed.hasVerifiedSupportContact) {
    refusalCodes.push("NO_VERIFIED_SUPPORT_CONTACT");
  }

  return refusalCodes.length === 0
    ? { decision: "ALLOW", refusalCodes: [] }
    : { decision: "DENY", refusalCodes };
}

/**
 * The role statuses a submitted activation puts an activatable role into.
 *
 * `DRAFT → PENDING_ACTIVATION` is the 0M.1 role table's own meaning of
 * "included in a submitted activation"; approval then carries it to `ACTIVE`. A
 * role already `ACTIVE` or `SUSPENDED` is left alone — submission is not the
 * operation that restores a suspended role.
 */
export function roleStatusOnActivationSubmission(
  current: RoleAssignmentStatus,
): RoleAssignmentStatus | null {
  return current === "DRAFT" ? "PENDING_ACTIVATION" : null;
}

export function roleStatusOnActivationApproval(
  current: RoleAssignmentStatus,
): RoleAssignmentStatus | null {
  return current === "PENDING_ACTIVATION" ? "ACTIVE" : null;
}

// — Inputs —

export const SubmitParticipantActivationInput = z.strictObject({
  participantId: ParticipantId,
  submittedAt: z.iso.datetime(),
});
export type SubmitParticipantActivationInput = z.infer<typeof SubmitParticipantActivationInput>;

/**
 * One governed review decision.
 *
 * Carries **who is acting**, never **what they are allowed to do**: there is no
 * `reviewerAuthorization` field, and adding one would be the assertion this
 * design exists to refuse. The service resolves `reviewerAccountId` against
 * `AccountEntitlement` and evaluates `activation:review` before anything else.
 *
 * `decisionReasonCode` is required on every decision, including `APPROVED`: a
 * decision with no recorded reason is an audit row that says what happened and
 * not why, which is the half that matters at review time.
 */
export const DecideParticipantActivationInput = z.strictObject({
  participantId: ParticipantId,
  decision: ActivationDecision,
  decisionReasonCode: ActivationDecisionReasonCode,
  /** Authorization principal AND audit actor — one identity, never two. */
  reviewerAccountId: ReviewerAccountId,
  decidedAt: z.iso.datetime(),
});
export type DecideParticipantActivationInput = z.infer<typeof DecideParticipantActivationInput>;

/**
 * Which reason codes are coherent with which decision.
 *
 * Recorded as data so the pairing is assertable rather than living inside a
 * branch. An `APPROVED` decision reading `PROVIDER_DECLINED` would be an audit
 * record that contradicts itself.
 */
export const REASON_CODES_BY_DECISION: Record<
  ActivationDecision,
  readonly ActivationDecisionReasonCode[]
> = Object.freeze({
  APPROVED: ["PREREQUISITES_SATISFIED"],
  MORE_INFORMATION_REQUIRED: [
    "PROFILE_SECTION_OUTSTANDING",
    "PROVIDER_ONBOARDING_INCOMPLETE",
    "ADDITIONAL_VERIFICATION_REQUESTED",
  ],
  REJECTED: ["NOT_ELIGIBLE_UNDER_POLICY", "PROVIDER_DECLINED", "SUBMISSION_WITHDRAWN"],
});

export function isCoherentDecisionReason(
  decision: ActivationDecision,
  reasonCode: ActivationDecisionReasonCode,
): boolean {
  return REASON_CODES_BY_DECISION[decision].includes(reasonCode);
}

/**
 * The participant status a decided activation produces.
 *
 * `APPROVED` admits. `MORE_INFORMATION_REQUIRED` returns the participant to
 * `PROFILE_INCOMPLETE` — the 0M.1 table permits exactly that from
 * `UNDER_REVIEW`, and it is what "a reviewer asking for more information" means
 * without suspending anyone. `REJECTED` **leaves the participant where it is**:
 * the 0M.1 lifecycle offers no rejected state, `CLOSED` is terminal and means the
 * participant gave up, and inventing a closure on Monacado's behalf would end an
 * admission the participant may legitimately resubmit.
 */
export function participantStatusAfterDecision(
  decision: ActivationDecision,
): ParticipantStatus | null {
  switch (decision) {
    case "APPROVED":
      return "ACTIVE";
    case "MORE_INFORMATION_REQUIRED":
      return "PROFILE_INCOMPLETE";
    case "REJECTED":
      return null;
  }
}
