/**
 * POST /api/notifications/email/webhook — provider email events (Phase 1.5).
 *
 * A translation layer and nothing else: every rule — authentication,
 * normalisation, idempotent ingestion, suppression, contact degradation — lives
 * in `handleProviderEmailWebhookRequest`, which takes headers and a body string
 * and returns a status and a body. This file converts Next.js `Request`/
 * `Response` at the edges so no decision can hide inside a framework object where
 * a test cannot reach it.
 *
 * **`POST` only.** Next returns 405 for a method a route does not export, so the
 * absence of the others *is* the enforcement.
 *
 * **Never cached, never prerendered.** It suppresses addresses and degrades
 * contacts.
 *
 * Nothing runs on import: no credential is read and no database connection is
 * opened until a request arrives.
 */

import {
  handleProviderEmailWebhookRequest,
  WEBHOOK_SECRET_HEADER,
} from "../../../../../src/server/notifications/email-webhook-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleProviderEmailWebhookRequest({
    authorizationHeader: request.headers.get("authorization"),
    secretHeader: request.headers.get(WEBHOOK_SECRET_HEADER),
    rawBody: await request.text(),
    receivedAt: new Date().toISOString(),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}
