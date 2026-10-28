/**
 * `/promote/{productRef}` — one Promotable Catalog Product (Phase 1.43).
 *
 * The full description, the Seller's mName (with "More from this seller",
 * `/promote?seller=<mName>` — no internal id in the URL), delivery, the terms in
 * force with the commission shown as the Offer states it, the standing terms a
 * running promotion will return to, any upcoming promotion, the Offer's own end,
 * and Request to Promote.
 *
 * A Product not in the catalog for this viewer — no such Product, not included
 * at this instant, or the viewer's own — is a 404, one answer for all three.
 */

import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { resolvePageSession } from "../../../src/server/account/page-session";
import { getPrisma } from "../../../src/server/db/client";
import { ProductRef } from "../../../src/contracts/marketplace/listing-record";
import {
  readPromotableCatalogDetail,
  resolvePromotableCatalogAccess,
  type PromotableCatalogTerms,
} from "../../../src/server/marketplace/promotable-catalog-read-service";
import { formatRetailPrice, formatPromotionRequestRefusals } from "../../account/account-home-copy";
import { SIGN_OUT_DESTINATION } from "../../account/sign-out-submission";
import {
  CATALOG_ACCOUNT_LINK,
  CATALOG_DELIVERY_LABELS,
  CATALOG_NOT_PROMOTER,
  CATALOG_TITLE,
  DETAIL_AFTER_PROMOTION,
  DETAIL_BACK,
  DETAIL_COMMISSION,
  DETAIL_DELIVERY,
  DETAIL_MORE_FROM_SELLER,
  DETAIL_OFFER_ENDS,
  DETAIL_PROMOTION_UNTIL,
  DETAIL_REQUEST_NOTE,
  DETAIL_SELLER,
  DETAIL_TERMS_NOW,
  DETAIL_UPCOMING_PROMOTION,
  DETAIL_WHOLESALE,
  formatCatalogCommissionDetail,
} from "../promote-copy";
import { RequestToPromoteButton } from "./request-to-promote-button";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function Terms({ heading, terms }: { heading: string; terms: PromotableCatalogTerms }) {
  return (
    <>
      <h2>{heading}</h2>
      <dl className="account-details">
        <dt>{DETAIL_WHOLESALE}</dt>
        <dd>{formatRetailPrice(terms.wholesalePriceMinorUnits, terms.currency)}</dd>
        <dt>{DETAIL_COMMISSION}</dt>
        <dd>{formatCatalogCommissionDetail(terms.commission, terms.calculatedCommissionMinorUnits, terms.currency)}</dd>
      </dl>
    </>
  );
}

export default async function PromoteDetailPage({ params }: { params: Promise<{ productRef: string }> }) {
  const session = await resolvePageSession((await headers()).get("cookie"));
  if (session === undefined) redirect(SIGN_OUT_DESTINATION);

  const db = getPrisma();
  const access = await resolvePromotableCatalogAccess(db, session.accountId);
  if (access.outcome !== "ALLOWED") {
    return (
      <main className="auth-main">
        <div className="auth-card">
          <h1>{CATALOG_TITLE}</h1>
          <p className="auth-status">{CATALOG_NOT_PROMOTER}</p>
          <p className="auth-status">
            <Link href="/account">{CATALOG_ACCOUNT_LINK}</Link>
          </p>
        </div>
      </main>
    );
  }

  const { productRef } = await params;
  if (!ProductRef.safeParse(productRef).success) notFound();
  const detail = await readPromotableCatalogDetail(db, access, productRef, new Date().toISOString());
  if (detail === null) notFound();

  const sellerHref = `/promote?seller=${encodeURIComponent(detail.sellerMName)}`;

  return (
    <main className="auth-main promote-main">
      <div className="auth-card promote-card-wide">
        <p className="auth-hint">
          <Link href="/promote">{DETAIL_BACK}</Link>
        </p>
        <h1>{detail.name}</h1>
        <p className="auth-status">
          {`${DETAIL_SELLER}: `}
          <Link className="promote-card-seller" href={sellerHref}>
            {detail.sellerMName}
          </Link>
          {" · "}
          <Link href={sellerHref}>{DETAIL_MORE_FROM_SELLER}</Link>
        </p>
        {detail.description !== null ? <p className="promote-description">{detail.description}</p> : null}
        {detail.deliveryMode !== null ? (
          <p className="auth-hint">{`${DETAIL_DELIVERY}: ${CATALOG_DELIVERY_LABELS[detail.deliveryMode]}`}</p>
        ) : null}

        <section className="account-section">
          <Terms
            heading={
              detail.termsInForce === "SCHEDULED_PROMOTION" && detail.promotionEndsAt !== null
                ? DETAIL_PROMOTION_UNTIL(detail.promotionEndsAt)
                : DETAIL_TERMS_NOW
            }
            terms={detail.terms}
          />
          {detail.standingTerms !== null ? <Terms heading={DETAIL_AFTER_PROMOTION} terms={detail.standingTerms} /> : null}
          {detail.upcomingPromotion !== null ? (
            <Terms
              heading={DETAIL_UPCOMING_PROMOTION(
                detail.upcomingPromotion.effectiveFrom,
                detail.upcomingPromotion.effectiveUntil,
              )}
              terms={detail.upcomingPromotion}
            />
          ) : null}
          {detail.offerEffectiveUntil !== null ? (
            <p className="auth-hint">{DETAIL_OFFER_ENDS(detail.offerEffectiveUntil)}</p>
          ) : null}
        </section>

        <section className="account-section">
          <p className="auth-hint">{DETAIL_REQUEST_NOTE}</p>
          <RequestToPromoteButton
            productRef={detail.productRef}
            authorization={detail.authorization}
            canRequest={access.canRequest}
            refusalMessage={access.canRequest ? null : formatPromotionRequestRefusals(access.requestRefusals)}
          />
        </section>
      </div>
    </main>
  );
}
