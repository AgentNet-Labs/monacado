/**
 * TEST-ONLY — a pre-Phase-1.45 promoted Listing row: one bound to an exact
 * Offer version through the legacy `accepted*` columns.
 *
 * Phase 1.45 retired the path that wrote these (`createPromotedListing` now
 * refuses), but such rows may still exist, so their reconstruction,
 * projection, and checkout refusal remain tested. This writes one directly
 * through the shared first-version insert, after the same reference checks
 * the retired path made, and without any of its authority or economics gates.
 * It accepts the retired input shape so call sites change only their callee.
 */

import type { Prisma } from "@prisma/client";
import type { getPrisma } from "../../src/server/db/client";
import { versionRowToSourceVersion as offerVersionRowToSourceVersion } from "../../src/server/marketplace/offer-mapper";
import {
  insertFirstVersion,
  readSnapshotInTx,
  requireNoCurrentPlacement,
  type ListingSnapshot,
} from "../../src/server/marketplace/listing-service";
import { cryptoListingIdProvider } from "../../src/server/marketplace/listing-ids";
import { syntheticListingRef } from "./listing-ref-fixture";

type Db = ReturnType<typeof getPrisma>;

export interface LegacyPromotedListingInput {
  storefrontId: string;
  internalProductId: string;
  controllingParticipantId: string;
  retail: { retailPriceMinorUnits: number; retailPriceCurrency: string };
  acceptedOfferSourceRecordId: string;
  acceptedOfferSourceRecordVersion: string;
  actingAccountId: string;
  now: string;
  /** Ignored — accepted so retired call sites compile unchanged. */
  acquisitionPolicy?: unknown;
  upstreamReviewState?: "NO_UPSTREAM_CHANGE" | "REVIEW_REQUIRED";
}

export async function seedLegacyPromotedListing(
  input: LegacyPromotedListingInput,
  deps: { db: Db | Prisma.TransactionClient },
): Promise<ListingSnapshot> {
  const tx = deps.db;
  const row = await tx.offerSourceRecordVersionRow.findUniqueOrThrow({
    where: {
      offerSourceRecordId_sourceRecordVersion: {
        offerSourceRecordId: input.acceptedOfferSourceRecordId,
        sourceRecordVersion: input.acceptedOfferSourceRecordVersion,
      },
    },
  });
  const offer = offerVersionRowToSourceVersion(row);
  if (offer.terms.price.type !== "PAID") throw new Error("legacy promoted fixture needs a PAID Offer");

  await requireNoCurrentPlacement(tx, input);
  const internalListingId = cryptoListingIdProvider.nextInternalListingId();
  await insertFirstVersion(tx, {
    internalListingId,
    listingSourceRecordId: cryptoListingIdProvider.nextListingSourceRecordId(),
    listingRef: syntheticListingRef(),
    storefrontId: input.storefrontId,
    internalProductId: input.internalProductId,
    controllingParticipantId: input.controllingParticipantId,
    placement: {
      listingType: "PROMOTED",
      retail: input.retail,
      offerDependency: {
        internalOfferId: offer.internalOfferId,
        offerSourceRecordId: offer.offerSourceRecordId,
        acceptedOfferSourceRecordVersion: offer.sourceRecordVersion,
        acceptedWholesalePriceMinorUnits: offer.terms.price.wholesalePriceMinorUnits,
        acceptedWholesalePriceCurrency: offer.terms.price.wholesalePriceCurrency,
        acceptedCommissionCalculationPolicyVersion: offer.economics.commissionCalculationPolicyVersion,
        acceptedAt: input.now,
      },
      upstreamReviewState: input.upstreamReviewState ?? "NO_UPSTREAM_CHANGE",
    },
    authorizedByParticipantId: input.controllingParticipantId,
    authorizedByActorId: input.actingAccountId,
    recordedAt: new Date(input.now),
  });
  return await readSnapshotInTx(tx, internalListingId);
}
