/**
 * Phase 1.46 — the browser half of Storefront go-live: one request shape, and
 * a refusal translated into one sentence from closed reason codes.
 */

import { describe, expect, it } from "vitest";
import {
  GO_LIVE_ALREADY_LIVE,
  GO_LIVE_NOT_AVAILABLE,
  goLiveRefusalMessage,
  storefrontGoLiveEndpoint,
  submitStorefrontGoLive,
} from "../app/account/storefront-go-live-submission";

const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

describe("Storefront go-live submission", () => {
  it("posts an empty JSON object to the handle's go-live route", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await submitStorefrontGoLive("ada-workshop", { fetchImpl })).toEqual({ outcome: "live" });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(storefrontGoLiveEndpoint("ada-workshop"));
    expect(calls[0]![1]).toMatchObject({ method: "POST", body: "{}" });
  });

  it("names the domain's reasons, and nothing else", async () => {
    const refused = await submitStorefrontGoLive("ada-workshop", {
      fetchImpl: respond(403, { error: "STOREFRONT_GO_LIVE_REFUSED", blockers: ["GO_LIVE_NOT_APPROVED", "OWNER_EMAIL_UNVERIFIED"] }) as never,
    });
    expect(refused).toEqual({
      outcome: "failed",
      message:
        "This storefront can't go live yet: Monacado has not yet approved this account for commerce; the owner's email address is not verified.",
    });
    expect(goLiveRefusalMessage(["PAYMENT_NOT_READY"])).toContain("admission or payment setup");
    expect(await submitStorefrontGoLive("x", { fetchImpl: respond(404, { error: "STOREFRONT_NOT_FOUND" }) as never })).toEqual({
      outcome: "failed",
      message: GO_LIVE_NOT_AVAILABLE,
    });
    expect(await submitStorefrontGoLive("x", { fetchImpl: respond(409, { error: "STOREFRONT_ALREADY_LIVE" }) as never })).toEqual({
      outcome: "failed",
      message: GO_LIVE_ALREADY_LIVE,
    });
  });
});
