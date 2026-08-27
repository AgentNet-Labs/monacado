/**
 * The purchase receipt read (Phase 1.10) — SERVER ONLY.
 *
 * **One read, and everything on it is bound to the sale.**
 *
 * `1.3` gave a receipt the marketplace terms. `1.9` gave it the seller's refund
 * terms and the contact the buyer was actually shown. Neither gave it the money,
 * the lines, or a single call to make — so "render a receipt" still meant knowing
 * which three services to ask and which of their answers were historical. This is
 * the one call, and it is the only place the assembly is decided.
 *
 * ## Reads only, and nothing is resolved from the seller's current configuration
 *
 * Nothing here writes, and nothing contacts a provider. Every field except one is
 * read from evidence attached to the purchase: the Order's own quote, the exact
 * Listing version it bound, the marketplace policy version it bound, the seller
 * refund policy version it bound, and the support contact frozen onto
 * `OrderRefundContactEvidence` at checkout.
 *
 * The one exception is `refund.currentSellerSupportContact`, which `1.9` already
 * resolves live, names separately, and cannot use to overwrite the frozen value.
 * A receipt renders without it.
 *
 * ## The marketplace rules are the BOUND version's, not today's
 *
 * `readMarketplacePolicy` is asked for the version on the Order, and its content
 * is verified against the source before anything is returned. An Order bound to
 * 1.0.0 shows 1.0.0's refund governance — which is **none**, because 1.0.0 states
 * none — rather than 1.1.0's. Filling that in from the current version would be
 * telling a buyer they were sold under rules that did not exist yet.
 *
 * A version whose content has moved, or that this deployment no longer ships, is
 * reported as no marketplace policy rather than as a substituted one. That is the
 * same call `readOrderRefundReceipt` makes for `POLICY_UNREADABLE`.
 */

import "../server-only";
import {
  OrderReceiptView,
  type ReceiptMarketplacePolicyView,
} from "../../contracts/marketplace/order-receipt";
import { selectRefundGovernanceSections } from "../../contracts/marketplace/marketplace-policy";
import { getPrisma } from "../db/client";
import { readMarketplacePolicy } from "../policy/marketplace-policy-service";
import { readOrderRefundReceipt, type RefundDisclosureDeps } from "./refund-disclosure-service";

type Db = ReturnType<typeof getPrisma>;

export interface OrderReceiptDeps extends RefundDisclosureDeps {
  db?: Db;
}

/**
 * Everything a receipt for this Order states.
 *
 * An Order that does not exist returns a view carrying `ORDER_NOT_FOUND` rather
 * than throwing: a receipt surface asked for a stale reference must render an
 * explanation, and a thrown error from a mail dispatcher's resolver is a batch
 * that stops mid-run.
 */
export async function readOrderReceipt(
  orderId: string,
  at: string,
  deps: OrderReceiptDeps = {},
): Promise<OrderReceiptView> {
  const db = deps.db ?? getPrisma();

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      lifecycle: true,
      placedAt: true,
      paidAt: true,
      sellerParticipantId: true,
      internalListingId: true,
      listingSourceRecordVersion: true,
      internalProductId: true,
      marketplacePolicyId: true,
      marketplacePolicyVersion: true,
      currency: true,
      quotedCommercialRetailAmountMinorUnits: true,
      quotedTaxAmountMinorUnits: true,
      quotedShippingAmountMinorUnits: true,
      quotedOtherPassThroughAmountMinorUnits: true,
    },
  });

  /* The refund half is read regardless, so a missing Order is answered by one
     shape rather than by two disagreeing ones. */
  const refund = await readOrderRefundReceipt(orderId, at, { db });

  if (order === null) {
    /* An empty shell carrying the reason. Every substantive field is a zero or a
       null rather than a plausible-looking value — `XXX` is ISO 4217's "no
       currency", and a receipt surface reads `unavailableReason` first. Inventing
       a readable-looking receipt for an Order that does not exist would be the
       one failure mode worse than rendering nothing. */
    return OrderReceiptView.parse({
      orderId,
      lifecycle: "UNKNOWN",
      placedAt: at,
      paidAt: null,
      seller: { participantId: "UNKNOWN", displayName: null },
      lines: [],
      money: {
        currency: "XXX",
        merchandiseMinorUnits: 0,
        taxMinorUnits: 0,
        shippingMinorUnits: 0,
        otherPassThroughMinorUnits: 0,
        totalMinorUnits: 0,
      },
      shipping: {
        chargedMinorUnits: 0,
        refundability: null,
        apportionment: "NOT_APPORTIONED",
      },
      refund,
      marketplacePolicy: null,
      refundInitiation: INITIATION,
      unavailableReason: "ORDER_NOT_FOUND",
      evaluatedAt: at,
    });
  }

  const merchandise = Number(order.quotedCommercialRetailAmountMinorUnits);
  const tax = Number(order.quotedTaxAmountMinorUnits);
  const shipping = Number(order.quotedShippingAmountMinorUnits);
  const other = Number(order.quotedOtherPassThroughAmountMinorUnits);

  return OrderReceiptView.parse({
    orderId: order.id,
    lifecycle: order.lifecycle,
    placedAt: order.placedAt.toISOString(),
    paidAt: order.paidAt === null ? null : order.paidAt.toISOString(),

    seller: {
      participantId: order.sellerParticipantId,
      /* No authoritative seller display name exists in this repository. See
         SELLER_DISPLAY_NAME_GAP — a Storefront's name would name the promoter on
         a promoted sale, and an account address is not a trading name. */
      displayName: null,
    },

    /* One line, because an Order binds one Listing. The shape is a list so a
       basket phase adds rows rather than changing the contract a renderer reads. */
    lines: [
      {
        internalListingId: order.internalListingId,
        listingSourceRecordVersion: order.listingSourceRecordVersion,
        internalProductId: order.internalProductId,
        /* Never today's Product title. See RECEIPT_LINE_DESCRIPTION_GAP. */
        description: null,
        merchandiseMinorUnits: merchandise,
      },
    ],

    money: {
      currency: order.currency,
      merchandiseMinorUnits: merchandise,
      taxMinorUnits: tax,
      shippingMinorUnits: shipping,
      otherPassThroughMinorUnits: other,
      /* Derived, exactly as `quotedBuyerTotalMinorUnits` derives it. A stored
         total would be a second answer able to disagree with its own parts. */
      totalMinorUnits: merchandise + tax + shipping + other,
    },

    shipping: {
      chargedMinorUnits: shipping,
      /* From the BOUND seller policy's enforced terms. `null` where none is
         bound — never a default, because assuming the buyer-favourable answer is
         still asserting a term nobody agreed to. */
      refundability: refund.policyVersion?.terms.shippingRefundability ?? null,
      apportionment: "NOT_APPORTIONED",
    },

    refund,
    marketplacePolicy: await readBoundMarketplacePolicy(db, {
      policyId: order.marketplacePolicyId,
      policyVersion: order.marketplacePolicyVersion,
    }),
    refundInitiation: INITIATION,
    unavailableReason: null,
    evaluatedAt: at,
  });
}

/**
 * A receipt never requires an account, so this never varies.
 *
 * A constant rather than a computed value: there is no input that could make a
 * refund request require a buyer account, and a field that *could* vary is a
 * field somebody eventually makes vary.
 */
const INITIATION = {
  requiresBuyerAccount: false,
  guestVerification: "ORDER_REFERENCE_AND_PURCHASE_CONFIRMATION",
  accountCreationAfterPurchase: "NEVER_REQUIRED",
} as const;

/**
 * The marketplace refund rules from the version this Order bound.
 *
 * `null` for an Order placed before the binding existed, and `null` again for a
 * bound version that cannot be read — a version whose prose has moved, or one
 * this deployment no longer ships. In both cases nothing is substituted: showing
 * a buyer the current version's rules for a purchase made under an older one
 * would be worse than showing none, because it would look authoritative.
 */
async function readBoundMarketplacePolicy(
  db: Db,
  bound: { policyId: string | null; policyVersion: string | null },
): Promise<ReceiptMarketplacePolicyView | null> {
  if (bound.policyId === null || bound.policyVersion === null) return null;
  try {
    const { version, document } = await readMarketplacePolicy(
      bound.policyId,
      bound.policyVersion,
      { db },
    );
    return {
      policyId: version.policyId,
      policyVersion: version.policyVersion,
      contentHash: version.contentHash,
      /* Buyer-facing refund governance only. A receipt is not the terms page, and
         a version stating no refund governance yields an empty list rather than a
         borrowed one. */
      refundSections: selectRefundGovernanceSections(document, "BUYER"),
    };
  } catch {
    return null;
  }
}
