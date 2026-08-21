/**
 * Buyer order-status route handler (Phase 1.0) — SERVER ONLY.
 *
 * The read the buyer's return page needs, and **nothing more than that read**.
 *
 * ## A deliberately narrow projection
 *
 * The response carries five fields: the Order id the caller already supplied, its
 * lifecycle, the currency, the buyer's total, and — only in `PAYMENT_FAILED` —
 * Monacado's bounded failure classification.
 *
 * It does **not** carry the seller, the promoter, the Storefront, the Product,
 * the Listing, the bound source versions, the commercial policy, Monacado's
 * retention, anyone's proceeds, the settlement standing, or the provider
 * transaction reference. A buyer needs to know whether their payment worked and
 * what they were charged; every other field would be a marketplace's private
 * commercial position, published to whoever holds an order id.
 *
 * ## Authorization
 *
 * **Possession of the Order id is the capability**, and that is a deliberate
 * choice rather than an omission. A guest buyer has no account and no session by
 * design (`0M.9` §3), so requiring one would break guest checkout — which the
 * same document calls first-class. The id is 26 Crockford characters of
 * `crypto.randomBytes` and encodes nothing: no buyer, no amount, no date, no
 * sequence. It is not enumerable, and the projection above is bounded precisely
 * because it is reachable this way.
 *
 * A wrong id and an unknown id return the **same** `404`, for the same reason
 * `claimGuestOrder` makes every refusal identical: distinguishing them turns this
 * into an oracle for which order ids exist.
 *
 * ## What it never does
 *
 * No write. No transition. No provider contact. No payment assertion. Arriving at
 * this route with any query string whatsoever cannot move an Order one state.
 */

import "../server-only";
import { quotedBuyerTotalMinorUnits } from "../../contracts/marketplace/order";
import { getOrder } from "../marketplace/order-service";
import { OrderNotFoundError } from "../marketplace/order-errors";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const ORDER_STATUS_ERROR_CODES = {
  invalidQuery: "INVALID_ORDER_STATUS_QUERY",
  notFound: "ORDER_NOT_FOUND",
  unavailable: "ORDER_STATUS_UNAVAILABLE",
} as const;

export const ORDER_STATUS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

/**
 * Named as never present in this projection, and asserted by a test.
 *
 * The list is the point: each entry is a real column on a record this route can
 * already reach, so its absence is a decision rather than an accident of which
 * fields happened to be convenient.
 */
export const NEVER_IN_ORDER_STATUS = [
  "sellerParticipantId",
  "promoterParticipantId",
  "buyerAccountId",
  "buyerParticipantId",
  "guestClaimCodeDigest",
  "storefrontId",
  "internalProductId",
  "internalListingId",
  "listingSourceRecordId",
  "listingSourceRecordVersion",
  "policyId",
  "policyVersion",
  "monacadoRetainedAmountMinorUnits",
  "sellerProceedsMinorUnits",
  "promoterNetProceedsMinorUnits",
  "providerTransactionRef",
  "settlementState",
] as const;

export interface OrderStatusView {
  orderId: string;
  lifecycle: string;
  currency: string;
  buyerTotalMinorUnits: number;
  /** Present only in `PAYMENT_FAILED`; a bounded Monacado code, never provider text. */
  paymentFailureCode: string | null;
}

export interface OrderStatusRouteResult {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface OrderStatusRouteDeps {
  db?: Db;
}

/** Project an Order onto exactly what a buyer may see. An allow-list, not a filter. */
export function toOrderStatusView(order: {
  orderId: string;
  lifecycle: string;
  quote: Parameters<typeof quotedBuyerTotalMinorUnits>[0];
  paymentFailureCode: string | null;
}): OrderStatusView {
  return {
    orderId: order.orderId,
    lifecycle: order.lifecycle,
    currency: order.quote.currency,
    buyerTotalMinorUnits: quotedBuyerTotalMinorUnits(order.quote),
    paymentFailureCode: order.lifecycle === "PAYMENT_FAILED" ? order.paymentFailureCode : null,
  };
}

export async function handleOrderStatusRequest(
  searchParams: URLSearchParams,
  deps: OrderStatusRouteDeps = {},
): Promise<OrderStatusRouteResult> {
  const db = deps.db ?? getPrisma();
  const orderId = searchParams.get("orderId");
  if (orderId === null || orderId === "") {
    return {
      status: 400,
      headers: { ...ORDER_STATUS_HEADERS },
      body: { error: ORDER_STATUS_ERROR_CODES.invalidQuery },
    };
  }

  try {
    const order = await getOrder(orderId, { db });
    return {
      status: 200,
      headers: { ...ORDER_STATUS_HEADERS },
      body: { ...toOrderStatusView(order) },
    };
  } catch (error) {
    if (error instanceof OrderNotFoundError) {
      return {
        status: 404,
        headers: { ...ORDER_STATUS_HEADERS },
        body: { error: ORDER_STATUS_ERROR_CODES.notFound },
      };
    }
    return {
      status: 500,
      headers: { ...ORDER_STATUS_HEADERS },
      body: { error: ORDER_STATUS_ERROR_CODES.unavailable },
    };
  }
}
