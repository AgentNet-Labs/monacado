/**
 * Executable checkout (Phase 1.0) — SERVER ONLY.
 *
 * The two operations that turn `0M.9`'s provider-neutral flow into a purchase a
 * real buyer can complete, and **no third thing**:
 *
 *   - `beginCheckout` — place the Order, then ask the provider to start a
 *     payment. Both steps are `0M.9`'s and `1.0`'s existing functions; this
 *     composes them and adds no economics.
 *   - `finalizeConfirmedPayment` — take one authoritative provider confirmation
 *     and hand it to `recordPaymentResult` unchanged.
 *
 * What this module deliberately does **not** contain:
 *
 *   - **No pricing.** The retail price, the effective commercial policy, the
 *     retention, the seller's proceeds, the promoter's spread, and the buyer's
 *     total are all `prepareCheckout` and `0M.T1`'s, computed from bound
 *     authoritative versions. Nothing here adds, adjusts, or re-derives an
 *     amount, and there is no parameter through which a caller could supply one.
 *   - **No second finalization path.** `recordPaymentResult` performs the atomic
 *     write — snapshot, settlement, proceeds obligations, purchase evidence,
 *     notification obligations, `PAID` — and this module calls it exactly once.
 *   - **No event framework.** One confirmation in, one bounded disposition out.
 *
 * ## Ordering, and why the Order is written first
 *
 * `placeOrder` commits before any provider is contacted, exactly as `0M.9`
 * designed. If session creation then fails, or the process dies, what survives is
 * a `PENDING_PAYMENT` Order naming precisely what was being bought — recoverable
 * by a human or a later reconciliation — rather than a Stripe payment nobody can
 * attach to anything.
 */

import "../server-only";
import {
  prepareCheckout,
  cancelOrder,
  getOrder,
  initiateOrderPayment,
  placeOrder,
  recordPaymentResult,
  type CompletedSale,
  type OrderServiceDeps,
} from "../marketplace/order-service";
import type {
  BuyerPaymentConfirmation,
  BuyerPaymentInitiation,
  BuyerPaymentInitiationPort,
} from "../../contracts/marketplace/buyer-payment";
import { PlaceOrderInput, type OrderRecord } from "../../contracts/marketplace/order";
import type { PaymentProvider } from "../../contracts/marketplace/payment-account";
import type {
  TaxCalculationPort,
  TaxQuote,
} from "../../contracts/marketplace/tax-calculation";
import { riskAllowed, type RiskDecision } from "../../contracts/marketplace/transaction-risk";
import { evaluateTransactionRisk } from "../risk/transaction-risk-service";
import { assertPartiesMayTransact } from "../marketplace/participant-standing-service";
import { TransactionDeniedByRiskError } from "../risk/risk-errors";
import { recordOrderTaxEvidence } from "../tax/tax-evidence-service";
import { taxCalculationIdempotencyKey } from "../tax/tax-idempotency";
import { ProductTaxClassificationMissingError } from "../tax/tax-errors";
import { resolveProductTaxFacts } from "../product/product-tax-facts-service";
import { taxClassificationAgreesWithDelivery } from "../../contracts/product/product-tax-classification";
import { resolveTaxDestination } from "../../contracts/marketplace/tax-destination";
import {
  BasketFulfillmentError,
  evaluateBasketFulfillment,
  type BasketFulfillmentRequirement,
} from "../../contracts/marketplace/basket-fulfillment";
import { resolveBasketDeliveryLines } from "../product/product-delivery-mode-service";
import { getPrisma } from "../db/client";
import { getActiveMarketplacePolicyVersionIn } from "../policy/marketplace-policy-service";
import { resolveSellerSupportContactIn } from "../policy/support-contact-service";
import { getActiveSellerRefundPolicyVersionIn } from "../marketplace/seller-refund-policy-service";
import { MONACADO_MARKETPLACE_POLICY_ID } from "../../contracts/marketplace/marketplace-policy-content";
import {
  BuyerCheckoutDetailsInput,
  ShipToAddressRequiredError,
  resolveShipToAddress,
  type OrderBuyerSnapshotRecord,
} from "../../contracts/marketplace/order-buyer-snapshot";
import {
  BuyerSnapshotError,
  captureBuyerSnapshot,
  type BuyerSnapshotIdProvider,
} from "../marketplace/order-buyer-snapshot-service";
import type { TaxEvidenceIdProvider } from "../tax/tax-calculation-ids";
import {
  InvalidOrderInputError,
  MarketplacePolicyUnavailableError,
  SellerRefundPolicyUnavailableError,
  SellerSupportContactUnavailableError,
} from "../marketplace/order-errors";

/** An Order placed and a payment started, ready for the buyer to complete. */
export interface BegunCheckout {
  order: OrderRecord;
  /**
   * Returned **once**, for a guest Order only, and stored nowhere.
   *
   * `0M.9`'s rule, unchanged: Monacado kept only the digest and cannot re-issue
   * it. The caller must hand it to the buyer.
   */
  guestClaimCode: string | null;
  buyerTotalMinorUnits: number;
  initiation: BuyerPaymentInitiation;
  /** Phase 1.2 — the decision that permitted this, and the policy behind it. */
  riskDecision: RiskDecision;
  /** Phase 1.2 — the authoritative tax result the buyer total includes. */
  taxQuote: TaxQuote;
  /** Phase 1.2 — who is buying. Private transactional data, never published. */
  buyerSnapshot: OrderBuyerSnapshotRecord;
  /** Phase 1.2 — what this basket needed delivered, and why. */
  fulfillment: BasketFulfillmentRequirement;
}

/**
 * Place an Order and start its payment.
 *
 * `policyId` names *which* Monacado commercial policy applies; its effective
 * version is resolved by `prepareCheckout`. Per-transaction policy selection
 * remains `0M.R2`'s subject and is not introduced here.
 */
export async function beginCheckout(
  input: unknown,
  policyId: string,
  args: {
    provider: PaymentProvider;
    port: BuyerPaymentInitiationPort;
    /** Phase 1.2 — required. There is no untaxed path. */
    taxPort: TaxCalculationPort;
    /** Phase 1.2 — required. There is no ungated path. */
    riskPolicyId: string;
    /**
     * Phase 1.2 correction — required. Completing a purchase is not anonymous.
     *
     * Account login stays optional; this does not make a buyer an account holder
     * and creates neither an `Account` nor a `MarketplaceParticipant`.
     */
    buyerDetails: unknown;
  },
  deps: OrderServiceDeps & {
    taxIds?: TaxEvidenceIdProvider;
    buyerSnapshotIds?: BuyerSnapshotIdProvider;
  } = {},
): Promise<BegunCheckout> {
  const parsed = PlaceOrderInput.safeParse(input);
  if (!parsed.success) throw new InvalidOrderInputError(["(root)"]);
  const v = parsed.data;

  /* Buyer details are validated BEFORE anything else runs. Completing a purchase
     is not anonymous, and discovering that only after pricing and gating would
     mean doing all that work for a checkout that cannot complete. */
  const detailsParsed = BuyerCheckoutDetailsInput.safeParse(args.buyerDetails);
  if (!detailsParsed.success) {
    throw new BuyerSnapshotError(
      "INVALID_DETAILS",
      "Buyer checkout details are missing or malformed",
    );
  }
  const details = detailsParsed.data;

  /* — 1. Price, from authoritative state. Writes nothing. — */
  const prepared = await prepareCheckout(v, policyId, deps);

  /* — 2. Risk gate, BEFORE anything is written. —
   *
   * Denying here rather than after `placeOrder` is deliberate: a denied
   * transaction leaves NO Order behind. A table of PENDING_PAYMENT rows that
   * were never allowed to proceed is a table nobody can interpret later. */
  const decision = await evaluateTransactionRisk(
    {
      currency: prepared.quote.currency,
      commercialRetailAmountMinorUnits:
        prepared.quote.quotedCommercialRetailAmountMinorUnits,
      sellerParticipantId: prepared.sellerParticipantId,
      promoterParticipantId: prepared.promoterParticipantId,
      /* On a promoted placement the promoter owns the storefront, so the
         promoter's clearance is the one exposure has always been about. */
      storefrontOwnerParticipantId:
        prepared.promoterParticipantId ?? prepared.sellerParticipantId,
    },
    args.riskPolicyId,
    v.placedAt,
    deps,
  );
  if (!riskAllowed(decision)) {
    throw new TransactionDeniedByRiskError(decision.reasonCodes);
  }

  /* — 2a. Participant standing, BEFORE anything is written. —
   *
   * The seam Phase 1.15 added, and it is separate from the risk gate above on
   * purpose. `RiskPolicy` decides whether a TRANSACTION is one Monacado will
   * take — an amount ceiling, a currency — and two of its checks are booleans on
   * a versioned policy row. Whether a PARTY may do new commerce at all is not a
   * property of a transaction and must not be tunable by activating a different
   * risk policy version, so it is asked here, unconditionally, against governed
   * records only.
   *
   * Every party, not just the Listing's controller. On a promoted sale the
   * controller is the promoter, so before this the Offer's seller — whose goods
   * are sold, and who is owed proceeds — was checked by nothing that could see a
   * suspension. A suspended seller sold indefinitely through any promoted
   * Listing.
   *
   * Each party is judged on their own records and in their own role. No
   * enforcement is inferred across parties: a restriction on the seller is not a
   * restriction on the promoter, and a Seller×Promoter risk anomaly is evidence
   * about a relationship, never a decision against someone. */
  await assertPartiesMayTransact(deps.db ?? getPrisma(), [
    { participantId: prepared.sellerParticipantId, role: "SELLER" },
    ...(prepared.promoterParticipantId === null
      ? []
      : [{ participantId: prepared.promoterParticipantId, role: "PROMOTER" as const }]),
  ]);

  /* — 2b. Commerce readiness, BEFORE tax and BEFORE anything is written. —
   *
   * Two conditions Monacado must be able to satisfy for the sale to be one it
   * can stand behind afterwards. Both are checked here rather than after
   * `placeOrder` for the reason the risk gate is: a refused transaction must
   * leave NO Order behind, and neither condition is worth an external tax call.
   *
   * ## Governing terms
   *
   * WHICH TERMS govern this purchase, as distinct from which FEES do. Resolved
   * before the Order exists and bound to it immediately after, so a receipt
   * opened next year shows the disclosures that actually applied rather than
   * whichever version happens to be current when it is opened.
   *
   * With no ACTIVE version the sale is **refused**. Monacado is merchant of
   * record: selling under terms it cannot afterwards name is worse than not
   * selling, because the resulting Order is an unanswerable question rather than
   * a missing one. This is also what stops a retirement from silently leaving
   * commerce ungoverned — there is no window in which sales continue unbound.
   *
   * ## A reachable seller
   *
   * Activation already requires a verified support contact, but a mailbox can
   * stop working the day after. Checked again per transaction because the harm
   * lands per transaction: a buyer with a problem and no destination for it.
   *
   * The precedence — verified dedicated, else verified primary, else nothing —
   * is NOT restated here. Checkout asks the canonical resolver a yes/no question
   * and never learns the address; a second copy of the rule would be a second
   * chance to disclose the wrong mailbox. */
  const db = deps.db ?? getPrisma();

  const activePolicy = await getActiveMarketplacePolicyVersionIn(
    db,
    MONACADO_MARKETPLACE_POLICY_ID,
  );
  if (activePolicy === null) {
    throw new MarketplacePolicyUnavailableError();
  }

  /* Resolved ONCE, and the resolved VALUE is kept (Phase 1.9 correction).
   *
   * `1.2` asked the canonical resolver a yes/no question and deliberately never
   * learned the address, so a second copy of the precedence rule could not exist.
   * That reasoning is unchanged — this still asks the same single resolver and
   * still reimplements nothing — but the answer is now retained, because the
   * receipt must record WHICH CONTACT THE BUYER WAS TOLD ABOUT, and that cannot
   * be reconstructed later from a seller who has since changed it.
   *
   * Fail-closed behaviour is untouched: no usable contact still refuses the sale. */
  const supportContact = await resolveSellerSupportContactIn(
    db,
    prepared.sellerParticipantId,
  );
  if (!supportContact.available) {
    throw new SellerSupportContactUnavailableError();
  }

  /* — 2b². The seller's refund terms (Phase 1.9 correction). —
   *
   * A sale is refund-governed, so it binds the EXACT seller refund-policy version
   * in force right now. A buyer must be able to see the applicable terms before
   * completing purchase, and the receipt must render the same ones afterwards —
   * neither is possible for an Order that bound nothing.
   *
   * With no ACTIVE version the sale is REFUSED, on the identical reasoning that
   * refuses a sale with no active marketplace policy: selling under returns terms
   * Monacado cannot afterwards name is worse than not selling, because the
   * resulting Order is an unanswerable question rather than a missing one. It is
   * also what stops a seller retiring their policy from silently leaving their
   * commerce ungoverned.
   *
   * The version is bound, never the prose. A copied paragraph would be a second
   * answer able to disagree with the version the buyer was shown — and the copy
   * is always the one that gets read. */
  const activeRefundPolicy = await getActiveSellerRefundPolicyVersionIn(
    db,
    prepared.sellerParticipantId,
  );
  if (activeRefundPolicy === null) {
    throw new SellerRefundPolicyUnavailableError();
  }

  /* — 2c. The Product facts a real engine needs (Phase 1.6). —
   *
   * Read BEFORE the engine is called, and from the authoritative source version
   * the Product currently points at — never inferred from a name, a category, a
   * specification, or the delivery mode.
   *
   * An unclassified Product REFUSES, here, without contacting the provider. That
   * is the phase's most important refusal: every alternative is a guess, and a
   * guessed tax category is a rate nobody chose. It fails before any Order
   * exists, so a refused checkout leaves nothing behind. */
  const productTaxFacts = await resolveProductTaxFacts(db, prepared.internalProductId);
  if (productTaxFacts === null || productTaxFacts.deliveryMode === null) {
    /* The delivery question is asked HERE now, earlier than `1.2` asked it,
       because a tax engine needs the same fact. Its refusal keeps `1.2`'s error
       identity rather than gaining a second name for one condition — and it now
       lands before any Order is written, which is strictly better. */
    throw new BasketFulfillmentError(
      "DELIVERY_MODE_UNKNOWN",
      "This product does not declare how it is delivered, so checkout cannot proceed",
      [prepared.internalProductId],
    );
  }
  if (productTaxFacts.taxClassification === null) {
    throw new ProductTaxClassificationMissingError(prepared.internalProductId);
  }
  if (
    !taxClassificationAgreesWithDelivery(
      productTaxFacts.taxClassification,
      productTaxFacts.deliveryMode,
    )
  ) {
    /* A PHYSICAL_GOOD delivered digitally is a data-entry error, and the two
       facts it contradicts are the two a tax engine is about to be told. Refusing
       is cheaper than a rate computed from a contradiction nobody noticed. */
    throw new ProductTaxClassificationMissingError(prepared.internalProductId);
  }

  /* — 2d. The ship-to address, and therefore the tax destination. —
   *
   * **Every completed transaction has one**, digital and physical alike. Either
   * the buyer ticked "same as billing" — in which case billing is copied in — or
   * they supplied a distinct address. Neither is a refusal, never a fallback to
   * billing: a silent fallback would tax a sale to an address nobody nominated.
   *
   * Resolved HERE, before the engine is contacted and before an Order exists, so
   * a purchase that cannot be sourced leaves nothing behind.
   *
   * For a digital sale this address is a **tax destination only**. It does not
   * make anything ship: what physically ships is `evaluateBasketFulfillment`'s
   * separate question, decided from Product delivery modes further down. */
  let shipToAddress;
  try {
    shipToAddress = resolveShipToAddress(details);
  } catch (error) {
    if (error instanceof ShipToAddressRequiredError) {
      /* One condition, one name — the refusal a caller already handles. */
      throw new BuyerSnapshotError(
        "SHIPPING_ADDRESS_REQUIRED",
        "This purchase requires a ship-to address",
      );
    }
    throw error;
  }
  const shipToDetails = { ...details, shippingAddress: shipToAddress };

  const taxRequestFacts = {
    currency: prepared.quote.currency,
    commercialRetailAmountMinorUnits: prepared.quote.quotedCommercialRetailAmountMinorUnits,
    shippingAmountMinorUnits: v.shippingAmountMinorUnits,
    internalProductId: prepared.internalProductId,
    sellerParticipantId: prepared.sellerParticipantId,
    /* The AUTHORITATIVE destination: the Order's ship-to address, bounded to the
       three fields an engine needs. One rule, no runtime choice, and never an IP —
       an IP locates a network interface, not a buyer, and sourcing tax from one is
       guessing with a number that looks authoritative. */
    destination: resolveTaxDestination(shipToAddress),
    product: {
      internalProductId: productTaxFacts.internalProductId,
      sourceRecordId: productTaxFacts.sourceRecordId,
      sourceRecordVersion: productTaxFacts.sourceRecordVersion,
      taxClassification: productTaxFacts.taxClassification,
      deliveryMode: productTaxFacts.deliveryMode,
    },
  };

  /* — 3. Tax, from an authoritative engine. —
   *
   * An adapter that cannot compute THROWS; it never returns a convenient zero.
   * So a deployment with no tax engine cannot sell, which is the whole point of
   * replacing the hard-coded zero `1.0` and `1.1` carried.
   *
   * The idempotency key is derived from the calculation's own facts, so a buyer
   * who reloads or double-submits the same checkout reuses the calculation the
   * provider already made — and any change that could change the tax owed
   * produces a different key, so a stale calculation is never reused. */
  const quote = await args.taxPort.calculate({
    ...taxRequestFacts,
    idempotencyKey: taxCalculationIdempotencyKey(taxRequestFacts),
    at: v.placedAt,
  });

  /* — 4. Place the Order, carrying the calculated tax and the governing terms. — */
  const placed = await placeOrder(
    { ...v, taxAmountMinorUnits: quote.taxAmountMinorUnits },
    policyId,
    deps,
  );

  /* A reference, never prose: the version is authoritative and a copied
     paragraph would be a second answer able to disagree with it. */
  /* ONE TRANSACTION, so an Order can never carry a policy binding without the
     contact that was disclosed alongside it, or the reverse. A receipt assembled
     from half a disclosure would be a receipt asserting something nobody can
     stand behind. */
  await db.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: placed.order.orderId },
      data: {
        marketplacePolicyId: activePolicy.policyId,
        marketplacePolicyVersion: activePolicy.policyVersion,
        /* The seller's returns terms, bound as a reference on the same terms and
           for the same reason (Phase 1.9 correction). */
        sellerRefundPolicyId: activeRefundPolicy.policyId,
        sellerRefundPolicyVersion: activeRefundPolicy.policyVersion,
      },
    });

    /* WHAT THE BUYER WAS TOLD, frozen. Never refreshed, and never reconciled
       against the seller's later configuration — see the model comment on
       `OrderRefundContactEvidence`. The state is recorded rather than assumed
       even though the refusal above makes it VERIFIED: "this was the effective
       verified contact when the sale occurred" is the claim a receipt makes, and
       a claim worth making is worth evidencing. */
    await tx.orderRefundContactEvidence.create({
      data: {
        orderId: placed.order.orderId,
        contactAddress: supportContact.address,
        contactSource: supportContact.source,
        contactState: "VERIFIED",
        capturedAt: new Date(v.placedAt),
      },
    });
  });

  /* — 4b. Does this basket need a delivery address? —
   *
   * Read from EXPLICIT Product delivery modes, never inferred. Written as a
   * basket rule because the policy is a property of a basket: encoding today's
   * one-Listing limit into it would mean rewriting the POLICY, not just the
   * plumbing, the day a second line exists.
   *
   * An unknown mode REFUSES. Guessing digital ships nothing to a buyer expecting
   * a parcel; guessing physical demands an address nobody needs. */
  const fulfillment = evaluateBasketFulfillment(
    await resolveBasketDeliveryLines(db, [prepared.internalProductId]),
  );

  /* No address check here any more: a ship-to address was resolved before tax was
     calculated, so by this point one exists for every basket. What `fulfillment`
     still decides is narrower and unchanged — whether anything PHYSICALLY ships,
     and therefore whether the provider's hosted page collects a delivery address
     of its own. */

  /* — 5. Record WHO is buying. —
   *
   * Before any payment, so a charge is never taken from a buyer Monacado has no
   * record of. `BUYER_SUPPLIED` — the confirmation path supersedes it with the
   * identity the payment actually authorized. */
  const snapshot = await captureBuyerSnapshot(
    {
      orderId: placed.order.orderId,
      /* The RESOLVED ship-to, so a buyer who chose "same as billing" gets a
         populated ship-to on the record rather than a null that means "look at
         billing instead". A later correction to billing then cannot change where
         a completed sale was taxed and sent. */
      details: shipToDetails,
      capturedAt: v.placedAt,
    },
    {
      ...(deps.db === undefined ? {} : { db: deps.db }),
      ...(deps.buyerSnapshotIds === undefined ? {} : { ids: deps.buyerSnapshotIds }),
    },
  );

  /* — 6. Record WHY that tax was charged. —
   *
   * After the Order because it points at one; before payment because an Order
   * whose tax nobody can explain must never be charged. `requireTaxQuoteMatches
   * Order` refuses if the Listing moved between pricing and placement. */
  await recordOrderTaxEvidence(
    {
      order: placed.order,
      quote,
      recordedAt: v.placedAt,
      /* The linkage that makes "what address was this tax calculated from"
         answerable years later. */
      buyerSnapshotId: snapshot.buyerSnapshotId,
    },
    { ...(deps.db === undefined ? {} : { db: deps.db }), ...(deps.taxIds === undefined ? {} : { ids: deps.taxIds }) },
  );

  /* — 7. Only now, a payment. — */
  const initiation = await initiateOrderPayment(placed.order, args.provider, args.port, {
    collectShippingAddress: fulfillment.requiresShippingAddress,
  });
  return {
    order: placed.order,
    guestClaimCode: placed.guestClaimCode,
    buyerTotalMinorUnits: placed.buyerTotalMinorUnits,
    initiation,
    riskDecision: decision,
    taxQuote: quote,
    buyerSnapshot: snapshot,
    fulfillment,
  };
}

// — Finalization —

/**
 * What one confirmation did, as a bounded answer.
 *
 * `ALREADY_RECORDED` is the idempotency signal and is load-bearing: a provider
 * that delivers the same event twice must produce one sale, and a caller needs to
 * be able to tell "recorded" from "recorded again" without inspecting rows.
 */
export const CONFIRMATION_DISPOSITIONS = [
  "SALE_RECORDED",
  "FAILURE_RECORDED",
  /** The hosted session expired and a still-pending Order was cancelled (1.1). */
  "ORDER_EXPIRED",
  "ALREADY_RECORDED",
] as const;
export type ConfirmationDisposition = (typeof CONFIRMATION_DISPOSITIONS)[number];

export interface FinalizedPayment {
  disposition: ConfirmationDisposition;
  order: OrderRecord;
  /** Present for a completed sale, including a replayed one. */
  sale: CompletedSale | null;
}

/**
 * Record one authoritative provider confirmation.
 *
 * ## Idempotency, and where each guarantee actually lives
 *
 * | Repeat delivery of | Guarded by |
 * | --- | --- |
 * | a success on a `PAID` Order | `0M.9`'s replay branch — same provider reference returns the existing sale and writes nothing |
 * | a **different** success on a `PAID` Order | `PaymentResultConflictError`, deliberately not idempotent: the buyer may have been charged twice |
 * | a failure on a `PAYMENT_FAILED` Order | the pre-check below, which reports `ALREADY_RECORDED` rather than attempting an invalid transition |
 * | two deliveries racing concurrently | the `UNIQUE` index on `TransactionEconomicSnapshot.orderId` — the loser's whole transaction rolls back, and its retry finds the Order `PAID` and replays |
 * | an expiry on a non-`PENDING_PAYMENT` Order | the abandonment pre-check — reported `ALREADY_RECORDED`, and a `PAID` sale is never downgraded |
 *
 * So: no snapshot, no settlement row, no proceeds obligation, no purchase
 * evidence, no notification obligation, and no `PAID` transition is ever created
 * twice — and **none of that is new machinery.** It is `0M.9`'s existing rules,
 * reached from a webhook instead of a test.
 *
 * A failure on a `PAID` Order and any confirmation about a `CANCELLED` Order both
 * raise, because each is a real contradiction between what a provider says and
 * what Monacado has authoritatively recorded. Swallowing one to keep a webhook
 * endpoint quiet would bury the only fact worth surfacing.
 */
export async function finalizeConfirmedPayment(
  confirmation: BuyerPaymentConfirmation,
  deps: OrderServiceDeps = {},
): Promise<FinalizedPayment> {
  const existing = await getOrder(confirmation.orderId, deps);

  /* — Abandonment (Phase 1.1) —
   *
   * The provider says this session can never complete. The Order is cancelled if
   * it is still waiting, and **nothing commercial is created**: `cancelOrder`
   * writes one lifecycle column and has no path to a snapshot, a settlement row,
   * a proceeds obligation, purchase evidence, or a review authority.
   *
   * The three refusals below are each a real protection, not defensiveness:
   *
   *   - a `PAID` Order is left alone. `0M.9` makes `PAID` terminal and the
   *     transition table has no `PAID → CANCELLED` edge, so a late or replayed
   *     expiry event **cannot downgrade a completed sale** — this check reports
   *     it cleanly rather than letting `cancelOrder` raise.
   *   - an already-`CANCELLED` Order is idempotent. Stripe delivers at least
   *     once, and a redelivery is not an invalid transition attempt.
   *   - a `PAYMENT_FAILED` Order keeps its more specific state. It already says
   *     what happened, and overwriting it with "abandoned" would lose the fact
   *     that a provider actually declined something.
   */
  if (confirmation.disposition === "ABANDONED") {
    if (existing.lifecycle !== "PENDING_PAYMENT") {
      return { disposition: "ALREADY_RECORDED", order: existing, sale: null };
    }
    const cancelled = await cancelOrder(
      { orderId: confirmation.orderId, at: confirmation.observedAt },
      deps,
    );
    return { disposition: "ORDER_EXPIRED", order: cancelled, sale: null };
  }

  /* A repeated failure delivery. `recordPaymentResult` would refuse the
     PAYMENT_FAILED → PAYMENT_FAILED transition, and rightly — but a provider
     redelivering an event it already delivered is not an invalid transition
     attempt, it is the ordinary at-least-once behaviour every webhook has. */
  if (existing.lifecycle === "PAYMENT_FAILED" && confirmation.result.outcome === "FAILED") {
    return { disposition: "ALREADY_RECORDED", order: existing, sale: null };
  }

  const wasAlreadyPaid = existing.lifecycle === "PAID";

  const { order, sale } = await recordPaymentResult(
    confirmation.orderId,
    confirmation.result,
    confirmation.observedAt,
    confirmation.provider,
    deps,
  );

  if (wasAlreadyPaid) return { disposition: "ALREADY_RECORDED", order, sale };
  return {
    disposition: sale === null ? "FAILURE_RECORDED" : "SALE_RECORDED",
    order,
    sale,
  };
}
