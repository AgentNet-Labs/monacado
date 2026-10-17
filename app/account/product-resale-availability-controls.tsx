"use client";

/**
 * Seller resale-availability controls for one Product (Phase 1.40).
 *
 * One button per governed change the server found permitted now; where it holds
 * `AVAILABLE` back because the Product is not active, the reason instead of the
 * button. Withdrawal asks once more before sending, because nothing here undoes
 * it. The Product's opaque reference is held in props and never rendered. On
 * success the server re-renders the page, so the state shown is the server's;
 * nothing is set client-side.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  ProductResaleAvailability,
  ResaleAvailabilityRefusal,
} from "../../src/contracts/product/product-resale-availability";
import {
  RESALE_REQUIRES_ACTIVE,
  RESALE_WITHDRAW_CONFIRM,
  RESALE_WITHDRAW_WARNING,
  RESALE_WITHDRAWN_NOTE,
  resaleActionLabel,
} from "./account-home-copy";
import { submitProductResaleAvailability } from "./product-resale-availability-submission";

export function ProductResaleAvailabilityControls({
  productRef,
  current,
  options,
}: {
  productRef: string;
  current: ProductResaleAvailability;
  options: Array<{ target: ProductResaleAvailability; refusal: ResaleAvailabilityRefusal | null }>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function send(target: ProductResaleAvailability) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const result = await submitProductResaleAvailability({ productRef, resaleAvailability: target });
    if (result.outcome === "updated") {
      setConfirmingWithdraw(false);
      router.refresh();
    } else {
      setError(result.message);
    }
    setPending(false);
  }

  if (current === "WITHDRAWN") return <p className="auth-hint">{RESALE_WITHDRAWN_NOTE}</p>;

  const permitted = options.filter((o) => o.refusal === null);
  const heldForLifecycle = options.some((o) => o.refusal === "PRODUCT_NOT_ACTIVE");

  return (
    <>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      {heldForLifecycle ? <p className="auth-hint">{RESALE_REQUIRES_ACTIVE}</p> : null}
      {permitted.map(({ target }) =>
        target === "WITHDRAWN" && confirmingWithdraw ? (
          <span key={target}>
            <span className="auth-hint">{RESALE_WITHDRAW_WARNING}</span>{" "}
            <button
              className="account-placement-withdraw"
              type="button"
              onClick={() => void send("WITHDRAWN")}
              disabled={pending}
            >
              {RESALE_WITHDRAW_CONFIRM}
            </button>
          </span>
        ) : (
          <button
            key={target}
            className="account-placement-withdraw"
            type="button"
            onClick={() => (target === "WITHDRAWN" ? setConfirmingWithdraw(true) : void send(target))}
            disabled={pending}
          >
            {resaleActionLabel(current, target)}
          </button>
        ),
      )}
    </>
  );
}
