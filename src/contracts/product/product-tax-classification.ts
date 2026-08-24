/**
 * Product tax classification (Phase 1.6).
 *
 * The smallest authoritative Product fact a production tax engine needs: **what
 * kind of thing is being sold**, in Monacado's own vocabulary.
 *
 * ## Provider-neutral, and deliberately so
 *
 * A Stripe Tax code (`txcd_…`), an Avalara tax code, and a TaxJar category are
 * each a *vendor's* encoding of a fiscal question. None of them belongs in
 * Product semantics: a Product that carried `txcd_10000000` would be a Product
 * whose meaning depended on a third party's catalogue, and changing engine would
 * mean rewriting immutable history. Monacado records the classification; the
 * **adapter/configuration layer** maps it to whatever the selected engine calls
 * that thing.
 *
 * ## Not a capsule fact
 *
 * This lives on the Product **source record** and is deliberately **absent from
 * `ProductData`**, so it never reaches a published capsule. Two reasons:
 *
 *   1. **Authority.** A tax classification is a *fiscal* characterization used by
 *      Monacado as merchant of record. Publishing it inside the creator's Product
 *      capsule would put a Monacado-fiscal claim under creator authority, which
 *      ADR §2's partitioning exists to prevent.
 *   2. **It is not a determination.** A capsule reader would reasonably treat a
 *      published classification as a statement about tax due. It is not — it is
 *      an input to an engine that makes that determination, under registrations
 *      Monacado configures elsewhere.
 *
 * It follows the same immutable-source-version rule as every other field on the
 * record: a change is a new `sourceRecordVersion`, and the version a sale was
 * calculated under is pinned in that sale's tax evidence forever.
 *
 * ## There is no UNSPECIFIED member
 *
 * `OTHER` and `UNSPECIFIED` were considered and rejected. A member that means
 * "we do not know" is a member an engine can be handed, and the whole point of
 * this fact is that an unclassified Product **cannot be sold under a production
 * tax calculation**. Absence is represented by the field being absent, which
 * fails closed at the checkout boundary rather than resolving to a code.
 *
 * Pure types. No I/O, no vendor, no rate, no rule about what tax is due.
 */

import { z } from "zod";

/**
 * What kind of thing this Product is, for tax purposes.
 *
 * Four members, each chosen because tax regimes routinely treat it differently
 * from the others — not because a finer vocabulary would be more descriptive. A
 * distinction with no fiscal consequence is a distinction somebody has to
 * maintain a mapping for.
 *
 *   - `DIGITAL_GOOD` — delivered electronically and consumed as a good: a
 *     download, an e-book, media. Widely taxed as an electronically supplied
 *     service, and widely at a different rate from its physical equivalent.
 *   - `SOFTWARE` — licensed or hosted software, including SaaS. Separated from
 *     `DIGITAL_GOOD` because many US states and several VAT regimes tax
 *     pre-written software, custom software, and SaaS distinctly.
 *   - `PHYSICAL_GOOD` — tangible property requiring delivery.
 *   - `SERVICE` — labour or a performed service rather than a good.
 *
 * `PHYSICAL_GOOD` is **not** the same fact as `deliveryMode: PHYSICAL`, and
 * neither is derived from the other. Delivery mode answers "does this need a
 * shipping address"; classification answers "how is this taxed". A service can
 * require an address; a physical good's tax category is not implied by needing
 * one. Deriving either from the other would make one question's answer depend on
 * the other's — see `taxClassificationAgreesWithDelivery` for the one
 * *contradiction* that is worth surfacing.
 */
export const PRODUCT_TAX_CLASSIFICATIONS = [
  "DIGITAL_GOOD",
  "SOFTWARE",
  "PHYSICAL_GOOD",
  "SERVICE",
] as const;
export const ProductTaxClassification = z.enum(PRODUCT_TAX_CLASSIFICATIONS);
export type ProductTaxClassification = z.infer<typeof ProductTaxClassification>;

/**
 * Whether a classification and a delivery mode contradict each other outright.
 *
 * The **only** cross-check, and it is narrow on purpose: a `PHYSICAL_GOOD` that
 * is delivered `DIGITAL` is a data-entry error, because there is no tangible
 * property to hand over. Every other pairing is legitimate — a `SERVICE` can be
 * performed at an address, `SOFTWARE` can ship on physical media, and a
 * `DIGITAL_GOOD` can be delivered on a disc.
 *
 * This **reports** a contradiction and decides nothing. What a caller does about
 * one is the caller's policy, and returning `false` here is never a licence to
 * substitute a classification of its own.
 */
export function taxClassificationAgreesWithDelivery(
  classification: ProductTaxClassification,
  deliveryMode: "DIGITAL" | "PHYSICAL",
): boolean {
  return !(classification === "PHYSICAL_GOOD" && deliveryMode === "DIGITAL");
}
