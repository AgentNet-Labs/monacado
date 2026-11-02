/**
 * `POST /api/storefronts/{publicHandle}/go-live` — take a Storefront live,
 * ACTIVE and PUBLIC (Phase 1.46).
 *
 * The smallest owner act that makes a Storefront publicly accessible, so a
 * promoted or seller-direct Listing in it can be bought. Same shape as the
 * Phase 1.31 presentation handler: origin, then session, then the domain
 * through `marketplace-application-service`, then a bounded error mapping. The
 * body is empty (`{}`): the act names its own target state, and a lifecycle,
 * visibility, or anything else in the body is a 400.
 *
 * **Authority is the domain's.** `createStorefrontSourceVersion` decides it,
 * unchanged — the active SUPER_OWNER only; the owner admitted, payable, commerce
 * approved, permitted `storefront:activate`, and with a verified address. A
 * Storefront that does not exist and one the caller has no governance over are
 * the same 404. A governor who is refused is told the reason codes, which are
 * closed vocabulary about their own Storefront and owner — never an id.
 *
 * | Status | Code                                | When |
 * |--------|-------------------------------------|------|
 * | 200    | —                                   | live; `{ publicHandle, lifecycle, visibility }` |
 * | 400    | `INVALID_STOREFRONT_GO_LIVE_REQUEST` | non-JSON or non-empty body |
 * | 401    | `UNAUTHENTICATED`                   | no session |
 * | 403    | `CROSS_ORIGIN_REQUEST_REFUSED`      | foreign origin |
 * | 403    | `STOREFRONT_GO_LIVE_REFUSED`        | a governor, refused; `blockers` names why |
 * | 404    | `STOREFRONT_NOT_FOUND`              | no such Storefront, or no governance over it |
 * | 409    | `STOREFRONT_ALREADY_LIVE`           | already ACTIVE and PUBLIC |
 * | 409    | `STOREFRONT_EDIT_CONFLICT`          | a concurrent version won |
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { PublicHandle } from "../../contracts/marketplace/storefront-source";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { goLiveStorefrontAs } from "./marketplace-application-service";
import {
  DuplicateSourceVersionError,
  GovernanceParticipantNotFoundError,
  InvalidStorefrontInputError,
  NoMaterialChangeError,
  OwnerAccountEmailUnverifiedError,
  OwnerParticipantNotFoundError,
  StorefrontNotAuthorizedError,
  StorefrontNotFoundError,
} from "./storefront-errors";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "./participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const STOREFRONT_GO_LIVE_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_STOREFRONT_GO_LIVE_REQUEST",
  notFound: "STOREFRONT_NOT_FOUND",
  refused: "STOREFRONT_GO_LIVE_REFUSED",
  alreadyLive: "STOREFRONT_ALREADY_LIVE",
  conflict: "STOREFRONT_EDIT_CONFLICT",
  unavailable: "STOREFRONT_UNAVAILABLE",
} as const;

export const STOREFRONT_GO_LIVE_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

/**
 * Reasons meaning "you do not govern this Storefront" — answered as 404, so the
 * route does not confirm a private draft exists to someone who cannot see it.
 */
const NO_GOVERNANCE_REASONS: readonly string[] = [
  "ACTOR_NOT_AUTHORIZED_FOR_OWNER",
  "GOVERNANCE_ASSIGNMENT_REQUIRED",
  "GOVERNANCE_ASSIGNMENT_NOT_ACTIVE",
  "GOVERNANCE_ASSIGNMENT_STOREFRONT_MISMATCH",
];

export interface StorefrontGoLiveRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface StorefrontGoLiveRouteRequest {
  publicHandle: string;
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface StorefrontGoLiveRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

/** An empty object, and only that. */
export const GoLiveStorefrontRequest = z.strictObject({});

function refuse(status: number, code: string, extra: Record<string, unknown> = {}): StorefrontGoLiveRouteResult {
  return { status, body: { error: code, ...extra }, headers: STOREFRONT_GO_LIVE_ROUTE_HEADERS };
}

function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

function bodyAcceptable(contentType: string | null, rawBody: string): boolean {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return false;
  try {
    return GoLiveStorefrontRequest.safeParse(JSON.parse(rawBody)).success;
  } catch {
    return false;
  }
}

export async function handleGoLiveStorefrontRequest(
  request: StorefrontGoLiveRouteRequest,
  deps: StorefrontGoLiveRouteDeps = {},
): Promise<StorefrontGoLiveRouteResult> {
  const codes = STOREFRONT_GO_LIVE_ROUTE_ERROR_CODES;
  const appOrigin = deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN;
  if (!originAcceptable(request.originHeader, appOrigin)) return refuse(403, codes.crossOrigin);

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const resolution = await resolveActingAccount(
    { cookieHeader: request.cookieHeader, now },
    { ...(deps.db !== undefined ? { db: deps.db as Db | Prisma.TransactionClient } : {}) },
  );
  if (resolution.outcome !== "AUTHENTICATED") return refuse(401, codes.unauthenticated);

  const handle = PublicHandle.safeParse(request.publicHandle);
  if (!handle.success) return refuse(404, codes.notFound);
  if (!bodyAcceptable(request.contentType, request.rawBody)) return refuse(400, codes.invalidRequest);

  try {
    const { currentVersion } = await goLiveStorefrontAs(
      resolution.actor,
      { publicHandle: handle.data, now },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    return {
      status: 200,
      body: {
        publicHandle: currentVersion.publicHandle,
        lifecycle: currentVersion.lifecycle,
        visibility: currentVersion.visibility,
      },
      headers: STOREFRONT_GO_LIVE_ROUTE_HEADERS,
    };
  } catch (error) {
    if (error instanceof InvalidStorefrontInputError) return refuse(400, codes.invalidRequest);
    if (error instanceof NoMaterialChangeError) return refuse(409, codes.alreadyLive);
    if (error instanceof DuplicateSourceVersionError) return refuse(409, codes.conflict);
    if (error instanceof StorefrontNotAuthorizedError) {
      if (error.reasonCodes.some((r) => NO_GOVERNANCE_REASONS.includes(r))) {
        return refuse(404, codes.notFound);
      }
      return refuse(403, codes.refused, { blockers: [...error.reasonCodes] });
    }
    if (error instanceof OwnerAccountEmailUnverifiedError) {
      return refuse(403, codes.refused, { blockers: ["OWNER_EMAIL_UNVERIFIED"] });
    }
    if (
      error instanceof ParticipantActionNotPermittedError ||
      error instanceof ParticipantLifecycleTerminatedError
    ) {
      return refuse(403, codes.refused, { blockers: ["PARTICIPANT_NOT_PERMITTED"] });
    }
    if (
      error instanceof StorefrontNotFoundError ||
      error instanceof GovernanceParticipantNotFoundError ||
      error instanceof OwnerParticipantNotFoundError
    ) {
      return refuse(404, codes.notFound);
    }
    return refuse(500, codes.unavailable);
  }
}
