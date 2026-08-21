/**
 * The buyer's Listing page (Phase 1.0).
 *
 * The minimum surface that exercises a real purchase: reach a Listing, see the
 * price, press a button. It is deliberately unstyled — marketplace design is not
 * this phase's subject, and a page that looked finished would invite people to
 * treat it as finished.
 *
 * ## A plain form, and no client JavaScript at all
 *
 * The checkout control is an ordinary `<form method="post">` posting to
 * `/api/checkout`, which answers `303` to Stripe's hosted page. There is no
 * client component, no `useState`, no `fetch`, no Stripe.js, and no publishable
 * key in any browser bundle. That is a security property before it is a
 * simplicity one: a card detail never touches a Monacado origin, and the
 * repository carries no browser-side payment SDK to keep patched.
 *
 * ## Nothing commercial is in the markup
 *
 * The form's only field is the Listing id. The price is *rendered* but never
 * *submitted* — a hidden amount input would be an amount the buyer could edit,
 * and the whole checkout path is built so there is no field in which an edited
 * one could arrive.
 *
 * Server component. It renders a price read through `prepareCheckout`, which
 * writes nothing, and it never learns whether the visitor is signed in — the
 * checkout route resolves that from the session cookie, so this page can hold no
 * buyer identity to leak.
 */

import { readCheckoutRuntimeConfig } from "../../../src/server/payments/checkout-runtime-config";
import { readListingCheckoutView } from "../../../src/server/payments/listing-checkout-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Minor units to a readable amount. Display only; no arithmetic decision. */
function formatAmount(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    minorUnits / 100,
  );
}

export default async function ListingPage({
  params,
}: {
  params: Promise<{ internalListingId: string }>;
}) {
  const { internalListingId } = await params;

  let view;
  try {
    const config = readCheckoutRuntimeConfig();
    view = await readListingCheckoutView({
      internalListingId: decodeURIComponent(internalListingId),
      policyId: config.policyId,
      now: new Date().toISOString(),
    });
  } catch {
    /* An unconfigured deployment shows nothing for sale rather than a price it
       cannot honour. */
    return (
      <main>
        <h1>Listing</h1>
        <p>Checkout is not available.</p>
      </main>
    );
  }

  if (!view.purchasable) {
    return (
      <main>
        <h1>Listing</h1>
        <p>This listing is not available for purchase.</p>
        {view.blockingReasons.length > 0 ? (
          <ul>
            {view.blockingReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </main>
    );
  }

  return (
    <main>
      <h1>Listing</h1>
      <p>
        Price:{" "}
        <strong>
          {formatAmount(view.buyerTotalMinorUnits ?? 0, view.currency ?? "USD")}
        </strong>
      </p>
      <p>Tax and shipping are not calculated in this phase.</p>
      <form method="post" action="/api/checkout">
        {/* The only field. Not the price, not the buyer, not an outcome. */}
        <input type="hidden" name="internalListingId" value={view.internalListingId} />
        <button type="submit">Buy now</button>
      </form>
      <p>No account is required. Checkout is completed on Stripe.</p>
    </main>
  );
}
