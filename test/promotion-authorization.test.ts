/**
 * Phase 1.41 — Promotion Authorization: the pure contract and the browser
 * submission half. NO DATABASE, NO NETWORK. What the services and routes do
 * against real rows is proved by `promotion-authorization.integration.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  PROMOTION_AUTHORIZATION_ACTS,
  PROMOTION_AUTHORIZATION_STATES,
  PromotionAuthorizationRef,
  decidePromotionAuthorizationAct,
  decidePromotionAuthorizationRequest,
  governedPromotionAuthorizationActs,
  isTerminalPromotionAuthorizationState,
  participantMayRequestPromotionAuthorization,
  promotionAuthorizationIsApproved,
  type PromotionAuthorizationAct,
  type PromotionAuthorizationAuthority,
  type PromotionAuthorizationRequestFacts,
  type PromotionAuthorizationState,
} from "../src/contracts/marketplace/promotion-authorization";
import { PARTICIPANT_STATUSES, ROLE_ASSIGNMENT_STATUSES } from "../src/contracts/marketplace/participant";
import {
  PROMOTION_ALREADY_REQUESTED,
  PROMOTION_FAILURE,
  PROMOTION_PRODUCT_REQUIRED,
  PROMOTION_PROMOTER_NOT_ELIGIBLE,
  PROMOTION_SIGNED_OUT,
  promotionAuthorizationCancelEndpoint,
  promotionAuthorizationDecisionEndpoint,
  promotionAuthorizationRequestEndpoint,
  submitPromotionAuthorizationCancel,
  submitPromotionAuthorizationDecision,
  submitPromotionAuthorizationRequest,
} from "../app/account/promotion-authorization-submission";
import { formatPromotionRequestRefusals, promotionCancelLabel } from "../app/account/account-home-copy";

const REF = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const AUTH_REF = "ZYXWVTSRQPNMKJHGFEDCBA9876543210";

/** Every governed (state, act, authority) → state, and nothing else. */
const GOVERNED: Array<[PromotionAuthorizationState, PromotionAuthorizationAct, PromotionAuthorizationAuthority, PromotionAuthorizationState]> = [
  ["REQUESTED", "APPROVE", "SELLER", "APPROVED"],
  ["REQUESTED", "DENY", "SELLER", "DENIED"],
  ["REQUESTED", "CANCEL", "PROMOTER", "CANCELLED"],
  ["APPROVED", "REVOKE", "SELLER", "REVOKED"],
  ["APPROVED", "CANCEL", "PROMOTER", "CANCELLED"],
];

describe("1.41 — the governed transition table", () => {
  it("permits exactly the governed within-cycle transitions", () => {
    for (const state of PROMOTION_AUTHORIZATION_STATES) {
      for (const act of PROMOTION_AUTHORIZATION_ACTS) {
        for (const authority of ["SELLER", "PROMOTER"] as const) {
          const expected = GOVERNED.find(([s, a, w]) => s === state && a === act && w === authority);
          const decision = decidePromotionAuthorizationAct({ current: state, act, authority });
          if (expected === undefined) {
            expect(decision, `${state} ${act} by ${authority}`).toEqual({
              outcome: "REFUSED",
              reason: "TRANSITION_NOT_GOVERNED",
            });
          } else {
            expect(decision).toEqual({ outcome: "CHANGE", from: state, to: expected[3] });
          }
        }
      }
    }
  });

  it("never restores approval on a terminal cycle — DENIED / REVOKED / CANCELLED → APPROVED is refused", () => {
    for (const state of ["DENIED", "REVOKED", "CANCELLED"] as const) {
      expect(isTerminalPromotionAuthorizationState(state)).toBe(true);
      expect(decidePromotionAuthorizationAct({ current: state, act: "APPROVE", authority: "SELLER" }).outcome).toBe("REFUSED");
      expect(governedPromotionAuthorizationActs(state, "SELLER")).toEqual([]);
      expect(governedPromotionAuthorizationActs(state, "PROMOTER")).toEqual([]);
    }
  });

  it("the Seller never cancels and the Promoter never decides", () => {
    expect(governedPromotionAuthorizationActs("REQUESTED", "SELLER")).toEqual(["APPROVE", "DENY"]);
    expect(governedPromotionAuthorizationActs("REQUESTED", "PROMOTER")).toEqual(["CANCEL"]);
    expect(governedPromotionAuthorizationActs("APPROVED", "SELLER")).toEqual(["REVOKE"]);
    expect(governedPromotionAuthorizationActs("APPROVED", "PROMOTER")).toEqual(["CANCEL"]);
  });

  it("REQUEST is never an act on an existing cycle", () => {
    for (const state of PROMOTION_AUTHORIZATION_STATES) {
      expect(decidePromotionAuthorizationAct({ current: state, act: "REQUEST", authority: "PROMOTER" }).outcome).toBe("REFUSED");
    }
  });

  it("a request opens a new cycle after none or a terminal state, and refuses an open one explicitly", () => {
    expect(decidePromotionAuthorizationRequest(null)).toEqual({ outcome: "NEW_CYCLE" });
    for (const state of ["DENIED", "REVOKED", "CANCELLED"] as const) {
      expect(decidePromotionAuthorizationRequest(state)).toEqual({ outcome: "NEW_CYCLE" });
    }
    expect(decidePromotionAuthorizationRequest("REQUESTED")).toEqual({ outcome: "REFUSED", reason: "ALREADY_REQUESTED" });
    expect(decidePromotionAuthorizationRequest("APPROVED")).toEqual({ outcome: "REFUSED", reason: "ALREADY_APPROVED" });
  });

  it("only a current APPROVED cycle is approved", () => {
    expect(promotionAuthorizationIsApproved(null)).toBe(false);
    for (const state of PROMOTION_AUTHORIZATION_STATES) {
      expect(promotionAuthorizationIsApproved(state)).toBe(state === "APPROVED");
    }
  });

  it("the reference is the shared opaque application-reference shape", () => {
    expect(PromotionAuthorizationRef.safeParse(AUTH_REF).success).toBe(true);
    expect(PromotionAuthorizationRef.safeParse("mon:pauth:ABC").success).toBe(false);
    expect(PromotionAuthorizationRef.safeParse("short").success).toBe(false);
  });
});

describe("1.41 — participantMayRequestPromotionAuthorization", () => {
  const ok: PromotionAuthorizationRequestFacts = {
    account: { status: "ACTIVE", emailVerifiedAt: "2028-01-01T00:00:00.000Z", firstName: "Pat", lastName: "Promoter" },
    participant: { status: "DRAFT", suspended: false, promoterRoleStatus: "DRAFT" },
  };

  it("a DRAFT participant with a DRAFT PROMOTER role and private identity may request — no payment or commerce facts exist to ask", () => {
    expect(participantMayRequestPromotionAuthorization(ok)).toEqual({ eligible: true, refusals: [] });
  });

  it("the drafting PROMOTER role statuses qualify; SUSPENDED and REVOKED do not", () => {
    for (const status of ROLE_ASSIGNMENT_STATUSES) {
      const result = participantMayRequestPromotionAuthorization({
        ...ok,
        participant: { ...ok.participant!, promoterRoleStatus: status },
      });
      expect(result.eligible, status).toBe(["DRAFT", "PENDING_ACTIVATION", "ACTIVE"].includes(status));
      if (!result.eligible) expect(result.refusals).toEqual(["PROMOTER_ROLE_NOT_ELIGIBLE"]);
    }
  });

  it("every drafting participant status qualifies, including RESTRICTED; SUSPENDED and CLOSED do not", () => {
    for (const status of PARTICIPANT_STATUSES) {
      const result = participantMayRequestPromotionAuthorization({
        ...ok,
        participant: { ...ok.participant!, status },
      });
      expect(result.eligible, status).toBe(!["SUSPENDED", "CLOSED"].includes(status));
    }
  });

  it("a standing suspension refuses even while the stored status is a drafting one", () => {
    expect(
      participantMayRequestPromotionAuthorization({ ...ok, participant: { ...ok.participant!, suspended: true } }).refusals,
    ).toEqual(["PARTICIPANT_SUSPENDED"]);
  });

  it("private marketplace identity is required: verified email, declared first and last name, the participant", () => {
    expect(
      participantMayRequestPromotionAuthorization({
        account: { status: "DISABLED", emailVerifiedAt: null, firstName: " ", lastName: null },
        participant: null,
      }).refusals,
    ).toEqual(["ACCOUNT_DISABLED", "EMAIL_UNVERIFIED", "FIRST_NAME_MISSING", "LAST_NAME_MISSING", "PARTICIPANT_MISSING"]);
  });

  it("the PROMOTER role is required — a Seller-only participant is refused", () => {
    expect(
      participantMayRequestPromotionAuthorization({ ...ok, participant: { ...ok.participant!, promoterRoleStatus: null } }).refusals,
    ).toEqual(["PROMOTER_ROLE_NOT_HELD"]);
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

describe("1.41 — the browser submission half", () => {
  it("sends only the references in the path and an empty strict body for request and cancel", async () => {
    const request = fakeFetch(201, {});
    expect(await submitPromotionAuthorizationRequest({ productRef: ` ${REF} ` }, { fetchImpl: request.impl })).toEqual({
      outcome: "updated",
    });
    expect(request.calls[0]!.url).toBe(promotionAuthorizationRequestEndpoint(REF));
    expect(request.calls[0]!.url).toBe(`/api/products/${REF}/promotion-authorization/request`);
    expect(request.calls[0]!.init.body).toBe("{}");

    const cancel = fakeFetch(200, {});
    await submitPromotionAuthorizationCancel({ productRef: REF, authorizationRef: AUTH_REF }, { fetchImpl: cancel.impl });
    expect(cancel.calls[0]!.url).toBe(promotionAuthorizationCancelEndpoint(REF, AUTH_REF));
    expect(cancel.calls[0]!.init.body).toBe("{}");
  });

  it("a decision carries the one decision word", async () => {
    const decide = fakeFetch(200, {});
    await submitPromotionAuthorizationDecision(
      { productRef: REF, authorizationRef: AUTH_REF, decision: "REVOKE" },
      { fetchImpl: decide.impl },
    );
    expect(decide.calls[0]!.url).toBe(promotionAuthorizationDecisionEndpoint(REF, AUTH_REF));
    expect(JSON.parse(decide.calls[0]!.init.body as string)).toEqual({ decision: "REVOKE" });
  });

  it("maps refusals to one bounded sentence", async () => {
    expect(await submitPromotionAuthorizationRequest({ productRef: "  " })).toEqual({
      outcome: "failed",
      message: PROMOTION_PRODUCT_REQUIRED,
    });
    const cases: Array<[number, unknown, string]> = [
      [401, { error: "UNAUTHENTICATED" }, PROMOTION_SIGNED_OUT],
      [409, { error: "PROMOTION_AUTHORIZATION_ALREADY_REQUESTED" }, PROMOTION_ALREADY_REQUESTED],
      [409, { error: "PROMOTION_AUTHORIZATION_PROMOTER_NOT_ELIGIBLE" }, PROMOTION_PROMOTER_NOT_ELIGIBLE],
      [500, { error: "SOMETHING_ELSE" }, PROMOTION_FAILURE],
      [
        403,
        { error: "PROMOTION_AUTHORIZATION_REQUEST_NOT_PERMITTED", refusals: ["EMAIL_UNVERIFIED", "LAST_NAME_MISSING"] },
        formatPromotionRequestRefusals(["EMAIL_UNVERIFIED", "LAST_NAME_MISSING"]),
      ],
    ];
    for (const [status, body, message] of cases) {
      const f = fakeFetch(status, body);
      expect(await submitPromotionAuthorizationRequest({ productRef: REF }, { fetchImpl: f.impl })).toEqual({
        outcome: "failed",
        message,
      });
    }
  });

  it("words the Promoter's withdrawal for what it ends", () => {
    expect(promotionCancelLabel("REQUESTED")).toBe("Cancel request");
    expect(promotionCancelLabel("APPROVED")).toBe("Stop promoting");
    expect(formatPromotionRequestRefusals(["PARTICIPANT_MISSING", "PROMOTER_ROLE_NOT_HELD"])).toBe(
      "Before you can ask to promote products: start Promoter setup.",
    );
  });
});
