"use client";

/**
 * Seller-direct placement control (Phase 1.34).
 *
 * Two selectors and a button. The Product is chosen by name and submitted by
 * its opaque `productRef`; the Storefront is chosen by display name and
 * submitted by its public handle. **The reference is the option's value and is
 * never rendered as text** — a person picks the thing they recognise, and the
 * identifier the server needs travels with it invisibly.
 *
 * There is deliberately no price field, no currency field, no Offer selector,
 * and no "publish" or "go live" control: this creates placement, and placement
 * is not pricing. On success the page is refreshed so the server renders the
 * new draft placement.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PLACEMENT_INTRO } from "./account-home-copy";
import { submitPlacement } from "./placement-submission";

export interface PlacementOption {
  /** The value submitted — a productRef or a publicHandle. */
  value: string;
  /** What the person reads. */
  label: string;
}

export function PlacementForm({
  products,
  storefronts,
}: {
  products: PlacementOption[];
  storefronts: PlacementOption[];
}) {
  const router = useRouter();
  const [productRef, setProductRef] = useState(products[0]?.value ?? "");
  const [storefrontHandle, setStorefrontHandle] = useState(storefronts[0]?.value ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);

    const result = await submitPlacement({ productRef, storefrontHandle });
    if (result.outcome === "created") {
      router.refresh();
    } else {
      setError(result.message);
    }
    setPending(false);
  }

  return (
    <form className="account-placement-form" onSubmit={onSubmit} noValidate>
      <p className="auth-status">{PLACEMENT_INTRO}</p>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="auth-field">
        <label htmlFor="placement-product">Product</label>
        <select
          id="placement-product"
          name="productRef"
          value={productRef}
          onChange={(e) => setProductRef(e.currentTarget.value)}
          disabled={pending}
        >
          {products.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="auth-field">
        <label htmlFor="placement-storefront">Storefront</label>
        <select
          id="placement-storefront"
          name="storefrontHandle"
          value={storefrontHandle}
          onChange={(e) => setStorefrontHandle(e.currentTarget.value)}
          disabled={pending}
        >
          {storefronts.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add as draft listing"}
      </button>
    </form>
  );
}
