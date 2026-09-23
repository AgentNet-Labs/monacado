/**
 * `POST /api/listings/{listingRef}/price` — state the retail price of one of
 * your own private draft placements (Phase 1.36).
 *
 * Phase 1.34 made a placement, Phase 1.35 made it removable, and both were
 * deliberately silent about money: a `SELLER_DIRECT` `DRAFT` placement is the
 * statement *which Product appears in which Storefront*, and placement is not
 * pricing (`LISTING_SOURCE_MODEL.md` §2a). This route adds the one commercial
 * sentence a Seller could not yet say about a placement they had already made:
 *
 * > "This Product is offered in this Storefront at this retail price."
 *
 * **And nothing beyond it.** The price is a commercial fact of the
 * *placement*. It is not a Product fact and revises no Product; it is not a
 * Storefront fact and revises no Storefront; it creates no Offer, no promoter
 * commission, no wholesale acquisition amount, and no marketplace fee; and it
 * does not take the placement live. After a successful call the placement is
 * still `DRAFT`, still private, still not for sale, and still consuming no
 * active-Listing capacity.
 *
 * The shape follows the Phase 1.31/1.32/1.34/1.35 handlers exactly: origin,
 * then session, then the path selector, then a strict JSON body, then the
 * domain through `marketplace-application-service`, then a bounded error
 * mapping.
 *
 * ## The reference is the only selector
 *
 * `listingRef` in the path, and nothing in the body identifies anything. An
 * `internalListingId`, a `listingSourceRecordId`, a Product id or reference, a
 * Storefront handle, a participant or controller id, a source-record version,
 * and a lifecycle all have **nowhere to go** — the body is a strict object with
 * two members, so any of them is a 400 rather than a field quietly ignored.
 * Which placement this is, who controls it, what type it is, and what state it
 * is in are all resolved server-side.
 *
 * ## The amount arrives as a person typed it, and is converted exactly once
 *
 * `{ "amount": "19.99", "currency": "USD" }`. The repository's authoritative
 * money model is integer minor units, and that is what is stored; but minor
 * units are not what a person types, and a route that demanded `1999` would
 * push the conversion into every client that ever calls it. So the decimal is
 * converted **here**, deterministically and without floating-point arithmetic,
 * by `parseRetailAmount` — the single place that conversion exists.
 *
 * `currency` is **required and explicit**, never defaulted. A currency is a
 * commercial claim, and a server that supplies a missing one has made that
 * claim on the seller's behalf. Only currencies Monacado prices in are accepted
 * (`USD` today); anything else is refused rather than converted at a guessed
 * minor-unit exponent.
 *
 * ## Authority is the domain's
 *
 * A SELLER role in a permitted status, control of this placement, a
 * `SELLER_DIRECT` type, a `DRAFT` lifecycle, and an authorized material change
 * — all decided by `setDraftPlacementPrice` and the versioned write path
 * beneath it, inside the transaction that writes. This handler decides none of
 * it and re-checks none of it.
 *
 * ## What a refusal says, and what it must not
 *
 * A reference that names nothing and a real placement belonging to another
 * Seller are **one answer**: `LISTING_NOT_AVAILABLE`. Anything finer would let
 * a caller holding a guessed reference learn that it exists, who has it, what
 * state it is in, whether it is promoted, or — worse on this route than on any
 * other — what a competitor charges for it.
 *
 * The amount refusals are safe precisely because they are **independent of the
 * placement**: `"abc"` is malformed whoever sent it and whatever it names, so a
 * 400 for one reveals nothing about any Listing. A caller probing references
 * must therefore send a valid amount, and then gets the same 404 for an unknown
 * reference as for somebody else's placement.
 *
 * Type, lifecycle, and "already at this price" are reported specifically, and
 * only ever for a placement the caller provably controls — control is
 * established before any of them can be raised.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ListingRef } from "../../contracts/marketplace/listing-record";
import { parseRetailAmount } from "../../contracts/marketplace/retail-amount";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { setOwnDraftPlacementPriceAs } from "./marketplace-application-service";
import {
  InvalidListingInputError,
  ListingNotAuthorizedError,
  ListingNotFoundError,
  ListingNotRepriceableError,
  ListingPriceUnchangedError,
  NoMaterialListingChangeError,
} from "./listing-errors";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "./participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const LISTING_PRICE_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  /** The body is not a strict `{ amount, currency }` JSON object. */
  invalidRequest: "INVALID_LISTING_REQUEST",
  /** The body was well-formed; the amount or currency was not acceptable. */
  invalidAmount: "INVALID_RETAIL_AMOUNT",
  /** No such placement, or none the caller controls — deliberately one code. */
  notAvailable: "LISTING_NOT_AVAILABLE",
  /** Controlled by the caller, but not in a state self-service pricing governs. */
  notRepriceable: "LISTING_NOT_REPRICEABLE",
  /** Controlled by the caller, and already carrying exactly this price. */
  priceUnchanged: "LISTING_PRICE_UNCHANGED",
  /** The caller may not author marketplace state at all. */
  notEligible: "LISTING_NOT_ELIGIBLE",
  unavailable: "LISTING_UNAVAILABLE",
} as const;

export const LISTING_PRICE_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface ListingPriceRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface ListingPriceRouteRequest {
  /** The `{listingRef}` path segment, exactly as routed. */
  listingRef: string;
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface ListingPriceRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

/**
 * The complete request body: one amount and its currency.
 *
 * A strict object, and the two members are **strings on purpose**. A JSON
 * number would be an IEEE-754 double the moment it was parsed, so `19.99`
 * would arrive as `19.989999999999998` and the exactness this route promises
 * would already be gone before any validation ran. A decimal string preserves
 * precisely what the person typed, and `parseRetailAmount` converts it without
 * arithmetic on a float.
 */
export const SetListingPriceRequest = z.strictObject({
  /** A user-facing decimal amount, e.g. `"19.99"`. Never a number. */
  amount: z.string().min(1).max(64),
  /** Explicit and required; never defaulted on the caller's behalf. */
  currency: z.string().min(1).max(8),
});
export type SetListingPriceRequest = z.infer<typeof SetListingPriceRequest>;

function refuse(status: number, code: string): ListingPriceRouteResult {
  return { status, body: { error: code }, headers: LISTING_PRICE_ROUTE_HEADERS };
}

/** A present origin must match; a missing one is permitted, as on the other routes. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

function parseBody(contentType: string | null, rawBody: string): SetListingPriceRequest | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = SetListingPriceRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function handleSetListingPriceRequest(
  request: ListingPriceRouteRequest,
  deps: ListingPriceRouteDeps = {},
): Promise<ListingPriceRouteResult> {
  const codes = LISTING_PRICE_ROUTE_ERROR_CODES;
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

  /* A path segment that could never be a reference names nothing — and says so
     with the SAME answer a well-formed reference to somebody else's placement
     gets, so the shape of a guess reveals nothing either. */
  const listingRef = ListingRef.safeParse(request.listingRef);
  if (!listingRef.success) return refuse(404, codes.notAvailable);

  const body = parseBody(request.contentType, request.rawBody);
  if (body === null) return refuse(400, codes.invalidRequest);

  /* The one conversion, and the one place it happens. A refusal here is about
     the AMOUNT and about nothing else — the same answer for the same string
     whatever placement it was aimed at — so it discloses nothing. */
  const amount = parseRetailAmount({ amount: body.amount, currency: body.currency });
  if (!amount.ok) return refuse(400, codes.invalidAmount);

  try {
    const { currentVersion, listingRef: ref } = await setOwnDraftPlacementPriceAs(
      resolution.actor,
      { listingRef: listingRef.data, retail: amount.retail, now },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    const placement = currentVersion.placement;
    return {
      status: 200,
      body: {
        /* The placement's own reference, unchanged by the repricing — the
           aggregate is the same aggregate, which is the point of having a
           reference that does not move with its versions. No internal id, no
           Product, no Storefront, no Offer, no economics. */
        listingRef: ref,
        /* Read back from the version that was actually written, never echoed
           from the request: what this route reports is what the database now
           holds. */
        lifecycle: currentVersion.lifecycle,
        /* Stated rather than implied. A priced draft is still not for sale, and
           the one place a caller might assume otherwise is right here. */
        listed: false,
        retail:
          placement.retail === null
            ? null
            : {
                amountMinorUnits: placement.retail.retailPriceMinorUnits,
                currency: placement.retail.retailPriceCurrency,
              },
      },
      headers: LISTING_PRICE_ROUTE_HEADERS,
    };
  } catch (error) {
    /* Controlled by the caller, and already at this price. Safe to be specific:
       control was established before this could be raised. */
    if (error instanceof ListingPriceUnchangedError) return refuse(409, codes.priceUnchanged);
    /* A racing call set the same price first, so the write path's own
       comparator refused it. The same question, the same answer. */
    if (error instanceof NoMaterialListingChangeError) return refuse(409, codes.priceUnchanged);

    /* Controlled by the caller, wrong type or wrong state. Safe for the same
       reason. */
    if (error instanceof ListingNotRepriceableError) return refuse(409, codes.notRepriceable);

    /* No such placement, or not the caller's — one answer. */
    if (error instanceof ListingNotFoundError) return refuse(404, codes.notAvailable);

    /* The caller cannot author marketplace state at all: no participant, no
       SELLER role, a status that does not permit drafting, or a closure. */
    if (
      error instanceof ListingNotAuthorizedError ||
      error instanceof ParticipantActionNotPermittedError ||
      error instanceof ParticipantLifecycleTerminatedError
    ) {
      return refuse(403, codes.notEligible);
    }
    if (error instanceof InvalidListingInputError) return refuse(404, codes.notAvailable);

    return refuse(500, codes.unavailable);
  }
}
