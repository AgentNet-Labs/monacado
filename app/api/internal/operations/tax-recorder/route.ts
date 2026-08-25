/**
 * /api/internal/operations/tax-recorder — run one tax-recording cycle
 * (Phase 1.8).
 *
 * The shape a *scheduled* invocation takes on a platform with no long-running
 * process. `1.7` shipped the recorder and no way to run it; this is the way.
 * `npm run tax:record:once` remains available to an operator.
 *
 * **`GET` and `POST` both work, and both require the secret.** `GET` is accepted
 * because Vercel Cron invokes with `GET` and cannot be configured otherwise — a
 * `POST`-only endpoint would be a scheduler that could never fire. The
 * CSRF-shaped concern that made `1.5`'s dispatcher `POST`-only does not reach
 * past a mandatory `Authorization` header: a browser cannot attach one
 * cross-origin from an `<img>`, a `<script>`, or a link.
 *
 * `401` is returned identically for unconfigured, absent, wrong-scheme, and
 * wrong secret. Nothing runs on import.
 */

import { handleTaxRecorderRequest } from "../../../../../src/server/tax/tax-recorder-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function runCycle(request: Request): Promise<Response> {
  const result = await handleTaxRecorderRequest({
    authorizationHeader: request.headers.get("authorization"),
    limitParam: new URL(request.url).searchParams.get("limit"),
    now: new Date().toISOString(),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}

/** The scheduler's verb. */
export async function GET(request: Request): Promise<Response> {
  return runCycle(request);
}

/** An operator's, or a scheduler that prefers it. */
export async function POST(request: Request): Promise<Response> {
  return runCycle(request);
}
