/**
 * `POST /api/participant/onboarding` — begin Seller/Promoter setup (Phase 1.29).
 *
 * The signed-in account asks to set up as a Seller, a Promoter, or both. Who is
 * asking comes from the session cookie and from nowhere else; the body names the
 * roles and nothing more. The shape follows `storefront-governance-route-handler`:
 * origin, then session, then a strict JSON body, then the domain service through
 * `marketplace-application-service`, then a bounded error mapping.
 *
 * **Setup only.** The participant is created DRAFT and each role DRAFT, by the
 * domain service's own rules. Nothing here submits activation, verifies an
 * address, touches a payment provider, or makes anything public.
 *
 * **Email verification is not required here, deliberately.** It gates going
 * live (`assertOwnerAccountEmailVerified` on the Storefront path), not setting
 * up — the boundary Phase 1.27's follow-up moved it to.
 *
 * The answer carries the participant's status and its roles' statuses, which is
 * what the page shows. It carries no participant id, account id, or role id: the
 * browser has no use for them and the page reads its own state server-side.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { SelfServiceOnboardingRole } from "../../contracts/marketplace/participant-record";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import { beginOnboardingAs } from "./marketplace-application-service";
import type { ParticipantSnapshot } from "./participant-service";
import {
  DuplicateParticipantError,
  InvalidParticipantInputError,
  ParticipantOnboardingClosedError,
} from "./participant-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const ONBOARDING_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_ONBOARDING_REQUEST",
  closed: "PARTICIPANT_ONBOARDING_CLOSED",
  conflict: "PARTICIPANT_ONBOARDING_CONFLICT",
  unavailable: "PARTICIPANT_ONBOARDING_UNAVAILABLE",
} as const;

export const ONBOARDING_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface OnboardingRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface OnboardingRouteRequest {
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface OnboardingRouteDeps {
  db?: Db;
  now?: () => string;
  appOrigin?: string | undefined;
}

/** Strict: an `accountId`, `participantId`, `status`, or `now` is a 400, not ignored. */
export const BeginOnboardingRequest = z.strictObject({
  roles: z.array(SelfServiceOnboardingRole).min(1).max(2),
});
export type BeginOnboardingRequest = z.infer<typeof BeginOnboardingRequest>;

function refuse(status: number, code: string): OnboardingRouteResult {
  return { status, body: { error: code }, headers: ONBOARDING_ROUTE_HEADERS };
}

/** A present origin must match; a missing one is permitted, as on the other routes. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

function parseBody(contentType: string | null, rawBody: string): BeginOnboardingRequest | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = BeginOnboardingRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function toOnboardingView(snapshot: ParticipantSnapshot): Record<string, unknown> {
  return {
    status: snapshot.participant.status,
    roles: snapshot.roles.map((r) => ({ role: r.role, status: r.status })),
  };
}

export async function handleBeginOnboardingRequest(
  request: OnboardingRouteRequest,
  deps: OnboardingRouteDeps = {},
): Promise<OnboardingRouteResult> {
  const codes = ONBOARDING_ROUTE_ERROR_CODES;
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
    const snapshot = await beginOnboardingAs(
      resolution.actor,
      { roles: parsed.roles, now },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    return { status: 200, body: toOnboardingView(snapshot), headers: ONBOARDING_ROUTE_HEADERS };
  } catch (error) {
    if (error instanceof InvalidParticipantInputError) return refuse(400, codes.invalidRequest);
    if (error instanceof ParticipantOnboardingClosedError) return refuse(409, codes.closed);
    /* Two first requests for one account racing: the loser is told to retry, and
       a retry finds the participant the winner created. */
    if (error instanceof DuplicateParticipantError) return refuse(409, codes.conflict);
    return refuse(500, codes.unavailable);
  }
}
