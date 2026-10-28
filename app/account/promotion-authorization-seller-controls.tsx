"use client";

/**
 * Seller Promotion Authorization controls for one Product (Phase 1.41,
 * Contract §16.2).
 *
 * Each open relationship the server found: the Promoter's mName (Phase 1.43 —
 * never a declared name, `Account.name`, or email) and state, with Approve /
 * Deny for a pending request and Revoke for an approved one — each Promoter
 * independently. A Promoter with no mName is shown as such, never named by
 * anything else, and is not offered Approve. Phase 1.44: an APPROVED Promoter
 * also shows whether it has accepted the current terms — the exact versions
 * and the date, never an id. The opaque references are held in props
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
  PROMOTION_PROMOTER_MNAME_MISSING,
  PROMOTION_REVOKE_LABEL,
  promotionTermsAcceptanceStatus,
} from "./account-home-copy";
import { submitPromotionAuthorizationDecision } from "./promotion-authorization-submission";

export function PromotionAuthorizationSellerControls({
  productRef,
  authorizations,
}: {
  productRef: string;
  authorizations: Array<{
    authorizationRef: string;
    promoterMName: string | null;
    state: "REQUESTED" | "APPROVED";
    canApprove: boolean;
    termsAcceptance: {
      packageAccepted: boolean;
      acceptance: { standingVersion: string; promotionVersion: string | null; acceptedAt: string } | null;
    } | null;
  }>;
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
            <span className="account-storefront-name">{a.promoterMName ?? PROMOTION_PROMOTER_MNAME_MISSING}</span>
            {` — ${PROMOTION_AUTHORIZATION_STATE_LABELS[a.state]}`}
            {a.termsAcceptance !== null ? ` · ${promotionTermsAcceptanceStatus(a.termsAcceptance)}` : ""}{" "}
            {a.state === "REQUESTED" ? (
              <>
                {a.canApprove ? (
                  <>
                    <button
                      className="account-placement-withdraw"
                      type="button"
                      onClick={() => void send(a.authorizationRef, "APPROVE")}
                      disabled={pending}
                    >
                      {PROMOTION_APPROVE_LABEL}
                    </button>{" "}
                  </>
                ) : null}
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
