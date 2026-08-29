/**
 * Governed participant restrictions (Phase 0M.R1).
 *
 * The machine-readable meaning `RESTRICTED` has been missing. 0M.1 §4.1 defines
 * the status as "admitted, some capability withheld pending a cure", and until
 * now nothing expressed **which** capability — `capability.ts` tests only
 * `status !== "ACTIVE"`. 0M.8 therefore refused to write the status at all,
 * behind `RestrictionScopeNotAvailableInPhaseError`. This is the scope that
 * error was waiting for.
 *
 * Six properties shape everything below:
 *
 *   1. **The scope vocabulary is the capability vocabulary.** A restriction
 *      names a member of `MARKETPLACE_CAPABILITIES` — the closed set of things a
 *      participant may do, already committed in 0M.1. Minting a parallel
 *      `STOREFRONT_ACTIVATION` / `OFFER_PUBLICATION` vocabulary would be two
 *      names for one concept, and the day they disagreed the restriction would
 *      be the one that was wrong.
 *
 *   2. **Only commerce is restrictable.** Drafting capabilities are excluded,
 *      because 0M.1 already rules that a restriction withholds *commerce*, not
 *      the ability to correct the work that caused it — `RESTRICTED` is a member
 *      of `DRAFTING_PARTICIPANT_STATUSES` precisely so a restricted participant
 *      can fix things. `activation:submit` is excluded for the same reason: a
 *      participant must be able to answer a restriction.
 *
 *   3. **Reasons are bounded classifications.** No underwriting payload, no
 *      provider rejection message, no KYC/KYB document, no investigator note, no
 *      external error text. A reason code says what *kind* of problem this is,
 *      at the granularity an operator acts on. Richer explanation, if it is ever
 *      needed, belongs in a separately governed internal record — never in the
 *      field that controls semantics.
 *
 *   4. **History is never destroyed.** Lifting a restriction is a state change
 *      with its own instant and actor, not a delete. A participant's restriction
 *      history is the evidence behind every status they have held.
 *
 *   5. **A restriction is Monacado's governed decision, never an observation.**
 *      A provider reporting `DISABLED` creates no restriction. Provider state is
 *      an external fact on `ParticipantPaymentAccount`; a restriction is an act
 *      Monacado performed, with an actor and a reason.
 *
 *   6. **This is not a risk engine.** No score, no reserve, no cap, no velocity
 *      window, no transaction reference, no expiry. `0M.R2` owns all of it.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { AccountId } from "../account/account";
import {
  MARKETPLACE_PARTICIPANT_ID_RE,
  PARTICIPANT_RESTRICTION_ID_RE,
} from "./identity";
import { MARKETPLACE_CAPABILITIES, MarketplaceCapability } from "./capability";
import type { ParticipantStatus } from "./participant";

// — Identity —

export const ParticipantRestrictionId = z
  .string()
  .regex(PARTICIPANT_RESTRICTION_ID_RE, "restrictionId must be mon:prst:<opaque>");
export type ParticipantRestrictionId = z.infer<typeof ParticipantRestrictionId>;

const ParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "participantId must be mon:mpart:<opaque>");

// — Scope —

/**
 * The capabilities a restriction may withhold.
 *
 * A strict subset of the committed `MARKETPLACE_CAPABILITIES`, and the omissions
 * carry the ruling:
 *
 *   - **Drafting is never restricted** (`storefront:draft:create`,
 *     `product:draft:create`, both listing-draft capabilities). 0M.1 puts
 *     `RESTRICTED` inside `DRAFTING_PARTICIPANT_STATUSES` deliberately: a
 *     restriction withholds commerce, not the ability to correct the work that
 *     caused it.
 *   - **`activation:submit` is never restricted.** A participant must be able to
 *     answer a restriction by resubmitting; restricting the answer would make
 *     the restriction unappealable.
 *   - **Capsule-publication capabilities are never restricted.**
 *     `review:*:capsule:publish` answers "does a stored authority back *this*
 *     capsule action", which is a property of a submission rather than a
 *     standing of a participant. Withholding it here would put two unrelated
 *     gates on one decision.
 *
 * What remains is exactly the commerce set: taking a storefront live, publishing
 * an Offer, receiving a payout, accruing commission, and submitting reviews.
 */
export const RESTRICTABLE_CAPABILITIES = [
  "storefront:activate",
  "offer:publish",
  "payout:receive",
  "commission:accrue",
  "review:product:submit",
  "review:seller:submit",
] as const satisfies readonly MarketplaceCapability[];

export const RestrictionScope = z.enum(RESTRICTABLE_CAPABILITIES);
export type RestrictionScope = z.infer<typeof RestrictionScope>;

export function isRestrictableCapability(capability: string): boolean {
  return (RESTRICTABLE_CAPABILITIES as readonly string[]).includes(capability);
}

/** The capabilities deliberately outside the vocabulary. Asserted by a test. */
export const NEVER_RESTRICTABLE_CAPABILITIES = MARKETPLACE_CAPABILITIES.filter(
  (c) => !isRestrictableCapability(c),
);

// — Reason —

/**
 * The closed reason vocabulary — five members, and no more than the current
 * architecture justifies.
 *
 * Each is a *classification of the problem*, at the granularity an operator acts
 * on. None carries a value: no name, address, provider message, document
 * reference, score, or free text can appear in one, so a restriction is safe to
 * surface in an interface and safe to log.
 */
export const RESTRICTION_REASON_CODES = [
  /** Monacado must complete its own review before commerce resumes. */
  "UNDERWRITING_REVIEW_REQUIRED",
  /** The participant does not currently meet a marketplace eligibility policy. */
  "POLICY_ELIGIBILITY_RESTRICTION",
  /**
   * A payment-provider requirement is outstanding, and Monacado has *decided*
   * to withhold commerce over it. The provider's own state never creates this
   * on its own — see the module header, property 5.
   */
  "PROVIDER_REQUIREMENT_UNRESOLVED",
  /** The participant's commercial activity is restricted under commercial terms. */
  "COMMERCIAL_ELIGIBILITY_RESTRICTION",
  /** An operator imposed this deliberately outside the categories above. */
  "MANUAL_OPERATIONAL_RESTRICTION",

  // — Phase 1.14: risk-derived grounds. —
  //
  // ADDITIVE, and named for the MEASUREMENT rather than for a conclusion about
  // the participant. `EXCESSIVE_CHARGEBACKS` was considered and rejected:
  // "excessive" is a judgement, and `ELEVATED` is the word Phase 1.13 already
  // chose for the same observation, so a recommendation and the act that follows
  // it read as one story rather than two.
  //
  // None of these establishes misconduct. An elevated rate is as consistent with
  // a seller being defrauded as with anything they did, which is why no member
  // here contains the word fraud — and a test walks the list to prove it.

  /** Finalized chargebacks are elevated against the governed review threshold. */
  "CHARGEBACK_RATE_ELEVATED",
  /** Completed refunds are elevated against the governed review threshold. */
  "REFUND_RATE_ELEVATED",
  /**
   * Adverse outcomes are concentrated in one seller-and-promoter relationship
   * rather than spread across the participant's activity. Evidence about the
   * RELATIONSHIP; it does not by itself make either party answerable for the
   * other's conduct.
   */
  "PROMOTER_CHANNEL_ANOMALY",
  /**
   * Volume, value, ticket size, or geography moved sharply against the
   * participant's own recent history. Observational, and deliberately vague about
   * cause, because the measurement is.
   */
  "UNUSUAL_TRANSACTION_ACTIVITY",
  /**
   * Monacado asked the participant for information and it has not arrived.
   *
   * "Outstanding" rather than "not provided": mail goes missing, and a code that
   * reads as refusal would be a finding this record cannot support. Distinct from
   * `UNDERWRITING_REVIEW_REQUIRED`, which says MONACADO is the one still working.
   */
  "REQUESTED_INFORMATION_OUTSTANDING",
] as const;
export const RestrictionReasonCode = z.enum(RESTRICTION_REASON_CODES);
export type RestrictionReasonCode = z.infer<typeof RestrictionReasonCode>;

/**
 * Why a restriction was LIFTED, as its own closed vocabulary (Phase 1.14).
 *
 * Separate from the imposition vocabulary, correcting a real defect. Until now
 * `liftedReasonCode` was typed as a `RestrictionReasonCode` — the five
 * *why-we-restricted* codes — so a lift could record who and when but had no
 * honest way to say why. There was no code meaning "the requirement was met", no
 * code meaning "we reconsidered and reversed it", and no code meaning "we should
 * not have imposed it". A lift recorded as `UNDERWRITING_REVIEW_REQUIRED` reads
 * as though the restriction were still warranted.
 *
 * "Why we restricted" and "why we stopped" are different questions, and one
 * vocabulary answering both answers neither.
 *
 * The column is already `VARCHAR(48)` and nullable, so this is a contracts-only
 * correction with no migration.
 */
export const RESTRICTION_LIFT_REASON_CODES = [
  /** The condition behind the restriction is satisfied. */
  "REQUIREMENT_SATISFIED",
  /** The participant again meets the eligibility policy that was withheld. */
  "ELIGIBILITY_RESTORED",
  /** The outstanding payment-provider requirement has been resolved. */
  "PROVIDER_REQUIREMENT_RESOLVED",
  /** Monacado reconsidered the decision and reversed it. */
  "LIFTED_ON_RECONSIDERATION",
  /**
   * The restriction should not have been imposed. Recorded plainly rather than
   * dressed as a cure: a marketplace that cannot say it got one wrong will
   * eventually record every reversal as though the participant had changed.
   */
  "IMPOSED_IN_ERROR",
  /** Replaced by a narrower restriction, which is a lift plus a new imposition. */
  "SUPERSEDED_BY_A_NARROWER_RESTRICTION",
] as const;
export const RestrictionLiftReasonCode = z.enum(RESTRICTION_LIFT_REASON_CODES);
export type RestrictionLiftReasonCode = z.infer<typeof RestrictionLiftReasonCode>;

/**
 * The reason codes that make a restriction a RISK decision (Phase 1.14).
 *
 * Named so a test can assert the set rather than infer it, and so the governance
 * gate has one place to read.
 *
 * WHY THE GATE IS SCOPED RATHER THAN TOTAL. `participant:restrict` predates
 * participant-level risk terms and is governed as an operational authority:
 * withholding commerce because underwriting is incomplete, or because a
 * payment-provider requirement is outstanding, was always within Monacado's
 * operational remit, and Phase 1.13's recorded gap does not reach it. What
 * genuinely needed new terms was restricting a participant BECAUSE OF WHAT THE
 * RISK ANALYTICS SAID — `RESTRICTING_SELLING_CAPABILITY_ON_RISK_GROUNDS`, in the
 * words of the constant that recorded the gap. This is that set.
 *
 * Gating every restriction would have been the easier line to write and the
 * wrong one: it would have made a deployment unable to complete underwriting
 * until it had activated a policy version about risk monitoring, which is an
 * authority nobody claimed was missing.
 */
export const RISK_DERIVED_RESTRICTION_REASON_CODES = [
  "CHARGEBACK_RATE_ELEVATED",
  "REFUND_RATE_ELEVATED",
  "PROMOTER_CHANNEL_ANOMALY",
  "UNUSUAL_TRANSACTION_ACTIVITY",
  "REQUESTED_INFORMATION_OUTSTANDING",
] as const satisfies readonly RestrictionReasonCode[];

// — Lifecycle —

/**
 * Two states, and no delete.
 *
 * `LIFTED` is terminal: re-imposing is a new restriction with its own instant
 * and actor, so "restricted, cleared, restricted again" reads as two events
 * rather than one row that changed its mind. There is no expiry — a restriction
 * that lapsed on its own would be a policy decision nothing in this phase makes.
 */
export const RESTRICTION_STATUSES = ["ACTIVE", "LIFTED"] as const;
export const RestrictionStatus = z.enum(RESTRICTION_STATUSES);
export type RestrictionStatus = z.infer<typeof RestrictionStatus>;

export const INITIAL_RESTRICTION_STATUS: RestrictionStatus = "ACTIVE";

// — Record —

/**
 * One governed restriction on one participant.
 *
 * Note what has no field: a risk score, a classification, a reserve amount, a
 * payout hold, a transaction cap, a velocity window, an order or payment
 * reference, an expiry, a provider message, a document, or any free text. All of
 * it is `0M.R2` or later, and a `strictObject` is what keeps it out.
 */
export const ParticipantRestrictionRecord = z.strictObject({
  restrictionId: ParticipantRestrictionId,
  participantId: ParticipantId,
  scope: RestrictionScope,
  reasonCode: RestrictionReasonCode,
  status: RestrictionStatus,

  imposedAt: z.iso.datetime(),
  /** The durable internal Account identity, per 0M.8's settled actor rule. */
  imposedByAccountId: AccountId,

  liftedAt: z.iso.datetime().nullable(),
  liftedByAccountId: AccountId.nullable(),
  /** Why it was lifted. Bounded, from the same closed vocabulary. */
  /**
   * Why it was lifted, from the LIFT vocabulary (Phase 1.14).
   *
   * Previously typed as a `RestrictionReasonCode`, which meant a lift could only
   * be recorded as one of the five reasons a restriction is IMPOSED — so "we
   * lifted it because underwriting review is required" was the closest a record
   * could get to saying the requirement had been met.
   */
  liftedReasonCode: RestrictionLiftReasonCode.nullable(),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ParticipantRestrictionRecord = z.infer<typeof ParticipantRestrictionRecord>;

// — Status reconciliation —

/**
 * What a participant's admission status should be, given its active restriction
 * count.
 *
 * **Deterministic and deliberately narrow.** Two answers only, and `null` — "no
 * status change is warranted" — for everything else, because inventing a
 * transition the 0M.1 table does not define would be a lifecycle change made
 * inside a risk phase.
 *
 *   - An `ACTIVE` participant acquiring its **first** active restriction becomes
 *     `RESTRICTED`. That is the transition 0M.1 already permits and the one the
 *     status exists for.
 *   - A `RESTRICTED` participant losing its **last** active restriction becomes
 *     `ACTIVE` again — the status has no remaining evidence, and leaving it
 *     would be a restriction nobody can enumerate, which is the exact condition
 *     0M.8 refused to create.
 *
 * Everything else returns `null`:
 *
 *   - A `DRAFT`, `PROFILE_INCOMPLETE`, `PROFILE_COMPLETE`, or `UNDER_REVIEW`
 *     participant may hold restrictions — a policy problem found during
 *     onboarding is real — but none of those transitions to `RESTRICTED` exists
 *     in the 0M.1 table, and the restriction record stands as evidence without
 *     one. When they later reach `ACTIVE` through the governed review, the
 *     restriction is already there to be reckoned with.
 *   - A `CLOSED` or `SUSPENDED` participant is not moved by this phase.
 *   - Restrictions two through N change nothing; the status is already right.
 *
 * **It never bypasses activation prerequisites.** Returning to `ACTIVE` here is
 * only reachable *from* `RESTRICTED`, which is only reachable *from* `ACTIVE` —
 * so the participant was already admitted through a governed activation review,
 * and this restores what a restriction withheld rather than granting admission.
 * A participant that never activated cannot reach `ACTIVE` by this path.
 */
export function reconcileParticipantStatusForRestrictions(input: {
  currentStatus: ParticipantStatus;
  activeRestrictionCount: number;
}): ParticipantStatus | null {
  const { currentStatus, activeRestrictionCount } = input;

  if (currentStatus === "ACTIVE" && activeRestrictionCount > 0) return "RESTRICTED";
  if (currentStatus === "RESTRICTED" && activeRestrictionCount === 0) return "ACTIVE";
  return null;
}

/**
 * May `RESTRICTED` be written for this participant at all?
 *
 * The invariant 0M.8 could not express: **a participant is never `RESTRICTED`
 * without at least one active machine-readable restriction.** Checked by the
 * service on every write, so the status and its evidence cannot come apart.
 */
export function restrictedStatusIsSupported(activeRestrictionCount: number): boolean {
  return activeRestrictionCount > 0;
}

// — Inputs —

export const ImposeParticipantRestrictionInput = z.strictObject({
  participantId: ParticipantId,
  scope: RestrictionScope,
  reasonCode: RestrictionReasonCode,
  /** The acting internal account — authorization principal AND audit actor. */
  actingAccountId: AccountId,
  imposedAt: z.iso.datetime(),
  /**
   * The Staff risk review this is imposed on the strength of, when there is one
   * (Phase 1.14).
   *
   * A REFERENCE TO A JUDGEMENT, NEVER TO A NUMBER, and never a trigger: nothing
   * reads a review to decide that a restriction should exist. It is supplied by
   * the person acting, so the consequence names its basis and an appeal months
   * later can be answered from the record.
   *
   * OPTIONAL, and its absence covers two ordinary cases: a restriction imposed on
   * operational grounds that never involved risk analytics, and an emergency act
   * taken before a review could be completed. What its absence never waives is
   * authorization.
   */
  riskReviewId: z.string().min(1).max(191).nullable().default(null),
});
export type ImposeParticipantRestrictionInput = z.infer<
  typeof ImposeParticipantRestrictionInput
>;


export const LiftParticipantRestrictionInput = z.strictObject({
  restrictionId: ParticipantRestrictionId,
  reasonCode: RestrictionLiftReasonCode,
  actingAccountId: AccountId,
  liftedAt: z.iso.datetime(),
});
export type LiftParticipantRestrictionInput = z.infer<typeof LiftParticipantRestrictionInput>;

// — Never on a restriction —

/**
 * Named as never-persistable, and not admissible through any input above.
 *
 * Every input is a `strictObject`, so each arrives as an unknown key and fails
 * validation. The first group is private provider and underwriting data; the
 * second is `0M.R2`'s subject matter.
 */
export const NEVER_ON_PARTICIPANT_RESTRICTION = [
  // private provider / underwriting data
  "kycPayload",
  "kybPayload",
  "underwritingData",
  "providerErrorPayload",
  "providerMessage",
  "rejectionText",
  "documentUrl",
  "identityDocument",
  "legalName",
  "address",
  "taxId",
  "ssn",
  "dateOfBirth",
  "investigatorNote",
  "internalNote",
  "freeTextReason",
  "stackTrace",
  // 0M.R2
  "riskScore",
  "riskClassification",
  "reserveAmountMinorUnits",
  "payoutHold",
  "transactionCapMinorUnits",
  "velocityWindowSeconds",
  "orderId",
  "paymentId",
  "expiresAt",
] as const;
