/**
 * /api/internal/operations/refund-processor — run one refund cycle (Phase 1.9).
 *
 * The shape a *scheduled* invocation takes on a platform with no long-running
 * process, following `1.8`'s tax-recorder endpoint exactly. `npm run
 * refund:process:once` remains available to an operator.
 *
 * One request runs **both halves** of the lifecycle: due payment refunds, then
 * due tax reversals — including ones committed moments earlier in the same
 * cycle, which is what lets an ordinary refund complete in a single invocation.
 *
 * **`GET` and `POST` both work, and both require the secret.** `GET` is accepted
 * because Vercel Cron invokes with `GET` and cannot be configured otherwise. The
 * CSRF-shaped concern that made `1.5`'s dispatcher `POST`-only does not reach
 * past a mandatory `Authorization` header: a browser cannot attach one
 * cross-origin from an `<img>`, a `<script>`, or a link.
 *
 * **A dedicated secret**, `MONACADO_REFUND_PROCESSOR_SECRET` — not the tax
 * recorder's and not the email dispatcher's. `401` is returned identically for
 * unconfigured, absent, wrong-scheme, and wrong secret. Nothing runs on import.
 */

import { handleRefundProcessorRequest } from "../../../../../src/server/payments/refund-processor-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function runCycle(request: Request): Promise<Response> {
  const result = await handleRefundProcessorRequest({
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
