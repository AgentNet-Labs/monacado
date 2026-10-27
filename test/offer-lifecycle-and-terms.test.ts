/**
 * Offer lifecycle, promotion status, and effective terms — pure (Phase 1.42).
 *
 * NO DATABASE, NO NETWORK, NO CLOCK. Every instant is an explicit literal.
 *
 * The rules under test:
 *   - lifecycle is derived from the current recorded act and the overall end;
 *     ENDED is never recorded, WITHDRAWN wins, the end is exclusive;
 *   - a promotion's status is derived from its window, an early-end act, and a
 *     replacement — SCHEDULED, RUNNING, ENDED, ENDED_EARLY, CANCELLED;
 *   - `effectiveOfferTerms` resolves in exactly the ruled order: not effective →
 *     none; ENDED → none; a RUNNING promotion → it; else the standing version;
 *   - it is NOT an aggregate commerce gate, and nothing reads a clock.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OFFER_ACTS,
  OFFER_LIFECYCLE_ACTS,
  OFFER_PROMOTION_STATUSES,
  RECORDED_OFFER_LIFECYCLE_STATES,
  deriveOfferLifecycleState,
  derivePromotionStatus,
  deriveSellerOfferState,
  effectiveOfferTerms,
  isOfferActionAvailable,
  isPendingPromotionStatus,
  type OfferTermsResolutionInput,
} from "../src/contracts/marketplace/offer-source";

const T0 = "2027-06-01T00:00:00.000Z";
const T1 = "2027-06-02T00:00:00.000Z";
const T2 = "2027-06-03T00:00:00.000Z";
const T3 = "2027-06-04T00:00:00.000Z";
const ms = (iso: string, delta: number) => new Date(Date.parse(iso) + delta).toISOString();

const WINDOW = { effectiveFrom: T1, effectiveUntil: T2 };

const offer = (overrides: Partial<OfferTermsResolutionInput> = {}): OfferTermsResolutionInput => ({
  recordedState: "ACTIVE",
  offerEffectiveUntil: null,
  standingVersion: "3",
  promotion: { sourceRecordVersion: "4", window: WINDOW, endedEarlyAt: null },
  ...overrides,
});

describe("vocabularies", () => {
  it("records only ACTIVE, PAUSED, WITHDRAWN; END_PROMOTION is an act, not a lifecycle move", () => {
    expect(RECORDED_OFFER_LIFECYCLE_STATES).toEqual(["ACTIVE", "PAUSED", "WITHDRAWN"]);
    expect(OFFER_LIFECYCLE_ACTS).toEqual(["ACTIVATE", "PAUSE", "RESUME", "WITHDRAW"]);
    expect(OFFER_ACTS).toEqual(["ACTIVATE", "PAUSE", "RESUME", "WITHDRAW", "END_PROMOTION"]);
    expect(OFFER_PROMOTION_STATUSES).toEqual(["SCHEDULED", "RUNNING", "ENDED", "ENDED_EARLY", "CANCELLED"]);
  });

  it("only SCHEDULED and RUNNING are pending", () => {
    expect(OFFER_PROMOTION_STATUSES.filter(isPendingPromotionStatus)).toEqual(["SCHEDULED", "RUNNING"]);
  });
});

describe("derived lifecycle", () => {
  it("is ENDED from the overall end onward, ACTIVE or PAUSED; the end is exclusive", () => {
    for (const recordedState of ["ACTIVE", "PAUSED"] as const) {
      expect(deriveOfferLifecycleState({ recordedState, offerEffectiveUntil: T1, at: ms(T1, -1) })).toBe(recordedState);
      expect(deriveOfferLifecycleState({ recordedState, offerEffectiveUntil: T1, at: T1 })).toBe("ENDED");
      expect(deriveOfferLifecycleState({ recordedState, offerEffectiveUntil: T1, at: T3 })).toBe("ENDED");
    }
  });

  it("with no overall end, never ENDS", () => {
    expect(deriveOfferLifecycleState({ recordedState: "ACTIVE", offerEffectiveUntil: null, at: "2999-01-01T00:00:00.000Z" })).toBe(
      "ACTIVE",
    );
  });

  it("a DRAFT never ends — the end is recorded only on activation", () => {
    expect(deriveOfferLifecycleState({ recordedState: null, offerEffectiveUntil: T0, at: T3 })).toBe("DRAFT");
  });
});

describe("promotion status", () => {
  const status = (at: string, extra: { endedEarlyAt?: string | null; replacedAt?: string | null } = {}) =>
    derivePromotionStatus({ window: WINDOW, endedEarlyAt: extra.endedEarlyAt ?? null, replacedAt: extra.replacedAt ?? null, at });

  it("is SCHEDULED before, RUNNING within, ENDED from the window's end — half-open", () => {
    expect(status(T0)).toBe("SCHEDULED");
    expect(status(ms(T1, -1))).toBe("SCHEDULED");
    expect(status(T1)).toBe("RUNNING");
    expect(status(ms(T2, -1))).toBe("RUNNING");
    expect(status(T2)).toBe("ENDED");
  });

  it("an early end takes effect at its instant, not before", () => {
    const endedEarlyAt = ms(T1, 3_600_000);
    expect(status(ms(endedEarlyAt, -1), { endedEarlyAt })).toBe("RUNNING");
    expect(status(endedEarlyAt, { endedEarlyAt })).toBe("ENDED_EARLY");
    expect(status(T3, { endedEarlyAt })).toBe("ENDED_EARLY");
  });

  it("a replacement cancels from its instant", () => {
    expect(status(ms(T0, 1), { replacedAt: ms(T0, 1) })).toBe("CANCELLED");
    expect(status(T0, { replacedAt: ms(T0, 1) })).toBe("SCHEDULED");
  });
});

describe("effectiveOfferTerms — the ruled order", () => {
  it("1. not lifecycle-effective → none, whatever a promotion says", () => {
    for (const recordedState of [null, "PAUSED", "WITHDRAWN"] as const) {
      expect(effectiveOfferTerms(offer({ recordedState }), T1)).toEqual({
        kind: "NONE",
        lifecycle: recordedState ?? "DRAFT",
      });
    }
  });

  it("2. ENDED → none, even inside a promotion window", () => {
    expect(effectiveOfferTerms(offer({ offerEffectiveUntil: T1 }), ms(T1, 1))).toEqual({ kind: "NONE", lifecycle: "ENDED" });
  });

  it("3. a RUNNING promotion → the promotion's exact version", () => {
    expect(effectiveOfferTerms(offer(), T1)).toEqual({ kind: "SCHEDULED_PROMOTION", sourceRecordVersion: "4" });
  });

  it("4. otherwise → the standing version: before, after, ended early, or no promotion", () => {
    const standing = { kind: "STANDING", sourceRecordVersion: "3" };
    expect(effectiveOfferTerms(offer(), T0)).toEqual(standing);
    expect(effectiveOfferTerms(offer(), T2)).toEqual(standing);
    expect(
      effectiveOfferTerms(offer({ promotion: { sourceRecordVersion: "4", window: WINDOW, endedEarlyAt: T1 } }), ms(T1, 1)),
    ).toEqual(standing);
    expect(effectiveOfferTerms(offer({ promotion: null }), T1)).toEqual(standing);
  });

  it("is deterministic and does not mutate its input", () => {
    const input = offer();
    const before = JSON.stringify(input);
    expect(effectiveOfferTerms(input, T1)).toEqual(effectiveOfferTerms(input, T1));
    expect(JSON.stringify(input)).toBe(before);
  });

  it("the Seller-facing state agrees with the resolver", () => {
    expect(deriveSellerOfferState(offer(), T1)).toEqual({
      lifecycle: "ACTIVE",
      promotionStatus: "RUNNING",
      effective: { kind: "SCHEDULED_PROMOTION", sourceRecordVersion: "4" },
    });
    expect(deriveSellerOfferState(offer({ recordedState: "PAUSED" }), T1)).toEqual({
      lifecycle: "PAUSED",
      promotionStatus: "RUNNING",
      effective: { kind: "NONE", lifecycle: "PAUSED" },
    });
  });
});

describe("offered actions", () => {
  it("are available when allowed, or refused ONLY for a missing or stale confirmation", () => {
    const decision = (decision: "ALLOW" | "DENY", ...reasonCodes: string[]) =>
      ({ capability: "offer:terms:change", decision, reasonCodes }) as Parameters<typeof isOfferActionAvailable>[0];
    expect(isOfferActionAvailable(decision("ALLOW"))).toBe(true);
    expect(isOfferActionAvailable(decision("DENY", "CREATOR_ECONOMICS_NOT_CONFIRMED"))).toBe(true);
    expect(isOfferActionAvailable(decision("DENY", "CREATOR_CONFIRMATION_STALE"))).toBe(true);
    expect(isOfferActionAvailable(decision("DENY", "PAYMENT_RESTRICTED"))).toBe(false);
    expect(isOfferActionAvailable(decision("DENY", "OFFER_LIFECYCLE_TERMINAL"))).toBe(false);
  });
});

describe("boundaries of the resolver", () => {
  const source = readFileSync(new URL("../src/contracts/marketplace/offer-source.ts", import.meta.url), "utf8");

  it("reads no clock", () => {
    expect(source).not.toMatch(/Date\.now\(|new Date\(\)/);
  });

  it("is wired into neither checkout nor Listings in Phase 1.42", () => {
    for (const path of [
      "../src/server/marketplace/checkout-service.ts",
      "../src/server/marketplace/listing-service.ts",
      "../src/contracts/marketplace/listing-source.ts",
    ]) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8")).not.toContain("effectiveOfferTerms");
    }
  });
});
