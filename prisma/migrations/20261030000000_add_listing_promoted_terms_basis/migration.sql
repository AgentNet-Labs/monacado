-- Phase 1.45 — Promoted Listing integration (Contract §13, §14, §16.3, §19).
--
-- Additive only. One nullable column and one CHECK on an existing table. No
-- column is dropped or narrowed, no existing row is touched, no helper table is
-- created, and nothing is backfilled. Requires only ALTER.
--
-- ── What is stored, and what is not ──────────────────────────────────────────
--
--   ListingSourceRecordVersionRow.promotedTermsBasis
--       'PROMOTION_PACKAGE' on every promoted Listing version written from
--       Phase 1.45 on; NULL on every seller-direct version and on every legacy
--       (0M.7) promoted version. A PROMOTION_PACKAGE Listing names no Offer: the
--       Seller terms that govern it are DERIVED at an instant from the
--       Product's current Offer, the Promoter's current Promotion Authorization
--       cycle, and that cycle's PromotionOfferAcceptance rows (Phase 1.44).
--
--   ListingSourceRecordVersionRow_promoted_terms_basis_check
--       holds the new kind structurally free of the legacy `accepted*` binding
--       and `upstreamReviewState`, so a Listing can never become a second
--       answer to the Seller's terms. Every existing row has a NULL basis and
--       passes. The legacy columns are retained, unwritten, as history.
--
--       MySQL refuses a CHECK over a column used in a foreign key's referential
--       action (error 3823), so the three FK members of the legacy binding
--       (`acceptedInternalOfferId`, `acceptedOfferSourceRecordId`,
--       `acceptedOfferSourceRecordVersion`) cannot appear here. Their absence
--       on this kind is held by the only write path (`placementToColumns`
--       writes them NULL) and by the read path, which refuses such a row as
--       corrupt (`listing-mapper.placementFromRow`).
--
-- Not stored: any Offer reference, accepted version, acceptance or
-- authorization id, economics, or effectiveness flag. Nothing here is published.

-- One statement, so the column and its constraint land together or not at all:
-- MySQL DDL is not transactional across statements, and a half-applied
-- migration is what made Phase 1.42 fail twice on Production.
ALTER TABLE `ListingSourceRecordVersionRow`
  ADD COLUMN `promotedTermsBasis` VARCHAR(32) NULL,
  ADD CONSTRAINT `ListingSourceRecordVersionRow_promoted_terms_basis_check` CHECK (
  `promotedTermsBasis` IS NULL OR (
    `promotedTermsBasis` = 'PROMOTION_PACKAGE' AND
    `listingType` = 'PROMOTED' AND
    `acceptedWholesalePriceMinorUnits` IS NULL AND
    `acceptedWholesalePriceCurrency` IS NULL AND
    `acceptedCommissionCalculationPolicyVersion` IS NULL AND
    `acceptedAt` IS NULL AND
    `upstreamReviewState` IS NULL
  )
);
