"use client";

/**
 * The Seller's Offer for one Product (Phase 1.42, Contract §12, §16, §19).
 *
 * Shows what the server derived — lifecycle, which terms are in force, the
 * standing terms with their exact commission and gross proceeds, the policy
 * version, the promotion and its status, and the first readiness blocker — and
 * offers only the acts the server found available. Every act re-decides on the
 * server. Confirmation is never assumed: activation echoes the standing
 * economics the page shows, and a revision or promotion first asks the server
 * for the exact economics of the version it would mint, shows them, and sends
 * them back only when the Seller confirms. No Promoter sees any of this.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SellerProductOffer } from "../../src/server/marketplace/offer-read-service";
import {
  OFFER_EFFECTIVE_LABELS,
  OFFER_LIFECYCLE_LABELS,
  formatOfferBlocker,
  formatOfferCommission,
  formatOfferEconomics,
  formatOfferPromotionStatus,
  formatRetailPrice,
} from "./account-home-copy";
import {
  OFFER_INVALID,
  confirmationFrom,
  instantFromLocal,
  offerActEndpoint,
  offerCreateEndpoint,
  postOffer,
  termsBody,
  type OfferDisclosure,
  type OfferOutcome,
} from "./offer-submission";

type Pending = { url: string; body: Record<string, unknown>; disclosure: OfferDisclosure };

function TermsInputs({ prefix }: { prefix: string }) {
  return (
    <>
      <label htmlFor={`${prefix}-wholesale`}>Wholesale price (USD)</label>
      <input id={`${prefix}-wholesale`} name="wholesalePrice" inputMode="decimal" placeholder="19.99" required />
      <label htmlFor={`${prefix}-method`}>Promoter commission</label>
      <select id={`${prefix}-method`} name="commissionMethod" defaultValue="PERCENT_OF_WHOLESALE">
        <option value="PERCENT_OF_WHOLESALE">Percent of wholesale</option>
        <option value="FIXED_AMOUNT">Fixed amount (USD)</option>
      </select>
      <input name="commissionValue" inputMode="decimal" placeholder="10" aria-label="Commission value" required />
    </>
  );
}

const fieldsOf = (form: HTMLFormElement) => {
  const data = new FormData(form);
  return {
    wholesalePrice: String(data.get("wholesalePrice") ?? ""),
    commissionMethod: (String(data.get("commissionMethod")) === "FIXED_AMOUNT" ? "FIXED_AMOUNT" : "PERCENT_OF_WHOLESALE") as
      | "FIXED_AMOUNT"
      | "PERCENT_OF_WHOLESALE",
    commissionValue: String(data.get("commissionValue") ?? ""),
    effectiveFrom: String(data.get("effectiveFrom") ?? ""),
    effectiveUntil: String(data.get("effectiveUntil") ?? ""),
  };
};

export function OfferSellerControls({ productRef, offer }: { productRef: string; offer: SellerProductOffer }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const view = offer.offer;

  async function send(url: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const result: OfferOutcome = await postOffer(url, body);
    if (result.outcome === "updated") {
      setPending(undefined);
      router.refresh();
    } else if (result.outcome === "confirm") {
      setPending({ url, body, disclosure: result.disclosure });
    } else {
      setError(result.message);
    }
    setBusy(false);
  }

  function submitTerms(event: React.FormEvent<HTMLFormElement>, url: string, extra: Record<string, unknown>) {
    event.preventDefault();
    const terms = termsBody(fieldsOf(event.currentTarget));
    if (terms === null) return setError(OFFER_INVALID);
    void send(url, { ...extra, terms });
  }

  function submitPromotion(event: React.FormEvent<HTMLFormElement>, replace: boolean) {
    event.preventDefault();
    if (view === null) return;
    const f = fieldsOf(event.currentTarget);
    const from = instantFromLocal(f.effectiveFrom);
    const until = instantFromLocal(f.effectiveUntil);
    const wholesalePrice = f.wholesalePrice.trim();
    if (from === null || until === null || wholesalePrice === "") return setError(OFFER_INVALID);
    void send(offerActEndpoint(productRef, view.offerRef, replace ? "promotions/replace" : "promotions"), {
      expectedVersion: view.standing.version,
      ...(replace && view.promotion !== null ? { expectedPromotionVersion: view.promotion.version } : {}),
      wholesalePrice,
      effectiveFrom: from,
      effectiveUntil: until,
      /* Deliberately unconfirmed: the server answers with the exact economics
         of the version it would mint, and the Seller confirms those. */
    });
  }

  const errorLine =
    error !== undefined ? (
      <p className="auth-error" role="alert">
        {error}
      </p>
    ) : null;

  if (pending !== undefined && view !== null) {
    const d = pending.disclosure;
    return (
      <div className="account-offer">
        {errorLine}
        <p className="auth-hint">
          {`Confirm version ${d.version}: promoter commission ${formatRetailPrice(d.calculatedCommissionMinorUnits, view.standing.currency)} · you receive ${formatRetailPrice(d.calculatedSellerGrossProceedsMinorUnits, view.standing.currency)} per sale before fees · policy ${d.commissionCalculationPolicyVersion}`}
        </p>
        <button
          className="account-placement-withdraw"
          type="button"
          disabled={busy}
          onClick={() => void send(pending.url, { ...pending.body, confirmation: confirmationFrom(d) })}
        >
          Confirm
        </button>{" "}
        <button className="account-placement-withdraw" type="button" disabled={busy} onClick={() => setPending(undefined)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="account-offer">
      {errorLine}
      {view === null ? null : (
        <>
          <p className="auth-hint">
            {`Offer — ${OFFER_LIFECYCLE_LABELS[view.lifecycle]} · ${OFFER_EFFECTIVE_LABELS[view.effective]}`}
            {view.offerEffectiveUntil !== null ? ` · ends ${new Date(view.offerEffectiveUntil).toLocaleString()}` : ""}
          </p>
          <p className="auth-hint">
            {`Standing terms (version ${view.standing.version}): ${formatOfferCommission(view.standing.commission, view.standing.currency)} · ${formatOfferEconomics(view.standing)}`}
          </p>
          {view.promotion !== null ? (
            <p className="auth-hint">
              {`Promotion (version ${view.promotion.version}) — ${formatOfferPromotionStatus(view.promotion, view.lifecycle)}, ${new Date(view.promotion.effectiveFrom).toLocaleString()} to ${new Date(view.promotion.effectiveUntil).toLocaleString()}: ${formatOfferEconomics(view.promotion)}`}
            </p>
          ) : null}
          {view.blockers.length > 0 ? <p className="auth-hint">{formatOfferBlocker(view.blockers)}</p> : null}
          <p>
            {view.actions.activate ? (
              <button
                className="account-placement-withdraw"
                type="button"
                disabled={busy}
                onClick={() =>
                  void send(offerActEndpoint(productRef, view.offerRef, "activate"), {
                    confirmation: confirmationFrom({
                      version: view.standing.version,
                      calculatedCommissionMinorUnits: view.standing.calculatedCommissionMinorUnits,
                      calculatedSellerGrossProceedsMinorUnits: view.standing.calculatedSellerGrossProceedsMinorUnits,
                      commissionCalculationPolicyVersion: view.standing.commissionCalculationPolicyVersion,
                    }),
                  })
                }
              >
                Confirm terms and activate
              </button>
            ) : null}
            {view.actions.pause ? (
              <button className="account-placement-withdraw" type="button" disabled={busy} onClick={() => void send(offerActEndpoint(productRef, view.offerRef, "pause"), {})}>
                Pause
              </button>
            ) : null}
            {view.actions.resume ? (
              <button
                className="account-placement-withdraw"
                type="button"
                disabled={busy}
                onClick={() => void send(offerActEndpoint(productRef, view.offerRef, "resume"), { expectedVersion: view.standing.version })}
              >
                Resume
              </button>
            ) : null}
            {view.actions.endPromotion && view.promotion !== null ? (
              <button
                className="account-placement-withdraw"
                type="button"
                disabled={busy}
                onClick={() =>
                  void send(offerActEndpoint(productRef, view.offerRef, "promotions/end"), {
                    expectedPromotionVersion: view.promotion!.version,
                  })
                }
              >
                End promotion now
              </button>
            ) : null}{" "}
            {view.actions.withdraw ? (
              <button className="account-placement-withdraw" type="button" disabled={busy} onClick={() => void send(offerActEndpoint(productRef, view.offerRef, "withdraw"), {})}>
                Withdraw offer
              </button>
            ) : null}
          </p>
          {view.actions.revise ? (
            <details className="account-storefront-edit">
              <summary>Change standing terms</summary>
              <form
                onSubmit={(e) =>
                  /* Unconfirmed on a live Offer by design: the server answers with
                     the new version's exact economics for the Seller to confirm. */
                  submitTerms(e, offerActEndpoint(productRef, view.offerRef, "revise"), {
                    expectedVersion: view.standing.version,
                  })
                }
              >
                <TermsInputs prefix={`offer-revise-${productRef}`} />
                <button type="submit" disabled={busy}>
                  Review new terms
                </button>
              </form>
            </details>
          ) : null}
          {view.actions.schedulePromotion || view.actions.replacePromotion ? (
            <details className="account-storefront-edit">
              <summary>{view.actions.replacePromotion ? "Replace scheduled promotion" : "Schedule a promotion"}</summary>
              <form onSubmit={(e) => submitPromotion(e, view.actions.replacePromotion)}>
                <label htmlFor={`offer-promo-${productRef}-price`}>Promotional wholesale price (USD)</label>
                <input id={`offer-promo-${productRef}-price`} name="wholesalePrice" inputMode="decimal" required />
                <label htmlFor={`offer-promo-${productRef}-from`}>Starts</label>
                <input id={`offer-promo-${productRef}-from`} name="effectiveFrom" type="datetime-local" required />
                <label htmlFor={`offer-promo-${productRef}-until`}>Ends</label>
                <input id={`offer-promo-${productRef}-until`} name="effectiveUntil" type="datetime-local" required />
                <button type="submit" disabled={busy}>
                  Review promotion
                </button>
              </form>
            </details>
          ) : null}
        </>
      )}
      {offer.canCreate ? (
        <details className="account-storefront-edit" open={view === null}>
          <summary>{view === null ? "Create an offer for promoters" : "Create a new offer"}</summary>
          <form onSubmit={(e) => submitTerms(e, offerCreateEndpoint(productRef), {})}>
            <TermsInputs prefix={`offer-create-${productRef}`} />
            <button type="submit" disabled={busy}>
              Save draft offer
            </button>
          </form>
        </details>
      ) : null}
    </div>
  );
}
