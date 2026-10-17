/**
 * `POST /api/products/{productRef}/resale-availability` — set the Seller-controlled
 * resale availability of one of your own Products (Phase 1.40, Contract §9.3).
 *
 * ```json
 * { "resaleAvailability": "AVAILABLE" | "PAUSED" | "WITHDRAWN" }
 * ```
 *
 * The shape follows the Phase 1.39 activation handler: origin, then session,
 * then the path selector, then a strict JSON body, then the domain through
 * `marketplace-application-service`, then a bounded error mapping.
 *
 * ## The reference is the only selector, the target the only input
 *
 * `productRef` in the path; the body carries only the target state. A
 * participant, a lifecycle, a Storefront, a Listing, or an Offer has nowhere to
 * go — the body is strict. No revision token: resale availability is not a fact
 * of any source version, and the decision is made against the current state
 * inside the transaction, so a repeated or racing request is a no-op or is
 * decided against the newer state rather than overwriting it blindly.
 *
 * ## Refusals
 *
 * | Status | `error`                                        | When                                         |
 * | ------ | ---------------------------------------------- | -------------------------------------------- |
 * | 401    | `UNAUTHENTICATED`                              | no session                                   |
 * | 403    | `CROSS_ORIGIN_REQUEST_REFUSED`                 | a foreign origin                             |
 * | 400    | `INVALID_RESALE_AVAILABILITY_REQUEST`          | malformed body, or a state outside the vocabulary |
 * | 404    | `PRODUCT_NOT_AVAILABLE`                        | no such Product, or not yours — one answer   |
 * | 409    | `RESALE_AVAILABILITY_TRANSITION_NOT_GOVERNED`  | e.g. anything out of `WITHDRAWN`             |
 * | 409    | `RESALE_AVAILABILITY_REQUIRES_ACTIVE_PRODUCT`  | `AVAILABLE` while the Product is not ACTIVE  |
 * | 409    | `RESALE_AVAILABILITY_CONFLICT`                 | a concurrent change won (not expected)       |
 * | 500    | `PRODUCT_UNAVAILABLE`                          | anything unexpected                          |
 *
 * ## What the answer carries
 *
 * The stable reference, the resale availability, whether anything changed, the
 * effective lifecycle, and whether the two together are resale-effective. No
 * internal id and no act id.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ProductRef } from "../../contracts/marketplace/listing-record";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { setOwnProductResaleAvailabilityAs } from "../marketplace/marketplace-application-service";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";
import {
  ConcurrencyConflictError,
  ProductNotAvailableError,
  ProductResaleAvailabilityRequiresActiveError,
  ProductResaleAvailabilityTransitionNotGovernedError,
  ValidationError,
} from "./errors";

type Db = ReturnType<typeof getPrisma>;

export const PRODUCT_RESALE_AVAILABILITY_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_RESALE_AVAILABILITY_REQUEST",
  notAvailable: "PRODUCT_NOT_AVAILABLE",
  notGoverned: "RESALE_AVAILABILITY_TRANSITION_NOT_GOVERNED",
  requiresActive: "RESALE_AVAILABILITY_REQUIRES_ACTIVE_PRODUCT",
  conflict: "RESALE_AVAILABILITY_CONFLICT",
  unavailable: "PRODUCT_UNAVAILABLE",
} as const;

export const PRODUCT_RESALE_AVAILABILITY_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface ProductResaleAvailabilityRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface ProductResaleAvailabilityRouteRequest {
  /** The `{productRef}` path segment, exactly as routed. */
  productRef: string;
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface ProductResaleAvailabilityRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

const SetResaleAvailabilityRequest = z.strictObject({
  /** The target state. Vocabulary-checked by the domain. */
  resaleAvailability: z.string().max(32),
});

function refuse(status: number, code: string): ProductResaleAvailabilityRouteResult {
  return { status, body: { error: code }, headers: PRODUCT_RESALE_AVAILABILITY_ROUTE_HEADERS };
}

/** A present origin must match; a missing one is permitted, as on the other routes. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

function parseBody(contentType: string | null, rawBody: string) {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = SetResaleAvailabilityRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function handleSetProductResaleAvailabilityRequest(
  request: ProductResaleAvailabilityRouteRequest,
  deps: ProductResaleAvailabilityRouteDeps = {},
): Promise<ProductResaleAvailabilityRouteResult> {
  const codes = PRODUCT_RESALE_AVAILABILITY_ROUTE_ERROR_CODES;
  const appOrigin = deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN;
  if (!originAcceptable(request.originHeader, appOrigin)) {
    return refuse(403, codes.crossOrigin);
  }

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const resolution = await resolveActingAccount(
    { cookieHeader: request.cookieHeader, now },
    { ...(deps.db !== undefined ? { db: deps.db as Db | Prisma.TransactionClient } : {}) },
  );
  if (resolution.outcome !== "AUTHENTICATED") return refuse(401, codes.unauthenticated);

  const productRef = ProductRef.safeParse(request.productRef);
  if (!productRef.success) return refuse(404, codes.notAvailable);

  const body = parseBody(request.contentType, request.rawBody);
  if (body === null) return refuse(400, codes.invalidRequest);

  try {
    const result = await setOwnProductResaleAvailabilityAs(
      resolution.actor,
      { productRef: productRef.data, resaleAvailability: body.resaleAvailability, now },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    return {
      status: 200,
      body: {
        productRef: result.productRef,
        resaleAvailability: result.resaleAvailability,
        changed: result.changed,
        lifecycle: result.lifecycle,
        resaleEffective: result.resaleEffective,
      },
      headers: PRODUCT_RESALE_AVAILABILITY_ROUTE_HEADERS,
    };
  } catch (error) {
    if (error instanceof ValidationError) return refuse(400, codes.invalidRequest);
    if (error instanceof ProductNotAvailableError) return refuse(404, codes.notAvailable);
    if (error instanceof ProductResaleAvailabilityTransitionNotGovernedError) return refuse(409, codes.notGoverned);
    if (error instanceof ProductResaleAvailabilityRequiresActiveError) return refuse(409, codes.requiresActive);
    if (error instanceof ConcurrencyConflictError) return refuse(409, codes.conflict);
    return refuse(500, codes.unavailable);
  }
}
