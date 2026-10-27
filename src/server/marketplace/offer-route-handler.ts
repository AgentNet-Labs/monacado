/**
 * Offer Seller routes (Phase 1.42, Contract §12, §16, §19):
 *
 *   POST /api/products/{productRef}/offers                                  create a DRAFT Offer
 *   POST /api/products/{productRef}/offers/{offerRef}/revise                new standing terms
 *   POST /api/products/{productRef}/offers/{offerRef}/activate              DRAFT → ACTIVE
 *   POST /api/products/{productRef}/offers/{offerRef}/pause                 ACTIVE → PAUSED
 *   POST /api/products/{productRef}/offers/{offerRef}/resume                PAUSED → ACTIVE
 *   POST /api/products/{productRef}/offers/{offerRef}/withdraw              → WITHDRAWN (terminal)
 *   POST /api/products/{productRef}/offers/{offerRef}/promotions            schedule a promotion
 *   POST /api/products/{productRef}/offers/{offerRef}/promotions/replace    replace a future one
 *   POST /api/products/{productRef}/offers/{offerRef}/promotions/end        end the running one early
 *
 * The shape follows the Phase 1.41 handler: origin, then session, then the path
 * selectors, then a strict JSON body, then the domain through
 * `marketplace-application-service`, then a bounded error mapping. There is no
 * GET here: the Seller reads their Offer on `/account`, and nothing that reads
 * writes.
 *
 * ## The references are the only selectors
 *
 * `productRef` and `offerRef` in the path. Bodies are strict and carry only what
 * the Seller states: terms, a window, the version they were looking at, and
 * their confirmation of the exact economics shown. No participant, account,
 * internal id, lifecycle, version label to mint, or economics the server must
 * trust has anywhere to go.
 *
 * ## Refusals
 *
 * | Status | `error`                          | When                                                       |
 * | ------ | -------------------------------- | ---------------------------------------------------------- |
 * | 401    | `UNAUTHENTICATED`                | no session                                                 |
 * | 403    | `CROSS_ORIGIN_REQUEST_REFUSED`   | a foreign origin                                           |
 * | 400    | `INVALID_OFFER_REQUEST`          | malformed body, extra field, invalid terms or window       |
 * | 404    | `PRODUCT_NOT_AVAILABLE`          | no such Product, or (create) not your Product              |
 * | 404    | `OFFER_NOT_FOUND`                | no such Offer on this Product for you                      |
 * | 403    | `OFFER_NOT_PERMITTED`            | an authority gate; `reasons` names it                      |
 * | 409    | `OFFER_ALREADY_EXISTS`           | create while the Product has a non-terminal Offer          |
 * | 409    | `OFFER_VERSION_STALE`            | `expectedVersion` / `expectedPromotionVersion` is stale    |
 * | 409    | `OFFER_CONFIRMATION_STALE`       | confirmation missing / for another version / stale amounts; |
 * |        |                                  | `disclosure` is the exact version's economics to confirm    |
 * | 409    | `OFFER_TRANSITION_NOT_PERMITTED` | the lifecycle does not permit the act (incl. terminal)     |
 * | 409    | `OFFER_NOT_READY`                | activate / resume readiness; `blockers` names each         |
 * | 409    | `OFFER_NO_MATERIAL_CHANGE`       | a revision restating the standing terms                    |
 * | 409    | `OFFER_PROMOTION_PENDING`        | revise or schedule while a promotion is scheduled/running  |
 * | 409    | `OFFER_PROMOTION_NOT_REPLACEABLE`| replace once the promotion has begun                       |
 * | 409    | `OFFER_PROMOTION_NOT_RUNNING`    | end early a promotion that is not running                  |
 * | 409    | `OFFER_CONFLICT`                 | a concurrent change won                                    |
 * | 500    | `OFFER_UNAVAILABLE`              | anything unexpected                                        |
 *
 * ## What the answer carries
 *
 * `{ productRef, offerRef, state, standingVersion, promotionVersion }` —
 * references, the derived lifecycle, and version labels. No internal id, no
 * participant, no act id.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ProductRef } from "../../contracts/marketplace/listing-record";
import {
  OFFER_CONFIRMATION_REASON_CODES,
  OFFER_LIFECYCLE_REASON_CODES,
  OfferRef,
} from "../../contracts/marketplace/offer-source";
import { resolveActingAccount, type ActingAccount } from "../account/acting-participant-boundary";
import {
  activateOwnOfferAs,
  createOwnOfferAs,
  endOwnOfferPromotionAs,
  pauseOwnOfferAs,
  replaceOwnOfferPromotionAs,
  resumeOwnOfferAs,
  reviseOwnOfferTermsAs,
  scheduleOwnOfferPromotionAs,
  withdrawOwnOfferAs,
  type ApplicationCommandInput,
} from "./marketplace-application-service";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";
import { ProductNotAvailableError } from "../product/errors";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import {
  InvalidOfferInputError,
  NoMaterialOfferChangeError,
  OfferAlreadyExistsError,
  OfferConfirmationRequiredError,
  OfferConflictError,
  OfferNotAuthorizedError,
  OfferNotFoundError,
  OfferNotReadyError,
  OfferPromotionNotReplaceableError,
  OfferPromotionNotRunningError,
  OfferPromotionPendingError,
  OfferVersionStaleError,
} from "./offer-errors";
import type { OfferActResult, OfferServiceDeps } from "./offer-service";

type Db = ReturnType<typeof getPrisma>;

export const OFFER_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_OFFER_REQUEST",
  productNotAvailable: "PRODUCT_NOT_AVAILABLE",
  notFound: "OFFER_NOT_FOUND",
  notPermitted: "OFFER_NOT_PERMITTED",
  alreadyExists: "OFFER_ALREADY_EXISTS",
  versionStale: "OFFER_VERSION_STALE",
  confirmationStale: "OFFER_CONFIRMATION_STALE",
  transitionNotPermitted: "OFFER_TRANSITION_NOT_PERMITTED",
  notReady: "OFFER_NOT_READY",
  noMaterialChange: "OFFER_NO_MATERIAL_CHANGE",
  promotionPending: "OFFER_PROMOTION_PENDING",
  promotionNotReplaceable: "OFFER_PROMOTION_NOT_REPLACEABLE",
  promotionNotRunning: "OFFER_PROMOTION_NOT_RUNNING",
  conflict: "OFFER_CONFLICT",
  unavailable: "OFFER_UNAVAILABLE",
} as const;

export const OFFER_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface OfferRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface OfferRouteRequest {
  /** The `{productRef}` path segment, exactly as routed. */
  productRef: string;
  /** The `{offerRef}` path segment; absent only for create. */
  offerRef?: string;
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface OfferRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

// — Bodies: strict at the edge; the domain re-validates every value —

/** Shapes only; terms, windows, and versions are validated by the domain. */
const Json = z.unknown();
const Bodies = {
  create: z.strictObject({ terms: Json }),
  revise: z.strictObject({ expectedVersion: Json, terms: Json, confirmation: Json.optional() }),
  activate: z.strictObject({ confirmation: Json, effectiveUntil: Json.optional() }),
  standDown: z.strictObject({}),
  resume: z.strictObject({ expectedVersion: Json }),
  schedule: z.strictObject({
    expectedVersion: Json,
    wholesalePrice: Json,
    effectiveFrom: Json,
    effectiveUntil: Json,
    confirmation: Json.optional(),
  }),
  replace: z.strictObject({
    expectedVersion: Json,
    expectedPromotionVersion: Json,
    wholesalePrice: Json,
    effectiveFrom: Json,
    effectiveUntil: Json,
    confirmation: Json.optional(),
  }),
  end: z.strictObject({ expectedPromotionVersion: Json }),
} as const;

function refuse(status: number, code: string, extra: Record<string, unknown> = {}): OfferRouteResult {
  return { status, body: { error: code, ...extra }, headers: OFFER_ROUTE_HEADERS };
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

function mapError(error: unknown): OfferRouteResult {
  const codes = OFFER_ROUTE_ERROR_CODES;
  if (error instanceof InvalidOfferInputError) return refuse(400, codes.invalidRequest, { fields: [...error.fields] });
  if (error instanceof ProductNotAvailableError) return refuse(404, codes.productNotAvailable);
  if (error instanceof OfferNotFoundError) return refuse(404, codes.notFound);
  if (error instanceof OfferNotAuthorizedError) {
    const reasons = [...error.reasonCodes];
    if (reasons.every((r) => (OFFER_LIFECYCLE_REASON_CODES as readonly string[]).includes(r))) {
      return refuse(409, codes.transitionNotPermitted, { reasons });
    }
    if (reasons.every((r) => (OFFER_CONFIRMATION_REASON_CODES as readonly string[]).includes(r))) {
      /* The Seller's own economics for the exact version, so they can confirm it. */
      return refuse(409, codes.confirmationStale, {
        reasons,
        ...(error instanceof OfferConfirmationRequiredError ? { disclosure: { ...error.disclosure } } : {}),
      });
    }
    return refuse(403, codes.notPermitted, { reasons });
  }
  if (error instanceof ParticipantActionNotPermittedError) {
    return refuse(403, codes.notPermitted, { reasons: [error.denialCode] });
  }
  if (error instanceof OfferAlreadyExistsError) return refuse(409, codes.alreadyExists);
  if (error instanceof OfferVersionStaleError) return refuse(409, codes.versionStale);
  if (error instanceof OfferNotReadyError) return refuse(409, codes.notReady, { blockers: [...error.blockers] });
  if (error instanceof NoMaterialOfferChangeError) return refuse(409, codes.noMaterialChange);
  if (error instanceof OfferPromotionPendingError) return refuse(409, codes.promotionPending);
  if (error instanceof OfferPromotionNotReplaceableError) return refuse(409, codes.promotionNotReplaceable);
  if (error instanceof OfferPromotionNotRunningError) return refuse(409, codes.promotionNotRunning);
  if (error instanceof OfferConflictError) return refuse(409, codes.conflict);
  return refuse(500, codes.unavailable);
}

function answer(status: number, result: OfferActResult): OfferRouteResult {
  return {
    status,
    body: {
      productRef: result.productRef,
      offerRef: result.offerRef,
      state: result.state,
      standingVersion: result.standingVersion,
      promotionVersion: result.promotionVersion,
    },
    headers: OFFER_ROUTE_HEADERS,
  };
}

type ApplicationOfferAct = (
  actor: ActingAccount,
  input: ApplicationCommandInput,
  deps?: OfferServiceDeps,
) => Promise<OfferActResult>;

/** The shared pipeline: origin, session, selectors, body, domain, mapping. */
async function handle(
  request: OfferRouteRequest,
  deps: OfferRouteDeps,
  options: { schema: z.ZodType; act: ApplicationOfferAct; requiresOfferRef: boolean; successStatus: number },
): Promise<OfferRouteResult> {
  const codes = OFFER_ROUTE_ERROR_CODES;
  const appOrigin = deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN;
  if (!originAcceptable(request.originHeader, appOrigin)) return refuse(403, codes.crossOrigin);

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const resolution = await resolveActingAccount(
    { cookieHeader: request.cookieHeader, now },
    { ...(deps.db !== undefined ? { db: deps.db as Db | Prisma.TransactionClient } : {}) },
  );
  if (resolution.outcome !== "AUTHENTICATED") return refuse(401, codes.unauthenticated);

  const productRef = ProductRef.safeParse(request.productRef);
  if (!productRef.success) return refuse(404, codes.productNotAvailable);
  const selectors: Record<string, string> = { productRef: productRef.data };
  if (options.requiresOfferRef) {
    const offerRef = OfferRef.safeParse(request.offerRef);
    if (!offerRef.success) return refuse(404, codes.notFound);
    selectors.offerRef = offerRef.data;
  }

  const body = parseBody(options.schema, request.contentType, request.rawBody);
  if (body === null || typeof body !== "object") return refuse(400, codes.invalidRequest);

  try {
    const result = await options.act(
      resolution.actor,
      { ...(body as Record<string, unknown>), ...selectors, now },
      deps.db !== undefined ? { db: deps.db } : {},
    );
    return answer(options.successStatus, result);
  } catch (error) {
    return mapError(error);
  }
}

const route =
  (schema: z.ZodType, act: ApplicationOfferAct, requiresOfferRef = true, successStatus = 200) =>
  (request: OfferRouteRequest, deps: OfferRouteDeps = {}): Promise<OfferRouteResult> =>
    handle(request, deps, { schema, act, requiresOfferRef, successStatus });

export const handleCreateOfferRequest = route(Bodies.create, createOwnOfferAs, false, 201);
export const handleReviseOfferRequest = route(Bodies.revise, reviseOwnOfferTermsAs);
export const handleActivateOfferRequest = route(Bodies.activate, activateOwnOfferAs);
export const handlePauseOfferRequest = route(Bodies.standDown, pauseOwnOfferAs);
export const handleResumeOfferRequest = route(Bodies.resume, resumeOwnOfferAs);
export const handleWithdrawOfferRequest = route(Bodies.standDown, withdrawOwnOfferAs);
export const handleSchedulePromotionRequest = route(Bodies.schedule, scheduleOwnOfferPromotionAs, true, 201);
export const handleReplacePromotionRequest = route(Bodies.replace, replaceOwnOfferPromotionAs, true, 201);
export const handleEndPromotionRequest = route(Bodies.end, endOwnOfferPromotionAs);
