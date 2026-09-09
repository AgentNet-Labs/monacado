/**
 * Storefront governance route handlers (Phase 1.21) — SERVER ONLY.
 *
 * **The first participant-facing marketplace mutation to reach `app/`.** Phase
 * 1.18 built the trusted actor boundary and deliberately built no route for it;
 * Phase 1.19 wired appointment and revocation as application commands and left
 * them unrouted. `marketplace-application-service` states what remained:
 *
 * > "A route's remaining job is to call `resolveActingAccount`, refuse
 * > `UNAUTHENTICATED` with a bounded 401, and map the domain errors."
 *
 * That is exactly and only what this module does.
 *
 * ## It decides nothing
 *
 * No authorization decision is made here. Who owns the Storefront, who holds an
 * ACTIVE governance assignment, whether the acting account is enabled, whether
 * the acting participant may author, and which direction of change is permitted
 * are all decided inside the governed service, against the database, in the
 * transaction that writes. This module handles HTTP: origin, session, parsing,
 * and turning a domain refusal into a bounded response.
 *
 * The one consequence worth stating plainly: **there is no code path here that
 * reaches `storefront-service` directly.** Both handlers call an application
 * command, which supplies the actor through `withActor`. Calling the domain
 * service from a route would skip that and reinstate exactly the payload
 * forgery Phase 1.18 removed — every service-level test would still pass while
 * the route stood open.
 *
 * ## The caller supplies business input, and no instant
 *
 * `AppointGovernanceRequest` and `SetGovernanceStatusRequest` are
 * `z.strictObject`s carrying the Storefront, the participant, and the requested
 * role or status. They carry no actor field, and an unknown key is a refusal
 * rather than something quietly dropped.
 *
 * **`now` is injected here, not accepted.** Both governed inputs require it, and
 * `withActor` overwrites only `actingAccountId` — so a route that forwarded a
 * caller's body verbatim would let that caller choose the instant recorded in
 * `assignedAt` and `revokedAt`. Those are the governance record of when
 * authority moved. This is the same reasoning `checkout-route-handler` gives for
 * refusing a client-chosen `placedAt`.
 *
 * ## Refusals are uniform on purpose
 *
 * An unknown Storefront, an actor holding no participant, a disabled account, an
 * actor who simply is not the owner or an active SUPER_OWNER, an appointee who
 * does not exist, and an assignment that was never made all answer **the same
 * 404 with the same code**. Distinguishing them would make this an oracle for
 * which Storefronts exist, which participant ids are real, and — worst — who
 * governs what, which is precisely the fact worth having before trying to
 * social-engineer a governance change.
 *
 * That is `participant-closure-errors`' rule applied here: "ANSWERED AS
 * NOT-FOUND, deliberately… A distinct 'not yours' error would confirm existence
 * to anybody who could guess an identifier."
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { InternalStorefrontId, StorefrontGovernanceRole } from "../../contracts/marketplace/storefront-source";
import {
  StoredGovernanceAssignmentStatus,
  type StorefrontGovernanceAssignmentRecord,
} from "../../contracts/marketplace/storefront-record";
import { MarketplaceParticipantId } from "../../contracts/marketplace/participant";
import { resolveActingAccount } from "../account/acting-participant-boundary";
import {
  appointStorefrontGovernance,
  setStorefrontGovernanceStatus,
} from "./marketplace-application-service";
import {
  GovernanceAssignmentNotFoundError,
  GovernanceParticipantNotFoundError,
  InvalidStorefrontInputError,
  StorefrontNotAuthorizedError,
  StorefrontNotFoundError,
  SuperOwnerAlreadyActiveError,
} from "./storefront-errors";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { ParticipantLifecycleTerminatedError } from "./participant-closure-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

/**
 * Bounded response codes.
 *
 * Every non-200 body is exactly `{ "error": <one of these> }` — no message, no
 * field list, no reason codes, no capability, no cause, no stack.
 */
export const GOVERNANCE_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_GOVERNANCE_REQUEST",
  /** Unknown Storefront, unknown participant, or not yours. One answer. */
  notFound: "STOREFRONT_GOVERNANCE_NOT_FOUND",
  /** A governed refusal — not an outage. */
  conflict: "STOREFRONT_GOVERNANCE_CONFLICT",
  unavailable: "STOREFRONT_GOVERNANCE_UNAVAILABLE",
} as const;

/** Participant-facing, so `referrer-policy` is present as on checkout and order status. */
export const GOVERNANCE_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface GovernanceRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

export interface GovernanceRouteRequest {
  contentType: string | null;
  originHeader: string | null;
  cookieHeader: string | null;
  rawBody: string;
}

export interface GovernanceRouteDeps {
  db?: Db | Prisma.TransactionClient;
  /** Injected so a test can pin the instant; production reads the clock. */
  now?: () => string;
  /** The origin this deployment answers on. Defaults to the configured one. */
  appOrigin?: string | undefined;
}

/**
 * What a caller may state when appointing.
 *
 * `strictObject`, so `actingAccountId`, `now`, `authorizedByParticipantId`, or
 * any other authority-shaped key is a **refusal** rather than a field quietly
 * discarded. The three members here are business input: which Storefront, which
 * participant, and which role.
 */
export const AppointGovernanceRequest = z.strictObject({
  internalStorefrontId: InternalStorefrontId,
  participantId: MarketplaceParticipantId,
  role: StorefrontGovernanceRole,
});
export type AppointGovernanceRequest = z.infer<typeof AppointGovernanceRequest>;

/**
 * What a caller may state when changing an assignment's standing.
 *
 * A separate schema from the appointment one, and a separate endpoint, because
 * the two are separate authorities: `SUSPENDED` and `REVOKED` reduce exposure
 * and stay available to an actor whose own standing is withheld, while `ACTIVE`
 * restores authority and does not. One endpoint branching on a caller-supplied
 * field is how the permitted act and the forbidden one end up behind one gate.
 */
export const SetGovernanceStatusRequest = z.strictObject({
  internalStorefrontId: InternalStorefrontId,
  participantId: MarketplaceParticipantId,
  status: StoredGovernanceAssignmentStatus,
});
export type SetGovernanceStatusRequest = z.infer<typeof SetGovernanceStatusRequest>;

/**
 * Names that must never appear on a governance request.
 *
 * Every schema above is a `strictObject`, so an unknown key already fails. This
 * list makes the intent explicit and gives a test something to enumerate — the
 * same belt-and-braces pattern `NEVER_ON_BEGIN_CHECKOUT_REQUEST` uses, and
 * equally not the primary control.
 */
export const NEVER_ON_GOVERNANCE_REQUEST = [
  "actingAccountId",
  "accountId",
  "actorParticipantId",
  "authorizedByParticipantId",
  "authorizedByActorId",
  "actorAuthorizedForOwnerParticipant",
  "capabilities",
  "internalCapabilities",
  "isSuperOwner",
  /* The instant a governance record carries is the server's, never a caller's. */
  "now",
] as const;

function refuse(status: number, code: string): GovernanceRouteResult {
  return { status, body: { error: code }, headers: GOVERNANCE_ROUTE_HEADERS };
}

/**
 * Whether a request may act.
 *
 * A missing `Origin` is permitted, as `isAcceptableOrigin` permits it: browsers
 * omit it on ordinary same-origin navigations. A *present* origin must match the
 * configured one — and when none is configured, a present origin matches
 * nothing, which fails closed.
 *
 * The session cookie is already `SameSite=Strict`, so this is defence in depth
 * rather than the only control. It is written here rather than reusing
 * `isAcceptableOrigin` because that helper's parameter is the full checkout
 * runtime config, and a governance route has no business requiring a configured
 * commercial policy id to answer.
 */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

/** Body parsing on checkout's terms: one content type, one bounded refusal. */
function parseBody<T>(
  schema: z.ZodType<T>,
  contentType: string | null,
  rawBody: string,
): T | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The governance assignment, projected onto what a caller may see.
 *
 * An allow-list, not a filter. `governanceAssignmentId` is deliberately absent:
 * no input accepts one, so returning it would hand out a durable handle nothing
 * consumes. Everything here is either a value the caller supplied or the
 * outcome they asked for.
 */
function toAssignmentView(
  record: StorefrontGovernanceAssignmentRecord,
): Record<string, unknown> {
  return {
    internalStorefrontId: record.internalStorefrontId,
    participantId: record.participantId,
    role: record.role,
    status: record.status,
    assignedAt: record.assignedAt,
    revokedAt: record.revokedAt,
  };
}

/**
 * Map a governed failure onto a bounded response.
 *
 * The uniform 404 is the load-bearing part. `StorefrontNotFoundError`,
 * `GovernanceParticipantNotFoundError` (which means *either* "you hold no
 * participant" *or* "that appointee does not exist"),
 * `GovernanceAssignmentNotFoundError`, and every `StorefrontNotAuthorizedError`
 * — including the `ACCOUNT_DISABLED` one — collapse to one answer. Its
 * `reasonCodes` and `capability` never travel: they name the exact gate that
 * refused, which is an authorization map handed to whoever asked.
 *
 * Suspension and closure are 409 rather than 404, and share one code with each
 * other, on `checkout-route-handler`'s precedent: a governed refusal is a
 * business answer rather than an outage, and a distinct code would disclose the
 * actor's own standing back to them in a form that travels into logs.
 */
function mapGovernanceError(error: unknown): GovernanceRouteResult {
  const codes = GOVERNANCE_ROUTE_ERROR_CODES;

  if (error instanceof InvalidStorefrontInputError) return refuse(400, codes.invalidRequest);

  if (
    error instanceof StorefrontNotFoundError ||
    error instanceof GovernanceParticipantNotFoundError ||
    error instanceof GovernanceAssignmentNotFoundError ||
    error instanceof StorefrontNotAuthorizedError
  ) {
    return refuse(404, codes.notFound);
  }

  if (
    error instanceof ParticipantActionNotPermittedError ||
    error instanceof ParticipantLifecycleTerminatedError ||
    error instanceof SuperOwnerAlreadyActiveError
  ) {
    return refuse(409, codes.conflict);
  }

  /* Anything else — a corrupt stored row, a persistence failure, an unmapped
     throw — is an outage, and says only that. */
  return refuse(500, codes.unavailable);
}

/**
 * Appoint a participant to a Storefront governance role, or change an existing
 * appointment.
 *
 * Order of checks, and each is deliberate: origin before anything, because a
 * cross-origin caller should learn nothing at all; then the session, **before
 * the body is parsed**, so an anonymous caller cannot probe which payloads are
 * well-formed; then the body; then the governed command, which owns every
 * authority question.
 */
export async function handleAppointGovernanceRequest(
  request: GovernanceRouteRequest,
  deps: GovernanceRouteDeps = {},
): Promise<GovernanceRouteResult> {
  const codes = GOVERNANCE_ROUTE_ERROR_CODES;
  const appOrigin = deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN;
  if (!originAcceptable(request.originHeader, appOrigin)) {
    return refuse(403, codes.crossOrigin);
  }

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const resolution = await resolveActingAccount(
    { cookieHeader: request.cookieHeader, now },
    { ...(deps.db !== undefined ? { db: deps.db } : {}) },
  );
  if (resolution.outcome !== "AUTHENTICATED") return refuse(401, codes.unauthenticated);

  const parsed = parseBody(AppointGovernanceRequest, request.contentType, request.rawBody);
  if (parsed === null) return refuse(400, codes.invalidRequest);

  try {
    const record = await appointStorefrontGovernance(
      resolution.actor,
      { ...parsed, now },
      { ...(deps.db !== undefined ? { db: deps.db as Db } : {}) },
    );
    return { status: 200, body: toAssignmentView(record), headers: GOVERNANCE_ROUTE_HEADERS };
  } catch (error) {
    return mapGovernanceError(error);
  }
}

/**
 * Suspend, revoke, or restore a Storefront governance assignment.
 *
 * A separate endpoint from appointment because it is a separate authority. The
 * direction rule — that withdrawing authority stays available to an actor whose
 * own authoring standing is withheld, while restoring it does not — lives in the
 * governed service and is not restated here.
 */
export async function handleSetGovernanceStatusRequest(
  request: GovernanceRouteRequest,
  deps: GovernanceRouteDeps = {},
): Promise<GovernanceRouteResult> {
  const codes = GOVERNANCE_ROUTE_ERROR_CODES;
  const appOrigin = deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN;
  if (!originAcceptable(request.originHeader, appOrigin)) {
    return refuse(403, codes.crossOrigin);
  }

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const resolution = await resolveActingAccount(
    { cookieHeader: request.cookieHeader, now },
    { ...(deps.db !== undefined ? { db: deps.db } : {}) },
  );
  if (resolution.outcome !== "AUTHENTICATED") return refuse(401, codes.unauthenticated);

  const parsed = parseBody(SetGovernanceStatusRequest, request.contentType, request.rawBody);
  if (parsed === null) return refuse(400, codes.invalidRequest);

  try {
    const record = await setStorefrontGovernanceStatus(
      resolution.actor,
      { ...parsed, now },
      { ...(deps.db !== undefined ? { db: deps.db as Db } : {}) },
    );
    return { status: 200, body: toAssignmentView(record), headers: GOVERNANCE_ROUTE_HEADERS };
  } catch (error) {
    return mapGovernanceError(error);
  }
}
