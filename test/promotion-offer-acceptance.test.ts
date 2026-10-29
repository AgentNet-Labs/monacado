/**
 * Phase 1.44 — Promoter Offer-package acceptance: the pure contract and the
 * browser submission half. NO DATABASE, NO NETWORK. What the service, route,
 * and read models do against real rows is proved by
 * `promotion-offer-acceptance.integration.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  OfferPackageAcceptanceInput,
  PROMOTED_TERMS_BLOCKERS,
  PROMOTED_TERMS_NOT_EVALUATED,
  RESALE_STATES_ADMITTING_ACCEPTANCE,
  acceptableOfferPackage,
  acceptanceCoveringPackage,
  acceptanceCoveringTermsInForce,
  acceptanceOfPackage,
  decidePromotedTermsEligibility,
  offerPackageMismatch,
  resaleAdmitsAcceptance,
  termsInForceOf,
  type PromotedTermsFacts,
  type RecordedOfferAcceptance,
} from "../src/contracts/marketplace/promotion-offer-acceptance";
import { OFFER_LIFECYCLE_STATES } from "../src/contracts/marketplace/offer-source";
import { PRODUCT_RESALE_AVAILABILITY_STATES } from "../src/contracts/product/product-resale-availability";
import {
  ACCEPTANCE_FAILURE,
  ACCEPTANCE_PROMOTION_CHANGED,
  ACCEPTANCE_STANDING_STALE,
  PROMOTION_SIGNED_OUT,
  offerPackageAcceptanceEndpoint,
  submitOfferPackageAcceptance,
} from "../app/account/promotion-authorization-submission";
import { ACCEPTANCE_COVERED_BY_PACKAGE, offerPackageAccepted, offerPackageStatus } from "../app/promote/promote-copy";
import { promotionTermsAcceptanceStatus } from "../app/account/account-home-copy";

const REF = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const AUTH_REF = "ZYXWVTSRQPNMKJHGFEDCBA9876543210";
const OFFER_REF = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

const standing = {
  version: "2",
  wholesalePriceMinorUnits: 4000,
  currency: "USD",
  commission: { method: "PERCENT_OF_WHOLESALE" as const, commissionBasisPoints: 1000 },
  calculatedCommissionMinorUnits: 400,
  commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1" as const,
};
const promotion = {
  ...standing,
  version: "3",
  wholesalePriceMinorUnits: 3000,
  calculatedCommissionMinorUnits: 300,
  effectiveFrom: "2029-09-01T00:00:00.000Z",
  effectiveUntil: "2029-09-08T00:00:00.000Z",
};

const row = (standingVersion: string, promotionVersion: string | null, acceptedAt: string): RecordedOfferAcceptance => ({
  standingVersion,
  promotionVersion,
  acceptedAt,
});

describe("1.44 — the acceptance request names an exact package", () => {
  it("admits a standard-only package and a standard + promotional package, nothing looser", () => {
    expect(OfferPackageAcceptanceInput.safeParse({ offerRef: OFFER_REF, standing, promotion: null }).success).toBe(true);
    expect(OfferPackageAcceptanceInput.safeParse({ offerRef: OFFER_REF, standing, promotion }).success).toBe(true);
    // The promotion is never optional: the Promoter states that there is none.
    expect(OfferPackageAcceptanceInput.safeParse({ offerRef: OFFER_REF, standing }).success).toBe(false);
    // No part-package form: there is no promotion without standing terms.
    expect(OfferPackageAcceptanceInput.safeParse({ offerRef: OFFER_REF, promotion }).success).toBe(false);
    // No "accept whatever is current": the version is required.
    const { version: _v, ...unversioned } = standing;
    expect(OfferPackageAcceptanceInput.safeParse({ offerRef: OFFER_REF, standing: unversioned, promotion: null }).success).toBe(false);
    // A promotion must carry its window.
    const { effectiveUntil: _u, ...windowless } = promotion;
    expect(OfferPackageAcceptanceInput.safeParse({ offerRef: OFFER_REF, standing, promotion: windowless }).success).toBe(false);
  });

  it("is strict: no extra field — no retail price, proceeds, display flag, or internal id — is accepted", () => {
    for (const extra of [
      { retailPriceMinorUnits: 9000 },
      { calculatedSellerGrossProceedsMinorUnits: 3600 },
      { authorizationId: "mon:pauth:X" },
    ]) {
      expect(OfferPackageAcceptanceInput.safeParse({ offerRef: OFFER_REF, standing, promotion: null, ...extra }).success).toBe(false);
      expect(OfferPackageAcceptanceInput.safeParse({ offerRef: OFFER_REF, standing: { ...standing, ...extra }, promotion: null }).success).toBe(false);
    }
    expect(
      OfferPackageAcceptanceInput.safeParse({ offerRef: OFFER_REF, standing, promotion: { ...promotion, inForce: true } }).success,
    ).toBe(false);
  });
});

describe("1.44 — which package may be accepted", () => {
  it("only an ACTIVE Offer admits a new acceptance", () => {
    for (const lifecycle of OFFER_LIFECYCLE_STATES) {
      const pkg = acceptableOfferPackage({ lifecycle, standingVersion: "2", promotion: null });
      expect(pkg, lifecycle).toEqual(lifecycle === "ACTIVE" ? { standingVersion: "2", promotionVersion: null } : null);
    }
  });

  it("is {S} with no pending promotion, and {S, P} while P is SCHEDULED or RUNNING — never {P} alone", () => {
    const at = (status: "SCHEDULED" | "RUNNING" | "ENDED" | "ENDED_EARLY" | "CANCELLED") =>
      acceptableOfferPackage({ lifecycle: "ACTIVE", standingVersion: "2", promotion: { sourceRecordVersion: "3", status } });
    expect(at("SCHEDULED")).toEqual({ standingVersion: "2", promotionVersion: "3" });
    expect(at("RUNNING")).toEqual({ standingVersion: "2", promotionVersion: "3" });
    expect(at("ENDED")).toEqual({ standingVersion: "2", promotionVersion: null });
    expect(at("ENDED_EARLY")).toEqual({ standingVersion: "2", promotionVersion: null });
    expect(at("CANCELLED")).toEqual({ standingVersion: "2", promotionVersion: null });
  });

  it("names how a requested package differs: the standing version first, then the promotion", () => {
    const acceptable = { standingVersion: "2", promotionVersion: "3" };
    expect(offerPackageMismatch({ standingVersion: "2", promotionVersion: "3" }, acceptable)).toBeNull();
    expect(offerPackageMismatch({ standingVersion: "1", promotionVersion: "3" }, acceptable)).toBe("STANDING_VERSION_STALE");
    expect(offerPackageMismatch({ standingVersion: "1", promotionVersion: null }, acceptable)).toBe("STANDING_VERSION_STALE");
    // Accepting S alone while P is pending is refused: all or nothing.
    expect(offerPackageMismatch({ standingVersion: "2", promotionVersion: null }, acceptable)).toBe("PROMOTION_CHANGED");
    // A replaced promotion.
    expect(offerPackageMismatch({ standingVersion: "2", promotionVersion: "4" }, acceptable)).toBe("PROMOTION_CHANGED");
    // A promotion that has since ended.
    expect(offerPackageMismatch({ standingVersion: "2", promotionVersion: "3" }, { standingVersion: "2", promotionVersion: null })).toBe(
      "PROMOTION_CHANGED",
    );
  });

  it("resale AVAILABLE or PAUSED admits assent; NOT_OFFERED and WITHDRAWN do not", () => {
    expect([...RESALE_STATES_ADMITTING_ACCEPTANCE].sort()).toEqual(["AVAILABLE", "PAUSED"]);
    for (const state of PRODUCT_RESALE_AVAILABILITY_STATES) {
      expect(resaleAdmitsAcceptance(state), state).toBe(state === "AVAILABLE" || state === "PAUSED");
    }
  });
});

describe("1.44 — coverage of the terms in force is derived, never stored", () => {
  const S = { standingVersion: "2", promotionVersion: null };
  const SP = { standingVersion: "2", promotionVersion: "3" };

  it("S in force is covered by any acceptance naming S — {S} or {S, P}", () => {
    expect(acceptanceCoveringTermsInForce([row("2", null, "2029-08-01T00:00:00.000Z")], S)).not.toBeNull();
    expect(acceptanceCoveringTermsInForce([row("2", "3", "2029-08-01T00:00:00.000Z")], S)).not.toBeNull();
    expect(acceptanceCoveringTermsInForce([row("1", null, "2029-08-01T00:00:00.000Z")], S)).toBeNull(); // S2 needs a new one
    expect(acceptanceCoveringTermsInForce([], S)).toBeNull();
  });

  it("P in force is covered only by exactly (S, P) — no fallback to {S} during the window", () => {
    expect(acceptanceCoveringTermsInForce([row("2", "3", "2029-08-01T00:00:00.000Z")], SP)).not.toBeNull();
    expect(acceptanceCoveringTermsInForce([row("2", null, "2029-08-01T00:00:00.000Z")], SP)).toBeNull();
    expect(acceptanceCoveringTermsInForce([row("2", "4", "2029-08-01T00:00:00.000Z")], SP)).toBeNull(); // replacement P2
    expect(acceptanceCoveringTermsInForce([row("1", "3", "2029-08-01T00:00:00.000Z")], SP)).toBeNull();
  });

  it("returns the earliest covering acceptance, deterministically", () => {
    const rows = [row("2", "3", "2029-08-05T00:00:00.000Z"), row("2", null, "2029-08-01T00:00:00.000Z")];
    expect(acceptanceCoveringTermsInForce(rows, S)!.acceptedAt).toBe("2029-08-01T00:00:00.000Z");
    expect(acceptanceCoveringTermsInForce([...rows].reverse(), S)!.acceptedAt).toBe("2029-08-01T00:00:00.000Z");
    expect(acceptanceOfPackage(rows, SP)!.acceptedAt).toBe("2029-08-05T00:00:00.000Z");
    expect(acceptanceOfPackage(rows, { standingVersion: "2", promotionVersion: "4" })).toBeNull();
  });

  it("a package is covered exactly, or {S} by an earlier {S, P} that included S — never {S, P} by {S}", () => {
    const sp = row("2", "3", "2029-08-01T00:00:00.000Z");
    const s = row("2", null, "2029-08-05T00:00:00.000Z");
    // P ended: S resumes and the {S, P} acceptance covers it.
    expect(acceptanceCoveringPackage([sp], S)).toBe(sp);
    // The exact {S} wins over an earlier {S, P}.
    expect(acceptanceCoveringPackage([sp, s], S)).toBe(s);
    expect(acceptanceCoveringPackage([s], SP)).toBeNull();
    expect(acceptanceCoveringPackage([sp], SP)).toBe(sp);
    // A genuinely new standing version S2 is covered by nothing earlier.
    expect(acceptanceCoveringPackage([sp, s], { standingVersion: "3", promotionVersion: null })).toBeNull();
  });

  it("reads the terms in force as package members; a promotion needs its basis", () => {
    expect(termsInForceOf({ kind: "NONE", lifecycle: "PAUSED" }, null)).toBeNull();
    expect(termsInForceOf({ kind: "STANDING", sourceRecordVersion: "2" }, null)).toEqual(S);
    expect(termsInForceOf({ kind: "SCHEDULED_PROMOTION", sourceRecordVersion: "3" }, "2")).toEqual(SP);
    expect(termsInForceOf({ kind: "SCHEDULED_PROMOTION", sourceRecordVersion: "3" }, null)).toBeNull();
  });
});

describe("1.44 — the promoted-terms eligibility helper", () => {
  const facts = (over: Partial<PromotedTermsFacts<RecordedOfferAcceptance>> = {}): PromotedTermsFacts<RecordedOfferAcceptance> => ({
    productLifecycle: "ACTIVE",
    resaleAvailability: "AVAILABLE",
    offer: {
      internalOfferId: "mon:offer:X",
      offerSourceRecordId: "mon:osrec:X",
      sellerHoldsAuthority: true,
      effective: { kind: "STANDING", sourceRecordVersion: "2" },
      promotionBasisStandingVersion: null,
    },
    authorization: { authorizationId: "mon:pauth:X", state: "APPROVED" },
    selfPromotion: false,
    acceptances: [row("2", null, "2029-08-01T00:00:00.000Z")],
    ...over,
  });

  it("passes with the governing versions, the cycle, and the acceptance — and always says what it did NOT evaluate", () => {
    const decision = decidePromotedTermsEligibility(facts());
    expect(decision).toMatchObject({
      eligible: true,
      governing: { standingVersion: "2", promotionVersion: null, termsKind: "STANDING", offerSourceRecordId: "mon:osrec:X" },
      authorizationId: "mon:pauth:X",
      acceptance: { standingVersion: "2", promotionVersion: null },
    });
    expect(decision.notEvaluated).toEqual(PROMOTED_TERMS_NOT_EVALUATED);
    expect(decision.notEvaluated).toEqual(expect.arrayContaining(["PROMOTER_PAYMENT_READINESS", "LISTING_READINESS", "RETAIL_ECONOMICS"]));
  });

  it("a running promotion is governed by (S, P) and needs exactly that acceptance", () => {
    const running = {
      offer: { ...facts().offer!, effective: { kind: "SCHEDULED_PROMOTION" as const, sourceRecordVersion: "3" }, promotionBasisStandingVersion: "2" },
    };
    expect(decidePromotedTermsEligibility(facts(running))).toMatchObject({ eligible: false, blockers: ["TERMS_NOT_ACCEPTED"] });
    expect(decidePromotedTermsEligibility(facts({ ...running, acceptances: [row("2", "3", "2029-08-01T00:00:00.000Z")] }))).toMatchObject({
      eligible: true,
      governing: { standingVersion: "2", promotionVersion: "3", termsKind: "SCHEDULED_PROMOTION" },
    });
  });

  it("names every blocker that holds, in the closed order", () => {
    const decision = decidePromotedTermsEligibility(
      facts({
        productLifecycle: "INCOMPLETE",
        resaleAvailability: "PAUSED", // admits assent, not commerce
        offer: null,
        authorization: { authorizationId: "mon:pauth:X", state: "REVOKED" },
        selfPromotion: true,
        acceptances: [],
      }),
    );
    expect(decision).toMatchObject({ eligible: false, blockers: [...PROMOTED_TERMS_BLOCKERS] });
    expect(decision.notEvaluated).toEqual(PROMOTED_TERMS_NOT_EVALUATED);
  });

  it("an Offer whose author no longer holds Seller authority has no terms in force", () => {
    expect(decidePromotedTermsEligibility(facts({ offer: { ...facts().offer!, sellerHoldsAuthority: false } }))).toMatchObject({
      eligible: false,
      blockers: ["NO_OFFER_TERMS_IN_FORCE", "TERMS_NOT_ACCEPTED"],
    });
    expect(decidePromotedTermsEligibility(facts({ authorization: null }))).toMatchObject({
      eligible: false,
      blockers: ["AUTHORIZATION_NOT_APPROVED"],
    });
  });
});

/** A recording `fetch` answering with one status and body. */
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("1.44 — the browser submission half", () => {
  it("posts the exact package to the cycle's acceptance endpoint, references in the path", async () => {
    const f = fakeFetch(201, {});
    const pkg = { offerRef: OFFER_REF, standing, promotion };
    expect(await submitOfferPackageAcceptance({ productRef: REF, authorizationRef: AUTH_REF, pkg }, { fetchImpl: f.impl })).toEqual({
      outcome: "updated",
    });
    expect(f.calls[0]!.url).toBe(offerPackageAcceptanceEndpoint(REF, AUTH_REF));
    expect(f.calls[0]!.url).toBe(`/api/products/${REF}/promotion-authorization/${AUTH_REF}/offer-acceptance`);
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual(pkg);
    // A replay is answered 200 and is still success.
    expect(
      await submitOfferPackageAcceptance({ productRef: REF, authorizationRef: AUTH_REF, pkg }, { fetchImpl: fakeFetch(200, {}).impl }),
    ).toEqual({ outcome: "updated" });
  });

  it("explains each refusal plainly, and says nothing was accepted when terms moved", async () => {
    const pkg = { offerRef: OFFER_REF, standing, promotion: null };
    const answer = async (status: number, body: unknown) =>
      submitOfferPackageAcceptance({ productRef: REF, authorizationRef: AUTH_REF, pkg }, { fetchImpl: fakeFetch(status, body).impl });
    expect(await answer(409, { error: "OFFER_ACCEPTANCE_STANDING_VERSION_STALE" })).toEqual({
      outcome: "failed",
      message: ACCEPTANCE_STANDING_STALE,
    });
    expect(await answer(409, { error: "OFFER_ACCEPTANCE_PROMOTION_CHANGED" })).toEqual({
      outcome: "failed",
      message: ACCEPTANCE_PROMOTION_CHANGED,
    });
    expect(ACCEPTANCE_STANDING_STALE).toMatch(/Nothing was accepted/);
    expect(await answer(401, {})).toEqual({ outcome: "failed", message: PROMOTION_SIGNED_OUT });
    expect(await answer(500, { error: "SOMETHING_ELSE" })).toEqual({ outcome: "failed", message: ACCEPTANCE_FAILURE });
    const thrown = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await submitOfferPackageAcceptance({ productRef: REF, authorizationRef: AUTH_REF, pkg }, { fetchImpl: thrown })).toEqual({
      outcome: "failed",
      message: ACCEPTANCE_FAILURE,
    });
  });
});

describe("1.44 — status after a promotion ends: the standard terms it included stay accepted", () => {
  const view = { promotion: null, acceptedAt: null, hadEarlierAcceptance: true, inForceCovered: true };

  it("Promoter: {S} covered by an earlier {S, P} reads as accepted, with nothing to accept", () => {
    expect(offerPackageAccepted(view)).toBe(true);
    expect(offerPackageStatus(view)).toBe(ACCEPTANCE_COVERED_BY_PACKAGE);
    expect(offerPackageStatus(view)).not.toMatch(/changed|need your acceptance/);
  });

  it("Promoter: an exact {S} acceptance is unchanged; a new S2 still needs acceptance", () => {
    expect(offerPackageStatus({ ...view, acceptedAt: "2029-08-01T00:00:00.000Z" })).toBe("You accepted the standard terms on Aug 1, 2029.");
    const s2 = { ...view, inForceCovered: false };
    expect(offerPackageAccepted(s2)).toBe(false);
    expect(offerPackageStatus(s2)).toBe("The seller's terms have changed. The new terms need your acceptance.");
  });

  it("Promoter: a pending promotion is never covered by {S} alone", () => {
    const pending = { ...view, promotion: { effectiveFrom: "2029-09-01T00:00:00.000Z", inForce: false } };
    expect(offerPackageAccepted(pending)).toBe(false);
    expect(offerPackageAccepted({ ...pending, promotion: { ...pending.promotion, inForce: true }, inForceCovered: false })).toBe(false);
  });

  it("Seller: resumed S reads as accepted, as part of the {S, P} acceptance", () => {
    const status = promotionTermsAcceptanceStatus({
      packageAccepted: true,
      currentPackage: { standingVersion: "1", promotionVersion: null },
      acceptance: { standingVersion: "1", promotionVersion: "2", acceptedAt: "2029-08-01T00:00:00.000Z" },
    });
    expect(status).toBe(
      "accepted your current terms (standard terms version 1) on Aug 1, 2029, as part of standard terms version 1 + promotional terms version 2",
    );
    expect(status).not.toMatch(/hasn't/);
  });

  it("Seller: exact acceptance and a not-yet-accepted S2 read as before", () => {
    const at = "2029-08-01T00:00:00.000Z";
    expect(
      promotionTermsAcceptanceStatus({
        packageAccepted: true,
        currentPackage: { standingVersion: "1", promotionVersion: "2" },
        acceptance: { standingVersion: "1", promotionVersion: "2", acceptedAt: at },
      }),
    ).toBe("accepted your current terms (standard terms version 1 + promotional terms version 2) on Aug 1, 2029");
    expect(
      promotionTermsAcceptanceStatus({
        packageAccepted: false,
        currentPackage: { standingVersion: "3", promotionVersion: null },
        acceptance: { standingVersion: "1", promotionVersion: null, acceptedAt: at },
      }),
    ).toBe("hasn't accepted your current terms (last accepted standard terms version 1 on Aug 1, 2029)");
  });
});
