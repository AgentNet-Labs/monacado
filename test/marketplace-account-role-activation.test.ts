/**
 * Marketplace account, role, activation, and review-authority tests (Phase 0M.1).
 *
 * NO DATABASE, NO NETWORK, NO CLOCK. Every contract under test is a pure function
 * of its argument, which is why the whole authorization model can be exercised
 * here rather than through fixtures or a route.
 *
 * The numbered `describe` blocks correspond one-to-one with the twenty-two
 * properties Phase 0M.1 was required to prove.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCOUNT_STATUSES, AccountStatus } from "../src/contracts/account/account";
import {
  MARKETPLACE_ROLES,
  MarketplaceParticipantView,
  MarketplaceRole,
  MarketplaceSubject,
  GUEST_SUBJECT,
  ParticipantStatus,
  PaymentReadinessStatus,
  RoleAssignmentStatus,
  holdsActiveRole,
  holdsRole,
} from "../src/contracts/marketplace/participant";
import {
  INITIAL_PARTICIPANT_STATUS,
  INITIAL_PAYMENT_READINESS,
  initialRoleAssignmentStatus,
  isValidInitialRoleAssignmentStatus,
  isValidParticipantTransition,
  isValidPaymentReadinessTransition,
  isValidRoleAssignmentTransition,
} from "../src/contracts/marketplace/lifecycle";
import {
  CapabilityDecision,
  MARKETPLACE_CAPABILITIES,
  MarketplaceCapability,
  ReviewCapsuleActionRequest,
  canAccrueCommission,
  canActivateStorefront,
  canCreateDraftProduct,
  canCreateDraftStorefront,
  canCreatePromotedListing,
  canPublishOffer,
  canPublishProductReviewCapsule,
  canPublishSellerReviewCapsule,
  canReceivePayout,
  canSubmitActivation,
  canSubmitProductReview,
  canSubmitSellerReview,
  evaluateReviewCapsuleAuthority,
  internalCapabilitiesGrantedByMarketplaceRoles,
  marketplaceCapabilitiesGrantedByInternalEntitlement,
  type CapabilityReasonCode,
} from "../src/contracts/marketplace/capability";
import {
  PublicReviewAttribution,
  ProjectReviewAttributionInput,
  REVIEW_CAPSULE_ACTIONS,
  ReviewCapsuleAction,
  ReviewSubmissionAuthorityView,
  projectPublicReviewAttribution,
} from "../src/contracts/marketplace/review-authority";

// — Fixtures —

/** A valid 26-character Crockford opaque body. Digits only: always in-alphabet. */
const body = (n: number): string => String(n).padStart(26, "0");

const ACCOUNT_ID = `mon:acct:${body(1)}`;
const OTHER_ACCOUNT_ID = `mon:acct:${body(2)}`;
const PARTICIPANT_ID = `mon:mpart:${body(3)}`;
const REVIEW_ID = `mon:rsub:${body(4)}`;
const OTHER_REVIEW_ID = `mon:rsub:${body(5)}`;
const AUTHORITY_ID = `mon:rauth:${body(6)}`;
const EVIDENCE_ID = `mon:pvev:${body(7)}`;
const PRODUCT_REF = `mon:product:${body(8)}`;

type RoleSpec = readonly [MarketplaceRole, RoleAssignmentStatus];

function participant(spec: {
  status: ParticipantStatus;
  roles: readonly RoleSpec[];
  paymentReadiness?: PaymentReadinessStatus;
  accountId?: string;
}): MarketplaceParticipantView {
  return MarketplaceParticipantView.parse({
    participantId: PARTICIPANT_ID,
    accountId: spec.accountId ?? ACCOUNT_ID,
    status: spec.status,
    roles: spec.roles.map(([role, status]) => ({ role, status })),
    paymentReadiness: spec.paymentReadiness ?? "NOT_STARTED",
  });
}

function subject(spec: {
  account?: AccountStatus | null;
  participant?: MarketplaceParticipantView | null;
  internalCapabilities?: readonly string[];
}): MarketplaceSubject {
  return MarketplaceSubject.parse({
    account: spec.account === null ? null : { accountId: ACCOUNT_ID, status: spec.account ?? "ACTIVE" },
    participant: spec.participant ?? null,
    internalCapabilities: spec.internalCapabilities ?? [],
  });
}

/** A seller/promoter drafting before any activation — the "bare-bones account". */
function bare(role: MarketplaceRole): MarketplaceSubject {
  return subject({ participant: participant({ status: "DRAFT", roles: [[role, "DRAFT"]] }) });
}

/** A fully admitted, fully payable participant in the given roles. */
function tradingParticipant(...roles: MarketplaceRole[]): MarketplaceParticipantView {
  return participant({
    status: "ACTIVE",
    roles: roles.map((r) => [r, "ACTIVE"] as RoleSpec),
    paymentReadiness: "ENABLED",
  });
}

/**
 * Every assertion runs the decision through its schema first, so a malformed
 * decision — an ALLOW carrying reasons, or a DENY carrying none — fails here
 * rather than being read as a verdict.
 */
function expectAllow(decision: CapabilityDecision, capability: MarketplaceCapability): void {
  expect(CapabilityDecision.parse(decision)).toEqual({
    capability,
    decision: "ALLOW",
    reasonCodes: [],
  });
}

function expectDeny(decision: CapabilityDecision, ...codes: CapabilityReasonCode[]): void {
  CapabilityDecision.parse(decision);
  expect(decision.decision).toBe("DENY");
  expect(decision.reasonCodes).toEqual(codes);
}

function authority(overrides: Partial<ReviewSubmissionAuthorityView> = {}) {
  return ReviewSubmissionAuthorityView.parse({
    authorityId: AUTHORITY_ID,
    reviewSubmissionId: REVIEW_ID,
    reviewKind: "PRODUCT_REVIEW",
    reviewSubjectRef: PRODUCT_REF,
    submitter: "ACCOUNT_BUYER",
    purchaseProvenance: "VERIFIED",
    purchaseEvidenceRef: EVIDENCE_ID,
    submissionState: "SUBMITTED",
    status: "ACTIVE",
    ...overrides,
  });
}

function capsuleRequest(
  action: ReviewCapsuleAction,
  overrides: {
    authority?: ReviewSubmissionAuthorityView;
    targetKind?: string;
    targetRef?: string;
  } = {},
): ReviewCapsuleActionRequest {
  const auth = overrides.authority ?? authority();
  return ReviewCapsuleActionRequest.parse({
    authority: auth,
    action,
    target: {
      kind: overrides.targetKind ?? auth.reviewKind,
      ref: overrides.targetRef ?? auth.reviewSubmissionId,
    },
  });
}

// — 1 —

describe("1. account status is separate from participant status", () => {
  it("the account vocabulary is identity-level only", () => {
    expect(ACCOUNT_STATUSES).toEqual(["ACTIVE", "DISABLED"]);
    for (const marketplaceOnly of ["PROFILE_INCOMPLETE", "UNDER_REVIEW", "RESTRICTED", "CLOSED"]) {
      expect(AccountStatus.safeParse(marketplaceOnly).success).toBe(false);
    }
  });

  it("the participant vocabulary does not accept an account status", () => {
    expect(ParticipantStatus.safeParse("DISABLED").success).toBe(false);
    expect(ParticipantStatus.safeParse("ACTIVE").success).toBe(true);
  });

  it("a disabled account denies commerce even with a fully active participant", () => {
    const s = subject({ account: "DISABLED", participant: tradingParticipant("SELLER") });
    expectDeny(canActivateStorefront(s), "ACCOUNT_DISABLED");
    expectDeny(canReceivePayout(s), "ACCOUNT_DISABLED");
    expectDeny(canCreateDraftProduct(s), "ACCOUNT_DISABLED");
  });

  it("an active account with no participant is authenticated and nothing more", () => {
    const s = subject({ account: "ACTIVE", participant: null });
    expectDeny(canCreateDraftStorefront(s), "PARTICIPANT_REQUIRED");
    expectDeny(canSubmitActivation(s), "PARTICIPANT_REQUIRED");
  });
});

// — 2 —

describe("2. internal entitlement is separate from marketplace role", () => {
  it("INTERNAL_OPERATOR is not a marketplace role", () => {
    expect(MARKETPLACE_ROLES).toEqual(["SELLER", "PROMOTER", "BUYER"]);
    expect(MarketplaceRole.safeParse("INTERNAL_OPERATOR").success).toBe(false);
  });

  it("an internal entitlement grants no marketplace capability", () => {
    expect(marketplaceCapabilitiesGrantedByInternalEntitlement(["publication-worker:status:read"]))
      .toEqual([]);
  });

  it("marketplace roles grant no internal capability", () => {
    expect(internalCapabilitiesGrantedByMarketplaceRoles(["SELLER", "PROMOTER", "BUYER"]))
      .toEqual([]);
  });

  it("holding the internal capability changes no marketplace decision", () => {
    const p = participant({ status: "DRAFT", roles: [["SELLER", "DRAFT"]] });
    const without = subject({ participant: p });
    const with_ = subject({ participant: p, internalCapabilities: ["publication-worker:status:read"] });
    for (const decide of [
      canCreateDraftStorefront,
      canCreateDraftProduct,
      canCreatePromotedListing,
      canSubmitActivation,
      canActivateStorefront,
      canPublishOffer,
      canReceivePayout,
      canAccrueCommission,
    ]) {
      expect(decide(with_)).toEqual(decide(without));
    }
  });

  it("an operator with no participant holds no marketplace capability", () => {
    const s = subject({ internalCapabilities: ["publication-worker:status:read"] });
    expectDeny(canCreateDraftProduct(s), "PARTICIPANT_REQUIRED");
    expectDeny(canReceivePayout(s), "PARTICIPANT_REQUIRED");
  });
});

// — 3 —

describe("3. one account may hold SELLER and PROMOTER", () => {
  const both = tradingParticipant("SELLER", "PROMOTER");
  const s = subject({ participant: both });

  it("both assignments coexist on one participant and one account", () => {
    expect(holdsActiveRole(both, "SELLER")).toBe(true);
    expect(holdsActiveRole(both, "PROMOTER")).toBe(true);
    expect(both.accountId).toBe(ACCOUNT_ID);
    expect(both.participantId).toBe(PARTICIPANT_ID);
  });

  it("each role's capabilities apply additively", () => {
    expectAllow(canCreateDraftProduct(s), "product:draft:create");
    expectAllow(canCreatePromotedListing(s), "listing:promoted:create");
    expectAllow(canPublishOffer(s), "offer:publish");
    expectAllow(canAccrueCommission(s), "commission:accrue");
  });
});

// — 4 —

describe("4. BUYER may coexist with the other roles", () => {
  it("all three roles are held at once", () => {
    const all = tradingParticipant("SELLER", "PROMOTER", "BUYER");
    expect(all.roles).toHaveLength(3);
    for (const role of MARKETPLACE_ROLES) expect(holdsRole(all, role)).toBe(true);
  });

  it("holding BUYER neither adds nor removes seller capability", () => {
    const withBuyer = subject({ participant: tradingParticipant("SELLER", "BUYER") });
    const withoutBuyer = subject({ participant: tradingParticipant("SELLER") });
    expect(canPublishOffer(withBuyer)).toEqual(canPublishOffer(withoutBuyer));
    expectAllow(
      canSubmitProductReview({ subject: withBuyer, purchaseProvenance: "VERIFIED" }),
      "review:product:submit",
    );
  });
});

// — 5 —

describe("5. a guest buyer requires no account", () => {
  it("the guest subject is a valid subject with no identity", () => {
    expect(MarketplaceSubject.safeParse(GUEST_SUBJECT).success).toBe(true);
    expect(GUEST_SUBJECT.account).toBeNull();
    expect(GUEST_SUBJECT.participant).toBeNull();
  });

  it("a guest with verified provenance may review", () => {
    expectAllow(
      canSubmitProductReview({ subject: GUEST_SUBJECT, purchaseProvenance: "VERIFIED" }),
      "review:product:submit",
    );
    expectAllow(
      canSubmitSellerReview({ subject: GUEST_SUBJECT, purchaseProvenance: "VERIFIED" }),
      "review:seller:submit",
    );
  });

  it("a guest holds no seller, promoter, or activation capability", () => {
    expectDeny(canCreateDraftStorefront(GUEST_SUBJECT), "ACCOUNT_REQUIRED");
    expectDeny(canCreateDraftProduct(GUEST_SUBJECT), "ACCOUNT_REQUIRED");
    expectDeny(canSubmitActivation(GUEST_SUBJECT), "ACCOUNT_REQUIRED");
    expectDeny(canReceivePayout(GUEST_SUBJECT), "ACCOUNT_REQUIRED");
  });

  it("a participant cannot exist without an account", () => {
    const orphan = MarketplaceSubject.safeParse({
      account: null,
      participant: participant({ status: "ACTIVE", roles: [["BUYER", "ACTIVE"]] }),
      internalCapabilities: [],
    });
    expect(orphan.success).toBe(false);
  });

  it("a participant may not be bound to a different account", () => {
    const mismatched = MarketplaceSubject.safeParse({
      account: { accountId: OTHER_ACCOUNT_ID, status: "ACTIVE" },
      participant: participant({ status: "ACTIVE", roles: [["BUYER", "ACTIVE"]] }),
      internalCapabilities: [],
    });
    expect(mismatched.success).toBe(false);
  });
});

// — 6 —

describe("6. a bare SELLER may draft but not activate", () => {
  const s = bare("SELLER");

  it("drafts", () => {
    expectAllow(canCreateDraftStorefront(s), "storefront:draft:create");
    expectAllow(canCreateDraftProduct(s), "product:draft:create");
  });

  it("does not activate, publish an offer, or take money", () => {
    expectDeny(canSubmitActivation(s), "PROFILE_NOT_COMPLETE");
    expectDeny(canActivateStorefront(s), "PARTICIPANT_NOT_ACTIVATED");
    expectDeny(canPublishOffer(s), "PARTICIPANT_NOT_ACTIVATED");
    expectDeny(canReceivePayout(s), "PARTICIPANT_NOT_ACTIVATED");
  });
});

// — 7 —

describe("7. a bare PROMOTER may draft but not activate", () => {
  const s = bare("PROMOTER");

  it("drafts a storefront and a promoted listing", () => {
    expectAllow(canCreateDraftStorefront(s), "storefront:draft:create");
    expectAllow(canCreatePromotedListing(s), "listing:promoted:create");
  });

  it("does not activate, accrue, or take money", () => {
    expectDeny(canSubmitActivation(s), "PROFILE_NOT_COMPLETE");
    expectDeny(canActivateStorefront(s), "PARTICIPANT_NOT_ACTIVATED");
    expectDeny(canAccrueCommission(s), "PARTICIPANT_NOT_ACTIVATED");
    expectDeny(canReceivePayout(s), "PARTICIPANT_NOT_ACTIVATED");
  });
});

// — 8 —

describe("8. a profile-incomplete participant cannot submit activation", () => {
  it("is refused for the profile, not for the role", () => {
    const s = subject({
      participant: participant({ status: "PROFILE_INCOMPLETE", roles: [["SELLER", "DRAFT"]] }),
    });
    expectDeny(canSubmitActivation(s), "PROFILE_NOT_COMPLETE");
    expectAllow(canCreateDraftProduct(s), "product:draft:create");
  });

  it("payment readiness does not substitute for the profile", () => {
    const s = subject({
      participant: participant({
        status: "PROFILE_INCOMPLETE",
        roles: [["SELLER", "DRAFT"]],
        paymentReadiness: "ENABLED",
      }),
    });
    expectDeny(canSubmitActivation(s), "PROFILE_NOT_COMPLETE");
  });
});

// — 9 —

describe("9. a profile-complete participant may submit activation", () => {
  it("submits with an activatable role", () => {
    const s = subject({
      participant: participant({
        status: "PROFILE_COMPLETE",
        roles: [["SELLER", "PENDING_ACTIVATION"]],
      }),
    });
    expectAllow(canSubmitActivation(s), "activation:submit");
  });

  it("a buyer-only participant has nothing to activate", () => {
    const s = subject({
      participant: participant({ status: "PROFILE_COMPLETE", roles: [["BUYER", "ACTIVE"]] }),
    });
    expectDeny(canSubmitActivation(s), "NO_ACTIVATABLE_ROLE");
  });

  it("submitting twice is refused, and an admitted participant has nothing to submit", () => {
    const underReview = subject({
      participant: participant({ status: "UNDER_REVIEW", roles: [["SELLER", "PENDING_ACTIVATION"]] }),
    });
    expectDeny(canSubmitActivation(underReview), "ACTIVATION_ALREADY_SUBMITTED");
    expectDeny(canSubmitActivation(subject({ participant: tradingParticipant("SELLER") })),
      "ACTIVATION_ALREADY_COMPLETE");
  });

  it("a suspended participant may not submit", () => {
    const s = subject({
      participant: participant({ status: "SUSPENDED", roles: [["SELLER", "SUSPENDED"]] }),
    });
    expectDeny(canSubmitActivation(s), "PARTICIPANT_STATUS_NOT_ELIGIBLE");
  });
});

// — 10 —

describe("10. payment readiness alone does not activate commerce", () => {
  it("ENABLED payment without Monacado admission sells nothing", () => {
    for (const status of ["PROFILE_COMPLETE", "UNDER_REVIEW"] as const) {
      const s = subject({
        participant: participant({
          status,
          roles: [["SELLER", "PENDING_ACTIVATION"]],
          paymentReadiness: "ENABLED",
        }),
      });
      expectDeny(canActivateStorefront(s), "PARTICIPANT_NOT_ACTIVATED");
      expectDeny(canPublishOffer(s), "PARTICIPANT_NOT_ACTIVATED");
      expectDeny(canReceivePayout(s), "PARTICIPANT_NOT_ACTIVATED");
      expectDeny(canAccrueCommission(s), "PARTICIPANT_NOT_ACTIVATED");
    }
  });
});

// — 11 —

describe("11. payout requires marketplace activation AND payment readiness", () => {
  it("both present: allowed", () => {
    expectAllow(canReceivePayout(subject({ participant: tradingParticipant("SELLER") })),
      "payout:receive");
  });

  it("activation without payment readiness: denied", () => {
    for (const readiness of ["NOT_STARTED", "DETAILS_REQUIRED", "PENDING_PROVIDER", "DISABLED"] as const) {
      const s = subject({
        participant: participant({
          status: "ACTIVE",
          roles: [["SELLER", "ACTIVE"]],
          paymentReadiness: readiness,
        }),
      });
      expectDeny(canReceivePayout(s), "PAYMENT_NOT_ENABLED");
    }
  });

  it("a provider restriction is reported as a restriction", () => {
    const s = subject({
      participant: participant({
        status: "ACTIVE",
        roles: [["PROMOTER", "ACTIVE"]],
        paymentReadiness: "RESTRICTED",
      }),
    });
    expectDeny(canReceivePayout(s), "PAYMENT_RESTRICTED");
    expectDeny(canAccrueCommission(s), "PAYMENT_RESTRICTED");
  });

  it("commission accrues before payout is possible, but not under a provider hold", () => {
    const pending = subject({
      participant: participant({
        status: "ACTIVE",
        roles: [["PROMOTER", "ACTIVE"]],
        paymentReadiness: "PENDING_PROVIDER",
      }),
    });
    expectAllow(canAccrueCommission(pending), "commission:accrue");
    expectDeny(canReceivePayout(pending), "PAYMENT_NOT_ENABLED");
  });
});

// — 12 —

describe("12. a promoter cannot modify Product authority", () => {
  const s = subject({ participant: tradingParticipant("PROMOTER") });

  it("cannot draft an owned Product or publish an Offer", () => {
    expectDeny(canCreateDraftProduct(s), "ROLE_NOT_HELD");
    expectDeny(canPublishOffer(s), "ROLE_NOT_HELD");
  });

  it("keeps its own curation capabilities", () => {
    expectAllow(canCreatePromotedListing(s), "listing:promoted:create");
    expectAllow(canCreateDraftStorefront(s), "storefront:draft:create");
    expectAllow(canAccrueCommission(s), "commission:accrue");
  });
});

// — 13 —

describe("13. BUYER status alone grants no general publication authority", () => {
  const s = subject({ participant: tradingParticipant("BUYER") });

  it("grants nothing over Product, Storefront, Listing, or Offer", () => {
    expectDeny(canCreateDraftProduct(s), "ROLE_NOT_HELD");
    expectDeny(canCreateDraftStorefront(s), "ROLE_NOT_HELD");
    expectDeny(canCreatePromotedListing(s), "ROLE_NOT_HELD");
    expectDeny(canPublishOffer(s), "ROLE_NOT_HELD");
    expectDeny(canActivateStorefront(s), "ROLE_NOT_HELD");
    expectDeny(canAccrueCommission(s), "ROLE_NOT_HELD");
    expectDeny(canReceivePayout(s), "ROLE_NOT_HELD");
  });

  it("grants no review-capsule authority on its own", () => {
    /* Buying is not reviewing: capsule authority comes from a stored submission
       authority, which a bare BUYER role does not create. */
    expectDeny(
      canPublishProductReviewCapsule(
        capsuleRequest("PUBLISH", { authority: authority({ purchaseProvenance: "UNVERIFIED" }) }),
      ),
      "PURCHASE_PROVENANCE_UNVERIFIED",
    );
  });
});

// — 14 —

describe("14. a product review submission grants only ProductReview capsule authority", () => {
  it("authorizes the ProductReview capsule", () => {
    expectAllow(
      canPublishProductReviewCapsule(capsuleRequest("PUBLISH")),
      "review:product:capsule:publish",
    );
    expectAllow(
      canPublishProductReviewCapsule(capsuleRequest("REGISTER")),
      "review:product:capsule:publish",
    );
  });

  it("authorizes nothing on the SellerReview capsule", () => {
    expectDeny(
      canPublishSellerReviewCapsule(capsuleRequest("PUBLISH")),
      "REVIEW_AUTHORITY_KIND_MISMATCH",
    );
    expectDeny(
      canPublishProductReviewCapsule(capsuleRequest("PUBLISH", { targetKind: "SELLER_REVIEW" })),
      "REVIEW_AUTHORITY_KIND_MISMATCH",
    );
  });
});

// — 15 —

describe("15. a seller review submission grants only SellerReview capsule authority", () => {
  const sellerAuthority = authority({ reviewKind: "SELLER_REVIEW" });

  it("authorizes the SellerReview capsule", () => {
    expectAllow(
      canPublishSellerReviewCapsule(capsuleRequest("PUBLISH", { authority: sellerAuthority })),
      "review:seller:capsule:publish",
    );
  });

  it("authorizes nothing on the ProductReview capsule", () => {
    expectDeny(
      canPublishProductReviewCapsule(capsuleRequest("PUBLISH", { authority: sellerAuthority })),
      "REVIEW_AUTHORITY_KIND_MISMATCH",
    );
    expectDeny(
      canPublishSellerReviewCapsule(
        capsuleRequest("PUBLISH", { authority: sellerAuthority, targetKind: "PRODUCT_REVIEW" }),
      ),
      "REVIEW_AUTHORITY_KIND_MISMATCH",
    );
  });

  it("the kind-agnostic evaluator routes by the authority's own kind", () => {
    expectAllow(
      evaluateReviewCapsuleAuthority(capsuleRequest("PUBLISH", { authority: sellerAuthority })),
      "review:seller:capsule:publish",
    );
    expectAllow(
      evaluateReviewCapsuleAuthority(capsuleRequest("PUBLISH")),
      "review:product:capsule:publish",
    );
  });
});

// — 16 —

describe("16. review authority permits update, supersession, and revocation of that review only", () => {
  it("a submitted review authorizes first publication", () => {
    for (const action of ["CREATE", "REGISTER", "PUBLISH"] as const) {
      expectAllow(
        canPublishProductReviewCapsule(capsuleRequest(action)),
        "review:product:capsule:publish",
      );
    }
    expectDeny(
      canPublishProductReviewCapsule(capsuleRequest("REVOKE")),
      "ACTION_NOT_AUTHORIZED_BY_SUBMISSION",
    );
  });

  it("editing authorizes update and supersession", () => {
    const edited = authority({ submissionState: "EDITED" });
    for (const action of ["UPDATE", "SUPERSEDE", "PUBLISH"] as const) {
      expectAllow(
        canPublishProductReviewCapsule(capsuleRequest(action, { authority: edited })),
        "review:product:capsule:publish",
      );
    }
    expectDeny(
      canPublishProductReviewCapsule(capsuleRequest("REVOKE", { authority: edited })),
      "ACTION_NOT_AUTHORIZED_BY_SUBMISSION",
    );
  });

  it("withdrawing authorizes revocation and nothing else", () => {
    const withdrawn = authority({ submissionState: "WITHDRAWN" });
    expectAllow(
      canPublishProductReviewCapsule(capsuleRequest("REVOKE", { authority: withdrawn })),
      "review:product:capsule:publish",
    );
    for (const action of ["CREATE", "REGISTER", "PUBLISH", "UPDATE", "SUPERSEDE"] as const) {
      expectDeny(
        canPublishProductReviewCapsule(capsuleRequest(action, { authority: withdrawn })),
        "ACTION_NOT_AUTHORIZED_BY_SUBMISSION",
      );
    }
  });

  it("an invalidated authority still permits retraction, and only retraction", () => {
    const invalidated = authority({ status: "INVALIDATED" });
    expectAllow(
      canPublishProductReviewCapsule(capsuleRequest("REVOKE", { authority: invalidated })),
      "review:product:capsule:publish",
    );
    expectDeny(
      canPublishProductReviewCapsule(capsuleRequest("PUBLISH", { authority: invalidated })),
      "REVIEW_AUTHORITY_INVALIDATED",
    );
  });

  it("the authority reaches that review and no other", () => {
    for (const action of REVIEW_CAPSULE_ACTIONS) {
      expectDeny(
        canPublishProductReviewCapsule(capsuleRequest(action, { targetRef: OTHER_REVIEW_ID })),
        "REVIEW_AUTHORITY_TARGET_MISMATCH",
      );
    }
  });
});

// — 17 —

describe("17. review authority grants no authority over any other capsule", () => {
  const OTHER_TARGETS = ["PRODUCT", "SELLER", "STOREFRONT", "LISTING", "OFFER"] as const;

  it("every non-review target is out of scope, for every action", () => {
    for (const kind of OTHER_TARGETS) {
      for (const action of REVIEW_CAPSULE_ACTIONS) {
        expectDeny(
          canPublishProductReviewCapsule(
            capsuleRequest(action, { targetKind: kind, targetRef: PRODUCT_REF }),
          ),
          "REVIEW_AUTHORITY_SCOPE_EXCEEDED",
        );
      }
    }
  });

  it("the reviewed Product itself remains out of scope", () => {
    expectDeny(
      canPublishProductReviewCapsule(
        capsuleRequest("SUPERSEDE", { targetKind: "PRODUCT", targetRef: PRODUCT_REF }),
      ),
      "REVIEW_AUTHORITY_SCOPE_EXCEEDED",
    );
  });
});

// — 18 —

describe("18. a guest review requires verified transaction provenance", () => {
  it("an unproven guest may not submit", () => {
    for (const provenance of ["NONE", "UNVERIFIED"] as const) {
      expectDeny(
        canSubmitProductReview({ subject: GUEST_SUBJECT, purchaseProvenance: provenance }),
        "PURCHASE_PROVENANCE_UNVERIFIED",
      );
      expectDeny(
        canSubmitSellerReview({ subject: GUEST_SUBJECT, purchaseProvenance: provenance }),
        "PURCHASE_PROVENANCE_UNVERIFIED",
      );
    }
  });

  it("an account holder is held to the same proof", () => {
    const s = subject({ participant: tradingParticipant("BUYER") });
    expectDeny(
      canSubmitProductReview({ subject: s, purchaseProvenance: "UNVERIFIED" }),
      "PURCHASE_PROVENANCE_UNVERIFIED",
    );
  });

  it("an unproven guest authority publishes nothing", () => {
    const guestAuthority = authority({
      submitter: "GUEST_BUYER",
      purchaseProvenance: "UNVERIFIED",
      purchaseEvidenceRef: null,
    });
    expectDeny(
      canPublishProductReviewCapsule(capsuleRequest("PUBLISH", { authority: guestAuthority })),
      "PURCHASE_PROVENANCE_UNVERIFIED",
    );
  });

  it("a proven guest authority publishes", () => {
    const guestAuthority = authority({ submitter: "GUEST_BUYER", purchaseProvenance: "VERIFIED" });
    expectAllow(
      canPublishProductReviewCapsule(capsuleRequest("PUBLISH", { authority: guestAuthority })),
      "review:product:capsule:publish",
    );
  });
});

// — 19 —

describe("19. private buyer identity is excluded from the public review projection", () => {
  it("the public attribution schema has no field for an identity", () => {
    for (const leak of [
      { accountId: ACCOUNT_ID },
      { email: "buyer@example.com" },
      { participantId: PARTICIPANT_ID },
      { purchaseEvidenceRef: EVIDENCE_ID },
      { legalName: "A Buyer" },
    ]) {
      const attempt = PublicReviewAttribution.safeParse({
        mode: "PSEUDONYMOUS",
        displayLabel: "quiet-otter",
        verifiedPurchase: true,
        ...leak,
      });
      expect(attempt.success).toBe(false);
    }
  });

  it("identity is not published by default, even for a verified purchaser", () => {
    const attribution = projectPublicReviewAttribution({
      submitter: "ACCOUNT_BUYER",
      purchaseProvenance: "VERIFIED",
      pseudonym: "quiet-otter",
      publicIdentityApproved: false,
    });
    expect(attribution).toEqual({
      mode: "VERIFIED_PURCHASER",
      displayLabel: "quiet-otter",
      verifiedPurchase: true,
    });
    const serialized = JSON.stringify(attribution);
    for (const secret of [ACCOUNT_ID, PARTICIPANT_ID, EVIDENCE_ID, "@"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("an unproven guest projects pseudonymously with no purchase claim", () => {
    expect(
      projectPublicReviewAttribution({
        submitter: "GUEST_BUYER",
        purchaseProvenance: "UNVERIFIED",
        pseudonym: "passing-heron",
        publicIdentityApproved: false,
      }),
    ).toEqual({ mode: "PSEUDONYMOUS", displayLabel: "passing-heron", verifiedPurchase: false });
  });

  it("public identity requires explicit approval", () => {
    expect(
      projectPublicReviewAttribution({
        submitter: "ACCOUNT_BUYER",
        purchaseProvenance: "VERIFIED",
        pseudonym: "Ada L.",
        publicIdentityApproved: true,
      }).mode,
    ).toBe("APPROVED_PUBLIC_IDENTITY");
  });

  it("an email address cannot be used as a display label", () => {
    expect(
      ProjectReviewAttributionInput.safeParse({
        submitter: "ACCOUNT_BUYER",
        purchaseProvenance: "VERIFIED",
        pseudonym: "buyer@example.com",
        publicIdentityApproved: false,
      }).success,
    ).toBe(false);
    expect(() =>
      projectPublicReviewAttribution({
        submitter: "ACCOUNT_BUYER",
        purchaseProvenance: "VERIFIED",
        pseudonym: "buyer@example.com",
        publicIdentityApproved: false,
      }),
    ).toThrow();
  });

  it("the stored authority carries a pointer to evidence, never the evidence", () => {
    const stored = authority();
    expect(stored.purchaseEvidenceRef).toBe(EVIDENCE_ID);
    expect(
      ReviewSubmissionAuthorityView.safeParse({ ...stored, buyerEmail: "buyer@example.com" }).success,
    ).toBe(false);
  });
});

// — 20 —

describe("20. invalid lifecycle transitions fail", () => {
  it("participants are admitted only through review", () => {
    expect(isValidParticipantTransition("DRAFT", "ACTIVE")).toBe(false);
    expect(isValidParticipantTransition("PROFILE_INCOMPLETE", "UNDER_REVIEW")).toBe(false);
    expect(isValidParticipantTransition("PROFILE_COMPLETE", "ACTIVE")).toBe(false);
    expect(isValidParticipantTransition("PROFILE_COMPLETE", "UNDER_REVIEW")).toBe(true);
    expect(isValidParticipantTransition("UNDER_REVIEW", "ACTIVE")).toBe(true);
    expect(isValidParticipantTransition("UNDER_REVIEW", "PROFILE_INCOMPLETE")).toBe(true);
  });

  it("CLOSED is terminal and DRAFT is the only start", () => {
    for (const to of ["ACTIVE", "DRAFT", "PROFILE_INCOMPLETE", "SUSPENDED"] as const) {
      expect(isValidParticipantTransition("CLOSED", to)).toBe(false);
    }
    expect(INITIAL_PARTICIPANT_STATUS).toBe("DRAFT");
  });

  it("suspension and restriction are reversible; revocation is not", () => {
    expect(isValidParticipantTransition("SUSPENDED", "ACTIVE")).toBe(true);
    expect(isValidParticipantTransition("RESTRICTED", "ACTIVE")).toBe(true);
    expect(isValidRoleAssignmentTransition("SUSPENDED", "ACTIVE")).toBe(true);
    expect(isValidRoleAssignmentTransition("REVOKED", "ACTIVE")).toBe(false);
    expect(isValidRoleAssignmentTransition("REVOKED", "DRAFT")).toBe(false);
  });

  it("a role reaches ACTIVE only through activation", () => {
    expect(isValidRoleAssignmentTransition("DRAFT", "ACTIVE")).toBe(false);
    expect(isValidRoleAssignmentTransition("DRAFT", "PENDING_ACTIVATION")).toBe(true);
    expect(isValidRoleAssignmentTransition("PENDING_ACTIVATION", "ACTIVE")).toBe(true);
  });

  it("SELLER and PROMOTER start DRAFT; BUYER starts ACTIVE", () => {
    expect(initialRoleAssignmentStatus("SELLER")).toBe("DRAFT");
    expect(initialRoleAssignmentStatus("PROMOTER")).toBe("DRAFT");
    expect(initialRoleAssignmentStatus("BUYER")).toBe("ACTIVE");
    expect(isValidInitialRoleAssignmentStatus("SELLER", "ACTIVE")).toBe(false);
    expect(isValidInitialRoleAssignmentStatus("BUYER", "ACTIVE")).toBe(true);
  });

  it("payment readiness is always the provider's answer", () => {
    expect(isValidPaymentReadinessTransition("NOT_STARTED", "ENABLED")).toBe(false);
    expect(isValidPaymentReadinessTransition("DETAILS_REQUIRED", "ENABLED")).toBe(false);
    expect(isValidPaymentReadinessTransition("PENDING_PROVIDER", "ENABLED")).toBe(true);
    expect(isValidPaymentReadinessTransition("ENABLED", "RESTRICTED")).toBe(true);
    expect(isValidPaymentReadinessTransition("DISABLED", "ENABLED")).toBe(false);
    expect(INITIAL_PAYMENT_READINESS).toBe("NOT_STARTED");
  });
});

// — 21 —

describe("21. unknown enum values and unknown keys fail", () => {
  it("unknown enum members are refused across every vocabulary", () => {
    expect(MarketplaceRole.safeParse("ADMIN").success).toBe(false);
    expect(ParticipantStatus.safeParse("REGISTERED").success).toBe(false);
    expect(RoleAssignmentStatus.safeParse("PENDING").success).toBe(false);
    expect(PaymentReadinessStatus.safeParse("STRIPE_PENDING").success).toBe(false);
    expect(MarketplaceCapability.safeParse("storefront:delete").success).toBe(false);
    expect(MARKETPLACE_CAPABILITIES).toHaveLength(12);
  });

  it("unknown keys are refused on every view", () => {
    const p = participant({ status: "ACTIVE", roles: [["SELLER", "ACTIVE"]] });
    expect(MarketplaceParticipantView.safeParse({ ...p, legalName: "A Seller" }).success).toBe(false);
    expect(
      MarketplaceSubject.safeParse({
        account: { accountId: ACCOUNT_ID, status: "ACTIVE" },
        participant: p,
        internalCapabilities: [],
        isAdmin: true,
      }).success,
    ).toBe(false);
    expect(
      MarketplaceSubject.safeParse({
        account: { accountId: ACCOUNT_ID, status: "ACTIVE", role: "SELLER" },
        participant: null,
        internalCapabilities: [],
      }).success,
    ).toBe(false);
  });

  it("a participant holds at most one assignment per role", () => {
    expect(
      MarketplaceParticipantView.safeParse({
        participantId: PARTICIPANT_ID,
        accountId: ACCOUNT_ID,
        status: "ACTIVE",
        roles: [
          { role: "SELLER", status: "ACTIVE" },
          { role: "SELLER", status: "SUSPENDED" },
        ],
        paymentReadiness: "ENABLED",
      }).success,
    ).toBe(false);
  });

  it("identifiers must be well-formed and of the right kind", () => {
    expect(
      MarketplaceParticipantView.safeParse({
        participantId: ACCOUNT_ID,
        accountId: ACCOUNT_ID,
        status: "DRAFT",
        roles: [],
        paymentReadiness: "NOT_STARTED",
      }).success,
    ).toBe(false);
    expect(
      ReviewSubmissionAuthorityView.safeParse({ ...authority(), reviewSubmissionId: AUTHORITY_ID })
        .success,
    ).toBe(false);
  });

  it("no capability decision depends on ambient state", () => {
    /* The rules are pure by inspection as well as by test: a decision that read a
       clock, an environment value, or the database could not be replayed, and a
       capability answer that cannot be replayed cannot be audited. */
    const forbidden = [
      "process.env",
      "Date.now",
      "new Date",
      "Math.random",
      "fetch(",
      "prisma",
      "@prisma/client",
      "node:crypto",
    ];
    for (const file of [
      "capability.ts",
      "participant.ts",
      "lifecycle.ts",
      "review-authority.ts",
      "identity.ts",
    ]) {
      const source = readFileSync(new URL(`../src/contracts/marketplace/${file}`, import.meta.url), "utf8");
      for (const token of forbidden) {
        expect(source, `${file} must not reference ${token}`).not.toContain(token);
      }
    }
  });

  it("a malformed decision is refused", () => {
    expect(
      CapabilityDecision.safeParse({
        capability: "offer:publish",
        decision: "ALLOW",
        reasonCodes: ["ROLE_NOT_HELD"],
      }).success,
    ).toBe(false);
    expect(
      CapabilityDecision.safeParse({
        capability: "offer:publish",
        decision: "DENY",
        reasonCodes: [],
      }).success,
    ).toBe(false);
    expect(
      CapabilityDecision.safeParse({
        capability: "offer:publish",
        decision: "MAYBE",
        reasonCodes: ["ROLE_NOT_HELD"],
      }).success,
    ).toBe(false);
  });
});
