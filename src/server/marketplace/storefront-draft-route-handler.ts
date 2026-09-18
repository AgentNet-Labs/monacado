/**
 * `POST /api/storefronts` — open a private draft Storefront (Phase 1.30).
 *
 * The signed-in account opens a Storefront for its own participant. Who is
 * asking comes from the session cookie; which participant owns the result is
 * that account's own, resolved server-side. The body names the two things the
 * domain requires at creation — a display name and a public handle — and nothing
 * else. The shape follows `participant-onboarding-route-handler`: origin, then
 * session, then a strict JSON body, then the domain through
 * `marketplace-application-service`, then a bounded error mapping.
 *
 * **Within the Storefront allowance.** The first Storefront is included; a
 * participant that already owns every Storefront its allowance covers is refused
 * with 409 `STOREFRONT_UPGRADE_REQUIRED`. The server enforces this; the page
 * only reflects it.
 *
 * **Draft only.** The first version is DRAFT + PRIVATE by construction, and the
 * owner is appointed its first SUPER_OWNER in the same transaction. Nothing here
 * activates, widens visibility, touches payment, or publishes.
 *
 * **Eligibility is the domain's.** `canCreateStorefrontRecord` (a SELLER or
 * PROMOTER role in a drafting status, on a participant whose status permits
 * drafting) and the suspension / closure seams decide; this handler only maps
 * their refusals onto one bounded code. Email verification is not required: it
 * gates going live, not drafting.
 *
 * The answer carries the display name, the handle the owner chose, and the
 * lifecycle and visibility — never the internal Storefront, source-record,
 * participant, or governance-assignment id.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  MAX_DISPLAY_NAME_LENGTH,
  PublicHandle,
} from "../../contracts/marketplace/storefront-source";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { openOwnedDraftStorefrontAs } from "./marketplace-application-service";
import {
  DuplicatePublicHandleError,
  GovernanceParticipantNotFoundError,
  InvalidStorefrontInputError,
  OwnerParticipantNotFoundError,
  StorefrontNotAuthorizedError,
  StorefrontUpgradeRequiredError,
} from "./storefront-errors";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "./participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const STOREFRONT_DRAFT_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_STOREFRONT_REQUEST",
  notEligible: "STOREFRONT_NOT_ELIGIBLE",
  handleUnavailable: "STOREFRONT_HANDLE_UNAVAILABLE",
  upgradeRequired: "STOREFRONT_UPGRADE_REQUIRED",
  unavailable: "STOREFRONT_UNAVAILABLE",
} as const;

export const STOREFRONT_DRAFT_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface StorefrontDraftRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface StorefrontDraftRouteRequest {
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface StorefrontDraftRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

/**
 * Strict: an owner, participant, account, governance role, lifecycle,
 * visibility, or instant is a 400, not ignored. Tagline and summary are not
 * asked for at creation; the domain holds them as nullable.
 */
export const OpenDraftStorefrontRequest = z.strictObject({
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  publicHandle: PublicHandle,
});
export type OpenDraftStorefrontRequest = z.infer<typeof OpenDraftStorefrontRequest>;

function refuse(status: number, code: string): StorefrontDraftRouteResult {
  return { status, body: { error: code }, headers: STOREFRONT_DRAFT_ROUTE_HEADERS };
}

/** A present origin must match; a missing one is permitted, as on the other routes. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

function parseBody(contentType: string | null, rawBody: string): OpenDraftStorefrontRequest | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = OpenDraftStorefrontRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function handleOpenDraftStorefrontRequest(
  request: StorefrontDraftRouteRequest,
  deps: StorefrontDraftRouteDeps = {},
): Promise<StorefrontDraftRouteResult> {
  const codes = STOREFRONT_DRAFT_ROUTE_ERROR_CODES;
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
    const { storefront } = await openOwnedDraftStorefrontAs(
      resolution.actor,
      {
        publicHandle: parsed.publicHandle,
        presentation: { displayName: parsed.displayName, tagline: null, summary: null },
        now,
      },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    const version = storefront.currentVersion;
    return {
      status: 201,
      body: {
        displayName: version.presentation.displayName,
        publicHandle: version.publicHandle,
        lifecycle: version.lifecycle,
        visibility: version.visibility,
      },
      headers: STOREFRONT_DRAFT_ROUTE_HEADERS,
    };
  } catch (error) {
    if (error instanceof InvalidStorefrontInputError) return refuse(400, codes.invalidRequest);
    if (error instanceof DuplicatePublicHandleError) return refuse(409, codes.handleUnavailable);
    if (error instanceof StorefrontUpgradeRequiredError) {
      return refuse(409, codes.upgradeRequired);
    }
    /* No participant, no Storefront-capable role in a drafting status, a
       participant status that does not permit drafting, a suspension, or a
       closure. One bounded answer: the reasons belong to the domain's own
       records, and the page already tells the person what setup they have. */
    if (
      error instanceof StorefrontNotAuthorizedError ||
      error instanceof GovernanceParticipantNotFoundError ||
      error instanceof OwnerParticipantNotFoundError ||
      error instanceof ParticipantActionNotPermittedError ||
      error instanceof ParticipantLifecycleTerminatedError
    ) {
      return refuse(403, codes.notEligible);
    }
    return refuse(500, codes.unavailable);
  }
}
