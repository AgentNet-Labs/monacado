/**
 * `POST /api/products/{productRef}/activate` — explicitly activate one of your
 * own Products (Phase 1.39, Contract §9.2).
 *
 * ```json
 * { "expectedRevision": "<the revision token of the Product as shown>" }
 * ```
 *
 * The shape follows the Phase 1.38 revision handler: origin, then session, then
 * the path selector, then a strict JSON body, then the domain through
 * `marketplace-application-service`, then a bounded error mapping.
 *
 * ## The reference is the only selector
 *
 * `productRef` in the path; the body carries only the revision token. A target
 * state, a participant, a Storefront, a Listing, or an Offer has nowhere to go —
 * the body is strict, so any of them is a 400. There is no way to name
 * `ACTIVE` or to skip a gate: activation readiness is derived from the
 * authoritative rows inside the activation transaction.
 *
 * ## Conditional on the Product the Seller saw
 *
 * If the Product was revised since the page was rendered, the answer is `409
 * PRODUCT_REVISION_CONFLICT` and nothing is written — a Seller never activates
 * a version they did not see.
 *
 * ## Refusals
 *
 * | Status | `error`                         | When                                          |
 * | ------ | ------------------------------- | --------------------------------------------- |
 * | 401    | `UNAUTHENTICATED`               | no session                                    |
 * | 403    | `CROSS_ORIGIN_REQUEST_REFUSED`  | a foreign origin                              |
 * | 400    | `INVALID_PRODUCT_ACTIVATION`    | malformed body or token                       |
 * | 404    | `PRODUCT_NOT_AVAILABLE`         | no such Product, or not yours — one answer    |
 * | 409    | `PRODUCT_REVISION_CONFLICT`     | stale token, or a concurrent activation won   |
 * | 409    | `PRODUCT_SUSPENDED`             | a Monacado Product suspension stands          |
 * | 409    | `PRODUCT_ALREADY_ACTIVE`        | the Product is already ACTIVE                 |
 * | 409    | `PRODUCT_INCOMPLETE`            | the current version fails completeness        |
 * | 403    | first readiness blocker         | e.g. `EMAIL_UNVERIFIED`, `PAYMENT_NOT_READY`  |
 * | 500    | `PRODUCT_UNAVAILABLE`           | anything unexpected                           |
 *
 * A readiness refusal also carries `blockers`: every blocker that applies, in
 * the evaluator's fixed order — closed classifications about the Seller's own
 * account and Product, raised only after authority is established.
 *
 * ## What the answer carries
 *
 * The stable reference, the lifecycle, and the (unchanged) revision token.
 * Activation writes no source version. No internal id, no activation id.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ProductRef } from "../../contracts/marketplace/listing-record";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { activateOwnProductAs } from "../marketplace/marketplace-application-service";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";
import {
  ConcurrencyConflictError,
  ProductActivationNotReadyError,
  ProductAlreadyActiveError,
  ProductNotAvailableError,
  ProductSuspendedError,
  ValidationError,
} from "./errors";

type Db = ReturnType<typeof getPrisma>;

export const PRODUCT_ACTIVATION_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_PRODUCT_ACTIVATION",
  notAvailable: "PRODUCT_NOT_AVAILABLE",
  conflict: "PRODUCT_REVISION_CONFLICT",
  suspended: "PRODUCT_SUSPENDED",
  alreadyActive: "PRODUCT_ALREADY_ACTIVE",
  unavailable: "PRODUCT_UNAVAILABLE",
} as const;

export const PRODUCT_ACTIVATION_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface ProductActivationRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface ProductActivationRouteRequest {
  /** The `{productRef}` path segment, exactly as routed. */
  productRef: string;
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface ProductActivationRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

const ActivateProductRequest = z.strictObject({
  /** The opaque revision token of the Product as shown. Format-checked by the domain. */
  expectedRevision: z.string().max(64),
});

function refuse(status: number, code: string, extra: Record<string, unknown> = {}): ProductActivationRouteResult {
  return { status, body: { error: code, ...extra }, headers: PRODUCT_ACTIVATION_ROUTE_HEADERS };
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
  const parsed = ActivateProductRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function handleActivateProductRequest(
  request: ProductActivationRouteRequest,
  deps: ProductActivationRouteDeps = {},
): Promise<ProductActivationRouteResult> {
  const codes = PRODUCT_ACTIVATION_ROUTE_ERROR_CODES;
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
    const activated = await activateOwnProductAs(
      resolution.actor,
      { productRef: productRef.data, expectedRevision: body.expectedRevision, now },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    return {
      status: 200,
      body: {
        productRef: activated.productRef,
        lifecycle: activated.lifecycle,
        revision: activated.revisionToken,
      },
      headers: PRODUCT_ACTIVATION_ROUTE_HEADERS,
    };
  } catch (error) {
    if (error instanceof ValidationError) return refuse(400, codes.invalidRequest);
    if (error instanceof ProductNotAvailableError) return refuse(404, codes.notAvailable);
    if (error instanceof ConcurrencyConflictError) return refuse(409, codes.conflict);
    if (error instanceof ProductSuspendedError) return refuse(409, codes.suspended);
    if (error instanceof ProductAlreadyActiveError) return refuse(409, codes.alreadyActive);
    if (error instanceof ProductActivationNotReadyError) {
      const first = error.blockers[0] ?? "PRODUCT_INCOMPLETE";
      return refuse(first === "PRODUCT_INCOMPLETE" ? 409 : 403, first, {
        blockers: [...error.blockers],
      });
    }
    return refuse(500, codes.unavailable);
  }
}
