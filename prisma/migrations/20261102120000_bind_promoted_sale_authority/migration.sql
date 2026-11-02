-- Phase 1.46 — First Complete Promoted Sale (Contract §16.3, §18, §19).
--
-- Additive only. Nullable columns and foreign keys on two existing tables. No
-- column is dropped or narrowed, no existing row is touched, no helper table is
-- created, and nothing is backfilled. Requires only ALTER and REFERENCES.
--
-- ── Why the Order carries the binding, not only the snapshot ─────────────────
--
-- A package-based promoted Listing (Phase 1.45) names no Offer. Which Seller
-- terms govern a sale, under which Promotion Authorization cycle and which
-- acceptance, is DERIVED at the checkout instant by
-- `readPromotedListingCommerceIn` (purpose TRANSACTION). Those reads are
-- current-state, not historical, and the economic snapshot is written later —
-- when the payment confirms. So the binding that authorized the sale is frozen
-- on the Order when it is placed, and the snapshot copies it when the sale
-- completes. Each column names an immutable row; no terms or amounts are copied.
--
--   Order.promotionAuthorizationId         the APPROVED cycle at placement
--   Order.promotionOfferAcceptanceId       the acceptance covering the terms
--   Order.promotedOfferSourceRecordId /
--   Order.promotedOfferSourceRecordVersion the exact governing Offer version
--   TransactionEconomicSnapshot.promotionAuthorizationId
--   TransactionEconomicSnapshot.promotionOfferAcceptanceId
--       the same authority on the sale record. Its governing Offer version is
--       the existing offerSourceRecordId / offerSourceRecordVersion columns.
--
-- All NULL on seller-direct and legacy promoted rows. RESTRICT throughout: a
-- sale's authority is evidence and is not deletable beneath it.

-- One statement per table, so each table's columns and constraints land
-- together or not at all (a half-applied migration is what made Phase 1.42 fail
-- twice on Production).
ALTER TABLE `Order`
  ADD COLUMN `promotionAuthorizationId` VARCHAR(191) NULL,
  ADD COLUMN `promotionOfferAcceptanceId` VARCHAR(191) NULL,
  ADD COLUMN `promotedOfferSourceRecordId` VARCHAR(191) NULL,
  ADD COLUMN `promotedOfferSourceRecordVersion` VARCHAR(64) NULL,
  ADD CONSTRAINT `Order_promotionAuthorizationId_fkey` FOREIGN KEY (`promotionAuthorizationId`) REFERENCES `PromotionAuthorization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `Order_promotionOfferAcceptanceId_fkey` FOREIGN KEY (`promotionOfferAcceptanceId`) REFERENCES `PromotionOfferAcceptance`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `Order_promotedOfferSourceRecordId_promotedOfferSourceRecord_fkey` FOREIGN KEY (`promotedOfferSourceRecordId`, `promotedOfferSourceRecordVersion`) REFERENCES `OfferSourceRecordVersionRow`(`offerSourceRecordId`, `sourceRecordVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `TransactionEconomicSnapshot`
  ADD COLUMN `promotionAuthorizationId` VARCHAR(191) NULL,
  ADD COLUMN `promotionOfferAcceptanceId` VARCHAR(191) NULL,
  ADD CONSTRAINT `TransactionEconomicSnapshot_promotionAuthorizationId_fkey` FOREIGN KEY (`promotionAuthorizationId`) REFERENCES `PromotionAuthorization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `TransactionEconomicSnapshot_promotionOfferAcceptanceId_fkey` FOREIGN KEY (`promotionOfferAcceptanceId`) REFERENCES `PromotionOfferAcceptance`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
