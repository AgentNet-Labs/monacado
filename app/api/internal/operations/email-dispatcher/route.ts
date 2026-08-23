/**
 * POST /api/internal/operations/email-dispatcher — run one dispatch cycle
 * (Phase 1.5).
 *
 * The shape a *scheduled* invocation takes on a platform with no long-running
 * process. **No cron schedule is wired in this phase** — there is no deployment
 * configuration file in this repository to add one to, and inventing one is a
 * deployment decision rather than a notification phase's. The operator command
 * `npm run email:dispatch:once` remains the primary path.
 *
 * `POST` only: a `GET` that sent Monacado's queue would be a queue an image tag
 * could drain. Gated by a shared secret, checked in the handler, which returns
 * `401` identically for unconfigured, absent, and wrong.
 *
 * Nothing runs on import.
 */

import { handleEmailDispatchRequest } from "../../../../../src/server/notifications/email-dispatcher-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleEmailDispatchRequest({
    authorizationHeader: request.headers.get("authorization"),
    limitParam: new URL(request.url).searchParams.get("limit"),
    now: new Date().toISOString(),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}
