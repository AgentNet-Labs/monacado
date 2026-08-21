/**
 * Order buyer snapshot (Phase 1.2 correction).
 *
 * The private transactional record of **who bought this**, captured at checkout
 * and superseded by the provider's confirmed details once payment completes.
 *
 * ## The policy this implements
 *
 * Account creation stays optional. **Completing a purchase is not anonymous.** A
 * completed order requires authoritative information sufficient for payment
 * authorization, tax jurisdiction and sourcing, fraud and compliance evaluation,
 * transactional communication and support, and fulfillment where applicable.
 *
 * This reverses — narrowly and deliberately — the earlier blanket prohibition on
 * persisting buyer contact and address information. `0M.9` wrote that "the
 * cheapest way to keep a promise about data is to have no column for it", and
 * that was the right instinct for a phase that could not yet charge anyone. It is
 * the wrong rule for a merchant of record: **Monacado cannot determine tax
 * jurisdiction, answer a support question, or ship anything to a buyer it knows
 * nothing about.**
 *
 * What was reversed is exactly that one prohibition. Everything in
 * `NEVER_ON_BUYER_SNAPSHOT` remains forbidden, and the reasoning is unchanged:
 * card data belongs at the processor, and identity dossiers belong nowhere.
 *
 * ## A guest is still a guest
 *
 * A guest Order carries a full snapshot **without** an `Account`, a
 * `MarketplaceParticipant`, or any published Node or capsule. The snapshot is
 * private transactional data attached to one Order — it is not an identity, not a
 * profile, and not reusable across orders. Buying twice as a guest produces two
 * snapshots, because each records who bought *that* order.
 *
 * ## `NEVER_ON_ORDER` still holds, literally
 *
 * `0M.9` named `buyerEmail`, `buyerName`, and `buyerAddress` as never-on-`Order`,
 * and they still are: the `Order` row has no such column and gains none. This is a
 * **separate table**, joined one-to-one, so the commercial record and the personal
 * record stay separable — which is what lets one be retained, exported, or erased
 * on a different schedule from the other.
 *
 * Pure types and pure decisions. No I/O, no clock, no provider.
 */

import { z } from "zod";
import { ORDER_BUYER_SNAPSHOT_ID_RE } from "./identity";
import { AccountEmail } from "../account/account";

// — Identity —

export const OrderBuyerSnapshotId = z
  .string()
  .regex(ORDER_BUYER_SNAPSHOT_ID_RE, "buyerSnapshotId must be mon:obsn:<opaque>");
export type OrderBuyerSnapshotId = z.infer<typeof OrderBuyerSnapshotId>;

// — Address —

/**
 * ISO 3166-1 alpha-2. **Required on every address**, because it is the one field
 * tax sourcing cannot proceed without.
 *
 * Uppercase and exactly two letters, so `US` fits and `United States`, `usa`, and
 * a free-form country name do not. A tax engine keyed on a code cannot accept a
 * label, and normalising labels to codes is a lookup table nobody should be
 * maintaining inside a checkout.
 */
export const CountryCode = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, "countryCode must be an ISO 3166-1 alpha-2 code");
export type CountryCode = z.infer<typeof CountryCode>;

/**
 * A bounded subdivision code — `CA`, `NY`, `ENG`.
 *
 * Nullable, because most of the world does not tax subnationally and inventing a
 * value where none exists would be inventing a jurisdiction. Where it matters
 * (US states, Canadian provinces) it is the difference between a correct rate and
 * a wrong one.
 */
export const RegionCode = z
  .string()
  .min(1)
  .max(8)
  .regex(/^[A-Z0-9-]+$/, "regionCode must be a bounded uppercase subdivision code");
export type RegionCode = z.infer<typeof RegionCode>;

/**
 * A postal address, **structured rather than a blob**.
 *
 * A single free-form field would be unusable for the two things an address is
 * actually for here: deriving a tax jurisdiction, and handing a carrier something
 * it can deliver to. Both need the parts named, and parsing them back out of a
 * blob is a guess dressed as a field.
 *
 * `line2`, `region`, and `postalCode` are nullable because a great many valid
 * addresses have none of them, and a required empty string is a lie that passes
 * validation.
 */
export const PostalAddress = z.strictObject({
  line1: z.string().min(1).max(200),
  line2: z.string().min(1).max(200).nullable(),
  city: z.string().min(1).max(120),
  region: RegionCode.nullable(),
  postalCode: z.string().min(1).max(32).nullable(),
  countryCode: CountryCode,
});
export type PostalAddress = z.infer<typeof PostalAddress>;

// — Provenance —

/**
 * Where these details came from, and therefore how much they may be trusted.
 *
 * The distinction is load-bearing and is the reason this is a stored column
 * rather than an assumption:
 *
 *   - `BUYER_SUPPLIED` — typed into Monacado's own checkout before payment. Good
 *     enough to price tax on, because tax must be computed *before* a buyer is
 *     charged and nothing better exists at that instant.
 *   - `PROVIDER_CONFIRMED` — read back from the completed Checkout Session after
 *     the payment succeeded. **This is the identity the payment actually
 *     authorized**, and it supersedes anything a browser said.
 *
 * A caller cannot set `PROVIDER_CONFIRMED`; only the confirmation path writes it,
 * and it will not be overwritten by later buyer-supplied data. That ordering is
 * what makes "the browser cannot assert the payment identity" true rather than
 * merely intended.
 */
export const BUYER_DETAIL_SOURCES = ["BUYER_SUPPLIED", "PROVIDER_CONFIRMED"] as const;
export const BuyerDetailSource = z.enum(BUYER_DETAIL_SOURCES);
export type BuyerDetailSource = z.infer<typeof BuyerDetailSource>;

// — Input —

/**
 * What a buyer supplies at checkout.
 *
 * Contact and address, and **nothing commercial**. There is still no field for a
 * price, a policy, a payment outcome, or a party — the checkout request's
 * refusals are unchanged, and this widens it by exactly the information the
 * purchase genuinely requires.
 *
 * Billing is always required; shipping depends on what the basket delivers. See
 * `SHIPPING_ADDRESS_POLICY`.
 */
export const BuyerCheckoutDetailsInput = z.strictObject({
  name: z.string().min(1).max(200),
  email: AccountEmail,
  billingAddress: PostalAddress,
  /**
   * **Conditionally required**, on the same structured shape as billing.
   *
   * Required when the basket contains any `PHYSICAL` Product; absent for an
   * all-digital basket, which is never asked for one. The decision is
   * `evaluateBasketFulfillment`'s, taken from explicit Product delivery modes —
   * see `SHIPPING_ADDRESS_POLICY`.
   */
  shippingAddress: PostalAddress.nullable(),
});
export type BuyerCheckoutDetailsInput = z.infer<typeof BuyerCheckoutDetailsInput>;

// — Record —

/**
 * The persisted snapshot, one per Order.
 *
 * `taxCountryCode` and `taxRegionCode` are **derived from the billing address**
 * and stored beside it rather than recomputed on read. That is a deliberate
 * duplication: the jurisdiction a tax amount was actually sourced under must stay
 * answerable even if the derivation rule changes later, and re-deriving it from
 * an address years afterwards would answer a different question.
 */
export const OrderBuyerSnapshotRecord = z.strictObject({
  buyerSnapshotId: OrderBuyerSnapshotId,
  orderId: z.string().min(1).max(191),

  name: z.string().min(1).max(200),
  email: AccountEmail,
  billingAddress: PostalAddress,
  /**
   * `null` when the basket needed no delivery address.
   *
   * That is a **fact worth reading back**, not a gap: it records that this
   * purchase was all-digital, which is why the buyer was never asked.
   */
  shippingAddress: PostalAddress.nullable(),

  /** Derived from `billingAddress` at capture. Never supplied by a caller. */
  taxCountryCode: CountryCode,
  taxRegionCode: RegionCode.nullable(),

  detailSource: BuyerDetailSource,
  capturedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrderBuyerSnapshotRecord = z.infer<typeof OrderBuyerSnapshotRecord>;

/**
 * The tax jurisdiction implied by a billing address.
 *
 * Derived in exactly one place so a forgotten fallback cannot silently source a
 * sale to the wrong regime. **Never from an IP address**: an IP locates a network
 * interface, not a buyer, and sourcing tax from one is guessing with a number
 * that looks authoritative.
 */
export function deriveTaxJurisdiction(billing: PostalAddress): {
  taxCountryCode: string;
  taxRegionCode: string | null;
} {
  return { taxCountryCode: billing.countryCode, taxRegionCode: billing.region };
}

/**
 * The bounded jurisdiction code a tax engine is asked about.
 *
 * `US-CA` where a region exists, `GB` where none does — the same shape
 * `TaxJurisdictionCode` already accepts, built from the snapshot rather than
 * invented.
 */
export function taxJurisdictionCodeFor(billing: PostalAddress): string {
  const { taxCountryCode, taxRegionCode } = deriveTaxJurisdiction(billing);
  return taxRegionCode === null ? taxCountryCode : `${taxCountryCode}-${taxRegionCode}`;
}

// — Shipping is conditional on what the basket delivers —

/**
 * **Billing is always required. Shipping depends on the basket.**
 *
 * ```
 * all lines DIGITAL   → no shipping address requested, and none required
 * any line PHYSICAL   → shipping address required; absence refuses checkout
 * any line UNKNOWN    → checkout refuses. Absence is never a default.
 * ```
 *
 * A mixed basket therefore requires shipping — that falls out of "any" rather
 * than needing its own case, because there is nowhere to ship half an order to.
 *
 * The decision comes from `evaluateBasketFulfillment`, reading **explicit
 * `deliveryMode` facts** off each Product's authoritative source version. It is
 * never inferred from a name, a category, `specifications`, or `capabilities`:
 * those are free-form, and reading a checkout rule out of one would make whether
 * a buyer is asked for an address depend on how somebody phrased a spec key.
 *
 * Not asking is as deliberate as asking. Demanding a delivery address for a
 * download is friction with no purpose, and it teaches buyers that Monacado asks
 * for data it does not need.
 */
export const SHIPPING_ADDRESS_POLICY = {
  billing: "ALWAYS_REQUIRED",
  shipping: "REQUIRED_WHEN_ANY_LINE_IS_PHYSICAL",
  unknownDeliveryMode: "REFUSE_CHECKOUT",
} as const;

// — Never on a buyer snapshot —

/**
 * Named as never-persistable, and refused by the `strictObject` above.
 *
 * **This list is what the privacy reversal did *not* touch.** Buyer contact and
 * address are now permitted because a merchant of record operationally requires
 * them. None of the following is operationally required by Monacado, and each has
 * a specific reason it stays out:
 *
 *   - **payment instrument data** — it belongs at the processor. Monacado's
 *     hosted-checkout design means a card number never touches a Monacado origin,
 *     and a column for one would undo that in a single migration.
 *   - **processor secrets** — an adapter's problem, never a record's.
 *   - **identity documents and KYC dossiers** — `0M.8` refused a provider's
 *     dossier and that refusal stands. Verification is the provider's function
 *     and its evidence is the provider's to hold.
 *   - **arbitrary fraud-provider payloads** — an unbounded blob is where every
 *     field nobody agreed to store eventually appears.
 */
export const NEVER_ON_BUYER_SNAPSHOT = [
  // payment instrument — stays at Stripe, always
  "cardNumber",
  "pan",
  "cvv",
  "cvc",
  "expiryMonth",
  "expiryYear",
  "paymentMethodPayload",
  "stripePaymentMethod",
  "bankAccountNumber",
  "routingNumber",
  "iban",
  // processor secrets — the adapter's problem
  "apiKey",
  "secretKey",
  "clientSecret",
  "webhookSecret",
  // identity and KYC — 0M.8's refusal, unchanged
  "identityDocumentImage",
  "identityDocumentUrl",
  "passportNumber",
  "nationalIdNumber",
  "kycDossier",
  "kycProviderPayload",
  // unbounded provider blobs
  "fraudProviderPayload",
  "riskProviderPayload",
  "rawProviderResponse",
] as const;
