/**
 * The Promotable Catalog, from the database (Phase 1.43) — SERVER ONLY.
 *
 * Reads only, at one explicit instant. The inclusion rule is the contract's
 * (`contracts/marketplace/promotable-catalog`); every gate in it is answered by
 * the reader that already owns it — Product lifecycle, resale availability,
 * Product authority, Offer state, participant standing — never restated here.
 *
 * Three passes, cheapest first:
 *
 *   1. **The database** narrows to current non-terminal Offers whose current act
 *      records `ACTIVE`, whose Seller is an `ACTIVE` participant on an `ACTIVE`
 *      account and has an mName (one mName, under `?seller=`), and that are not
 *      the viewer's own.
 *   2. **Stored Product facts** apply the search words and the delivery filter.
 *   3. **Derivation** at the instant decides the rest — lifecycle, resale,
 *      authority, the Offer's derived lifecycle and the terms in force, Seller
 *      standing — then the price and commission ranges, the sort, and the page.
 *
 * Nothing that leaves this module carries an internal id, a declared name,
 * `Account.name`, an email, or a payment fact: a Seller is its mName, a Product
 * its `productRef`.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  PROMOTABLE_CATALOG_PAGE_SIZE,
  PromotableCatalogCursor,
  catalogSortValue,
  catalogSummary,
  compareCatalogPositions,
  matchesCatalogSearch,
  promotableCatalogBrowseAllowed,
  type PromotableCatalogDeliveryMode,
  type PromotableCatalogQuery,
  type PromotableCatalogSort,
  type PromotableCatalogSortKeys,
} from "../../contracts/marketplace/promotable-catalog";
import {
  participantMayRequestPromotionAuthorization,
  type PromotionAuthorizationRequestRefusal,
} from "../../contracts/marketplace/promotion-authorization";
import { effectiveOfferTerms, type OfferSourceVersion } from "../../contracts/marketplace/offer-source";
import { getPrisma } from "../db/client";
import { readProductLifecycleIn } from "../product/product-lifecycle-service";
import { readProductResaleAvailabilitiesIn } from "../product/product-resale-availability-service";
import { readParticipantStanding } from "./participant-standing-service";
import { promotionStatusAt, readOfferStateIn } from "./offer-service";
import {
  readCurrentPromotionAuthorizationIn,
  readPromoterPromotionAuthorizationsIn,
  readPromotionRequestFactsIn,
} from "./promotion-authorization-read-service";
import { readPromoterOfferPackageIn, type PromoterOfferPackageView } from "./promotion-offer-acceptance-read-service";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;
/** The Seller-level lifecycle facts `readProductLifecycleIn` shares across one Seller's Products. */
type ParticipantFactsCache = NonNullable<Parameters<typeof readProductLifecycleIn>[2]>;

// — Viewer —

/** Who is browsing, resolved from the session's account. */
export type PromotableCatalogAccess =
  | {
      outcome: "ALLOWED";
      /** Internal — used to exclude the viewer's own Products; never rendered. */
      viewerParticipantId: string;
      canRequest: boolean;
      requestRefusals: PromotionAuthorizationRequestRefusal[];
    }
  | { outcome: "NOT_PROMOTER"; requestRefusals: PromotionAuthorizationRequestRefusal[] };

/**
 * May this account browse, and may it request? The Phase 1.41 request gate,
 * read once: browsing tolerates the closable identity gaps
 * (`promotableCatalogBrowseAllowed`); requesting tolerates none.
 */
export async function resolvePromotableCatalogAccess(tx: Tx, accountId: string): Promise<PromotableCatalogAccess> {
  const read = await readPromotionRequestFactsIn(tx, { accountId });
  if (read === null || read.participantId === null) {
    return { outcome: "NOT_PROMOTER", requestRefusals: ["PARTICIPANT_MISSING"] };
  }
  const eligibility = participantMayRequestPromotionAuthorization(read.facts);
  if (!promotableCatalogBrowseAllowed(eligibility.refusals)) {
    return { outcome: "NOT_PROMOTER", requestRefusals: [...eligibility.refusals] };
  }
  return {
    outcome: "ALLOWED",
    viewerParticipantId: read.participantId,
    canRequest: eligibility.eligible,
    requestRefusals: [...eligibility.refusals],
  };
}

// — What is shown —

/** One set of terms as a Promoter sees them: wholesale and commission. No Seller proceeds. */
export interface PromotableCatalogTerms {
  wholesalePriceMinorUnits: number;
  currency: string;
  /** The Offer's own commission method — a percentage is never synthesized from an amount. */
  commission:
    | { method: "PERCENT_OF_WHOLESALE"; commissionBasisPoints: number }
    | { method: "FIXED_AMOUNT"; fixedCommissionMinorUnits: number };
  calculatedCommissionMinorUnits: number;
}

/** The viewer's own relationship with the Product: "NONE" covers none, DENIED, REVOKED, and CANCELLED. */
export type PromotableCatalogAuthorization = "NONE" | "REQUESTED" | "APPROVED";

/**
 * A scheduled or running promotion, beside the standard terms (Phase 1.44): its
 * exact terms, its whole window, and whether it is in force now. Never
 * characterized as better or worse than the standard terms.
 */
export type PromotableCatalogPromotion = PromotableCatalogTerms & {
  effectiveFrom: string;
  effectiveUntil: string;
  /** `true` while RUNNING; `false` while SCHEDULED. */
  inForce: boolean;
};

export interface PromotableCatalogCard {
  productRef: string;
  name: string;
  sellerMName: string;
  /** The description's first line, cut for a card; `null` without one. */
  summary: string | null;
  deliveryMode: PromotableCatalogDeliveryMode | null;
  /** The terms in force now — what the filters and sorts read. */
  terms: PromotableCatalogTerms;
  termsInForce: "STANDING" | "SCHEDULED_PROMOTION";
  /** The standard (standing) terms — always shown, promotion or not (Phase 1.44). */
  standardTerms: PromotableCatalogTerms;
  /** A SCHEDULED or RUNNING promotion, shown alongside; `null` when none. */
  promotion: PromotableCatalogPromotion | null;
  authorization: PromotableCatalogAuthorization;
}

export interface PromotableCatalogPage {
  cards: PromotableCatalogCard[];
  /** Opaque; `null` when this page is the last. */
  nextCursor: string | null;
  /** `true` when the supplied cursor could not be read (or named another sort) and the list restarted. */
  cursorIgnored: boolean;
}

export interface PromotableCatalogDetail extends PromotableCatalogCard {
  description: string | null;
  /** The Offer's own overall end, if its Seller set one. */
  offerEffectiveUntil: string | null;
  /**
   * Phase 1.44 — the exact package this viewer may accept, with its acceptance
   * status; `null` unless the viewer's current authorization is `APPROVED`.
   */
  termsAcceptance: PromoterOfferPackageView | null;
}

// — Derivation —

function catalogTerms(version: OfferSourceVersion): PromotableCatalogTerms | null {
  const { price, promotion } = version.terms;
  if (price.type !== "PAID" || promotion.type !== "PROMOTABLE") return null;
  const c = promotion.commission;
  return {
    wholesalePriceMinorUnits: price.wholesalePriceMinorUnits,
    currency: price.wholesalePriceCurrency,
    commission:
      c.method === "PERCENT_OF_WHOLESALE"
        ? { method: c.method, commissionBasisPoints: c.commissionBasisPoints }
        : { method: c.method, fixedCommissionMinorUnits: c.fixedCommissionMinorUnits },
    calculatedCommissionMinorUnits: version.economics.calculatedCommissionMinorUnits,
  };
}

const OFFER_WITH_SELLER = { seller: { select: { marketplaceName: true } } } as const;
type CandidateOffer = Prisma.OfferGetPayload<{ include: typeof OFFER_WITH_SELLER }>;

interface ProductFacts {
  productRef: string;
  name: string;
  description: string | null;
  deliveryMode: PromotableCatalogDeliveryMode | null;
}

interface CatalogEntry {
  keys: PromotableCatalogSortKeys;
  /** For the detail page, the viewer's own cycle (internal; never rendered). */
  internalProductId: string;
  detail: Omit<PromotableCatalogDetail, "authorization" | "termsAcceptance">;
}

/** Pass 1: the stored markers the database can answer. */
async function candidateOffers(
  tx: Tx,
  where: { viewerParticipantId: string; seller: string | null; internalProductId?: string },
): Promise<CandidateOffer[]> {
  return await tx.offer.findMany({
    where: {
      nonTerminalForProductId: where.internalProductId ?? { not: null },
      sellerParticipantId: { not: where.viewerParticipantId },
      acts: { some: { currentForOfferId: { not: null }, state: "ACTIVE" } },
      seller: {
        marketplaceName: where.seller ?? { not: null },
        status: "ACTIVE",
        account: { status: "ACTIVE" },
      },
    },
    include: OFFER_WITH_SELLER,
  });
}

/** Pass 2's input: each candidate Product's reference and current stored facts. */
async function productFacts(tx: Tx, internalProductIds: readonly string[]): Promise<Map<string, ProductFacts>> {
  const out = new Map<string, ProductFacts>();
  if (internalProductIds.length === 0) return out;
  const products = await tx.product.findMany({
    where: { internalProductId: { in: [...internalProductIds] } },
    select: { internalProductId: true, productRef: true, sourceRecordId: true, currentSourceRecordVersion: true },
  });
  const versions = await tx.productSourceRecordVersionRow.findMany({
    where: {
      OR: products.map((p) => ({ sourceRecordId: p.sourceRecordId, sourceRecordVersion: p.currentSourceRecordVersion })),
    },
    select: {
      sourceRecordId: true,
      sourceRecordVersion: true,
      factName: true,
      factDescription: true,
      factDeliveryMode: true,
    },
  });
  const versionOf = new Map(versions.map((v) => [`${v.sourceRecordId}\u0000${v.sourceRecordVersion}`, v]));
  for (const p of products) {
    const v = versionOf.get(`${p.sourceRecordId}\u0000${p.currentSourceRecordVersion}`);
    if (v === undefined) continue;
    out.set(p.internalProductId, {
      productRef: p.productRef,
      name: v.factName,
      description: v.factDescription,
      deliveryMode:
        v.factDeliveryMode === "PHYSICAL" || v.factDeliveryMode === "DIGITAL" ? v.factDeliveryMode : null,
    });
  }
  return out;
}

/** Pass 3: one candidate, decided at `at` — the entry, or `null` when any gate holds it out. */
async function deriveEntry(
  tx: Tx,
  offer: CandidateOffer,
  facts: ProductFacts,
  at: string,
  caches: {
    participantFacts: ParticipantFactsCache;
    standing: Map<string, boolean>;
    resale: Map<string, string>;
    activatedAt: Map<string, Date>;
  },
): Promise<CatalogEntry | null> {
  const sellerMName = offer.seller.marketplaceName;
  if (sellerMName === null) return null;

  /* Gates 1 and 3 — Product ACTIVE, and this Offer's Seller is who holds
     authority over it now. */
  const product = await readProductLifecycleIn(tx, offer.internalProductId, caches.participantFacts);
  if (
    product === null ||
    product.lifecycle.lifecycle !== "ACTIVE" ||
    product.authorityParticipantId !== offer.sellerParticipantId
  ) {
    return null;
  }

  /* Gate 2 — resale AVAILABLE. */
  if (caches.resale.get(offer.internalProductId) !== "AVAILABLE") return null;

  /* Gate 7 — Seller standing. */
  let sellerInGoodStanding = caches.standing.get(offer.sellerParticipantId);
  if (sellerInGoodStanding === undefined) {
    const standing = await readParticipantStanding(tx, offer.sellerParticipantId);
    sellerInGoodStanding = !standing.suspended && !standing.activeScopes.includes("offer:publish");
    caches.standing.set(offer.sellerParticipantId, sellerInGoodStanding);
  }
  if (!sellerInGoodStanding) return null;

  /* Gates 4 and 5 — the Offer's derived lifecycle and the terms in force, both
     decided by the one resolver checkout and Listings will use. */
  const state = await readOfferStateIn(tx, offer);
  const effective = effectiveOfferTerms(state.resolution, at);
  if (effective.kind === "NONE") return null;
  const promotionInForce = effective.kind === "SCHEDULED_PROMOTION";
  const inForceVersion = promotionInForce ? state.promotion : state.standing;
  if (inForceVersion === null || inForceVersion.sourceRecordVersion !== effective.sourceRecordVersion) return null;
  const inForce = catalogTerms(inForceVersion);
  if (inForce === null) return null;
  const promotionStatus = promotionStatusAt(state, at);
  const standardTerms = catalogTerms(state.standing);
  if (standardTerms === null) return null;
  const window = state.resolution.promotion?.window ?? null;
  const pending = promotionStatus === "SCHEDULED" || promotionStatus === "RUNNING";
  const promotionTerms = pending && state.promotion !== null ? catalogTerms(state.promotion) : null;

  const activatedAt = caches.activatedAt.get(offer.internalOfferId);
  if (activatedAt === undefined) return null;

  return {
    keys: {
      productRef: facts.productRef,
      activatedAt: activatedAt.toISOString(),
      name: facts.name,
      sellerMName,
      wholesalePriceMinorUnits: inForce.wholesalePriceMinorUnits,
      calculatedCommissionMinorUnits: inForce.calculatedCommissionMinorUnits,
    },
    internalProductId: offer.internalProductId,
    detail: {
      productRef: facts.productRef,
      name: facts.name,
      sellerMName,
      summary: catalogSummary(facts.description),
      description: facts.description,
      deliveryMode: facts.deliveryMode,
      terms: inForce,
      termsInForce: promotionInForce ? "SCHEDULED_PROMOTION" : "STANDING",
      standardTerms,
      promotion:
        promotionTerms !== null && window !== null
          ? {
              ...promotionTerms,
              effectiveFrom: window.effectiveFrom,
              effectiveUntil: window.effectiveUntil,
              inForce: promotionStatus === "RUNNING",
            }
          : null,
      offerEffectiveUntil: state.resolution.offerEffectiveUntil,
    },
  };
}

/** Every included entry among these candidates, unordered. */
async function deriveEntries(
  tx: Tx,
  offers: CandidateOffer[],
  at: string,
  accept: (facts: ProductFacts, sellerMName: string) => boolean,
): Promise<CatalogEntry[]> {
  const facts = await productFacts(
    tx,
    offers.map((o) => o.internalProductId),
  );
  const survivors = offers.filter((o) => {
    const f = facts.get(o.internalProductId);
    return f !== undefined && o.seller.marketplaceName !== null && accept(f, o.seller.marketplaceName);
  });
  if (survivors.length === 0) return [];

  const [resale, activations] = await Promise.all([
    readProductResaleAvailabilitiesIn(
      tx,
      survivors.map((o) => o.internalProductId),
    ),
    tx.offerAct.findMany({
      where: { internalOfferId: { in: survivors.map((o) => o.internalOfferId) }, act: "ACTIVATE" },
      select: { internalOfferId: true, actedAt: true },
    }),
  ]);
  const caches = {
    participantFacts: new Map() as ParticipantFactsCache,
    standing: new Map<string, boolean>(),
    resale: new Map<string, string>([...resale.entries()]),
    activatedAt: new Map(activations.map((a) => [a.internalOfferId, a.actedAt])),
  };

  const entries: CatalogEntry[] = [];
  for (const offer of survivors) {
    const entry = await deriveEntry(tx, offer, facts.get(offer.internalProductId)!, at, caches);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function inRange(value: number, min: number | null, max: number | null): boolean {
  return (min === null || value >= min) && (max === null || value <= max);
}

// — The cursor —

export function encodePromotableCatalogCursor(cursor: PromotableCatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** The cursor, or `null` when it is not one this catalog issued for `sort`. */
export function decodePromotableCatalogCursor(
  value: string,
  sort: PromotableCatalogSort,
): PromotableCatalogCursor | null {
  try {
    const parsed = PromotableCatalogCursor.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success && parsed.data.s === sort ? parsed.data : null;
  } catch {
    return null;
  }
}

async function authorizationsOf(tx: Tx, viewerParticipantId: string): Promise<Map<string, PromotableCatalogAuthorization>> {
  const rows = await readPromoterPromotionAuthorizationsIn(tx, viewerParticipantId);
  return new Map(
    rows.map((r) => [r.productRef, r.state === "REQUESTED" || r.state === "APPROVED" ? r.state : "NONE"]),
  );
}

function toCard(detail: CatalogEntry["detail"], authorization: PromotableCatalogAuthorization): PromotableCatalogCard {
  return {
    productRef: detail.productRef,
    name: detail.name,
    sellerMName: detail.sellerMName,
    summary: detail.summary,
    deliveryMode: detail.deliveryMode,
    terms: detail.terms,
    termsInForce: detail.termsInForce,
    standardTerms: detail.standardTerms,
    promotion: detail.promotion,
    authorization,
  };
}

/**
 * One page of the catalog for this viewer at `at`: up to 24 cards after the
 * cursor, in the query's order, and the cursor that continues it.
 */
export async function readPromotableCatalogPage(
  tx: Tx,
  viewer: { viewerParticipantId: string },
  query: PromotableCatalogQuery,
  at: string,
): Promise<PromotableCatalogPage> {
  // A seller filter that cannot be an mName matches no Seller.
  if (query.seller === "") return { cards: [], nextCursor: null, cursorIgnored: false };

  const offers = await candidateOffers(tx, { viewerParticipantId: viewer.viewerParticipantId, seller: query.seller });
  const entries = (
    await deriveEntries(tx, offers, at, (f, sellerMName) =>
      (query.deliveryMode === null || f.deliveryMode === query.deliveryMode) &&
      matchesCatalogSearch(query.q, [f.name, f.description, sellerMName]),
    )
  ).filter(
    (e) =>
      inRange(e.keys.wholesalePriceMinorUnits, query.wholesaleMin, query.wholesaleMax) &&
      inRange(e.keys.calculatedCommissionMinorUnits, query.commissionMin, query.commissionMax),
  );

  const position = (e: CatalogEntry) => ({ value: catalogSortValue(query.sort, e.keys), productRef: e.keys.productRef });
  entries.sort((a, b) => compareCatalogPositions(query.sort, position(a), position(b)));

  const cursor = query.cursor === null ? null : decodePromotableCatalogCursor(query.cursor, query.sort);
  const after =
    cursor === null
      ? entries
      : entries.filter((e) => compareCatalogPositions(query.sort, position(e), { value: cursor.v, productRef: cursor.r }) > 0);
  const page = after.slice(0, PROMOTABLE_CATALOG_PAGE_SIZE);
  const last = page[page.length - 1];
  const nextCursor =
    after.length > PROMOTABLE_CATALOG_PAGE_SIZE && last !== undefined
      ? encodePromotableCatalogCursor({ s: query.sort, v: position(last).value, r: last.keys.productRef })
      : null;

  const authorizations = await authorizationsOf(tx, viewer.viewerParticipantId);
  return {
    cards: page.map((e) => toCard(e.detail, authorizations.get(e.keys.productRef) ?? "NONE")),
    nextCursor,
    cursorIgnored: query.cursor !== null && cursor === null,
  };
}

/**
 * One catalog Product's detail for this viewer at `at`, or `null` when that
 * Product is not in the catalog for this viewer — no such Product, not
 * included, or the viewer's own. All three are one answer.
 */
export async function readPromotableCatalogDetail(
  tx: Tx,
  viewer: { viewerParticipantId: string },
  productRef: string,
  at: string,
): Promise<PromotableCatalogDetail | null> {
  const product = await tx.product.findUnique({ where: { productRef }, select: { internalProductId: true } });
  if (product === null) return null;
  const offers = await candidateOffers(tx, {
    viewerParticipantId: viewer.viewerParticipantId,
    seller: null,
    internalProductId: product.internalProductId,
  });
  const [entry] = await deriveEntries(tx, offers, at, () => true);
  if (entry === undefined) return null;
  const authorizations = await authorizationsOf(tx, viewer.viewerParticipantId);
  const authorization = authorizations.get(entry.keys.productRef) ?? "NONE";
  /* Phase 1.44 — the package an APPROVED viewer may accept, from the one reader
     the acceptance route's own gates agree with. */
  const cycle =
    authorization === "APPROVED"
      ? await readCurrentPromotionAuthorizationIn(tx, {
          internalProductId: entry.internalProductId,
          promoterParticipantId: viewer.viewerParticipantId,
        })
      : null;
  const termsAcceptance = cycle === null ? null : await readPromoterOfferPackageIn(tx, cycle, at);
  return { ...entry.detail, authorization, termsAcceptance };
}
