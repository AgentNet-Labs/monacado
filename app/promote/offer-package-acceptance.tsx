"use client";

/**
 * Accept the seller's terms (Phase 1.44) — one action for the whole package.
 *
 * Shown to a Promoter whose current authorization is APPROVED, wherever the
 * server found a package it may accept: the catalog detail page and the
 * Promoter's `/account` rows. It renders exactly the server's view — the
 * standard terms, and a scheduled or running promotion with its window — and
 * ONE button: "Accept standard terms", or "Accept standard + promotional
 * terms". There is never a separate control for either part.
 *
 * The request sends the server's own view back unaltered (minus the display
 * flag `inForce`), so the server can refuse anything that is no longer exactly
 * the package in force. No retail price and no Monacado fee appear: neither is
 * part of the seller's terms. On success the server re-renders the page.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PromoterOfferPackageView } from "../../src/server/marketplace/promotion-offer-acceptance-read-service";
import { formatRetailPrice } from "../account/account-home-copy";
import { submitOfferPackageAcceptance } from "../account/promotion-authorization-submission";
import {
  ACCEPTANCE_HEADING,
  ACCEPTANCE_NOTE,
  ACCEPTANCE_VERSION_LABEL,
  ACCEPT_PACKAGE_LABEL,
  ACCEPT_STANDARD_LABEL,
  DETAIL_COMMISSION,
  DETAIL_PROMOTION_HEADING,
  DETAIL_STANDARD_TERMS,
  DETAIL_WHOLESALE,
  formatCatalogCommissionDetail,
  offerPackageStatus,
} from "./promote-copy";

function TermsList({
  heading,
  terms,
}: {
  heading: string;
  terms: PromoterOfferPackageView["standing"];
}) {
  return (
    <>
      <h3>{heading}</h3>
      <dl className="account-details">
        <dt>{ACCEPTANCE_VERSION_LABEL}</dt>
        <dd>{terms.version}</dd>
        <dt>{DETAIL_WHOLESALE}</dt>
        <dd>{formatRetailPrice(terms.wholesalePriceMinorUnits, terms.currency)}</dd>
        <dt>{DETAIL_COMMISSION}</dt>
        <dd>{formatCatalogCommissionDetail(terms.commission, terms.calculatedCommissionMinorUnits, terms.currency)}</dd>
      </dl>
    </>
  );
}

export function OfferPackageAcceptance({ productRef, view }: { productRef: string; view: PromoterOfferPackageView }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function accept() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    const promotion =
      view.promotion === null ? null : (({ inForce: _display, ...terms }) => terms)(view.promotion);
    const result = await submitOfferPackageAcceptance({
      productRef,
      authorizationRef: view.authorizationRef,
      pkg: { offerRef: view.offerRef, standing: view.standing, promotion },
    });
    if (result.outcome === "updated") router.refresh();
    else setError(result.message);
    setPending(false);
  }

  return (
    <div className="account-promotion">
      <h2>{ACCEPTANCE_HEADING}</h2>
      <p className="promote-card-state">{offerPackageStatus(view)}</p>
      <TermsList heading={DETAIL_STANDARD_TERMS} terms={view.standing} />
      {view.promotion !== null ? <TermsList heading={DETAIL_PROMOTION_HEADING(view.promotion)} terms={view.promotion} /> : null}
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      {view.acceptedAt === null ? (
        <>
          <p className="auth-hint">{ACCEPTANCE_NOTE}</p>
          <button className="auth-button" type="button" onClick={() => void accept()} disabled={pending}>
            {view.promotion === null ? ACCEPT_STANDARD_LABEL : ACCEPT_PACKAGE_LABEL}
          </button>
        </>
      ) : null}
    </div>
  );
}
