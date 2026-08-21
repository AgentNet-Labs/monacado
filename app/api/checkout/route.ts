/**
 * POST /api/checkout — begin one buyer checkout (Phase 1.0).
 *
 * A translation layer and nothing else, on the same terms as this repository's
 * first route: every rule — origin refusal, body parsing, session resolution,
 * Order placement, payment initiation, response shaping — lives in
 * `handleBeginCheckoutRequest`, which takes headers and a body string and returns
 * a status, headers, and a redirect target. This file converts Next.js
 * `Request`/`Response` at the edges so no decision can hide inside a framework
 * object where a test cannot reach it.
 *
 * **`POST` only.** No `GET`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `HEAD` is
 * exported, and Next returns 405 for a method a route does not export — so the
 * absence of those handlers *is* the enforcement. A `GET` that began a checkout
 * would be a checkout an image tag could start.
 *
 * **Never cached, never prerendered.** It writes an Order.
 *
 * Nothing runs on import: no Stripe client is constructed, no credential is read,
 * and no database connection is opened until a request arrives.
 */

import { handleBeginCheckoutRequest } from "../../../src/server/payments/checkout-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleBeginCheckoutRequest({
    contentType: request.headers.get("content-type"),
    originHeader: request.headers.get("origin"),
    cookieHeader: request.headers.get("cookie"),
    rawBody: await request.text(),
  });

  return new Response(result.body === null ? null : JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
