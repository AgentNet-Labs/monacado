"use client";

/**
 * Request to Promote, from a catalog detail page (Phase 1.43).
 *
 * The Phase 1.41 request, unchanged: `POST
 * /api/products/{productRef}/promotion-authorization/request` through the same
 * submission helper `/account` uses, so the gate, the refusals, and their
 * wording are one thing. On success the server re-renders the page and the
 * state shown is the server's. No negotiation, and no acceptance of the terms
 * shown — the Seller decides.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { submitPromotionAuthorizationRequest } from "../../account/promotion-authorization-submission";
import { CATALOG_AUTHORIZATION_LABELS } from "../promote-copy";

export function RequestToPromoteButton({
  productRef,
  authorization,
  canRequest,
  refusalMessage,
}: {
  productRef: string;
  authorization: "NONE" | "REQUESTED" | "APPROVED";
  canRequest: boolean;
  /** Why the viewer cannot request yet; `null` when it can. */
  refusalMessage: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (authorization !== "NONE") {
    return <p className="promote-card-state">{CATALOG_AUTHORIZATION_LABELS[authorization]}</p>;
  }

  async function request() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const result = await submitPromotionAuthorizationRequest({ productRef });
    if (result.outcome === "updated") router.refresh();
    else setError(result.message);
    setPending(false);
  }

  return (
    <>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      {!canRequest && refusalMessage !== null ? <p className="auth-hint">{refusalMessage}</p> : null}
      <button className="auth-button" type="button" onClick={() => void request()} disabled={pending || !canRequest}>
        {CATALOG_AUTHORIZATION_LABELS.NONE}
      </button>
    </>
  );
}
