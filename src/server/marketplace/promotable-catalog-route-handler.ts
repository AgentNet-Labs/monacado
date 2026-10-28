/**
 * GET /api/promote/catalog — the next page of the Promotable Catalog
 * (Phase 1.43), for the page's load-more.
 *
 * Read-only: no body, no write, no cookie set, no session touched. The same
 * search, filters, sort, and opaque cursor the page reads, under the same
 * viewer rule — a signed-in participant who may browse (`resolvePromotableCatalogAccess`).
 *
 * | Status | `error`                              | When                                          |
 * | ------ | ------------------------------------ | --------------------------------------------- |
 * | 401    | `UNAUTHENTICATED`                    | no live session                               |
 * | 403    | `PROMOTABLE_CATALOG_NOT_AVAILABLE`   | the account may not browse it                 |
 * | 400    | `INVALID_PROMOTABLE_CATALOG_QUERY`   | a parameter or the cursor is not understood   |
 * | 500    | `PROMOTABLE_CATALOG_UNAVAILABLE`     | anything unexpected                           |
 *
 * `200 { cards, nextCursor }`. A card carries a `productRef`, Product facts,
 * the Seller's mName, and the terms in force — never an internal id, a
 * declared name, `Account.name`, an email, or a payment fact.
 */

import "../server-only";
import { parsePromotableCatalogQuery } from "../../contracts/marketplace/promotable-catalog";
import { resolvePageSession } from "../account/page-session";
import { getPrisma } from "../db/client";
import { readPromotableCatalogPage, resolvePromotableCatalogAccess } from "./promotable-catalog-read-service";

type Db = ReturnType<typeof getPrisma>;

export const PROMOTABLE_CATALOG_ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  notAvailable: "PROMOTABLE_CATALOG_NOT_AVAILABLE",
  invalidQuery: "INVALID_PROMOTABLE_CATALOG_QUERY",
  unavailable: "PROMOTABLE_CATALOG_UNAVAILABLE",
} as const;

export const PROMOTABLE_CATALOG_ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface PromotableCatalogRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
}

const respond = (status: number, body: Record<string, unknown>): PromotableCatalogRouteResult => ({
  status,
  body,
  headers: PROMOTABLE_CATALOG_ROUTE_HEADERS,
});

export async function handlePromotableCatalogRequest(
  request: { search: string; cookieHeader: string | null },
  deps: { db?: Db; now?: () => string } = {},
): Promise<PromotableCatalogRouteResult> {
  const db = deps.db ?? getPrisma();
  const now = (deps.now ?? (() => new Date().toISOString()))();
  try {
    const session = await resolvePageSession(request.cookieHeader, { db, now: () => now });
    if (session === undefined) return respond(401, { error: PROMOTABLE_CATALOG_ROUTE_ERROR_CODES.unauthenticated });

    const access = await resolvePromotableCatalogAccess(db, session.accountId);
    if (access.outcome !== "ALLOWED") return respond(403, { error: PROMOTABLE_CATALOG_ROUTE_ERROR_CODES.notAvailable });

    const params = new URLSearchParams(request.search);
    const { query, invalid } = parsePromotableCatalogQuery((name) => params.get(name));
    if (invalid.length > 0) {
      return respond(400, { error: PROMOTABLE_CATALOG_ROUTE_ERROR_CODES.invalidQuery, invalid });
    }

    const page = await readPromotableCatalogPage(db, access, query, now);
    if (page.cursorIgnored) {
      return respond(400, { error: PROMOTABLE_CATALOG_ROUTE_ERROR_CODES.invalidQuery, invalid: ["cursor"] });
    }
    return respond(200, { cards: page.cards, nextCursor: page.nextCursor });
  } catch {
    return respond(500, { error: PROMOTABLE_CATALOG_ROUTE_ERROR_CODES.unavailable });
  }
}
