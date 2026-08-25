/**
 * Tax execution boundary (Phase 1.2, made production-capable in Phase 1.6).
 *
 * `0M.T1` recorded a tax amount and calculated nothing; `1.0` and `1.1` sent a
 * hard-coded zero because nothing could calculate one. `1.2` replaced that
 * assumption with a **provider-neutral calculation boundary** and made an
 * authoritative tax result a precondition of taking a payment. `1.6` puts a real
 * engine behind that boundary — **Stripe Tax**, in test mode — and adds the
 * facts a real engine needs and the evidence a real transaction must keep.
 *
 * ## What this is, and firmly is not
 *
 * **Is:** the interface a tax engine sits behind, the shape of its answer, and
 * the evidence Monacado keeps so a completed Order can later explain the amount
 * it charged.
 *
 * **Is not:** nexus determination, registration, filing, or remittance. Those
 * remain operator and provider responsibilities; `tax-readiness.ts` reports
 * whether they have been configured and **refuses to infer any of them**. A
 * provider computes; Monacado records what it was told, by whom, and on what.
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
 * ## Where the destination comes from
 *
 * **The ship-to address, always.** Standard Monacado retail checkout collects two
 * addresses on every purchase — billing for the payment and transaction record,
 * ship-to for the destination — and tax is sourced to ship-to for digital,
 * physical, and mixed baskets alike. `resolveTaxDestination` in
 * `tax-destination.ts` is the one place that reduces it to bounded fields.
 *
 * **There is no runtime choice of tax source.** No buyer-declared tax location,
 * no billing tax-source mode, no IP sourcing, no proxy piercing, no device
 * location. Earlier shapes inside this phase carried a `BILLING | SHIPPING` enum
 * through the request, quote, and evidence; the branch cannot occur now, and the
 * enum went with it rather than surviving with one legitimate value.
 *
 * **A ship-to address does not imply physical fulfillment.** On a digital
 * purchase it is a tax destination and nothing else. Whether anything ships is
 * `evaluateBasketFulfillment`'s separate question.
 *
 * The `destination` sent is **an address, bounded**: country, subdivision, postal
 * code. Stripe Tax cannot produce a correct US rate from a two-letter country
 * code — sales tax varies by municipality, and the postal code is the smallest
 * element that resolves it. That is precisely the carve-out `1.2` anticipated:
 * *the collected address remains the jurisdiction source unless the actual
 * provider requires additional destination information*.
 *
 * **This does not resolve every international sourcing rule, and does not claim
 * to.** It decides which transaction facts Monacado supplies; the provider
 * determines the tax result from them. Origin sourcing, marketplace-facilitator
 * rules, VAT place-of-supply for digital services, and reverse charge are all the
 * engine's to apply. Provider-specific sourcing vocabulary stays behind the port.
 *
 * **No street line, name, or email crosses this boundary**, and there is no field
 * in which one could arrive.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import { ORDER_TAX_EVIDENCE_ID_RE } from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { ProductTaxClassification } from "../product/product-tax-classification";
import { DeliveryMode } from "../product/product.capsule";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

export { PRODUCT_TAX_CLASSIFICATIONS, ProductTaxClassification } from "../product/product-tax-classification";

// — Identity —

export const OrderTaxEvidenceId = z
  .string()
  .regex(ORDER_TAX_EVIDENCE_ID_RE, "taxEvidenceId must be mon:taxe:<opaque>");
export type OrderTaxEvidenceId = z.infer<typeof OrderTaxEvidenceId>;

// — Provider —

/**
 * Which engine produced a result.
 *
 * `1.2` named only test adapters, because the repository configured no vendor and
 * choosing one inside a phase about boundaries would have been choosing a third
 * party by implication. `1.6` makes that choice deliberately and adds exactly one
 * member: **`STRIPE_TAX`**, because Stripe is already the payment platform,
 * Monacado is the merchant of record on those charges, and a tax engine that
 * shares the payment provider's account is the one whose registrations, reports,
 * and reversals line up with the charges they concern.
 *
 * The two test adapters remain, and remain test adapters. Adding a second real
 * vendor later is a new member plus a new adapter and **no change to any
 * caller** — which is the point of the interface existing before the vendor did.
 */
export const TAX_PROVIDERS = ["TEST_ZERO_RATE", "TEST_FLAT_RATE", "STRIPE_TAX"] as const;
export const TaxProvider = z.enum(TAX_PROVIDERS);
export type TaxProvider = z.infer<typeof TaxProvider>;

/**
 * The providers whose answers may govern real commerce.
 *
 * A separate list rather than "not a test adapter", so the distinction is a
 * stated fact one can grep for rather than a naming convention one has to trust.
 * `tax-readiness.ts` blocks live commerce when the selected provider is absent
 * from it: a flat-rate stub returning a plausible number is **more** dangerous
 * than no engine at all, because its answers look calculated.
 */
export const PRODUCTION_TAX_PROVIDERS: readonly TaxProvider[] = ["STRIPE_TAX"];

export function isProductionTaxProvider(provider: TaxProvider): boolean {
  return PRODUCTION_TAX_PROVIDERS.includes(provider);
}

/**
 * Which of the provider's two worlds an answer came from.
 *
 * Recorded on the quote and persisted on the evidence, because "was this a real
 * calculation" must be answerable from the record itself rather than from
 * whichever credential a deployment happened to hold at the time. It is read back
 * from the **provider's own statement** about the object, never from Monacado's
 * configuration: a deployment that believes it is in test mode while holding a
 * live key is exactly the failure this catches.
 */
export const TAX_PROVIDER_MODES = ["TEST", "LIVE"] as const;
export const TaxProviderMode = z.enum(TAX_PROVIDER_MODES);
export type TaxProviderMode = z.infer<typeof TaxProviderMode>;

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

// — Destination —

/**
 * The bounded destination a real engine is asked about (Phase 1.6).
 *
 * **Three fields, and the boundary is the point.** Country is what every regime
 * needs; subdivision is the difference between a correct US or Canadian rate and
 * a wrong one; postal code is the smallest element that resolves a municipal
 * rate. There is deliberately **no `line1`, `line2`, `city`, `name`, or
 * `email`** — a tax engine does not need a street to compute a rate, and a field
 * that exists is a field that ends up in a log.
 *
 * Assembled by `resolveTaxDestination` from the Order's **ship-to** address, and
 * from nothing else. Never from billing, never buyer-declared, never from an IP.
 */
export const TaxDestination = z.strictObject({
  /** ISO 3166-1 alpha-2, and required. Nothing can be sourced without it. */
  countryCode: z.string().length(2).regex(/^[A-Z]{2}$/, "countryCode must be ISO 3166-1 alpha-2"),
  /** ISO 3166-2 subdivision, without the country prefix. `null` where none. */
  regionCode: z
    .string()
    .min(1)
    .max(8)
    .regex(/^[A-Z0-9-]+$/, "regionCode must be a bounded uppercase subdivision code")
    .nullable(),
  /**
   * The postal code, and the one element of an address that is here.
   *
   * `null` for the many countries that have none. Present, it is what turns a
   * state-level US estimate into the rate actually owed in that municipality.
   */
  postalCode: z.string().min(1).max(32).nullable(),
});
export type TaxDestination = z.infer<typeof TaxDestination>;

/**
 * The bounded jurisdiction code a destination sources to.
 *
 * `US-CA` where a subdivision exists, `GB` where none does — the same shape
 * `TaxJurisdictionCode` accepts, built from the ship-to destination **actually
 * sent**. It is the jurisdiction the tax was sourced under, and there is no
 * second candidate for that.
 */
export function taxDestinationJurisdictionCode(destination: TaxDestination): string {
  return destination.regionCode === null
    ? destination.countryCode
    : `${destination.countryCode}-${destination.regionCode}`;
}

// — Product basis —

/**
 * The exact Product fact a calculation was made under (Phase 1.6).
 *
 * Carried on the request, echoed on the quote, and pinned in the evidence, so
 * three questions stay answerable years later: *which* Product, *which immutable
 * source version* of it, and *what classification* that version declared. A
 * classification that later changes cannot rewrite a completed sale's basis,
 * because the sale names the version the classification came from.
 *
 * `deliveryMode` rides along because several regimes tax the same goods
 * differently depending on whether anything physical moves. It is the Product's
 * declared mode, not a derivation from the classification — see
 * `taxClassificationAgreesWithDelivery`.
 */
export const ProductTaxBasis = z.strictObject({
  internalProductId: z.string().min(1).max(191),
  /** The stable source record, constant across versions. */
  sourceRecordId: z.string().min(1).max(191),
  /** The EXACT version. Never "current", never "latest". */
  sourceRecordVersion: z.string().min(1).max(64),
  taxClassification: ProductTaxClassification,
  deliveryMode: DeliveryMode,
});
export type ProductTaxBasis = z.infer<typeof ProductTaxBasis>;

// — Request —

/**
 * What an engine is asked to price.
 *
 * The commercial retail amount and shipping — the two figures a tax regime
 * ordinarily assesses — the bounded destination, and the exact Product basis.
 * **No buyer identity, no street address, no email, and no line-item
 * description**, and no field in which one could arrive.
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
   * The bounded ship-to destination this sale is taxed to.
   *
   * The **only** location on this request. A `buyerJurisdictionCode` derived from
   * billing sat here through earlier drafts of this phase and was removed: a
   * second location field beside the authoritative one is a second answer waiting
   * to be read by mistake.
   *
   * `null` is tolerated by the contract (a test adapter that sources nothing has
   * no use for it) and **refused by every production adapter**, which cannot
   * compute a rate without knowing where to compute it for.
   */
  destination: TaxDestination.nullable(),
  /**
   * The exact Product source version and classification (Phase 1.6).
   *
   * `null` is tolerated by the contract for the same reason `destination` is, and
   * **refused by every production adapter**. An unclassified Product is not sold
   * under a guessed category: see `product-tax-classification.ts`.
   */
  product: ProductTaxBasis.nullable(),
  /**
   * A stable, Monacado-derived key for this calculation (Phase 1.6).
   *
   * Handed to providers that support idempotency so a replayed checkout reuses
   * the calculation it already made instead of creating a second one. Derived
   * from the checkout's own facts and therefore **stable across replay and
   * different across a genuinely different sale** — see `tax-idempotency.ts`.
   * Opaque, and by construction discloses nothing about the buyer.
   */
  idempotencyKey: z.string().min(1).max(255).nullable(),
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
 * it, and so a later reversal can tell the engine **which** calculation is being
 * reversed. It is opaque here: never parsed, never interpreted, and no decision
 * is made from it.
 *
 * `basisAmountMinorUnits` records **what the tax was assessed on**, so a later
 * reader can check the quote against the Order rather than trusting that the two
 * were about the same sale.
 */
export const TaxQuote = z.strictObject({
  provider: TaxProvider,
  /** The provider's own statement about which world this came from (1.6). */
  providerMode: TaxProviderMode,
  providerCalculationRef: z.string().min(1).max(191),
  currency: CurrencyCode,
  taxAmountMinorUnits: Amount,
  /** Retail + shipping, as the engine understood it. A checked invariant. */
  basisAmountMinorUnits: Amount,
  treatment: TaxTreatment,
  jurisdictionCode: TaxJurisdictionCode.nullable(),
  /**
   * The exact Product basis this was calculated under (Phase 1.6).
   *
   * Echoed back from the request rather than restated by the engine, and
   * **checked equal to it** at the port boundary — an engine that answered about
   * a different Product would otherwise be indistinguishable from one that
   * answered about this one. `null` only from a test adapter that classifies
   * nothing.
   */
  productTaxBasis: ProductTaxBasis.nullable(),
  /**
   * The provider's own code for that classification (Phase 1.6).
   *
   * Kept so the mapping a historical calculation actually used stays legible
   * after the configuration that produced it changes. Without it, a later reader
   * could recover the Monacado classification but not what the engine was told,
   * and those are the two halves of "why this rate".
   */
  providerTaxCode: z.string().min(1).max(64).nullable(),
  /**
   * The version of the Monacado-side provider mapping in force (Phase 1.6).
   *
   * A short deployment-set label, never a secret and never a credential. It is
   * what lets "we changed the SOFTWARE mapping in September" be checked against a
   * sale rather than argued about.
   */
  providerConfigVersion: z.string().min(1).max(64).nullable(),
  calculatedAt: z.iso.datetime(),
  /**
   * When the provider stops honouring this calculation (Phase 1.6).
   *
   * Modelled explicitly because it is real: Stripe Tax calculations expire, and a
   * stale one cannot be turned into the provider-side transaction a reversal
   * later needs. `null` where the provider states no expiry. A quote past this
   * instant is **refused**, never quietly reused.
   */
  expiresAt: z.iso.datetime().nullable(),
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
 *
 * Non-negativity is not checked here because it **cannot fail**: `Amount` is a
 * non-negative integer, so a negative tax cannot be parsed into a quote at all.
 */
export function taxQuoteIsCoherent(quote: TaxQuote): boolean {
  if (quote.treatment !== "TAXABLE") return quote.taxAmountMinorUnits === 0;
  return quote.taxAmountMinorUnits <= quote.basisAmountMinorUnits;
}

/**
 * Whether the provider still honours this calculation at a given instant.
 *
 * A quote with no stated expiry is usable — that is the provider saying it does
 * not expire, not Monacado assuming so. An expiry exactly at the instant is
 * treated as expired: a boundary that is honoured "usually" is a boundary that
 * fails in production at the worst moment.
 */
export function taxQuoteIsUsableAt(quote: TaxQuote, at: string): boolean {
  if (quote.expiresAt === null) return true;
  return Date.parse(at) < Date.parse(quote.expiresAt);
}

/**
 * What a **production** quote is missing, as a list of field names.
 *
 * Empty for a complete one. The fields are exactly those that make a completed
 * sale explainable and reversible later — the Product basis it was calculated
 * under, the provider code that basis was mapped to, and the mapping version that
 * produced the map. A test adapter is exempt because it governs no commerce; a
 * production provider that omitted any of these would be one whose historical
 * calculations could not be interpreted after a mapping change.
 */
export function productionTaxQuoteIssues(quote: TaxQuote): string[] {
  if (!isProductionTaxProvider(quote.provider)) return [];
  const missing: string[] = [];
  if (quote.productTaxBasis === null) missing.push("productTaxBasis");
  if (quote.providerTaxCode === null) missing.push("providerTaxCode");
  if (quote.providerConfigVersion === null) missing.push("providerConfigVersion");
  return missing;
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
 * this is the **why**, not the what — which engine, in which mode, which
 * calculation, on what basis, under which treatment, against which Product
 * version and classification, at what instant. The amount is repeated here
 * deliberately and is a **checked invariant** against the Order rather than a
 * second answer: if the two ever disagree, that is the thing worth surfacing.
 *
 * ## Interpretable after the world moves on
 *
 * Every field a later reader needs is **pinned**, not referenced: the Product
 * source version, the classification that version declared, the provider code it
 * was mapped to, and the mapping version that produced the map. Reclassifying a
 * Product tomorrow, or remapping `SOFTWARE` next quarter, changes nothing about
 * a sale made today — which is the whole reason these are columns rather than
 * joins.
 *
 * ## What it deliberately does not hold
 *
 * No raw provider payload, no line-item echo, no copy of the Order or the Product
 * snapshot, and no address. A raw payload is where every field nobody agreed to
 * store eventually appears; the address lives once, on the buyer snapshot, and is
 * reached through `buyerSnapshotId`.
 */
export const OrderTaxEvidenceRecord = z.strictObject({
  taxEvidenceId: OrderTaxEvidenceId,
  orderId: z.string().min(1).max(191),
  provider: TaxProvider,
  /**
   * Which of the provider's worlds answered. Nullable only because the column is
   * additive over rows written before `1.6`; every row written now sets it.
   */
  providerMode: TaxProviderMode.nullable(),
  /**
   * The engine's own identifier for this calculation.
   *
   * **The reversal hook.** A later refund must tell the engine which original
   * calculation is being reversed, and this is that identifier — durable, opaque,
   * and never minted by Monacado.
   */
  providerCalculationRef: z.string().min(1).max(191),
  /** When the provider stops honouring that calculation, where it says. */
  providerCalculationExpiresAt: z.iso.datetime().nullable(),
  currency: CurrencyCode,
  taxAmountMinorUnits: Amount,
  basisAmountMinorUnits: Amount,
  treatment: TaxTreatment,
  /**
   * The jurisdiction the amount was sourced under — of the ship-to destination
   * actually sent.
   *
   * There is no companion "which address was this" field, and deliberately not:
   * tax is always sourced to ship-to, so a column recording that fact would have
   * one legitimate value. The address itself lives once, on `OrderBuyerSnapshot`,
   * reached through `buyerSnapshotId`.
   */
  jurisdictionCode: TaxJurisdictionCode.nullable(),
  /**
   * The exact Product source version this tax was calculated under (1.6).
   *
   * Nullable for rows written before the fact existed. Pinned, never joined —
   * see the header.
   */
  productSourceRecordId: z.string().min(1).max(191).nullable(),
  productSourceRecordVersion: z.string().min(1).max(64).nullable(),
  productTaxClassification: ProductTaxClassification.nullable(),
  /** The provider code that classification was mapped to, and the map's version. */
  providerTaxCode: z.string().min(1).max(64).nullable(),
  providerConfigVersion: z.string().min(1).max(64).nullable(),
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
 * The first group is **buyer personal data**. Monacado persists a buyer's contact
 * and billing address on `OrderBuyerSnapshot` — one record, deliberately scoped —
 * and this evidence row is not a second copy of it. The linkage is
 * `buyerSnapshotId`; duplicating the address here would create two answers to
 * "where was this sourced" that can disagree. `1.6` sends a **bounded
 * destination** to the engine and persists none of it beyond the jurisdiction
 * code: a postal code is useful to a rate engine and useless in an audit row that
 * already names the snapshot it came from. Identity documents and tax identifiers
 * remain forbidden outright.
 *
 * The second is **filing and remittance**, whose fields appearing here would mean
 * Monacado had started keeping a return — see `TAX_FILING_BOUNDARY`.
 *
 * The third is **raw provider payloads**, which is where every field nobody
 * agreed to store eventually appears.
 */
export const NEVER_ON_TAX_EVIDENCE = [
  // buyer personal data — no address, and therefore no column for one
  "buyerAddress",
  "shippingAddress",
  "billingAddress",
  "postalCode",
  "buyerEmail",
  "buyerName",
  "ipAddress",
  "taxIdentificationNumber",
  "vatNumber",
  "exemptionCertificate",
  // filing and remittance — the operator's and the provider's, never a column here
  "filingPeriod",
  "remittedAt",
  "returnId",
  "liabilityAccountId",
  // raw provider payloads — an unbounded blob is where everything ends up
  "rawProviderResponse",
  "providerPayload",
  "taxBreakdown",
  // credentials — the adapter's problem
  "apiKey",
  "accountId",
] as const;

// — Standard retail tax policy —

/**
 * How Monacado treats tax in ordinary retail checkout, as a stated value.
 *
 * Recorded here rather than left in prose so a later reader can check what was
 * claimed against what was built, and so a test can assert that no exemption
 * machinery quietly appeared. **None of it is checkout copy** — this phase
 * displays nothing new to a buyer. The buyer-facing expression of it belongs in
 * Marketplace Policy and Terms material, which is a governed, versioned artifact
 * and not something a tax module writes.
 *
 * ## What Monacado does
 *
 * Calculates and collects applicable tax using the **ship-to jurisdiction** and
 * the governed Product classification and provider mapping. One rule, one source,
 * evidenced per transaction.
 *
 * ## What ordinary checkout does not do
 *
 * **It does not accept buyer exemption credentials to reduce tax.** There is no
 * field for an exemption number, a VAT number, a resale certificate, a buyer
 * exemption state, or an approval workflow — not disabled ones, none. Standard
 * retail checkout is not a venue for adjudicating a buyer's tax status, and a
 * field that existed would imply Monacado had undertaken to verify what was typed
 * into it.
 *
 * A buyer whose own tax status entitles them to relief pursues it through the
 * applicable tax processes — deduction, reclaim, or recovery — with the authority
 * concerned. The transaction evidence Monacado keeps is what such a process needs
 * from a seller.
 *
 * ## What remains possible
 *
 * **Provider-determined non-taxability is ordinary and evidenced.** A zero from
 * the engine for the pinned classification and ship-to jurisdiction is a valid
 * result, not a suspicious one — see `TAX_TREATMENTS` and `taxQuoteIsCoherent`.
 *
 * **Corrections remain available.** Monacado or its providers may process
 * corrections, adjustments, refunds, reporting changes, or other actions required
 * where transaction tax is later determined to have been charged or reported
 * incorrectly, or where governing tax procedures require an adjustment. Stating
 * that is not a claim that any of it is implemented in this phase — refunds and
 * reporting are explicitly out of scope — and no wording here overrides applicable
 * law.
 */
export const MONACADO_RETAIL_TAX_POLICY = {
  /** One source, always. */
  jurisdictionSource: "SHIP_TO",
  /** Both collected on every purchase; ship-to is the tax destination. */
  addressesCollected: ["BILLING", "SHIP_TO"],
  /** No exemption credential is accepted at ordinary checkout. */
  buyerExemptionCredentials: "NOT_ACCEPTED",
  /** No approval workflow exists for a buyer-requested exemption. */
  buyerExemptionWorkflow: "NOT_IMPLEMENTED",
  /** A provider-determined zero is a valid, evidenced outcome. */
  providerDeterminedNonTaxability: "PERMITTED_AND_EVIDENCED",
  /** The buyer's own status is pursued through applicable tax processes. */
  buyerRecovery: "BUYER_RESPONSIBILITY_VIA_TAX_AUTHORITY",
  /** Correction authority is retained; its machinery is a later phase. */
  correctionAuthority: "MONACADO_OR_PROVIDER",
  /** Where the buyer-facing wording lives. Never rendered at checkout here. */
  buyerFacingExpression: "MARKETPLACE_POLICY_AND_TERMS",
} as const;

/**
 * Named as never admissible anywhere in the tax boundary.
 *
 * The exemption vocabulary, stated so a future widening has to argue with a list
 * rather than slip past review. `strictObject` is what actually enforces it.
 */
export const NEVER_A_TAX_EXEMPTION_INPUT = [
  "exemptionNumber",
  "exemptionCertificate",
  "exemptionState",
  "exemptionApproval",
  "vatNumber",
  "taxIdentificationNumber",
  "resaleCertificate",
  "buyerTaxStatus",
] as const;

// — The filing boundary —

/**
 * What Monacado does about filing and remittance in this phase: **nothing**.
 *
 * Stated as a value rather than left in prose, so a later reader can check what
 * was claimed against what was built. `1.6` calculates tax and records why. It
 * does not register Monacado anywhere, does not report a transaction to a tax
 * authority, and does not remit a cent.
 *
 * `providerRecordsTransactions` is `false` and is the one worth understanding:
 * Stripe Tax's reporting and filing products operate on **Tax Transactions**,
 * which are created from a calculation after the payment succeeds. This phase
 * creates none — that is a write into the provider on a confirmed sale, which
 * belongs with the reversal work that shares the same seam, not inside a
 * calculation phase. Until it exists, Stripe Tax's reports do not contain
 * Monacado's sales, and no report should be treated as if they did.
 */
export const TAX_FILING_BOUNDARY = {
  /** Monacado calculates tax through a provider. */
  calculation: "IMPLEMENTED",
  /**
   * Recording the calculation as a provider-side transaction.
   *
   * **`true` since Phase 1.7.** A paid sale's calculation is turned into a Stripe
   * Tax Transaction, so the provider's reports now contain Monacado's sales.
   * That is emphatically **not** filing readiness: `filing` and `remittance`
   * below are unchanged, and somebody still has to be named to submit what those
   * reports show.
   */
  providerRecordsTransactions: true,
  /** Determining where Monacado must collect. Never inferred by this code. */
  nexusDetermination: "OPERATOR_AND_ADVISER",
  /** Where Monacado is registered. Configured in the provider, evidenced here. */
  registration: "OPERATOR_CONFIGURED_IN_PROVIDER",
  /** Filing returns. */
  filing: "NOT_IMPLEMENTED",
  /** Remitting collected tax. */
  remittance: "NOT_IMPLEMENTED",
} as const;
