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
 * ## Two addresses, both required (Phase 1.6)
 *
 * Standard Monacado retail checkout takes a **billing address** and a **ship-to
 * address**, on every purchase. Billing is the payment and transaction record;
 * ship-to is the destination and **the tax jurisdiction**, digital and physical
 * alike. `shipToSameAsBilling` supplies the second from the first so nobody types
 * one address twice, and a ship-to address on a download implies no physical
 * fulfillment. There is no third buyer-facing tax address.
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
 * **Billing and ship-to are both always required**, and `shipToSameAsBilling`
 * supplies the second from the first. See `BUYER_ADDRESS_POLICY`.
 */
export const BuyerCheckoutDetailsInput = z.strictObject({
  name: z.string().min(1).max(200),
  email: AccountEmail,
  billingAddress: PostalAddress,
  /**
   * The **ship-to address**, required for every completed transaction.
   *
   * `null` **only** when `shipToSameAsBilling` is set — in which case billing
   * supplies it. It is never left null on the stored snapshot: see
   * `resolveShipToAddress`.
   */
  shippingAddress: PostalAddress.nullable(),
  /**
   * The ordinary retail convenience: *ship to my billing address*.
   *
   * Present so a buyer is never made to type one address twice. It is a **form
   * affordance, not a second address concept** — selecting it copies billing into
   * the authoritative ship-to fields, and what is stored afterwards is an
   * ordinary ship-to address indistinguishable from one that was typed.
   *
   * Defaults to `false` so an omitted flag can never silently substitute billing
   * for an address a buyer meant to give.
   */
  shipToSameAsBilling: z.boolean().default(false),
});
export type BuyerCheckoutDetailsInput = z.infer<typeof BuyerCheckoutDetailsInput>;

/**
 * The one place a ship-to address is resolved, and the invariant it enforces.
 *
 * **Every completed transaction has a ship-to address** — digital, physical, and
 * a future mixed basket alike. Two ways to arrive at one, and no third:
 *
 *   - `shipToSameAsBilling` → billing is **copied** into ship-to;
 *   - otherwise the buyer supplies a distinct one.
 *
 * Neither present is a refusal, never a fallback to billing. A silent fallback
 * would tax a sale to an address the buyer never nominated, and would do it
 * invisibly.
 *
 * The copy is deliberate rather than a reference: the stored snapshot must hold a
 * populated ship-to even when it began as "same as billing", so that a later
 * reader — or a later correction to billing — cannot change where a completed
 * sale was taxed and sent.
 */
export function resolveShipToAddress(details: {
  billingAddress: PostalAddress;
  shippingAddress: PostalAddress | null;
  shipToSameAsBilling?: boolean;
}): PostalAddress {
  if (details.shipToSameAsBilling === true) return { ...details.billingAddress };
  const parsed = PostalAddress.safeParse(details.shippingAddress);
  if (!parsed.success) {
    throw new ShipToAddressRequiredError();
  }
  return parsed.data;
}

/**
 * No ship-to address could be resolved, so no sale may proceed.
 *
 * Carries no address and no field values — a refusal about an address is exactly
 * the log line an address ends up in.
 */
export class ShipToAddressRequiredError extends Error {
  readonly detail = "SHIPPING_ADDRESS_REQUIRED";
  constructor() {
    super("A ship-to address is required for every purchase");
    this.name = "ShipToAddressRequiredError";
  }
}

// — Record —

/**
 * The persisted snapshot, one per Order.
 *
 * **Four things every new Order has**: a buyer name, a buyer email, a billing
 * address, and a ship-to address. The application boundary enforces all four;
 * the shipping columns stay nullable in the database only so Orders written
 * before this policy stay readable, and nothing new is written with them empty.
 *
 * `taxCountryCode` and `taxRegionCode` are **derived from the ship-to address**
 * and stored beside it rather than recomputed on read. That is a deliberate
 * duplication: the jurisdiction a tax amount was actually sourced under must stay
 * answerable even if the derivation rule changes later, and re-deriving it from
 * an address years afterwards would answer a different question.
 *
 * There is **no third address**. Billing is the payment record, ship-to is the
 * destination, and the tax jurisdiction is a derived *code* — not a separate
 * buyer-facing tax address, which the settled policy does not have.
 */
export const OrderBuyerSnapshotRecord = z.strictObject({
  buyerSnapshotId: OrderBuyerSnapshotId,
  orderId: z.string().min(1).max(191),

  name: z.string().min(1).max(200),
  email: AccountEmail,
  billingAddress: PostalAddress,
  /**
   * The ship-to address. **Populated on every Order written under this policy**,
   * including one where the buyer chose "same as billing" — the values are copied
   * in, never left null to mean "look at billing instead".
   *
   * Nullable only for Orders that predate the policy, where no ship-to was ever
   * collected and inventing one would fabricate a destination.
   */
  shippingAddress: PostalAddress.nullable(),

  /** Derived from `shippingAddress` at capture. Never supplied by a caller. */
  taxCountryCode: CountryCode,
  taxRegionCode: RegionCode.nullable(),

  detailSource: BuyerDetailSource,
  capturedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrderBuyerSnapshotRecord = z.infer<typeof OrderBuyerSnapshotRecord>;

/**
 * The tax jurisdiction implied by the **ship-to** address.
 *
 * Derived in exactly one place so a forgotten fallback cannot silently source a
 * sale to the wrong regime, and from one address only — **there is no runtime
 * choice of tax source**. Never from billing, never buyer-declared, and **never
 * from an IP address**: an IP locates a network interface, not a buyer, and
 * sourcing tax from one is guessing with a number that looks authoritative.
 */
export function deriveTaxJurisdiction(shipTo: PostalAddress): {
  taxCountryCode: string;
  taxRegionCode: string | null;
} {
  return { taxCountryCode: shipTo.countryCode, taxRegionCode: shipTo.region };
}

/**
 * The bounded jurisdiction code a tax engine is asked about.
 *
 * `US-CA` where a region exists, `GB` where none does — the same shape
 * `TaxJurisdictionCode` already accepts, built from the snapshot rather than
 * invented.
 */
/**
 * The bounded jurisdiction code a sale is sourced under, from its ship-to address.
 *
 * `US-CA` where a subdivision exists, `GB` where none does. One input, one rule,
 * and no alternative: helpers that derived a jurisdiction from billing, or chose
 * between billing and shipping, existed briefly during Phase 1.6 and were
 * removed. A second derivation sitting beside this one is a second answer waiting
 * to be called by mistake.
 */
export function taxJurisdictionCodeFor(shipTo: PostalAddress): string {
  const { taxCountryCode, taxRegionCode } = deriveTaxJurisdiction(shipTo);
  return taxRegionCode === null ? taxCountryCode : `${taxCountryCode}-${taxRegionCode}`;
}

// — Shipping is conditional on what the basket delivers —

/**
 * **Two addresses, both always required.**
 *
 * ```
 * billing   ALWAYS required — the payment and transaction record
 * ship-to   ALWAYS required — the destination, and the tax jurisdiction
 * ```
 *
 * This settles a question Phase 1.2 answered differently. `1.2` collected a
 * shipping address only when something physical was in the basket, and sourced
 * tax to billing; Phase 1.6's first correction made sourcing depend on what was
 * being delivered. Both are superseded: **standard Monacado retail checkout takes
 * a billing address and a ship-to address, and tax is always sourced to ship-to.**
 * There is no third buyer-facing tax address and no runtime choice of tax source.
 *
 * **`shipToSameAsBilling` is why this is not friction.** A buyer shipping to the
 * address they pay from ticks one box; the values are copied into the ship-to
 * fields, and nobody types an address twice.
 *
 * **A ship-to address does not imply physical fulfillment.** For a digital
 * purchase it is a destination for *tax* purposes and nothing else: no parcel, no
 * carrier, no shipping address collected on the provider's hosted page, and the
 * digital-delivery entitlement policy is untouched. Whether anything physically
 * ships remains `evaluateBasketFulfillment`'s question, decided from explicit
 * Product `deliveryMode` facts — never from a name, a category, `specifications`,
 * or `capabilities`.
 *
 * A **mixed** basket is ordinary here: every line shares the one transaction
 * ship-to for tax sourcing. Split shipments and multiple destinations are not
 * implemented, and would need their own governed design.
 */
export const BUYER_ADDRESS_POLICY = {
  billing: "ALWAYS_REQUIRED",
  shipTo: "ALWAYS_REQUIRED",
  shipToSameAsBilling: "SUPPORTED",
  taxJurisdictionSource: "SHIP_TO",
  digitalShipToImpliesFulfillment: false,
  physicalFulfillmentDecision: "PRODUCT_DELIVERY_MODE",
  unknownDeliveryMode: "REFUSE_CHECKOUT",
  multipleShipToDestinations: "NOT_IMPLEMENTED",
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
