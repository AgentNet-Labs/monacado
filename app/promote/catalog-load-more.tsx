"use client";

/**
 * Load-more for the Promotable Catalog (Phase 1.43).
 *
 * The page renders the first 24 cards on the server; this appends each next 24
 * from `GET /api/promote/catalog` with the same search, filters, and sort, plus
 * the opaque cursor the previous page returned. The list keeps growing in place,
 * so it scrolls as one list. Nothing here decides inclusion or order — the
 * server does, on every page.
 */

import { useState } from "react";
import type { PromotableCatalogCard } from "../../src/server/marketplace/promotable-catalog-read-service";
import { CatalogCard } from "./catalog-card";
import { CATALOG_LOAD_MORE, CATALOG_LOAD_MORE_FAILED } from "./promote-copy";

export const PROMOTABLE_CATALOG_ENDPOINT = "/api/promote/catalog";

export function CatalogLoadMore({
  initialCursor,
  queryString,
  fetchImpl,
}: {
  initialCursor: string | null;
  /** The page's search, filters, and sort, without a cursor. */
  queryString: string;
  fetchImpl?: typeof fetch;
}) {
  const [cards, setCards] = useState<PromotableCatalogCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function loadMore() {
    if (pending || cursor === null) return;
    setPending(true);
    setFailed(false);
    const params = new URLSearchParams(queryString);
    params.set("cursor", cursor);
    try {
      const response = await (fetchImpl ?? fetch)(`${PROMOTABLE_CATALOG_ENDPOINT}?${params.toString()}`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("catalog page refused");
      const page = (await response.json()) as { cards: PromotableCatalogCard[]; nextCursor: string | null };
      setCards((shown) => [...shown, ...page.cards]);
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    }
    setPending(false);
  }

  return (
    <>
      {cards.length > 0 ? (
        <ul className="promote-cards promote-cards-more">
          {cards.map((card) => (
            <CatalogCard key={card.productRef} card={card} />
          ))}
        </ul>
      ) : null}
      {failed ? (
        <p className="auth-error" role="alert">
          {CATALOG_LOAD_MORE_FAILED}
        </p>
      ) : null}
      {cursor !== null ? (
        <button className="auth-button promote-load-more" type="button" onClick={() => void loadMore()} disabled={pending}>
          {CATALOG_LOAD_MORE}
        </button>
      ) : null}
    </>
  );
}
