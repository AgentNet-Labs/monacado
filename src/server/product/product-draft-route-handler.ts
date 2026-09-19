/**
 * `POST /api/products` — open a private draft Product (Phase 1.32).
 *
 * The signed-in account drafts a Product as its own participant. Who is asking
 * comes from the session cookie; who authored the Product is that account's own
 * participant, resolved server-side. The body is the creator's facts and nothing
 * else. The shape follows the Storefront handlers: origin, then session, then a
 * strict JSON body, then the domain through `marketplace-application-service`,
 * then a bounded error mapping.
 *
 * **Within the Product allowance.** The free plan includes
 * `INCLUDED_PRODUCT_ALLOWANCE` Products; a Seller who authors that many is
 * refused with 409 `PRODUCT_UPGRADE_REQUIRED`, decided inside the write.
 *
 * **SELLER only, and draft only.** `canCreateDraftProduct` decides — a SELLER
 * role in a drafting status on a participant permitted to draft; a promoter
 * never authors Product facts. The version is `draft`, its creator Node is
 * unbound (ADR §10.3), and no Listing, Offer, Node, capsule, or publication is
 * created. Email verification is not required to draft.
 *
 * The answer carries the facts the page shows and the draft status — never the
 * internal Product or source-record id, and never the participant.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { DraftProductInput } from "../../contracts/product/product-source-record";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { createDraftProductAs } from "../marketplace/marketplace-application-service";
import {
  DuplicateProductError,
  ProductCreatorNotEligibleError,
  ProductCreatorParticipantRequiredError,
  ProductUpgradeRequiredError,
  ValidationError,
} from "./errors";
import { ParticipantActionNotPermittedError } from "../marketplace/participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "../marketplace/participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const PRODUCT_DRAFT_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_PRODUCT_REQUEST",
  notEligible: "PRODUCT_NOT_ELIGIBLE",
  conflict: "PRODUCT_CREATE_CONFLICT",
  upgradeRequired: "PRODUCT_UPGRADE_REQUIRED",
  unavailable: "PRODUCT_UNAVAILABLE",
} as const;

export const PRODUCT_DRAFT_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface ProductDraftRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface ProductDraftRouteRequest {
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface ProductDraftRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

function refuse(status: number, code: string): ProductDraftRouteResult {
  return { status, body: { error: code }, headers: PRODUCT_DRAFT_ROUTE_HEADERS };
}

/** A present origin must match; a missing one is permitted, as on the other routes. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

function parseBody(contentType: string | null, rawBody: string): DraftProductInput | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = DraftProductInput.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function handleCreateDraftProductRequest(
  request: ProductDraftRouteRequest,
  deps: ProductDraftRouteDeps = {},
): Promise<ProductDraftRouteResult> {
  const codes = PRODUCT_DRAFT_ROUTE_ERROR_CODES;
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
    const record = await createDraftProductAs(resolution.actor, parsed, {
      now,
      ...(deps.db !== undefined ? { db: deps.db } : {}),
    });
    return {
      status: 201,
      body: {
        name: record.facts.name,
        description: record.facts.description ?? null,
        promotable: record.facts.promotable,
        generalAvailabilityState: record.facts.generalAvailabilityState,
        deliveryMode: record.facts.deliveryMode ?? null,
        status: "DRAFT",
      },
      headers: PRODUCT_DRAFT_ROUTE_HEADERS,
    };
  } catch (error) {
    if (error instanceof ValidationError) return refuse(400, codes.invalidRequest);
    /* The Seller authors every Product the free plan includes. Same status and
       shape as the Storefront allowance's refusal. */
    if (error instanceof ProductUpgradeRequiredError) return refuse(409, codes.upgradeRequired);
    /* No participant, no SELLER role in a drafting status, a participant status
       that does not permit drafting, a suspension, or a closure — one bounded
       answer. The page already shows the person what setup they have. */
    if (
      error instanceof ProductCreatorParticipantRequiredError ||
      error instanceof ProductCreatorNotEligibleError ||
      error instanceof ParticipantActionNotPermittedError ||
      error instanceof ParticipantLifecycleTerminatedError
    ) {
      return refuse(403, codes.notEligible);
    }
    /* Two freshly generated identifiers collided — vanishingly rare, and a retry
       draws new ones. */
    if (error instanceof DuplicateProductError) return refuse(409, codes.conflict);
    return refuse(500, codes.unavailable);
  }
}
