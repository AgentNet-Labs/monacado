/**
 * The scheduled dispatch trigger (Phase 1.27) — SERVER ONLY.
 *
 * **A trigger, and nothing else.** Phase 1.5 built the whole delivery engine —
 * the outbox, the claim lease, the backoff schedule, the permanent-failure
 * terminal state — and wired an operator endpoint to it. What it deliberately did
 * not wire was anything that fires on its own, and said so: "**No cron schedule
 * is wired in this phase**: there is no `vercel.json` or equivalent in this
 * repository to add one to ... The endpoint is here so that decision is one line
 * when somebody makes it."
 *
 * Phase 1.27 is the phase that made it necessary. Account verification made mail
 * load-bearing for authentication: a verification message that fails once and
 * lands in `RETRY_PENDING` is now a person who can never sign in, because nothing
 * would ever try again. So this is that one line, plus the smallest handler that
 * can be authorised.
 *
 * ## It reuses the dispatcher; it does not become one
 *
 * The only thing below is an authorisation check and a call to
 * `runEmailDispatchCycle` — the same function the Phase 1.5 endpoint calls.
 * Retry counts, backoff intervals, claim leases, dedupe, suppression, obligation
 * semantics and the provider abstraction are all untouched and are not restated
 * here. **MySQL remains authoritative**: `claimDueEmailDeliveries` decides what is
 * eligible by reading `status` and `nextAttemptAt`, and this handler's entire
 * contribution is supplying the instant to compare them against.
 *
 * There is no queue, no job record, no scheduler state, and nothing durable owned
 * by this module. If the schedule stopped firing, no delivery would be lost —
 * they would simply wait, exactly as they do today.
 *
 * ## Why it is a second route rather than a method on the first
 *
 * Vercel Cron issues a **GET**, and the Phase 1.5 endpoint is `POST` only for a
 * stated reason: "a `GET` that sent Monacado's queue would be a queue an image
 * tag could drain." Rather than reopen that decision, the scheduled path is its
 * own narrow route with its own gate, and the operator endpoint keeps the
 * contract it was reviewed with.
 *
 * The two gates are separate on purpose. A platform scheduler and a human
 * operator are different callers with different credentials, and a route that
 * accepted either secret would widen both.
 *
 * ## The cadence is committed, in `vercel.json`
 *
 * `vercel.json` declares one Vercel Cron job — this path, every five minutes
 * (`recommendedCron` below) — and nothing else. An earlier draft of this phase
 * withheld it for the reason Phase 1.8 withheld the tax recorder's: minute-level
 * Vercel Cron requires a paid plan, and the plan was unknown. That is resolved —
 * Monacado's Vercel account is Pro — so the declaration is committed. The tax
 * recorder's own disposition is unchanged, and it remains unscheduled.
 *
 * Daily was never an acceptable substitute here: a person who hit one transient
 * provider error would wait up to a day to be allowed to sign in.
 *
 * **Production.** Vercel invokes cron jobs for Production deployments only. Once
 * this is deployed to Production with `CRON_SECRET` set, Vercel calls this route
 * every five minutes; without the secret every tick is refused with 401 and
 * nothing is dispatched.
 *
 * **Staging.** The custom staging environment is NOT assumed to run this cron.
 * The route is deployed there like any other, and a retry proof is made by
 * invoking it manually with that environment's `CRON_SECRET` as the bearer. No
 * second scheduler exists to make staging mirror Production.
 *
 * ## The gate
 *
 * A shared secret presented as `Authorization: Bearer …`, compared in constant
 * time, whose **variable name** is configuration and whose value is read at
 * request time and stored in nothing — the construction this repository uses for
 * the Stripe key, the mail provider credential, the dispatcher secret and the
 * throttle pepper. It is its own secret and never any of those.
 *
 * It defaults to `CRON_SECRET` because that is the variable Vercel Cron itself
 * sends: when it is set, the platform attaches `Authorization: Bearer $CRON_SECRET`
 * to every scheduled invocation. Defaulting to it means the trigger is authorised
 * by configuration the operator sets once, with no value invented here.
 *
 * **Unconfigured is 401, never a permissive default.** An open dispatcher
 * endpoint is a way for anyone on the internet to make Monacado send its whole
 * due queue on demand, and "the secret was not set" is precisely the deployment
 * mistake that must fail closed rather than open.
 */

import "../server-only";
import type { MailPort } from "../../contracts/marketplace/notification-delivery";
import {
  DEFAULT_DISPATCH_LIMIT,
  runEmailDispatchCycle,
  type EmailDispatcherDeps,
} from "./email-dispatcher";
import { constantTimeEquals, MAX_REQUEST_LIMIT, type Env } from "./email-dispatcher-route-handler";

/**
 * The NAME of the variable holding the scheduler secret. Never the secret.
 *
 * `CRON_SECRET` is Vercel's own convention and is what the platform sends.
 * `MONACADO_SCHEDULER_SECRET_ENV` can point this at a differently-named variable
 * for a deployment that schedules some other way.
 */
export const SCHEDULER_SECRET_ENV_DEFAULT = "CRON_SECRET";

/** The path a scheduler calls. Named once, here. */
export const EMAIL_DISPATCH_SCHEDULED_PATH =
  "/api/internal/operations/email-dispatcher/scheduled";

/**
 * The cadence this workflow runs at, and where it is declared.
 *
 * The same shape as `TAX_RECORDER_SCHEDULE_GUIDANCE` — see the module header.
 * Stated as data rather than prose so readiness can be asserted rather than
 * remembered.
 */
export const EMAIL_DISPATCH_SCHEDULE_GUIDANCE = {
  /** The path a scheduler should call. */
  path: EMAIL_DISPATCH_SCHEDULED_PATH,
  /**
   * Five minutes, chosen against the retry ladder rather than picked round.
   * `EMAIL_RETRY_POLICY.backoffSeconds` is `[60, 300, 900, 3600, 10800]`, so a
   * five-minute tick collects the first retry within about four minutes of it
   * becoming due and lines up with the second step. Faster spends invocations on
   * an empty table — the common case, since the enqueue path already attempts an
   * immediate send and most messages never reach `RETRY_PENDING` at all.
   */
  recommendedCron: "*/5 * * * *",
  recommendedIntervalSeconds: 300,
  /** Minute-level Vercel Cron needs a paid plan. Monacado's account is Pro. */
  vercelMinuteLevelCronRequiresPlan: "PRO_OR_ENTERPRISE",
  /** Vercel Hobby caps cron at once per day. */
  vercelHobbyCronCadence: "DAILY",
  /** A day is not a sign-up cadence: it is a day somebody cannot sign in. */
  dailyCadenceAdequate: false,
  /** Any controlled scheduler issuing an authenticated request will do. */
  externalSchedulerAcceptable: true,
  /** Declared in `vercel.json` at `recommendedCron`, and nothing else is. */
  committedCronDeclaration: "VERCEL_JSON",
  /** Still a prerequisite: without `CRON_SECRET` every tick is a 401. */
  productionPrerequisite: true,
} as const;

export interface ScheduledDispatchResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Whether this request may run a cycle.
 *
 * One answer for every way of failing — unconfigured, absent header, wrong
 * scheme, wrong secret. Distinguishing them tells an unauthenticated caller how
 * far they got.
 */
export function isAuthorizedScheduledDispatch(
  authorizationHeader: string | null,
  env: Env,
): boolean {
  const secretEnvVar = env.MONACADO_SCHEDULER_SECRET_ENV ?? SCHEDULER_SECRET_ENV_DEFAULT;
  const expected = (env[secretEnvVar] ?? "").trim();
  if (expected === "") return false;

  const header = authorizationHeader ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  return constantTimeEquals(header.slice(7).trim(), expected);
}

/**
 * Run one bounded dispatch cycle on behalf of the scheduler.
 *
 * The limit is bounded exactly as the operator endpoint bounds it: one
 * invocation is a cycle, not a drain. A backlog larger than the limit is
 * processed by the next tick rather than by one request that runs until the
 * platform kills it mid-send.
 *
 * A dispatch failure is `503`, not `500`, for the reason the operator endpoint
 * gives: the work is durable and still due, so the honest answer to a scheduler
 * is "try again".
 */
export async function handleScheduledDispatchRequest(
  request: {
    authorizationHeader: string | null;
    limitParam: string | null;
    now: string;
  },
  deps: EmailDispatcherDeps & { env?: Env; port?: MailPort } = {},
): Promise<ScheduledDispatchResult> {
  const env = deps.env ?? process.env;

  if (!isAuthorizedScheduledDispatch(request.authorizationHeader, env)) {
    return { status: 401, body: { error: "UNAUTHORIZED" } };
  }

  const parsed = Number.parseInt(request.limitParam ?? "", 10);
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, MAX_REQUEST_LIMIT)
      : DEFAULT_DISPATCH_LIMIT;

  try {
    /* The existing dispatcher, unchanged. Everything about WHICH deliveries are
       eligible is decided inside it, from MySQL. */
    const result = await runEmailDispatchCycle({ now: request.now, limit }, deps.port, {
      ...deps,
      env,
    });
    /* Counts only. No address, no subject, no delivery id, no provider
       reference — a response that named messages would be a way to enumerate
       them, and this endpoint's reply reaches a platform log. */
    return { status: 200, body: { ran: true, ...result } };
  } catch {
    return { status: 503, body: { error: "DISPATCH_UNAVAILABLE" } };
  }
}
