/**
 * Private dispute capsule projection (Phase 1.11).
 *
 * The fourth private capsule, following `TaxTransaction` (1.7), `Refund`, and
 * `TaxReversal` (1.9), and built to their pattern exactly.
 *
 * ## Why this is consistent with the ADR, which names disputes
 *
 * `CDD_ARCHITECTURE_DECISIONS` §1 lists disputes among the records that "remain
 * relational-first and are not canonical entity capsules", and adds that
 * separate event capsules are "not authorized yet". This projection does not
 * contradict either sentence, and the distinction is the whole point:
 *
 * - The **`TransactionDispute` row is the authoritative record.** It is not
 *   replaced, shadowed, or reconstructed from this capsule.
 * - This is a **read-only projection of** that row, exactly as the refund
 *   capsule is of `OrderRefund` — which is likewise a relational-first financial
 *   record that 1.9 projected privately without anybody treating it as the
 *   canonical Refund entity.
 * - **Projection runs one way.** Nothing here writes back, creates provenance,
 *   or authorizes a business change.
 *
 * ## Private, and the disclosure question is the sharpest of the four
 *
 * A public dispute capsule would publish, per sale, that a cardholder went to
 * their bank rather than to the seller. That is a statement about a seller's
 * dispute rate — which card networks treat as confidential merchant performance
 * data — and, on a marketplace where a Listing has one Product and one seller,
 * an inference about an individual buyer's conduct toward a named merchant.
 * Neither party agreed to either disclosure.
 *
 * ## Nothing is published
 *
 * No Node is registered, no capsule id is minted, no Registrar is contacted, and
 * **no outbox row is written** — the claim `REFUND_CAPSULE_PUBLICATION_DISPOSITION`
 * makes for refunds, kept true here.
 */

import { z } from "zod";
import { CandidateMetadata, SemVer } from "../capsule/envelope";
import { AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF } from "../ontology/commerce.context";
import { capsuleVisibilityFor, CapsuleVisibility } from "../capsule/visibility";
import { canonicalHash } from "../integrity/hash";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import {
  DisputeEconomicEffect,
  DisputeFundsState,
  DisputeReasonCode,
  DisputeStatus,
  DisputeTaxConsequence,
  TransactionDisputeRecord,
} from "./transaction-dispute";

export const DISPUTE_TYPE = "Dispute" as const;

export class DisputeProjectionError extends Error {
  readonly reason: "invalid-source-record" | "invalid-context";
  readonly paths: readonly string[];
  constructor(reason: "invalid-source-record" | "invalid-context", paths: readonly string[]) {
    super("A dispute capsule could not be projected");
    this.name = "DisputeProjectionError";
    this.reason = reason;
    this.paths = paths;
  }
}

/**
 * What a dispute capsule carries.
 *
 * References and bounded codes. **No buyer, no evidence, no provider text, and
 * no raw payload** — the same list `NEVER_ON_TRANSACTION_DISPUTE` refuses on the
 * record itself, refused again here by `strictObject`.
 *
 * The disputed amount IS projected, unlike in operator summaries. The difference
 * is the audience: a private capsule is read by reconciliation and audit
 * workflows that need the figure to do their job, whereas a status summary is
 * rendered on screens and pasted into chat.
 */
export const DisputeCapsuleData = z.strictObject({
  disputeRef: z.string().min(1).max(191),
  /** Null when the dispute could not be attributed to a sale. */
  orderRef: z.string().min(1).max(191).nullable(),
  economicSnapshotRef: z.string().min(1).max(191).nullable(),

  provider: z.literal("STRIPE"),
  providerMode: z.literal("TEST"),
  providerDisputeRef: z.string().min(1).max(191),
  originalProviderTransactionRef: z.string().min(1).max(191),

  currency: CurrencyCode,
  disputedAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  reasonCode: DisputeReasonCode,

  status: DisputeStatus,
  fundsState: DisputeFundsState,
  economicEffect: DisputeEconomicEffect,
  taxConsequence: DisputeTaxConsequence,

  /** Posture only. Never the evidence, never a file reference. */
  responsePermitted: z.boolean(),
  evidenceDueBy: z.iso.datetime().nullable(),
  evidenceSubmissionCount: z.int().min(0),

  openedAt: z.iso.datetime(),
  fundsWithdrawnAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),

  accountingReversalRef: z.string().min(1).max(191).nullable(),
});
export type DisputeCapsuleData = z.infer<typeof DisputeCapsuleData>;

const DisputeType = z.literal(DISPUTE_TYPE);

/**
 * A private capsule candidate.
 *
 * `CandidateMetadata` rather than `PublishedMetadata`: there is no
 * Registrar-issued Node ID, no capsule ID, no Publisher, and no `publishedAt`,
 * because nothing is published. Fabricating any of them would assert a
 * publication that never happened.
 */
export const DisputeCapsuleCandidate = z.strictObject({
  "@context": z.array(z.string().min(1)).min(1),
  "@type": DisputeType,
  /** `PRIVATE`, by governance. See `capsule/visibility.ts`. */
  visibility: CapsuleVisibility,
  metadata: CandidateMetadata,
  data: DisputeCapsuleData,
});
export type DisputeCapsuleCandidate = z.infer<typeof DisputeCapsuleCandidate>;

export const DisputeProjectionContext = z.strictObject({
  generatedAt: z.iso.datetime(),
  capsuleSemver: SemVer,
  mappingVersion: z.string().min(1).max(191),
});
export type DisputeProjectionContext = z.infer<typeof DisputeProjectionContext>;

export const DEFAULT_DISPUTE_CAPSULE_SEMVER = "1.0.0";

/**
 * Project one authoritative dispute into its private capsule candidate.
 *
 * **Deterministic**: the same record and context always produce the same
 * capsule, and therefore the same hash.
 *
 * Fails closed. An invalid record or context produces an error, never a
 * best-effort capsule — projection repairs nothing, and a record that cannot be
 * projected is one somebody must fix at the source.
 *
 * An open or unattributed dispute is deliberately projectable, on 1.7's
 * reasoning: an unresolved dispute is exactly what a reconciliation agent needs
 * to reason about, and refusing to project it would hide the rows that matter
 * most.
 */
export function projectDisputeCapsule(
  record: unknown,
  context: unknown,
): DisputeCapsuleCandidate {
  const parsedRecord = TransactionDisputeRecord.safeParse(record);
  if (!parsedRecord.success) {
    throw new DisputeProjectionError(
      "invalid-source-record",
      Array.from(new Set(parsedRecord.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const parsedContext = DisputeProjectionContext.safeParse(context);
  if (!parsedContext.success) {
    throw new DisputeProjectionError(
      "invalid-context",
      Array.from(new Set(parsedContext.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }

  const source = parsedRecord.data;
  const ctx = parsedContext.data;

  return DisputeCapsuleCandidate.parse({
    "@context": [AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF],
    "@type": DISPUTE_TYPE,
    visibility: capsuleVisibilityFor("Dispute"),
    metadata: {
      version: ctx.capsuleSemver,
      /* Provenance REPRESENTS what the database already holds — which record,
         which version of this mapping, generated when — and asserts none of it
         into being. */
      provenance: {
        source: source.disputeId,
        method: "deterministic-projection",
        acquiredAt: source.recordedAt,
        assertionKind: "Asserted",
        sourceClass: "governed-database-record",
        sourceSystem: "monacado",
        sourceRecordType: "TransactionDispute",
        sourceRecordId: source.disputeId,
        /* The last provider event applied identifies this row's content: the
           record has no version counter, and every field it carries was set by
           an event at or before that instant. */
        sourceRecordVersion: source.lastProviderEventAt,
        generatedAt: ctx.generatedAt,
        generatorVersion: ctx.mappingVersion,
      },
    },
    data: {
      disputeRef: source.disputeId,
      orderRef: source.orderId,
      economicSnapshotRef: source.snapshotId,
      provider: source.provider,
      providerMode: source.providerMode,
      providerDisputeRef: source.providerDisputeRef,
      originalProviderTransactionRef: source.providerTransactionRef,
      currency: source.currency,
      disputedAmountMinorUnits: source.disputedAmountMinorUnits,
      reasonCode: source.reasonCode,
      status: source.status,
      fundsState: source.fundsState,
      economicEffect: source.economicEffect,
      taxConsequence: source.taxConsequence,
      responsePermitted: source.responsePermitted,
      evidenceDueBy: source.evidenceDueBy,
      evidenceSubmissionCount: source.evidenceSubmissionCount,
      openedAt: source.openedAt,
      fundsWithdrawnAt: source.fundsWithdrawnAt,
      closedAt: source.closedAt,
      recordedAt: source.recordedAt,
      accountingReversalRef: source.reversalId,
    },
  });
}

/** The candidate's content hash. Same record + context ⇒ same hash. */
export function disputeCapsuleHash(candidate: DisputeCapsuleCandidate): string {
  return canonicalHash(candidate);
}

/**
 * Named as never admissible in a dispute capsule, and refused by `strictObject`.
 *
 * Asserted by test rather than merely documented, so a future widening argues
 * with a list instead of slipping past review.
 *
 * The buyer entries matter more here than on any previous capsule: a provider
 * dispute event is the single richest source of cardholder identity that reaches
 * this system, and this is the artifact most likely to be handed to an agent.
 */
export const NEVER_IN_DISPUTE_CAPSULE = [
  // buyer identity
  "buyerName",
  "buyerEmail",
  "email",
  "billingAddress",
  "shippingAddress",
  "streetAddress",
  "postalCode",
  "ipAddress",
  "customerPurchaseIp",
  // instrument
  "cardNumber",
  "cardLast4",
  "cardBrand",
  "cardNetwork",
  "paymentMethodDetails",
  // provider text and payload
  "networkReasonCode",
  "providerStatusString",
  "rawProviderResponse",
  "providerPayload",
  "providerMessage",
  "disputeNarrative",
  "reasonText",
  // evidence
  "evidenceDocument",
  "evidenceFileId",
  "representmentEvidence",
  "accessActivityLog",
  "shippingTrackingNumber",
  "customerCommunication",
  // operator commentary
  "supportNote",
  "operatorComment",
] as const;

/**
 * What this phase does about publication: **nothing**.
 *
 * Stated as a value so the claim is checkable, on
 * `REFUND_CAPSULE_PUBLICATION_DISPOSITION`'s terms.
 */
export const DISPUTE_CAPSULE_PUBLICATION_DISPOSITION = {
  visibility: "PRIVATE",
  agentNetPublication: "NONE",
  nodeRegistration: "NONE",
  registrarContact: "NONE",
  publicResolverExposure: "NONE",
  outboxRow: "NONE",
} as const;
