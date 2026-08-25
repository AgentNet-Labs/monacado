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
 *
 * **Phase 1.8 — the tax recording port is supplied here and only here.** It gives
 * a booked sale a best-effort immediate tax report instead of waiting for the
 * next scheduled cycle. Constructing it in the *route module* rather than in the
 * handler is what keeps every test of that handler unable to reach a network: a
 * handler with no port skips the fast path entirely and relies on the scheduler,
 * which is the guarantee regardless.
 */

import { handleStripeWebhookRequest, STRIPE_SIGNATURE_HEADER } from "../../../../../src/server/payments/stripe-webhook-route-handler";
import { createStripeTaxTransactionRecorder } from "../../../../../src/server/tax/stripe-tax-transaction-adapter";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleStripeWebhookRequest(
    {
      rawBody: await request.text(),
      signatureHeader: request.headers.get(STRIPE_SIGNATURE_HEADER),
    },
    /* Lazily constructed inside the adapter: a deployment with no tax
       configuration yields a normalised PROVIDER_NOT_CONFIGURED against the row
       rather than an exception in a webhook. */
    { taxRecordingPort: createStripeTaxTransactionRecorder() },
  );

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
