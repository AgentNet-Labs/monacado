/**
 * Private TaxReversal capsule projection (Phase 1.9).
 *
 * ```
 * OrderTaxReversal (authoritative DB record) → deterministic projection
 *   → private TaxReversal capsule candidate
 * ```
 *
 * The companion to `1.7`'s `TaxTransaction` capsule, and deliberately a **second
 * capsule rather than a field on the first**. `1.7` left `adjustmentRefs` on the
 * tax-transaction capsule *"always empty in this phase … so that adding one later
 * changes a value rather than the shape"*, and that is exactly what happens here:
 * the original capsule's shape is untouched, and this one describes the reversal.
 *
 * Folding a reversal into the original capsule would have been the projection
 * equivalent of rewriting a sale-time fact — the thing every phase of this tax
 * lifecycle has refused.
 *
 * ## Private, and not published
 *
 * `CAPSULE_VISIBILITY_POLICY.TaxReversal` is `PRIVATE`, on `TaxTransaction`'s
 * terms exactly: it is the same fiscal detail, about the same sale, read by the
 * same internal reconciliation and audit workflows. **This phase publishes
 * nothing.**
 *
 * ## No buyer, ever
 *
 * The jurisdiction code is not projected here at all — it is on the original
 * transaction's capsule, once, and a second copy would be a second answer able to
 * disagree with it. There is no field for a buyer name, an email, an address, a
 * payment credential, or a raw provider payload.
 *
 * Pure functions. No database, clock, environment read, randomness, or network.
 */

import { z } from "zod";
import { CandidateMetadata, SemVer } from "../capsule/envelope";
import { AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF } from "../ontology/commerce.context";
import { capsuleVisibilityFor, CapsuleVisibility } from "../capsule/visibility";
import { canonicalHash } from "../integrity/hash";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { TaxProvider, TaxProviderMode } from "./tax-calculation";
import {
  OrderTaxReversalRecord,
  TaxReversalScope,
  TaxReversalStatus,
} from "./tax-reversal";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

export const TAX_REVERSAL_TYPE = "TaxReversal" as const;

/** The mapping version. Bumped when this projection's shape changes. */
export const TAX_REVERSAL_MAPPING_VERSION = "tax-reversal-mapping/1.0.0";

// — Errors —

export class TaxReversalProjectionError extends Error {
  readonly reason: string;
  readonly detail: readonly string[];
  constructor(reason: string, detail: readonly string[] = []) {
    super(`TaxReversal projection failed: ${reason}`);
    this.name = "TaxReversalProjectionError";
    this.reason = reason;
    this.detail = detail;
  }
}

// — Data —

/**
 * The non-PII facts a private tax-reversal capsule exposes.
 *
 * *What was reversed, of which original transaction, by which engine, with which
 * references, and where the provider call got to.* Nothing more, and nothing that
 * the original transaction's capsule already answers.
 */
export const TaxReversalCapsuleData = z.strictObject({
  /** Stable Monacado identity for the reversal itself. */
  taxReversalRef: z.string().min(1).max(191),
  /** The sale this concerns. */
  orderRef: z.string().min(1).max(191),
  /** The payment refund this reversal accompanies. */
  refundRef: z.string().min(1).max(191),
  /** The `1.7` record whose sale-time facts are being reversed. Never rewritten. */
  taxTransactionRef: z.string().min(1).max(191),

  scope: TaxReversalScope,

  currency: CurrencyCode,
  reversedTaxAmountMinorUnits: Amount,
  reversedTaxableBasisMinorUnits: Amount,

  provider: TaxProvider,
  providerMode: TaxProviderMode,
  /** The engine's ORIGINAL transaction — what a reversal names. */
  originalProviderTaxTransactionRef: z.string().min(1).max(191),
  /** The engine's reversal transaction. `null` until the call succeeds. */
  providerReversalRef: z.string().min(1).max(191).nullable(),

  recordedAt: z.iso.datetime(),
  providerReversalCreatedAt: z.iso.datetime().nullable(),

  status: TaxReversalStatus,
  attemptCount: z.int().min(0),
});
export type TaxReversalCapsuleData = z.infer<typeof TaxReversalCapsuleData>;

// — Candidate —

const TaxReversalType = z.literal(TAX_REVERSAL_TYPE);

export const TaxReversalCapsuleCandidate = z.strictObject({
  "@context": z.array(z.string().min(1)).min(1),
  "@type": TaxReversalType,
  /** `PRIVATE`, by governance. See `capsule/visibility.ts`. */
  visibility: CapsuleVisibility,
  metadata: CandidateMetadata,
  data: TaxReversalCapsuleData,
});
export type TaxReversalCapsuleCandidate = z.infer<typeof TaxReversalCapsuleCandidate>;

// — Projection context —

export const TaxReversalProjectionContext = z.strictObject({
  generatedAt: z.iso.datetime(),
  capsuleSemver: SemVer,
  mappingVersion: z.string().min(1).max(191),
});
export type TaxReversalProjectionContext = z.infer<typeof TaxReversalProjectionContext>;

export const DEFAULT_TAX_REVERSAL_CAPSULE_SEMVER = "1.0.0";

// — Projection —

/**
 * Project one authoritative tax reversal into its private capsule candidate.
 *
 * Fails closed. An invalid record or context produces an error, never a
 * best-effort capsule.
 */
export function projectTaxReversalCapsule(
  record: unknown,
  context: unknown,
): TaxReversalCapsuleCandidate {
  const parsedRecord = OrderTaxReversalRecord.safeParse(record);
  if (!parsedRecord.success) {
    throw new TaxReversalProjectionError(
      "invalid-source-record",
      Array.from(new Set(parsedRecord.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const parsedContext = TaxReversalProjectionContext.safeParse(context);
  if (!parsedContext.success) {
    throw new TaxReversalProjectionError(
      "invalid-context",
      Array.from(new Set(parsedContext.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }

  const source = parsedRecord.data;
  const ctx = parsedContext.data;

  return TaxReversalCapsuleCandidate.parse({
    "@context": [AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF],
    "@type": TAX_REVERSAL_TYPE,
    visibility: capsuleVisibilityFor("TaxReversal"),
    metadata: {
      version: ctx.capsuleSemver,
      provenance: {
        source: source.taxReversalId,
        method: "deterministic-projection",
        acquiredAt: source.recordedAt,
        assertionKind: "Asserted",
        sourceClass: "governed-database-record",
        sourceSystem: "monacado",
        sourceRecordType: "OrderTaxReversal",
        sourceRecordId: source.taxReversalId,
        sourceRecordVersion: source.recordedAt,
        generatedAt: ctx.generatedAt,
        generatorVersion: ctx.mappingVersion,
      },
    },
    data: {
      taxReversalRef: source.taxReversalId,
      orderRef: source.orderId,
      refundRef: source.refundId,
      taxTransactionRef: source.taxTransactionId,
      scope: source.scope,
      currency: source.currency,
      reversedTaxAmountMinorUnits: source.reversedTaxAmountMinorUnits,
      reversedTaxableBasisMinorUnits: source.reversedTaxableBasisMinorUnits,
      provider: source.provider,
      providerMode: source.providerMode,
      originalProviderTaxTransactionRef: source.originalProviderTaxTransactionRef,
      providerReversalRef: source.providerReversalRef,
      recordedAt: source.recordedAt,
      providerReversalCreatedAt: source.providerReversalCreatedAt,
      status: source.status,
      attemptCount: source.attemptCount,
    },
  });
}

/** The candidate's content hash. Same record + context ⇒ same hash. */
export function taxReversalCapsuleHash(candidate: TaxReversalCapsuleCandidate): string {
  return canonicalHash(candidate);
}

/** Named as never admissible in a tax-reversal capsule. Asserted by test. */
export const NEVER_IN_TAX_REVERSAL_CAPSULE = [
  "buyerName",
  "buyerEmail",
  "email",
  "billingAddress",
  "shippingAddress",
  "shipToAddress",
  "streetAddress",
  "line1",
  "postalCode",
  "ipAddress",
  "cardNumber",
  "paymentMethodPayload",
  "rawProviderResponse",
  "providerPayload",
  "providerMessage",
  "apiKey",
] as const;
