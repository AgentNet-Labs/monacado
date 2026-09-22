"use client";

/**
 * Withdraw one draft placement (Phase 1.35).
 *
 * A single button. The placement's opaque reference is held in component state
 * and put in the request path — **never rendered as text**, on the same rule the
 * placement form follows for `productRef`: a person acts on the thing they
 * recognise, and the identifier travels invisibly.
 *
 * There is no confirmation dialog, deliberately. Withdrawing a private draft
 * placement destroys nothing — the Product stays in the library, the Storefront
 * is untouched, the Listing keeps its whole history, and the same placement can
 * be made again. A modal asking "are you sure?" would imply otherwise.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PLACEMENT_WITHDRAW_LABEL } from "./account-home-copy";
import { submitPlacementWithdrawal } from "./placement-withdraw-submission";

export function PlacementWithdrawButton({ listingRef }: { listingRef: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onClick() {
    if (pending) return;
    setPending(true);
    setError(undefined);

    const result = await submitPlacementWithdrawal(listingRef);
    if (result.outcome === "withdrawn") {
      /* The server re-renders the list, so the withdrawn placement simply stops
         being current. Nothing is hidden client-side. */
      router.refresh();
    } else {
      setError(result.message);
      setPending(false);
    }
  }

  return (
    <>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="account-placement-withdraw"
        type="button"
        onClick={onClick}
        disabled={pending}
      >
        {pending ? "Removing…" : PLACEMENT_WITHDRAW_LABEL}
      </button>
    </>
  );
}
