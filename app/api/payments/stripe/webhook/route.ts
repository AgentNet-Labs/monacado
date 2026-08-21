/**
 * POST /api/payments/stripe/webhook — Stripe's authoritative payment result
 * (Phase 1.0).
 *
 * The only route in the repository through which an Order can become `PAID`.
 *
 * **The body is read as raw text and handed through unmodified.** Stripe signs
 * bytes; parsing here and re-serialising in the handler would verify a signature
 * over something Stripe never sent. `request.text()` is therefore not a
 * convenience — it is the correctness requirement, and the reason this route does
 * not use `request.json()`.
 *
 * **`POST` only**, never cached, never prerendered. Nothing runs on import.
 *
 * Authentication is the signature and nothing else: there is no session, no
 * cookie, no bearer token, and no IP allow-list involved, because the signing
 * secret is what proves Stripe sent this and none of the others would.
 */

import { handleStripeWebhookRequest, STRIPE_SIGNATURE_HEADER } from "../../../../../src/server/payments/stripe-webhook-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleStripeWebhookRequest({
    rawBody: await request.text(),
    signatureHeader: request.headers.get(STRIPE_SIGNATURE_HEADER),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
