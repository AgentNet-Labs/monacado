/**
 * The buyer's view of one purchasable Listing (Phase 1.0) — SERVER ONLY.
 *
 * What the minimal buyer page needs in order to show a price and a button, and
 * nothing beyond it.
 *
 * **It runs `prepareCheckout` rather than reading the price itself.** That is the
 * point: `prepareCheckout` is a pure read that writes nothing, and it is already
 * the authority on the effective price at an instant, on buyer eligibility
 * through `0M.7`'s persisted evaluator, on the governed commerce approval, and on
 * the effective commercial policy. A page that read `retailPriceMinorUnits` off a
 * row directly would be a second pricing implementation — quietly disagreeing
 * with the one the sale actually uses the moment a sale window opened.
 *
 * So the quoted total shown to the buyer and the amount sent to Stripe come from
 * the same function call shape, on the same authoritative versions. They cannot
 * drift, because there is only one of them.
 *
 * A Listing that cannot be bought yields `purchasable: false` and **no price**.
 * Showing a price for something unbuyable is how a buyer ends up at a refusal
 * they were invited into.
 */

import "../server-only";
import { prepareCheckout } from "../marketplace/checkout-service";
import {
  ListingNotFoundError,
  ListingNotPurchasableError,
  NoEffectiveCommercialPolicyError,
  OrderCurrencyMismatchError,
} from "../marketplace/order-errors";
import { getPrisma } from "../db/client";
import { publicSafeBlockingReasons } from "../../contracts/marketplace/listing-source";

type Db = ReturnType<typeof getPrisma>;

export interface ListingCheckoutView {
  internalListingId: string;
  purchasable: boolean;
  /** Present only when purchasable. */
  currency: string | null;
  /** The buyer's total at this instant. Present only when purchasable. */
  buyerTotalMinorUnits: number | null;
  /**
   * Bounded Monacado reasons, never free text — and **filtered for a public
   * audience** (Phase 1.15). Reasons describing the participant's marketplace
   * standing are withheld; see `publicSafeBlockingReasons`.
   */
  blockingReasons: readonly string[];
}

const UNAVAILABLE = (internalListingId: string, blockingReasons: readonly string[] = []) => ({
  internalListingId,
  purchasable: false,
  currency: null,
  buyerTotalMinorUnits: null,
  blockingReasons,
});

export async function readListingCheckoutView(
  args: { internalListingId: string; policyId: string; now: string },
  deps: { db?: Db } = {},
): Promise<ListingCheckoutView> {
  const db = deps.db ?? getPrisma();
  try {
    const prepared = await prepareCheckout(
      {
        internalListingId: args.internalListingId,
        buyerAccountId: null,
        taxAmountMinorUnits: 0,
        shippingAmountMinorUnits: 0,
        otherPassThroughAmountMinorUnits: 0,
        currency: "USD",
        productAvailability: "available",
        placedAt: args.now,
      },
      args.policyId,
      { db },
    );
    return {
      internalListingId: args.internalListingId,
      purchasable: true,
      currency: prepared.quote.currency,
      buyerTotalMinorUnits: prepared.buyerTotalMinorUnits,
      blockingReasons: [],
    };
  } catch (error) {
    if (error instanceof ListingNotPurchasableError) {
      /* Phase 1.15 — filtered, not passed through.
       *
       * These were surfaced as-is on the reasoning that they are bounded codes
       * and therefore safe. Bounded is not the same as public. Two of them
       * describe the PARTICIPANT rather than the Listing, and because any active
       * restriction reconciles a participant to `RESTRICTED` and a suspension to
       * `SUSPENDED`, returning either told an anonymous visitor that this
       * seller's or promoter's standing had been withheld — turning a public
       * failure path into a probe for a counterparty's account standing.
       *
       * The rest still travel. A buyer is owed the operational consequence, and
       * "this product is unavailable" is a fact about the thing they wanted to
       * buy; only the participant's standing is withheld. */
      return UNAVAILABLE(args.internalListingId, publicSafeBlockingReasons(error.blockingReasons));
    }
    if (
      error instanceof ListingNotFoundError ||
      error instanceof OrderCurrencyMismatchError ||
      error instanceof NoEffectiveCommercialPolicyError
    ) {
      return UNAVAILABLE(args.internalListingId);
    }
    throw error;
  }
}
