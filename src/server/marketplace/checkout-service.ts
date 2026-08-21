/**
 * Checkout preparation (Phase 0M.9) — SERVER ONLY.
 *
 * Validates and prices one purchase from **persisted authoritative data**, and
 * writes nothing. It answers: may this Listing be bought right now, at what
 * price, under which exact versions, and what will the buyer be charged.
 *
 * Six properties shape everything below:
 *
 *   1. **No commercial figure is accepted from a caller.** There is no parameter
 *      for a retail price, Monacado's retention, an acquisition amount, seller
 *      proceeds, a commission, or a promoter's spread. The retail price is
 *      derived from the bound Listing version at the checkout instant, and the
 *      split is `0M.4A`'s calculators' answer at the moment the sale completes.
 *      A caller supplies only what Monacado genuinely cannot derive: which
 *      Listing, which buyer, and the tax, shipping, and pass-through amounts an
 *      external system charged.
 *
 *   2. **Eligibility is the committed contract's, not a second opinion.**
 *      `evaluateListingBuyerEligibility` decides, through `0M.7`'s persisted
 *      read, and every blocking reason is surfaced rather than the first.
 *
 *   3. **The effective policy is resolved once, here, and then bound.** Checkout
 *      asks `0M.R1` which policy is effective *now* and records the exact
 *      `(policyId, policyVersion)` on the Order, so the sale is priced under the
 *      rate that applied when the buyer was quoted — not whichever is current
 *      when the payment happens to land.
 *
 *   4. **The seller is resolved, never assumed.** For a promoted Listing the
 *      party owed seller proceeds is the **Offer's** seller, who is not the
 *      Listing's controller. Defaulting to the controller would pay the promoter
 *      the seller's money, which is the worst mistake this phase could make
 *      quietly.
 *
 *   5. **Tax, shipping, and pass-through are recorded, never calculated.**
 *      `0M.T2` owns tax execution. They are outside every commercial basis,
 *      structurally, because no calculator in this repository accepts them.
 *
 *   6. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected.
 *
 * **No write of any kind**, no payment, and no provider contact.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  PlaceOrderInput,
  quotedBuyerTotalMinorUnits,
  type OrderQuote,
} from "../../contracts/marketplace/order";
import {
  effectiveSellerRetailPrice,
  evaluateListingBuyerEligibility,
  type ListingSourceVersion,
  type MonacadoWholesaleAcquisitionPolicy,
} from "../../contracts/marketplace/listing-source";
import { toWholesaleAcquisitionPolicy } from "../../contracts/marketplace/commercial-policy";
import { getPrisma } from "../db/client";
import { getEffectiveCommercialPolicyVersion } from "./commercial-policy-service";
import {
  NoActiveCommercialPolicyError,
  CommercialPolicyNotFoundError,
} from "./commercial-policy-errors";
import { versionRowToSourceVersion as listingVersionRowToSourceVersion } from "./listing-mapper";
import { versionRowToSourceVersion as offerVersionRowToSourceVersion } from "./offer-mapper";
import { resolveCommerceApproval } from "./participant-commerce-approval-service";
import {
  InvalidOrderInputError,
  ListingNotFoundError,
  ListingNotPurchasableError,
  NoEffectiveCommercialPolicyError,
  OrderCurrencyMismatchError,
  OrderPersistenceFailureError,
  SellerNotResolvableError,
} from "./order-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface CheckoutServiceDeps {
  db?: Db;
}

/**
 * Everything the sale path needs, resolved from persisted state.
 *
 * Deliberately carries the *bindings* and the *quote*, and no split: the split is
 * `0M.T1`'s to compute at the instant the sale completes, from these same
 * bindings. A prepared checkout that already contained seller proceeds would be a
 * second answer waiting to disagree with the snapshot.
 */
export interface PreparedCheckout {
  /** The exact Listing source version the buyer is buying. */
  listingSourceVersion: ListingSourceVersion;
  listingSourceRecordId: string;
  listingSourceRecordVersion: string;

  /** The exact policy this quote was priced under, and its economics. */
  policyId: string;
  policyVersion: string;
  policy: MonacadoWholesaleAcquisitionPolicy;

  storefrontId: string;
  internalProductId: string;

  transactionType: "SELLER_DIRECT" | "PROMOTED";
  /** The party owed seller proceeds — the Offer's seller on a promoted sale. */
  sellerParticipantId: string;
  /** Promoted only. `null` on a seller-direct checkout. */
  promoterParticipantId: string | null;

  quote: OrderQuote;
  /** Derived from the quote's four amounts, never stored. */
  buyerTotalMinorUnits: number;
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidOrderInputError {
  return new InvalidOrderInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

function isDomainError(error: unknown): boolean {
  return (
    error instanceof InvalidOrderInputError ||
    error instanceof ListingNotFoundError ||
    error instanceof ListingNotPurchasableError ||
    error instanceof OrderCurrencyMismatchError ||
    error instanceof NoEffectiveCommercialPolicyError ||
    error instanceof SellerNotResolvableError
  );
}

/**
 * Resolve the party owed seller proceeds, and the promoter where there is one.
 *
 * Seller-direct: the Listing's controller sells their own Product, so controller
 * and seller are the same participant.
 *
 * Promoted: the controller is the **promoter**, and the seller is named by the
 * exact accepted Offer source version — read from that version rather than from
 * the Offer's current pointer, so a sale pays the party who contracted the terms
 * being sold.
 */
export async function resolveSaleCounterparties(
  tx: Tx,
  sourceVersion: ListingSourceVersion,
): Promise<{ sellerParticipantId: string; promoterParticipantId: string | null }> {
  const placement = sourceVersion.placement;
  if (placement.listingType === "SELLER_DIRECT") {
    return {
      sellerParticipantId: sourceVersion.controllingParticipantId,
      promoterParticipantId: null,
    };
  }

  const dependency = placement.offerDependency;
  const offerRow = await tx.offerSourceRecordVersionRow.findUnique({
    where: {
      offerSourceRecordId_sourceRecordVersion: {
        offerSourceRecordId: dependency.offerSourceRecordId,
        sourceRecordVersion: dependency.acceptedOfferSourceRecordVersion,
      },
    },
  });
  if (offerRow === null) throw new SellerNotResolvableError();

  /* Through 0M.6's own mapper, so a corrupt Offer row fails there rather than
     naming a seller nobody agreed to pay. */
  const offer = offerVersionRowToSourceVersion(offerRow);
  return {
    sellerParticipantId: offer.sellerParticipantId,
    promoterParticipantId: sourceVersion.controllingParticipantId,
  };
}

/**
 * Read the Listing's **current** source version — what is on sale now.
 *
 * A buyer buys what is offered at the moment they check out, so this deliberately
 * follows the current-version pointer, and then **records which version that
 * was**. Everything downstream binds the recorded label rather than the pointer,
 * so the sale stays reproducible even after the Listing moves on. Letting a
 * caller *name* a version instead would let someone purchase terms that had
 * already been withdrawn.
 */
async function readCurrentListingVersion(
  db: Db,
  internalListingId: string,
): Promise<{
  sourceVersion: ListingSourceVersion;
  listingSourceRecordId: string;
  listingSourceRecordVersion: string;
}> {
  const stable = await db.listing.findUnique({ where: { internalListingId } });
  if (stable === null) throw new ListingNotFoundError();

  const row = await db.listingSourceRecordVersionRow.findUnique({
    where: {
      listingSourceRecordId_sourceRecordVersion: {
        listingSourceRecordId: stable.listingSourceRecordId,
        sourceRecordVersion: stable.currentSourceRecordVersion,
      },
    },
  });
  if (row === null) throw new ListingNotFoundError();

  return {
    sourceVersion: listingVersionRowToSourceVersion(row),
    listingSourceRecordId: stable.listingSourceRecordId,
    listingSourceRecordVersion: stable.currentSourceRecordVersion,
  };
}

/**
 * Whether this Listing may be sold, using `0M.4A`'s own evaluator.
 *
 * Product availability is **supplied** — it is the Product model's question and
 * this phase adds no second answer to it.
 *
 * **Go-live approval is read, never supplied.** It comes from the governed
 * `ParticipantCommerceApproval` decision for the **Storefront's owner**, which is
 * whose clearance `storefrontExposure` has always been about: `0M.3A` calls it
 * "Monacado's opinion about a participant, not a fact about a shop", and the shop
 * is reachable exactly when its owner has been cleared. Absence of a decision
 * yields `NOT_APPROVED`, so a participant nobody has assessed cannot sell.
 *
 * Every failing reason is surfaced, not the first.
 */
async function requirePurchasable(
  db: Db,
  sourceVersion: ListingSourceVersion,
  supplied: { productAvailability: "available" | "unavailable" },
): Promise<void> {
  const placement = sourceVersion.placement;

  const storefront = await db.storefront.findUnique({
    where: { internalStorefrontId: sourceVersion.storefrontId },
  });
  if (storefront === null) throw new ListingNotFoundError();

  const controller = await db.marketplaceParticipant.findUnique({
    where: { id: sourceVersion.controllingParticipantId },
  });
  if (controller === null) throw new ListingNotFoundError();

  const role = await db.marketplaceRoleAssignment.findFirst({
    where: {
      participantId: controller.id,
      role: placement.listingType === "PROMOTED" ? "PROMOTER" : "SELLER",
    },
  });

  /* A promoted Listing's commercial selectability comes from the EXACT accepted
     Offer version, never the Offer's current one. */
  let offer: { lifecycle: string; availability: string } | undefined;
  if (placement.listingType === "PROMOTED") {
    const offerRow = await db.offerSourceRecordVersionRow.findUnique({
      where: {
        offerSourceRecordId_sourceRecordVersion: {
          offerSourceRecordId: placement.offerDependency.offerSourceRecordId,
          sourceRecordVersion: placement.offerDependency.acceptedOfferSourceRecordVersion,
        },
      },
    });
    if (offerRow !== null) {
      offer = { lifecycle: offerRow.lifecycle, availability: offerRow.availability };
    }
  }

  const eligibility = evaluateListingBuyerEligibility({
    lifecycle: sourceVersion.lifecycle,
    listingType: placement.listingType,
    productAvailability: supplied.productAvailability,
    storefrontExposure: {
      lifecycle: storefront.lifecycle as never,
      visibility: storefront.visibility as never,
      goLiveApproval: await resolveCommerceApproval(db, storefront.ownerParticipantId),
    },
    controllingParticipantStatus: controller.status as never,
    controllingRoleStatus: (role?.status ?? "NONE") as never,
    ...(offer === undefined ? {} : { offer: offer as never }),
    ...(placement.listingType === "PROMOTED"
      ? { upstreamReviewState: placement.upstreamReviewState }
      : {}),
  });

  if (!eligibility.buyerActive) {
    throw new ListingNotPurchasableError(eligibility.blockingReasons);
  }
}

/**
 * The effective commercial policy, as the committed economics contract.
 *
 * `0M.R1`'s *effective* read — correct here and only here, because a new
 * transaction is being priced. Everything afterwards binds the exact
 * `(policyId, policyVersion)` this returns. A policy with no active version is a
 * refusal, never a fallback rate.
 */
async function resolveEffectivePolicy(
  db: Db,
  policyId: string,
): Promise<{ policyId: string; policyVersion: string; policy: MonacadoWholesaleAcquisitionPolicy }> {
  try {
    const version = await getEffectiveCommercialPolicyVersion(policyId, { db });
    return {
      policyId: version.policyId,
      policyVersion: version.policyVersion,
      policy: toWholesaleAcquisitionPolicy(version),
    };
  } catch (error) {
    if (
      error instanceof NoActiveCommercialPolicyError ||
      error instanceof CommercialPolicyNotFoundError
    ) {
      throw new NoEffectiveCommercialPolicyError(error);
    }
    throw error;
  }
}

/**
 * Prepare and price one checkout.
 *
 * `policyId` names *which* Monacado policy applies; its **version** is resolved
 * here from what is effective now. Per-transaction, per-participant, and
 * per-class policy *selection* is explicitly `0M.R2`, so this phase takes the
 * policy identity as an input rather than choosing among several.
 *
 * Writes nothing, charges nothing, and contacts no provider.
 */
export async function prepareCheckout(
  input: unknown,
  policyId: string,
  deps: CheckoutServiceDeps = {},
): Promise<PreparedCheckout> {
  const parsed = PlaceOrderInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const v = parsed.data;

  const db = deps.db ?? getPrisma();

  try {
    const { sourceVersion, listingSourceRecordId, listingSourceRecordVersion } =
      await readCurrentListingVersion(db, v.internalListingId);

    await requirePurchasable(db, sourceVersion, {
      productAvailability: v.productAvailability,
    });

    const placement = sourceVersion.placement;
    if (placement.retail.retailPriceCurrency !== v.currency) {
      throw new OrderCurrencyMismatchError("listingRetailCurrency");
    }

    const { policyVersion, policy, policyId: boundPolicyId } = await resolveEffectivePolicy(
      db,
      policyId,
    );
    if (policy.currency !== v.currency) {
      throw new OrderCurrencyMismatchError("policyCurrency");
    }

    /* The EFFECTIVE price at the checkout instant. A seller-direct Listing inside
       a scheduled sale window quotes the sale price; a promoted Listing has no
       schedule — 0M.4A gives that branch no field for one — so the promoter's
       retail price is the basis. Derived from persisted columns plus a supplied
       instant, and stored nowhere. */
    const quotedCommercialRetailAmountMinorUnits =
      placement.listingType === "SELLER_DIRECT"
        ? effectiveSellerRetailPrice({ placement, now: v.placedAt }).effectivePriceMinorUnits
        : placement.retail.retailPriceMinorUnits;

    const { sellerParticipantId, promoterParticipantId } = await resolveSaleCounterparties(
      db,
      sourceVersion,
    );

    const quote: OrderQuote = {
      currency: v.currency,
      quotedCommercialRetailAmountMinorUnits,
      quotedTaxAmountMinorUnits: v.taxAmountMinorUnits,
      quotedShippingAmountMinorUnits: v.shippingAmountMinorUnits,
      quotedOtherPassThroughAmountMinorUnits: v.otherPassThroughAmountMinorUnits,
    };

    return {
      listingSourceVersion: sourceVersion,
      listingSourceRecordId,
      listingSourceRecordVersion,
      policyId: boundPolicyId,
      policyVersion,
      policy,
      storefrontId: sourceVersion.storefrontId,
      internalProductId: sourceVersion.internalProductId,
      transactionType: placement.listingType,
      sellerParticipantId,
      promoterParticipantId,
      quote,
      buyerTotalMinorUnits: quotedBuyerTotalMinorUnits(quote),
    };
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OrderPersistenceFailureError("prepareCheckout", error);
  }
}
