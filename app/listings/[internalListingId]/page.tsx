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
 * The form carries the Listing id and the buyer's own details. The price is
 * *rendered* but never *submitted* — a hidden amount input would be an amount the
 * buyer could edit, and the whole checkout path is built so there is no field in
 * which an edited one could arrive.
 *
 * Buyer name, contact, and address fields were added by the Phase 1.2
 * correction, because completing a purchase is not anonymous: a merchant of
 * record cannot source tax, send a receipt, or answer support without them. That
 * widens what a client *supplies*; it weakens nothing about what the route
 * *refuses*. **No card field appears here and none ever will** — payment details
 * are entered on Stripe's page and never touch a Monacado origin.
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
      <p>Tax is calculated at checkout from your billing address.</p>
      {/* Buyer details are collected here because completing a purchase is not
          anonymous: Monacado cannot source tax, send a receipt, or answer a
          support question without them. Still no price, no policy, no party, and
          no payment outcome — an address is none of those. Card details are
          never asked for here and never touch this origin. */}
      <form method="post" action="/api/checkout">
        <input type="hidden" name="internalListingId" value={view.internalListingId} />

        <fieldset>
          <legend>Your details</legend>
          <p>
            <label htmlFor="buyerName">Full name</label>
            <input id="buyerName" name="buyerName" required maxLength={200} />
          </p>
          <p>
            <label htmlFor="buyerEmail">Email</label>
            <input id="buyerEmail" name="buyerEmail" type="email" required maxLength={320} />
          </p>
        </fieldset>

        <fieldset>
          <legend>Billing address</legend>
          <p>
            <label htmlFor="billingLine1">Address line 1</label>
            <input id="billingLine1" name="billingLine1" required maxLength={200} />
          </p>
          <p>
            <label htmlFor="billingLine2">Address line 2 (optional)</label>
            <input id="billingLine2" name="billingLine2" maxLength={200} />
          </p>
          <p>
            <label htmlFor="billingCity">City</label>
            <input id="billingCity" name="billingCity" required maxLength={120} />
          </p>
          <p>
            {/* Bounded subdivision code. Nullable because most of the world does
                not tax subnationally. */}
            <label htmlFor="billingRegion">State / region code (optional)</label>
            <input id="billingRegion" name="billingRegion" maxLength={8} placeholder="CA" />
          </p>
          <p>
            <label htmlFor="billingPostalCode">Postal code (optional)</label>
            <input id="billingPostalCode" name="billingPostalCode" maxLength={32} />
          </p>
          <p>
            {/* Required: the one field tax sourcing cannot proceed without. */}
            <label htmlFor="billingCountryCode">Country code</label>
            <input
              id="billingCountryCode"
              name="billingCountryCode"
              required
              maxLength={2}
              minLength={2}
              placeholder="US"
            />
          </p>
        </fieldset>

        <fieldset>
          {/* Required only when the basket contains something physical — decided
              from explicit Product delivery modes, never inferred. An all-digital
              purchase is never asked, and anything typed here is discarded:
              demanding a delivery address for a download is friction with no
              purpose. Whether it is needed is not something this page can know,
              so the fields are offered and the service decides. */}
          <legend>Delivery address (required for physical items)</legend>
          <p>
            <label htmlFor="shippingLine1">Address line 1</label>
            <input id="shippingLine1" name="shippingLine1" maxLength={200} />
          </p>
          <p>
            <label htmlFor="shippingLine2">Address line 2 (optional)</label>
            <input id="shippingLine2" name="shippingLine2" maxLength={200} />
          </p>
          <p>
            <label htmlFor="shippingCity">City</label>
            <input id="shippingCity" name="shippingCity" maxLength={120} />
          </p>
          <p>
            <label htmlFor="shippingRegion">State / region code (optional)</label>
            <input id="shippingRegion" name="shippingRegion" maxLength={8} placeholder="NY" />
          </p>
          <p>
            <label htmlFor="shippingPostalCode">Postal code (optional)</label>
            <input id="shippingPostalCode" name="shippingPostalCode" maxLength={32} />
          </p>
          <p>
            <label htmlFor="shippingCountryCode">Country code</label>
            <input
              id="shippingCountryCode"
              name="shippingCountryCode"
              maxLength={2}
              minLength={2}
              placeholder="US"
            />
          </p>
        </fieldset>

        <button type="submit">Buy now</button>
      </form>
      <p>
        No account is required. Payment is completed on Stripe, which is where
        card details are entered — they never reach Monacado.
      </p>
    </main>
  );
}
