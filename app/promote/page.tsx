/**
 * `/promote` — the Promotable Catalog (Phase 1.43, Contract §16.1).
 *
 * Where a signed-in Promoter finds Products to ask permission for: searchable
 * (Product name, description, Seller mName), filterable (delivery, wholesale
 * range, commission range, one Seller by mName), and sortable, 24 cards at a
 * time with load-more. Every card links to its detail page, where the request
 * is made through the Phase 1.41 route.
 *
 * Guarded here, during render, like `/account`: a signed-out visitor is
 * redirected before anything is read. A signed-in account that may not browse
 * is told how to start Promoter setup and shown no Product.
 *
 * The filter form is a plain GET form — the URL is the whole query, so a
 * filtered list can be bookmarked and the back button works.
 */

import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolvePageSession } from "../../src/server/account/page-session";
import { getPrisma } from "../../src/server/db/client";
import {
  PROMOTABLE_CATALOG_DELIVERY_MODES,
  PROMOTABLE_CATALOG_PARAMS,
  PROMOTABLE_CATALOG_SORTS,
  parsePromotableCatalogQuery,
} from "../../src/contracts/marketplace/promotable-catalog";
import {
  readPromotableCatalogPage,
  resolvePromotableCatalogAccess,
} from "../../src/server/marketplace/promotable-catalog-read-service";
import { SIGN_OUT_DESTINATION } from "../account/sign-out-submission";
import { CatalogCard } from "./catalog-card";
import { CatalogLoadMore } from "./catalog-load-more";
import {
  CATALOG_ACCOUNT_LINK,
  CATALOG_APPLY,
  CATALOG_CLEAR,
  CATALOG_DELIVERY_ANY,
  CATALOG_DELIVERY_LABELS,
  CATALOG_EMPTY,
  CATALOG_FIELD_LABELS,
  CATALOG_FILTERS_IGNORED,
  CATALOG_INTRO,
  CATALOG_NOT_PROMOTER,
  CATALOG_SORT_LABELS,
  CATALOG_TITLE,
} from "./promote-copy";

/* This page reads a cookie. A cached render would be somebody else's session. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function PromotePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
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

  const params = await searchParams;
  const { query, invalid } = parsePromotableCatalogQuery((name) => first(params[name]));
  const page = await readPromotableCatalogPage(db, access, query, new Date().toISOString());

  /* The query the load-more continues — every understood parameter, no cursor. */
  const carried = new URLSearchParams();
  for (const name of Object.values(PROMOTABLE_CATALOG_PARAMS)) {
    const value = first(params[name]);
    if (name !== PROMOTABLE_CATALOG_PARAMS.cursor && value !== undefined && !invalid.includes(name)) {
      carried.set(name, value);
    }
  }
  const value = (name: string) => (invalid.includes(name) ? "" : (first(params[name]) ?? ""));

  return (
    <main className="auth-main promote-main">
      <div className="auth-card promote-card-wide">
        <h1>{CATALOG_TITLE}</h1>
        <p className="auth-lede">{CATALOG_INTRO}</p>
        <p className="auth-hint">
          <Link href="/account">{CATALOG_ACCOUNT_LINK}</Link>
        </p>

        <form className="promote-filters" method="get" action="/promote" role="search">
          <div className="auth-field promote-filter-search">
            <label htmlFor="promote-q">{CATALOG_FIELD_LABELS.q}</label>
            <input id="promote-q" name={PROMOTABLE_CATALOG_PARAMS.q} type="search" defaultValue={value("q")} maxLength={100} />
          </div>
          <div className="auth-field">
            <label htmlFor="promote-delivery">{CATALOG_FIELD_LABELS.deliveryMode}</label>
            <select id="promote-delivery" name={PROMOTABLE_CATALOG_PARAMS.deliveryMode} defaultValue={query.deliveryMode ?? ""}>
              <option value="">{CATALOG_DELIVERY_ANY}</option>
              {PROMOTABLE_CATALOG_DELIVERY_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {CATALOG_DELIVERY_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>
          {(["wholesaleMin", "wholesaleMax", "commissionMin", "commissionMax"] as const).map((name) => (
            <div className="auth-field" key={name}>
              <label htmlFor={`promote-${name}`}>{CATALOG_FIELD_LABELS[name]}</label>
              <input
                id={`promote-${name}`}
                name={PROMOTABLE_CATALOG_PARAMS[name]}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={value(name)}
              />
            </div>
          ))}
          <div className="auth-field">
            <label htmlFor="promote-seller">{CATALOG_FIELD_LABELS.seller}</label>
            <input
              id="promote-seller"
              name={PROMOTABLE_CATALOG_PARAMS.seller}
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              defaultValue={first(params.seller) ?? ""}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="promote-sort">{CATALOG_FIELD_LABELS.sort}</label>
            <select id="promote-sort" name={PROMOTABLE_CATALOG_PARAMS.sort} defaultValue={query.sort}>
              {PROMOTABLE_CATALOG_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {CATALOG_SORT_LABELS[sort]}
                </option>
              ))}
            </select>
          </div>
          <div className="promote-filter-actions">
            <button className="auth-button" type="submit">
              {CATALOG_APPLY}
            </button>
            <Link className="promote-clear" href="/promote">
              {CATALOG_CLEAR}
            </Link>
          </div>
        </form>

        {invalid.length > 0 || page.cursorIgnored ? <p className="auth-hint">{CATALOG_FILTERS_IGNORED}</p> : null}

        {page.cards.length === 0 ? (
          <p className="auth-status">{CATALOG_EMPTY}</p>
        ) : (
          <ul className="promote-cards">
            {page.cards.map((card) => (
              <CatalogCard key={card.productRef} card={card} />
            ))}
          </ul>
        )}
        <CatalogLoadMore initialCursor={page.nextCursor} queryString={carried.toString()} />
      </div>
    </main>
  );
}
