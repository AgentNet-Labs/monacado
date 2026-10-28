/**
 * One Promotable Catalog card (Phase 1.43).
 *
 * Product name (linking to its detail page), the Seller's mName, a one-line
 * description, and the standard terms — wholesale and the Offer's actual
 * commission — always (Phase 1.44). A scheduled or running promotion appears
 * on its own line beside them, with its window, marked "in force now" while it
 * runs. No retail price, no internal id, no Seller personal identity — the card
 * is given none.
 *
 * Neither a server nor a client component by itself: the page renders the first
 * page with it, and `CatalogLoadMore` renders appended pages with it.
 */

import Link from "next/link";
import type { PromotableCatalogCard } from "../../src/server/marketplace/promotable-catalog-read-service";
import {
  CATALOG_AUTHORIZATION_LABELS,
  CATALOG_PROMOTION_BADGE,
  formatCatalogPromotionWindow,
  formatCatalogTermsLine,
} from "./promote-copy";

export function CatalogCard({ card }: { card: PromotableCatalogCard }) {
  return (
    <li className="promote-card">
      <Link className="promote-card-name" href={`/promote/${encodeURIComponent(card.productRef)}`}>
        {card.name}
      </Link>
      <span className="promote-card-seller">{card.sellerMName}</span>
      {card.summary !== null ? <p className="promote-card-summary">{card.summary}</p> : null}
      <p className="promote-card-terms">{formatCatalogTermsLine(card.standardTerms)}</p>
      {card.promotion !== null ? (
        <p className="promote-card-terms">
          <span className="promote-card-badge">{CATALOG_PROMOTION_BADGE}</span>
          {` ${formatCatalogPromotionWindow(card.promotion)} · ${formatCatalogTermsLine(card.promotion)}`}
        </p>
      ) : null}
      {card.authorization !== "NONE" ? (
        <p className="promote-card-state">{CATALOG_AUTHORIZATION_LABELS[card.authorization]}</p>
      ) : null}
    </li>
  );
}
