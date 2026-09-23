"use client";

/**
 * Price one draft placement (Phase 1.36).
 *
 * One amount field and a button, inside a disclosure so a list of placements
 * stays a list rather than becoming a form per row. The placement's opaque
 * reference is held in component state and put in the request path — **never
 * rendered as text**, on the same rule the placement form follows for
 * `productRef` and the withdraw button for `listingRef`: a person acts on the
 * thing they recognise, and the identifier travels invisibly.
 *
 * **A currency input, not a minor-unit one.** The field is pre-filled with the
 * price already stored, so changing one is editing what is there rather than
 * retyping it from scratch, and the currency is shown beside the field rather
 * than offered as a choice — `USD` is the only currency this phase prices in,
 * and a select with one option is a decision nobody is being asked to make.
 *
 * `inputMode="decimal"` rather than `type="number"`: a number input hands back
 * a browser-normalized value and invites the spinner arithmetic that turns a
 * price into a float. The string the person typed is what is sent, and the
 * server converts it.
 *
 * Nothing here decides authority. Whether this placement may be priced is the
 * domain's answer, asked again inside the write; this component only shows the
 * control the projection said to show.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  PLACEMENT_PRICE_CHANGE_LABEL,
  PLACEMENT_PRICE_CURRENCY,
  PLACEMENT_PRICE_FIELD_LABEL,
  PLACEMENT_PRICE_HINT,
  PLACEMENT_PRICE_NOTE,
  PLACEMENT_PRICE_SET_LABEL,
} from "./account-home-copy";
import { submitPlacementPrice } from "./placement-price-submission";

export function PlacementPriceForm({
  listingRef,
  fieldId,
  currentAmount,
}: {
  listingRef: string;
  /** Unique per placement, so each field keeps its own label association. */
  fieldId: string;
  /** The stored price as a plain decimal, or `""` while unpriced. */
  currentAmount: string;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(currentAmount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const label = currentAmount === "" ? PLACEMENT_PRICE_SET_LABEL : PLACEMENT_PRICE_CHANGE_LABEL;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);

    const result = await submitPlacementPrice({
      listingRef,
      amount,
      currency: PLACEMENT_PRICE_CURRENCY,
    });
    if (result.outcome === "priced") {
      /* The server re-renders the list from the new source version, so the
         price shown is the price stored. Nothing is updated client-side. */
      router.refresh();
    } else {
      setError(result.message);
      setPending(false);
    }
  }

  return (
    <details className="account-placement-price">
      <summary>{label}</summary>
      <form className="account-placement-price-form" onSubmit={onSubmit} noValidate>
        <p className="auth-hint">{PLACEMENT_PRICE_NOTE}</p>
        {error !== undefined ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="auth-field">
          <label htmlFor={fieldId}>{PLACEMENT_PRICE_FIELD_LABEL}</label>
          <input
            id={fieldId}
            name="amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            disabled={pending}
          />
          <span className="auth-hint">{PLACEMENT_PRICE_HINT}</span>
        </div>
        <button className="auth-button" type="submit" disabled={pending}>
          {pending ? "Saving…" : label}
        </button>
      </form>
    </details>
  );
}
