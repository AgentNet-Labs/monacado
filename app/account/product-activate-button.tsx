"use client";

/**
 * Activate one Product (Phase 1.39).
 *
 * A single button, rendered only where the server derived the Product as
 * `COMPLETE` with no activation blocker. The Product's opaque reference and
 * revision token are held in props and sent invisibly — never rendered as text.
 * On success the server re-renders the page, so the badge reads `Active` from
 * the same derivation that decided it; nothing is set client-side.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PRODUCT_ACTIVATE_HINT, PRODUCT_ACTIVATE_LABEL } from "./account-home-copy";
import { submitProductActivation } from "./product-activation-submission";

export function ProductActivateButton({
  productRef,
  revisionToken,
}: {
  productRef: string;
  revisionToken: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onClick() {
    if (pending) return;
    setPending(true);
    setError(undefined);

    const result = await submitProductActivation({ productRef, expectedRevision: revisionToken });
    if (result.outcome === "activated") {
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
      <p className="auth-hint">{PRODUCT_ACTIVATE_HINT}</p>
      <button className="account-placement-withdraw" type="button" onClick={onClick} disabled={pending}>
        {pending ? "Activating…" : PRODUCT_ACTIVATE_LABEL}
      </button>
    </>
  );
}
