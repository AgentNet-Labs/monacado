"use client";

/**
 * Draft Product control (Phase 1.32).
 *
 * The creator's facts and nothing commercial: name, description, delivery,
 * availability, and whether promoters may feature it. Delivery has no default —
 * whether a buyer is asked for an address must be the creator's statement, never
 * a guess. On success the page is refreshed so the server renders the new draft.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  DeliveryMode,
  GeneralAvailabilityState,
} from "../../src/contracts/product/product.capsule";
import { AVAILABILITY_LABELS, DELIVERY_MODE_LABELS } from "./account-home-copy";
import { submitDraftProduct } from "./product-submission";

const DELIVERY_MODES = Object.keys(DELIVERY_MODE_LABELS) as DeliveryMode[];
const AVAILABILITY_STATES = Object.keys(AVAILABILITY_LABELS) as GeneralAvailabilityState[];

export function ProductForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode | null>(null);
  const [availability, setAvailability] = useState<GeneralAvailabilityState>("available");
  const [promotable, setPromotable] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);

    const result = await submitDraftProduct({
      name,
      description,
      promotable,
      generalAvailabilityState: availability,
      deliveryMode,
    });
    if (result.outcome === "created") {
      router.refresh();
      setName("");
      setDescription("");
      setDeliveryMode(null);
      setAvailability("available");
      setPromotable(false);
    } else {
      setError(result.message);
    }
    setPending(false);
  }

  return (
    <form className="account-product-form" onSubmit={onSubmit} noValidate>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="auth-field">
        <label htmlFor="product-name">Product name</label>
        <input
          id="product-name"
          name="name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={pending}
        />
      </div>
      <div className="auth-field">
        <label htmlFor="product-description">Description (optional)</label>
        <textarea
          id="product-description"
          name="description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          disabled={pending}
        />
      </div>
      <fieldset className="account-roles-choice">
        <legend>Delivery</legend>
        {DELIVERY_MODES.map((mode) => (
          <label key={mode} className="account-checkbox">
            <input
              type="radio"
              name="deliveryMode"
              value={mode}
              checked={deliveryMode === mode}
              onChange={() => setDeliveryMode(mode)}
              disabled={pending}
            />
            {DELIVERY_MODE_LABELS[mode]}
          </label>
        ))}
      </fieldset>
      <div className="auth-field">
        <label htmlFor="product-availability">Availability</label>
        <select
          id="product-availability"
          name="generalAvailabilityState"
          value={availability}
          onChange={(e) => setAvailability(e.currentTarget.value as GeneralAvailabilityState)}
          disabled={pending}
        >
          {AVAILABILITY_STATES.map((state) => (
            <option key={state} value={state}>
              {AVAILABILITY_LABELS[state]}
            </option>
          ))}
        </select>
      </div>
      <label className="account-checkbox account-product-promotable">
        <input
          type="checkbox"
          name="promotable"
          checked={promotable}
          onChange={(e) => setPromotable(e.currentTarget.checked)}
          disabled={pending}
        />
        Promoters may feature this product
      </label>
      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add draft product"}
      </button>
    </form>
  );
}
