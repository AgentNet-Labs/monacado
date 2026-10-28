/**
 * The Promotable Catalog (Phase 1.43) — pure.
 *
 * What a signed-in Promoter browses to find Products to ask permission for
 * (Contract §16.1). A READ over authoritative rows, derived at one instant —
 * never a stored list, never published, never an Offer acceptance.
 *
 * ## Inclusion — every one of these, at the instant read
 *
 *   1. Product lifecycle `ACTIVE` (derived — Seller readiness, suspension, and
 *      the activation basis included);
 *   2. resale availability `AVAILABLE`;
 *   3. a current non-terminal Offer whose Seller holds Product authority;
 *   4. that Offer's derived lifecycle `ACTIVE` (not `PAUSED`, `WITHDRAWN`, or
 *      derived `ENDED`);
 *   5. terms in force (standing, or a running promotion) that are `PAID` +
 *      `PROMOTABLE`;
 *   6. the Seller's account `ACTIVE`;
 *   7. the Seller not suspended and holding no active `offer:publish`
 *      restriction;
 *   8. the Seller has an mName — the only Seller identity shown.
 *
 * And never the viewer's own Products.
 *
 * Item 8 is structurally implied for every participant created from Phase 1.43
 * on (the row is created with its mName). It is kept as an explicit read-time
 * check, with no new state, because a participant created earlier has none and
 * must be left out rather than named by anything else.
 *
 * ## What a card shows
 *
 * Product name, Seller mName, a one-line description, wholesale, and the
 * Offer's ACTUAL commission — a percentage Offer as its percentage, a fixed
 * Offer as its amount; a percentage is never synthesized from an amount. No
 * retail price, no internal id, no Seller personal identity.
 */

import { z } from "zod";
import { APPLICATION_REF_RE } from "../capsule/identity";
import { parseMarketplaceNameLookup } from "./marketplace-name";
import type { PromotionAuthorizationRequestRefusal } from "./promotion-authorization";

export const PROMOTABLE_CATALOG_PAGE_SIZE = 24;
export const PROMOTABLE_CATALOG_QUERY_MAX_LENGTH = 100;
/** Characters of description a card shows before it is cut. */
export const PROMOTABLE_CATALOG_SUMMARY_MAX_LENGTH = 140;

export const PROMOTABLE_CATALOG_SORTS = [
  "NEWEST",
  "NAME",
  "SELLER",
  "WHOLESALE_LOW",
  "WHOLESALE_HIGH",
  "COMMISSION_HIGH",
  "COMMISSION_LOW",
] as const;
export const PromotableCatalogSort = z.enum(PROMOTABLE_CATALOG_SORTS);
export type PromotableCatalogSort = z.infer<typeof PromotableCatalogSort>;
export const DEFAULT_PROMOTABLE_CATALOG_SORT: PromotableCatalogSort = "NEWEST";

export const PROMOTABLE_CATALOG_DELIVERY_MODES = ["PHYSICAL", "DIGITAL"] as const;
export type PromotableCatalogDeliveryMode = (typeof PROMOTABLE_CATALOG_DELIVERY_MODES)[number];

export interface PromotableCatalogQuery {
  /** Words that must each appear in the Product name, its description, or the Seller's mName. */
  q: string | null;
  deliveryMode: PromotableCatalogDeliveryMode | null;
  /** Inclusive bounds on the wholesale price in force, in minor units. */
  wholesaleMin: number | null;
  wholesaleMax: number | null;
  /** Inclusive bounds on the calculated commission in force, in minor units. */
  commissionMin: number | null;
  commissionMax: number | null;
  /**
   * One Seller, by mName. `""` when the caller named a seller that cannot be an
   * mName: it matches no Seller, rather than being ignored into "every Seller".
   */
  seller: string | null;
  sort: PromotableCatalogSort;
  cursor: string | null;
}

/** The query-string names, as the page and the load-more route both read them. */
export const PROMOTABLE_CATALOG_PARAMS = {
  q: "q",
  deliveryMode: "delivery",
  wholesaleMin: "wholesaleMin",
  wholesaleMax: "wholesaleMax",
  commissionMin: "commissionMin",
  commissionMax: "commissionMax",
  seller: "seller",
  sort: "sort",
  cursor: "cursor",
} as const;

/** A dollar amount as typed — "40", "40.5", "40.50" — in minor units; `null` if it is not one. */
export function parseDollarAmount(value: string): number | null {
  const m = /^\s*\$?(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(value);
  if (m === null) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/**
 * How much of a folded Product name the NAME sort orders by. The sort is by
 * this prefix, then `productRef` — still a total order, and the one the cursor
 * carries, so a cursor stays small however long or non-ASCII the name.
 */
export const PROMOTABLE_CATALOG_NAME_SORT_PREFIX = 64;

/**
 * The longest cursor accepted. Covers the largest one issued: a 64-code-unit
 * name prefix at six JSON bytes per unit (every unit escaped), the sort, and a
 * productRef, base64url-encoded.
 */
const CURSOR_SHAPE = /^[A-Za-z0-9_-]{1,1024}$/;

export interface ParsedPromotableCatalogQuery {
  query: PromotableCatalogQuery;
  /** Parameters present but not understood. The page ignores them; the route refuses. */
  invalid: string[];
}

/**
 * Read the catalog query from search parameters. A blank parameter is absent;
 * a malformed one is reported in `invalid` and treated as absent — except
 * `seller`, which then matches nothing.
 */
export function parsePromotableCatalogQuery(
  get: (name: string) => string | null | undefined,
): ParsedPromotableCatalogQuery {
  const invalid: string[] = [];
  const raw = (name: string): string | null => {
    const v = get(name);
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };

  const qRaw = raw(PROMOTABLE_CATALOG_PARAMS.q);
  let q: string | null = null;
  if (qRaw !== null) {
    const collapsed = qRaw.trim().replace(/\s+/g, " ");
    if (collapsed.length > PROMOTABLE_CATALOG_QUERY_MAX_LENGTH) invalid.push(PROMOTABLE_CATALOG_PARAMS.q);
    else q = collapsed;
  }

  const deliveryRaw = raw(PROMOTABLE_CATALOG_PARAMS.deliveryMode);
  let deliveryMode: PromotableCatalogDeliveryMode | null = null;
  if (deliveryRaw !== null) {
    const upper = deliveryRaw.trim().toUpperCase();
    if ((PROMOTABLE_CATALOG_DELIVERY_MODES as readonly string[]).includes(upper)) {
      deliveryMode = upper as PromotableCatalogDeliveryMode;
    } else invalid.push(PROMOTABLE_CATALOG_PARAMS.deliveryMode);
  }

  const amount = (name: string): number | null => {
    const v = raw(name);
    if (v === null) return null;
    const parsed = parseDollarAmount(v);
    if (parsed === null) invalid.push(name);
    return parsed;
  };
  const wholesaleMin = amount(PROMOTABLE_CATALOG_PARAMS.wholesaleMin);
  const wholesaleMax = amount(PROMOTABLE_CATALOG_PARAMS.wholesaleMax);
  const commissionMin = amount(PROMOTABLE_CATALOG_PARAMS.commissionMin);
  const commissionMax = amount(PROMOTABLE_CATALOG_PARAMS.commissionMax);

  const sellerRaw = raw(PROMOTABLE_CATALOG_PARAMS.seller);
  let seller: string | null = null;
  if (sellerRaw !== null) {
    seller = parseMarketplaceNameLookup(sellerRaw) ?? "";
    if (seller === "") invalid.push(PROMOTABLE_CATALOG_PARAMS.seller);
  }

  const sortRaw = raw(PROMOTABLE_CATALOG_PARAMS.sort);
  let sort = DEFAULT_PROMOTABLE_CATALOG_SORT;
  if (sortRaw !== null) {
    const parsed = PromotableCatalogSort.safeParse(sortRaw.trim().toUpperCase());
    if (parsed.success) sort = parsed.data;
    else invalid.push(PROMOTABLE_CATALOG_PARAMS.sort);
  }

  const cursorRaw = raw(PROMOTABLE_CATALOG_PARAMS.cursor);
  let cursor: string | null = null;
  if (cursorRaw !== null) {
    if (CURSOR_SHAPE.test(cursorRaw)) cursor = cursorRaw;
    else invalid.push(PROMOTABLE_CATALOG_PARAMS.cursor);
  }

  return {
    query: { q, deliveryMode, wholesaleMin, wholesaleMax, commissionMin, commissionMax, seller, sort, cursor },
    invalid,
  };
}

/** Lowercased with accents removed — how search and name sorting compare text. */
export function foldForSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Every word of `q` appears in at least one of `fields`. */
export function matchesCatalogSearch(q: string | null, fields: readonly (string | null)[]): boolean {
  if (q === null) return true;
  const haystack = fields.filter((f): f is string => f !== null).map(foldForSearch);
  return foldForSearch(q)
    .split(" ")
    .filter((w) => w !== "")
    .every((word) => haystack.some((h) => h.includes(word)));
}

/** The first line of a description, cut to the card's length on a word boundary. */
export function catalogSummary(description: string | null): string | null {
  if (description === null) return null;
  const line = description.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (line === "") return null;
  if (line.length <= PROMOTABLE_CATALOG_SUMMARY_MAX_LENGTH) return line;
  const cut = line.slice(0, PROMOTABLE_CATALOG_SUMMARY_MAX_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// — Ordering and the cursor —

/** What every sort reads from one catalog entry. */
export interface PromotableCatalogSortKeys {
  productRef: string;
  /** When the Offer was activated (ISO instant) — "newest". */
  activatedAt: string;
  name: string;
  sellerMName: string;
  wholesalePriceMinorUnits: number;
  calculatedCommissionMinorUnits: number;
}

/** The one value a sort orders by; `productRef` breaks every tie. */
export function catalogSortValue(sort: PromotableCatalogSort, keys: PromotableCatalogSortKeys): string | number {
  switch (sort) {
    case "NEWEST":
      return keys.activatedAt;
    case "NAME":
      return foldForSearch(keys.name).slice(0, PROMOTABLE_CATALOG_NAME_SORT_PREFIX);
    case "SELLER":
      return keys.sellerMName;
    case "WHOLESALE_LOW":
    case "WHOLESALE_HIGH":
      return keys.wholesalePriceMinorUnits;
    case "COMMISSION_HIGH":
    case "COMMISSION_LOW":
      return keys.calculatedCommissionMinorUnits;
  }
}

/** Sorts whose value is a number; every other sort's value is a string. */
const NUMERIC_SORTS: ReadonlySet<PromotableCatalogSort> = new Set([
  "WHOLESALE_LOW",
  "WHOLESALE_HIGH",
  "COMMISSION_HIGH",
  "COMMISSION_LOW",
]);

const DESCENDING: ReadonlySet<PromotableCatalogSort> = new Set(["NEWEST", "WHOLESALE_HIGH", "COMMISSION_HIGH"]);

function compareValues(a: string | number, b: string | number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Total order for one sort over (sort value, productRef). Deterministic:
 * strings compare by code unit, never by locale, so the server and any later
 * page agree on where an entry falls.
 */
export function compareCatalogPositions(
  sort: PromotableCatalogSort,
  a: { value: string | number; productRef: string },
  b: { value: string | number; productRef: string },
): number {
  const byValue = compareValues(a.value, b.value);
  if (byValue !== 0) return DESCENDING.has(sort) ? -byValue : byValue;
  return compareValues(a.productRef, b.productRef);
}

/** The decoded continuation point: the last entry already shown, under one sort. */
export const PromotableCatalogCursor = z
  .strictObject({
    s: PromotableCatalogSort,
    v: z.union([z.string().max(PROMOTABLE_CATALOG_NAME_SORT_PREFIX), z.number().int().nonnegative()]),
    r: z.string().regex(APPLICATION_REF_RE),
  })
  .refine((c) => typeof c.v === (NUMERIC_SORTS.has(c.s) ? "number" : "string"), {
    message: "cursor value does not match its sort",
  });
export type PromotableCatalogCursor = z.infer<typeof PromotableCatalogCursor>;

// — Who may browse —

/**
 * Request-gate refusals that still let a participant BROWSE. Browsing is a read
 * and exposes nothing about the viewer, so an identity gap — an unverified
 * email or a missing declared name, which the participant can close, or a
 * missing mName, which only a pre-1.43 or abnormal row can have and which no
 * participant path fills — keeps the Request button disabled but not the
 * catalog. Every other refusal (no
 * participant, no PROMOTER role, an ineligible role, a closed or suspended
 * participant, a disabled account) closes the catalog too.
 */
export const PROMOTABLE_CATALOG_BROWSE_TOLERATED_REFUSALS = [
  "EMAIL_UNVERIFIED",
  "FIRST_NAME_MISSING",
  "LAST_NAME_MISSING",
  "MARKETPLACE_NAME_MISSING",
] as const satisfies readonly PromotionAuthorizationRequestRefusal[];

export function promotableCatalogBrowseAllowed(
  requestRefusals: readonly PromotionAuthorizationRequestRefusal[],
): boolean {
  return requestRefusals.every((r) =>
    (PROMOTABLE_CATALOG_BROWSE_TOLERATED_REFUSALS as readonly string[]).includes(r),
  );
}
