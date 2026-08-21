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

/**
 * The four states a buyer can land in, each said in the buyer's terms.
 *
 * The distinction that matters most is **pending versus terminal**. Pending is
 * not a failure and must never read as one: the redirect routinely beats the
 * webhook by a moment, and a buyer told "failed" who was in fact charged a second
 * later will pay twice trying to fix it.
 *
 * The second distinction is **failed versus cancelled**. A decline and an expiry
 * are different events with different next steps, and `0M.9`'s lifecycle already
 * keeps them apart — the page would be throwing that away by merging them.
 */
const OUTCOME: Record<
  string,
  { headline: string; explanation: string; terminal: boolean; charged: boolean }
> = {
  PAID: {
    headline: "Payment received",
    explanation: "Your payment is confirmed and your order is complete.",
    terminal: true,
    charged: true,
  },
  PENDING_PAYMENT: {
    headline: "Payment pending",
    explanation:
      "Stripe has not yet confirmed this payment to Monacado. This is normal for a few seconds after checkout — reload this page in a moment.",
    terminal: false,
    charged: false,
  },
  PAYMENT_FAILED: {
    headline: "Payment failed",
    explanation:
      "Your payment was not completed. No money was taken and this order was not fulfilled. To try again, start a new checkout — each attempt is a separate order.",
    terminal: true,
    charged: false,
  },
  CANCELLED: {
    headline: "Checkout expired",
    explanation:
      "This checkout was not completed in time and has been cancelled. No money was taken. You are welcome to start a new checkout.",
    terminal: true,
    charged: false,
  },
};

const UNKNOWN_OUTCOME = {
  headline: "Checkout",
  explanation: "",
  terminal: false,
  charged: false,
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
  const outcome = OUTCOME[status.lifecycle] ?? UNKNOWN_OUTCOME;

  return (
    <main>
      <h1>{outcome.headline}</h1>
      <p>{outcome.explanation}</p>
      <dl>
        <dt>Order</dt>
        <dd>{status.orderId}</dd>
        <dt>{outcome.charged ? "Total charged" : "Amount"}</dt>
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
      {/* A terminal outcome is not going to change on reload; a pending one is.
          Saying so is the difference between a buyer waiting and a buyer paying
          again. */}
      {outcome.terminal ? null : <p>This page will update once Stripe confirms the payment.</p>}
      {/* The receipt goes to the address Stripe collected. Said here because a
          guest has no account to check, and would otherwise have no idea one was
          sent — or that they should look for it. */}
      {status.lifecycle === "PAID" ? (
        <p>A confirmation has been emailed to the address you gave at checkout.</p>
      ) : null}
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
