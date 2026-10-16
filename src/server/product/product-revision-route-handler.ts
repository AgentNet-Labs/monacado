/**
 * `POST /api/products/{productRef}/revise` — revise one of your own Products
 * (Phase 1.38).
 *
 * The Seller restates the four facts self-service revision governs, and the
 * Product gains one new immutable source version:
 *
 * ```json
 * {
 *   "expectedRevision": "<the revision token of the state being edited>",
 *   "name": "Hand-thrown mug",
 *   "description": "Stoneware, 350 ml." | null,
 *   "deliveryMode": "PHYSICAL" | "DIGITAL",
 *   "shippingPolicy": null
 *                   | { "method": "FREE" }
 *                   | { "method": "FIXED", "amount": "4.50", "currency": "USD" }
 * }
 * ```
 *
 * The shape follows the Phase 1.32/1.36 handlers: origin, then session, then
 * the path selector, then a strict JSON body, then the domain through
 * `marketplace-application-service`, then a bounded error mapping.
 *
 * ## The reference is the only selector
 *
 * `productRef` in the path; nothing in the body identifies anything. An
 * internal id, a source-record id or version, a participant, or a status has
 * nowhere to go — the body is strict, so any of them is a 400.
 *
 * ## Conditional on the state the Seller edited
 *
 * `expectedRevision` is the opaque revision token (`product-revision-token.ts`)
 * the page received with the Product it showed. If the Product has been revised
 * since — another tab saved first — the answer is `409
 * PRODUCT_REVISION_CONFLICT` and nothing is written. A success returns the new
 * token as `revision`, so the same form can save again without reloading.
 *
 * ## A fixed shipping charge arrives as a person typed it
 *
 * `"4.50"` and `"USD"`, strings on purpose, converted exactly once by
 * `parseRetailAmount` — no floating point, over-precision refused, an
 * unsupported currency refused. A zero charge is refused: free shipping is
 * stated as `FREE`, so "free" has one spelling and missing data never looks
 * like it.
 *
 * ## Refusals that reveal nothing
 *
 * Body-only refusals (`INVALID_PRODUCT_REVISION`, `UNSUPPORTED_SHIPPING_POLICY`,
 * `INVALID_SHIPPING_CHARGE`, `SHIPPING_POLICY_NOT_APPLICABLE`) depend on the
 * body alone, so they say nothing about any Product. An unknown reference and a
 * Product someone else authors are one answer, `PRODUCT_NOT_AVAILABLE`.
 * `PRODUCT_REVISION_UNCHANGED` and `PRODUCT_REVISION_CONFLICT` are raised only
 * after authority is established.
 *
 * ## What the answer carries
 *
 * The stable reference, the revised facts as written, the shipping policy, and
 * `PRODUCT_COMPLETENESS_V1` over the new current version. No internal id, no
 * version label, no Node identity, no participant. Completeness is not a
 * lifecycle state: nothing here says the Product is active or for sale.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ProductRef } from "../../contracts/marketplace/listing-record";
import { SupportedRetailCurrency, parseRetailAmount } from "../../contracts/marketplace/retail-amount";
import {
  SHIPPING_POLICY_METHODS,
  type ProductShippingPolicy,
} from "../../contracts/product/product-shipping-policy";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { reviseOwnProductAs } from "../marketplace/marketplace-application-service";
import { ParticipantActionNotPermittedError } from "../marketplace/participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "../marketplace/participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";
import {
  ConcurrencyConflictError,
  DuplicateVersionError,
  ProductCreatorNotEligibleError,
  ProductCreatorParticipantRequiredError,
  ProductNotAvailableError,
  ProductRevisionUnchangedError,
  ValidationError,
} from "./errors";

type Db = ReturnType<typeof getPrisma>;

export const PRODUCT_REVISION_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  /** The body is malformed, or a fact is not acceptable. */
  invalidRequest: "INVALID_PRODUCT_REVISION",
  /** A shipping-policy method this phase does not support. */
  unsupportedShippingPolicy: "UNSUPPORTED_SHIPPING_POLICY",
  /** A FIXED charge whose amount or currency is not acceptable. */
  invalidShippingCharge: "INVALID_SHIPPING_CHARGE",
  /** A shipping policy stated for a Product that is not Seller-shipped. */
  shippingPolicyNotApplicable: "SHIPPING_POLICY_NOT_APPLICABLE",
  /** No such Product, or none the caller authors — deliberately one code. */
  notAvailable: "PRODUCT_NOT_AVAILABLE",
  /** The caller may not author Products at all. */
  notEligible: "PRODUCT_NOT_ELIGIBLE",
  /** The revision restates exactly the current version. */
  unchanged: "PRODUCT_REVISION_UNCHANGED",
  /** The Product is no longer at the expected revision (a stale edit, or a lost race). */
  conflict: "PRODUCT_REVISION_CONFLICT",
  unavailable: "PRODUCT_UNAVAILABLE",
} as const;

export const PRODUCT_REVISION_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface ProductRevisionRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface ProductRevisionRouteRequest {
  /** The `{productRef}` path segment, exactly as routed. */
  productRef: string;
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface ProductRevisionRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

/**
 * The outer body. Facts are type-checked here and judged by the domain's
 * `ProductRevisionInput`; the shipping policy is parsed separately below so its
 * refusals can be specific.
 */
const ReviseProductRequest = z.strictObject({
  /** The opaque revision token of the state being edited. Format-checked by the domain. */
  expectedRevision: z.string().max(64),
  name: z.string().max(1_000),
  description: z.string().max(10_000).nullable(),
  deliveryMode: z.string().max(32),
  shippingPolicy: z.unknown(),
});

const FreeShippingRequest = z.strictObject({ method: z.literal("FREE") });
const FixedShippingRequest = z.strictObject({
  method: z.literal("FIXED"),
  /** A user-facing decimal amount, e.g. `"4.50"`. Never a number. */
  amount: z.string().min(1).max(64),
  /** Explicit and required; never defaulted on the caller's behalf. */
  currency: z.string().min(1).max(8),
});

type ShippingParse =
  | { ok: true; policy: ProductShippingPolicy | null }
  | { ok: false; code: string };

/** Parse the requested shipping policy, converting any FIXED amount exactly once. */
export function parseRequestedShippingPolicy(value: unknown): ShippingParse {
  const codes = PRODUCT_REVISION_ROUTE_ERROR_CODES;
  if (value === null) return { ok: true, policy: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, code: codes.invalidRequest };
  const method = (value as { method?: unknown }).method;
  if (typeof method !== "string") return { ok: false, code: codes.invalidRequest };
  if (!(SHIPPING_POLICY_METHODS as readonly string[]).includes(method)) {
    return { ok: false, code: codes.unsupportedShippingPolicy };
  }

  if (method === "FREE") {
    return FreeShippingRequest.safeParse(value).success
      ? { ok: true, policy: { method: "FREE" } }
      : { ok: false, code: codes.invalidRequest };
  }

  const fixed = FixedShippingRequest.safeParse(value);
  if (!fixed.success) return { ok: false, code: codes.invalidRequest };
  /* The one conversion. Zero is refused (`AMOUNT_NOT_POSITIVE`): free shipping
     is `FREE`, never `FIXED 0`. */
  const amount = parseRetailAmount({ amount: fixed.data.amount, currency: fixed.data.currency });
  if (!amount.ok) return { ok: false, code: codes.invalidShippingCharge };
  return {
    ok: true,
    policy: {
      method: "FIXED",
      fixedChargeMinorUnits: amount.retail.retailPriceMinorUnits,
      /* Already proven supported by `parseRetailAmount`; narrowed, not trusted. */
      fixedChargeCurrency: SupportedRetailCurrency.parse(amount.retail.retailPriceCurrency),
    },
  };
}

function refuse(status: number, code: string): ProductRevisionRouteResult {
  return { status, body: { error: code }, headers: PRODUCT_REVISION_ROUTE_HEADERS };
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
  const parsed = ReviseProductRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The shipping policy as the answer states it — minor units, never a float. */
function policyBody(policy: ProductShippingPolicy | undefined) {
  if (policy === undefined) return null;
  if (policy.method === "FREE") return { method: "FREE" };
  return {
    method: "FIXED",
    amountMinorUnits: policy.fixedChargeMinorUnits,
    currency: policy.fixedChargeCurrency,
  };
}

export async function handleReviseProductRequest(
  request: ProductRevisionRouteRequest,
  deps: ProductRevisionRouteDeps = {},
): Promise<ProductRevisionRouteResult> {
  const codes = PRODUCT_REVISION_ROUTE_ERROR_CODES;
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

  /* A segment that could never be a reference names nothing — the same answer a
     well-formed reference to somebody else's Product gets. */
  const productRef = ProductRef.safeParse(request.productRef);
  if (!productRef.success) return refuse(404, codes.notAvailable);

  const body = parseBody(request.contentType, request.rawBody);
  if (body === null) return refuse(400, codes.invalidRequest);

  const shipping = parseRequestedShippingPolicy(body.shippingPolicy);
  if (!shipping.ok) return refuse(400, shipping.code);
  /* Body-only, so it discloses nothing: a shipping rule for something nobody
     ships is refused, never silently dropped. */
  if (shipping.policy !== null && body.deliveryMode !== "PHYSICAL") {
    return refuse(400, codes.shippingPolicyNotApplicable);
  }

  try {
    const revised = await reviseOwnProductAs(
      resolution.actor,
      {
        productRef: productRef.data,
        expectedRevision: body.expectedRevision,
        input: {
          name: body.name,
          description: body.description,
          deliveryMode: body.deliveryMode,
          shippingPolicy: shipping.policy,
        },
        now,
      },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    const facts = revised.record.facts;
    return {
      status: 200,
      body: {
        /* Unchanged by the revision — the same Product, a new version. */
        productRef: revised.productRef,
        /* The new state's revision token — what the next edit must send. */
        revision: revised.revisionToken,
        /* Read back from the version written, never echoed from the request. */
        name: facts.name,
        description: facts.description ?? null,
        deliveryMode: facts.deliveryMode ?? null,
        shippingPolicy: policyBody(revised.record.shippingPolicy),
        completeness: {
          profile: revised.completeness.profile,
          complete: revised.completeness.complete,
          missing: revised.completeness.missing,
        },
      },
      headers: PRODUCT_REVISION_ROUTE_HEADERS,
    };
  } catch (error) {
    if (error instanceof ValidationError) return refuse(400, codes.invalidRequest);
    if (error instanceof ProductNotAvailableError) return refuse(404, codes.notAvailable);
    /* No participant to author with, or one no longer permitted to author —
       raised only for a Product the caller provably authored. */
    if (
      error instanceof ProductCreatorParticipantRequiredError ||
      error instanceof ProductCreatorNotEligibleError ||
      error instanceof ParticipantActionNotPermittedError ||
      error instanceof ParticipantLifecycleTerminatedError
    ) {
      return refuse(403, codes.notEligible);
    }
    if (error instanceof ProductRevisionUnchangedError) return refuse(409, codes.unchanged);
    if (error instanceof ConcurrencyConflictError || error instanceof DuplicateVersionError) {
      return refuse(409, codes.conflict);
    }
    return refuse(500, codes.unavailable);
  }
}
