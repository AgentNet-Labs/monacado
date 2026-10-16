"use client";

/**
 * Edit one Product (Phase 1.38).
 *
 * Name, description, delivery type, and — for a shipped Product — the shipping
 * charge: free, or a fixed amount. Saving writes a new version of the Product;
 * the server re-renders the list, so what is shown is what is stored.
 *
 * The Product's opaque reference is held in props and put in the request path,
 * **never rendered as text**, on the same rule as the placement controls.
 *
 * **No shipping choice is pre-selected** for a shipped Product that has none:
 * whether shipping is free is the Seller's statement, never a default. Switching
 * to digital hides the choice, and the server stores no shipping charge for a
 * digital Product.
 *
 * **Saves are conditional on the state being edited.** The form holds the
 * revision token of the Product it was filled from, sends it with every save,
 * and replaces it with the token the server returns on success — kept in state
 * beside the fields, so the token always describes the content on screen. If
 * the Product changed elsewhere first, the server refuses, the form says to
 * reload, and saving is disabled until it is: a stale edit never overwrites a
 * newer one.
 *
 * Nothing here decides authority or completeness; both are the server's.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DeliveryMode } from "../../src/contracts/product/product.capsule";
import {
  DELIVERY_MODE_LABELS,
  PRODUCT_EDIT_LABEL,
  SHIPPING_CHARGE_CURRENCY,
  SHIPPING_CHARGE_HINT,
  SHIPPING_POLICY_LABELS,
} from "./account-home-copy";
import {
  minorUnitsToDecimalInput,
  submitProductRevision,
  type ShippingChoice,
} from "./product-revision-submission";

const DELIVERY_MODES = Object.keys(DELIVERY_MODE_LABELS) as DeliveryMode[];
const SHIPPING_CHOICES = Object.keys(SHIPPING_POLICY_LABELS) as Array<"FREE" | "FIXED">;

export interface ProductRevisionFormProps {
  productRef: string;
  /** The opaque revision token of the Product state shown. */
  revisionToken: string;
  /** Unique per Product, so each field keeps its own label association. */
  fieldIdPrefix: string;
  name: string;
  description: string | null;
  deliveryMode: DeliveryMode | null;
  shippingPolicy:
    | { method: "FREE" }
    | { method: "FIXED"; amountMinorUnits: number; currency: string }
    | null;
}

export function ProductRevisionForm(props: ProductRevisionFormProps) {
  const router = useRouter();
  const [name, setName] = useState(props.name);
  const [description, setDescription] = useState(props.description ?? "");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode | null>(props.deliveryMode);
  const [shippingChoice, setShippingChoice] = useState<ShippingChoice>(
    props.shippingPolicy?.method ?? null,
  );
  const [shippingAmount, setShippingAmount] = useState(
    props.shippingPolicy?.method === "FIXED"
      ? minorUnitsToDecimalInput(props.shippingPolicy.amountMinorUnits)
      : "",
  );
  const [revision, setRevision] = useState(props.revisionToken);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const id = (field: string) => `${props.fieldIdPrefix}-${field}`;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || stale) return;
    setPending(true);
    setError(undefined);

    const result = await submitProductRevision({
      productRef: props.productRef,
      expectedRevision: revision,
      name,
      description,
      deliveryMode,
      shippingChoice,
      shippingAmount,
      currency: SHIPPING_CHARGE_CURRENCY,
    });
    if (result.outcome === "revised") {
      setRevision(result.revision);
      router.refresh();
    } else {
      setError(result.message);
      if (result.conflict === true) setStale(true);
    }
    setPending(false);
  }

  return (
    <details className="account-storefront-edit">
      <summary>{PRODUCT_EDIT_LABEL}</summary>
      <form className="account-product-form" onSubmit={onSubmit} noValidate>
        {error !== undefined ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="auth-field">
          <label htmlFor={id("name")}>Product name</label>
          <input
            id={id("name")}
            name="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            disabled={pending}
          />
        </div>
        <div className="auth-field">
          <label htmlFor={id("description")}>Description</label>
          <textarea
            id={id("description")}
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
                name={id("deliveryMode")}
                value={mode}
                checked={deliveryMode === mode}
                onChange={() => setDeliveryMode(mode)}
                disabled={pending}
              />
              {DELIVERY_MODE_LABELS[mode]}
            </label>
          ))}
        </fieldset>
        {deliveryMode === "PHYSICAL" ? (
          <fieldset className="account-roles-choice">
            <legend>Shipping</legend>
            {SHIPPING_CHOICES.map((choice) => (
              <label key={choice} className="account-checkbox">
                <input
                  type="radio"
                  name={id("shippingPolicy")}
                  value={choice}
                  checked={shippingChoice === choice}
                  onChange={() => setShippingChoice(choice)}
                  disabled={pending}
                />
                {SHIPPING_POLICY_LABELS[choice]}
              </label>
            ))}
            {shippingChoice === "FIXED" ? (
              <div className="auth-field">
                <label htmlFor={id("shippingAmount")}>Shipping charge</label>
                <input
                  id={id("shippingAmount")}
                  name="shippingAmount"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={shippingAmount}
                  onChange={(e) => setShippingAmount(e.currentTarget.value)}
                  disabled={pending}
                />
                <span className="auth-hint">{SHIPPING_CHARGE_HINT}</span>
              </div>
            ) : null}
          </fieldset>
        ) : null}
        <button className="auth-button" type="submit" disabled={pending || stale}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      </form>
    </details>
  );
}
