-- Phase 1.6 — Production Tax Integration.
--
-- ADDITIVE ONLY. Every statement below either ADDs a NULLABLE column or CREATEs
-- an index. Nothing is dropped, nothing is renamed, no column is narrowed, no
-- committed migration is modified, and no existing row is rewritten.
--
-- Every column is NULLABLE FOR BACKWARD COMPATIBILITY, and in no case is
-- absence a default:
--
--   * ProductSourceRecordVersionRow.taxClassification — Product source versions
--     written before Phase 1.6 declare none. A production tax calculation
--     REFUSES an unclassified Product rather than assuming a category.
--
--   * OrderTaxEvidence.* — tax evidence rows written before Phase 1.6 have no
--     Product basis, provider mode, or mapping version, and cannot be given one
--     retroactively without inventing what a historical calculation was told.
--     Every row written from now on sets them.
--
-- Tax is sourced to the Order's SHIP-TO address, always, so there is no column
-- recording which address was used: it would have exactly one legitimate value.
-- The addresses themselves live once, on OrderBuyerSnapshot, whose shipping
-- columns stay NULLABLE for Orders predating the two-address policy while the
-- application boundary requires a ship-to address on every new Order.

-- AlterTable
ALTER TABLE `OrderTaxEvidence` ADD COLUMN `productSourceRecordId` VARCHAR(191) NULL,
    ADD COLUMN `productSourceRecordVersion` VARCHAR(64) NULL,
    ADD COLUMN `productTaxClassification` VARCHAR(32) NULL,
    ADD COLUMN `providerCalculationExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `providerConfigVersion` VARCHAR(64) NULL,
    ADD COLUMN `providerMode` VARCHAR(16) NULL,
    ADD COLUMN `providerTaxCode` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `ProductSourceRecordVersionRow` ADD COLUMN `taxClassification` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `OrderTaxEvidence_productSourceRecordId_productSourceRecordVe_idx` ON `OrderTaxEvidence`(`productSourceRecordId`, `productSourceRecordVersion`);

