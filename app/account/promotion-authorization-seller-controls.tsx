"use client";

/**
 * Seller Promotion Authorization controls for one Product (Phase 1.41,
 * Contract §16.2).
 *
 * Each open relationship the server found: the Promoter's declared first and
 * last name (a declaration, never shown as verified) and
 * state, with Approve / Deny for a pending request and Revoke for an approved
 * one — each Promoter independently. The opaque references are held in props
 * and never rendered. On success the server re-renders the page, so the state
 * shown is the server's; nothing is set client-side. No Offer term, commission,
 * price, or Storefront control is offered here.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SellerPromotionAuthorizationDecision } from "../../src/contracts/marketplace/promotion-authorization";
import {
  PROMOTION_APPROVE_LABEL,
  PROMOTION_AUTHORIZATION_STATE_LABELS,
  PROMOTION_DENY_LABEL,
  PROMOTION_REVOKE_LABEL,
} from "./account-home-copy";
import { submitPromotionAuthorizationDecision } from "./promotion-authorization-submission";

export function PromotionAuthorizationSellerControls({
  productRef,
  authorizations,
}: {
  productRef: string;
  authorizations: Array<{ authorizationRef: string; promoterDeclaredName: string; state: "REQUESTED" | "APPROVED" }>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function send(authorizationRef: string, decision: SellerPromotionAuthorizationDecision) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const result = await submitPromotionAuthorizationDecision({ productRef, authorizationRef, decision });
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
      <ul className="account-promotion-authorizations">
        {authorizations.map((a) => (
          <li key={a.authorizationRef}>
            <span className="account-storefront-name">{a.promoterDeclaredName}</span>
            {` — ${PROMOTION_AUTHORIZATION_STATE_LABELS[a.state]} `}
            {a.state === "REQUESTED" ? (
              <>
                <button
                  className="account-placement-withdraw"
                  type="button"
                  onClick={() => void send(a.authorizationRef, "APPROVE")}
                  disabled={pending}
                >
                  {PROMOTION_APPROVE_LABEL}
                </button>{" "}
                <button
                  className="account-placement-withdraw"
                  type="button"
                  onClick={() => void send(a.authorizationRef, "DENY")}
                  disabled={pending}
                >
                  {PROMOTION_DENY_LABEL}
                </button>
              </>
            ) : (
              <button
                className="account-placement-withdraw"
                type="button"
                onClick={() => void send(a.authorizationRef, "REVOKE")}
                disabled={pending}
              >
                {PROMOTION_REVOKE_LABEL}
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
