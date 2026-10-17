/**
 * Phase 1.40 — Seller-controlled Product resale availability, pure.
 *
 * The transition table, the lifecycle gate on setting AVAILABLE, no-op handling,
 * the resale-effectiveness helper, and the browser submission's mapping. No
 * database.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCT_RESALE_AVAILABILITY,
  PRODUCT_RESALE_AVAILABILITY_STATES,
  decideResaleAvailabilityChange,
  governedResaleAvailabilityTargets,
  productResaleEffectiveness,
  resaleAvailabilityOptions,
  type ProductResaleAvailability,
} from "../src/contracts/product/product-resale-availability";
import { PRODUCT_LIFECYCLE_STATES } from "../src/contracts/product/product-lifecycle";
import {
  RESALE_CONFLICT,
  RESALE_FAILURE,
  RESALE_NOT_AVAILABLE,
  RESALE_NOT_GOVERNED,
  RESALE_SIGNED_OUT,
  productResaleAvailabilityEndpoint,
  submitProductResaleAvailability,
} from "../app/account/product-resale-availability-submission";
import { RESALE_REQUIRES_ACTIVE, formatResaleAvailability } from "../app/account/account-home-copy";

describe("resale availability — states and default", () => {
  it("has exactly the four governed states, and every Product starts NOT_OFFERED", () => {
    expect([...PRODUCT_RESALE_AVAILABILITY_STATES]).toEqual(["NOT_OFFERED", "AVAILABLE", "PAUSED", "WITHDRAWN"]);
    expect(DEFAULT_PRODUCT_RESALE_AVAILABILITY).toBe("NOT_OFFERED");
  });

  it("governs only the unambiguous transitions", () => {
    expect(governedResaleAvailabilityTargets("NOT_OFFERED")).toEqual(["AVAILABLE"]);
    expect(governedResaleAvailabilityTargets("AVAILABLE")).toEqual(["PAUSED", "WITHDRAWN"]);
    expect(governedResaleAvailabilityTargets("PAUSED")).toEqual(["AVAILABLE", "WITHDRAWN"]);
    /* Re-opening a withdrawn Product "requires governed future handling" (§9.3). */
    expect(governedResaleAvailabilityTargets("WITHDRAWN")).toEqual([]);
  });
});

describe("decideResaleAvailabilityChange", () => {
  it("ACTIVE → AVAILABLE is a change", () => {
    expect(decideResaleAvailabilityChange({ current: "NOT_OFFERED", target: "AVAILABLE", lifecycle: "ACTIVE" })).toEqual({
      outcome: "CHANGE",
      from: "NOT_OFFERED",
      to: "AVAILABLE",
    });
  });

  for (const lifecycle of ["INCOMPLETE", "COMPLETE", "SUSPENDED"] as const) {
    it(`a ${lifecycle} Product cannot newly become AVAILABLE — from NOT_OFFERED or PAUSED`, () => {
      for (const current of ["NOT_OFFERED", "PAUSED"] as const) {
        expect(decideResaleAvailabilityChange({ current, target: "AVAILABLE", lifecycle })).toEqual({
          outcome: "REFUSED",
          reason: "PRODUCT_NOT_ACTIVE",
        });
      }
    });

    it(`a preserved AVAILABLE re-requested while ${lifecycle} is no change, not a refusal`, () => {
      expect(decideResaleAvailabilityChange({ current: "AVAILABLE", target: "AVAILABLE", lifecycle })).toEqual({
        outcome: "UNCHANGED",
      });
    });
  }

  it("PAUSED and WITHDRAWN are protective and permitted in every lifecycle", () => {
    for (const lifecycle of PRODUCT_LIFECYCLE_STATES) {
      expect(decideResaleAvailabilityChange({ current: "AVAILABLE", target: "PAUSED", lifecycle }).outcome).toBe("CHANGE");
      expect(decideResaleAvailabilityChange({ current: "AVAILABLE", target: "WITHDRAWN", lifecycle }).outcome).toBe("CHANGE");
      expect(decideResaleAvailabilityChange({ current: "PAUSED", target: "WITHDRAWN", lifecycle }).outcome).toBe("CHANGE");
    }
  });

  it("PAUSED → AVAILABLE resumes only while ACTIVE", () => {
    expect(decideResaleAvailabilityChange({ current: "PAUSED", target: "AVAILABLE", lifecycle: "ACTIVE" }).outcome).toBe("CHANGE");
  });

  it("refuses every ungoverned transition, whatever the lifecycle", () => {
    const ungoverned: Array<[ProductResaleAvailability, ProductResaleAvailability]> = [
      ["WITHDRAWN", "AVAILABLE"],
      ["WITHDRAWN", "PAUSED"],
      ["WITHDRAWN", "NOT_OFFERED"],
      ["NOT_OFFERED", "PAUSED"],
      ["NOT_OFFERED", "WITHDRAWN"],
      ["AVAILABLE", "NOT_OFFERED"],
      ["PAUSED", "NOT_OFFERED"],
    ];
    for (const lifecycle of PRODUCT_LIFECYCLE_STATES) {
      for (const [current, target] of ungoverned) {
        expect(decideResaleAvailabilityChange({ current, target, lifecycle })).toEqual({
          outcome: "REFUSED",
          reason: "TRANSITION_NOT_GOVERNED",
        });
      }
    }
  });

  it("the same state is always a no-op", () => {
    for (const lifecycle of PRODUCT_LIFECYCLE_STATES) {
      for (const state of PRODUCT_RESALE_AVAILABILITY_STATES) {
        expect(decideResaleAvailabilityChange({ current: state, target: state, lifecycle })).toEqual({ outcome: "UNCHANGED" });
      }
    }
  });
});

describe("resaleAvailabilityOptions", () => {
  it("offers AVAILABLE on an ACTIVE Product, and holds it back with the reason otherwise", () => {
    expect(resaleAvailabilityOptions("NOT_OFFERED", "ACTIVE")).toEqual([{ target: "AVAILABLE", refusal: null }]);
    expect(resaleAvailabilityOptions("NOT_OFFERED", "COMPLETE")).toEqual([
      { target: "AVAILABLE", refusal: "PRODUCT_NOT_ACTIVE" },
    ]);
    expect(resaleAvailabilityOptions("PAUSED", "SUSPENDED")).toEqual([
      { target: "AVAILABLE", refusal: "PRODUCT_NOT_ACTIVE" },
      { target: "WITHDRAWN", refusal: null },
    ]);
    expect(resaleAvailabilityOptions("WITHDRAWN", "ACTIVE")).toEqual([]);
  });
});

describe("productResaleEffectiveness — the future promoted-commerce contract", () => {
  it("is effective only when lifecycle is ACTIVE and resale is AVAILABLE", () => {
    for (const lifecycle of PRODUCT_LIFECYCLE_STATES) {
      for (const resaleAvailability of PRODUCT_RESALE_AVAILABILITY_STATES) {
        const answer = productResaleEffectiveness({ lifecycle, resaleAvailability });
        expect(answer.effective).toBe(lifecycle === "ACTIVE" && resaleAvailability === "AVAILABLE");
      }
    }
  });

  it("names the lifecycle first: a preserved AVAILABLE does not override a non-ACTIVE lifecycle", () => {
    expect(productResaleEffectiveness({ lifecycle: "COMPLETE", resaleAvailability: "AVAILABLE" })).toEqual({
      effective: false,
      ineffectiveBecause: "LIFECYCLE_NOT_ACTIVE",
    });
    expect(productResaleEffectiveness({ lifecycle: "ACTIVE", resaleAvailability: "PAUSED" })).toEqual({
      effective: false,
      ineffectiveBecause: "RESALE_NOT_AVAILABLE",
    });
    expect(productResaleEffectiveness({ lifecycle: "ACTIVE", resaleAvailability: "AVAILABLE" })).toEqual({
      effective: true,
      ineffectiveBecause: null,
    });
  });

  it("takes no legacy promotable, generalAvailabilityState, Offer, Listing, Storefront, or authorization input", () => {
    /* The contract's input is exactly the two axes; anything else is a type error. */
    // @ts-expect-error — promotable is retired and is not an input.
    productResaleEffectiveness({ lifecycle: "ACTIVE", resaleAvailability: "AVAILABLE", promotable: true });
    // @ts-expect-error — generalAvailabilityState is not an input.
    productResaleEffectiveness({ lifecycle: "ACTIVE", resaleAvailability: "AVAILABLE", generalAvailabilityState: "available" });
    expect(productResaleEffectiveness.length).toBe(1);
  });
});

describe("resale wording", () => {
  it("never presents a preserved AVAILABLE on a non-ACTIVE Product as resale", () => {
    expect(formatResaleAvailability("AVAILABLE", true)).toBe("Resale available");
    expect(formatResaleAvailability("AVAILABLE", false)).toBe(
      "Resale preference: Available, currently ineffective because the product is not active",
    );
    expect(formatResaleAvailability("NOT_OFFERED", false)).toBe("Not offered for resale");
  });
});

describe("resale-availability submission", () => {
  function captureFetch(reply: Response | (() => never)) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (typeof reply === "function") reply();
      return reply;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const REF = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  it("sends only the target state, to the Product's own path", async () => {
    const { calls, fetchImpl } = captureFetch(json(200, {}));
    expect(await submitProductResaleAvailability({ productRef: REF, resaleAvailability: "PAUSED" }, { fetchImpl })).toEqual({
      outcome: "updated",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(productResaleAvailabilityEndpoint(REF));
    expect(calls[0]!.url).toBe(`/api/products/${REF}/resale-availability`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ resaleAvailability: "PAUSED" });
  });

  it("maps every refusal onto bounded copy", async () => {
    const cases: Array<[Response | (() => never), string]> = [
      [json(401, { error: "UNAUTHENTICATED" }), RESALE_SIGNED_OUT],
      [json(404, { error: "PRODUCT_NOT_AVAILABLE" }), RESALE_NOT_AVAILABLE],
      [json(409, { error: "RESALE_AVAILABILITY_REQUIRES_ACTIVE_PRODUCT" }), RESALE_REQUIRES_ACTIVE],
      [json(409, { error: "RESALE_AVAILABILITY_TRANSITION_NOT_GOVERNED" }), RESALE_NOT_GOVERNED],
      [json(409, { error: "RESALE_AVAILABILITY_CONFLICT" }), RESALE_CONFLICT],
      [json(400, { error: "INVALID_RESALE_AVAILABILITY_REQUEST" }), RESALE_FAILURE],
      [new Response("not json", { status: 502 }), RESALE_FAILURE],
      [
        () => {
          throw new TypeError("network");
        },
        RESALE_FAILURE,
      ],
    ];
    for (const [reply, message] of cases) {
      const { fetchImpl } = captureFetch(reply);
      expect(
        await submitProductResaleAvailability({ productRef: REF, resaleAvailability: "AVAILABLE" }, { fetchImpl }),
      ).toEqual({ outcome: "failed", message });
    }
  });

  it("sends nothing without a reference", async () => {
    const { calls, fetchImpl } = captureFetch(json(200, {}));
    expect(await submitProductResaleAvailability({ productRef: "", resaleAvailability: "AVAILABLE" }, { fetchImpl })).toEqual({
      outcome: "failed",
      message: RESALE_NOT_AVAILABLE,
    });
    expect(calls).toHaveLength(0);
  });
});
