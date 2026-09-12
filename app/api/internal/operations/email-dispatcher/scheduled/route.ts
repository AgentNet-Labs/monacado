/**
 * GET /api/internal/operations/email-dispatcher/scheduled — the recurring
 * trigger (Phase 1.27).
 *
 * The sibling of the Phase 1.5 operator endpoint, and deliberately a sibling
 * rather than a second method on it: Vercel Cron issues a **GET**, and that
 * endpoint is `POST` only for a reason it states — "a `GET` that sent Monacado's
 * queue would be a queue an image tag could drain." So the scheduled path is its
 * own route with its own gate, and the operator contract is left as reviewed.
 *
 * `GET` is safe *here* because the gate is a bearer secret rather than the
 * method: an image tag, a prefetcher, or a link scanner carries no
 * `Authorization` header and gets 401. Vercel Cron attaches
 * `Authorization: Bearer $CRON_SECRET` to every scheduled invocation, which is
 * what this checks.
 *
 * The route holds no logic. Authorisation and the cycle both live in
 * `email-dispatch-schedule-route-handler.ts`, which in turn only calls the
 * existing `runEmailDispatchCycle`. Nothing runs on import.
 */

import { handleScheduledDispatchRequest } from "../../../../../../src/server/notifications/email-dispatch-schedule-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  const result = await handleScheduledDispatchRequest({
    authorizationHeader: request.headers.get("authorization"),
    limitParam: new URL(request.url).searchParams.get("limit"),
    now: new Date().toISOString(),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
