"use client";

/**
 * The Promoter's Promotion Authorization controls (Phase 1.41).
 *
 * A request form naming a Product by the reference its Seller shared — there is
 * deliberately no search, browse, or discovery here — and the Promoter's
 * current relationship for each Product it has asked about: the state, Cancel
 * where governed (`REQUESTED`, `APPROVED`), and Request again after a terminal
 * state. No Product fact is shown: the reference is what the Promoter itself
 * supplied. On success the server re-renders the page.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { PromotionAuthorizationState } from "../../src/contracts/marketplace/promotion-authorization";
import {
  PROMOTION_AUTHORIZATION_STATE_LABELS,
  PROMOTION_NONE,
  PROMOTION_REQUEST_AGAIN_LABEL,
  PROMOTION_REQUEST_FIELD_LABEL,
  PROMOTION_REQUEST_LABEL,
  promotionCancelLabel,
} from "./account-home-copy";
import {
  submitPromotionAuthorizationCancel,
  submitPromotionAuthorizationRequest,
  type PromotionAuthorizationOutcome,
} from "./promotion-authorization-submission";

export function PromotionAuthorizationPromoterSection({
  canRequest,
  authorizations,
}: {
  canRequest: boolean;
  authorizations: Array<{
    productRef: string;
    authorizationRef: string;
    state: PromotionAuthorizationState;
    canCancel: boolean;
    canRequestAgain: boolean;
  }>;
}) {
  const router = useRouter();
  const [productRef, setProductRef] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function run(action: () => Promise<PromotionAuthorizationOutcome>, onDone?: () => void) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const result = await action();
    if (result.outcome === "updated") {
      onDone?.();
      router.refresh();
    } else {
      setError(result.message);
    }
    setPending(false);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(() => submitPromotionAuthorizationRequest({ productRef }), () => setProductRef(""));
  }

  return (
    <>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      {authorizations.length === 0 ? (
        <p className="auth-hint">{PROMOTION_NONE}</p>
      ) : (
        <ul className="account-promotion-requests">
          {authorizations.map((a) => (
            <li key={a.authorizationRef}>
              <span className="account-storefront-name">{a.productRef}</span>
              {` — ${PROMOTION_AUTHORIZATION_STATE_LABELS[a.state]} `}
              {a.canCancel ? (
                <button
                  className="account-placement-withdraw"
                  type="button"
                  onClick={() =>
                    void run(() =>
                      submitPromotionAuthorizationCancel({
                        productRef: a.productRef,
                        authorizationRef: a.authorizationRef,
                      }),
                    )
                  }
                  disabled={pending}
                >
                  {promotionCancelLabel(a.state)}
                </button>
              ) : a.canRequestAgain ? (
                <button
                  className="account-placement-withdraw"
                  type="button"
                  onClick={() => void run(() => submitPromotionAuthorizationRequest({ productRef: a.productRef }))}
                  disabled={pending}
                >
                  {PROMOTION_REQUEST_AGAIN_LABEL}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canRequest ? (
        <form className="account-product-form" onSubmit={onSubmit} noValidate>
          <div className="auth-field">
            <label htmlFor="promotion-product-ref">{PROMOTION_REQUEST_FIELD_LABEL}</label>
            <input
              id="promotion-product-ref"
              name="productRef"
              type="text"
              autoComplete="off"
              value={productRef}
              onChange={(e) => setProductRef(e.currentTarget.value)}
              disabled={pending}
            />
          </div>
          <button className="auth-button" type="submit" disabled={pending}>
            {PROMOTION_REQUEST_LABEL}
          </button>
        </form>
      ) : null}
    </>
  );
}
