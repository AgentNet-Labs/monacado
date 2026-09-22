/**
 * `POST /api/listings` — place one of your own Products in one of your
 * Storefronts, as a private DRAFT Listing (Phase 1.34).
 *
 * The first self-service Listing path. It creates **placement and nothing else**:
 * which Product appears in which Storefront, as a `DRAFT`, `SELLER_DIRECT`,
 * unpriced Listing. No price, no currency, no Offer, no commission, no
 * activation, no Node, and no publication — see `LISTING_SOURCE_MODEL.md` §2a
 * for why an unpriced placement is the honest record rather than a gap in one.
 *
 * The shape follows the Phase 1.31 and 1.32 handlers exactly: origin, then
 * session, then a strict JSON body, then the domain through
 * `marketplace-application-service`, then a bounded error mapping.
 *
 * ## Two selectors, and they are the whole request
 *
 * `productRef` — the opaque application reference the account page already
 * holds — and `storefrontHandle`. The body is a strict object, so an internal
 * `mon:product:` id, a `mon:srec:`, a ProductNode id, a participant id, an
 * owner id, a governance assignment, a Listing id, a source version, a
 * lifecycle, a retail price, a currency, an Offer, or a commission is a 400
 * rather than a field quietly ignored. Identity and authority come from the
 * session and the database; the caller states what they want placed, never who
 * they are or what they may do.
 *
 * ## Authority is the domain's, and it is asked once
 *
 * A SELLER role in a permitted status, creator authority over that Product,
 * placement authority over that Storefront, and a participation in good
 * standing — all decided by `createSellerDirectListing` inside its own write
 * transaction. This handler decides none of it and re-checks none of it; a
 * second copy here would be a second answer able to disagree.
 *
 * ## What a refusal says, and what it must not
 *
 * A `productRef` that names nothing, a Product belonging to another Seller, a
 * handle that names nothing, and a Storefront the caller does not control are
 * **one answer**: `PLACEMENT_NOT_AVAILABLE`. Separating them would turn this
 * route into an oracle for whether a competitor's private draft exists, and for
 * which Products they hold — the same reasoning that makes the Storefront
 * presentation route answer 404 for both.
 *
 * Being unable to place *anything* is different, and is safe to say plainly: a
 * promoter-only participant, an account with no participant, and a suspended or
 * closed participation learn that they are not eligible, which reveals nothing
 * about anyone else.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ProductRef } from "../../contracts/marketplace/listing-record";
import { PublicHandle } from "../../contracts/marketplace/storefront-source";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { placeOwnProductInStorefront } from "./marketplace-application-service";
import {
  ControllerParticipantNotFoundError,
  InvalidListingInputError,
  ListingAlreadyExistsError,
  ListingNotAuthorizedError,
  ListingProductNotFoundError,
  ListingStorefrontNotFoundError,
} from "./listing-errors";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "./participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const LISTING_PLACEMENT_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_LISTING_REQUEST",
  /** No such Product or Storefront, or no authority over one — deliberately one code. */
  notAvailable: "PLACEMENT_NOT_AVAILABLE",
  /** The caller may not place Listings at all. Reveals nothing about anyone else. */
  notEligible: "LISTING_NOT_ELIGIBLE",
  alreadyExists: "LISTING_ALREADY_EXISTS",
  unavailable: "LISTING_UNAVAILABLE",
} as const;

export const LISTING_PLACEMENT_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface ListingPlacementRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface ListingPlacementRouteRequest {
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface ListingPlacementRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

/**
 * The complete request: two selectors.
 *
 * A strict object, restated here rather than reused from the service input
 * because the service input also carries `actingAccountId` and `now` — the two
 * values this layer exists to supply rather than accept.
 */
export const CreateListingPlacementRequest = z.strictObject({
  productRef: ProductRef,
  storefrontHandle: PublicHandle,
});
export type CreateListingPlacementRequest = z.infer<typeof CreateListingPlacementRequest>;

function refuse(status: number, code: string): ListingPlacementRouteResult {
  return { status, body: { error: code }, headers: LISTING_PLACEMENT_ROUTE_HEADERS };
}

/** A present origin must match; a missing one is permitted, as on the other routes. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

function parseBody(
  contentType: string | null,
  rawBody: string,
): CreateListingPlacementRequest | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = CreateListingPlacementRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Which authority refusals must stay indistinguishable from "no such thing".
 *
 * `PRODUCT_AUTHORITY_REQUIRED` and `STOREFRONT_AUTHORITY_REQUIRED` are the two
 * the domain raises about a *specific* Product or Storefront the caller named.
 * Answering them distinctly would confirm that the named thing exists and
 * belongs to somebody else, which is exactly what a caller enumerating opaque
 * references is looking for. Every other reason code is about the caller.
 */
const NON_DISCLOSING_REASONS = new Set([
  "PRODUCT_AUTHORITY_REQUIRED",
  "STOREFRONT_AUTHORITY_REQUIRED",
]);

export async function handleCreateListingPlacementRequest(
  request: ListingPlacementRouteRequest,
  deps: ListingPlacementRouteDeps = {},
): Promise<ListingPlacementRouteResult> {
  const codes = LISTING_PLACEMENT_ROUTE_ERROR_CODES;
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

  const parsed = parseBody(request.contentType, request.rawBody);
  if (parsed === null) return refuse(400, codes.invalidRequest);

  try {
    const { currentVersion, listingRef } = await placeOwnProductInStorefront(
      resolution.actor,
      { productRef: parsed.productRef, storefrontHandle: parsed.storefrontHandle, now },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    return {
      status: 201,
      body: {
        /* Phase 1.35 — the placement's own stable reference, so the caller can
           act on what it just made. Opaque, un-namespaced, and naming the
           aggregate rather than a version, so it stays valid across every later
           lifecycle move. No internal identifier, no price, no currency, no
           Offer: the placement has none. */
        listingRef,
        productRef: parsed.productRef,
        storefrontHandle: parsed.storefrontHandle,
        lifecycle: currentVersion.lifecycle,
        listed: false,
      },
      headers: LISTING_PLACEMENT_ROUTE_HEADERS,
    };
  } catch (error) {
    if (error instanceof InvalidListingInputError) return refuse(400, codes.invalidRequest);

    /* Already placed. A real, specific answer — and safe, because the caller has
       already proved authority over both sides of the pair to reach it. */
    if (error instanceof ListingAlreadyExistsError) return refuse(409, codes.alreadyExists);

    /* One answer for "no such Product/Storefront" and "not yours". */
    if (
      error instanceof ListingProductNotFoundError ||
      error instanceof ListingStorefrontNotFoundError ||
      (error instanceof ListingNotAuthorizedError &&
        error.reasonCodes.some((code) => NON_DISCLOSING_REASONS.has(code)))
    ) {
      return refuse(404, codes.notAvailable);
    }

    /* The caller cannot place Listings at all: no participant, no SELLER role,
       a status that does not permit drafting, a suspension, or a closure. */
    if (
      error instanceof ListingNotAuthorizedError ||
      error instanceof ControllerParticipantNotFoundError ||
      error instanceof ParticipantActionNotPermittedError ||
      error instanceof ParticipantLifecycleTerminatedError
    ) {
      return refuse(403, codes.notEligible);
    }

    return refuse(500, codes.unavailable);
  }
}
