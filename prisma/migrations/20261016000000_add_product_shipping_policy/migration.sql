-- Phase 1.38 — Seller shipping policy on Product source versions
-- (PRODUCT_COMPLETENESS_PROFILE.md §4.2, §5.1; Contract §9).
--
-- Additive only. No column is dropped or narrowed, no existing row is touched,
-- and no existing migration is changed.
--
-- ── Why on the immutable source version ───────────────────────────────────────
--
-- Completeness is derived from the Product's CURRENT authoritative source
-- version, and the Seller shipping policy is one of the facts it reads. So the
-- policy is versioned with the record: a revision writes a new version row with
-- the new policy, and every earlier row keeps the policy it was written with.
--
-- ── Why NULLABLE, and nothing is backfilled ───────────────────────────────────
--
-- NULL is the honest value for every version that exists before this
-- migration: no Seller made a shipping decision for it. Backfilling FREE would
-- record a decision nobody made — and "no decision" and "free shipping" are
-- different facts that completeness must be able to tell apart. Non-shipped
-- Products never carry a policy, so the columns are NULL for them by design.
--
-- ── What this is not ──────────────────────────────────────────────────────────
--
-- Not the shipping amount charged on an Order (transaction economics, frozen on
-- the Order snapshot), not a tax or payment fact, and not a `fact*` column, so
-- it is not projected into any capsule.

ALTER TABLE `ProductSourceRecordVersionRow`
  ADD COLUMN `shippingPolicyMethod` VARCHAR(16) NULL,
  ADD COLUMN `shippingFixedChargeMinorUnits` BIGINT NULL,
  ADD COLUMN `shippingFixedChargeCurrency` VARCHAR(3) NULL;
