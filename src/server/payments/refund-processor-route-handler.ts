/**
 * The refund processor dispatcher endpoint (Phase 1.9) — SERVER ONLY.
 *
 * The whole route expressed **without Next.js**, following
 * `tax-recorder-route-handler.ts` exactly: it takes headers and returns a status
 * and a body, so every rule is testable without constructing a framework request.
 *
 * ## Why an endpoint, and why now
 *
 * `1.8` recorded the lesson in the form of the gap it closed: a bounded cycle
 * with nothing to run it is *"durable work nobody will ever process — the failure
 * mode that looks fine in every test."* For refunds that failure mode is worse
 * than for tax reporting. An unreported sale is a filing problem discovered at
 * quarter end; an unexecuted refund is a buyer who has been charged for something
 * they are owed back, and every hour of it makes a chargeback more likely and
 * more expensive.
 *
 * ## A dedicated secret
 *
 * `MONACADO_REFUND_PROCESSOR_SECRET`, not the tax recorder's and not the email
 * dispatcher's. `1.8`'s reasoning, unchanged: one operational secret driving two
 * unrelated subsystems is one rotation away from an outage in the one nobody was
 * thinking about — and this is the subsystem that returns money.
 *
 * ## The gate
 *
 * A shared secret presented as `Authorization: Bearer …`, compared in constant
 * time, whose **variable name** is configuration and whose value is resolved at
 * request time and stored in nothing. It answers `401` identically for "no secret
 * configured", "no header", "wrong scheme", and "wrong secret": distinguishing
 * them tells an unauthenticated caller how far they got. The body says only
 * `UNAUTHORIZED` — no variable name, no hint about which condition failed, and
 * nothing about whether refunds are configured at all.
 *
 * ## `GET` is accepted, for `1.8`'s stated reason
 *
 * `1.5`'s dispatcher is `POST`-only, reasoning that *"a `GET` that sent
 * Monacado's queue would be a queue an image tag could drain"*. That holds for an
 * *unauthenticated* GET and does not hold here: this endpoint refuses every
 * request without an `Authorization` header, and a browser cannot attach one
 * cross-origin from an `<img>`, a `<script>`, or a link. It is accepted because
 * **Vercel Cron invokes with `GET`** and cannot be configured otherwise.
 *
 * ## No cron is committed
 *
 * The same disposition `1.8` reached and for the same unresolved reason: the
 * repository holds no authoritative statement of which Vercel plan production
 * runs on, minute-level cron needs Pro or Enterprise, and Hobby caps cron at once
 * per day. Committing a five-minute schedule would commit a deployment that fails
 * at deploy time on a plan nobody has ruled out; downgrading to daily to fit Hobby
 * is worse, because once a day is not a cadence for returning people's money.
 *
 * So the endpoint ships production-ready and the cadence is documented. Readiness
 * treats the scheduler as an **operator statement**, because Monacado cannot see
 * its own deployment's scheduler.
 *
 * ## What it returns
 *
 * Counts. No Order id, no buyer, no amount, no provider reference, no secret, and
 * no variable name — a response that named refunds would be a way to enumerate
 * customers and their complaints.
 */

import "../server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { REFUND_OPERATIONS_POLICY } from "../../contracts/marketplace/refund-operations";
import { runRefundCycle, type RefundCycleDeps } from "../marketplace/refund-processor";

export type Env = Record<string, string | undefined>;

/** The NAME of the variable holding the dispatcher secret. Never the secret. */
export const REFUND_PROCESSOR_SECRET_ENV_DEFAULT = "MONACADO_REFUND_PROCESSOR_SECRET";

/** The path the scheduler invokes. Kept here so readiness can name it once. */
export const REFUND_PROCESSOR_ENDPOINT_PATH = "/api/internal/operations/refund-processor";

/**
 * What a production deployment should schedule, and what it takes to do it.
 *
 * **Documentation, not deployment configuration.** These are values a readiness
 * report and an operator runbook can name; nothing here causes anything to be
 * scheduled, and no cron is declared in this repository.
 *
 * The cadence is `1.8`'s, deliberately matched rather than argued about
 * separately: both subsystems process a handful of rows against the same
 * provider, and two cadences for one operator to remember buys nothing.
 */
export const REFUND_PROCESSOR_SCHEDULE_GUIDANCE = {
  recommendedCron: "*/5 * * * *",
  recommendedIntervalSeconds: 300,
  vercelMinuteLevelCronRequiresPlan: "PRO_OR_ENTERPRISE",
  vercelHobbyCronCadence: "DAILY",
  /** Once a day is not a cadence for returning a buyer's money. */
  dailyCadenceAdequate: false,
  externalSchedulerAcceptable: true,
  committedCronDeclaration: "NONE",
  productionPrerequisite: true,
} as const;

/** How many rows one request will process. Bounded; a request is not a drain. */
export const MAX_REQUEST_LIMIT = REFUND_OPERATIONS_POLICY.maxCycleLimit;

export interface RefundProcessorRouteResult {
  status: number;
  body: Record<string, unknown>;
}

function constantTimeEquals(presented: string, expected: string): boolean {
  /* Digested first so the comparison is over fixed-length buffers:
     `timingSafeEqual` throws on a length mismatch, and the throw would itself
     leak the expected length. */
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Whether this request may run a cycle. One answer for every way of failing. */
export function isAuthorizedRefundProcessorRequest(
  authorizationHeader: string | null,
  env: Env,
): boolean {
  const secretEnvVar =
    env.MONACADO_REFUND_PROCESSOR_SECRET_ENV ?? REFUND_PROCESSOR_SECRET_ENV_DEFAULT;
  const expected = (env[secretEnvVar] ?? "").trim();
  if (expected === "") return false;

  const header = authorizationHeader ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  return constantTimeEquals(header.slice(7).trim(), expected);
}

/** Whether the dispatcher secret is configured at all, without reading it. */
export function isRefundProcessorSecretConfigured(env: Env): boolean {
  const secretEnvVar =
    env.MONACADO_REFUND_PROCESSOR_SECRET_ENV ?? REFUND_PROCESSOR_SECRET_ENV_DEFAULT;
  return (env[secretEnvVar] ?? "").trim() !== "";
}

/**
 * Whether an operator has declared that a scheduler invokes this endpoint.
 *
 * An **operator statement**, never an inference. Monacado cannot see its own
 * deployment's scheduler, and treating a file's presence as proof would be
 * asserting an operational fact nobody established — `1.8`'s rule, and the same
 * one `tax-readiness.ts` applies to registration posture.
 */
export function isRefundProcessorScheduleDeclared(env: Env): boolean {
  return (env.MONACADO_REFUND_PROCESSOR_SCHEDULE ?? "").trim() !== "";
}

/**
 * Run one bounded refund cycle.
 *
 * A cycle failure is `503`, not `500`: the work is durable and still due, so the
 * honest answer to a scheduler is "try again", not "this request was malformed".
 * The error itself is discarded — it can carry a query, a row, or a provider
 * message.
 */
export async function handleRefundProcessorRequest(
  request: {
    authorizationHeader: string | null;
    limitParam: string | null;
    now: string;
  },
  deps: RefundCycleDeps & { env?: Env } = {},
): Promise<RefundProcessorRouteResult> {
  const env = deps.env ?? process.env;

  if (!isAuthorizedRefundProcessorRequest(request.authorizationHeader, env)) {
    return { status: 401, body: { error: "UNAUTHORIZED" } };
  }

  const parsed = Number.parseInt(request.limitParam ?? "", 10);
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, MAX_REQUEST_LIMIT)
      : REFUND_OPERATIONS_POLICY.defaultCycleLimit;

  try {
    const result = await runRefundCycle({ at: request.now, limit }, deps);
    return {
      status: 200,
      body: {
        ran: true,
        refundsClaimed: result.refundsClaimed,
        refundsExecuted: result.refundsExecuted,
        refundsRetryScheduled: result.refundsRetryScheduled,
        refundsPermanentlyFailed: result.refundsPermanentlyFailed,
        taxReversalsClaimed: result.taxReversalsClaimed,
        taxReversalsExecuted: result.taxReversalsExecuted,
        taxReversalsRetryScheduled: result.taxReversalsRetryScheduled,
        taxReversalsPermanentlyFailed: result.taxReversalsPermanentlyFailed,
        staleClaimsRecovered: result.staleClaimsRecovered,
        claimConflicts: result.claimConflicts,
        recoveryExceptionsRaised: result.recoveryExceptionsRaised,
      },
    };
  } catch {
    return { status: 503, body: { error: "REFUND_PROCESSING_UNAVAILABLE" } };
  }
}
