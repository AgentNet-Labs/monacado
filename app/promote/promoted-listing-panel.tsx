"use client";

/**
 * "Your listing" — the Promoter's own promoted Listings for one Product
 * (Phase 1.46).
 *
 * Shown on `/promote/{productRef}` while the Promoter's authorization for the
 * Product is APPROVED. Place the Product in a Storefront the Promoter controls (a DRAFT,
 * priced or not); set or change the price; see what Monacado keeps, what the
 * Promoter nets, and the lowest viable price under the Seller terms in force;
 * see every blocker; Activate at the version shown; Withdraw; and, once ACTIVE,
 * the buyer link.
 *
 * Everything shown is the server's: after each act the page re-renders and the
 * state is read again. No Seller proceeds, no wholesale or commission figure,
 * and no Listing copy fields — the Listing presents the Product as it is.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatRetailPrice } from "../account/account-home-copy";
import {
  blockerText,
  submitCreatePromotedListing,
  submitPromotedListingActivation,
  submitPromotedListingPrice,
  submitPromotedListingWithdrawal,
  type PromotedListingOutcome,
} from "./promoted-listing-submission";

type EconomicsView =
  | {
      ok: true;
      monacadoRetainedMinorUnits: number;
      promoterNetProceedsMinorUnits: number;
      minimumViableRetailMinorUnits: number;
      currency: string;
    }
  | { ok: false; blocker: string; minimumViableRetailMinorUnits: number | null };

export interface PanelListing {
  listingRef: string;
  storefrontHandle: string;
  lifecycle: string;
  sourceRecordVersion: string;
  retail: { retailPriceMinorUnits: number; retailPriceCurrency: string } | null;
  blockers: string[];
  economics: EconomicsView | null;
  upcomingPromotion: { effectiveFrom: string; economics: EconomicsView | null } | null;
  buyerPath: string | null;
}

function Economics({ view, currency }: { view: EconomicsView | null; currency: string }) {
  if (view === null) return <p className="auth-hint">No Seller terms are in force, so there are no economics to show.</p>;
  if (!view.ok) {
    return (
      <p className="auth-hint">
        {`This price doesn't work: ${blockerText(view.blocker)}.`}
        {view.minimumViableRetailMinorUnits !== null
          ? ` The lowest viable price is ${formatRetailPrice(view.minimumViableRetailMinorUnits, currency)}.`
          : ""}
      </p>
    );
  }
  return (
    <dl className="account-details">
      <dt>Monacado keeps</dt>
      <dd>{formatRetailPrice(view.monacadoRetainedMinorUnits, view.currency)}</dd>
      <dt>You net</dt>
      <dd>{formatRetailPrice(view.promoterNetProceedsMinorUnits, view.currency)}</dd>
      <dt>Lowest viable price</dt>
      <dd>{formatRetailPrice(view.minimumViableRetailMinorUnits, view.currency)}</dd>
    </dl>
  );
}

function useAct() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; blockers: string[] } | undefined>(undefined);
  async function run(act: () => Promise<PromotedListingOutcome>) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const result = await act();
    if (result.outcome === "done") router.refresh();
    else setError({ message: result.message, blockers: result.blockers });
    setPending(false);
  }
  const errorView =
    error === undefined ? null : (
      <div className="auth-error" role="alert">
        <p>{error.message}</p>
        {error.blockers.length > 0 ? (
          <ul>
            {error.blockers.map((b) => (
              <li key={b}>{blockerText(b)}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  return { pending, run, errorView };
}

function ListingRow({ listing }: { listing: PanelListing }) {
  const { pending, run, errorView } = useAct();
  const [amount, setAmount] = useState("");
  const currency = listing.retail?.retailPriceCurrency ?? "USD";
  const terminal = listing.lifecycle !== "DRAFT" && listing.lifecycle !== "ACTIVE";

  return (
    <li className="promote-listing">
      <p>
        <strong>{listing.storefrontHandle}</strong>
        {` — ${listing.lifecycle.toLowerCase()} · `}
        {listing.retail === null
          ? "No price set"
          : formatRetailPrice(listing.retail.retailPriceMinorUnits, listing.retail.retailPriceCurrency)}
      </p>
      {listing.buyerPath !== null ? (
        <p className="auth-hint">
          {"Buyer link: "}
          <a href={listing.buyerPath}>{listing.buyerPath}</a>
        </p>
      ) : null}
      <Economics view={listing.economics} currency={currency} />
      {listing.upcomingPromotion !== null ? (
        <>
          <p className="auth-hint">{`From ${listing.upcomingPromotion.effectiveFrom} a scheduled promotion applies:`}</p>
          <Economics view={listing.upcomingPromotion.economics} currency={currency} />
        </>
      ) : null}
      {listing.blockers.length > 0 ? (
        <>
          <p className="auth-hint">{listing.lifecycle === "DRAFT" ? "Before it can go live:" : "Not purchasable right now:"}</p>
          <ul>
            {listing.blockers.map((b) => (
              <li key={b}>{blockerText(b)}</li>
            ))}
          </ul>
        </>
      ) : null}
      {errorView}
      {!terminal ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => submitPromotedListingPrice(listing.listingRef, amount));
          }}
        >
          <label>
            {listing.retail === null ? "Set price (USD) " : "Change price (USD) "}
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="19.99" />
          </label>{" "}
          <button type="submit" disabled={pending || amount.trim() === ""}>
            Save price
          </button>
        </form>
      ) : null}
      {listing.lifecycle === "DRAFT" ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void run(() => submitPromotedListingActivation(listing.listingRef, listing.sourceRecordVersion))}
        >
          Activate
        </button>
      ) : null}{" "}
      {!terminal ? (
        <button type="button" disabled={pending} onClick={() => void run(() => submitPromotedListingWithdrawal(listing.listingRef))}>
          Withdraw
        </button>
      ) : null}
    </li>
  );
}

export function PromotedListingPanel({
  productRef,
  storefrontHandles,
  listings,
  canCreate,
}: {
  productRef: string;
  storefrontHandles: string[];
  listings: PanelListing[];
  /** The viewer's authorization is APPROVED. */
  canCreate: boolean;
}) {
  const { pending, run, errorView } = useAct();
  const [storefrontHandle, setStorefrontHandle] = useState(storefrontHandles[0] ?? "");
  const [amount, setAmount] = useState("");

  return (
    <>
      <h2>Your listing</h2>
      {listings.length > 0 ? (
        <ul className="promote-listings">
          {listings.map((l) => (
            <ListingRow key={l.listingRef} listing={l} />
          ))}
        </ul>
      ) : (
        <p className="auth-hint">You haven&apos;t listed this product yet.</p>
      )}
      {canCreate && storefrontHandles.length > 0 ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => submitCreatePromotedListing(productRef, { storefrontHandle, amount }));
          }}
        >
          {errorView}
          <label>
            {"Storefront "}
            <select value={storefrontHandle} onChange={(e) => setStorefrontHandle(e.target.value)}>
              {storefrontHandles.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            {"Price (USD, optional) "}
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="19.99" />
          </label>{" "}
          <button type="submit" disabled={pending || storefrontHandle === ""}>
            Create draft listing
          </button>
        </form>
      ) : canCreate ? (
        <p className="auth-hint">Open a storefront from your account to list this product.</p>
      ) : null}
    </>
  );
}
