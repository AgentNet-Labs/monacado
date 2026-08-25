/**
 * The tax recorder dispatcher endpoint (Phase 1.8) — SERVER ONLY.
 *
 * The whole route expressed **without Next.js**, following
 * `email-dispatcher-route-handler.ts` exactly: it takes headers and returns a
 * status and a body, so every rule is testable without constructing a framework
 * request.
 *
 * ## Why an endpoint, and why now
 *
 * `1.7` shipped `tax:record:once` and no way to run it. On a platform with no
 * long-running process a schedule is a cron hitting a URL, and without one the
 * durable work `1.7` commits is recoverable in principle and unrecovered in
 * fact. This is the shape a scheduled invocation takes.
 *
 * ## The gate
 *
 * A shared secret presented as `Authorization: Bearer …`, compared in constant
 * time, whose **variable name** is configuration and whose value is resolved at
 * request time and stored in nothing. Absent or unconfigured is `401`, never a
 * permissive default.
 *
 * It answers `401` identically for "no secret configured", "no header", "wrong
 * scheme", and "wrong secret". Distinguishing them tells an unauthenticated
 * caller how far they got, and the body says only `UNAUTHORIZED` — no variable
 * name, no hint about which condition failed, and nothing about whether tax is
 * configured at all.
 *
 * **A dedicated secret.** `MONACADO_TAX_RECORDER_SECRET`, not the email
 * dispatcher's and not a payment credential: one operational secret that could
 * drive two unrelated subsystems is one rotation away from an outage in the one
 * nobody was thinking about.
 *
 * ## GET is accepted, and that is a deliberate departure
 *
 * `1.5`'s dispatcher is `POST`-only, reasoning that "a `GET` that sent Monacado's
 * queue would be a queue an image tag could drain". That reasoning holds for an
 * *unauthenticated* GET and does not hold here: this endpoint refuses every
 * request without an `Authorization` header, and a browser cannot attach one
 * cross-origin from an `<img>`, a `<script>`, or a link. A CSRF-shaped attack
 * cannot reach past the gate.
 *
 * It is accepted because **Vercel Cron invokes with `GET`** and cannot be
 * configured otherwise. A `POST`-only endpoint would be a scheduler that could
 * never fire — precisely the gap this phase exists to close. `POST` remains
 * accepted for an operator or a scheduler that prefers it.
 *
 * ## What it returns
 *
 * Counts. No Order id, no buyer, no amount, no provider reference, no secret, and
 * no variable name — a response that named sales would be a way to enumerate
 * customers.
 */

import "../server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { TAX_RECORDING_OPERATIONS_POLICY } from "../../contracts/marketplace/tax-recording-operations";
import {
  runTaxTransactionRecordingCycle,
  type TaxRecordingCycleDeps,
} from "./tax-transaction-recorder";

export type Env = Record<string, string | undefined>;

/** The NAME of the variable holding the dispatcher secret. Never the secret. */
export const TAX_RECORDER_SECRET_ENV_DEFAULT = "MONACADO_TAX_RECORDER_SECRET";

/** The path the scheduler invokes. Kept here so readiness can name it once. */
export const TAX_RECORDER_ENDPOINT_PATH = "/api/internal/operations/tax-recorder";

/**
 * What a production deployment should schedule, and what it takes to do it.
 *
 * **Documentation, not deployment configuration.** These are values a readiness
 * report and an operator runbook can name; nothing here causes anything to be
 * scheduled, and no cron is declared in this repository.
 *
 * ## Why no committed cron
 *
 * A `vercel.json` carrying a five-minute cron was written for this phase and then
 * removed. Vercel limits Hobby projects to **daily** cron execution, and the
 * repository holds no authoritative statement of which plan Monacado production
 * runs on — the only mention of Vercel anywhere is a deferred "Vercel wiring"
 * item in `PRODUCT_PERSISTENCE.md`. Committing a minute-level schedule would have
 * meant committing a deployment that **fails at deploy time** on the plan nobody
 * has ruled out.
 *
 * Downgrading to a daily cron to fit Hobby was the other available answer and is
 * worse: once a day is not a tax-recording cadence. A calculation expires, and a
 * sale reported a day late is a sale that spent a day invisible to reconciliation
 * for no reason. The honest disposition is to ship the endpoint production-ready,
 * state the cadence, and let the deployment decision be made deliberately.
 *
 * ## The scheduler need not be Vercel
 *
 * Any controlled scheduler that can issue an authenticated request on this
 * cadence satisfies it. Readiness asks whether **a** scheduler is configured, not
 * whose.
 */
export const TAX_RECORDER_SCHEDULE_GUIDANCE = {
  /** The cadence a production deployment should run. */
  recommendedCron: "*/5 * * * *",
  recommendedIntervalSeconds: 300,
  /** Minute-level Vercel Cron needs a paid plan. */
  vercelMinuteLevelCronRequiresPlan: "PRO_OR_ENTERPRISE",
  /** Vercel Hobby caps cron at once per day. */
  vercelHobbyCronCadence: "DAILY",
  /** And once a day is not adequate for this workflow. */
  dailyCadenceAdequate: false,
  /** Any controlled scheduler issuing an authenticated request will do. */
  externalSchedulerAcceptable: true,
  /** Nothing in this repository schedules anything. */
  committedCronDeclaration: "NONE",
  /** Cleared by configuring a real scheduler, not by a file existing. */
  productionPrerequisite: true,
} as const;

/** How many rows one request will process. Bounded; a request is not a drain. */
export const MAX_REQUEST_LIMIT = TAX_RECORDING_OPERATIONS_POLICY.maxCycleLimit;

export interface TaxRecorderRouteResult {
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
export function isAuthorizedTaxRecorderRequest(
  authorizationHeader: string | null,
  env: Env,
): boolean {
  const secretEnvVar = env.MONACADO_TAX_RECORDER_SECRET_ENV ?? TAX_RECORDER_SECRET_ENV_DEFAULT;
  const expected = (env[secretEnvVar] ?? "").trim();
  if (expected === "") return false;

  const header = authorizationHeader ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  return constantTimeEquals(header.slice(7).trim(), expected);
}

/** Whether the dispatcher secret is configured at all, without reading it. */
export function isTaxRecorderSecretConfigured(env: Env): boolean {
  const secretEnvVar = env.MONACADO_TAX_RECORDER_SECRET_ENV ?? TAX_RECORDER_SECRET_ENV_DEFAULT;
  return (env[secretEnvVar] ?? "").trim() !== "";
}

/**
 * Run one bounded recording cycle.
 *
 * A cycle failure is `503`, not `500`: the work is durable and still due, so the
 * honest answer to a scheduler is "try again", not "this request was malformed".
 * The error itself is discarded — it can carry a query, a row, or a provider
 * message.
 */
export async function handleTaxRecorderRequest(
  request: {
    authorizationHeader: string | null;
    limitParam: string | null;
    now: string;
  },
  deps: TaxRecordingCycleDeps & { env?: Env } = {},
): Promise<TaxRecorderRouteResult> {
  const env = deps.env ?? process.env;

  if (!isAuthorizedTaxRecorderRequest(request.authorizationHeader, env)) {
    return { status: 401, body: { error: "UNAUTHORIZED" } };
  }

  const parsed = Number.parseInt(request.limitParam ?? "", 10);
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, MAX_REQUEST_LIMIT)
      : TAX_RECORDING_OPERATIONS_POLICY.defaultCycleLimit;

  try {
    const result = await runTaxTransactionRecordingCycle({ at: request.now, limit }, deps);
    return {
      status: 200,
      body: {
        ran: true,
        claimed: result.claimed,
        recorded: result.recorded,
        retryScheduled: result.retryScheduled,
        permanentlyFailed: result.permanentlyFailed,
        staleClaimsRecovered: result.staleClaimsRecovered,
        claimConflicts: result.claimConflicts,
      },
    };
  } catch {
    return { status: 503, body: { error: "TAX_RECORDING_UNAVAILABLE" } };
  }
}
