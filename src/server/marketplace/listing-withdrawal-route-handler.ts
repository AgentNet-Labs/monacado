/**
 * `POST /api/listings/{listingRef}/withdraw` — take one of your own private
 * draft placements back out of a Storefront (Phase 1.35).
 *
 * The other half of Phase 1.34. A Seller could create a placement and then
 * never refer to one again, because every identifier a Listing had was internal
 * — so the only self-service act in the product had no undo. `listingRef` makes
 * a placement nameable; this route makes it removable.
 *
 * **It removes a placement, and nothing else.** The Product stays in the
 * Seller's library, the Storefront stays exactly as it was, and the withdrawn
 * Listing keeps its whole immutable history. What changes is one lifecycle
 * move, `DRAFT → WITHDRAWN`, which releases the Product + Storefront pair so
 * the same Product may be placed there again later.
 *
 * The shape follows the Phase 1.31/1.32/1.34 handlers exactly: origin, then
 * session, then the path selector, then the domain through
 * `marketplace-application-service`, then a bounded error mapping.
 *
 * ## The reference is the whole request
 *
 * There is **no request body**, and that is the narrowest possible surface: a
 * lifecycle, a Product, a Storefront, a controller, a participant, a reason, a
 * price, an Offer, or an activation field has nowhere to go because there is
 * nowhere for anything to go. A body that arrives anyway is ignored rather than
 * parsed, since the route reads none of it.
 *
 * ## Authority is the domain's
 *
 * A SELLER role in a permitted status, control of this placement, and a
 * `DRAFT → WITHDRAWN` move the transition table allows — all decided by
 * `createListingSourceVersion` inside its own write transaction. This handler
 * decides none of it and re-checks none of it.
 *
 * ## What a refusal says, and what it must not
 *
 * A reference that names nothing and a real placement belonging to another
 * Seller are **one answer**: `LISTING_NOT_AVAILABLE`. Anything finer would let
 * a caller holding a guessed reference learn that it exists, who has it, or
 * what state it is in — a census of a competitor's private shelf, assembled one
 * 404 at a time.
 *
 * State is reported only for a placement the caller provably controls, which is
 * why `LISTING_NOT_WITHDRAWABLE` is safe: by the time it can be raised, control
 * has been established.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { ListingRef } from "../../contracts/marketplace/listing-record";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { withdrawOwnDraftPlacementAs } from "./marketplace-application-service";
import {
  InvalidListingInputError,
  ListingNotAuthorizedError,
  ListingNotFoundError,
  ListingNotWithdrawableError,
  NoMaterialListingChangeError,
} from "./listing-errors";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "./participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const LISTING_WITHDRAWAL_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  /** No such placement, or none the caller controls — deliberately one code. */
  notAvailable: "LISTING_NOT_AVAILABLE",
  /** Controlled by the caller, but not in a state self-service withdrawal governs. */
  notWithdrawable: "LISTING_NOT_WITHDRAWABLE",
  /** The caller may not author marketplace state at all. */
  notEligible: "LISTING_NOT_ELIGIBLE",
  unavailable: "LISTING_UNAVAILABLE",
} as const;

export const LISTING_WITHDRAWAL_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface ListingWithdrawalRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface ListingWithdrawalRouteRequest {
  /** The `{listingRef}` path segment, exactly as routed. */
  listingRef: string;
  originHeader: string | null;
  cookieHeader: string | null;
}

export interface ListingWithdrawalRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

function refuse(status: number, code: string): ListingWithdrawalRouteResult {
  return { status, body: { error: code }, headers: LISTING_WITHDRAWAL_ROUTE_HEADERS };
}

/** A present origin must match; a missing one is permitted, as on the other routes. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

export async function handleWithdrawListingRequest(
  request: ListingWithdrawalRouteRequest,
  deps: ListingWithdrawalRouteDeps = {},
): Promise<ListingWithdrawalRouteResult> {
  const codes = LISTING_WITHDRAWAL_ROUTE_ERROR_CODES;
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

  try {
    const { currentVersion, listingRef: ref } = await withdrawOwnDraftPlacementAs(
      resolution.actor,
      { listingRef: listingRef.data, now },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    return {
      status: 200,
      body: {
        /* The placement's own reference, unchanged by the withdrawal — the
           aggregate is the same aggregate, which is the point of having a
           reference that does not move with its versions. No internal id, no
           Product, no Storefront, no price. */
        listingRef: ref,
        lifecycle: currentVersion.lifecycle,
        listed: false,
      },
      headers: LISTING_WITHDRAWAL_ROUTE_HEADERS,
    };
  } catch (error) {
    /* Controlled by the caller, wrong state. Safe to be specific: control was
       established before this could be raised. */
    if (error instanceof ListingNotWithdrawableError) return refuse(409, codes.notWithdrawable);
    /* A concurrent withdrawal won the race and the move is no longer a change. */
    if (error instanceof NoMaterialListingChangeError) return refuse(409, codes.notWithdrawable);

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
