/**
 * Phase 1.39 — Product lifecycle derivation and the one activation-readiness
 * evaluator (pure; no database). Contract §9.1, §9.2.
 */

import { describe, expect, it } from "vitest";
import {
  PRODUCT_ACTIVATION_BLOCKERS,
  PRODUCT_SUSPENSION_LIFT_REASON_CODES,
  PRODUCT_SUSPENSION_REASON_CODES,
  activationBasisFrom,
  deriveProductLifecycle,
  evaluateProductActivationReadiness,
  type ProductActivationBasisNow,
  type ProductActivationReadinessFacts,
  type ProductLifecycleFacts,
} from "../src/contracts/product/product-lifecycle";
import { MITIGATION_CODE_FORBIDDEN_TERMS } from "../src/contracts/marketplace/participant-mitigation";
import {
  PRODUCT_TAX_CLASSIFY_CAPABILITY,
  canClassifyProductTax,
  isInternallyAuthorized,
} from "../src/contracts/account/internal-authorization";
import type { AccountCapability } from "../src/contracts/account/account";
import { MARKETPLACE_CAPABILITIES } from "../src/contracts/marketplace/capability";

const READY: ProductActivationReadinessFacts = {
  productSuspended: false,
  contentComplete: true,
  account: {
    emailVerifiedAt: "2026-10-01T00:00:00.000Z",
    firstName: "Ada",
    lastName: "Lovelace",
  },
  participant: {
    status: "ACTIVE",
    suspended: false,
    productActivationRestricted: false,
    sellerRoleStatus: "ACTIVE",
    paymentReadiness: "ENABLED",
    commerceApproval: "APPROVED",
  },
  tax: { classification: "DIGITAL_GOOD", deliveryMode: "DIGITAL" },
};

const NOW: ProductActivationBasisNow = {
  participantId: "mon:mpart:SELLER",
  emailVerifiedAt: "2026-10-01T00:00:00.000Z",
  sellerRoleActivatedAt: "2026-10-02T00:00:00.000Z",
  paymentEnabledSince: "2026-10-03T00:00:00.000Z",
  restrictionCount: 0,
  participantSuspensionCount: 0,
  nonApprovalDecisionCount: 1,
  productSuspensionCount: 0,
};

const ACTIVATION = {
  basis: activationBasisFrom(NOW)!,
  laterVersionsHeld: true,
  suspensionsRecordingThisActivation: 0,
};

function facts(over: Partial<ProductLifecycleFacts> = {}): ProductLifecycleFacts {
  return { readiness: READY, basisNow: NOW, activation: ACTIVATION, ...over };
}

function withParticipant(
  over: Partial<NonNullable<ProductActivationReadinessFacts["participant"]>>,
): ProductActivationReadinessFacts {
  return { ...READY, participant: { ...READY.participant!, ...over } };
}

describe("lifecycle derivation (Contract §9.1)", () => {
  it("an incomplete current version is INCOMPLETE", () => {
    const r = deriveProductLifecycle(facts({ readiness: { ...READY, contentComplete: false }, activation: null }));
    expect(r.lifecycle).toBe("INCOMPLETE");
  });

  it("complete but never activated is COMPLETE — readiness alone never activates", () => {
    const r = deriveProductLifecycle(facts({ activation: null }));
    expect(r.readiness.ready).toBe(true);
    expect(r.lifecycle).toBe("COMPLETE");
    expect(r.activationInEffect).toBe(false);
  });

  it("complete, ready, and explicitly activated with readiness held is ACTIVE", () => {
    const r = deriveProductLifecycle(facts());
    expect(r.lifecycle).toBe("ACTIVE");
    expect(r.activationInEffect).toBe(true);
  });

  it("a revision that makes the Product incomplete takes ACTIVE to INCOMPLETE", () => {
    const r = deriveProductLifecycle(facts({ readiness: { ...READY, contentComplete: false } }));
    expect(r.lifecycle).toBe("INCOMPLETE");
  });

  it("a later version that was incomplete, even if since fixed, leaves the activation lapsed", () => {
    const r = deriveProductLifecycle(facts({ activation: { ...ACTIVATION, laterVersionsHeld: false } }));
    expect(r.lifecycle).toBe("COMPLETE");
  });

  it("losing Seller readiness takes ACTIVE to COMPLETE", () => {
    for (const lost of [
      withParticipant({ paymentReadiness: "RESTRICTED" }),
      withParticipant({ commerceApproval: "NOT_APPROVED" }),
      withParticipant({ status: "RESTRICTED", productActivationRestricted: true }),
      withParticipant({ suspended: true, status: "SUSPENDED" }),
      { ...READY, account: { ...READY.account, emailVerifiedAt: null } },
      { ...READY, tax: { classification: null, deliveryMode: "DIGITAL" } },
    ]) {
      expect(deriveProductLifecycle(facts({ readiness: lost })).lifecycle).toBe("COMPLETE");
    }
  });

  it("restoring readiness never re-activates: every lapse-revealing value is compared", () => {
    const lapses: Partial<ProductActivationBasisNow>[] = [
      { paymentEnabledSince: "2026-11-01T00:00:00.000Z" },
      { emailVerifiedAt: "2026-11-01T00:00:00.000Z" },
      { sellerRoleActivatedAt: "2026-11-01T00:00:00.000Z" },
      { restrictionCount: 1 },
      { participantSuspensionCount: 1 },
      { nonApprovalDecisionCount: 2 },
      { productSuspensionCount: 1 },
      { participantId: "mon:mpart:SOMEONE_ELSE" },
    ];
    for (const lapse of lapses) {
      const r = deriveProductLifecycle(facts({ basisNow: { ...NOW, ...lapse } }));
      expect(r.readiness.ready).toBe(true);
      expect(r.lifecycle).toBe("COMPLETE");
    }
  });

  it("SUSPENDED dominates every other state", () => {
    const suspended = { ...READY, productSuspended: true };
    expect(deriveProductLifecycle(facts({ readiness: suspended })).lifecycle).toBe("SUSPENDED");
    expect(
      deriveProductLifecycle(facts({ readiness: { ...suspended, contentComplete: false } })).lifecycle,
    ).toBe("SUSPENDED");
  });

  describe("suspension reinstatement (Contract §9.1 table)", () => {
    const afterLift = { ...NOW, productSuspensionCount: 1 };

    it("ACTIVE immediately before, complete, and ready throughout → ACTIVE", () => {
      const r = deriveProductLifecycle(
        facts({ basisNow: afterLift, activation: { ...ACTIVATION, suspensionsRecordingThisActivation: 1 } }),
      );
      expect(r.lifecycle).toBe("ACTIVE");
    });

    it("COMPLETE before the suspension stays COMPLETE even though ready now", () => {
      const r = deriveProductLifecycle(facts({ basisNow: afterLift }));
      expect(r.lifecycle).toBe("COMPLETE");
    });

    it("never activated before the suspension stays COMPLETE", () => {
      expect(deriveProductLifecycle(facts({ basisNow: afterLift, activation: null })).lifecycle).toBe("COMPLETE");
    });

    it("incomplete now → INCOMPLETE", () => {
      const r = deriveProductLifecycle(
        facts({
          readiness: { ...READY, contentComplete: false },
          basisNow: afterLift,
          activation: { ...ACTIVATION, suspensionsRecordingThisActivation: 1 },
        }),
      );
      expect(r.lifecycle).toBe("INCOMPLETE");
    });

    it("readiness failing now → COMPLETE", () => {
      const r = deriveProductLifecycle(
        facts({
          readiness: withParticipant({ paymentReadiness: "DISABLED" }),
          basisNow: afterLift,
          activation: { ...ACTIVATION, suspensionsRecordingThisActivation: 1 },
        }),
      );
      expect(r.lifecycle).toBe("COMPLETE");
    });

    it("readiness that lapsed while suspended, even if restored, → COMPLETE", () => {
      const r = deriveProductLifecycle(
        facts({
          basisNow: { ...afterLift, paymentEnabledSince: "2026-12-01T00:00:00.000Z" },
          activation: { ...ACTIVATION, suspensionsRecordingThisActivation: 1 },
        }),
      );
      expect(r.lifecycle).toBe("COMPLETE");
    });
  });
});

describe("the activation-readiness evaluator (Contract §9.2)", () => {
  it("passes on complete content and every Seller gate — with no Storefront, Listing, or Offer fact at all", () => {
    expect(evaluateProductActivationReadiness(READY)).toEqual({ ready: true, blockers: [] });
    expect(Object.keys(READY).sort()).toEqual(["account", "contentComplete", "participant", "productSuspended", "tax"]);
  });

  const cases: [string, ProductActivationReadinessFacts, string][] = [
    ["unverified email", { ...READY, account: { ...READY.account, emailVerifiedAt: null } }, "EMAIL_UNVERIFIED"],
    ["missing first name", { ...READY, account: { ...READY.account, firstName: null } }, "FIRST_NAME_MISSING"],
    ["blank first name", { ...READY, account: { ...READY.account, firstName: "   " } }, "FIRST_NAME_MISSING"],
    ["missing last name", { ...READY, account: { ...READY.account, lastName: null } }, "LAST_NAME_MISSING"],
    ["no participant", { ...READY, participant: null }, "PARTICIPANT_MISSING"],
    ["inactive participant", withParticipant({ status: "UNDER_REVIEW" }), "PARTICIPANT_NOT_ACTIVE"],
    ["inactive SELLER role", withParticipant({ sellerRoleStatus: "PENDING_ACTIVATION" }), "SELLER_ROLE_NOT_ACTIVE"],
    ["undated SELLER role", withParticipant({ sellerRoleStatus: "ACTIVE_UNDATED" }), "SELLER_ROLE_NOT_ACTIVE"],
    ["payment not ready", withParticipant({ paymentReadiness: "PENDING_PROVIDER" }), "PAYMENT_NOT_READY"],
    ["undated payment readiness", withParticipant({ paymentReadiness: "ENABLED_UNDATED" }), "PAYMENT_NOT_READY"],
    ["no commerce approval", withParticipant({ commerceApproval: "NOT_APPROVED" }), "COMMERCE_APPROVAL_MISSING"],
    ["participant suspended", withParticipant({ suspended: true }), "PARTICIPANT_SUSPENDED"],
    ["product:activate restriction", withParticipant({ productActivationRestricted: true }), "PRODUCT_ACTIVATION_RESTRICTED"],
    ["no tax classification", { ...READY, tax: { classification: null, deliveryMode: "DIGITAL" } }, "TAX_CLASSIFICATION_NOT_READY"],
    ["contradictory tax classification", { ...READY, tax: { classification: "PHYSICAL_GOOD", deliveryMode: "DIGITAL" } }, "TAX_CLASSIFICATION_NOT_READY"],
    ["incomplete content", { ...READY, contentComplete: false }, "PRODUCT_INCOMPLETE"],
    ["product suspended", { ...READY, productSuspended: true }, "PRODUCT_SUSPENDED"],
  ];
  for (const [label, input, blocker] of cases) {
    it(`blocks on ${label}`, () => {
      const r = evaluateProductActivationReadiness(input);
      expect(r.ready).toBe(false);
      expect(r.blockers).toEqual([blocker]);
    });
  }

  it("reports every blocker, in the fixed vocabulary order", () => {
    const r = evaluateProductActivationReadiness({
      ...READY,
      contentComplete: false,
      account: { emailVerifiedAt: null, firstName: null, lastName: null },
      tax: { classification: null, deliveryMode: null },
    });
    expect(r.blockers).toEqual([
      "PRODUCT_INCOMPLETE",
      "EMAIL_UNVERIFIED",
      "FIRST_NAME_MISSING",
      "LAST_NAME_MISSING",
      "TAX_CLASSIFICATION_NOT_READY",
    ]);
    const order = (b: string) => PRODUCT_ACTIVATION_BLOCKERS.indexOf(b as never);
    expect([...r.blockers].sort((a, b) => order(a) - order(b))).toEqual(r.blockers);
  });

  it("tax classification never affects completeness, only readiness", () => {
    const r = deriveProductLifecycle(
      facts({ readiness: { ...READY, tax: { classification: null, deliveryMode: "DIGITAL" } }, activation: null }),
    );
    expect(r.lifecycle).toBe("COMPLETE");
  });
});

describe("activation basis", () => {
  it("refuses to pin a basis with a missing instant", () => {
    for (const hole of ["participantId", "emailVerifiedAt", "sellerRoleActivatedAt", "paymentEnabledSince"] as const) {
      expect(activationBasisFrom({ ...NOW, [hole]: null })).toBeNull();
    }
    expect(activationBasisFrom(NOW)).toEqual(ACTIVATION.basis);
  });
});

describe("Product suspension vocabulary", () => {
  it("names concerns, never findings", () => {
    for (const code of [...PRODUCT_SUSPENSION_REASON_CODES, ...PRODUCT_SUSPENSION_LIFT_REASON_CODES]) {
      for (const term of MITIGATION_CODE_FORBIDDEN_TERMS) expect(code).not.toContain(term);
    }
  });
});

describe("Product tax-classification authority (Monacado, never the Seller)", () => {
  const subject = (capabilities: AccountCapability[], accountStatus: "ACTIVE" | "DISABLED" = "ACTIVE") => ({
    accountId: "mon:acct:0123456789ABCDEFGHJKMNPQRS",
    accountStatus,
    capabilities,
  });

  it("is allowed only by an explicit product:tax-classify grant on an ACTIVE account", () => {
    expect(isInternallyAuthorized(canClassifyProductTax(subject([PRODUCT_TAX_CLASSIFY_CAPABILITY])))).toBe(true);
    expect(isInternallyAuthorized(canClassifyProductTax(subject([PRODUCT_TAX_CLASSIFY_CAPABILITY], "DISABLED")))).toBe(false);
    expect(isInternallyAuthorized(canClassifyProductTax(null))).toBe(false);
  });

  it("is not conferred by any neighbouring staff grant", () => {
    const neighbours: AccountCapability[] = [
      "product:suspend",
      "participant:commerce-approve",
      "participant:restrict",
      "activation:review",
    ];
    expect(isInternallyAuthorized(canClassifyProductTax(subject(neighbours)))).toBe(false);
  });

  it("is not a marketplace (role) capability, so no Seller role can carry it", () => {
    expect(MARKETPLACE_CAPABILITIES as readonly string[]).not.toContain("product:tax-classify");
  });
});
