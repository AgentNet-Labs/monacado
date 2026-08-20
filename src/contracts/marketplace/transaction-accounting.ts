/**
 * MoR transaction accounting foundation (Phase 0M.T1).
 *
 * The **immutable per-sale economic snapshot**: what one sale's money was, bound
 * to the exact authoritative sources that produced it. `0M.9` writes the first
 * real Order and payment against this; Monacado must not create a transactional
 * payment record it cannot account for.
 *
 * Seven properties shape everything below:
 *
 *   1. **A snapshot is an economic fact, not a state machine.** Every field here
 *      is fixed at the instant of sale and never edited afterwards. The things
 *      that legitimately move — has the money arrived, has it settled, what did
 *      the provider call it — live on a *separate* settlement record, so
 *      recording provider evidence can never rewrite what the parties earned.
 *
 *   2. **The binding is exact, and it is structural.** A snapshot names one
 *      `(listingSourceRecordId, listingSourceRecordVersion)`, one
 *      `(offerSourceRecordId, offerSourceRecordVersion)` where the sale was
 *      promoted, and one `(policyId, policyVersion)`. Composite foreign keys onto
 *      the unique keys `0M.6`, `0M.7`, and `0M.R1` already established mean a
 *      snapshot cannot reference a version that does not exist, and none of them
 *      can be deleted beneath it. **Historical economics therefore do not change
 *      when the Listing, the Offer, or the current policy does** — the binding
 *      names a version label, never a current-version pointer.
 *
 *   3. **The economics are calculated, never supplied — and never reimplemented.**
 *      `calculateSellerDirectEconomics` and `calculatePromotedListingEconomics`
 *      are 0M.4A's, consumed unchanged. There is still exactly one implementation
 *      of the MoR, commission, and promoter-spread arithmetic in this repository
 *      and this phase does not add a second. What is stored is the *result*,
 *      exactly as `0M.2A` stores an Offer's accepted economics, and for the same
 *      reason: the numbers the parties transacted on must be reproducible rather
 *      than recalculated under whatever policy is current later.
 *
 *   4. **The accounting identity is checked before the write.** For a promoted
 *      sale, `sellerProceeds + promoterNetProceeds + monacadoRetained =
 *      commercialRetailAmount`; for a seller-direct sale,
 *      `sellerProceeds + monacadoRetained = commercialRetailAmount`. A snapshot
 *      that does not add up to what the buyer was charged is not a snapshot, and
 *      it is refused rather than recorded.
 *
 *   5. **Tax, shipping, and other pass-through amounts are outside the commercial
 *      retail economics.** They are recorded on the snapshot because a future
 *      checkout must be able to state what the buyer was charged in total, and
 *      they enter no basis: not Monacado's retention, not the acquisition amount,
 *      not the seller-funded commission, and not the promoter's margin
 *      (`MONACADO_MOR_BUSINESS_MODEL.md` §G/§H). They are *inputs to this record*
 *      and never inputs to a calculator — structurally, because
 *      `CommercialRetailBasis` has no field for any of them.
 *
 *   6. **The two transaction types are structurally impossible to confuse.** A
 *      seller-direct snapshot has **no field** for an Offer binding, a wholesale
 *      price, a commission, a promoter spread, or promoter proceeds — not "they
 *      are zero", but nowhere to go. The same discriminated-union technique
 *      0M.4A uses for the placement itself.
 *
 *   7. **No tax is calculated, no nexus is determined, and nothing is remitted.**
 *      `0M.T2` owns tax execution. A tax *amount* is recorded here; a tax *rate*,
 *      a jurisdiction, a taxability class, and a filing obligation have no field
 *      and could not be given one without changing these `strictObject`s.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import {
  COMMERCIAL_POLICY_ID_RE,
  INTERNAL_LISTING_ID_RE,
  INTERNAL_OFFER_ID_RE,
  TRANSACTION_ECONOMIC_SNAPSHOT_ID_RE,
} from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { PaymentProvider } from "./payment-account";

// — Identity —

export const TransactionEconomicSnapshotId = z
  .string()
  .regex(TRANSACTION_ECONOMIC_SNAPSHOT_ID_RE, "snapshotId must be mon:txsnp:<opaque>");
export type TransactionEconomicSnapshotId = z.infer<typeof TransactionEconomicSnapshotId>;

/** A minor-unit money amount. Integers only; no floating-point money anywhere. */
const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

/**
 * A signed minor-unit amount.
 *
 * Used for the promoter retail spread alone, which 0M.4A already permits to be
 * negative so long as promoter *net* proceeds are not — a promoter may
 * legitimately sell below the Offer wholesale price when a seller-funded
 * commission covers the difference.
 */
const SignedAmount = z.int().min(-MAX_MINOR_UNIT_AMOUNT).max(MAX_MINOR_UNIT_AMOUNT);

const SourceRecordRef = z.string().min(1).max(191);
const SourceVersionRef = z.string().min(1).max(64);

// — Transaction type —

/**
 * Which shape of sale this was.
 *
 * The same two the Listing already has, and deliberately the same names: a
 * snapshot's type is *read from* the bound Listing source version rather than
 * supplied, so it cannot disagree with the placement that produced it.
 */
export const TRANSACTION_TYPES = ["SELLER_DIRECT", "PROMOTED"] as const;
export const TransactionType = z.enum(TRANSACTION_TYPES);
export type TransactionType = z.infer<typeof TransactionType>;

// — Exact source bindings —

/**
 * The exact Listing source version this sale's retail price came from.
 *
 * `listingSourceRecordVersion` names a version *label*, never a pointer. A later
 * Listing version — a new price, a new sale window, a lifecycle change — mints a
 * new row and leaves this one exactly as it was, so a historical sale reproduces
 * from the terms it actually ran under.
 */
export const ListingSourceBinding = z.strictObject({
  internalListingId: z
    .string()
    .regex(INTERNAL_LISTING_ID_RE, "internalListingId must be mon:listing:<opaque>"),
  listingSourceRecordId: SourceRecordRef,
  /** The EXACT version — never "current", never "latest". */
  listingSourceRecordVersion: SourceVersionRef,
});
export type ListingSourceBinding = z.infer<typeof ListingSourceBinding>;

/**
 * The exact Offer source version a promoted sale's wholesale economics came from.
 *
 * Present on the promoted arm only. The Offer remains authoritative for its own
 * wholesale price and seller-funded commission; this records *which* version was
 * authoritative, so a seller who later changes either does not retroactively
 * change what a completed sale paid out.
 */
export const OfferSourceBinding = z.strictObject({
  internalOfferId: z
    .string()
    .regex(INTERNAL_OFFER_ID_RE, "internalOfferId must be mon:offer:<opaque>"),
  offerSourceRecordId: SourceRecordRef,
  /** The EXACT version — never "current", never "latest". */
  offerSourceRecordVersion: SourceVersionRef,
});
export type OfferSourceBinding = z.infer<typeof OfferSourceBinding>;

/**
 * The exact commercial policy version this sale's retention was computed under.
 *
 * `0M.R1` made this a pair that names a persisted, immutable row and stays
 * resolvable after the rate changes. A `RETIRED` version resolves normally —
 * that is the whole point, because by the time anyone reconstructs a historical
 * sale the version it ran under usually is retired.
 */
export const CommercialPolicyBinding = z.strictObject({
  policyId: z.string().regex(COMMERCIAL_POLICY_ID_RE, "policyId must be mon:cpol:<opaque>"),
  /** The EXACT version — never the effective one. */
  policyVersion: SourceVersionRef,
});
export type CommercialPolicyBinding = z.infer<typeof CommercialPolicyBinding>;

// — Pass-through charges —

/**
 * What the buyer was charged **outside** the commercial retail economics.
 *
 * Recorded so a future checkout can state the buyer's total, and structurally
 * outside every basis: no calculator in this repository accepts any of these,
 * because `CommercialRetailBasis` is the merchandise price alone and has no
 * field for them.
 *
 * Amounts only. There is deliberately no tax rate, no jurisdiction, no
 * taxability class, no nexus determination, no exemption certificate, no
 * carrier, no service level, and no remittance state — `0M.T2` owns tax
 * execution and a column for any of it here would be that phase started early.
 *
 * `otherPassThroughAmountMinorUnits` covers the "permitted pass-through" the
 * business model's checkout decomposition names (§H). It is a single amount
 * rather than a line-item table: itemising a buyer's charges is checkout's
 * subject, and this phase records the accounting total.
 */
export const TransactionPassThroughAmounts = z.strictObject({
  /** Recorded, never calculated here. 0M.T2 owns calculation and remittance. */
  taxAmountMinorUnits: Amount,
  shippingAmountMinorUnits: Amount,
  otherPassThroughAmountMinorUnits: Amount,
});
export type TransactionPassThroughAmounts = z.infer<typeof TransactionPassThroughAmounts>;

/**
 * The pass-through fields, named so a test can assert none of them reaches a
 * commercial basis. Asserted, not merely documented.
 */
export const PASS_THROUGH_AMOUNT_FIELDS = [
  "taxAmountMinorUnits",
  "shippingAmountMinorUnits",
  "otherPassThroughAmountMinorUnits",
] as const;

// — Economics, as a discriminated union —

/**
 * The economics of one seller-direct sale.
 *
 * No Offer and no promoter are involved, so the seller receives the whole
 * acquisition amount. There is **no field** for a wholesale price, a commission,
 * a spread, or promoter proceeds: a seller selling their own product has no
 * promoter counterparty, and a zero in those columns would imply one who earned
 * nothing rather than one who does not exist.
 */
export const SellerDirectTransactionEconomics = z.strictObject({
  transactionType: z.literal("SELLER_DIRECT"),
  monacadoRetainedAmountMinorUnits: Amount,
  morWholesaleAcquisitionAmountMinorUnits: Amount,
  /** With no Offer in play, the whole acquisition amount. */
  sellerProceedsMinorUnits: Amount,
});
export type SellerDirectTransactionEconomics = z.infer<
  typeof SellerDirectTransactionEconomics
>;

/**
 * The economics of one promoted sale.
 *
 * Three layers, each keeping its own name (`MONACADO_MOR_BUSINESS_MODEL.md` §D).
 * `offerWholesalePriceMinorUnits` is what the seller contracted to be owed;
 * `morWholesaleAcquisitionAmountMinorUnits` is what Monacado paid the supply side
 * out of retail. They are different economic layers and are never called by the
 * same name.
 */
export const PromotedTransactionEconomics = z.strictObject({
  transactionType: z.literal("PROMOTED"),
  /** The exact Offer version the wholesale economics came from. */
  offerBinding: OfferSourceBinding,

  monacadoRetainedAmountMinorUnits: Amount,
  morWholesaleAcquisitionAmountMinorUnits: Amount,

  /** The Offer's contracted wholesale price. NOT the acquisition amount. */
  offerWholesalePriceMinorUnits: Amount,
  /** Seller-funded, computed by the Offer and carried here unchanged. */
  sellerFundedCommissionMinorUnits: Amount,

  /** `acquisition − offerWholesale`. May be negative; promoter *net* may not. */
  promoterRetailSpreadMinorUnits: SignedAmount,
  /** `spread + commission`. The authoritative promoter figure. */
  promoterNetProceedsMinorUnits: Amount,

  /** `offerWholesale − commission`. The seller's own contracted proceeds. */
  sellerProceedsMinorUnits: Amount,
});
export type PromotedTransactionEconomics = z.infer<typeof PromotedTransactionEconomics>;

export const TransactionEconomics = z.discriminatedUnion("transactionType", [
  SellerDirectTransactionEconomics,
  PromotedTransactionEconomics,
]);
export type TransactionEconomics = z.infer<typeof TransactionEconomics>;

// — Errors —

export class TransactionAccountingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TransactionAccountingError";
    this.code = code;
  }
}

// — The accounting identity —

/**
 * The commercial identity every snapshot must satisfy, checked before any write.
 *
 * ```
 * promoted:        sellerProceeds + promoterNetProceeds + monacadoRetained = R
 * seller-direct:   sellerProceeds +                       monacadoRetained = R
 * ```
 *
 * plus, on both arms, `acquisition + monacadoRetained = R` — the MoR layer's own
 * identity, which is what makes "Monacado's retention is taken exactly once,
 * inside the acquisition amount" a checked fact rather than a described one.
 *
 * **Tax, shipping, and other pass-through amounts appear nowhere in it.** They
 * are not part of what the three parties divide, and folding them in would
 * enlarge somebody's share of money that was never commercial revenue.
 *
 * 0M.4A's `calculatePromotedListingEconomics` already asserts the promoted
 * identity on the way out. This checks it again on the way *in* to storage,
 * because a snapshot is the record everything downstream reconciles against and
 * an unbalanced one must never reach a row.
 */
export function reconcileTransactionEconomics(input: {
  commercialRetailAmountMinorUnits: number;
  economics: TransactionEconomics;
}): void {
  const economics = TransactionEconomics.parse(input.economics);
  const retail = input.commercialRetailAmountMinorUnits;

  if (
    economics.morWholesaleAcquisitionAmountMinorUnits +
      economics.monacadoRetainedAmountMinorUnits !==
    retail
  ) {
    throw new TransactionAccountingError(
      "ACQUISITION_IMBALANCE",
      "the acquisition amount and Monacado's retained amount do not sum to the commercial retail amount",
    );
  }

  if (economics.transactionType === "SELLER_DIRECT") {
    if (
      economics.sellerProceedsMinorUnits + economics.monacadoRetainedAmountMinorUnits !==
      retail
    ) {
      throw new TransactionAccountingError(
        "RECONCILIATION_IMBALANCE",
        "seller and Monacado amounts do not sum to the commercial retail amount",
      );
    }
    return;
  }

  /* The components are checked BEFORE the three-party sum, and the order matters.
     The promoter's two parts answer to different parties and move independently
     (MONACADO_MOR_BUSINESS_MODEL.md §D). Checking the sum first would report a
     wrong spread as one generic imbalance and lose which figure was wrong — and
     the sum alone cannot distinguish a spread and a commission that are each
     wrong but happen to add up. */
  if (
    economics.promoterRetailSpreadMinorUnits !==
    economics.morWholesaleAcquisitionAmountMinorUnits -
      economics.offerWholesalePriceMinorUnits
  ) {
    throw new TransactionAccountingError(
      "PROMOTER_SPREAD_IMBALANCE",
      "the promoter retail spread is not the acquisition amount less the Offer wholesale price",
    );
  }
  if (
    economics.promoterNetProceedsMinorUnits !==
    economics.promoterRetailSpreadMinorUnits + economics.sellerFundedCommissionMinorUnits
  ) {
    throw new TransactionAccountingError(
      "PROMOTER_NET_IMBALANCE",
      "promoter net proceeds are not the retail spread plus the seller-funded commission",
    );
  }
  if (
    economics.sellerProceedsMinorUnits !==
    economics.offerWholesalePriceMinorUnits - economics.sellerFundedCommissionMinorUnits
  ) {
    throw new TransactionAccountingError(
      "SELLER_PROCEEDS_IMBALANCE",
      "seller proceeds are not the Offer wholesale price less the seller-funded commission",
    );
  }

  /* The identity itself, last: with every component checked it is a restatement
     rather than a discovery, and a failure here would mean the arithmetic of the
     components does not close over retail — which must still never reach a row. */
  if (
    economics.sellerProceedsMinorUnits +
      economics.promoterNetProceedsMinorUnits +
      economics.monacadoRetainedAmountMinorUnits !==
    retail
  ) {
    throw new TransactionAccountingError(
      "RECONCILIATION_IMBALANCE",
      "seller, promoter, and Monacado amounts do not sum to the commercial retail amount",
    );
  }
}

// — The record —

/**
 * One immutable per-sale economic snapshot.
 *
 * Note what has no field, and could not be given one without changing this
 * `strictObject`: a settlement state, a provider transaction reference, a payout
 * identifier, a refund or chargeback amount, a tax rate, a jurisdiction, a buyer
 * identity, a buyer address, a card or bank detail, a risk score, or a free-text
 * note. The first two live on the *settlement* record because they legitimately
 * change; the rest belong to `0M.T2`, `0M.R2`, or nowhere.
 */
export const TransactionEconomicSnapshotRecord = z.strictObject({
  snapshotId: TransactionEconomicSnapshotId,

  // — Exact historical binding —
  listingBinding: ListingSourceBinding,
  policyBinding: CommercialPolicyBinding,

  // — Commercial retail economics —
  /**
   * The commercial retail amount the buyer was charged for the merchandise
   * alone — the effective price at `occurredAt`, so a seller-direct sale inside a
   * scheduled sale window records the sale price. Tax, shipping, and other
   * pass-through amounts are **not** in it.
   */
  commercialRetailAmountMinorUnits: Amount,
  /** One currency for the whole transaction. Checked, never coerced. */
  currency: CurrencyCode,
  economics: TransactionEconomics,

  // — Outside the commercial economics —
  passThrough: TransactionPassThroughAmounts,

  /** The instant of sale the economics were computed at. Supplied, never a clock read. */
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
});
export type TransactionEconomicSnapshotRecord = z.infer<
  typeof TransactionEconomicSnapshotRecord
>;

/**
 * What the buyer was charged in total.
 *
 * **Derived, never stored** — the same rule that keeps an effective price out of
 * the Listing tables. A stored total is a second answer that can disagree with
 * the four amounts it sums, and the four are the authoritative ones.
 */
export function buyerChargedTotalMinorUnits(
  snapshot: Pick<
    TransactionEconomicSnapshotRecord,
    "commercialRetailAmountMinorUnits" | "passThrough"
  >,
): number {
  return (
    snapshot.commercialRetailAmountMinorUnits +
    snapshot.passThrough.taxAmountMinorUnits +
    snapshot.passThrough.shippingAmountMinorUnits +
    snapshot.passThrough.otherPassThroughAmountMinorUnits
  );
}

// — Settlement —

/**
 * Where the money for one snapshot has got to.
 *
 * Deliberately generic and provider-neutral: four states, and no more. Nothing
 * here is Stripe-shaped, and nothing names a payout, a transfer, a balance, or a
 * schedule.
 *
 *   - `PENDING` — the economics are recorded; no funds evidence exists yet.
 *   - `FUNDS_RECEIVED` — the provider reports the buyer's funds were captured.
 *   - `SETTLED` — the transaction is closed out for accounting purposes.
 *   - `REVERSED` — the funds movement was undone or never completed.
 *
 * **`REVERSED` is a state, not a workflow.** It records that the money went back
 * and nothing else: there is no reversal amount, no partial reversal, no
 * recovery from seller or promoter economics, no representment evidence, and no
 * refund or chargeback distinction. That accounting is `0M.T2`
 * (`MONACADO_MOR_BUSINESS_MODEL.md` §I), and it will be recorded as its own
 * entry rather than by editing this one — which is exactly why the state exists
 * now: provider reversal evidence arriving must not require rewriting a
 * financial row's schema.
 */
export const TRANSACTION_SETTLEMENT_STATES = [
  "PENDING",
  "FUNDS_RECEIVED",
  "SETTLED",
  "REVERSED",
] as const;
export const TransactionSettlementState = z.enum(TRANSACTION_SETTLEMENT_STATES);
export type TransactionSettlementState = z.infer<typeof TransactionSettlementState>;

export const INITIAL_TRANSACTION_SETTLEMENT_STATE: TransactionSettlementState = "PENDING";

/**
 * Valid settlement transitions, as an exhaustive table.
 *
 * Forward-only along the funds path, with `REVERSED` reachable from every
 * non-terminal state because a provider may undo a capture before or after
 * Monacado closes the transaction out. Nothing returns: a reversal that could be
 * un-reversed would misrepresent a second funds movement as the first, and
 * "received again" is a new transaction rather than a row that changed its mind.
 */
export const TRANSACTION_SETTLEMENT_TRANSITIONS: Record<
  TransactionSettlementState,
  readonly TransactionSettlementState[]
> = Object.freeze({
  PENDING: ["FUNDS_RECEIVED", "REVERSED"],
  FUNDS_RECEIVED: ["SETTLED", "REVERSED"],
  SETTLED: ["REVERSED"],
  REVERSED: [],
});

export function isValidTransactionSettlementTransition(
  from: TransactionSettlementState,
  to: TransactionSettlementState,
): boolean {
  return TRANSACTION_SETTLEMENT_TRANSITIONS[from].includes(to);
}

export function isTerminalTransactionSettlementState(
  state: TransactionSettlementState,
): boolean {
  return TRANSACTION_SETTLEMENT_TRANSITIONS[state].length === 0;
}

// — Provider transaction reference —

/**
 * Shapes a provider transaction reference must never take.
 *
 * The same two refusals `ProviderAccountRef` makes (0M.8), for the same two
 * mistakes: a `mon:` value would mean a Monacado identity had been stored as an
 * external one, and a `sk_`/`whsec_`/bearer value would mean a credential had
 * been pasted where a reference belongs. A backstop, not the guarantee — the
 * guarantee is that no column for a credential exists at all.
 */
const FORBIDDEN_PROVIDER_TRANSACTION_REF_PREFIXES: readonly string[] = [
  "mon:",
  "sk_",
  "rk_",
  "pk_live_",
  "whsec_",
  "bearer ",
  "basic ",
];

/**
 * An opaque external identifier for the transaction at the payment provider.
 *
 * Persisted for exactly one purpose: reconciling Monacado's snapshot against the
 * provider's own record when reconciliation is implemented. It is **not** a Node,
 * **not** a capsule identity, **not** public identity, and never published.
 * Monacado's economics are never inferred from it — the snapshot is authoritative
 * and this string is a payload.
 *
 * No provider SDK, credential, endpoint, or API call exists in this phase.
 */
export const ProviderTransactionRef = z
  .string()
  .min(1)
  .max(191)
  .refine((v) => v.trim() === v, "providerTransactionRef must not carry surrounding whitespace")
  .refine(
    (v) =>
      !FORBIDDEN_PROVIDER_TRANSACTION_REF_PREFIXES.some((p) => v.toLowerCase().startsWith(p)),
    "providerTransactionRef must be an opaque external reference, never a Monacado identifier or a provider secret",
  );
export type ProviderTransactionRef = z.infer<typeof ProviderTransactionRef>;

/**
 * The mutable half, kept deliberately apart from the immutable economics.
 *
 * One settlement record per snapshot. Splitting the two is what makes
 * "economic facts are not editable in place" enforceable rather than aspirational:
 * every legitimate update targets this table, and the snapshot table has no
 * update path at all.
 */
export const TransactionSettlementRecord = z.strictObject({
  snapshotId: TransactionEconomicSnapshotId,
  state: TransactionSettlementState,

  /** Both null until provider evidence exists, and always set together. */
  provider: PaymentProvider.nullable(),
  providerTransactionRef: ProviderTransactionRef.nullable(),
  providerReferenceRecordedAt: z.iso.datetime().nullable(),

  fundsReceivedAt: z.iso.datetime().nullable(),
  settledAt: z.iso.datetime().nullable(),
  reversedAt: z.iso.datetime().nullable(),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TransactionSettlementRecord = z.infer<typeof TransactionSettlementRecord>;

// — Inputs —

/**
 * Record one sale's economics from persisted sources.
 *
 * **The retail price is not a parameter.** It is read from the bound Listing
 * source version at `occurredAt` — so a seller-direct sale inside a scheduled
 * window prices at the sale price without anyone passing it, and no caller can
 * invent a price the Listing never offered. The transaction type, the Offer
 * binding, the wholesale price, and the seller-funded commission are read the
 * same way, from the versions the Listing itself binds to.
 *
 * The pass-through amounts have **no defaults**. A defaulted zero tax is exactly
 * the silent thing this phase must not do: a caller records what was charged,
 * explicitly, or it does not record a sale.
 */
export const RecordTransactionEconomicSnapshotInput = z.strictObject({
  internalListingId: z
    .string()
    .regex(INTERNAL_LISTING_ID_RE, "internalListingId must be mon:listing:<opaque>"),
  /** The EXACT Listing source version. Never "current". */
  listingSourceRecordVersion: SourceVersionRef,

  /** The EXACT commercial policy version. Never "the effective one". */
  policyId: z.string().regex(COMMERCIAL_POLICY_ID_RE, "policyId must be mon:cpol:<opaque>"),
  policyVersion: SourceVersionRef,

  /** Checked against the Listing's retail currency and the policy's. Never coerced. */
  currency: CurrencyCode,

  /** Recorded, never calculated. Required — see above. */
  taxAmountMinorUnits: Amount,
  shippingAmountMinorUnits: Amount,
  otherPassThroughAmountMinorUnits: Amount,

  /** The instant of sale. Prices the effective seller retail price. */
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
});
export type RecordTransactionEconomicSnapshotInput = z.infer<
  typeof RecordTransactionEconomicSnapshotInput
>;

/**
 * Attach the provider's own transaction reference.
 *
 * Provider and reference are supplied together because a reference without its
 * counterparty is unreconcilable — and reconciling a reference against the wrong
 * provider is the mistake naming it prevents (0M.8's reasoning, unchanged).
 *
 * Write-once. A recorded reference is evidence of which external transaction
 * this snapshot is, and replacing it would silently re-point a financial record
 * at a different one.
 */
export const RecordProviderTransactionReferenceInput = z.strictObject({
  snapshotId: TransactionEconomicSnapshotId,
  provider: PaymentProvider,
  providerTransactionRef: ProviderTransactionRef,
  recordedAt: z.iso.datetime(),
});
export type RecordProviderTransactionReferenceInput = z.infer<
  typeof RecordProviderTransactionReferenceInput
>;

export const AdvanceTransactionSettlementInput = z.strictObject({
  snapshotId: TransactionEconomicSnapshotId,
  to: TransactionSettlementState,
  at: z.iso.datetime(),
});
export type AdvanceTransactionSettlementInput = z.infer<
  typeof AdvanceTransactionSettlementInput
>;

// — Never on a transaction snapshot —

/**
 * Named as never-persistable on the economic snapshot, and not admissible
 * through any input above.
 *
 * Four groups, for four different reasons:
 *
 *   - **Tax execution** — `0M.T2`. A rate, a jurisdiction, a nexus finding, or a
 *     remittance state here would be that phase started early, and would make a
 *     tax position look decided when no engine exists.
 *   - **Reversal accounting** — also `0M.T2`. A refund or chargeback is its own
 *     entry, never an edit to what a completed sale earned.
 *   - **Payouts** — `0M.9` and beyond. *When* each party is paid is a payment
 *     operation; this record says what each party is owed.
 *   - **Private buyer and risk data** — nowhere near a financial fact row, and
 *     never public capsule content (ADR §11.10, business model §G/§K).
 */
export const NEVER_ON_TRANSACTION_ECONOMIC_SNAPSHOT = [
  // tax execution — 0M.T2
  "taxRate",
  "taxRateBasisPoints",
  "taxJurisdiction",
  "taxNexus",
  "taxabilityClass",
  "taxRegistrationId",
  "taxExemptionCertificate",
  "taxRemittedAt",
  "taxFilingId",
  // reversal accounting — 0M.T2
  "refundAmountMinorUnits",
  "chargebackAmountMinorUnits",
  "reversalAmountMinorUnits",
  "representmentEvidence",
  // payouts — 0M.9 and later
  "payoutId",
  "payoutScheduledAt",
  "payoutBatchId",
  "reserveAmountMinorUnits",
  // private buyer, payment, and risk data — never here
  "buyerAccountId",
  "buyerEmail",
  "buyerAddress",
  "buyerIpAddress",
  "cardLast4",
  "cardFingerprint",
  "bankAccountNumber",
  "providerApiKey",
  "riskScore",
  "riskClassification",
  // derived values that must stay derived
  "buyerChargedTotalMinorUnits",
  "effectiveRetailPriceMinorUnits",
  "saleActive",
  "promoterMarginRateBasisPoints",
] as const;

/**
 * Named so the boundary of this phase is recorded rather than remembered.
 *
 * Every item is a thing a reader might reasonably expect a "transaction
 * accounting" phase to contain, and none of it is here.
 */
export const DEFERRED_TRANSACTION_ACCOUNTING_EXTENSIONS = [
  // 0M.9
  "order and order-line records",
  "checkout",
  "payment initiation",
  "payout execution",
  // 0M.T2
  "tax calculation",
  "nexus determination",
  "tax remittance and filing",
  "refund and chargeback accounting",
  "processor reconciliation workflows",
  "double-entry ledger postings",
  // 0M.R2
  "risk-adjusted policy selection",
  "reserves and payout holds",
] as const;
