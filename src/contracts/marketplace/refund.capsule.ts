/**
 * Private Refund capsule projection (Phase 1.9).
 *
 * ```
 * OrderRefund (authoritative DB record) → deterministic projection
 *   → private Refund capsule candidate
 * ```
 *
 * The second private capsule this repository projects, following `1.7`'s
 * `TaxTransaction` in construction and in posture. Its purpose is **reasoning
 * rather than discovery**: an internal reconciliation agent, a refund
 * investigation, or an audit can be handed one of these instead of joining six
 * tables and re-deriving what happened to a sale.
 *
 * ## Private, and not published
 *
 * `CAPSULE_VISIBILITY_POLICY.Refund` is `PRIVATE`, and **this phase publishes
 * nothing** — no Node registration, no Registrar call, no outbox row, and no
 * publication state anywhere in this module.
 *
 * The disclosure argument is stronger here than for a tax transaction and worth
 * stating rather than inheriting. A public refund capsule would publish, per
 * sale, that a purchase was returned and under which reason code. On a
 * marketplace where a Listing binds one Product and one seller, an aggregate of
 * those is a published failure rate for that seller; individually, each is a
 * statement about one buyer's dissatisfaction. Neither party agreed to either,
 * and making them public would need the separate governance decision
 * `PUBLIC_DISCLOSURE_REQUIREMENTS` describes.
 *
 * ## The database stays authoritative
 *
 * A projection in the ADR's exact sense: one way, from an identified
 * authoritative record, creating no provenance and authorizing no business
 * change. It cannot write, cannot reach a database, and cannot be reversed into a
 * source record. If a capsule and its row ever disagree, **the row is right**.
 *
 * ## No buyer, ever
 *
 * A refund is about a *sale*, not a *person*. There is no field for a buyer name,
 * an email, an address, a payment credential, or a raw provider payload, and
 * `strictObject` means one cannot be added by accident. There is also no field
 * for who *asked* beyond a bounded requestor **kind** — an operator's account id
 * identifies a Monacado employee, and a research capsule is not the place for it.
 *
 * Pure functions. No database, clock, environment read, randomness, or network.
 */

import { z } from "zod";
import { CandidateMetadata, SemVer } from "../capsule/envelope";
import { AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF } from "../ontology/commerce.context";
import { capsuleVisibilityFor, CapsuleVisibility } from "../capsule/visibility";
import { canonicalHash } from "../integrity/hash";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { PaymentProvider } from "./payment-account";
import {
  OrderRefundRecord,
  RefundLifecycleState,
  RefundReasonCode,
  RefundRequestorKind,
  RefundScope,
  RefundStatus,
} from "./order-refund";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

export const REFUND_TYPE = "Refund" as const;

/** The mapping version. Bumped when this projection's shape changes. */
export const REFUND_MAPPING_VERSION = "refund-mapping/1.0.0";

// — Errors —

export class RefundProjectionError extends Error {
  readonly reason: string;
  readonly detail: readonly string[];
  constructor(reason: string, detail: readonly string[] = []) {
    super(`Refund projection failed: ${reason}`);
    this.name = "RefundProjectionError";
    this.reason = reason;
    this.detail = detail;
  }
}

// — Data —

/**
 * The non-PII facts a private refund capsule exposes.
 *
 * Every member answers a question an internal reader actually asks: *what was
 * returned, for which sale, under which governed reason, through which provider,
 * with which references, and where in the lifecycle is it*. Nothing here
 * identifies a person, and nothing restates prose.
 */
export const RefundCapsuleData = z.strictObject({
  /** Stable Monacado identity for the refund itself. */
  refundRef: z.string().min(1).max(191),
  /** The sale this concerns. An opaque Monacado Order reference. */
  orderRef: z.string().min(1).max(191),
  /** The sale's immutable economics. */
  economicSnapshotRef: z.string().min(1).max(191),

  scope: RefundScope,
  reasonCode: RefundReasonCode,
  /**
   * The lines this refund returned, each in full.
   *
   * The refund UNIT, projected because "what came back" is the first thing an
   * internal reader needs and the last thing they should have to infer from an
   * amount.
   */
  refundedLineRefs: z.array(z.string().min(1).max(220)),
  coversWholeOrder: z.boolean(),
  /**
   * The EXACT seller refund-policy version that governed this refund.
   *
   * A **stable reference, never the prose**. "Which terms governed this?" is the
   * first question an audit or a reconciliation agent asks, and following a
   * reference is cheaper than re-deriving it — but the terms themselves live on
   * one authoritative version row, and a copy in a capsule would be a second
   * answer able to disagree with what the buyer was actually shown.
   */
  sellerRefundPolicyRef: z.strictObject({
    policyId: z.string().min(1).max(191),
    policyVersion: z.string().min(1).max(64),
  }),
  /**
   * Who caused the refund, as a **kind only**.
   *
   * Deliberately not the acting account. An operator's account id names a
   * Monacado employee, and a capsule an internal agent reads is not where an
   * individual's decision history should accumulate.
   */
  requestorKind: RefundRequestorKind,

  currency: CurrencyCode,
  amountMinorUnits: Amount,
  /** The parts, so a reasoning agent need not re-derive the composition. */
  linesRetailMinorUnits: Amount,
  linesTaxMinorUnits: Amount,
  refundedShippingMinorUnits: Amount,

  provider: PaymentProvider,
  providerMode: z.enum(["TEST", "LIVE"]),
  /** The original charge. Opaque; identifies a transaction, not a person. */
  originalProviderTransactionRef: z.string().min(1).max(191),
  /** The provider's refund. `null` until executed. */
  providerRefundRef: z.string().min(1).max(191).nullable(),

  requestedAt: z.iso.datetime(),
  providerRefundCreatedAt: z.iso.datetime().nullable(),

  status: RefundStatus,
  /** The composite state, combining this refund with its tax reversal. */
  lifecycleState: RefundLifecycleState,
  attemptCount: z.int().min(0),
  /**
   * The `1.2` accounting entry, where one exists.
   *
   * Present because "was this actually booked?" is the first question a
   * reconciliation agent asks about a refund, and following a reference is
   * cheaper than inferring it from a status.
   */
  accountingReversalRef: z.string().min(1).max(191).nullable(),
  /** The tax reversal accompanying this refund, where one exists. */
  taxReversalRef: z.string().min(1).max(191).nullable(),
});
export type RefundCapsuleData = z.infer<typeof RefundCapsuleData>;

// — Candidate —

const RefundType = z.literal(REFUND_TYPE);

/**
 * A private capsule candidate.
 *
 * `CandidateMetadata` rather than `PublishedMetadata`, and that is not a
 * placeholder: there is no Registrar-issued Node ID, no capsule ID, no Publisher,
 * and no `publishedAt`, because **nothing is published**. Fabricating any of them
 * would assert a publication that never happened.
 */
export const RefundCapsuleCandidate = z.strictObject({
  "@context": z.array(z.string().min(1)).min(1),
  "@type": RefundType,
  /** `PRIVATE`, by governance. See `capsule/visibility.ts`. */
  visibility: CapsuleVisibility,
  metadata: CandidateMetadata,
  data: RefundCapsuleData,
});
export type RefundCapsuleCandidate = z.infer<typeof RefundCapsuleCandidate>;

// — Projection context —

/**
 * What the caller supplies that the record cannot.
 *
 * The generation instant, the mapping version, and the two cross-record
 * references a refund row does not itself carry. Nothing here can change what the
 * capsule *says* about the refund.
 */
export const RefundProjectionContext = z.strictObject({
  generatedAt: z.iso.datetime(),
  capsuleSemver: SemVer,
  mappingVersion: z.string().min(1).max(191),
  /** The composite lifecycle, derived by the caller from both durable records. */
  lifecycleState: RefundLifecycleState,
  /** The tax reversal accompanying this refund, if any. */
  taxReversalRef: z.string().min(1).max(191).nullable(),
});
export type RefundProjectionContext = z.infer<typeof RefundProjectionContext>;

export const DEFAULT_REFUND_CAPSULE_SEMVER = "1.0.0";

// — Projection —

/**
 * Project one authoritative refund into its private capsule candidate.
 *
 * Fails closed. An invalid record or context produces an error, never a
 * best-effort capsule — **projection repairs nothing**, and a record that cannot
 * be projected is one somebody must fix at the source.
 *
 * A `PENDING` or failed refund is deliberately projectable, on `1.7`'s reasoning:
 * a refund that has not completed is exactly the thing a reconciliation agent
 * needs to reason about, and refusing to project it would hide the rows that
 * matter most.
 */
export function projectRefundCapsule(record: unknown, context: unknown): RefundCapsuleCandidate {
  const parsedRecord = OrderRefundRecord.safeParse(record);
  if (!parsedRecord.success) {
    throw new RefundProjectionError(
      "invalid-source-record",
      Array.from(new Set(parsedRecord.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const parsedContext = RefundProjectionContext.safeParse(context);
  if (!parsedContext.success) {
    throw new RefundProjectionError(
      "invalid-context",
      Array.from(new Set(parsedContext.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }

  const source = parsedRecord.data;
  const ctx = parsedContext.data;

  return RefundCapsuleCandidate.parse({
    "@context": [AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF],
    "@type": REFUND_TYPE,
    visibility: capsuleVisibilityFor("Refund"),
    metadata: {
      version: ctx.capsuleSemver,
      /* Provenance REPRESENTS what the database already holds — which record,
         which version of this mapping, generated when — and asserts none of it
         into being. */
      provenance: {
        source: source.refundId,
        method: "deterministic-projection",
        acquiredAt: source.recordedAt,
        assertionKind: "Asserted",
        sourceClass: "governed-database-record",
        sourceSystem: "monacado",
        sourceRecordType: "OrderRefund",
        sourceRecordId: source.refundId,
        /* The refund's own version is its recorded instant: the record has no
           version counter, and the request-time facts are immutable, so the
           instant it was committed identifies the content exactly. */
        sourceRecordVersion: source.recordedAt,
        generatedAt: ctx.generatedAt,
        generatorVersion: ctx.mappingVersion,
      },
    },
    data: {
      refundRef: source.refundId,
      orderRef: source.orderId,
      economicSnapshotRef: source.snapshotId,
      scope: source.scope,
      reasonCode: source.reasonCode,
      refundedLineRefs: source.lineRefs,
      coversWholeOrder: source.coversWholeOrder,
      sellerRefundPolicyRef: {
        policyId: source.sellerRefundPolicyId,
        policyVersion: source.sellerRefundPolicyVersion,
      },
      requestorKind: source.requestorKind,
      currency: source.currency,
      amountMinorUnits: source.amountMinorUnits,
      linesRetailMinorUnits: source.linesRetailMinorUnits,
      linesTaxMinorUnits: source.linesTaxMinorUnits,
      refundedShippingMinorUnits: source.refundedShippingMinorUnits,
      provider: source.provider,
      providerMode: source.providerMode,
      originalProviderTransactionRef: source.providerTransactionRef,
      providerRefundRef: source.providerRefundRef,
      requestedAt: source.requestedAt,
      providerRefundCreatedAt: source.providerRefundCreatedAt,
      status: source.status,
      lifecycleState: ctx.lifecycleState,
      attemptCount: source.attemptCount,
      accountingReversalRef: source.reversalId,
      taxReversalRef: ctx.taxReversalRef,
    },
  });
}

/** The candidate's content hash. Same record + context ⇒ same hash. */
export function refundCapsuleHash(candidate: RefundCapsuleCandidate): string {
  return canonicalHash(candidate);
}

/**
 * Named as never admissible in a refund capsule, and refused by `strictObject`.
 *
 * Asserted by test rather than merely documented, so a future widening argues
 * with a list instead of slipping past review.
 */
export const NEVER_IN_REFUND_CAPSULE = [
  "buyerName",
  "buyerEmail",
  "email",
  "billingAddress",
  "shippingAddress",
  "streetAddress",
  "line1",
  "postalCode",
  "ipAddress",
  "cardNumber",
  "cardLast4",
  "paymentMethodPayload",
  "rawProviderResponse",
  "providerPayload",
  "providerMessage",
  "reasonText",
  "supportNote",
  /* The acting operator. A kind is projected; an identity is not. */
  "requestedByAccountId",
  /* The seller's policy PROSE. A stable REFERENCE is projected — the terms
     themselves live on one authoritative version row, and a copy here would be a
     second answer able to disagree with what the buyer was shown. */
  "sellerRefundPolicyText",
  "refundPolicyDocument",
  "refundPolicySections",
  "apiKey",
] as const;

/**
 * What this phase does about publication: **nothing**.
 *
 * Stated as a value so the claim is checkable. No Node is registered, no capsule
 * id is minted, no Registrar is contacted, and no outbox row is written for a
 * refund or tax-reversal capsule anywhere in this repository.
 */
export const REFUND_CAPSULE_PUBLICATION_DISPOSITION = {
  visibility: "PRIVATE",
  agentNetPublication: "NONE",
  nodeRegistration: "NONE",
  registrarContact: "NONE",
  publicResolverExposure: "NONE",
} as const;
