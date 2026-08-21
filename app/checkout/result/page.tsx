/**
 * The buyer's return page (Phase 1.0).
 *
 * Where Stripe sends the buyer afterwards, and **the page that proves the design
 * works**: it reads the Order from Monacado's database and reports what
 * Monacado's own records say. It is reachable by anyone with the URL, it is
 * reachable with any query string, and it can change nothing.
 *
 * ## Arriving here is not evidence of payment
 *
 * Stripe's success URL is just a redirect target — a buyer can navigate to it by
 * hand, bookmark it, or reach it after cancelling. So this page asserts nothing
 * and asks nothing to be marked paid. It renders the lifecycle it finds:
 *
 *   - `PAID` — the webhook verified Stripe's signed statement and the sale is
 *     recorded, with its economics, obligations, evidence, and notices.
 *   - `PENDING_PAYMENT` — ordinary and expected. The redirect frequently beats
 *     the webhook by a moment, and a delayed-notification method can leave it
 *     here for much longer. Pending means *not yet known*, never *failed*.
 *   - `PAYMENT_FAILED` / `CANCELLED` — no sale, and no economics anywhere.
 *
 * ## The guest claim code
 *
 * `0M.9` mints it once, stores only its digest, and cannot re-issue it. The
 * checkout route put it in a short-lived `HttpOnly` cookie so this page can show
 * it exactly once, on the buyer's own machine. It is never in the URL — a query
 * parameter would put a bearer credential into browser history, into a `Referer`
 * header, and into Stripe's redirect logs.
 *
 * Server component. No client JavaScript, no polling, and no Stripe SDK: a reload
 * is the refresh.
 */

import { cookies } from "next/headers";
import { GUEST_CLAIM_COOKIE_NAME } from "../../../src/server/payments/checkout-route-handler";
import { handleOrderStatusRequest } from "../../../src/server/payments/order-status-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatAmount(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    minorUnits / 100,
  );
}

const HEADLINE: Record<string, string> = {
  PAID: "Payment received",
  PENDING_PAYMENT: "Payment pending",
  PAYMENT_FAILED: "Payment failed",
  CANCELLED: "Order cancelled",
};

const EXPLANATION: Record<string, string> = {
  PAID: "Your order is complete.",
  PENDING_PAYMENT:
    "Stripe has not yet confirmed this payment to Monacado. Reload this page in a moment.",
  PAYMENT_FAILED: "No payment was taken and no order was completed.",
  CANCELLED: "This order was cancelled before payment completed.",
};

export default async function CheckoutResultPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.orderId;
  const orderId = typeof raw === "string" ? raw : null;

  if (orderId === null) {
    return (
      <main>
        <h1>Checkout</h1>
        <p>No order was identified.</p>
      </main>
    );
  }

  /* The same handler the JSON route uses, so the page and the API cannot report
     different things about one Order. */
  const result = await handleOrderStatusRequest(
    new URLSearchParams({ orderId }),
  );

  if (result.status !== 200) {
    return (
      <main>
        <h1>Checkout</h1>
        <p>That order could not be found.</p>
      </main>
    );
  }

  const status = result.body as {
    orderId: string;
    lifecycle: string;
    currency: string;
    buyerTotalMinorUnits: number;
    paymentFailureCode: string | null;
  };

  const claimCode = (await cookies()).get(GUEST_CLAIM_COOKIE_NAME)?.value ?? null;

  return (
    <main>
      <h1>{HEADLINE[status.lifecycle] ?? "Checkout"}</h1>
      <p>{EXPLANATION[status.lifecycle] ?? ""}</p>
      <dl>
        <dt>Order</dt>
        <dd>{status.orderId}</dd>
        <dt>Total</dt>
        <dd>{formatAmount(status.buyerTotalMinorUnits, status.currency)}</dd>
        <dt>Status</dt>
        <dd>{status.lifecycle}</dd>
        {status.paymentFailureCode !== null ? (
          <>
            <dt>Reason</dt>
            <dd>{status.paymentFailureCode}</dd>
          </>
        ) : null}
      </dl>
      {claimCode !== null && claimCode !== "" ? (
        <section>
          <h2>Your claim code</h2>
          <p>
            Save this. It is shown once and Monacado cannot re-issue it — only its
            digest was stored. It is how you attach this purchase to an account
            later.
          </p>
          <p>
            <code>{claimCode}</code>
          </p>
        </section>
      ) : null}
    </main>
  );
}
