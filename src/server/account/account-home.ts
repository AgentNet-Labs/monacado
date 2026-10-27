/**
 * What the signed-in `/account` page shows — SERVER ONLY (Phase 1.29; Storefronts
 * added in Phase 1.30).
 *
 * Read fresh from the database on every render, from the account id the session
 * resolved to. Nothing here is carried in the session: a name or address changed
 * elsewhere would otherwise go stale in a cookie, and the session would grow into
 * a second copy of the account.
 *
 * **A projection, not a record.** The account row includes its password hash and
 * its internal ids; this returns neither, nor the participant's or any role's id.
 * The page cannot render what it is never handed.
 *
 * The rows come from `readActingAccountRows`, the reader the marketplace
 * authority path already uses for account → participant → roles, so the page and
 * the services agree on what this account holds.
 */

import "../server-only";
import { readSellerProductOffersIn, type SellerProductOffer } from "../marketplace/offer-read-service";
import {
  permitsDrafting,
  type MarketplaceRole,
  type ParticipantStatus,
  type RoleAssignmentStatus,
} from "../../contracts/marketplace/participant";
import {
  SELF_SERVICE_ONBOARDING_ROLES,
  isDraftWritableParticipantStatus,
  type SelfServiceOnboardingRole,
} from "../../contracts/marketplace/participant-record";
import type {
  StorefrontLifecycleState,
  StorefrontVisibility,
} from "../../contracts/marketplace/storefront-source";
import { INCLUDED_STOREFRONT_ALLOWANCE } from "../../contracts/marketplace/storefront-record";
import {
  canCreateDraftProduct,
  canCreateDraftStorefront,
  canCreateSellerDirectListing,
  isAllowed,
} from "../../contracts/marketplace/capability";
import type { ListingLifecycleState } from "../../contracts/marketplace/listing-source";
import type {
  DeliveryMode,
  GeneralAvailabilityState,
} from "../../contracts/product/product.capsule";
import type { RecordStatus } from "../../contracts/product/product-source-record";
import type { ProductCompletenessGap } from "../../contracts/product/product-completeness";
import { ProductShippingPolicy } from "../../contracts/product/product-shipping-policy";
import { shippingPolicyFromColumns } from "../product/persistence-mapper";
import { productRevisionToken } from "../product/product-revision-token";
import {
  PRODUCT_COMPLETENESS_COLUMNS,
  evaluateCompletenessOfVersionRow,
} from "../product/product-completeness-service";
import type {
  ProductActivationBlocker,
  ProductLifecycleState,
} from "../../contracts/product/product-lifecycle";
import { readProductLifecycleIn } from "../product/product-lifecycle-service";
import {
  productResaleEffectiveness,
  resaleAvailabilityOptions,
  type ProductResaleAvailability,
  type ResaleAvailabilityRefusal,
} from "../../contracts/product/product-resale-availability";
import { readProductResaleAvailabilitiesIn } from "../product/product-resale-availability-service";
import {
  governedPromotionAuthorizationActs,
  participantMayRequestPromotionAuthorization,
  type PromotionAuthorizationRequestRefusal,
  type PromotionAuthorizationState,
} from "../../contracts/marketplace/promotion-authorization";
import {
  readPromoterPromotionAuthorizationsIn,
  readPromotionRequestFactsIn,
  readSellerPromotionAuthorizationsIn,
} from "../marketplace/promotion-authorization-read-service";
import { readActingAccountRows } from "../marketplace/acting-subject-service";
import { toMarketplaceSubject } from "../marketplace/participant-mapper";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export interface AccountHomeRole {
  role: MarketplaceRole;
  status: RoleAssignmentStatus;
}

/**
 * One Storefront the account's participant owns (Phase 1.30): the name and
 * handle the owner chose, and where it stands. No internal id of any kind.
 */
export interface AccountHomeStorefront {
  displayName: string;
  /** `null` when unset — the source model's own representation (Phase 1.31). */
  tagline: string | null;
  summary: string | null;
  publicHandle: string;
  lifecycle: StorefrontLifecycleState;
  visibility: StorefrontVisibility;
  /**
   * Whether the page should offer the presentation editor (Phase 1.31): this
   * participant holds an ACTIVE SUPER_OWNER or ADMIN assignment on it, it is not
   * CLOSED, and the participant's status permits drafting. The route asks the
   * domain again; this only decides what to show.
   */
  canEditPresentation: boolean;
  /**
   * Whether the page should offer this Storefront as a placement destination
   * (Phase 1.34): the participant's status permits drafting and the Storefront
   * is not CLOSED.
   *
   * Ownership is not re-asked because every Storefront in this list is one the
   * participant owns, and owning it IS placement authority
   * (`requireStorefrontPlacementAuthority`). The route asks the domain again;
   * this only decides what to show.
   *
   * A CLOSED Storefront is excluded although the domain would still accept a
   * placement into one from its owner. Offering it would be the page inviting
   * somebody to stock a shop whose history is closed — see the note in
   * `MARKETPLACE_ASSORTMENT_AND_LISTING_RULES.md` on lifecycle and placement.
   */
  canPlaceProduct: boolean;
}

/**
 * One current seller-direct placement the participant controls (Phase 1.34):
 * which of their Products is in which of their Storefronts, and — since
 * Phase 1.36 — what it is priced at, if anything.
 *
 * User-facing facts only. No Listing identifier beyond the application
 * reference, and no internal Product or Storefront id.
 *
 * **The price is nullable and that is the whole point of carrying it.** A
 * private draft placement may or may not have one, the two are genuinely
 * different commercial states, and a page cannot offer "set a price" versus
 * "change the price" without being told which. `null` is *unpriced* — never a
 * zero, never a missing key, and never a fabricated currency.
 */
export interface AccountHomePlacement {
  /**
   * The placement's stable application reference (Phase 1.35) — how a page
   * action names this placement.
   *
   * Safe to carry here, and the only Listing identifier that is: opaque,
   * un-namespaced, immutable, and naming the aggregate rather than a version.
   * `mon:listing:` and `mon:srec:` stay internal. It is an action VALUE, never
   * user-visible copy.
   */
  listingRef: string;
  /** The Product's name, from its CURRENT source version. */
  productName: string;
  /** The Storefront's display name, from ITS current source version. */
  storefrontDisplayName: string;
  /** The public handle — the Storefront's own client-facing selector. */
  storefrontHandle: string;
  lifecycle: ListingLifecycleState;
  /**
   * The placement's ordinary retail price, or `null` while it carries none
   * (Phase 1.36).
   *
   * Minor units, because that is the authoritative money model and the page
   * must not be handed a second one to disagree with — the amount a person
   * reads is produced by the presentation layer's formatter from exactly this
   * number. No effective price, no sale overlay, no economics: every one of
   * those is derived, and a projection that carried a derived value would be a
   * second answer able to go stale.
   */
  retail: { amountMinorUnits: number; currency: string } | null;
}

/**
 * One Product the account's participant authors (Phase 1.32): the facts the page
 * shows, from the CURRENT source version. No internal id of any kind.
 */
export interface AccountHomeProduct {
  /**
   * The stable application reference (Phase 1.34) — how a page action names
   * this Product.
   *
   * Safe to carry here, and the ONLY Product identifier that is: it is opaque,
   * un-namespaced, immutable, and carries no business meaning, so it exposes
   * nothing about the Product, its author, or how many exist. The internal
   * `mon:product:` and `mon:srec:` identities remain absent, as does every Node
   * identity. Nothing requires it to be shown to a person.
   */
  productRef: string;
  name: string;
  description: string | null;
  /* The legacy Product `promotable` fact is deliberately absent (Phase 1.40):
     it is retired as a governing requirement (Contract §9.3) and the page must
     not present it as resale permission. `resaleAvailability` below governs. */
  generalAvailabilityState: GeneralAvailabilityState;
  deliveryMode: DeliveryMode | null;
  recordStatus: RecordStatus;
  /**
   * The Seller shipping policy on the current version (Phase 1.38), or `null`
   * for none — which is "no shipping decision", never free shipping. A FIXED
   * charge is in integer minor units.
   */
  shippingPolicy:
    | { method: "FREE" }
    | { method: "FIXED"; amountMinorUnits: number; currency: string }
    | null;
  /**
   * `PRODUCT_COMPLETENESS_V1` over the current version (Phase 1.38) — content
   * completeness only. Not a lifecycle state: nothing here says the Product is
   * active, eligible, or for sale.
   */
  completeness: { complete: boolean; missing: ProductCompletenessGap[] };
  /**
   * The opaque revision token of the current version (Phase 1.38) — what an
   * edit of THIS state must send, so a stale edit is refused rather than
   * overwriting a newer one. A digest, not an identifier; see
   * `product-revision-token.ts`.
   */
  revisionToken: string;
  /**
   * The Product's effective lifecycle (Phase 1.39), derived from current
   * authoritative facts — never stored. `ACTIVE` only while an explicit Seller
   * activation is in effect.
   */
  lifecycle: ProductLifecycleState;
  /**
   * Why the Product cannot be activated now, in the evaluator's fixed order —
   * closed classifications about this account and this Product. Empty when
   * activation is permissible (or the Product is already `ACTIVE`).
   */
  activationBlockers: ProductActivationBlocker[];
  /**
   * The Seller's recorded resale availability (Phase 1.40, Contract §9.3) — a
   * separate axis from `lifecycle`, preserved across lifecycle changes.
   */
  resaleAvailability: ProductResaleAvailability;
  /**
   * Lifecycle `ACTIVE` AND resale `AVAILABLE`. Necessary for promoted commerce,
   * never sufficient — nothing here says the Product is for sale.
   */
  resaleEffective: boolean;
  /**
   * The governed resale-availability changes from the current state, each with
   * the reason the lifecycle holds it back now, if any. The route decides again.
   */
  resaleOptions: Array<{ target: ProductResaleAvailability; refusal: ResaleAvailabilityRefusal | null }>;
  /**
   * Promoters whose CURRENT Promotion Authorization for this Product is open —
   * pending (`REQUESTED`) or approved (`APPROVED`) — oldest request first
   * (Phase 1.41, Contract §16.2). Terminal cycles are history and not listed.
   * Independent of `lifecycle` and `resaleAvailability`.
   */
  promotionAuthorizations: AccountHomeSellerPromotionAuthorization[];
  /**
   * The Product's Offer as its Seller sees it (Phase 1.42): the current or most
   * recent Offer, its derived state, standing terms and economics, promotion,
   * blockers, and the acts available. Seller-facing only; never published.
   */
  offer: SellerProductOffer;
}

/**
 * One Promoter's open relationship with one of the Seller's Products (Phase
 * 1.41). The reference is an action value, never shown. The Promoter is
 * identified by its DECLARED first and last name — a declaration, never a
 * verification — and never by `Account.name`, an email, or an id.
 */
export interface AccountHomeSellerPromotionAuthorization {
  authorizationRef: string;
  promoterDeclaredName: string;
  state: "REQUESTED" | "APPROVED";
}

/**
 * The Promoter's side of Promotion Authorization (Phase 1.41) — present only
 * while the participant holds a PROMOTER role assignment of any status.
 */
export interface AccountHomePromoter {
  /**
   * `participantMayRequestPromotionAuthorization` over this account's rows —
   * private marketplace identity and a drafting PROMOTER role. Never payment
   * readiness. The route asks again, with the Product.
   */
  canRequest: boolean;
  /** Why not, in the gate's closed vocabulary; empty when `canRequest`. */
  requestRefusals: PromotionAuthorizationRequestRefusal[];
  /** The current relationship for every Product this Promoter has requested, oldest first. */
  authorizations: AccountHomePromoterAuthorization[];
}

export interface AccountHomePromoterAuthorization {
  /** The reference the Promoter itself submitted — no Product fact is disclosed. */
  productRef: string;
  authorizationRef: string;
  state: PromotionAuthorizationState;
  /** `REQUESTED` and `APPROVED` may be cancelled by the Promoter; terminal states may be re-requested. */
  canCancel: boolean;
  canRequestAgain: boolean;
}

export interface AccountHome {
  name: string;
  email: string;
  emailVerified: boolean;
  /** `null` until the account begins Seller or Promoter setup. */
  marketplace: {
    status: ParticipantStatus;
    roles: AccountHomeRole[];
    /** Whether self-service setup may still add a role (the participant is drafting). */
    onboardingOpen: boolean;
  } | null;
  /**
   * The Seller/Promoter roles this account may start from the page now: every
   * one it does not hold, while setup is open; none once it is not.
   */
  setupRolesAvailable: SelfServiceOnboardingRole[];
  /** Storefronts the participant owns, oldest first. Empty without a participant. */
  storefronts: AccountHomeStorefront[];
  /**
   * Whether the page should offer to open a draft Storefront: the 0M.1
   * `canCreateDraftStorefront` decision over this account's own rows — a SELLER
   * or PROMOTER role in a drafting status, on a participant permitted to draft —
   * AND a Storefront left in the participant's allowance. The route asks the
   * domain again; this only decides what to show.
   */
  canCreateStorefront: boolean;
  /**
   * The participant may draft Storefronts but owns every one its allowance
   * covers: the next needs an upgrade. Never true alongside `canCreateStorefront`.
   */
  storefrontUpgradeRequired: boolean;
  /** Products the participant authors, oldest first (Phase 1.32). */
  products: AccountHomeProduct[];
  /**
   * Whether the page should offer to draft a Product: the 0M.1
   * `canCreateDraftProduct` decision — SELLER only. The route asks again.
   */
  canCreateProduct: boolean;
  /**
   * Current seller-direct placements this participant controls, oldest first
   * (Phase 1.34). Empty without a participant.
   */
  placements: AccountHomePlacement[];
  /**
   * Whether the page should offer the placement form: the 0M.1
   * `canCreateSellerDirectListing` decision — SELLER only — AND at least one
   * Product to place AND at least one Storefront to place it into.
   *
   * All three, because a form with an empty selector is not an offer. What to
   * say instead when a side is missing is the page's decision, from
   * `products` and `storefronts`, which it already has.
   */
  canPlaceListing: boolean;
  /** `null` unless the participant holds a PROMOTER role (Phase 1.41). */
  promoter: AccountHomePromoter | null;
}

/** `undefined` when the account no longer exists — the page treats that as signed out. */
export async function readAccountHome(
  accountId: string,
  /** `now` (Phase 1.42): the instant Offer state is derived at. */
  deps: { db?: Db; now?: string } = {},
): Promise<AccountHome | undefined> {
  const db = deps.db ?? getPrisma();
  const now = deps.now ?? new Date().toISOString();
  const rows = await readActingAccountRows(db, accountId);
  if (rows === null) return undefined;

  const { account, participant, roles } = rows;
  const storefronts =
    participant === null
      ? []
      : await readOwnedStorefronts(
          db,
          participant.id,
          permitsDrafting(participant.status as ParticipantStatus),
        );
  const subject = toMarketplaceSubject({
    account,
    participant,
    roles,
    internalCapabilities: rows.internalCapabilities,
  });
  const mayDraftStorefront = isAllowed(canCreateDraftStorefront(subject));
  const canCreateProduct = isAllowed(canCreateDraftProduct(subject));
  const products = participant === null ? [] : await readAuthoredProducts(db, accountId, participant.id, now);
  const placements =
    participant === null ? [] : await readSellerDirectPlacements(db, participant.id);
  /* Phase 1.34. The capability AND both sides of the act: a placement form with
     no Product to place, or nowhere to place it, is not an offer — it is a
     dead control. What to say instead is the page's decision, and it has
     `products` and `storefronts` to make it. */
  const canPlaceListing =
    isAllowed(canCreateSellerDirectListing(subject)) &&
    products.length > 0 &&
    storefronts.some((s) => s.canPlaceProduct);
  /* The same allowance `openOwnedDraftStorefront` enforces: the included
     Storefront, plus any upgrade entitlement — of which none exists yet. */
  const withinAllowance = storefronts.length < INCLUDED_STOREFRONT_ALLOWANCE;
  const canCreateStorefront = mayDraftStorefront && withinAllowance;
  const storefrontUpgradeRequired = mayDraftStorefront && !withinAllowance;
  const onboardingOpen =
    participant === null || isDraftWritableParticipantStatus(participant.status as ParticipantStatus);
  const held = new Set(roles.map((r) => r.role));
  const promoter =
    participant !== null && held.has("PROMOTER") ? await readPromoterHome(db, accountId, participant.id) : null;

  return {
    promoter,
    setupRolesAvailable: onboardingOpen
      ? SELF_SERVICE_ONBOARDING_ROLES.filter((role) => !held.has(role))
      : [],
    storefronts,
    products,
    canCreateProduct,
    placements,
    canPlaceListing,
    canCreateStorefront,
    storefrontUpgradeRequired,
    name: account.name,
    email: account.email,
    emailVerified: account.emailVerifiedAt !== null,
    marketplace:
      participant === null
        ? null
        : {
            status: participant.status as ParticipantStatus,
            roles: roles.map((r) => ({
              role: r.role as MarketplaceRole,
              status: r.status as RoleAssignmentStatus,
            })),
            onboardingOpen,
          },
  };
}

/**
 * The participant's Storefronts, each with the display name from its CURRENT
 * source version — the stable record carries the handle, lifecycle, and
 * visibility, and the version row is where the name lives.
 */
async function readOwnedStorefronts(
  db: Db,
  ownerParticipantId: string,
  participantMayDraft: boolean,
): Promise<AccountHomeStorefront[]> {
  const stores = await db.storefront.findMany({
    where: { ownerParticipantId },
    orderBy: { createdAt: "asc" },
    select: {
      internalStorefrontId: true,
      storefrontSourceRecordId: true,
      currentSourceRecordVersion: true,
      publicHandle: true,
      lifecycle: true,
      visibility: true,
    },
  });
  if (stores.length === 0) return [];

  const versions = await db.storefrontSourceRecordVersionRow.findMany({
    where: {
      OR: stores.map((s) => ({
        storefrontSourceRecordId: s.storefrontSourceRecordId,
        sourceRecordVersion: s.currentSourceRecordVersion,
      })),
    },
    select: {
      storefrontSourceRecordId: true,
      presentationDisplayName: true,
      presentationTagline: true,
      presentationSummary: true,
    },
  });
  const current = new Map(versions.map((v) => [v.storefrontSourceRecordId, v]));

  /* The participant's own ACTIVE governance on these Storefronts — the
     assignment `canEditStorefrontPresentation` requires. Ownership alone is not
     governance (0M.3C §3). */
  const governed = new Set(
    (
      await db.storefrontGovernanceAssignment.findMany({
        where: {
          participantId: ownerParticipantId,
          status: "ACTIVE",
          internalStorefrontId: { in: stores.map((s) => s.internalStorefrontId) },
        },
        select: { internalStorefrontId: true },
      })
    ).map((g) => g.internalStorefrontId),
  );

  return stores.map((s) => {
    const version = current.get(s.storefrontSourceRecordId);
    return {
      displayName: version?.presentationDisplayName ?? s.publicHandle,
      tagline: version?.presentationTagline ?? null,
      summary: version?.presentationSummary ?? null,
      publicHandle: s.publicHandle,
      lifecycle: s.lifecycle as StorefrontLifecycleState,
      visibility: s.visibility as StorefrontVisibility,
      canEditPresentation:
        participantMayDraft &&
        s.lifecycle !== "CLOSED" &&
        governed.has(s.internalStorefrontId),
      /* Phase 1.34. Deliberately NOT gated on the governance assignment:
         editing a Storefront's presentation requires an ACTIVE governance role
         (0M.3A §3), while PLACING into it is satisfied by ownership alone, and
         every Storefront here is owned by this participant. Reusing the
         presentation condition would refuse an owner who has never appointed
         themselves SUPER_OWNER — which is every owner, on the day they open
         their first shop. */
      canPlaceProduct: participantMayDraft && s.lifecycle !== "CLOSED",
    };
  });
}

/**
 * The participant's current seller-direct placements (Phase 1.34).
 *
 * **Current only.** A Listing released by a terminal lifecycle state carries a
 * NULL placement marker and is history, not a placement — the same distinction
 * the composite unique index draws. Reading the marker rather than listing
 * lifecycle states keeps this and that constraint answering from one fact.
 *
 * Promoted placements are excluded: promoted self-service does not exist, and a
 * page that listed one would be showing a capacity nobody can reach.
 *
 * Two follow-up reads rather than a join, matching `readAuthoredProducts` and
 * `readOwnedStorefronts`: the names live on the CURRENT source versions of the
 * Product and the Storefront, not on their stable rows.
 */
async function readSellerDirectPlacements(
  db: Db,
  participantId: string,
): Promise<AccountHomePlacement[]> {
  const listings = await db.listing.findMany({
    where: {
      controllingParticipantId: participantId,
      listingType: "SELLER_DIRECT",
      currentPlacementMarker: { not: null },
    },
    orderBy: { createdAt: "asc" },
    select: {
      listingRef: true,
      internalProductId: true,
      storefrontId: true,
      lifecycle: true,
      listingSourceRecordId: true,
      currentSourceRecordVersion: true,
    },
  });
  if (listings.length === 0) return [];

  /* The price lives on the CURRENT immutable source version, never on the
     stable row — there is no price column there to read, and that is deliberate
     (`LISTING_PERSISTENCE.md` §7). A third follow-up read rather than a join,
     matching the two below it. */
  const listingVersions = await db.listingSourceRecordVersionRow.findMany({
    where: {
      OR: listings.map((l) => ({
        listingSourceRecordId: l.listingSourceRecordId,
        sourceRecordVersion: l.currentSourceRecordVersion,
      })),
    },
    select: {
      listingSourceRecordId: true,
      retailPriceMinorUnits: true,
      retailPriceCurrency: true,
    },
  });
  const retailBySourceRecord = new Map(
    listingVersions.map((v) => [
      v.listingSourceRecordId,
      /* Both columns or neither. A half-populated pair is corruption the mapper
         refuses on the authoritative path; here — a read-only page projection —
         it is treated as unpriced rather than rendered as half a price, on the
         same reasoning that drops a placement whose Product name will not
         resolve. */
      v.retailPriceMinorUnits === null || v.retailPriceCurrency === null
        ? null
        : {
            amountMinorUnits: Number(v.retailPriceMinorUnits),
            currency: v.retailPriceCurrency,
          },
    ]),
  );

  const products = await db.product.findMany({
    where: { internalProductId: { in: listings.map((l) => l.internalProductId) } },
    select: { internalProductId: true, sourceRecordId: true, currentSourceRecordVersion: true },
  });
  const productVersions = await db.productSourceRecordVersionRow.findMany({
    where: {
      OR: products.map((p) => ({
        sourceRecordId: p.sourceRecordId,
        sourceRecordVersion: p.currentSourceRecordVersion,
      })),
    },
    select: { sourceRecordId: true, factName: true },
  });
  const nameBySourceRecord = new Map(productVersions.map((v) => [v.sourceRecordId, v.factName]));
  const productName = new Map(
    products.map((p) => [p.internalProductId, nameBySourceRecord.get(p.sourceRecordId)]),
  );

  const stores = await db.storefront.findMany({
    where: { internalStorefrontId: { in: listings.map((l) => l.storefrontId) } },
    select: {
      internalStorefrontId: true,
      publicHandle: true,
      storefrontSourceRecordId: true,
      currentSourceRecordVersion: true,
    },
  });
  const storeVersions = await db.storefrontSourceRecordVersionRow.findMany({
    where: {
      OR: stores.map((s) => ({
        storefrontSourceRecordId: s.storefrontSourceRecordId,
        sourceRecordVersion: s.currentSourceRecordVersion,
      })),
    },
    select: { storefrontSourceRecordId: true, presentationDisplayName: true },
  });
  const displayBySourceRecord = new Map(
    storeVersions.map((v) => [v.storefrontSourceRecordId, v.presentationDisplayName]),
  );
  const store = new Map(
    stores.map((s) => [
      s.internalStorefrontId,
      {
        handle: s.publicHandle,
        /* The handle is the fallback the Storefront list already uses when a
           draft has no display name yet. */
        displayName: displayBySourceRecord.get(s.storefrontSourceRecordId) ?? s.publicHandle,
      },
    ]),
  );

  /* A placement whose Product or Storefront name cannot be resolved is dropped
     rather than rendered with a placeholder: a page naming somebody's shop
     "Unknown" is worse than a page not naming it. */
  return listings.flatMap((l) => {
    const name = productName.get(l.internalProductId);
    const shop = store.get(l.storefrontId);
    if (name === undefined || shop === undefined) return [];
    return [
      {
        listingRef: l.listingRef,
        productName: name,
        storefrontDisplayName: shop.displayName,
        storefrontHandle: shop.handle,
        lifecycle: l.lifecycle as ListingLifecycleState,
        retail: retailBySourceRecord.get(l.listingSourceRecordId) ?? null,
      },
    ];
  });
}

/**
 * The participant's Products (Phase 1.32), each from its CURRENT source version.
 *
 * Authorship is the version's `authorityCreatorParticipantId` — the column
 * Product authority is read from everywhere else — and it is a present fact: a
 * Product whose current version names someone else is not listed, whoever wrote
 * an earlier one.
 */
async function readAuthoredProducts(
  db: Db,
  accountId: string,
  participantId: string,
  now: string,
): Promise<AccountHomeProduct[]> {
  const products = await db.product.findMany({
    where: { versions: { some: { authorityCreatorParticipantId: participantId } } },
    orderBy: { productRowCreatedAt: "asc" },
    select: {
      internalProductId: true,
      sourceRecordId: true,
      currentSourceRecordVersion: true,
      productRef: true,
    },
  });
  if (products.length === 0) return [];

  const versions = await db.productSourceRecordVersionRow.findMany({
    where: {
      OR: products.map((p) => ({
        sourceRecordId: p.sourceRecordId,
        sourceRecordVersion: p.currentSourceRecordVersion,
      })),
    },
    select: {
      sourceRecordId: true,
      authorityCreatorParticipantId: true,
      factGeneralAvailabilityState: true,
      recordStatus: true,
      /* name, description, delivery mode, and the shipping policy — exactly the
         columns completeness reads (Phase 1.38). */
      ...PRODUCT_COMPLETENESS_COLUMNS,
    },
  });
  const current = new Map(versions.map((v) => [v.sourceRecordId, v]));

  /* Phase 1.39 — the one lifecycle derivation, per Product. The participant's
     own facts are read once and shared; the internal id never leaves here. */
  const participantFacts = new Map();
  const lifecycles = new Map<string, Awaited<ReturnType<typeof readProductLifecycleIn>>>();
  for (const p of products) {
    lifecycles.set(p.internalProductId, await readProductLifecycleIn(db, p.internalProductId, participantFacts));
  }
  /* Phase 1.40 — the Seller's resale choice, its own axis, read in one query. */
  const resale = await readProductResaleAvailabilitiesIn(
    db,
    products.map((p) => p.internalProductId),
  );
  /* Phase 1.41 — each Product's current Promoter relationships, a third axis. */
  const promotion = await readSellerPromotionAuthorizationsIn(
    db,
    products.map((p) => p.internalProductId),
  );
  /* Phase 1.42 — each Product's Offer, a fourth axis: Seller commercial authority
     for promoted resale, derived at `now`. */
  const offers = await readSellerProductOffersIn(
    db,
    products.map((p) => p.internalProductId),
    { accountId, sellerParticipantId: participantId },
    now,
  );

  return products.flatMap((p) => {
    const v = current.get(p.sourceRecordId);
    if (v === undefined || v.authorityCreatorParticipantId !== participantId) return [];
    const lifecycle = lifecycles.get(p.internalProductId)?.lifecycle;
    if (lifecycle === undefined) return [];
    const resaleAvailability = resale.get(p.internalProductId) ?? "NOT_OFFERED";
    return [
      {
        productRef: p.productRef,
        name: v.factName,
        description: v.factDescription,
        generalAvailabilityState: v.factGeneralAvailabilityState as GeneralAvailabilityState,
        deliveryMode: v.factDeliveryMode as DeliveryMode | null,
        recordStatus: v.recordStatus as RecordStatus,
        shippingPolicy: shippingPolicyForPage(v),
        /* The one evaluator, over the current version's own columns. */
        completeness: (({ complete, missing }) => ({ complete, missing }))(
          evaluateCompletenessOfVersionRow(v),
        ),
        revisionToken: productRevisionToken(p.sourceRecordId, p.currentSourceRecordVersion),
        lifecycle: lifecycle.lifecycle,
        activationBlockers:
          lifecycle.lifecycle === "ACTIVE" ? [] : [...lifecycle.readiness.blockers],
        resaleAvailability,
        resaleEffective: productResaleEffectiveness({
          lifecycle: lifecycle.lifecycle,
          resaleAvailability,
        }).effective,
        resaleOptions: resaleAvailabilityOptions(resaleAvailability, lifecycle.lifecycle),
        /* A relationship whose Promoter has no declared name (an invariant
           violation — the request gate requires both) is dropped rather than
           named by anything else, as an unresolvable placement name is above. */
        promotionAuthorizations: (promotion.get(p.internalProductId) ?? []).flatMap((a) =>
          (a.state === "REQUESTED" || a.state === "APPROVED") && a.promoterDeclaredName !== null
            ? [{ authorizationRef: a.authorizationRef, promoterDeclaredName: a.promoterDeclaredName, state: a.state }]
            : [],
        ),
        offer: offers.get(p.internalProductId) ?? { offer: null, canCreate: false },
      },
    ];
  });
}

/** The Promoter's request eligibility and current relationships (Phase 1.41). */
async function readPromoterHome(db: Db, accountId: string, participantId: string): Promise<AccountHomePromoter> {
  const read = await readPromotionRequestFactsIn(db, { accountId });
  const eligibility =
    read === null
      ? { eligible: false, refusals: ["PARTICIPANT_MISSING" as const] }
      : participantMayRequestPromotionAuthorization(read.facts);
  const authorizations = await readPromoterPromotionAuthorizationsIn(db, participantId);
  return {
    canRequest: eligibility.eligible,
    requestRefusals: [...eligibility.refusals],
    authorizations: authorizations.map((a) => ({
      productRef: a.productRef,
      authorizationRef: a.authorizationRef,
      state: a.state,
      canCancel: governedPromotionAuthorizationActs(a.state, "PROMOTER").includes("CANCEL"),
      canRequestAgain: governedPromotionAuthorizationActs(a.state, "PROMOTER").length === 0 && eligibility.eligible,
    })),
  };
}

/** The current version's shipping policy, shaped for the page; `null` for none or malformed. */
function shippingPolicyForPage(row: {
  shippingPolicyMethod: string | null;
  shippingFixedChargeMinorUnits: bigint | null;
  shippingFixedChargeCurrency: string | null;
}): AccountHomeProduct["shippingPolicy"] {
  const parsed = ProductShippingPolicy.safeParse(shippingPolicyFromColumns(row));
  if (!parsed.success) return null;
  if (parsed.data.method === "FREE") return { method: "FREE" };
  return {
    method: "FIXED",
    amountMinorUnits: parsed.data.fixedChargeMinorUnits,
    currency: parsed.data.fixedChargeCurrency,
  };
}
