/**
 * Phase 1.15 — restriction enforcement seams, pure.
 *
 * No database, no network, no credential. Every fact below is a vocabulary, a
 * pure decision, or a property of the source text.
 *
 * The source-scanning tests are the point of the file, not a garnish. This
 * phase's central commitment — **a scope is IMPLEMENTED only if a production
 * service reads it** — is a property of what the server tree CONTAINS, and the
 * only way to assert it is to read the files. Four scopes reached Phase 1.14
 * fully governed, fully persisted, notice-raising, and enforced by nothing; a
 * registry that merely *said* otherwise would have been the same failure with
 * better prose.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  IMPLEMENTED_RESTRICTION_SCOPES,
  NEVER_ON_PARTICIPANT_ACTION_DENIAL,
  PARTICIPANT_ACTION_DENIAL_CODES,
  RESTRICTION_SCOPE_ENFORCEMENT,
  UNSUPPORTED_RESTRICTION_SCOPES,
  commerceBlockingScopesForRole,
  evaluateParticipantAction,
  isEnforceableRestrictionScope,
  scopeAppliesToRole,
} from "../src/contracts/marketplace/restriction-enforcement";
import {
  RESTRICTABLE_CAPABILITIES,
  RestrictionScope,
} from "../src/contracts/marketplace/participant-restriction";
import {
  PARTICIPANT_STANDING_BLOCKING_REASONS,
  publicSafeBlockingReasons,
} from "../src/contracts/marketplace/listing-source";
import {
  PARTY_DISCLOSING_RISK_DENIAL_REASON_CODES,
  buyerSafeRiskDenialReasons,
} from "../src/contracts/marketplace/transaction-risk";

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), "utf8");

const STANDING_SERVICE = "src/server/marketplace/participant-standing-service.ts";

describe("the registry covers the vocabulary exactly", () => {
  it("has one entry per restrictable capability, and no others", () => {
    expect(Object.keys(RESTRICTION_SCOPE_ENFORCEMENT).sort()).toEqual(
      [...RESTRICTABLE_CAPABILITIES].sort(),
    );
  });

  it("partitions the vocabulary into implemented and unsupported", () => {
    expect(
      [...IMPLEMENTED_RESTRICTION_SCOPES, ...UNSUPPORTED_RESTRICTION_SCOPES].sort(),
    ).toEqual([...RESTRICTABLE_CAPABILITIES].sort());
    for (const scope of IMPLEMENTED_RESTRICTION_SCOPES) {
      expect(UNSUPPORTED_RESTRICTION_SCOPES).not.toContain(scope);
    }
  });

  it("keys every entry to itself, so a copy-paste cannot mislabel one", () => {
    for (const [key, entry] of Object.entries(RESTRICTION_SCOPE_ENFORCEMENT)) {
      expect(entry.scope).toBe(key);
    }
  });
});

describe("a scope is IMPLEMENTED only if a production service reads it", () => {
  /* The invariant this phase exists to establish. An implemented scope names its
     seams; each named seam must exist as a real symbol under `src/server/**`. */
  it("every implemented scope names at least one seam, and every seam exists", () => {
    expect(IMPLEMENTED_RESTRICTION_SCOPES.length).toBeGreaterThan(0);

    const serverSources = [
      STANDING_SERVICE,
      "src/server/marketplace/order-service.ts",
      "src/server/marketplace/offer-service.ts",
      "src/server/marketplace/storefront-service.ts",
      "src/server/marketplace/listing-service.ts",
      "src/server/payments/executable-checkout-service.ts",
    ].map(read);

    for (const scope of IMPLEMENTED_RESTRICTION_SCOPES) {
      const entry = RESTRICTION_SCOPE_ENFORCEMENT[scope];
      expect(entry.seams.length).toBeGreaterThan(0);
      for (const seam of entry.seams) {
        const defined = serverSources.some((src) => src.includes(`function ${seam}`));
        const called = serverSources.some((src) => src.includes(`${seam}(`));
        expect(defined || called, `seam ${seam} for ${scope} must exist in src/server`).toBe(
          true,
        );
      }
    }
  });

  it("an unsupported scope claims no seam and no role", () => {
    for (const scope of UNSUPPORTED_RESTRICTION_SCOPES) {
      const entry = RESTRICTION_SCOPE_ENFORCEMENT[scope];
      expect(entry.seams).toHaveLength(0);
      expect(entry.appliesToRoles).toHaveLength(0);
      expect(isEnforceableRestrictionScope(scope)).toBe(false);
    }
  });

  it("names the three scopes 1.15 wired, and the three it refuses", () => {
    /* Written out rather than derived: if a later phase changes the partition,
       this should be a deliberate diff rather than a silently passing test. */
    expect([...IMPLEMENTED_RESTRICTION_SCOPES].sort()).toEqual([
      "offer:publish",
      "payout:receive",
      "storefront:activate",
    ]);
    expect([...UNSUPPORTED_RESTRICTION_SCOPES].sort()).toEqual([
      "commission:accrue",
      "review:product:submit",
      "review:seller:submit",
    ]);
  });

  it("the imposition path refuses an unenforceable scope", () => {
    const src = read("src/server/marketplace/participant-restriction-service.ts");
    expect(src).toContain("isEnforceableRestrictionScope");
    expect(src).toContain("RestrictionScopeNotEnforceableError");
  });
});

describe("history is preserved, never rewritten", () => {
  it("a retired scope still parses, so stored rows read back and can be lifted", () => {
    for (const scope of UNSUPPORTED_RESTRICTION_SCOPES) {
      expect(RestrictionScope.safeParse(scope).success).toBe(true);
    }
  });
});

describe("scopes are role-aware", () => {
  it("offer:publish reaches a seller and never a promoter", () => {
    expect(scopeAppliesToRole("offer:publish", "SELLER")).toBe(true);
    expect(scopeAppliesToRole("offer:publish", "PROMOTER")).toBe(false);
  });

  it("payout:receive reaches both parties that can be owed proceeds", () => {
    expect(scopeAppliesToRole("payout:receive", "SELLER")).toBe(true);
    expect(scopeAppliesToRole("payout:receive", "PROMOTER")).toBe(true);
  });

  it("a promoter is not blocked by a capability they never exercise", () => {
    expect(commerceBlockingScopesForRole("PROMOTER")).not.toContain("offer:publish");
    expect(commerceBlockingScopesForRole("SELLER")).toContain("offer:publish");
  });

  it("commerce blocking never includes storefront:activate", () => {
    /* Going live is a Storefront lifecycle act, not a per-sale question. */
    for (const role of ["SELLER", "PROMOTER"] as const) {
      expect(commerceBlockingScopesForRole(role)).not.toContain("storefront:activate");
    }
  });

  it("a buyer carries no commerce-blocking scope", () => {
    expect(commerceBlockingScopesForRole("BUYER")).toHaveLength(0);
  });
});

describe("suspension dominates", () => {
  it("refuses every action, whatever scopes it needs", () => {
    const suspended = { suspended: true, activeScopes: [] as const };
    expect(
      evaluateParticipantAction({ standing: suspended, requiredScopes: [] }).denialCode,
    ).toBe("PARTICIPANT_SUSPENDED");
    expect(
      evaluateParticipantAction({
        standing: suspended,
        requiredScopes: ["payout:receive"],
      }).denialCode,
    ).toBe("PARTICIPANT_SUSPENDED");
  });

  it("outranks a restriction when both stand", () => {
    const decision = evaluateParticipantAction({
      standing: { suspended: true, activeScopes: ["payout:receive"] },
      requiredScopes: ["payout:receive"],
    });
    expect(decision.denialCode).toBe("PARTICIPANT_SUSPENDED");
  });

  it("an unsuspended participant with no matching restriction is allowed", () => {
    const decision = evaluateParticipantAction({
      standing: { suspended: false, activeScopes: ["offer:publish"] },
      requiredScopes: ["payout:receive"],
    });
    expect(decision).toEqual({ allowed: true, denialCode: null });
  });

  it("a restriction on the required scope refuses, and names no reason", () => {
    const decision = evaluateParticipantAction({
      standing: { suspended: false, activeScopes: ["payout:receive"] },
      requiredScopes: ["payout:receive"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe("ACTION_RESTRICTED");
  });
});

describe("denial output carries no private risk intelligence", () => {
  it("the denial vocabulary is two bounded codes", () => {
    expect([...PARTICIPANT_ACTION_DENIAL_CODES]).toEqual([
      "PARTICIPANT_SUSPENDED",
      "ACTION_RESTRICTED",
    ]);
  });

  it("no denial code names a score, a rate, a review, or a reason", () => {
    for (const code of PARTICIPANT_ACTION_DENIAL_CODES) {
      expect(code).not.toMatch(/SCORE|RATE|CHARGEBACK|REFUND|REVIEW|FRAUD|RISK/i);
    }
  });

  it("the standing error module declares no forbidden field", () => {
    const src = read("src/server/marketplace/participant-standing-errors.ts");
    for (const forbidden of NEVER_ON_PARTICIPANT_ACTION_DENIAL) {
      expect(src).not.toContain(`readonly ${forbidden}`);
    }
  });
});

describe("private standing does not reach public surfaces", () => {
  it("withholds the two participant-describing listing reasons", () => {
    const filtered = publicSafeBlockingReasons([
      "PRODUCT_UNAVAILABLE",
      "CONTROLLING_PARTICIPANT_NOT_ACTIVE",
      "CONTROLLING_ROLE_NOT_ACTIVE",
      "LISTING_NOT_ACTIVE",
    ]);
    expect(filtered).toEqual(["PRODUCT_UNAVAILABLE", "LISTING_NOT_ACTIVE"]);
    for (const withheld of PARTICIPANT_STANDING_BLOCKING_REASONS) {
      expect(filtered).not.toContain(withheld);
    }
  });

  it("keeps the Offer's current-availability refusal public-safe", () => {
    /* Phase 1.15, Ruling 1 — `OFFER_NOT_CURRENTLY_OFFERED` describes the OFFER,
       not the participant, so it travels to a buyer exactly as the other Offer
       and Listing codes do. A buyer is owed "this is not for sale". */
    expect(publicSafeBlockingReasons(["OFFER_NOT_CURRENTLY_OFFERED"])).toEqual([
      "OFFER_NOT_CURRENTLY_OFFERED",
    ]);
    expect(PARTICIPANT_STANDING_BLOCKING_REASONS).not.toContain("OFFER_NOT_CURRENTLY_OFFERED");
  });

  it("withholds every party-disclosing risk denial reason from a buyer", () => {
    const filtered = buyerSafeRiskDenialReasons([
      "ORDER_AMOUNT_EXCEEDS_LIMIT",
      "SELLER_RESTRICTED",
      "PROMOTER_RESTRICTED",
      "SELLER_NOT_COMMERCE_APPROVED",
      "SELLER_PAYMENT_NOT_READY",
      "CURRENCY_NOT_PERMITTED",
    ]);
    expect(filtered).toEqual(["ORDER_AMOUNT_EXCEEDS_LIMIT", "CURRENCY_NOT_PERMITTED"]);
    for (const withheld of PARTY_DISCLOSING_RISK_DENIAL_REASON_CODES) {
      expect(filtered).not.toContain(withheld);
    }
  });

  it("the public buyer surfaces filter rather than pass through", () => {
    expect(read("src/server/payments/listing-checkout-view.ts")).toContain(
      "publicSafeBlockingReasons(error.blockingReasons)",
    );
    expect(read("src/server/payments/checkout-route-handler.ts")).toContain(
      "buyerSafeRiskDenialReasons(error.reasonCodes)",
    );
  });
});

describe("risk analytics cannot reach an enforcement seam", () => {
  it("the standing service reads only governed decisions", () => {
    const src = read(STANDING_SERVICE);
    expect(src).toContain("participantSuspension");
    expect(src).toContain("participantRestriction");
    /* No analytics table, no score, no threshold, no review disposition. */
    for (const forbidden of [
      "sellerRiskMetric",
      "participantRiskReview",
      "riskScore",
      "chargebackRate",
      "refundRate",
      "SUSPENSION_RECOMMENDED",
      "seller-risk-report-service",
      "seller-risk-review-policy-service",
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it("the standing service writes nothing", () => {
    const src = read(STANDING_SERVICE);
    for (const write of [".create(", ".update(", ".delete(", ".upsert(", ".createMany("]) {
      expect(src).not.toContain(write);
    }
  });

  it("no risk module imports a mitigation writer", () => {
    for (const rel of [
      "src/server/risk/participant-risk-review-service.ts",
      "src/server/risk/seller-risk-report-service.ts",
      "src/server/risk/transaction-risk-service.ts",
      "scripts/seller-risk-review.ts",
    ]) {
      const src = read(rel);
      expect(src).not.toContain("imposeParticipantRestriction");
      expect(src).not.toContain("suspendParticipant");
    }
  });
});

describe("stand-down is never gated", () => {
  /* A participant whose commerce was just withheld must still be able to stop
     trading. Each seam guards only the branch that makes something live. */
  it("the offer seam guards activation only", () => {
    const src = read("src/server/marketplace/offer-service.ts");
    expect(src).toContain('next.lifecycle === "ACTIVE" && current.lifecycle !== "ACTIVE"');
    expect(src).toContain("assertOfferMayBecomeCommerciallyLive");
  });

  it("the listing seam guards going live only", () => {
    const src = read("src/server/marketplace/listing-service.ts");
    expect(src).toContain('nextLifecycle === "ACTIVE" && current.lifecycle !== "ACTIVE"');
  });

  it("the storefront seam guards going live and widening exposure only", () => {
    const src = read("src/server/marketplace/storefront-service.ts");
    expect(src).toContain("becomingOperational || wideningExposure");
    expect(src).toContain("isExposureIncrease(current.visibility, next.visibility)");
  });
});

describe("historical obligations stay outside enforcement", () => {
  it("no correction path consults participant standing", () => {
    /* Refunds, disputes, reversals, and tax corrections are obligations Monacado
       already owes. A restriction withholds what a participant may do NEXT and
       never what has already been promised — asserted here because the property
       is currently true by absence, and absence is what silently regresses. */
    for (const rel of [
      "src/server/marketplace/refund-initiation-service.ts",
      "src/server/marketplace/order-refund-service.ts",
      "src/server/marketplace/transaction-reversal-service.ts",
      "src/server/marketplace/transaction-dispute-service.ts",
      "src/server/marketplace/dispute-evidence-service.ts",
    ]) {
      const src = read(rel);
      expect(src).not.toContain("participantRestriction");
      expect(src).not.toContain("participantSuspension");
      expect(src).not.toContain("participant-standing-service");
    }
  });

  it("settlement gating stops at ELIGIBLE and never blocks PAID", () => {
    const src = read("src/server/marketplace/order-service.ts");
    expect(src).toContain('if (to === "ELIGIBLE")');
    expect(src).toContain("Nothing here blocks PAID");
  });
});

describe("MoR framing is preserved", () => {
  it("no phase 1.15 file frames proceeds as the participant's money", () => {
    const forbidden = [
      "seller's funds",
      "the seller's share of buyer payments",
      "on behalf of the seller",
      "forward buyer funds",
      "forwards funds",
      "pass through to seller",
      "payment facilitator",
      "payfac",
      "remit to seller",
      "payout to seller",
    ];
    for (const rel of [
      "src/contracts/marketplace/restriction-enforcement.ts",
      STANDING_SERVICE,
      "src/server/marketplace/participant-standing-errors.ts",
      "src/server/marketplace/order-errors.ts",
    ]) {
      const src = read(rel).toLowerCase();
      for (const phrase of forbidden) {
        expect(src, `${rel} must not contain "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it("the payout scope is described as Monacado's own obligation", () => {
    const entry = RESTRICTION_SCOPE_ENFORCEMENT["payout:receive"];
    expect(entry.meaning).toContain("its commercial obligation");
    expect(entry.rationale).toContain("never the buyer's own payment");
  });
});

describe("no provider, publication, or policy activation", () => {
  it("the phase's own modules contact nothing external", () => {
    for (const rel of [
      "src/contracts/marketplace/restriction-enforcement.ts",
      STANDING_SERVICE,
      "src/server/marketplace/participant-standing-errors.ts",
    ]) {
      const src = read(rel);
      /* `publish` is deliberately absent from this list: `offer:publish` is a
         capability NAME, and matching the substring would forbid the vocabulary
         rather than the act. What is checked is that nothing here calls a
         provider, opens a socket, or reaches a publication pipeline. */
      for (const forbidden of [
        "stripe",
        "fetch(",
        "agentnet",
        "publication-service",
        "publication-worker",
        "projectofferCapsule",
        "http://",
        "https://",
      ]) {
        expect(src.toLowerCase(), `${rel} must not reference ${forbidden}`).not.toContain(
          forbidden.toLowerCase(),
        );
      }
    }
  });
});
