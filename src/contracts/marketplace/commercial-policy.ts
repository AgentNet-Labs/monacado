/**
 * Persisted versioned commercial policy (Phase 0M.R1).
 *
 * `MonacadoWholesaleAcquisitionPolicy` has been a *supplied value* since 0M.4A:
 * a strict Zod object the Listing economics consume, with no home in the
 * database and no way for a later transaction to prove which version produced
 * its numbers. This is that home.
 *
 * Six properties shape everything below:
 *
 *   1. **The database becomes authoritative; the Zod object stays the shape.**
 *      Nothing here re-derives economics. `toWholesaleAcquisitionPolicy` maps a
 *      persisted version onto the *existing committed contract*, and the
 *      existing calculators consume it unchanged. There is exactly one
 *      arithmetic implementation in this repository and 0M.R1 does not add a
 *      second.
 *
 *   2. **Stable identity and version identity are different things.**
 *      `CommercialPolicy` endures; `CommercialPolicyVersion` rows are immutable
 *      snapshots keyed by `(policyId, policyVersion)` — the same composite the
 *      Offer source versions use, so a future Order binds to an exact pair that
 *      cannot drift onto "whatever is current".
 *
 *   3. **History is never edited.** Changing economics mints a new version. A
 *      superseded version keeps its numbers, its effective instant, and its
 *      audit fields exactly as they were when transactions ran under it.
 *
 *   4. **Only derived-from-nothing values are stored.** The retained percentage,
 *      the fixed amount, the currency, and the rounding rule are policy *inputs*.
 *      The acquisition percentage, the retained amount for a given price, and
 *      every per-sale figure are **not stored** — they are deterministic
 *      functions of a price and a version, and a stored copy is a second answer
 *      that can disagree with the first.
 *
 *   5. **The current standard policy is one version, not an invariant.** 92.5%
 *      minus $1.00 is what `MONACADO_STANDARD_POLICY_V1` describes today. No
 *      rate is compiled into a calculator or a service — `0M.4A` already asserts
 *      that with a test, and this phase must not weaken it.
 *
 *   6. **Reason-free.** A policy version carries economics and provenance. It
 *      carries no participant, no product class, no risk score, and no
 *      applicability rule: per-transaction policy *selection* is `0M.R2`, and a
 *      column for it here would be that phase started early.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { AccountId } from "../account/account";
import { COMMERCIAL_POLICY_ID_RE } from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { MonacadoWholesaleAcquisitionPolicy } from "./listing-source";

// — Identity —

export const CommercialPolicyId = z
  .string()
  .regex(COMMERCIAL_POLICY_ID_RE, "policyId must be mon:cpol:<opaque>");
export type CommercialPolicyId = z.infer<typeof CommercialPolicyId>;

/**
 * The version label.
 *
 * Free-form within bounds and **opaque to every calculation**, exactly as the
 * committed contract already treats it. Monacado may version semantically
 * (`2.0.0`), sequentially (`7`), or by date; what matters is that the pair
 * `(policyId, policyVersion)` names one immutable set of numbers forever.
 */
export const CommercialPolicyVersionLabel = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => v.trim() === v, "policyVersion must not carry surrounding whitespace");
export type CommercialPolicyVersionLabel = z.infer<typeof CommercialPolicyVersionLabel>;

// — Lifecycle —

/**
 * A version's publication state, and the reason there is one.
 *
 * A policy version has to exist before it takes effect — someone drafts the next
 * rate, and it must not be selectable while they are still deciding it. Three
 * states, and no more:
 *
 *   - `DRAFT` — recorded, never selectable, never bound to a transaction.
 *   - `ACTIVE` — the version economics run under from `effectiveFrom` onward.
 *   - `RETIRED` — superseded. **Still bindable by historical reference**, which
 *     is the whole point: an Order that ran under it must stay reproducible.
 *
 * There is deliberately no `DELETED`. A version transactions ran under is not a
 * thing that may stop existing.
 */
export const COMMERCIAL_POLICY_VERSION_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export const CommercialPolicyVersionStatus = z.enum(COMMERCIAL_POLICY_VERSION_STATUSES);
export type CommercialPolicyVersionStatus = z.infer<typeof CommercialPolicyVersionStatus>;

/**
 * Valid version transitions, as an exhaustive table.
 *
 * `DRAFT → ACTIVE` is activation. `ACTIVE → RETIRED` is supersession. Nothing
 * returns: a retired version is not re-activated, because "the rate we used
 * until March, then again from June" is two versions and pretending otherwise
 * loses the gap. `DRAFT → RETIRED` abandons a draft that was never used.
 */
export const COMMERCIAL_POLICY_VERSION_TRANSITIONS: Record<
  CommercialPolicyVersionStatus,
  readonly CommercialPolicyVersionStatus[]
> = Object.freeze({
  DRAFT: ["ACTIVE", "RETIRED"],
  ACTIVE: ["RETIRED"],
  RETIRED: [],
});

export const INITIAL_COMMERCIAL_POLICY_VERSION_STATUS: CommercialPolicyVersionStatus = "DRAFT";

export function isValidCommercialPolicyVersionTransition(
  from: CommercialPolicyVersionStatus,
  to: CommercialPolicyVersionStatus,
): boolean {
  return COMMERCIAL_POLICY_VERSION_TRANSITIONS[from].includes(to);
}

/** A version an economics calculation may legitimately be run under. */
export function isBindableCommercialPolicyVersion(
  status: CommercialPolicyVersionStatus,
): boolean {
  // RETIRED included on purpose: a historical transaction reproduces from the
  // version it actually ran under, which by then is usually retired. Only DRAFT
  // is unbindable, because nothing ever ran under it.
  return status !== "DRAFT";
}

// — Records —

/**
 * The enduring policy identity.
 *
 * Carries a bounded operational label so an operator can tell two policies apart
 * in a list. The label is **never** an input to a calculation and never appears
 * in a capsule; economics read the id and the version and nothing else.
 */
export const CommercialPolicyRecord = z.strictObject({
  policyId: CommercialPolicyId,
  /** Operational display only. Never authoritative, never published. */
  label: z.string().min(1).max(191),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CommercialPolicyRecord = z.infer<typeof CommercialPolicyRecord>;

/**
 * One immutable version of one policy.
 *
 * The economics fields are exactly `MonacadoWholesaleAcquisitionPolicy`'s, in
 * the same units and with the same bounds — basis points for the percentage,
 * minor units for the fixed amount, an explicit currency, and the rounding rule
 * carried on the policy rather than inherited from whichever calculator runs.
 *
 * What is **absent** is as deliberate: no acquisition percentage (it is
 * `10000 − retainedPercentageBasisPoints`), no retained amount (it depends on a
 * price), no per-sale figure of any kind, and no applicability rule.
 */
export const CommercialPolicyVersionRecord = z.strictObject({
  policyId: CommercialPolicyId,
  policyVersion: CommercialPolicyVersionLabel,
  status: CommercialPolicyVersionStatus,

  // — Economics, identical in shape to the committed contract —
  currency: CurrencyCode,
  retainedPercentageBasisPoints: z.int().min(0).max(10_000),
  retainedFixedAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  roundingPolicy: z.literal("HALF_UP_TO_MINOR_UNIT"),

  /**
   * When this version's economics begin to apply.
   *
   * Supplied, never a clock read, matching every instant in this repository.
   * Two ACTIVE versions of one policy may never share an `effectiveFrom` —
   * "which one applied at that instant" must have exactly one answer.
   */
  effectiveFrom: z.iso.datetime(),

  /** Who recorded it, as the durable internal Account identity (0M.8's rule). */
  recordedByAccountId: AccountId,
  recordedAt: z.iso.datetime(),

  /** Set when the version leaves ACTIVE. `null` while it stands. */
  retiredAt: z.iso.datetime().nullable(),
  retiredByAccountId: AccountId.nullable(),
});
export type CommercialPolicyVersionRecord = z.infer<typeof CommercialPolicyVersionRecord>;

// — Reconstruction —

/**
 * Rebuild the committed `MonacadoWholesaleAcquisitionPolicy` from a persisted
 * version.
 *
 * **The only bridge between storage and the economics**, and deliberately a
 * strict one: it emits the committed contract's own `strictObject`, so a field
 * this phase might add to storage cannot silently leak into a calculation.
 *
 * A `DRAFT` version is refused. Nothing ever ran under it, so producing a
 * runnable policy from one would let an unapproved rate price a sale.
 */
export function toWholesaleAcquisitionPolicy(
  version: CommercialPolicyVersionRecord,
): MonacadoWholesaleAcquisitionPolicy {
  const parsed = CommercialPolicyVersionRecord.parse(version);
  if (!isBindableCommercialPolicyVersion(parsed.status)) {
    throw new CommercialPolicyError(
      "POLICY_VERSION_NOT_BINDABLE",
      "a DRAFT policy version may not be used for economics",
    );
  }
  return MonacadoWholesaleAcquisitionPolicy.parse({
    policyId: parsed.policyId,
    policyVersion: parsed.policyVersion,
    currency: parsed.currency,
    retainedPercentageBasisPoints: parsed.retainedPercentageBasisPoints,
    retainedFixedAmountMinorUnits: parsed.retainedFixedAmountMinorUnits,
    roundingPolicy: parsed.roundingPolicy,
  });
}

export class CommercialPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CommercialPolicyError";
    this.code = code;
  }
}

// — Inputs —

export const CreateCommercialPolicyInput = z.strictObject({
  label: z.string().min(1).max(191),
  now: z.iso.datetime(),
});
export type CreateCommercialPolicyInput = z.infer<typeof CreateCommercialPolicyInput>;

/**
 * Record one new immutable version.
 *
 * Created `DRAFT` and at no other status — there is no `status` parameter, so a
 * caller cannot mint an already-effective rate in one step without the explicit
 * activation that supersedes whatever came before.
 */
export const RecordCommercialPolicyVersionInput = z.strictObject({
  policyId: CommercialPolicyId,
  policyVersion: CommercialPolicyVersionLabel,
  currency: CurrencyCode,
  retainedPercentageBasisPoints: z.int().min(0).max(10_000),
  retainedFixedAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  roundingPolicy: z.literal("HALF_UP_TO_MINOR_UNIT"),
  effectiveFrom: z.iso.datetime(),
  recordedByAccountId: AccountId,
  recordedAt: z.iso.datetime(),
});
export type RecordCommercialPolicyVersionInput = z.infer<
  typeof RecordCommercialPolicyVersionInput
>;

/**
 * Activate a drafted version, retiring whichever version it supersedes.
 *
 * One operation rather than two, because the intermediate state — two ACTIVE
 * versions of one policy — is exactly the ambiguity the effective lookup must
 * never encounter.
 */
export const ActivateCommercialPolicyVersionInput = z.strictObject({
  policyId: CommercialPolicyId,
  policyVersion: CommercialPolicyVersionLabel,
  activatedByAccountId: AccountId,
  activatedAt: z.iso.datetime(),
});
export type ActivateCommercialPolicyVersionInput = z.infer<
  typeof ActivateCommercialPolicyVersionInput
>;

// — The current standard policy, as data —

/**
 * The economics of the policy Monacado operates today
 * (`MONACADO_MOR_BUSINESS_MODEL.md` §B): 7.5% + $1.00 retained, so
 * 92.5% − $1.00 acquired.
 *
 * **A described version, not an invariant and not a default.** No service reads
 * it, no calculation falls back to it, and nothing seeds it automatically — it
 * exists so an explicit bootstrap and a test can name the same numbers once
 * instead of twice. Changing Monacado's rate means recording a *new version*
 * through the service, never editing this constant.
 *
 * There is no `policyId` here on purpose: the identity is minted when the policy
 * is created, so this constant cannot become a hard-coded policy reference.
 */
export const MONACADO_STANDARD_POLICY_V1 = Object.freeze({
  policyVersion: "1",
  currency: "USD",
  /** 7.5% */
  retainedPercentageBasisPoints: 750,
  /** $1.00 */
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
} as const);

// — Never on a policy version —

/**
 * Named as never-persistable, and not admissible through any input above.
 *
 * The first four are `0M.R2`: per-transaction, per-participant, and per-class
 * policy *selection* is that phase's whole subject, and a column for it here
 * would be that phase started early. The rest are derived values that must stay
 * derived.
 */
export const NEVER_ON_COMMERCIAL_POLICY_VERSION = [
  "participantId",
  "productClass",
  "riskScore",
  "riskClassification",
  "applicabilityRule",
  "overrideOf",
  "acquisitionPercentageBasisPoints",
  "retainedAmountMinorUnits",
  "acquisitionAmountMinorUnits",
  "commercialRetailPriceMinorUnits",
  "sellerProceedsMinorUnits",
  "promoterNetProceedsMinorUnits",
  "taxMinorUnits",
  "shippingMinorUnits",
] as const;
