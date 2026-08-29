/**
 * Continued use as acceptance of an updated Marketplace Policy — SERVER ONLY.
 *
 * Monacado's governing rule has two halves. A participant joining now explicitly
 * accepts the version in force at onboarding. A participant ALREADY TRADING
 * accepts an updated version by continuing to use Monacado on or after the date
 * it takes effect, having been given notice of it — which is what 1.3.0's
 * `POLICY_CHANGES` section says in terms.
 *
 * This module answers the second half from records Monacado already keeps.
 *
 * ## No activity ledger was invented for this
 *
 * Every qualifying act below is an authoritative record that already exists and
 * already carries the participant and the instant: a source version the
 * participant authored, or a completed sale attributed to them. Building a
 * general "participant did something" table to answer one contractual question
 * would be a second, weaker record of facts the first-class ones already hold —
 * and it would drift.
 *
 * ## A qualifying act is the participant's OWN act
 *
 * A buyer's purchase is never evidence that a seller or a promoter accepted
 * anything. An Order counts only where the participant is the recorded SELLER or
 * PROMOTER of it — that is a completed sale they supplied or promoted, which is
 * unambiguously their continued use of the marketplace. Someone else's activity
 * proves nothing about them, and the query below cannot express otherwise
 * because participation is the join key.
 *
 * ## Before the effective date proves nothing
 *
 * Acts are counted strictly ON OR AFTER `effectiveFrom`. A participant who
 * traded busily under 1.2.0 and stopped the day 1.3.0 took effect has accepted
 * nothing, which is precisely the outcome the policy describes for a participant
 * who does not agree — and the reason the comparison is not merely "has this
 * participant ever traded".
 *
 * ## It evidences; it does not gate
 *
 * Nothing here denies commerce, and no caller may make it do so. Its output is
 * evidence that an acceptance already occurred by operation of the policy, which
 * a caller may record as a `CONTINUED_USE_AFTER_NOTICE` acceptance. Turning it
 * into a precondition would reintroduce the affirmative-reacceptance gate
 * Monacado does not have.
 */

import "../server-only";
import { getPrisma } from "../db/client";

export interface ContinuedUseDeps {
  db?: ReturnType<typeof getPrisma>;
}

/**
 * The authoritative records that establish a participant's continued use.
 *
 * Named so a test can assert the set rather than infer it, and so the reasoning
 * for each is reviewable rather than buried in a query.
 */
export const CONTINUED_USE_EVIDENCE_KINDS = [
  /** A completed sale the participant supplied. */
  "PAID_ORDER_AS_SELLER",
  /** A completed sale the participant promoted. */
  "PAID_ORDER_AS_PROMOTER",
  /** An Offer version the participant published as the supplying seller. */
  "OFFER_SOURCE_VERSION_AUTHORED",
  /** A Listing version the participant controlled. */
  "LISTING_SOURCE_VERSION_AUTHORED",
] as const;
export type ContinuedUseEvidenceKind = (typeof CONTINUED_USE_EVIDENCE_KINDS)[number];

/** Never admissible as evidence that a seller or promoter accepted terms. */
export const NEVER_CONTINUED_USE_EVIDENCE = [
  /* A buyer's purchase is the buyer's act. It says nothing about whether the
     seller or the promoter agreed to anything, and using it would let one
     participant's conduct bind another's. */
  "BUYER_PURCHASE",
  /* Being logged in is not using the marketplace, and a session is not a
     commercial act. */
  "ACCOUNT_SESSION",
  /* Monacado's own act, not the participant's. */
  "OPERATOR_ACTION",
  /* A notice is what Monacado sent, not what the participant then did. */
  "NOTICE_DELIVERY",
] as const;

export interface ContinuedUseFinding {
  participantId: string;
  policyVersion: string;
  effectiveFrom: string;
  /** `true` when at least one qualifying act occurred on or after the date. */
  established: boolean;
  /** The kinds observed. Empty when nothing qualifying happened. */
  evidence: ContinuedUseEvidenceKind[];
  /** The earliest qualifying act, which is when acceptance occurred. */
  firstQualifyingAt: string | null;
}

/**
 * Did this participant continue to use Monacado on or after the effective date?
 *
 * Deterministic: the same participant, version, and date over unchanged records
 * give the same answer, and the instant returned is the EARLIEST qualifying act
 * — the moment the policy says acceptance happened, not the moment anybody
 * asked the question.
 */
export async function evaluateContinuedUseAcceptance(
  input: { participantId: string; policyVersion: string; effectiveFrom: string },
  deps: ContinuedUseDeps = {},
): Promise<ContinuedUseFinding> {
  const db = deps.db ?? getPrisma();
  const from = new Date(input.effectiveFrom);
  const evidence: ContinuedUseEvidenceKind[] = [];
  const instants: Date[] = [];

  /* A completed sale the participant supplied. `lifecycle: PAID` and `paidAt`,
     the same pair every commercial measure in this repository counts on. */
  const asSeller = await db.order.findFirst({
    where: { sellerParticipantId: input.participantId, lifecycle: "PAID", paidAt: { gte: from } },
    orderBy: { paidAt: "asc" },
    select: { paidAt: true },
  });
  if (asSeller?.paidAt != null) {
    evidence.push("PAID_ORDER_AS_SELLER");
    instants.push(asSeller.paidAt);
  }

  /* A completed sale the participant promoted. A DIFFERENT act from supplying
     one, and recorded as such, because a promoter's continued use is their own
     and must not be read off the seller's. */
  const asPromoter = await db.order.findFirst({
    where: {
      promoterParticipantId: input.participantId,
      lifecycle: "PAID",
      paidAt: { gte: from },
    },
    orderBy: { paidAt: "asc" },
    select: { paidAt: true },
  });
  if (asPromoter?.paidAt != null) {
    evidence.push("PAID_ORDER_AS_PROMOTER");
    instants.push(asPromoter.paidAt);
  }

  const offer = await db.offerSourceRecordVersionRow.findFirst({
    where: { sellerParticipantId: input.participantId, recordedAt: { gte: from } },
    orderBy: { recordedAt: "asc" },
    select: { recordedAt: true },
  });
  if (offer !== null) {
    evidence.push("OFFER_SOURCE_VERSION_AUTHORED");
    instants.push(offer.recordedAt);
  }

  const listing = await db.listingSourceRecordVersionRow.findFirst({
    where: { controllingParticipantId: input.participantId, recordedAt: { gte: from } },
    orderBy: { recordedAt: "asc" },
    select: { recordedAt: true },
  });
  if (listing !== null) {
    evidence.push("LISTING_SOURCE_VERSION_AUTHORED");
    instants.push(listing.recordedAt);
  }

  instants.sort((a, b) => a.getTime() - b.getTime());
  return {
    participantId: input.participantId,
    policyVersion: input.policyVersion,
    effectiveFrom: input.effectiveFrom,
    established: evidence.length > 0,
    evidence,
    firstQualifyingAt: instants[0]?.toISOString() ?? null,
  };
}
