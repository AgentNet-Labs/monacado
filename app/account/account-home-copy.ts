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
import type { ProductCompletenessGap } from "../../src/contracts/product/product-completeness";
import type {
  ProductActivationBlocker,
  ProductLifecycleState,
} from "../../src/contracts/product/product-lifecycle";
import type { ProductResaleAvailability } from "../../src/contracts/product/product-resale-availability";
import type {
  PromotionAuthorizationRequestRefusal,
  PromotionAuthorizationState,
} from "../../src/contracts/marketplace/promotion-authorization";

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

// — Product revision and completeness (Phase 1.38) —

/**
 * Content completeness, in the Seller's words. Deliberately not "Active",
 * "Ready", or anything that sounds like the Product may be sold: completeness
 * is about the Product's own description only.
 */
export const PRODUCT_COMPLETENESS_LABELS = {
  complete: "Details complete",
  incomplete: "Details incomplete",
} as const;

/** Each missing requirement, as a short phrase listed after "Missing:". */
export const PRODUCT_COMPLETENESS_GAP_LABELS: Readonly<Record<ProductCompletenessGap, string>> = {
  NAME_MISSING: "name",
  DESCRIPTION_MISSING: "description",
  DELIVERY_MODE_MISSING: "delivery type",
  SHIPPING_POLICY_MISSING: "shipping charge",
};

export const PRODUCT_EDIT_LABEL = "Edit product";

export const SHIPPING_POLICY_LABELS = {
  FREE: "Free shipping",
  FIXED: "Fixed shipping charge",
} as const;

/** Shown when a shipped Product has no shipping decision yet. Never "free". */
export const SHIPPING_POLICY_NONE = "No shipping charge chosen";

/** USD is the only currency this phase charges shipping in. */
export const SHIPPING_CHARGE_CURRENCY = "USD";

export const SHIPPING_CHARGE_HINT = "In US dollars, for example 4.50. For no charge, choose free shipping.";

/** One line, e.g. "Missing: description, shipping charge". */
export function formatCompletenessGaps(missing: readonly ProductCompletenessGap[]): string {
  return `Missing: ${missing.map((gap) => PRODUCT_COMPLETENESS_GAP_LABELS[gap]).join(", ")}`;
}

// — Product lifecycle and activation (Phase 1.39) —

/** The lifecycle badge. Derived on the server; never stored, never chosen here. */
export const PRODUCT_LIFECYCLE_LABELS: Readonly<Record<ProductLifecycleState, string>> = {
  INCOMPLETE: "Incomplete",
  COMPLETE: "Complete",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
};

/**
 * Follows the badge on every Product. ACTIVE means eligible to sell, not
 * listed: no Listing or Storefront is activated in this phase (Contract §9.1).
 */
export const PRODUCT_NOT_LISTED = "Not listed for sale";

export const PRODUCT_ACTIVATE_LABEL = "Activate product";

/** Beside the button: what activation does, and what it does not. */
export const PRODUCT_ACTIVATE_HINT =
  "Activating makes this product eligible to sell. It does not list it in a storefront.";

/** Why activation is not available yet — one concise reason per blocker. */
export const PRODUCT_ACTIVATION_BLOCKER_LABELS: Readonly<Record<ProductActivationBlocker, string>> = {
  PRODUCT_SUSPENDED: "This product is suspended by Monacado.",
  PRODUCT_INCOMPLETE: "Complete the product details first.",
  EMAIL_UNVERIFIED: "Verify your email address first.",
  FIRST_NAME_MISSING: "Your account has no first name on record.",
  LAST_NAME_MISSING: "Your account has no last name on record.",
  PARTICIPANT_MISSING: "Set up your seller account first.",
  PARTICIPANT_SUSPENDED: "Your account is suspended.",
  PRODUCT_ACTIVATION_RESTRICTED: "Product activation is restricted on your account.",
  PARTICIPANT_NOT_ACTIVE: "Your account has not been approved to sell yet.",
  SELLER_ROLE_NOT_ACTIVE: "Your seller role is not active yet.",
  PAYMENT_NOT_READY: "Finish payment setup first.",
  COMMERCE_APPROVAL_MISSING: "Monacado has not approved your account for selling yet.",
  TAX_CLASSIFICATION_NOT_READY: "Monacado has not classified this product for tax yet.",
};

/** One line naming the first thing in the way, e.g. "Can't activate yet: Finish payment setup first." */
export function formatActivationBlocker(blockers: readonly ProductActivationBlocker[]): string | null {
  const first = blockers[0];
  return first === undefined ? null : `Can't activate yet: ${PRODUCT_ACTIVATION_BLOCKER_LABELS[first]}`;
}

// — Resale availability (Phase 1.40) —

/**
 * The Seller's recorded resale choice, stated as a choice — a separate line from
 * the lifecycle badge, never merged into it. `AVAILABLE` on a Product that is
 * not active is shown as a preference that is not in effect, never as resale.
 */
export function formatResaleAvailability(
  resaleAvailability: ProductResaleAvailability,
  resaleEffective: boolean,
): string {
  switch (resaleAvailability) {
    case "NOT_OFFERED":
      return "Not offered for resale";
    case "AVAILABLE":
      return resaleEffective
        ? "Resale available"
        : "Resale preference: Available, currently ineffective because the product is not active";
    case "PAUSED":
      return "Resale paused";
    case "WITHDRAWN":
      return "Withdrawn from resale";
  }
}

/** What resale availability is, and what it is not. */
export const RESALE_AVAILABILITY_HINT =
  "Resale availability is your product-wide permission for third-party resale. It does not create an offer, approve any promoter, or list anything for sale.";

/** The button for each governed target, worded from where the Product stands. */
export function resaleActionLabel(
  current: ProductResaleAvailability,
  target: ProductResaleAvailability,
): string {
  if (target === "AVAILABLE") return current === "PAUSED" ? "Resume resale" : "Make available for resale";
  if (target === "PAUSED") return "Pause resale";
  if (target === "WITHDRAWN") return "Withdraw from resale";
  return "Not offered for resale";
}

/** Why `AVAILABLE` cannot be newly chosen while the Product is not active. */
export const RESALE_REQUIRES_ACTIVE =
  "Resale can be made available only while the product is active.";

/** Shown beside the withdrawal confirmation — it has no way back here. */
export const RESALE_WITHDRAW_WARNING =
  "Withdrawing ends resale availability for this product. Reopening a withdrawn product is not available.";

export const RESALE_WITHDRAW_CONFIRM = "Confirm withdrawal";

/** Shown once withdrawn, where no control remains. */
export const RESALE_WITHDRAWN_NOTE = "Reopening a withdrawn product is not available.";

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

// — Promotion Authorization (Phase 1.41) —

/** Each relationship state in plain words. None of them says anything is for sale. */
export const PROMOTION_AUTHORIZATION_STATE_LABELS: Record<PromotionAuthorizationState, string> = {
  REQUESTED: "Requested",
  APPROVED: "Approved",
  DENIED: "Denied",
  REVOKED: "Revoked",
  CANCELLED: "Cancelled",
};

/** The Seller's per-Product heading, and what approval does and does not do. */
export const PROMOTION_SELLER_HEADING = "Promoters";
export const PROMOTION_SELLER_NOTE =
  "Approving lets that promoter promote this product. It is permission only — nothing goes on sale, and you can revoke it at any time without affecting other promoters.";
export const PROMOTION_APPROVE_LABEL = "Approve";
export const PROMOTION_DENY_LABEL = "Deny";
export const PROMOTION_REVOKE_LABEL = "Revoke";

/** The Promoter's section. */
export const PROMOTION_PROMOTER_HEADING = "Promotion requests";
export const PROMOTION_PROMOTER_INTRO =
  "Ask a seller for permission to promote one of their products, using the product reference they shared with you. Approval is permission only — nothing is for sale until the product and its terms are ready.";
export const PROMOTION_REQUEST_FIELD_LABEL = "Product reference";
export const PROMOTION_REQUEST_LABEL = "Request permission";
export const PROMOTION_REQUEST_AGAIN_LABEL = "Request again";
export const PROMOTION_NONE = "You haven't asked to promote any products yet.";

/** The Promoter's withdrawal, worded for what it ends. */
export function promotionCancelLabel(state: PromotionAuthorizationState): string {
  return state === "APPROVED" ? "Stop promoting" : "Cancel request";
}

const PROMOTION_REQUEST_REFUSAL_TEXT: Record<PromotionAuthorizationRequestRefusal, string> = {
  ACCOUNT_DISABLED: "this account is disabled",
  EMAIL_UNVERIFIED: "verify your email address",
  FIRST_NAME_MISSING: "add your first name",
  LAST_NAME_MISSING: "add your last name",
  PARTICIPANT_MISSING: "start Promoter setup",
  PARTICIPANT_STATUS_NOT_ELIGIBLE: "your marketplace account isn't eligible",
  PARTICIPANT_SUSPENDED: "your marketplace account is suspended",
  PROMOTER_ROLE_NOT_HELD: "start Promoter setup",
  PROMOTER_ROLE_NOT_ELIGIBLE: "your Promoter setup isn't eligible",
};

/** Why the Promoter cannot request yet, as one sentence. */
export function formatPromotionRequestRefusals(refusals: readonly PromotionAuthorizationRequestRefusal[]): string {
  const parts = [...new Set(refusals.map((r) => PROMOTION_REQUEST_REFUSAL_TEXT[r]))];
  return `Before you can ask to promote products: ${parts.join("; ")}.`;
}
