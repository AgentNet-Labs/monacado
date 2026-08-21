/**
 * Tax execution boundary (Phase 1.2).
 *
 * `0M.T1` recorded a tax amount and calculated nothing; `1.0` and `1.1` sent a
 * hard-coded zero because nothing could calculate one. This replaces that
 * assumption with a **provider-neutral calculation boundary** and makes an
 * authoritative tax result a precondition of taking a payment.
 *
 * ## What this is, and firmly is not
 *
 * **Is:** the interface a tax engine sits behind, the shape of its answer, and
 * the evidence Monacado keeps so a completed Order can later explain the amount
 * it charged.
 *
 * **Is not:** nexus determination, product tax classification, sourcing rules,
 * exemption certificate handling, filing, or remittance. Those are `0M.T2`'s
 * operational half and remain unimplemented. A provider computes; Monacado
 * records what it was told and by whom.
 *
 * ## Tax is not commercial revenue
 *
 * The amount here reaches the buyer's total and **nothing else**. It is outside
 * every commercial basis — structurally, because `reconcileTransactionEconomics`
 * has no term for it and `PASS_THROUGH_AMOUNT_FIELDS` is asserted absent from
 * every basis. Folding tax into the retail amount would enlarge Monacado's
 * retention, the seller's proceeds, and the promoter's spread with money that was
 * never anyone's revenue.
 *
 * ## Where the jurisdiction comes from
 *
 * Real tax depends on where the buyer is, and **Monacado now collects that**: a
 * completed checkout captures a billing address on `OrderBuyerSnapshot`, and
 * `buyerJurisdictionCode` is derived from it — in one place, by
 * `taxJurisdictionCodeFor`, and **never from an IP address**. An IP locates a
 * network interface, not a buyer, and sourcing tax from one is guessing with a
 * number that looks authoritative.
 *
 * The request still carries a **bounded code and no address**. An engine that
 * needs the full address receives it from the snapshot at the adapter boundary;
 * this contract stays free of personal data so nothing downstream of it can leak
 * any.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import { ORDER_TAX_EVIDENCE_ID_RE } from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

// — Identity —

export const OrderTaxEvidenceId = z
  .string()
  .regex(ORDER_TAX_EVIDENCE_ID_RE, "taxEvidenceId must be mon:taxe:<opaque>");
export type OrderTaxEvidenceId = z.infer<typeof OrderTaxEvidenceId>;

// — Provider —

/**
 * Which engine produced a result.
 *
 * Both members are **test adapters**, and that is the whole list. No production
 * tax vendor is named, because the repository configures none and choosing one
 * here would be choosing a third party, a data-processing relationship, and a
 * filing posture on Monacado's behalf inside a phase about boundaries.
 *
 * A real provider is a new member plus a new adapter, and **no change to any
 * caller** — which is the point of the interface existing before the vendor does.
 */
export const TAX_PROVIDERS = ["TEST_ZERO_RATE", "TEST_FLAT_RATE"] as const;
export const TaxProvider = z.enum(TAX_PROVIDERS);
export type TaxProvider = z.infer<typeof TaxProvider>;

// — Treatment —

/**
 * What the engine decided about taxability, as a bounded classification.
 *
 * Coarse on purpose. A finer vocabulary would be a claim about tax law that
 * Monacado is not the authority on, and the engine's own reasoning belongs in the
 * engine's records — reachable by `providerCalculationRef` when an auditor needs
 * it.
 */
export const TAX_TREATMENTS = [
  /** Tax was assessed and is included in the amount. */
  "TAXABLE",
  /** The engine determined no tax is due on this transaction. */
  "EXEMPT",
  /** The engine determined the transaction is outside the taxing regime. */
  "OUT_OF_SCOPE",
] as const;
export const TaxTreatment = z.enum(TAX_TREATMENTS);
export type TaxTreatment = z.infer<typeof TaxTreatment>;

/**
 * A bounded jurisdiction label, where the engine reports one.
 *
 * A **code**, never an address: uppercase letters, digits, and hyphens, so
 * `US-CA` or `GB` fits and `221B Baker Street` cannot. Kept only because an
 * auditor asking "why this amount" needs to know which regime answered, and
 * `null` where the engine does not say.
 */
export const TaxJurisdictionCode = z
  .string()
  .min(2)
  .max(16)
  .regex(/^[A-Z0-9-]+$/, "jurisdictionCode must be an uppercase bounded code, never an address");
export type TaxJurisdictionCode = z.infer<typeof TaxJurisdictionCode>;

// — Request —

/**
 * What an engine is asked to price.
 *
 * The commercial retail amount and shipping — the two figures a tax regime
 * ordinarily assesses — plus the identifiers a classification might need. **No
 * buyer identity, no address, no email, and no line-item description**, and no
 * field in which one could arrive.
 */
export const TaxCalculationRequest = z.strictObject({
  currency: CurrencyCode,
  /** The merchandise amount alone. Tax is never assessed on tax. */
  commercialRetailAmountMinorUnits: Amount,
  shippingAmountMinorUnits: Amount,
  /** For product tax classification, when an engine supports one. */
  internalProductId: z.string().min(1).max(191),
  /** The party whose nexus would matter to a real engine. */
  sellerParticipantId: z.string().min(1).max(191),
  /**
   * Where the buyer is, derived from their billing address.
   *
   * `null` only where no snapshot exists yet. Every checkout path now supplies
   * one — see the module header for why it is never derived from an IP.
   */
  buyerJurisdictionCode: TaxJurisdictionCode.nullable(),
  /** The instant the quote is for. Injected, never a clock read. */
  at: z.iso.datetime(),
});
export type TaxCalculationRequest = z.infer<typeof TaxCalculationRequest>;

// — Result —

/**
 * The engine's authoritative answer.
 *
 * `providerCalculationRef` is the engine's own identifier for this calculation,
 * kept so an auditor can reach the engine's reasoning without Monacado storing
 * it. It is opaque here: never parsed, never interpreted, and no decision is made
 * from it.
 *
 * `basisAmountMinorUnits` records **what the tax was assessed on**, so a later
 * reader can check the quote against the Order rather than trusting that the two
 * were about the same sale.
 */
export const TaxQuote = z.strictObject({
  provider: TaxProvider,
  providerCalculationRef: z.string().min(1).max(191),
  currency: CurrencyCode,
  taxAmountMinorUnits: Amount,
  /** Retail + shipping, as the engine understood it. A checked invariant. */
  basisAmountMinorUnits: Amount,
  treatment: TaxTreatment,
  jurisdictionCode: TaxJurisdictionCode.nullable(),
  calculatedAt: z.iso.datetime(),
});
export type TaxQuote = z.infer<typeof TaxQuote>;

/**
 * A quote is internally coherent.
 *
 * Two rules, both cheap and both catching a real mistake:
 *
 *   - an `EXEMPT` or `OUT_OF_SCOPE` result must carry **zero** tax. A non-zero
 *     amount under a not-taxable treatment is an engine contradicting itself, and
 *     charging it would be charging tax nobody said was due.
 *   - a `TAXABLE` result must not exceed its own basis. Tax larger than the thing
 *     taxed is always an error, and it is the error that overcharges a buyer.
 */
export function taxQuoteIsCoherent(quote: TaxQuote): boolean {
  if (quote.treatment !== "TAXABLE") return quote.taxAmountMinorUnits === 0;
  return quote.taxAmountMinorUnits <= quote.basisAmountMinorUnits;
}

// — The port —

/**
 * The single boundary across which Monacado obtains a tax amount.
 *
 * An implementation **must not invent an amount when it cannot compute one**. A
 * zero returned because an engine was unreachable is indistinguishable from a
 * zero that is genuinely correct, and the difference is a tax liability nobody
 * recorded — so an adapter that cannot answer must throw, and checkout refuses
 * rather than proceeding untaxed.
 */
export interface TaxCalculationPort {
  calculate(request: TaxCalculationRequest): Promise<TaxQuote>;
}

// — Evidence —

/**
 * What Monacado keeps so a completed Order can explain its tax.
 *
 * The Order already stores the *amount* charged (`quotedTaxAmountMinorUnits`), so
 * this is the **why**, not the what — which engine, which calculation, on what
 * basis, under which treatment, at what instant. The amount is repeated here
 * deliberately and is a **checked invariant** against the Order rather than a
 * second answer: if the two ever disagree, that is the thing worth surfacing.
 */
export const OrderTaxEvidenceRecord = z.strictObject({
  taxEvidenceId: OrderTaxEvidenceId,
  orderId: z.string().min(1).max(191),
  provider: TaxProvider,
  providerCalculationRef: z.string().min(1).max(191),
  currency: CurrencyCode,
  taxAmountMinorUnits: Amount,
  basisAmountMinorUnits: Amount,
  treatment: TaxTreatment,
  jurisdictionCode: TaxJurisdictionCode.nullable(),
  /**
   * The buyer snapshot whose billing address produced that jurisdiction.
   *
   * The linkage that answers "what address was this calculated from" years
   * later. Nullable only because the column is additive over rows written before
   * buyer snapshots existed; every row written now sets it.
   */
  buyerSnapshotId: z.string().min(1).max(191).nullable(),
  calculatedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
});
export type OrderTaxEvidenceRecord = z.infer<typeof OrderTaxEvidenceRecord>;

// — Never here —

/**
 * Named as never admissible on a request, a quote, or the evidence row.
 *
 * The first group is **buyer personal data**. Monacado now persists a buyer's
 * contact and billing address on `OrderBuyerSnapshot` — one record, deliberately
 * scoped — and this evidence row is not a second copy of it. The linkage is
 * `buyerSnapshotId`; duplicating the address here would create two answers to
 * "where was this sourced" that can disagree. Identity documents and tax
 * identifiers remain forbidden outright.
 *
 * The second is **filing and remittance**, which is `0M.T2` and whose fields
 * appearing here would mean Monacado had started keeping a return.
 */
export const NEVER_ON_TAX_EVIDENCE = [
  // buyer personal data — no address, and therefore no column for one
  "buyerAddress",
  "shippingAddress",
  "billingAddress",
  "postalCode",
  "buyerEmail",
  "buyerName",
  "taxIdentificationNumber",
  "vatNumber",
  "exemptionCertificate",
  // filing and remittance — 0M.T2
  "filingPeriod",
  "remittedAt",
  "returnId",
  "liabilityAccountId",
  // credentials — the adapter's problem
  "apiKey",
  "accountId",
] as const;
