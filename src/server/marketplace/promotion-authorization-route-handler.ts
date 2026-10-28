/**
 * Promotion Authorization routes (Phase 1.41, Contract §16.1):
 *
 *   POST /api/products/{productRef}/promotion-authorization/request
 *        `{}` — a Promoter requests authorization for that Product.
 *   POST /api/products/{productRef}/promotion-authorization/{authorizationRef}/decision
 *        `{ "decision": "APPROVE" | "DENY" | "REVOKE" }` — the Product's Seller.
 *   POST /api/products/{productRef}/promotion-authorization/{authorizationRef}/cancel
 *        `{}` — the cycle's own Promoter.
 *   POST /api/products/{productRef}/promotion-authorization/{authorizationRef}/offer-acceptance
 *        `{ offerRef, standing, promotion }` — the cycle's own Promoter accepts
 *        the exact Offer package it was shown (Phase 1.44).
 *
 * The shape follows the Phase 1.40 resale handler: origin, then session, then
 * the path selectors, then a strict JSON body, then the domain through
 * `marketplace-application-service`, then a bounded error mapping.
 *
 * ## The references are the only selectors
 *
 * `productRef` and `authorizationRef` in the path; the bodies carry at most the
 * Seller's decision. A participant, a Seller, a Promoter, a state, a lifecycle,
 * an Offer, a price, or a commission has nowhere to go — every body is strict.
 * The one exception is the Phase 1.44 acceptance, whose strict body RESTATES
 * the exact package the Promoter was shown — the Offer reference, the version
 * labels, the economics, and the window — so the server can refuse anything
 * that is not exactly the package in force. It still names no participant,
 * state, or authority, and nothing in it is taken as a fact.
 *
 * ## Refusals
 *
 * | Status | `error`                                            | When                                              |
 * | ------ | -------------------------------------------------- | ------------------------------------------------- |
 * | 401    | `UNAUTHENTICATED`                                  | no session                                        |
 * | 403    | `CROSS_ORIGIN_REQUEST_REFUSED`                     | a foreign origin                                  |
 * | 400    | `INVALID_PROMOTION_AUTHORIZATION_REQUEST`          | malformed body, extra field, or unknown decision  |
 * | 404    | `PRODUCT_NOT_AVAILABLE`                            | no such Product; for a decision, also not yours   |
 * | 404    | `PROMOTION_AUTHORIZATION_NOT_FOUND`                | no such authorization on this Product for you     |
 * | 403    | `PROMOTION_AUTHORIZATION_REQUEST_NOT_PERMITTED`    | the request gate; `refusals` names why            |
 * | 403    | `PROMOTION_AUTHORIZATION_SELF_PROMOTION`           | the requester is the Product's Seller             |
 * | 409    | `PROMOTION_AUTHORIZATION_ALREADY_REQUESTED`        | request while the current cycle is `REQUESTED`    |
 * | 409    | `PROMOTION_AUTHORIZATION_ALREADY_APPROVED`         | request while the current cycle is `APPROVED`     |
 * | 409    | `PROMOTION_AUTHORIZATION_TRANSITION_NOT_GOVERNED`  | e.g. approve twice, revoke a request, deny a cancel |
 * | 409    | `PROMOTION_AUTHORIZATION_SUPERSEDED`               | acting on a cycle a re-request replaced           |
 * | 409    | `PROMOTION_AUTHORIZATION_PROMOTER_NOT_ELIGIBLE`    | approval while the Promoter no longer qualifies   |
 * | 409    | `PROMOTION_AUTHORIZATION_CONFLICT`                 | a concurrent change won (not expected)            |
 * | 409    | `OFFER_ACCEPTANCE_AUTHORIZATION_NOT_APPROVED`      | acceptance on a cycle that is not `APPROVED`      |
 * | 409    | `OFFER_ACCEPTANCE_PRODUCT_NOT_ACTIVE`              | acceptance while the Product is not `ACTIVE`      |
 * | 409    | `OFFER_ACCEPTANCE_RESALE_NOT_OFFERED`              | acceptance while resale is `NOT_OFFERED` / `WITHDRAWN` |
 * | 409    | `OFFER_ACCEPTANCE_OFFER_NOT_ACCEPTING`             | no such current Offer, or it is not `ACTIVE`      |
 * | 409    | `OFFER_ACCEPTANCE_STANDING_VERSION_STALE`          | the standing version named is no longer current   |
 * | 409    | `OFFER_ACCEPTANCE_PROMOTION_CHANGED`               | the promotion named (or its absence) is not current |
 * | 409    | `OFFER_ACCEPTANCE_TERMS_MISMATCH`                  | restated economics / window differ from the versions |
 * | 500    | `PROMOTION_AUTHORIZATION_UNAVAILABLE`              | anything unexpected                               |
 *
 * No Promotion Authorization act is idempotent: a repeat is an explicit 409 and
 * writes nothing. Acceptance is: the exact package already accepted in this
 * cycle answers 200 with its original `acceptedAt`; a first acceptance is 201.
 *
 * ## What the answer carries
 *
 * `{ productRef, authorizationRef, state }` — references only, no internal id,
 * no act id, no participant, and no Product fact. An acceptance answers
 * `{ productRef, authorizationRef, offerRef, standingVersion, promotionVersion,
 * acceptedAt }` — no acceptance id and no account.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ProductRef } from "../../contracts/marketplace/listing-record";
import { PromotionAuthorizationRef } from "../../contracts/marketplace/promotion-authorization";
import { resolveActingAccount, type ActingAccount } from "../account/acting-participant-boundary";
import { OfferPackageAcceptanceInput } from "../../contracts/marketplace/promotion-offer-acceptance";
import {
  acceptOfferPackageForOwnAuthorizationAs,
  cancelOwnPromotionAuthorizationAs,
  decideOwnProductPromotionAuthorizationAs,
  requestPromotionAuthorizationForProductAs,
} from "./marketplace-application-service";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";
import { ProductNotAvailableError, ValidationError } from "../product/errors";
import {
  PromotionAuthorizationAlreadyOpenError,
  PromotionAuthorizationConflictError,
  PromotionAuthorizationNotFoundError,
  PromotionAuthorizationPromoterNotEligibleError,
  PromotionAuthorizationRequestNotPermittedError,
  PromotionAuthorizationSelfPromotionError,
  PromotionAuthorizationSupersededError,
  PromotionAuthorizationTransitionNotGovernedError,
  PromotionOfferAcceptanceRefusedError,
  type OfferAcceptanceRefusal,
} from "./promotion-authorization-errors";
import type { PromotionAuthorizationResult } from "./promotion-authorization-service";

type Db = ReturnType<typeof getPrisma>;

export const PROMOTION_AUTHORIZATION_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_PROMOTION_AUTHORIZATION_REQUEST",
  productNotAvailable: "PRODUCT_NOT_AVAILABLE",
  notFound: "PROMOTION_AUTHORIZATION_NOT_FOUND",
  requestNotPermitted: "PROMOTION_AUTHORIZATION_REQUEST_NOT_PERMITTED",
  selfPromotion: "PROMOTION_AUTHORIZATION_SELF_PROMOTION",
  alreadyRequested: "PROMOTION_AUTHORIZATION_ALREADY_REQUESTED",
  alreadyApproved: "PROMOTION_AUTHORIZATION_ALREADY_APPROVED",
  notGoverned: "PROMOTION_AUTHORIZATION_TRANSITION_NOT_GOVERNED",
  superseded: "PROMOTION_AUTHORIZATION_SUPERSEDED",
  promoterNotEligible: "PROMOTION_AUTHORIZATION_PROMOTER_NOT_ELIGIBLE",
  conflict: "PROMOTION_AUTHORIZATION_CONFLICT",
  unavailable: "PROMOTION_AUTHORIZATION_UNAVAILABLE",
} as const;

/** Phase 1.44 — each acceptance refusal's route code. */
export const OFFER_ACCEPTANCE_ROUTE_ERROR_CODES: Readonly<Record<OfferAcceptanceRefusal, string>> = {
  AUTHORIZATION_NOT_APPROVED: "OFFER_ACCEPTANCE_AUTHORIZATION_NOT_APPROVED",
  PRODUCT_NOT_ACTIVE: "OFFER_ACCEPTANCE_PRODUCT_NOT_ACTIVE",
  RESALE_NOT_OFFERED: "OFFER_ACCEPTANCE_RESALE_NOT_OFFERED",
  OFFER_NOT_ACCEPTING: "OFFER_ACCEPTANCE_OFFER_NOT_ACCEPTING",
  STANDING_VERSION_STALE: "OFFER_ACCEPTANCE_STANDING_VERSION_STALE",
  PROMOTION_CHANGED: "OFFER_ACCEPTANCE_PROMOTION_CHANGED",
  TERMS_MISMATCH: "OFFER_ACCEPTANCE_TERMS_MISMATCH",
};

export const PROMOTION_AUTHORIZATION_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface PromotionAuthorizationRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

interface RouteRequestBase {
  /** The `{productRef}` path segment, exactly as routed. */
  productRef: string;
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export type PromotionAuthorizationRequestRouteRequest = RouteRequestBase;

export interface PromotionAuthorizationCycleRouteRequest extends RouteRequestBase {
  /** The `{authorizationRef}` path segment, exactly as routed. */
  authorizationRef: string;
}

export interface PromotionAuthorizationRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

/** Strict and empty: nothing a caller could state belongs in a request or a cancellation. */
const EmptyBody = z.strictObject({});
const DecisionBody = z.strictObject({
  /** Vocabulary-checked by the domain. */
  decision: z.string().max(16),
});

function refuse(status: number, code: string, extra: Record<string, unknown> = {}): PromotionAuthorizationRouteResult {
  return { status, body: { error: code, ...extra }, headers: PROMOTION_AUTHORIZATION_ROUTE_HEADERS };
}

/** A present origin must match; a missing one is permitted, as on the other routes. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

function parseBody<T extends z.ZodType>(schema: T, contentType: string | null, rawBody: string): z.infer<T> | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function mapError(error: unknown): PromotionAuthorizationRouteResult {
  const codes = PROMOTION_AUTHORIZATION_ROUTE_ERROR_CODES;
  if (error instanceof ValidationError) return refuse(400, codes.invalidRequest);
  if (error instanceof ProductNotAvailableError) return refuse(404, codes.productNotAvailable);
  if (error instanceof PromotionAuthorizationNotFoundError) return refuse(404, codes.notFound);
  if (error instanceof PromotionAuthorizationRequestNotPermittedError) {
    return refuse(403, codes.requestNotPermitted, { refusals: [...error.refusals] });
  }
  if (error instanceof PromotionAuthorizationSelfPromotionError) return refuse(403, codes.selfPromotion);
  if (error instanceof PromotionAuthorizationAlreadyOpenError) {
    return refuse(409, error.code === "PROMOTION_AUTHORIZATION_ALREADY_REQUESTED" ? codes.alreadyRequested : codes.alreadyApproved);
  }
  if (error instanceof PromotionAuthorizationTransitionNotGovernedError) return refuse(409, codes.notGoverned);
  if (error instanceof PromotionAuthorizationSupersededError) return refuse(409, codes.superseded);
  if (error instanceof PromotionAuthorizationPromoterNotEligibleError) return refuse(409, codes.promoterNotEligible);
  if (error instanceof PromotionAuthorizationConflictError) return refuse(409, codes.conflict);
  if (error instanceof PromotionOfferAcceptanceRefusedError) return refuse(409, OFFER_ACCEPTANCE_ROUTE_ERROR_CODES[error.reason]);
  return refuse(500, codes.unavailable);
}

function answer(status: number, result: PromotionAuthorizationResult): PromotionAuthorizationRouteResult {
  return {
    status,
    body: { productRef: result.productRef, authorizationRef: result.authorizationRef, state: result.state },
    headers: PROMOTION_AUTHORIZATION_ROUTE_HEADERS,
  };
}

/**
 * The shared preamble: origin, session, path selectors, body. Returns either a
 * refusal or everything the domain call needs.
 */
async function prepare<T extends z.ZodType>(
  request: RouteRequestBase & { authorizationRef?: string },
  schema: T,
  deps: PromotionAuthorizationRouteDeps,
): Promise<
  | { refusal: PromotionAuthorizationRouteResult }
  | { actor: ActingAccount; productRef: string; authorizationRef: string | undefined; body: z.infer<T>; now: string }
> {
  const codes = PROMOTION_AUTHORIZATION_ROUTE_ERROR_CODES;
  const appOrigin = deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN;
  if (!originAcceptable(request.originHeader, appOrigin)) return { refusal: refuse(403, codes.crossOrigin) };

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const resolution = await resolveActingAccount(
    { cookieHeader: request.cookieHeader, now },
    { ...(deps.db !== undefined ? { db: deps.db as Db | Prisma.TransactionClient } : {}) },
  );
  if (resolution.outcome !== "AUTHENTICATED") return { refusal: refuse(401, codes.unauthenticated) };

  const productRef = ProductRef.safeParse(request.productRef);
  if (!productRef.success) return { refusal: refuse(404, codes.productNotAvailable) };
  let authorizationRef: string | undefined;
  if (request.authorizationRef !== undefined) {
    const parsed = PromotionAuthorizationRef.safeParse(request.authorizationRef);
    if (!parsed.success) return { refusal: refuse(404, codes.notFound) };
    authorizationRef = parsed.data;
  }

  const body = parseBody(schema, request.contentType, request.rawBody);
  if (body === null) return { refusal: refuse(400, codes.invalidRequest) };
  return { actor: resolution.actor, productRef: productRef.data, authorizationRef, body, now };
}

const dbDeps = (deps: PromotionAuthorizationRouteDeps) => (deps.db !== undefined ? { db: deps.db } : {});

/** `POST …/promotion-authorization/request` — 201 with the new cycle's reference. */
export async function handleRequestPromotionAuthorizationRequest(
  request: PromotionAuthorizationRequestRouteRequest,
  deps: PromotionAuthorizationRouteDeps = {},
): Promise<PromotionAuthorizationRouteResult> {
  const prepared = await prepare(request, EmptyBody, deps);
  if ("refusal" in prepared) return prepared.refusal;
  try {
    const result = await requestPromotionAuthorizationForProductAs(
      prepared.actor,
      { productRef: prepared.productRef, now: prepared.now },
      dbDeps(deps),
    );
    return answer(201, result);
  } catch (error) {
    return mapError(error);
  }
}

/** `POST …/promotion-authorization/{authorizationRef}/decision` — the Seller's act. */
export async function handleDecidePromotionAuthorizationRequest(
  request: PromotionAuthorizationCycleRouteRequest,
  deps: PromotionAuthorizationRouteDeps = {},
): Promise<PromotionAuthorizationRouteResult> {
  const prepared = await prepare(request, DecisionBody, deps);
  if ("refusal" in prepared) return prepared.refusal;
  try {
    const result = await decideOwnProductPromotionAuthorizationAs(
      prepared.actor,
      {
        productRef: prepared.productRef,
        authorizationRef: prepared.authorizationRef!,
        decision: prepared.body.decision,
        now: prepared.now,
      },
      dbDeps(deps),
    );
    return answer(200, result);
  } catch (error) {
    return mapError(error);
  }
}

/** `POST …/promotion-authorization/{authorizationRef}/cancel` — the Promoter's own withdrawal. */
export async function handleCancelPromotionAuthorizationRequest(
  request: PromotionAuthorizationCycleRouteRequest,
  deps: PromotionAuthorizationRouteDeps = {},
): Promise<PromotionAuthorizationRouteResult> {
  const prepared = await prepare(request, EmptyBody, deps);
  if ("refusal" in prepared) return prepared.refusal;
  try {
    const result = await cancelOwnPromotionAuthorizationAs(
      prepared.actor,
      { productRef: prepared.productRef, authorizationRef: prepared.authorizationRef!, now: prepared.now },
      dbDeps(deps),
    );
    return answer(200, result);
  } catch (error) {
    return mapError(error);
  }
}

/**
 * `POST …/promotion-authorization/{authorizationRef}/offer-acceptance` — the
 * cycle's own Promoter accepts the exact Offer package (Phase 1.44). 201 for a
 * first acceptance; 200, with the original `acceptedAt`, for the same package
 * again.
 */
export async function handleAcceptOfferPackageRequest(
  request: PromotionAuthorizationCycleRouteRequest,
  deps: PromotionAuthorizationRouteDeps = {},
): Promise<PromotionAuthorizationRouteResult> {
  const prepared = await prepare(request, OfferPackageAcceptanceInput, deps);
  if ("refusal" in prepared) return prepared.refusal;
  try {
    const result = await acceptOfferPackageForOwnAuthorizationAs(
      prepared.actor,
      {
        productRef: prepared.productRef,
        authorizationRef: prepared.authorizationRef!,
        input: prepared.body,
        now: prepared.now,
      },
      dbDeps(deps),
    );
    return {
      status: result.created ? 201 : 200,
      body: {
        productRef: result.productRef,
        authorizationRef: result.authorizationRef,
        offerRef: result.offerRef,
        standingVersion: result.standingVersion,
        promotionVersion: result.promotionVersion,
        acceptedAt: result.acceptedAt,
      },
      headers: PROMOTION_AUTHORIZATION_ROUTE_HEADERS,
    };
  } catch (error) {
    return mapError(error);
  }
}
