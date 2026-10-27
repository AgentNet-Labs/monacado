/**
 * Phase 1.42 — the browser half of the Seller's Offer acts and its copy (pure,
 * `fetch` injected).
 *
 * The browser sends terms as typed and echoes the server's disclosure on
 * confirm; it computes no economics. A missing or stale confirmation comes back
 * as a question for the Seller, never as success or a bare failure.
 */

import { describe, expect, it } from "vitest";
import {
  OFFER_ALREADY_EXISTS,
  OFFER_FAILURE,
  OFFER_INVALID,
  OFFER_NOT_FOUND,
  OFFER_PROMOTION_PENDING,
  OFFER_SIGNED_OUT,
  OFFER_STALE,
  OFFER_TRANSITION,
  confirmationFrom,
  instantFromLocal,
  offerActEndpoint,
  offerCreateEndpoint,
  postOffer,
  termsBody,
} from "../app/account/offer-submission";
import {
  OFFER_ACTIVATION_BLOCKER_LABELS,
  OFFER_LIFECYCLE_LABELS,
  OFFER_PROMOTION_STATUS_LABELS,
  formatOfferBlocker,
  formatOfferCommission,
  formatOfferEconomics,
  formatOfferPromotionStatus,
} from "../app/account/account-home-copy";
import {
  OFFER_ACTIVATION_BLOCKERS,
  OFFER_LIFECYCLE_STATES,
  OFFER_PROMOTION_STATUSES,
} from "../src/contracts/marketplace/offer-source";

const PRODUCT = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const OFFER = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

const DISCLOSURE = {
  version: "2",
  calculatedCommissionMinorUnits: 1200,
  calculatedSellerGrossProceedsMinorUnits: 4800,
  commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
};

function respond(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("endpoints", () => {
  it("name only the references", () => {
    expect(offerCreateEndpoint(PRODUCT)).toBe(`/api/products/${PRODUCT}/offers`);
    expect(offerActEndpoint(PRODUCT, OFFER, "promotions/replace")).toBe(
      `/api/products/${PRODUCT}/offers/${OFFER}/promotions/replace`,
    );
  });
});

describe("postOffer", () => {
  it("POSTs the body as JSON, same-origin, and reports success", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const url = offerActEndpoint(PRODUCT, OFFER, "pause");
    expect(await postOffer(url, {}, { fetchImpl })).toEqual({ outcome: "updated" });
    expect(seen!.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(seen!.init.body as string)).toEqual({});
  });

  it("turns a confirmation refusal into a question carrying the server's disclosure", async () => {
    const outcome = await postOffer("/x", {}, {
      fetchImpl: respond(409, { error: "OFFER_CONFIRMATION_STALE", reasons: ["CREATOR_ECONOMICS_NOT_CONFIRMED"], disclosure: DISCLOSURE }),
    });
    expect(outcome).toEqual({ outcome: "confirm", disclosure: DISCLOSURE });
  });

  it("a confirmation refusal without a well-formed disclosure is a plain stale failure", async () => {
    const outcome = await postOffer("/x", {}, {
      fetchImpl: respond(409, { error: "OFFER_CONFIRMATION_STALE", disclosure: { version: 2 } }),
    });
    expect(outcome).toEqual({ outcome: "failed", message: OFFER_STALE });
  });

  it("names the first readiness blocker", async () => {
    const outcome = await postOffer("/x", {}, {
      fetchImpl: respond(409, { error: "OFFER_NOT_READY", blockers: ["PRODUCT_NOT_ACTIVE", "PAYMENT_NOT_READY"] }),
    });
    expect(outcome).toEqual({ outcome: "failed", message: formatOfferBlocker(["PRODUCT_NOT_ACTIVE"]) });
  });

  const cases: [number, unknown, string][] = [
    [401, {}, OFFER_SIGNED_OUT],
    [400, { error: "INVALID_OFFER_REQUEST" }, OFFER_INVALID],
    [404, { error: "OFFER_NOT_FOUND" }, OFFER_NOT_FOUND],
    [409, { error: "OFFER_ALREADY_EXISTS" }, OFFER_ALREADY_EXISTS],
    [409, { error: "OFFER_VERSION_STALE" }, OFFER_STALE],
    [409, { error: "OFFER_TRANSITION_NOT_PERMITTED" }, OFFER_TRANSITION],
    [409, { error: "OFFER_PROMOTION_PENDING" }, OFFER_PROMOTION_PENDING],
    [500, { error: "OFFER_UNAVAILABLE" }, OFFER_FAILURE],
    [502, "not json", OFFER_FAILURE],
  ];
  it.each(cases)("maps %i %j to its message", async (status, body, message) => {
    expect(await postOffer("/x", {}, { fetchImpl: respond(status, body) })).toEqual({ outcome: "failed", message });
  });

  it("a network failure is a failure, never success", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await postOffer("/x", {}, { fetchImpl })).toEqual({ outcome: "failed", message: OFFER_FAILURE });
  });
});

describe("request bodies", () => {
  it("echoes a disclosure as the confirmation, field for field", () => {
    expect(confirmationFrom(DISCLOSURE)).toEqual(DISCLOSURE);
  });

  it("sends terms as typed, with no amount computed in the browser", () => {
    expect(termsBody({ wholesalePrice: " 19.99 ", commissionMethod: "PERCENT_OF_WHOLESALE", commissionValue: "12.5" })).toEqual({
      wholesalePrice: "19.99",
      currency: "USD",
      commission: { method: "PERCENT_OF_WHOLESALE", percent: "12.5" },
    });
    expect(termsBody({ wholesalePrice: "19.99", commissionMethod: "FIXED_AMOUNT", commissionValue: "2" })).toEqual({
      wholesalePrice: "19.99",
      currency: "USD",
      commission: { method: "FIXED_AMOUNT", amount: "2" },
    });
    expect(termsBody({ wholesalePrice: "", commissionMethod: "FIXED_AMOUNT", commissionValue: "2" })).toBeNull();
    expect(termsBody({ wholesalePrice: "5", commissionMethod: "FIXED_AMOUNT", commissionValue: " " })).toBeNull();
  });

  it("reads a datetime-local value as a UTC instant, and refuses blank or garbage", () => {
    expect(instantFromLocal("")).toBeNull();
    expect(instantFromLocal("soon")).toBeNull();
    expect(instantFromLocal("2027-06-01T09:00")).toMatch(/^2027-06-0[12]T\d{2}:00:00\.000Z$/);
  });
});

describe("copy", () => {
  it("labels every lifecycle state, promotion status, and blocker", () => {
    for (const state of OFFER_LIFECYCLE_STATES) expect(OFFER_LIFECYCLE_LABELS[state]).toBeTruthy();
    for (const status of OFFER_PROMOTION_STATUSES) expect(OFFER_PROMOTION_STATUS_LABELS[status]).toBeTruthy();
    for (const blocker of OFFER_ACTIVATION_BLOCKERS) expect(OFFER_ACTIVATION_BLOCKER_LABELS[blocker]).toBeTruthy();
    expect(formatOfferBlocker([])).toBeNull();
  });

  it("never shows a promotion as running unless it is in force", () => {
    expect(formatOfferPromotionStatus({ status: "RUNNING", inForce: true }, "ACTIVE")).toBe("Running");
    expect(formatOfferPromotionStatus({ status: "RUNNING", inForce: false }, "PAUSED")).toBe(
      "Not in effect — the offer is paused",
    );
    expect(formatOfferPromotionStatus({ status: "RUNNING", inForce: false }, "WITHDRAWN")).toBe(
      "Not in effect — the offer was withdrawn",
    );
    expect(formatOfferPromotionStatus({ status: "RUNNING", inForce: false }, "ENDED")).toBe(
      "Not in effect — the offer has ended",
    );
    /* A scheduled one on a terminal Offer will never start; on a paused one it may. */
    expect(formatOfferPromotionStatus({ status: "SCHEDULED", inForce: false }, "WITHDRAWN")).toBe(
      "Will not take effect — the offer was withdrawn",
    );
    expect(formatOfferPromotionStatus({ status: "SCHEDULED", inForce: false }, "PAUSED")).toBe("Scheduled");
    /* History stays history. */
    expect(formatOfferPromotionStatus({ status: "ENDED_EARLY", inForce: false }, "WITHDRAWN")).toBe("Ended early");
    for (const lifecycle of OFFER_LIFECYCLE_STATES) {
      for (const status of OFFER_PROMOTION_STATUSES) {
        expect(formatOfferPromotionStatus({ status, inForce: false }, lifecycle)).not.toBe("Running");
      }
    }
  });

  it("formats the commission method and the economics a Seller confirms", () => {
    expect(formatOfferCommission({ method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 1250 }, "USD")).toBe(
      "12.5% of wholesale",
    );
    expect(formatOfferCommission({ method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 200 }, "USD")).toBe("$2.00 per sale");
    const line = formatOfferEconomics({
      wholesalePriceMinorUnits: 6000,
      currency: "USD",
      calculatedCommissionMinorUnits: 1200,
      calculatedSellerGrossProceedsMinorUnits: 4800,
      commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
    });
    expect(line).toBe(
      "Wholesale $60.00 · promoter commission $12.00 · you receive $48.00 per sale before fees · policy WHOLESALE_COMMISSION_V1",
    );
  });
});
