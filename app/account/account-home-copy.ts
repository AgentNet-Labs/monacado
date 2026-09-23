/**
 * `/account` wording (Phase 1.29) — pure, so it can be tested without a render.
 *
 * Each status gets a plain-language label rather than its enum name. The labels
 * describe where setup stands; none of them promises an outcome, because every
 * step past DRAFT is Monacado's decision, not the page's.
 *
 * Type-only imports: the setup form is a client component and imports this
 * module, so a runtime import from the zod contracts here would ship them to the
 * browser.
 */

import type {
  MarketplaceRole,
  ParticipantStatus,
  RoleAssignmentStatus,
} from "../../src/contracts/marketplace/participant";
import type {
  StorefrontLifecycleState,
  StorefrontVisibility,
} from "../../src/contracts/marketplace/storefront-source";
import type {
  DeliveryMode,
  GeneralAvailabilityState,
} from "../../src/contracts/product/product.capsule";

export const EMAIL_VERIFIED_LABEL = "Verified";
export const EMAIL_UNVERIFIED_LABEL = "Email not verified";

/** Shown only while unverified. Setup is open; going live is what waits. */
export const EMAIL_UNVERIFIED_NOTE =
  "You can start setting up now. Your email address must be verified before anything you set up can go live.";

export const ROLE_LABELS: Readonly<Record<MarketplaceRole, string>> = {
  SELLER: "Seller",
  PROMOTER: "Promoter",
  BUYER: "Buyer",
};

export const ROLE_STATUS_LABELS: Readonly<Record<RoleAssignmentStatus, string>> = {
  DRAFT: "Setup in progress",
  PENDING_ACTIVATION: "Awaiting approval",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  REVOKED: "Ended",
};

export const PARTICIPANT_STATUS_LABELS: Readonly<Record<ParticipantStatus, string>> = {
  DRAFT: "Setup in progress",
  PROFILE_INCOMPLETE: "Setup in progress",
  PROFILE_COMPLETE: "Ready to submit for approval",
  UNDER_REVIEW: "Under review",
  ACTIVE: "Approved",
  RESTRICTED: "Restricted",
  SUSPENDED: "Suspended",
  CLOSED: "Closed",
};

// — Storefronts (Phase 1.30) —

export const STOREFRONT_LIFECYCLE_LABELS: Readonly<Record<StorefrontLifecycleState, string>> = {
  DRAFT: "Draft",
  ACTIVE: "Live",
  SUSPENDED: "Suspended",
  CLOSED: "Closed",
};

export const STOREFRONT_VISIBILITY_LABELS: Readonly<Record<StorefrontVisibility, string>> = {
  PRIVATE: "Private",
  UNLISTED: "Unlisted",
  PUBLIC: "Public",
};

/** Shown before the first Storefront. Drafting is open; going live is what waits. */
export const STOREFRONT_INTRO =
  "Create a private draft storefront. Nothing is public until your storefront is approved to go live.";

/** Shown once the included Storefront exists. No price, plan, or link — the upgrade is not built yet. */
export const STOREFRONT_UPGRADE_NOTE = "Additional storefronts require an upgrade.";

export const STOREFRONT_HANDLE_HINT =
  "3–63 characters: lowercase letters, numbers, and single hyphens. It will be part of your storefront's web address once it goes live.";

// — Storefront presentation (Phase 1.31) —

export const STOREFRONT_OPTIONAL_FIELD_HINT =
  "Tagline and summary are optional. Leave one blank to remove it.";

export const STOREFRONT_HANDLE_FIXED_NOTE = "The handle can't be changed yet.";

// — Products (Phase 1.32) —

export const PRODUCT_INTRO =
  "Add a product as a private draft. Drafts are not listed and not for sale.";

export const PRODUCT_DRAFT_STATUS = "Draft · Not listed for sale";

export const DELIVERY_MODE_LABELS: Readonly<Record<DeliveryMode, string>> = {
  DIGITAL: "Digital",
  PHYSICAL: "Physical (shipped)",
};

export const AVAILABILITY_LABELS: Readonly<Record<GeneralAvailabilityState, string>> = {
  available: "Available",
  "pre-release": "Pre-release",
  unavailable: "Unavailable",
  discontinued: "Discontinued",
};

export const PROMOTABLE_LABELS = {
  true: "Promoters may feature it",
  false: "Not open to promoters",
} as const;

// — Placements (Phase 1.34) —

/** Shown above the placement control. Placement is not pricing, and says so. */
export const PLACEMENT_INTRO =
  "Add one of your products to one of your storefronts. The listing stays a private draft — no price is set and nothing goes on sale.";

/** The state every placement this phase can create is in. */
export const PLACEMENT_DRAFT_STATUS = "Draft · Not live · Not for sale";

/** A Seller with products but nowhere to put them. No redirect, no upsell. */
export const PLACEMENT_NEEDS_STOREFRONT =
  "Create a storefront to add your products to.";

/** A Seller with a storefront and nothing to put in it. */
export const PLACEMENT_NEEDS_PRODUCT =
  "Add a product before you can add it to a storefront.";

// — Withdrawing a placement (Phase 1.35) —

/** The action label. Says what it removes, in the words a person would use. */
export const PLACEMENT_WITHDRAW_LABEL = "Remove from storefront";

/**
 * Shown beside the action. The two reassurances are the point: a person
 * removing a draft placement needs to know they are not deleting the thing they
 * made or the shop they made it for.
 */
export const PLACEMENT_WITHDRAW_NOTE =
  "This removes the draft listing only. Your product stays in your library and your storefront is unchanged. You can add it again later.";

// — Pricing a placement (Phase 1.36) —

/** The action label when the placement carries no price yet. */
export const PLACEMENT_PRICE_SET_LABEL = "Set price";

/** The action label when it already carries one. */
export const PLACEMENT_PRICE_CHANGE_LABEL = "Change price";

/**
 * Shown inside the pricing control.
 *
 * Two jobs, and the second is the important one: say what a price does, and say
 * what it does NOT do. A person who has just typed an amount is exactly the
 * person most likely to assume the item is now for sale.
 */
export const PLACEMENT_PRICE_NOTE =
  "Set what buyers would pay for this product in this storefront. The listing stays a private draft — pricing it does not make it live or put it on sale.";

/** The label above the amount field. The currency is fixed and shown beside it. */
export const PLACEMENT_PRICE_FIELD_LABEL = "Retail price";

/** The only currency this phase prices in. Shown, never chosen. */
export const PLACEMENT_PRICE_CURRENCY = "USD";

export const PLACEMENT_PRICE_HINT = "Amount in US dollars, for example 19.99.";

/** Shown in place of a price while the placement carries none. */
export const PLACEMENT_PRICE_NONE = "No price set";

/**
 * A stored minor-unit amount as the text a person reads.
 *
 * **Presentation only, and never an input to anything.** The authoritative
 * amount is the integer this is given; nothing derived from this string is ever
 * stored, compared, or sent back to the server, so the division below cannot
 * reach a commercial record. The exact decimal-to-minor-unit conversion — the
 * one that does touch authoritative money — is `parseRetailAmount`, which uses
 * no floating-point arithmetic at all.
 *
 * `Intl.NumberFormat` rather than a hand-built symbol and separator, matching
 * the three existing money formatters in this repository (the checkout result
 * page, the listing page, and the transactional notices). It rounds to the
 * currency's own fraction digits, so the binary approximation of `1999 / 100`
 * formats as `$19.99` exactly.
 *
 * Minor units are assumed to be hundredths, which holds for every currency this
 * phase accepts — `SUPPORTED_RETAIL_CURRENCIES` is `USD` alone. That contract
 * is not imported here: this module is loaded by client components and must
 * stay free of runtime imports from the zod contracts.
 */
export function formatRetailPrice(amountMinorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amountMinorUnits / 100,
  );
}
