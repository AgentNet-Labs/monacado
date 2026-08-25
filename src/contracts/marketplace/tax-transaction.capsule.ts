/**
 * Private TaxTransaction capsule projection (Phase 1.7).
 *
 * The first **private** capsule this repository projects, and the first whose
 * purpose is reasoning rather than discovery.
 *
 * ```
 * OrderTaxTransaction (authoritative DB record) → deterministic projection
 *   → private TaxTransaction capsule candidate
 * ```
 *
 * ## Private, and not published
 *
 * `CAPSULE_VISIBILITY_POLICY.TaxTransaction` is `PRIVATE`, and **this phase
 * publishes nothing** — there is no Node registration, no Registrar call, no
 * outbox row, and no publication state anywhere in this module. What exists is
 * the *projection*: a deterministic candidate an internal reader — a
 * reconciliation agent, a tax-exception investigation, a refund's reasoning — can
 * be handed without querying six tables and re-deriving the tax treatment.
 *
 * Public capsules are for discoverability; this one is not discoverable, and
 * making it so would need the separate governance decision
 * `PUBLIC_DISCLOSURE_REQUIREMENTS` describes.
 *
 * ## The database stays authoritative
 *
 * This is a projection in the ADR's exact sense: one way, from an identified
 * authoritative record, creating no provenance and authorizing no business
 * change. It cannot write, cannot reach a database, and cannot be reversed into
 * a source record. If a capsule and its row ever disagree, **the row is right**.
 *
 * ## Deterministic
 *
 * Same record + same projection context ⇒ byte-identical candidate and identical
 * hash. Nothing reads a clock or generates randomness; the generation instant is
 * a context field, exactly as `0M.2B` and `0M.4B` established.
 *
 * ## No buyer, ever
 *
 * A tax transaction is about a *sale*, not a *person*. There is no field for a
 * buyer name, an email, a street address, a billing address, a payment
 * credential, or a raw provider payload, and `strictObject` means one cannot be
 * added by accident. The jurisdiction **code** is present because it is what the
 * tax was sourced under; the address it came from is not, and lives once on
 * `OrderBuyerSnapshot`.
 *
 * Pure functions. No database, clock, environment read, randomness, or network.
 */

import { z } from "zod";
import { CandidateMetadata, SemVer } from "../capsule/envelope";
import { AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF } from "../ontology/commerce.context";
import { capsuleVisibilityFor, CapsuleVisibility } from "../capsule/visibility";
import { canonicalHash } from "../integrity/hash";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { TaxJurisdictionCode, TaxProvider, TaxProviderMode, TaxTreatment } from "./tax-calculation";
import {
  OrderTaxTransactionRecord,
  TaxTransactionLifecycleState,
} from "./tax-transaction";
import { ProductTaxClassification } from "../product/product-tax-classification";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

export const TAX_TRANSACTION_TYPE = "TaxTransaction" as const;

/** The mapping version. Bumped when this projection's shape changes. */
export const TAX_TRANSACTION_MAPPING_VERSION = "tax-transaction-mapping/1.0.0";

// — Errors —

export class TaxTransactionProjectionError extends Error {
  readonly reason: string;
  readonly detail: readonly string[];
  constructor(reason: string, detail: readonly string[] = []) {
    super(`TaxTransaction projection failed: ${reason}`);
    this.name = "TaxTransactionProjectionError";
    this.reason = reason;
    this.detail = detail;
  }
}

// — Data —

/**
 * The non-PII facts a private tax capsule exposes.
 *
 * Every member answers a question an internal reader actually asks: *what was
 * taxed, where, under which classification, by which engine, with which
 * references, and what has happened to it since*. Nothing here identifies a
 * person, and nothing restates prose.
 */
export const TaxTransactionCapsuleData = z.strictObject({
  /** Stable Monacado identity for the tax transaction itself. */
  taxTransactionRef: z.string().min(1).max(191),
  /** The sale this concerns. An opaque Monacado Order reference. */
  orderRef: z.string().min(1).max(191),

  currency: CurrencyCode,
  taxableBasisMinorUnits: Amount,
  taxAmountMinorUnits: Amount,
  /** `null` until the provider has represented one. */
  providerTotalAmountMinorUnits: Amount.nullable(),

  /** The bounded code the tax was sourced under. **Never an address.** */
  shipToJurisdictionCode: TaxJurisdictionCode.nullable(),
  treatment: TaxTreatment,

  /** The exact Product source version whose classification produced the rate. */
  internalProductRef: z.string().min(1).max(191),
  productSourceRecordRef: z.string().min(1).max(191),
  productSourceRecordVersion: z.string().min(1).max(64),
  productTaxClassification: ProductTaxClassification,

  provider: TaxProvider,
  providerMode: TaxProviderMode,
  /** The engine's calculation. What a correction is derived from. */
  providerCalculationRef: z.string().min(1).max(191),
  /** The engine's transaction. **What a reversal names.** */
  providerTaxTransactionRef: z.string().min(1).max(191).nullable(),

  /** When the engine calculated, and when it created its transaction. */
  calculatedAt: z.iso.datetime(),
  providerTaxTransactionCreatedAt: z.iso.datetime().nullable(),

  lifecycleState: TaxTransactionLifecycleState,
  /**
   * References to corrections or reversals recorded against this sale's tax.
   *
   * **Always empty in this phase** — adjustment and reversal execution are a
   * later phase, and an empty array is the accurate projection of a record that
   * has none. The field exists so that adding one later changes a value rather
   * than the shape, which is what keeps a capsule's meaning stable across the
   * phase that finally writes them.
   */
  adjustmentRefs: z.array(z.string().min(1).max(191)),
});
export type TaxTransactionCapsuleData = z.infer<typeof TaxTransactionCapsuleData>;

// — Candidate —

const TaxTransactionType = z.literal(TAX_TRANSACTION_TYPE);

/**
 * A private capsule candidate.
 *
 * `CandidateMetadata` rather than `PublishedMetadata`, and that is not a
 * placeholder: there is no Registrar-issued Node ID, no capsule ID, no Publisher,
 * and no `publishedAt`, because **nothing is published**. Fabricating any of them
 * would assert a publication that never happened.
 *
 * `visibility` sits on the candidate rather than being inferred by a reader, so a
 * future publisher handed one of these has to actively ignore a field that says
 * `PRIVATE` in order to get it wrong.
 */
export const TaxTransactionCapsuleCandidate = z.strictObject({
  "@context": z.array(z.string().min(1)).min(1),
  "@type": TaxTransactionType,
  /** `PRIVATE`, by governance. See `capsule/visibility.ts`. */
  visibility: CapsuleVisibility,
  metadata: CandidateMetadata,
  data: TaxTransactionCapsuleData,
});
export type TaxTransactionCapsuleCandidate = z.infer<typeof TaxTransactionCapsuleCandidate>;

// — Projection context —

/**
 * What the caller supplies that the record cannot.
 *
 * The generation instant and the mapping version — the two things that make the
 * projection deterministic without reading a clock. Nothing here can change what
 * the capsule *says* about the sale.
 */
export const TaxTransactionProjectionContext = z.strictObject({
  generatedAt: z.iso.datetime(),
  capsuleSemver: SemVer,
  mappingVersion: z.string().min(1).max(191),
});
export type TaxTransactionProjectionContext = z.infer<typeof TaxTransactionProjectionContext>;

export const DEFAULT_TAX_TRANSACTION_CAPSULE_SEMVER = "1.0.0";

// — Projection —

/**
 * Project one authoritative tax transaction into its private capsule candidate.
 *
 * Fails closed. An invalid record or context produces an error, never a
 * best-effort capsule — **projection repairs nothing**, and a record that cannot
 * be projected is one somebody must fix at the source.
 *
 * The `PENDING` case is deliberately projectable: a committed-but-unreported tax
 * transaction is exactly the thing a reconciliation agent needs to reason about,
 * and refusing to project it would hide the rows that matter most. The provider
 * transaction reference is `null` there, and says so.
 */
export function projectTaxTransactionCapsule(
  record: unknown,
  context: unknown,
): TaxTransactionCapsuleCandidate {
  const parsedRecord = OrderTaxTransactionRecord.safeParse(record);
  if (!parsedRecord.success) {
    throw new TaxTransactionProjectionError(
      "invalid-source-record",
      Array.from(new Set(parsedRecord.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const parsedContext = TaxTransactionProjectionContext.safeParse(context);
  if (!parsedContext.success) {
    throw new TaxTransactionProjectionError(
      "invalid-context",
      Array.from(new Set(parsedContext.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }

  const source = parsedRecord.data;
  const ctx = parsedContext.data;

  return TaxTransactionCapsuleCandidate.parse({
    "@context": [AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF],
    "@type": TAX_TRANSACTION_TYPE,
    visibility: capsuleVisibilityFor("TaxTransaction"),
    metadata: {
      version: ctx.capsuleSemver,
      /* Provenance REPRESENTS what the database already holds — which record,
         which version of this mapping, generated when — and asserts none of it
         into being. */
      provenance: {
        source: source.taxTransactionId,
        method: "deterministic-projection",
        acquiredAt: source.recordedAt,
        assertionKind: "Asserted",
        sourceClass: "governed-database-record",
        sourceSystem: "monacado",
        sourceRecordType: "OrderTaxTransaction",
        sourceRecordId: source.taxTransactionId,
        /* The tax transaction's own version is its recorded instant: the record
           has no version counter, and the sale-time facts are immutable, so the
           instant it was committed identifies the content exactly. */
        sourceRecordVersion: source.recordedAt,
        generatedAt: ctx.generatedAt,
        generatorVersion: ctx.mappingVersion,
      },
    },
    data: {
      taxTransactionRef: source.taxTransactionId,
      orderRef: source.orderId,
      currency: source.currency,
      taxableBasisMinorUnits: source.taxableBasisMinorUnits,
      taxAmountMinorUnits: source.taxAmountMinorUnits,
      providerTotalAmountMinorUnits: source.providerTotalAmountMinorUnits,
      shipToJurisdictionCode: source.jurisdictionCode,
      treatment: source.treatment,
      internalProductRef: source.internalProductId,
      productSourceRecordRef: source.productSourceRecordId,
      productSourceRecordVersion: source.productSourceRecordVersion,
      productTaxClassification: source.productTaxClassification,
      provider: source.provider,
      providerMode: source.providerMode,
      providerCalculationRef: source.providerCalculationRef,
      providerTaxTransactionRef: source.providerTaxTransactionRef,
      calculatedAt: source.calculatedAt,
      providerTaxTransactionCreatedAt: source.providerTaxTransactionCreatedAt,
      lifecycleState: source.lifecycleState,
      /* Empty by construction: this phase records no adjustments or reversals. */
      adjustmentRefs: [],
    },
  });
}

/** The candidate's content hash. Same record + context ⇒ same hash. */
export function taxTransactionCapsuleHash(candidate: TaxTransactionCapsuleCandidate): string {
  return canonicalHash(candidate);
}

/**
 * Named as never admissible in a tax capsule, and refused by `strictObject`.
 *
 * Asserted by test rather than merely documented, so a future widening argues
 * with a list instead of slipping past review.
 */
export const NEVER_IN_TAX_TRANSACTION_CAPSULE = [
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
  "apiKey",
] as const;

/**
 * What this phase does about publication: **nothing**.
 *
 * Stated as a value so the claim is checkable. No Node is registered, no capsule
 * id is minted, no Registrar is contacted, and no outbox row is written for a tax
 * capsule anywhere in this repository.
 */
export const TAX_CAPSULE_PUBLICATION_DISPOSITION = {
  visibility: "PRIVATE",
  agentNetPublication: "NONE",
  nodeRegistration: "NONE",
  registrarContact: "NONE",
  publicResolverExposure: "NONE",
} as const;
