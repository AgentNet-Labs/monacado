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
