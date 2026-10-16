/**
 * `POST /api/internal/products/{productRef}/tax-classification` — a Monacado
 * operator assigns or changes one Product's tax classification (Phase 1.39).
 *
 * ```json
 * { "taxClassification": "PHYSICAL_GOOD" }
 * ```
 *
 * A STAFF route. Authenticated by the ordinary session cookie, authorised by an
 * explicit active `product:tax-classify` entitlement — never by a marketplace
 * role, Product authority, or ownership. Nothing in the Seller UI calls it.
 * Shaped like the activation handler: origin, session, path selector, strict
 * body, domain, bounded error mapping.
 *
 * ## The body carries only the classification
 *
 * Strict: a delivery mode, a version, a participant, a lifecycle, or an
 * internal id has nowhere to go and is a 400. There is no way to clear a
 * classification and no "unknown" member to send.
 *
 * ## Refusals
 *
 * | Status | `error`                                    | When                                         |
 * | ------ | ------------------------------------------ | -------------------------------------------- |
 * | 401    | `UNAUTHENTICATED`                          | no session                                   |
 * | 403    | `CROSS_ORIGIN_REQUEST_REFUSED`             | a foreign origin                             |
 * | 400    | `INVALID_TAX_CLASSIFICATION`               | malformed body, or not a governed member     |
 * | 403    | `TAX_CLASSIFICATION_NOT_AUTHORIZED`        | no `product:tax-classify` grant — asked first |
 * | 404    | `PRODUCT_NOT_AVAILABLE`                    | no such Product                              |
 * | 403    | `TAX_CLASSIFICATION_SELF_ACTION`           | the operator's own participant authors it    |
 * | 409    | `TAX_CLASSIFICATION_CONTRADICTS_DELIVERY`  | `PHYSICAL_GOOD` on a `DIGITAL` Product       |
 * | 409    | `TAX_CLASSIFICATION_UNCHANGED`             | already this classification; nothing written |
 * | 409    | `PRODUCT_REVISION_CONFLICT`                | the Product was revised concurrently         |
 * | 500    | `PRODUCT_UNAVAILABLE`                      | anything unexpected                          |
 *
 * Authorisation is answered before the reference is looked up, so an
 * unauthorised caller cannot probe which Products exist.
 *
 * ## What the answer carries
 *
 * The stable reference and the classification now in force. No version label,
 * no internal id, no act id, no lifecycle.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ProductRef } from "../../contracts/marketplace/listing-record";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { classifyProductTaxAs } from "../marketplace/product-tax-classification-service";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";
import {
  ConcurrencyConflictError,
  ProductNotAvailableError,
  ProductTaxClassificationContradictsDeliveryError,
  ProductTaxClassificationNotAuthorizedError,
  ProductTaxClassificationSelfActionNotPermittedError,
  ProductTaxClassificationUnchangedError,
  ValidationError,
} from "./errors";

type Db = ReturnType<typeof getPrisma>;

export const PRODUCT_TAX_CLASSIFICATION_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_TAX_CLASSIFICATION",
  notAuthorized: "TAX_CLASSIFICATION_NOT_AUTHORIZED",
  notAvailable: "PRODUCT_NOT_AVAILABLE",
  selfAction: "TAX_CLASSIFICATION_SELF_ACTION",
  contradictsDelivery: "TAX_CLASSIFICATION_CONTRADICTS_DELIVERY",
  unchanged: "TAX_CLASSIFICATION_UNCHANGED",
  conflict: "PRODUCT_REVISION_CONFLICT",
  unavailable: "PRODUCT_UNAVAILABLE",
} as const;

export const PRODUCT_TAX_CLASSIFICATION_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface ProductTaxClassificationRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface ProductTaxClassificationRouteRequest {
  /** The `{productRef}` path segment, exactly as routed. */
  productRef: string;
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface ProductTaxClassificationRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

const ClassifyProductTaxRequest = z.strictObject({
  /** Membership is checked by the domain against the governed enum. */
  taxClassification: z.string().max(32),
});

function refuse(status: number, code: string): ProductTaxClassificationRouteResult {
  return { status, body: { error: code }, headers: PRODUCT_TAX_CLASSIFICATION_ROUTE_HEADERS };
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
  const parsed = ClassifyProductTaxRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function handleClassifyProductTaxRequest(
  request: ProductTaxClassificationRouteRequest,
  deps: ProductTaxClassificationRouteDeps = {},
): Promise<ProductTaxClassificationRouteResult> {
  const codes = PRODUCT_TAX_CLASSIFICATION_ROUTE_ERROR_CODES;
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

  const body = parseBody(request.contentType, request.rawBody);
  if (body === null) return refuse(400, codes.invalidRequest);

  /* A malformed reference names no Product; it reaches the domain as one that
     does not exist, so authorisation is still answered first. */
  const productRef = ProductRef.safeParse(request.productRef);

  try {
    const classified = await classifyProductTaxAs(
      resolution.actor,
      {
        productRef: productRef.success ? productRef.data : "",
        taxClassification: body.taxClassification,
        now,
      },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    return {
      status: 200,
      body: { productRef: classified.productRef, taxClassification: classified.taxClassification },
      headers: PRODUCT_TAX_CLASSIFICATION_ROUTE_HEADERS,
    };
  } catch (error) {
    if (error instanceof ValidationError) return refuse(400, codes.invalidRequest);
    if (error instanceof ProductTaxClassificationNotAuthorizedError) return refuse(403, codes.notAuthorized);
    if (error instanceof ProductNotAvailableError) return refuse(404, codes.notAvailable);
    if (error instanceof ProductTaxClassificationSelfActionNotPermittedError) {
      return refuse(403, codes.selfAction);
    }
    if (error instanceof ProductTaxClassificationContradictsDeliveryError) {
      return refuse(409, codes.contradictsDelivery);
    }
    if (error instanceof ProductTaxClassificationUnchangedError) return refuse(409, codes.unchanged);
    if (error instanceof ConcurrencyConflictError) return refuse(409, codes.conflict);
    return refuse(500, codes.unavailable);
  }
}
