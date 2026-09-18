/**
 * `POST /api/storefronts/{publicHandle}/presentation` — edit a Storefront's
 * display name, tagline, and summary (Phase 1.31).
 *
 * The Storefront is named by its public handle, the reference the account page
 * already shows; who is asking comes from the session cookie. The body is the
 * complete presentation and nothing else. The shape follows the Phase 1.30
 * handler: origin, then session, then a strict JSON body, then the domain
 * through `marketplace-application-service`, then a bounded error mapping.
 *
 * **Presentation only.** The domain is handed a presentation and no other field,
 * so no lifecycle, visibility, handle, owner, or governance change can ride
 * along. Every edit mints the next immutable source version; earlier versions
 * are never touched.
 *
 * **Authority is the domain's.** An ACTIVE SUPER_OWNER or ADMIN on this
 * Storefront whose own participation permits authoring may edit it; this
 * handler decides nothing about that, and only maps refusals. A Storefront that
 * does not exist and one the caller has no authority over are the same 404, so
 * the route does not confirm that a private draft exists to someone who cannot
 * see it.
 *
 * `null` clears a tagline or summary; a blank string is not a value and is
 * refused. The answer carries the presentation, the handle, and the lifecycle
 * and visibility — no internal Storefront, version, participant, or governance
 * id.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  PublicHandle,
  StorefrontPresentation,
} from "../../contracts/marketplace/storefront-source";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { editStorefrontPresentationAs } from "./marketplace-application-service";
import {
  DuplicateSourceVersionError,
  GovernanceParticipantNotFoundError,
  InvalidStorefrontInputError,
  NoMaterialChangeError,
  OwnerParticipantNotFoundError,
  StorefrontNotAuthorizedError,
  StorefrontNotFoundError,
} from "./storefront-errors";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "./participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const STOREFRONT_PRESENTATION_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_STOREFRONT_PRESENTATION_REQUEST",
  notFound: "STOREFRONT_NOT_FOUND",
  notEditable: "STOREFRONT_NOT_EDITABLE",
  unchanged: "STOREFRONT_PRESENTATION_UNCHANGED",
  conflict: "STOREFRONT_EDIT_CONFLICT",
  unavailable: "STOREFRONT_UNAVAILABLE",
} as const;

export const STOREFRONT_PRESENTATION_ROUTE_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });

export interface StorefrontPresentationRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface StorefrontPresentationRouteRequest {
  /** The `{publicHandle}` path segment, exactly as routed. */
  publicHandle: string;
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface StorefrontPresentationRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

/**
 * The complete presentation, and only it. The source model's own schema: an
 * `accountId`, handle, lifecycle, visibility, or version label is a 400.
 */
export const EditStorefrontPresentationRequest = StorefrontPresentation;
export type EditStorefrontPresentationRequest = z.infer<typeof EditStorefrontPresentationRequest>;

function refuse(status: number, code: string): StorefrontPresentationRouteResult {
  return { status, body: { error: code }, headers: STOREFRONT_PRESENTATION_ROUTE_HEADERS };
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
): EditStorefrontPresentationRequest | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = EditStorefrontPresentationRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function handleEditStorefrontPresentationRequest(
  request: StorefrontPresentationRouteRequest,
  deps: StorefrontPresentationRouteDeps = {},
): Promise<StorefrontPresentationRouteResult> {
  const codes = STOREFRONT_PRESENTATION_ROUTE_ERROR_CODES;
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

  /* A path segment that could never be a handle names nothing. */
  const handle = PublicHandle.safeParse(request.publicHandle);
  if (!handle.success) return refuse(404, codes.notFound);

  const parsed = parseBody(request.contentType, request.rawBody);
  if (parsed === null) return refuse(400, codes.invalidRequest);

  try {
    const { currentVersion } = await editStorefrontPresentationAs(
      resolution.actor,
      { publicHandle: handle.data, presentation: parsed, now },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    return {
      status: 200,
      body: {
        publicHandle: currentVersion.publicHandle,
        displayName: currentVersion.presentation.displayName,
        tagline: currentVersion.presentation.tagline,
        summary: currentVersion.presentation.summary,
        lifecycle: currentVersion.lifecycle,
        visibility: currentVersion.visibility,
      },
      headers: STOREFRONT_PRESENTATION_ROUTE_HEADERS,
    };
  } catch (error) {
    if (error instanceof InvalidStorefrontInputError) return refuse(400, codes.invalidRequest);
    if (error instanceof NoMaterialChangeError) return refuse(409, codes.unchanged);
    if (error instanceof DuplicateSourceVersionError) return refuse(409, codes.conflict);
    /* The caller governs this Storefront but it is CLOSED — its presentation is
       history. Only a governor can reach this reason: the decision refuses
       everyone else on authority first. */
    if (
      error instanceof StorefrontNotAuthorizedError &&
      error.reasonCodes.includes("STOREFRONT_CLOSED")
    ) {
      return refuse(403, codes.notEditable);
    }
    /* The actor's own participation is suspended or closed. */
    if (
      error instanceof ParticipantActionNotPermittedError ||
      error instanceof ParticipantLifecycleTerminatedError
    ) {
      return refuse(403, codes.notEditable);
    }
    /* No such Storefront, or no authority over it — the same answer. */
    if (
      error instanceof StorefrontNotFoundError ||
      error instanceof StorefrontNotAuthorizedError ||
      error instanceof GovernanceParticipantNotFoundError ||
      error instanceof OwnerParticipantNotFoundError
    ) {
      return refuse(404, codes.notFound);
    }
    return refuse(500, codes.unavailable);
  }
}
