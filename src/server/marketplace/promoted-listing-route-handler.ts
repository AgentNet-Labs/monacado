/**
 * Promoted Listing routes (Phase 1.45, Contract §13–§16.3):
 *
 *   POST /api/products/{productRef}/promoted-listings
 *        `{ storefrontHandle, retail?: { amount, currency } | null }` — an
 *        APPROVED Promoter places the Product in a Storefront it controls, as
 *        a DRAFT, priced or not.
 *   POST /api/promoted-listings/{listingRef}/price
 *        `{ amount, currency }` — set or change the price (DRAFT or ACTIVE).
 *   POST /api/promoted-listings/{listingRef}/activate
 *        `{ expectedVersion }` — the full activation gate, at the version shown.
 *   POST /api/promoted-listings/{listingRef}/withdraw
 *        `{}` — stand down. Never gated.
 *
 * The shape follows the Phase 1.41/1.44 handlers: origin, then session, then
 * the path selector, then a strict JSON body, then the domain through
 * `marketplace-application-service`, then a bounded error mapping.
 *
 * ## What a body can say
 *
 * References and a price, nothing else. An Offer, a version of anybody's terms,
 * an authorization, an acceptance, a commission, a wholesale amount, a policy,
 * a participant, and a lifecycle have nowhere to go: every body is strict.
 * Which Seller terms govern is derived server-side at the instant of the act.
 *
 * ## Refusals
 *
 * | Status | `error`                                  | When                                                   |
 * | ------ | ---------------------------------------- | ------------------------------------------------------ |
 * | 401    | `UNAUTHENTICATED`                        | no session                                             |
 * | 403    | `CROSS_ORIGIN_REQUEST_REFUSED`           | a foreign origin                                       |
 * | 400    | `INVALID_PROMOTED_LISTING_REQUEST`       | malformed body or an extra field                       |
 * | 400    | `INVALID_RETAIL_AMOUNT`                  | the amount or currency is not acceptable               |
 * | 404    | `PRODUCT_NOT_AVAILABLE`                  | no such Product                                        |
 * | 404    | `STOREFRONT_NOT_AVAILABLE`               | no such Storefront                                     |
 * | 404    | `LISTING_NOT_AVAILABLE`                  | no such Listing, or not yours — one answer             |
 * | 403    | `PROMOTED_LISTING_NOT_ELIGIBLE`          | no participant / PROMOTER role / Storefront authority, or standing |
 * | 409    | `PROMOTED_LISTING_REFUSED`               | `reason` names it (authorization, self-promotion, …)   |
 * | 409    | `PROMOTED_LISTING_ECONOMICS_REFUSED`     | `reason` names the economics blocker                   |
 * | 409    | `PROMOTED_LISTING_NOT_READY`             | activation; `blockers` lists every one, in gate order  |
 * | 409    | `LISTING_ALREADY_PLACED`                 | a current Listing already places it there              |
 * | 409    | `LISTING_PRICE_UNCHANGED`                | the same price again                                   |
 * | 409    | `LISTING_VERSION_STALE`                  | the Listing changed since it was shown                 |
 * | 409    | `LISTING_NOT_WITHDRAWABLE`               | withdraw of a terminal Listing                         |
 * | 500    | `PROMOTED_LISTING_UNAVAILABLE`           | anything unexpected                                    |
 *
 * Every reason and blocker is a closed code; none carries a value. In
 * particular no refusal names the Seller, the wholesale price, the commission,
 * or the Seller's proceeds.
 *
 * ## What the answer carries
 *
 * `{ listingRef, lifecycle, version, retail }` — references and the Promoter's
 * own price only.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ListingRef, ProductRef } from "../../contracts/marketplace/listing-record";
import { parseRetailAmount } from "../../contracts/marketplace/retail-amount";
import { resolveActingAccount, type ActingAccount } from "../account/acting-participant-boundary";
import {
  activateOwnPromotedListingAs,
  createOwnPromotedListingDraftAs,
  setOwnPromotedListingPriceAs,
  withdrawOwnPromotedListingAs,
} from "./marketplace-application-service";
import {
  InvalidListingInputError,
  ListingAlreadyExistsError,
  ListingEconomicsRefusedError,
  ListingNotAuthorizedError,
  ListingNotFoundError,
  ListingNotWithdrawableError,
  ListingPriceUnchangedError,
  ListingProductNotFoundError,
  ListingStorefrontNotFoundError,
  ListingVersionStaleError,
  NoMaterialListingChangeError,
  PromotedListingNotReadyError,
  PromotedListingRefusedError,
} from "./listing-errors";
import type { ListingSnapshot } from "./listing-service";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "./participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const PROMOTED_LISTING_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_PROMOTED_LISTING_REQUEST",
  invalidAmount: "INVALID_RETAIL_AMOUNT",
  productNotAvailable: "PRODUCT_NOT_AVAILABLE",
  storefrontNotAvailable: "STOREFRONT_NOT_AVAILABLE",
  listingNotAvailable: "LISTING_NOT_AVAILABLE",
  notEligible: "PROMOTED_LISTING_NOT_ELIGIBLE",
  refused: "PROMOTED_LISTING_REFUSED",
  economicsRefused: "PROMOTED_LISTING_ECONOMICS_REFUSED",
  notReady: "PROMOTED_LISTING_NOT_READY",
  alreadyPlaced: "LISTING_ALREADY_PLACED",
  priceUnchanged: "LISTING_PRICE_UNCHANGED",
  versionStale: "LISTING_VERSION_STALE",
  notWithdrawable: "LISTING_NOT_WITHDRAWABLE",
  unavailable: "PROMOTED_LISTING_UNAVAILABLE",
} as const;

export const PROMOTED_LISTING_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface PromotedListingRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

interface RouteRequestBase {
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface CreatePromotedListingRouteRequest extends RouteRequestBase {
  /** The `{productRef}` path segment, exactly as routed. */
  productRef: string;
}

export interface PromotedListingRouteRequest extends RouteRequestBase {
  /** The `{listingRef}` path segment, exactly as routed. */
  listingRef: string;
}

export interface PromotedListingRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

/** Strings on purpose, as on the Phase 1.36 price route: a JSON number is already a float. */
const AmountBody = z.strictObject({
  amount: z.string().min(1).max(64),
  currency: z.string().min(1).max(8),
});
const CreateBody = z.strictObject({
  storefrontHandle: z.string().min(1).max(64),
  retail: AmountBody.nullable().optional(),
});
const ActivateBody = z.strictObject({ expectedVersion: z.string().min(1).max(16) });
const EmptyBody = z.strictObject({});

function refuse(status: number, code: string, extra: Record<string, unknown> = {}): PromotedListingRouteResult {
  return { status, body: { error: code, ...extra }, headers: PROMOTED_LISTING_ROUTE_HEADERS };
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

function mapError(error: unknown): PromotedListingRouteResult {
  const codes = PROMOTED_LISTING_ROUTE_ERROR_CODES;
  if (error instanceof ListingProductNotFoundError) return refuse(404, codes.productNotAvailable);
  if (error instanceof ListingStorefrontNotFoundError) return refuse(404, codes.storefrontNotAvailable);
  /* No such Listing and somebody else's are one answer; a malformed reference
     that slipped past the path check names nothing either. */
  if (error instanceof ListingNotFoundError || error instanceof InvalidListingInputError) {
    return refuse(404, codes.listingNotAvailable);
  }
  if (
    error instanceof ListingNotAuthorizedError ||
    error instanceof ParticipantActionNotPermittedError ||
    error instanceof ParticipantLifecycleTerminatedError
  ) {
    return refuse(403, codes.notEligible);
  }
  if (error instanceof PromotedListingRefusedError) return refuse(409, codes.refused, { reason: error.reason });
  if (error instanceof ListingEconomicsRefusedError) {
    return refuse(409, codes.economicsRefused, { reason: error.economicsCode });
  }
  if (error instanceof PromotedListingNotReadyError) return refuse(409, codes.notReady, { blockers: [...error.blockers] });
  if (error instanceof ListingAlreadyExistsError) return refuse(409, codes.alreadyPlaced);
  if (error instanceof ListingPriceUnchangedError || error instanceof NoMaterialListingChangeError) {
    return refuse(409, codes.priceUnchanged);
  }
  if (error instanceof ListingVersionStaleError) return refuse(409, codes.versionStale);
  if (error instanceof ListingNotWithdrawableError) return refuse(409, codes.notWithdrawable);
  return refuse(500, codes.unavailable);
}

function answer(status: number, snapshot: ListingSnapshot): PromotedListingRouteResult {
  const { currentVersion, listingRef } = snapshot;
  const placement = currentVersion.placement;
  const retail = "retail" in placement ? placement.retail : null;
  return {
    status,
    body: {
      listingRef,
      lifecycle: currentVersion.lifecycle,
      version: currentVersion.sourceRecordVersion,
      retail: retail === null ? null : { amountMinorUnits: retail.retailPriceMinorUnits, currency: retail.retailPriceCurrency },
    },
    headers: PROMOTED_LISTING_ROUTE_HEADERS,
  };
}

/** The shared preamble: origin, then session. */
async function authenticate(
  request: RouteRequestBase,
  deps: PromotedListingRouteDeps,
): Promise<{ refusal: PromotedListingRouteResult } | { actor: ActingAccount; now: string }> {
  const codes = PROMOTED_LISTING_ROUTE_ERROR_CODES;
  if (!originAcceptable(request.originHeader, deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN)) {
    return { refusal: refuse(403, codes.crossOrigin) };
  }
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const resolution = await resolveActingAccount(
    { cookieHeader: request.cookieHeader, now },
    { ...(deps.db !== undefined ? { db: deps.db as Db | Prisma.TransactionClient } : {}) },
  );
  if (resolution.outcome !== "AUTHENTICATED") return { refusal: refuse(401, codes.unauthenticated) };
  return { actor: resolution.actor, now };
}

const dbDeps = (deps: PromotedListingRouteDeps) => (deps.db !== undefined ? { db: deps.db } : {});

/** `POST /api/products/{productRef}/promoted-listings` — 201 with the new DRAFT. */
export async function handleCreatePromotedListingRequest(
  request: CreatePromotedListingRouteRequest,
  deps: PromotedListingRouteDeps = {},
): Promise<PromotedListingRouteResult> {
  const codes = PROMOTED_LISTING_ROUTE_ERROR_CODES;
  const auth = await authenticate(request, deps);
  if ("refusal" in auth) return auth.refusal;
  const productRef = ProductRef.safeParse(request.productRef);
  if (!productRef.success) return refuse(404, codes.productNotAvailable);
  const body = parseBody(CreateBody, request.contentType, request.rawBody);
  if (body === null) return refuse(400, codes.invalidRequest);
  let retail = null;
  if (body.retail != null) {
    const amount = parseRetailAmount({ amount: body.retail.amount, currency: body.retail.currency });
    if (!amount.ok) return refuse(400, codes.invalidAmount);
    retail = amount.retail;
  }
  try {
    const snapshot = await createOwnPromotedListingDraftAs(
      auth.actor,
      { productRef: productRef.data, storefrontHandle: body.storefrontHandle, retail, now: auth.now },
      dbDeps(deps),
    );
    return answer(201, snapshot);
  } catch (error) {
    /* A handle that could never be a handle names no Storefront. */
    if (error instanceof InvalidListingInputError && error.fields.includes("storefrontHandle")) {
      return refuse(404, codes.storefrontNotAvailable);
    }
    return mapError(error);
  }
}

/** Parse the `{listingRef}` path segment; a non-reference names nothing. */
function listingRefOf(request: PromotedListingRouteRequest): string | null {
  const parsed = ListingRef.safeParse(request.listingRef);
  return parsed.success ? parsed.data : null;
}

/** `POST /api/promoted-listings/{listingRef}/price` */
export async function handleSetPromotedListingPriceRequest(
  request: PromotedListingRouteRequest,
  deps: PromotedListingRouteDeps = {},
): Promise<PromotedListingRouteResult> {
  const codes = PROMOTED_LISTING_ROUTE_ERROR_CODES;
  const auth = await authenticate(request, deps);
  if ("refusal" in auth) return auth.refusal;
  const listingRef = listingRefOf(request);
  if (listingRef === null) return refuse(404, codes.listingNotAvailable);
  const body = parseBody(AmountBody, request.contentType, request.rawBody);
  if (body === null) return refuse(400, codes.invalidRequest);
  const amount = parseRetailAmount({ amount: body.amount, currency: body.currency });
  if (!amount.ok) return refuse(400, codes.invalidAmount);
  try {
    const snapshot = await setOwnPromotedListingPriceAs(
      auth.actor,
      { listingRef, retail: amount.retail, now: auth.now },
      dbDeps(deps),
    );
    return answer(200, snapshot);
  } catch (error) {
    return mapError(error);
  }
}

/** `POST /api/promoted-listings/{listingRef}/activate` */
export async function handleActivatePromotedListingRequest(
  request: PromotedListingRouteRequest,
  deps: PromotedListingRouteDeps = {},
): Promise<PromotedListingRouteResult> {
  const codes = PROMOTED_LISTING_ROUTE_ERROR_CODES;
  const auth = await authenticate(request, deps);
  if ("refusal" in auth) return auth.refusal;
  const listingRef = listingRefOf(request);
  if (listingRef === null) return refuse(404, codes.listingNotAvailable);
  const body = parseBody(ActivateBody, request.contentType, request.rawBody);
  if (body === null) return refuse(400, codes.invalidRequest);
  try {
    const snapshot = await activateOwnPromotedListingAs(
      auth.actor,
      { listingRef, expectedVersion: body.expectedVersion, now: auth.now },
      dbDeps(deps),
    );
    return answer(200, snapshot);
  } catch (error) {
    /* A version label that could never be one cannot be the version shown. */
    if (error instanceof InvalidListingInputError && error.fields.includes("expectedVersion")) {
      return refuse(409, codes.versionStale);
    }
    return mapError(error);
  }
}

/** `POST /api/promoted-listings/{listingRef}/withdraw` */
export async function handleWithdrawPromotedListingRequest(
  request: PromotedListingRouteRequest,
  deps: PromotedListingRouteDeps = {},
): Promise<PromotedListingRouteResult> {
  const codes = PROMOTED_LISTING_ROUTE_ERROR_CODES;
  const auth = await authenticate(request, deps);
  if ("refusal" in auth) return auth.refusal;
  const listingRef = listingRefOf(request);
  if (listingRef === null) return refuse(404, codes.listingNotAvailable);
  const body = parseBody(EmptyBody, request.contentType, request.rawBody);
  if (body === null) return refuse(400, codes.invalidRequest);
  try {
    const snapshot = await withdrawOwnPromotedListingAs(auth.actor, { listingRef, now: auth.now }, dbDeps(deps));
    return answer(200, snapshot);
  } catch (error) {
    return mapError(error);
  }
}
