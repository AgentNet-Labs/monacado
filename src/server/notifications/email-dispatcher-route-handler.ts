/**
 * The dispatcher endpoint (Phase 1.5) — SERVER ONLY.
 *
 * The whole route expressed **without Next.js**, following
 * `worker-status-route-handler.ts` and `checkout-route-handler.ts`: it takes
 * headers and returns a status and a body, so every rule is testable without
 * constructing a framework request.
 *
 * ## Why an endpoint at all
 *
 * The operator command exists and is the primary path. This is the shape a
 * *scheduled* invocation takes on a platform with no long-running process — a
 * cron hits a URL. **No cron schedule is wired in this phase**: there is no
 * `vercel.json` or equivalent in this repository to add one to, and inventing a
 * deployment configuration to hold a schedule is a deployment decision, not a
 * notification phase's. The endpoint is here so that decision is one line when
 * somebody makes it.
 *
 * ## The gate
 *
 * A shared secret presented as `Authorization: Bearer …`, compared in constant
 * time, whose **variable name** is configuration and whose value is resolved at
 * request time and stored in nothing. Absent or unconfigured is `401`, never a
 * permissive default: an unauthenticated dispatcher endpoint is a way for anyone
 * on the internet to make Monacado send its whole queue on demand.
 *
 * It answers `401` identically for "no secret configured", "no header", and
 * "wrong secret". Distinguishing them tells an unauthenticated caller how far
 * they got.
 *
 * ## What it returns
 *
 * Counts. No address, no subject, no body, no delivery id, and no provider
 * reference — a response that named messages would be a way to enumerate them.
 */

import "../server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { MailPort } from "../../contracts/marketplace/notification-delivery";
import {
  DEFAULT_DISPATCH_LIMIT,
  runEmailDispatchCycle,
  type EmailDispatcherDeps,
} from "./email-dispatcher";

export type Env = Record<string, string | undefined>;

/** The NAME of the variable holding the dispatcher secret. Never the secret. */
export const DISPATCHER_SECRET_ENV_DEFAULT = "MONACADO_EMAIL_DISPATCHER_SECRET";

/** How many deliveries one request will process. Bounded; a request is not a drain. */
export const MAX_REQUEST_LIMIT = 100;

export interface DispatcherRouteResult {
  status: number;
  body: Record<string, unknown>;
}

function constantTimeEquals(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Whether this request may run a cycle. One answer for every way of failing. */
export function isAuthorizedDispatchRequest(
  authorizationHeader: string | null,
  env: Env,
): boolean {
  const secretEnvVar = env.MONACADO_EMAIL_DISPATCHER_SECRET_ENV ?? DISPATCHER_SECRET_ENV_DEFAULT;
  const expected = (env[secretEnvVar] ?? "").trim();
  if (expected === "") return false;

  const header = authorizationHeader ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  return constantTimeEquals(header.slice(7).trim(), expected);
}

/**
 * Run one bounded dispatch cycle.
 *
 * A dispatch failure is `503`, not `500`: the work is durable and still due, so
 * the honest answer to a scheduler is "try again", not "this request was
 * malformed".
 */
export async function handleEmailDispatchRequest(
  request: {
    authorizationHeader: string | null;
    limitParam: string | null;
    now: string;
  },
  deps: EmailDispatcherDeps & { env?: Env; port?: MailPort } = {},
): Promise<DispatcherRouteResult> {
  const env = deps.env ?? process.env;

  if (!isAuthorizedDispatchRequest(request.authorizationHeader, env)) {
    return { status: 401, body: { error: "UNAUTHORIZED" } };
  }

  const parsed = Number.parseInt(request.limitParam ?? "", 10);
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, MAX_REQUEST_LIMIT)
      : DEFAULT_DISPATCH_LIMIT;

  try {
    const result = await runEmailDispatchCycle(
      { now: request.now, limit },
      deps.port,
      { ...deps, env },
    );
    return { status: 200, body: { ran: true, ...result } };
  } catch {
    /* The error is deliberately not echoed: it can carry a query, a row, or a
       rendered body. The work is durable and still due. */
    return { status: 503, body: { error: "DISPATCH_UNAVAILABLE" } };
  }
}
