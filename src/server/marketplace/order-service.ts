/**
 * Buyer Order and post-sale service (Phase 0M.9) — SERVER ONLY.
 *
 * The first path in this repository that creates an actual commercial
 * transaction: place an Order, execute payment through a provider-neutral port,
 * and — on success — record the sale atomically.
 *
 * Seven properties shape everything below:
 *
 *   1. **No accounting is implemented here.** The economics are `0M.T1`'s
 *      snapshot, computed by `0M.4A`'s calculators from the bound Listing, Offer,
 *      and policy versions. This service supplies bindings and checks agreement;
 *      it adds no second answer to what anyone earned.
 *
 *   2. **The payment call is outside the transaction, and everything else is
 *      inside one.** A network call cannot sit in a database transaction, so the
 *      design is the pragmatic one: place the Order first (durable, `PENDING_PAYMENT`),
 *      charge, then record the result. If the process dies mid-charge the Order
 *      survives as `PENDING_PAYMENT` — a state a human or a later reconciliation
 *      can resolve — rather than a sale nobody can account for.
 *
 *   3. **The successful-sale write is one transaction.** Order → `PAID`,
 *      economic snapshot, settlement row, proceeds obligations, purchase
 *      evidence, and seller/promoter notification obligations commit together or
 *      not at all. A `PAID` Order without economics, economics without an Order,
 *      or a promoted sale without its promoter obligation are each impossible
 *      rather than unlikely.
 *
 *   4. **Replay is idempotent when it is a retry, and refused when it is not.**
 *      The same provider transaction returns the existing sale; a *different*
 *      one against a paid Order is refused, because that means the buyer may have
 *      been charged twice and burying it as a replay would hide the one fact
 *      worth surfacing.
 *
 *   5. **The quote is checked against the economics before anything is written.**
 *      The Order says what the buyer was quoted and the snapshot says what the
 *      sale's economics were; if the Listing moved between placement and payment
 *      they diverge, and Monacado would be booking a sale for one figure having
 *      charged another.
 *
 *   6. **Guest checkout creates no Account and fabricates no participant.** A
 *      guest Order carries a claim-code digest and nothing else that identifies
 *      anyone.
 *
 *   7. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, the payment port, and the database
 *      are injected.
 *
 * **No live provider integration, no payout execution, no tax calculation or
 * remittance, and no refund or chargeback accounting.** The payment adapter
 * behind `BuyerPaymentPort` does not exist in this phase; `0M.T2` owns reversal
 * accounting.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  CancelOrderInput,
  ClaimGuestOrderInput,
  INITIAL_ORDER_LIFECYCLE_STATE,
  PlaceOrderInput,
  isValidOrderLifecycleTransition,
  quotedBuyerTotalMinorUnits,
  type OrderLifecycleState,
  type OrderRecord,
} from "../../contracts/marketplace/order";
import {
  BuyerPaymentRequest,
  BuyerPaymentResult,
  type BuyerPaymentPort,
} from "../../contracts/marketplace/buyer-payment";
import {
  AdvanceProceedsObligationInput,
  INITIAL_PROCEEDS_OBLIGATION_STATE,
  deriveProceedsClaims,
  isValidProceedsObligationTransition,
  type ProceedsObligationRecord,
  type ProceedsObligationState,
} from "../../contracts/marketplace/proceeds-obligation";
import {
  AuthorizeReviewSubmissionInput,
  evaluatePurchaseReviewEligibility,
  reviewSubjectRefFor,
  type PurchaseEvidenceRecord,
  type ReviewEligibility,
  type ReviewSubmissionAuthorityRecord,
} from "../../contracts/marketplace/purchase-evidence";
import type { ReviewCapsuleKind } from "../../contracts/marketplace/review-authority";
import type { PaymentProvider } from "../../contracts/marketplace/payment-account";
import { getPrisma } from "../db/client";
import { prepareCheckout, type PreparedCheckout } from "./checkout-service";
import { recordTransactionEconomicSnapshotInTx } from "./transaction-accounting-service";
import { upsertObligationInTx } from "./notification-obligation-service";
import {
  cryptoGuestClaimCodeProvider,
  hashGuestClaimCode,
  type GuestClaimCodeProvider,
} from "./guest-claim-code";
import { cryptoOrderIdProvider, type OrderIdProvider } from "./order-ids";
import { cryptoParticipantIdProvider, type ParticipantIdProvider } from "./participant-ids";
import {
  BuyerAccountNotFoundError,
  CorruptOrderRecordError,
  GuestClaimRefusedError,
  InvalidOrderInputError,
  InvalidOrderTransitionError,
  InvalidProceedsObligationTransitionError,
  ListingNotFoundError,
  ListingNotPurchasableError,
  NoEffectiveCommercialPolicyError,
  NotAGuestOrderError,
  OrderCurrencyMismatchError,
  OrderNotCompletedError,
  OrderNotFoundError,
  OrderPersistenceFailureError,
  PaymentResultConflictError,
  ProceedsObligationNotFoundError,
  QuoteSnapshotMismatchError,
  ReviewNotEligibleError,
  SellerNotResolvableError,
} from "./order-errors";
import {
  buyerToColumns,
  orderRowToRecord,
  proceedsObligationRowToRecord,
  purchaseEvidenceRowToRecord,
  reviewAuthorityRowToRecord,
} from "./order-mapper";

type Db = ReturnType<typeof getPrisma>;

export interface OrderServiceDeps {
  db?: Db;
  ids?: OrderIdProvider;
  /** Supplies `nextObligationId` for the 0M.N1 notice rows a sale creates. */
  notificationIds?: ParticipantIdProvider;
  claimCodes?: GuestClaimCodeProvider;
}

/** An Order placed and awaiting payment, plus the guest's one-time claim code. */
export interface PlacedOrder {
  order: OrderRecord;
  /**
   * Returned **once**, for a guest Order only, and stored nowhere.
   *
   * The caller must hand it to the buyer; Monacado cannot re-issue it, because
   * only its digest was kept.
   */
  guestClaimCode: string | null;
  /** What the buyer will be charged. Derived from the quote, never stored. */
  buyerTotalMinorUnits: number;
}

/** A completed sale, with everything the transaction created. */
export interface CompletedSale {
  order: OrderRecord;
  snapshotId: string;
  proceedsObligations: ProceedsObligationRecord[];
  purchaseEvidence: PurchaseEvidenceRecord;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isForeignKeyViolation = (e: unknown): boolean => prismaCode(e) === "P2003";

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidOrderInputError {
  return new InvalidOrderInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

/** Errors that must escape a catch block unwrapped rather than be disguised. */
function isDomainError(error: unknown): boolean {
  return (
    error instanceof InvalidOrderInputError ||
    error instanceof OrderNotFoundError ||
    error instanceof ListingNotFoundError ||
    error instanceof ListingNotPurchasableError ||
    error instanceof OrderCurrencyMismatchError ||
    error instanceof NoEffectiveCommercialPolicyError ||
    error instanceof BuyerAccountNotFoundError ||
    error instanceof SellerNotResolvableError ||
    error instanceof InvalidOrderTransitionError ||
    error instanceof PaymentResultConflictError ||
    error instanceof QuoteSnapshotMismatchError ||
    error instanceof OrderNotCompletedError ||
    error instanceof ReviewNotEligibleError ||
    error instanceof GuestClaimRefusedError ||
    error instanceof NotAGuestOrderError ||
    error instanceof InvalidProceedsObligationTransitionError ||
    error instanceof ProceedsObligationNotFoundError ||
    error instanceof CorruptOrderRecordError
  );
}

// — Placing an Order —

/**
 * Place one Order, quoted from persisted authoritative data.
 *
 * Durable **before** any payment runs, which is what makes the external charge
 * recoverable: a process that dies mid-charge leaves a `PENDING_PAYMENT` Order
 * naming exactly what was being bought, rather than a payment nobody can attach
 * to anything.
 *
 * A guest Order mints a claim code, stores only its digest, and returns the raw
 * code once. **No Account is created and no `MarketplaceParticipant` is
 * fabricated** — a guest simply has neither, and there is no column for either.
 */
export async function placeOrder(
  input: unknown,
  policyId: string,
  deps: OrderServiceDeps = {},
): Promise<PlacedOrder> {
  const parsed = PlaceOrderInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const v = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOrderIdProvider;
  const claimCodes = deps.claimCodes ?? cryptoGuestClaimCodeProvider;

  /* Priced outside the write, and deliberately: preparation is a pure read that
     may refuse for a dozen reasons, and none of them should hold a transaction
     open. */
  const prepared = await prepareCheckout(v, policyId, { db });

  try {
    /* An account buyer's participant record is looked up, never created. Most
       buyers have none, and 0M.1 is explicit that such an account "is treated as
       a guest buyer, which is what they are until they claim otherwise". */
    let buyerColumns;
    let guestClaimCode: string | null = null;
    if (v.buyerAccountId === null) {
      guestClaimCode = claimCodes.nextGuestClaimCode();
      buyerColumns = buyerToColumns({
        buyerKind: "GUEST_BUYER",
        guestClaimCodeDigest: hashGuestClaimCode(guestClaimCode),
      });
    } else {
      const account = await db.account.findUnique({
        where: { id: v.buyerAccountId },
      });
      if (account === null) throw new BuyerAccountNotFoundError();
      const participant = await db.marketplaceParticipant.findUnique({
        where: { accountId: v.buyerAccountId },
      });
      buyerColumns = buyerToColumns({
        buyerKind: "ACCOUNT_BUYER",
        buyerAccountId: v.buyerAccountId,
        buyerParticipantId: participant?.id ?? null,
      });
    }

    const row = await db.order.create({
      data: {
        id: ids.nextOrderId(),
        ...buyerColumns,
        internalListingId: v.internalListingId,
        listingSourceRecordId: prepared.listingSourceRecordId,
        listingSourceRecordVersion: prepared.listingSourceRecordVersion,
        policyId: prepared.policyId,
        policyVersion: prepared.policyVersion,
        storefrontId: prepared.storefrontId,
        internalProductId: prepared.internalProductId,
        transactionType: prepared.transactionType,
        sellerParticipantId: prepared.sellerParticipantId,
        promoterParticipantId: prepared.promoterParticipantId,
        currency: prepared.quote.currency,
        quotedCommercialRetailAmountMinorUnits: BigInt(
          prepared.quote.quotedCommercialRetailAmountMinorUnits,
        ),
        quotedTaxAmountMinorUnits: BigInt(prepared.quote.quotedTaxAmountMinorUnits),
        quotedShippingAmountMinorUnits: BigInt(prepared.quote.quotedShippingAmountMinorUnits),
        quotedOtherPassThroughAmountMinorUnits: BigInt(
          prepared.quote.quotedOtherPassThroughAmountMinorUnits,
        ),
        lifecycle: INITIAL_ORDER_LIFECYCLE_STATE,
        placedAt: new Date(v.placedAt),
      },
    });

    return {
      order: orderRowToRecord(row),
      guestClaimCode,
      buyerTotalMinorUnits: prepared.buyerTotalMinorUnits,
    };
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isForeignKeyViolation(error)) throw new ListingNotFoundError(error);
    throw new OrderPersistenceFailureError("placeOrder", error);
  }
}

// — Reads —

export async function getOrder(orderId: string, deps: OrderServiceDeps = {}): Promise<OrderRecord> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.order.findUnique({ where: { id: orderId } });
    if (row === null) throw new OrderNotFoundError();
    return orderRowToRecord(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("getOrder", error);
  }
}

export async function listProceedsObligations(
  snapshotId: string,
  deps: OrderServiceDeps = {},
): Promise<ProceedsObligationRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.proceedsObligation.findMany({
      where: { snapshotId },
      orderBy: { party: "asc" },
    });
    return rows.map(proceedsObligationRowToRecord);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("listProceedsObligations", error);
  }
}

// — Payment execution —

/**
 * Charge the buyer through the injected port.
 *
 * **The only I/O boundary in the sale path, and it sits deliberately outside any
 * database transaction** — a network call inside one would hold locks for the
 * duration of somebody else's outage.
 *
 * The idempotency key is the **Order id**, so every retry of this one charge
 * carries the same key. A key generated per call would defeat its own purpose,
 * which is the failure mode worth designing out rather than documenting.
 */
export async function executeOrderPayment(
  order: OrderRecord,
  provider: PaymentProvider,
  port: BuyerPaymentPort,
): Promise<BuyerPaymentResult> {
  const request = BuyerPaymentRequest.parse({
    orderId: order.orderId,
    provider,
    currency: order.quote.currency,
    amountMinorUnits: quotedBuyerTotalMinorUnits(order.quote),
    idempotencyKey: order.orderId,
  });
  return BuyerPaymentResult.parse(await port.executePayment(request));
}

// — Recording the result —

/**
 * Check the Order's quote against the computed sale economics.
 *
 * The check that makes the two records' overlap safe rather than duplicative. If
 * the Listing was repriced between placement and payment, the amounts diverge and
 * Monacado would be booking a sale for one figure having charged another.
 * Refused before anything is written.
 */
function requireQuoteMatchesSnapshot(
  order: OrderRecord,
  snapshot: {
    commercialRetailAmountMinorUnits: number;
    currency: string;
    passThrough: {
      taxAmountMinorUnits: number;
      shippingAmountMinorUnits: number;
      otherPassThroughAmountMinorUnits: number;
    };
  },
): void {
  const mismatched: string[] = [];
  if (
    snapshot.commercialRetailAmountMinorUnits !== order.quote.quotedCommercialRetailAmountMinorUnits
  ) {
    mismatched.push("commercialRetailAmountMinorUnits");
  }
  if (snapshot.currency !== order.quote.currency) mismatched.push("currency");
  if (snapshot.passThrough.taxAmountMinorUnits !== order.quote.quotedTaxAmountMinorUnits) {
    mismatched.push("taxAmountMinorUnits");
  }
  if (
    snapshot.passThrough.shippingAmountMinorUnits !== order.quote.quotedShippingAmountMinorUnits
  ) {
    mismatched.push("shippingAmountMinorUnits");
  }
  if (
    snapshot.passThrough.otherPassThroughAmountMinorUnits !==
    order.quote.quotedOtherPassThroughAmountMinorUnits
  ) {
    mismatched.push("otherPassThroughAmountMinorUnits");
  }
  if (mismatched.length > 0) throw new QuoteSnapshotMismatchError(mismatched);
}

/**
 * Record the provider's answer, and on success record the sale.
 *
 * **On failure** nothing commercial is created: no snapshot, no obligation, no
 * evidence. The Order moves to `PAYMENT_FAILED` with a bounded classification,
 * which is the minimum durable state a failure requires. A `PAYMENT_FAILED`
 * notification obligation is recorded **only when the buyer is a participant** —
 * `0M.N1` keys recipients on participants by design, and a guest has none.
 *
 * **On success** the whole sale commits as one transaction; see
 * `recordCompletedSale`.
 *
 * **Replay** is decided before anything else: the same provider transaction
 * returns the existing sale, a different one is refused.
 */
export async function recordPaymentResult(
  orderId: string,
  result: unknown,
  at: string,
  provider: PaymentProvider,
  deps: OrderServiceDeps = {},
): Promise<{ order: OrderRecord; sale: CompletedSale | null }> {
  const parsedResult = BuyerPaymentResult.safeParse(result);
  if (!parsedResult.success) throw inputError(parsedResult.error);
  const paymentResult = parsedResult.data;

  const db = deps.db ?? getPrisma();

  const order = await getOrder(orderId, deps);

  /* Replay, decided first. A repeat of the same provider transaction is a retry
     of one charge; a DIFFERENT one against a paid Order means the buyer may have
     been charged twice, and recording it as an ordinary replay would bury the one
     fact worth surfacing. */
  if (order.lifecycle === "PAID") {
    if (paymentResult.outcome !== "SUCCEEDED") throw new PaymentResultConflictError();
    const existing = await db.transactionEconomicSnapshot.findUnique({
      where: { orderId },
      include: { settlement: true },
    });
    if (existing === null) throw new CorruptOrderRecordError(["economicSnapshot"]);
    if (
      existing.settlement?.providerTransactionRef !== paymentResult.providerTransactionRef ||
      existing.settlement?.provider !== paymentResult.provider
    ) {
      throw new PaymentResultConflictError();
    }
    const evidenceRow = await db.purchaseEvidence.findUnique({
      where: { orderId },
    });
    if (evidenceRow === null) throw new CorruptOrderRecordError(["purchaseEvidence"]);
    return {
      order,
      sale: {
        order,
        snapshotId: existing.id,
        proceedsObligations: await listProceedsObligations(existing.id, deps),
        purchaseEvidence: purchaseEvidenceRowToRecord(evidenceRow),
      },
    };
  }

  if (paymentResult.outcome === "FAILED") {
    const failed = await recordPaymentFailure(db, order, paymentResult.failureCode, at, deps);
    return { order: failed, sale: null };
  }

  const sale = await recordCompletedSale(db, order, paymentResult, at, provider, deps);
  return { order: sale.order, sale };
}

/**
 * Move an Order to `PAYMENT_FAILED`.
 *
 * **Creates nothing commercial.** A failed payment is not a sale, so there is no
 * economic snapshot, no proceeds obligation, and no purchase evidence — and
 * therefore no review eligibility either.
 */
async function recordPaymentFailure(
  db: Db,
  order: OrderRecord,
  failureCode: string,
  at: string,
  deps: OrderServiceDeps,
): Promise<OrderRecord> {
  if (!isValidOrderLifecycleTransition(order.lifecycle, "PAYMENT_FAILED")) {
    throw new InvalidOrderTransitionError(order.lifecycle, "PAYMENT_FAILED");
  }
  const notificationIds = deps.notificationIds ?? cryptoParticipantIdProvider;

  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.order.update({
        where: { id: order.orderId },
        data: {
          lifecycle: "PAYMENT_FAILED",
          paymentFailureCode: failureCode,
          failedAt: new Date(at),
        },
      });

      /* Only a participant can be a recipient: 0M.N1 keys obligations on
         participants rather than addresses, precisely so a notice cannot be
         handed to whoever holds an email next. A guest buyer therefore gets no
         obligation row, and buyer-facing delivery for guests is 0M.N2's. */
      const buyerParticipantId =
        order.buyer.buyerKind === "ACCOUNT_BUYER" ? order.buyer.buyerParticipantId : null;
      if (buyerParticipantId !== null) {
        await upsertObligationInTx(tx, {
          id: notificationIds.nextObligationId(),
          recipientParticipantId: buyerParticipantId,
          category: "PAYMENT_FAILED",
          subject: { kind: "PAYMENT", ref: order.orderId, versionRef: null },
          contextCode: null,
          createdAt: at,
        });
      }

      return orderRowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("recordPaymentFailure", error);
  }
}

/**
 * The successful-sale write path — **one transaction, or none of it**.
 *
 * Everything a completed sale creates commits together:
 *
 *   1. the economic snapshot and its `PENDING` settlement row (`0M.T1`);
 *   2. the provider transaction reference on that settlement row;
 *   3. one proceeds obligation per party owed — one for a seller-direct sale, two
 *      for a promoted one;
 *   4. the private purchase evidence a review's authority will rest on;
 *   5. `SALE_RECORDED` notification obligations for the seller and any promoter;
 *   6. the Order's move to `PAID`.
 *
 * The invariants this makes structural: a `PAID` Order without economics,
 * economics without an Order, and a promoted sale without its promoter obligation
 * are each **impossible**, not merely unlikely.
 *
 * The snapshot is created through `0M.T1`'s own service, which recomputes the
 * economics from the bound Listing, Offer, and policy versions and validates the
 * accounting identity before writing. **No arithmetic happens here.**
 */
async function recordCompletedSale(
  db: Db,
  order: OrderRecord,
  payment: { provider: PaymentProvider; providerTransactionRef: string },
  at: string,
  provider: PaymentProvider,
  deps: OrderServiceDeps,
): Promise<CompletedSale> {
  if (!isValidOrderLifecycleTransition(order.lifecycle, "PAID")) {
    throw new InvalidOrderTransitionError(order.lifecycle, "PAID");
  }
  const ids = deps.ids ?? cryptoOrderIdProvider;
  const notificationIds = deps.notificationIds ?? cryptoParticipantIdProvider;

  try {
    return await db.$transaction(async (tx) => {
      /* 0M.T1's service, given a transaction client so its two writes join this
         one. It computes the economics from the EXACT bound versions and refuses
         an unbalanced snapshot before any row exists. */
      const { snapshot } = await recordTransactionEconomicSnapshotInTx(tx, {
        internalListingId: order.internalListingId,
        listingSourceRecordVersion: order.listingSourceRecordVersion,
        policyId: order.policyId,
        policyVersion: order.policyVersion,
        currency: order.quote.currency,
        taxAmountMinorUnits: order.quote.quotedTaxAmountMinorUnits,
        shippingAmountMinorUnits: order.quote.quotedShippingAmountMinorUnits,
        otherPassThroughAmountMinorUnits: order.quote.quotedOtherPassThroughAmountMinorUnits,
        occurredAt: order.placedAt,
        recordedAt: at,
      });

      /* The quote and the economics must agree. If the Listing moved between
         placement and payment they will not, and Monacado would be booking a sale
         for one figure having charged another. */
      requireQuoteMatchesSnapshot(order, snapshot);

      /* Bind the snapshot to its Order — the additive column 0M.T1 anticipated —
         and attach the provider's evidence to the settlement row. */
      await tx.transactionEconomicSnapshot.update({
        where: { id: snapshot.snapshotId },
        data: { orderId: order.orderId },
      });
      await tx.transactionSettlement.update({
        where: { snapshotId: snapshot.snapshotId },
        data: {
          provider: payment.provider,
          providerTransactionRef: payment.providerTransactionRef,
          providerReferenceRecordedAt: new Date(at),
        },
      });

      /* What each party is owed, read from the snapshot and computed by nothing
         here. A seller-direct sale yields one claim; a promoted sale two. */
      const claims = deriveProceedsClaims(snapshot.economics);
      const obligations: ProceedsObligationRecord[] = [];
      for (const claim of claims) {
        const participantId =
          claim.party === "SELLER" ? order.sellerParticipantId : order.promoterParticipantId;
        /* Unreachable: deriveProceedsClaims yields a PROMOTER claim only on the
           promoted arm, where checkout resolved a promoter. Asserted because
           paying an obligation to nobody must fail loudly. */
        if (participantId === null) throw new SellerNotResolvableError();

        const row = await tx.proceedsObligation.create({
          data: {
            id: ids.nextProceedsObligationId(),
            snapshotId: snapshot.snapshotId,
            participantId,
            party: claim.party,
            amountMinorUnits: BigInt(claim.amountMinorUnits),
            currency: snapshot.currency,
            state: INITIAL_PROCEEDS_OBLIGATION_STATE,
            accruedAt: new Date(order.placedAt),
          },
        });
        obligations.push(proceedsObligationRowToRecord(row));
      }

      /* The private record that this buyer transacted — the provenance a review's
         authority rests on. Never published (ADR §11.10). */
      const evidenceRow = await tx.purchaseEvidence.create({
        data: {
          id: ids.nextPurchaseEvidenceId(),
          orderId: order.orderId,
          purchaseProvenance: "VERIFIED",
          submitter: order.buyer.buyerKind,
          internalProductId: order.internalProductId,
          sellerParticipantId: order.sellerParticipantId,
          establishedAt: new Date(at),
        },
      });

      /* Who Monacado owes a notice. Seller always; promoter on a promoted sale.
         Both are participants by construction, which is what 0M.N1 requires. */
      await upsertObligationInTx(tx, {
        id: notificationIds.nextObligationId(),
        recipientParticipantId: order.sellerParticipantId,
        category: "SALE_RECORDED",
        subject: { kind: "ORDER", ref: order.orderId, versionRef: null },
        contextCode: null,
        createdAt: at,
      });
      if (order.promoterParticipantId !== null) {
        await upsertObligationInTx(tx, {
          id: notificationIds.nextObligationId(),
          recipientParticipantId: order.promoterParticipantId,
          category: "SALE_RECORDED",
          subject: { kind: "ORDER", ref: order.orderId, versionRef: null },
          contextCode: null,
          createdAt: at,
        });
      }

      const orderRow = await tx.order.update({
        where: { id: order.orderId },
        data: { lifecycle: "PAID", paidAt: new Date(at) },
      });

      return {
        order: orderRowToRecord(orderRow),
        snapshotId: snapshot.snapshotId,
        proceedsObligations: obligations,
        purchaseEvidence: purchaseEvidenceRowToRecord(evidenceRow),
      };
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("recordCompletedSale", error);
  }
}

/** Abandon an Order before payment succeeded. */
export async function cancelOrder(
  input: unknown,
  deps: OrderServiceDeps = {},
): Promise<OrderRecord> {
  const parsed = CancelOrderInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { orderId, at } = parsed.data;

  const db = deps.db ?? getPrisma();
  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.order.findUnique({ where: { id: orderId } });
      if (current === null) throw new OrderNotFoundError();
      const from = current.lifecycle as OrderLifecycleState;
      if (!isValidOrderLifecycleTransition(from, "CANCELLED")) {
        throw new InvalidOrderTransitionError(from, "CANCELLED");
      }
      const row = await tx.order.update({
        where: { id: orderId },
        data: { lifecycle: "CANCELLED", cancelledAt: new Date(at) },
      });
      return orderRowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("cancelOrder", error);
  }
}

// — Guest claim —

/**
 * Attach a guest purchase to an account.
 *
 * The **minimum durable foundation** the roadmap asks for. Verification is
 * possession of the claim code, compared by digest through the unique index — so
 * there is no timing signal here and no code is ever compared in application
 * code.
 *
 * Every refusal is the **same** error. Distinguishing "wrong code" from "already
 * claimed" from "no such order" would turn this into an oracle for probing which
 * order ids exist.
 *
 * `buyerKind` is untouched: the sale was made by a guest, and a record that
 * quietly became an account purchase would misstate what happened.
 */
export async function claimGuestOrder(
  input: unknown,
  deps: OrderServiceDeps = {},
): Promise<OrderRecord> {
  const parsed = ClaimGuestOrderInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { orderId, guestClaimCode, claimedByAccountId, claimedAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  const digest = hashGuestClaimCode(guestClaimCode);

  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.order.findUnique({
        where: { guestClaimCodeDigest: digest },
      });
      if (current === null || current.id !== orderId) throw new GuestClaimRefusedError();
      if (current.buyerKind !== "GUEST_BUYER") throw new NotAGuestOrderError();
      if (current.claimedByAccountId !== null) throw new GuestClaimRefusedError();

      const account = await tx.account.findUnique({
        where: { id: claimedByAccountId },
      });
      if (account === null) throw new GuestClaimRefusedError();

      const row = await tx.order.update({
        where: { id: orderId },
        data: { claimedByAccountId, claimedAt: new Date(claimedAt) },
      });
      return orderRowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("claimGuestOrder", error);
  }
}

// — Proceeds obligations —

/** Advance one claim's standing. Records that Monacado paid; it does not pay. */
export async function advanceProceedsObligation(
  input: unknown,
  deps: OrderServiceDeps = {},
): Promise<ProceedsObligationRecord> {
  const parsed = AdvanceProceedsObligationInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { obligationId, to, at } = parsed.data;

  const db = deps.db ?? getPrisma();
  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.proceedsObligation.findUnique({
        where: { id: obligationId },
      });
      if (current === null) throw new ProceedsObligationNotFoundError();
      const from = current.state as ProceedsObligationState;
      if (!isValidProceedsObligationTransition(from, to)) {
        throw new InvalidProceedsObligationTransitionError(from, to);
      }
      const row = await tx.proceedsObligation.update({
        where: { id: obligationId },
        data: {
          state: to,
          ...(to === "ELIGIBLE" ? { becameEligibleAt: new Date(at) } : { paidAt: new Date(at) }),
        },
      });
      return proceedsObligationRowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("advanceProceedsObligation", error);
  }
}

// — Review eligibility —

/**
 * Whether one completed purchase still licenses one kind of review.
 *
 * **The purchase half only.** Whether the *subject* may submit — account status,
 * participant standing, an active `BUYER` role — is `capability.ts`'s
 * `canSubmitProductReview` / `canSubmitSellerReview`, which this does not
 * re-decide. A caller asks both.
 */
export async function evaluateReviewEligibility(
  orderId: string,
  reviewKind: ReviewCapsuleKind,
  deps: OrderServiceDeps = {},
): Promise<ReviewEligibility> {
  const db = deps.db ?? getPrisma();
  try {
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (order === null) throw new OrderNotFoundError();

    const evidence = await db.purchaseEvidence.findUnique({
      where: { orderId },
    });
    const existing = await db.reviewSubmissionAuthority.findUnique({
      where: { orderId_reviewKind: { orderId, reviewKind } },
    });

    return evaluatePurchaseReviewEligibility({
      orderCompleted: order.lifecycle === "PAID",
      purchaseEvidenceExists: evidence !== null,
      authorityAlreadyExists: existing !== null,
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("evaluateReviewEligibility", error);
  }
}

/**
 * Authorize one review out of one completed purchase.
 *
 * Creates the stored grant ADR §11.6 requires before Monacado may publish a
 * review for anyone — **and no review content**. There is no text, rating, or
 * title parameter: this decides who may write, and the writing is a later phase.
 *
 * A **guest may be authorized.** `0M.1` settled that a guest is "a real,
 * supported case… and is not an account in disguise", and requires `VERIFIED`
 * provenance rather than an account for every review. Requiring a claim first
 * would contradict a committed contract.
 *
 * One authority per governed subject per Order, enforced by the unique index.
 */
export async function authorizeReviewSubmission(
  input: unknown,
  deps: OrderServiceDeps = {},
): Promise<ReviewSubmissionAuthorityRecord> {
  const parsed = AuthorizeReviewSubmissionInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { orderId, reviewKind } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOrderIdProvider;

  try {
    return await db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (order === null) throw new OrderNotFoundError();

      const evidence = await tx.purchaseEvidence.findUnique({
        where: { orderId },
      });
      const existing = await tx.reviewSubmissionAuthority.findUnique({
        where: { orderId_reviewKind: { orderId, reviewKind } },
      });

      const eligibility = evaluatePurchaseReviewEligibility({
        orderCompleted: order.lifecycle === "PAID",
        purchaseEvidenceExists: evidence !== null,
        authorityAlreadyExists: existing !== null,
      });
      if (!eligibility.eligible) throw new ReviewNotEligibleError(eligibility.blockers);
      /* Unreachable once eligibility passed; asserted so the non-null below is a
         checked fact rather than an assumption. */
      if (evidence === null) throw new OrderNotCompletedError();

      const row = await tx.reviewSubmissionAuthority.create({
        data: {
          id: ids.nextReviewSubmissionAuthorityId(),
          reviewSubmissionId: ids.nextReviewSubmissionId(),
          orderId,
          purchaseEvidenceId: evidence.id,
          reviewKind,
          reviewSubjectRef: reviewSubjectRefFor(reviewKind, {
            internalProductId: evidence.internalProductId,
            sellerParticipantId: evidence.sellerParticipantId,
          }),
          submitter: evidence.submitter,
          purchaseProvenance: evidence.purchaseProvenance,
          submissionState: "SUBMITTED",
          status: "ACTIVE",
        },
      });
      return reviewAuthorityRowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("authorizeReviewSubmission", error);
  }
}

export async function getPurchaseEvidence(
  orderId: string,
  deps: OrderServiceDeps = {},
): Promise<PurchaseEvidenceRecord> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.purchaseEvidence.findUnique({ where: { orderId } });
    if (row === null) throw new OrderNotCompletedError();
    return purchaseEvidenceRowToRecord(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("getPurchaseEvidence", error);
  }
}

/** Re-exported so a caller can prepare a quote without importing two modules. */
export { prepareCheckout, type PreparedCheckout };
