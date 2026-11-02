"use client";

/**
 * Take a Storefront live — ACTIVE and PUBLIC (Phase 1.46).
 *
 * A single button; the handle travels in the request path. The domain decides
 * whether the Storefront may go live and the page shows its reasons when not.
 * No confirmation dialog: going live is reversible by the owner, and nothing is
 * sold until a Listing in it is itself live.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { submitStorefrontGoLive } from "./storefront-go-live-submission";

export function StorefrontGoLiveButton({ publicHandle }: { publicHandle: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onClick() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const result = await submitStorefrontGoLive(publicHandle);
    if (result.outcome === "live") {
      router.refresh();
    } else {
      setError(result.message);
    }
    setPending(false);
  }

  return (
    <>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="account-storefront-go-live" type="button" onClick={onClick} disabled={pending}>
        {pending ? "Going live…" : "Go live"}
      </button>
    </>
  );
}
