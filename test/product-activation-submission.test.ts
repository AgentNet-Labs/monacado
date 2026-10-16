/**
 * Phase 1.39 — the browser half of Product activation (pure, `fetch` injected).
 */

import { describe, expect, it } from "vitest";
import {
  ACTIVATION_ALREADY_ACTIVE,
  ACTIVATION_CONFLICT,
  ACTIVATION_FAILURE,
  ACTIVATION_NOT_AVAILABLE,
  ACTIVATION_SIGNED_OUT,
  productActivationEndpoint,
  submitProductActivation,
} from "../app/account/product-activation-submission";
import { PRODUCT_ACTIVATION_BLOCKER_LABELS } from "../app/account/account-home-copy";

const REF = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN = "0123456789abcdef0123456789abcdef";

function respond(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("submitProductActivation", () => {
  it("sends only the revision token, to the reference's activate path", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ productRef: REF, lifecycle: "ACTIVE", revision: TOKEN }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await submitProductActivation({ productRef: REF, expectedRevision: TOKEN }, { fetchImpl })).toEqual({
      outcome: "activated",
    });
    expect(seen!.url).toBe(productActivationEndpoint(REF));
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ expectedRevision: TOKEN });
  });

  const cases: [number, unknown, string][] = [
    [401, { error: "UNAUTHENTICATED" }, ACTIVATION_SIGNED_OUT],
    [404, { error: "PRODUCT_NOT_AVAILABLE" }, ACTIVATION_NOT_AVAILABLE],
    [409, { error: "PRODUCT_REVISION_CONFLICT" }, ACTIVATION_CONFLICT],
    [409, { error: "PRODUCT_ALREADY_ACTIVE" }, ACTIVATION_ALREADY_ACTIVE],
    [409, { error: "PRODUCT_SUSPENDED" }, PRODUCT_ACTIVATION_BLOCKER_LABELS.PRODUCT_SUSPENDED],
    [409, { error: "PRODUCT_INCOMPLETE", blockers: ["PRODUCT_INCOMPLETE"] }, PRODUCT_ACTIVATION_BLOCKER_LABELS.PRODUCT_INCOMPLETE],
    [403, { error: "EMAIL_UNVERIFIED", blockers: ["EMAIL_UNVERIFIED"] }, PRODUCT_ACTIVATION_BLOCKER_LABELS.EMAIL_UNVERIFIED],
    [403, { error: "PAYMENT_NOT_READY", blockers: ["PAYMENT_NOT_READY"] }, PRODUCT_ACTIVATION_BLOCKER_LABELS.PAYMENT_NOT_READY],
    [500, { error: "PRODUCT_UNAVAILABLE" }, ACTIVATION_FAILURE],
    [400, { error: "SOMETHING_NEW" }, ACTIVATION_FAILURE],
  ];
  for (const [status, body, message] of cases) {
    it(`maps ${status} ${(body as { error: string }).error} to one bounded sentence`, async () => {
      expect(
        await submitProductActivation({ productRef: REF, expectedRevision: TOKEN }, { fetchImpl: respond(status, body) }),
      ).toEqual({ outcome: "failed", message });
    });
  }

  it("fails closed on a network error and on an empty reference", async () => {
    const throwing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await submitProductActivation({ productRef: REF, expectedRevision: TOKEN }, { fetchImpl: throwing })).toEqual({
      outcome: "failed",
      message: ACTIVATION_FAILURE,
    });
    expect(await submitProductActivation({ productRef: "", expectedRevision: TOKEN })).toEqual({
      outcome: "failed",
      message: ACTIVATION_NOT_AVAILABLE,
    });
  });
});
