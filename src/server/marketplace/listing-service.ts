/**
 * Listing persistence service (Phase 0M.7) — SERVER ONLY.
 *
 * The narrow application boundary over Listing persistence: create either
 * branch, read the record and its versions, read one exact historical version,
 * mint a new version from an authorized material change, and evaluate buyer
 * eligibility and effective price from source plus a supplied instant.
 *
 * Six properties shape everything below:
 *
 *   1. **Immutable history.** A material change inserts a new version row and
 *      moves the stable record's pointer in one transaction. No historical row
 *      is ever updated.
 *
 *   2. **The exact accepted Offer version is authoritative, and never
 *      re-resolved.** A promoted Listing names one identified
 *      `OfferSourceRecordVersionRow` and stays bound to it. This service never
 *      reads the Offer's current-version pointer to decide what a Listing
 *      accepted; rebinding happens only when a caller explicitly names a
 *      different version in an update.
 *
 *   3. **Existing decisions are used, never restated.**
 *      `canCreateSellerDirectListing` and `canCreatePromotedListing` decide
 *      authority; 0M.4A's economics, lifecycle table, effective-price function,
 *      and buyer-eligibility function decide everything else. There is no second
 *      copy of any rule and no parallel permission model.
 *
 *   4. **Derived values are computed, never stored.** Effective price,
 *      sale-active status, and the whole MoR reconciliation are calculated on
 *      demand from authoritative inputs plus a supplied instant and a supplied
 *      policy. Nothing here writes one to a column.
 *
 *   5. **The acquisition policy is supplied per call.** It is validated against
 *      and never persisted, so a commercial decision never becomes stored state.
 *
 *   6. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected.
 *
 * **Each branch reports its own capability.** `SELLER_DIRECT` is governed by
 * `listing:seller_direct:create` and `PROMOTED` by `listing:promoted:create`.
 * The seller-direct capability was added in this phase: 0M.1's vocabulary
 * predates 0M.4A splitting Listings into two branches and named only the
 * promoted half. Placing a Product for sale is deliberately NOT the same
 * authorization concern as authoring the Product's own facts, so
 * `product:draft:create` governs Product drafting and nothing else.
 *
 * No HTTP route, no UI, no Node issuance, no publication, no checkout.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  CreatePromotedListingInput,
  CreateSellerDirectListingInput,
  UpdateListingInput,
  materialListingChangesBetween,
} from "../../contracts/marketplace/listing-record";
import {
  INITIAL_LISTING_LIFECYCLE_STATE,
  ListingEconomicsError,
  ListingPlacement,
  calculatePromotedListingEconomics,
  effectiveSellerRetailPrice,
  evaluateListingBuyerEligibility,
  evaluateUpstreamOfferReview,
  isValidListingLifecycleTransition,
  type EffectiveSellerPrice,
  type ListingBuyerEligibility,
  type ListingPlacement as Placement,
  type ListingSourceRecord,
  type ListingSourceVersion,
  type MaterialListingField,
  type MonacadoWholesaleAcquisitionPolicy,
} from "../../contracts/marketplace/listing-source";
import {
  canCreatePromotedListing,
  canCreateSellerDirectListing,
  isAllowed,
  type CapabilityDecision,
} from "../../contracts/marketplace/capability";
import type { MarketplaceSubject } from "../../contracts/marketplace/participant";
import type { GeneralAvailabilityState } from "../../contracts/product/product.capsule";
import { getPrisma } from "../db/client";
import { toMarketplaceSubject } from "./participant-mapper";
import { assertListingMayBecomeOperational } from "./participant-standing-service";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { versionRowToSourceVersion as offerVersionRowToSourceVersion } from "./offer-mapper";
import { cryptoListingIdProvider, type ListingIdProvider } from "./listing-ids";
import {
  AcceptedOfferVersionNotFoundError,
  ControllerParticipantNotFoundError,
  CorruptListingRecordError,
  DuplicateListingSourceVersionError,
  InvalidListingInputError,
  ListingEconomicsRefusedError,
  ListingNotAuthorizedError,
  ListingNotFoundError,
  ListingPersistenceFailureError,
  ListingProductNotFoundError,
  ListingStorefrontNotFoundError,
  ListingVersionNotFoundError,
  NoMaterialListingChangeError,
  OfferProductMismatchError,
} from "./listing-errors";
import { resolveCommerceApproval } from "./participant-commerce-approval-service";
import {
  listingRowToSourceRecord,
  placementToColumns,
  versionRowToSourceVersion,
} from "./listing-mapper";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface ListingServiceDeps {
  db?: Db;
  ids?: ListingIdProvider;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";
const isForeignKeyViolation = (e: unknown): boolean => prismaCode(e) === "P2003";

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidListingInputError {
  return new InvalidListingInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

/** Errors that must escape a catch block unwrapped rather than be disguised. */
function isDomainError(error: unknown): boolean {
  return (
    /* Phase 1.15 — a governed standing refusal is a DOMAIN answer, not an
       outage. Wrapped as a persistence failure it would read to a caller as
       though the database had broken, and the bounded denial code the seam
       produced would be lost. */
    error instanceof ParticipantActionNotPermittedError ||
    error instanceof ListingNotFoundError ||
    error instanceof ListingVersionNotFoundError ||
    error instanceof ListingNotAuthorizedError ||
    error instanceof NoMaterialListingChangeError ||
    error instanceof CorruptListingRecordError ||
    error instanceof ListingProductNotFoundError ||
    error instanceof ListingStorefrontNotFoundError ||
    error instanceof ControllerParticipantNotFoundError ||
    error instanceof AcceptedOfferVersionNotFoundError ||
    error instanceof OfferProductMismatchError ||
    error instanceof ListingEconomicsRefusedError ||
    error instanceof InvalidListingInputError
  );
}

export interface ListingSnapshot {
  record: ListingSourceRecord;
  currentVersion: ListingSourceVersion;
}

// — Authorization facts —

/**
 * Materialize the acting account's marketplace subject from persisted state.
 *
 * The **0M.5 machinery**, not a second copy: the same account, participant,
 * role, and entitlement rows feed the same `toMarketplaceSubject` mapper the
 * participant and Offer services use, so a decision is made against the database
 * rather than against whatever a caller asserted.
 *
 * An unknown account yields the guest subject, which every gate refuses with
 * `ACCOUNT_REQUIRED` — a refusal, not an exception.
 */
async function resolveSubject(tx: Tx, accountId: string): Promise<MarketplaceSubject> {
  const account = await tx.account.findUnique({ where: { id: accountId } });
  if (account === null) {
    return toMarketplaceSubject({
      account: null,
      participant: null,
      roles: [],
      internalCapabilities: [],
    });
  }

  const participant = await tx.marketplaceParticipant.findUnique({ where: { accountId } });
  const roles =
    participant === null
      ? []
      : await tx.marketplaceRoleAssignment.findMany({
          where: { participantId: participant.id },
          orderBy: { role: "asc" },
        });
  const entitlements = await tx.accountEntitlement.findMany({
    where: { accountId, status: "ACTIVE" },
    orderBy: { capability: "asc" },
  });

  return toMarketplaceSubject({
    account,
    participant,
    roles,
    internalCapabilities: entitlements.map((e) => e.capability),
  });
}

function requireAllowed(decision: CapabilityDecision): void {
  if (isAllowed(decision)) return;
  throw new ListingNotAuthorizedError(decision.capability, [...decision.reasonCodes]);
}

/**
 * The subject must BE the controlling participant.
 *
 * A capability decision answers "may this kind of participant do this kind of
 * thing"; it does not answer "is this that participant". Both are required, and
 * conflating them would let any promoter edit any other promoter's Listing.
 */
function requireController(
  subject: MarketplaceSubject,
  controllingParticipantId: string,
  capability: string,
): void {
  if (subject.participant?.participantId !== controllingParticipantId) {
    throw new ListingNotAuthorizedError(capability, ["PARTICIPANT_REQUIRED"]);
  }
}

/**
 * The branch's own authority decision.
 *
 * One capability per branch, never shared with Product drafting: SELLER for a
 * seller-direct placement, PROMOTER for a promoted one.
 */
function decideForBranch(
  listingType: "SELLER_DIRECT" | "PROMOTED",
  subject: MarketplaceSubject,
): CapabilityDecision {
  return listingType === "PROMOTED"
    ? canCreatePromotedListing(subject)
    : canCreateSellerDirectListing(subject);
}

// — Placement assembly —

/** Parse a placement through 0M.4A's own union, mapping refusals to field paths. */
function parsePlacement(candidate: unknown): Placement {
  const parsed = ListingPlacement.safeParse(candidate);
  if (!parsed.success) throw inputError(parsed.error);
  return parsed.data;
}

/**
 * Validate promoted economics with 0M.4A's own calculator.
 *
 * The viability rule is the contract's: promoter net proceeds must not be
 * negative. It is **not reproduced here** — `calculatePromotedListingEconomics`
 * throws `NEGATIVE_PROMOTER_PROCEEDS`, and this maps that bounded code onto a
 * persistence error. The result is discarded: it is a check, not a stored fact.
 */
function requireViablePromotedEconomics(input: {
  commercialRetailPriceMinorUnits: number;
  currency: string;
  offerWholesalePriceMinorUnits: number;
  offerWholesalePriceCurrency: string;
  sellerFundedCommissionMinorUnits: number;
  policy: MonacadoWholesaleAcquisitionPolicy;
}): void {
  try {
    calculatePromotedListingEconomics(input);
  } catch (error) {
    if (error instanceof ListingEconomicsError) {
      throw new ListingEconomicsRefusedError(error.code);
    }
    throw error;
  }
}

/**
 * Read one exact Offer source version and derive the accepted dependency.
 *
 * The wholesale price and commission come **from the persisted Offer version**,
 * never from the caller: a caller-supplied number could disagree with the Offer
 * actually accepted, which is the divergence the exact binding exists to
 * prevent. The Offer version stays authoritative for its own economics.
 */
async function resolveAcceptedOffer(
  tx: Tx,
  input: {
    offerSourceRecordId: string;
    sourceRecordVersion: string;
    internalProductId: string;
  },
): Promise<{
  dependencyBase: {
    internalOfferId: string;
    offerSourceRecordId: string;
    acceptedOfferSourceRecordVersion: string;
    acceptedWholesalePriceMinorUnits: number;
    acceptedWholesalePriceCurrency: string;
    acceptedCommissionCalculationPolicyVersion: string;
  };
  sellerFundedCommissionMinorUnits: number;
  currentOfferSourceRecordVersion: string;
}> {
  const row = await tx.offerSourceRecordVersionRow.findUnique({
    where: {
      offerSourceRecordId_sourceRecordVersion: {
        offerSourceRecordId: input.offerSourceRecordId,
        sourceRecordVersion: input.sourceRecordVersion,
      },
    },
  });
  if (row === null) throw new AcceptedOfferVersionNotFoundError();

  /* Reconstructed through 0M.6's own mapper, so a corrupt Offer row fails there
     rather than producing an accepted dependency nobody could have agreed to. */
  const offer = offerVersionRowToSourceVersion(row);

  if (offer.internalProductId !== input.internalProductId) {
    throw new OfferProductMismatchError();
  }
  if (offer.terms.price.type !== "PAID") {
    /* A FREE Offer has no wholesale price to promote against. 0M.2A refuses a
       commission on one, and a promoted Listing over it has no economics. */
    throw new ListingEconomicsRefusedError("OFFER_NOT_PAID");
  }

  const stable = await tx.offer.findUnique({
    where: { internalOfferId: offer.internalOfferId },
  });
  if (stable === null) throw new AcceptedOfferVersionNotFoundError();

  return {
    dependencyBase: {
      internalOfferId: offer.internalOfferId,
      offerSourceRecordId: offer.offerSourceRecordId,
      acceptedOfferSourceRecordVersion: offer.sourceRecordVersion,
      acceptedWholesalePriceMinorUnits: offer.terms.price.wholesalePriceMinorUnits,
      acceptedWholesalePriceCurrency: offer.terms.price.wholesalePriceCurrency,
      acceptedCommissionCalculationPolicyVersion:
        offer.economics.commissionCalculationPolicyVersion,
    },
    sellerFundedCommissionMinorUnits: offer.economics.calculatedCommissionMinorUnits,
    currentOfferSourceRecordVersion: stable.currentSourceRecordVersion,
  };
}

// — Reads —

async function readSnapshotInTx(tx: Tx, internalListingId: string): Promise<ListingSnapshot> {
  const row = await tx.listing.findUnique({ where: { internalListingId } });
  if (row === null) throw new ListingNotFoundError();

  const currentVersion = await tx.listingSourceRecordVersionRow.findUnique({
    where: {
      listingSourceRecordId_sourceRecordVersion: {
        listingSourceRecordId: row.listingSourceRecordId,
        sourceRecordVersion: row.currentSourceRecordVersion,
      },
    },
  });
  /* A stable record pointing at a nonexistent version would mean a partially
     written transaction; the write path makes it impossible, and reading it back
     must fail loudly rather than return half a Listing. */
  if (currentVersion === null) {
    throw new CorruptListingRecordError(["currentSourceRecordVersion"]);
  }

  return {
    record: listingRowToSourceRecord(row, currentVersion),
    currentVersion: versionRowToSourceVersion(currentVersion),
  };
}

/** Read one Listing with its current authoritative source version. */
export async function getListing(
  internalListingId: string,
  deps: ListingServiceDeps = {},
): Promise<ListingSnapshot> {
  const db = deps.db ?? getPrisma();
  try {
    return await readSnapshotInTx(db, internalListingId);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ListingPersistenceFailureError("getListing", error);
  }
}

/**
 * Read the current authoritative source version.
 *
 * This is the function a future publication phase hands to
 * `listingSourceRecordToCapsuleProjection`.
 */
export async function getCurrentSourceVersion(
  internalListingId: string,
  deps: ListingServiceDeps = {},
): Promise<ListingSourceVersion> {
  return (await getListing(internalListingId, deps)).currentVersion;
}

/** Read one exact historical source version. Never "the latest". */
export async function getSourceVersion(
  internalListingId: string,
  sourceRecordVersion: string,
  deps: ListingServiceDeps = {},
): Promise<ListingSourceVersion> {
  const db = deps.db ?? getPrisma();
  try {
    const stable = await db.listing.findUnique({ where: { internalListingId } });
    if (stable === null) throw new ListingNotFoundError();

    const row = await db.listingSourceRecordVersionRow.findUnique({
      where: {
        listingSourceRecordId_sourceRecordVersion: {
          listingSourceRecordId: stable.listingSourceRecordId,
          sourceRecordVersion,
        },
      },
    });
    if (row === null) throw new ListingVersionNotFoundError();
    return versionRowToSourceVersion(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ListingPersistenceFailureError("getSourceVersion", error);
  }
}

/** Every source version, oldest first — deterministic creation order. */
export async function listSourceVersions(
  internalListingId: string,
  deps: ListingServiceDeps = {},
): Promise<ListingSourceVersion[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.listingSourceRecordVersionRow.findMany({
      where: { internalListingId },
      orderBy: { seq: "asc" },
    });
    if (rows.length === 0) throw new ListingNotFoundError();
    return rows.map(versionRowToSourceVersion);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ListingPersistenceFailureError("listSourceVersions", error);
  }
}

/**
 * The public price at a supplied instant, for a seller-direct Listing.
 *
 * 0M.4A's own `effectiveSellerRetailPrice`. **Derived, never stored** — and the
 * reason no database write happens when a sale window opens or closes.
 */
export async function getEffectivePrice(
  internalListingId: string,
  now: string,
  deps: ListingServiceDeps = {},
): Promise<EffectiveSellerPrice> {
  const { currentVersion } = await getListing(internalListingId, deps);
  const placement = currentVersion.placement;
  if (placement.listingType !== "SELLER_DIRECT") {
    /* A promoted price has no sale overlay: the promoter's retail price is the
       price, and 0M.4A gives that branch no schedule through which it could move. */
    return {
      effectivePriceMinorUnits: placement.retail.retailPriceMinorUnits,
      currency: placement.retail.retailPriceCurrency,
      saleActive: false,
    };
  }
  return effectiveSellerRetailPrice({ placement, now });
}

/**
 * Whether this Listing may be sold to a buyer right now.
 *
 * 0M.4A's own `evaluateListingBuyerEligibility`, fed from persisted state. The
 * Product's availability is **supplied** rather than read: Product availability
 * is the Product model's question, and this phase adds no second answer to it.
 *
 * **Go-live approval is READ, never supplied.** 0M.3A settled that it is
 * *Monacado's resolved determination about a participant*, never a Storefront
 * fact — "storing it would put the approver's decision inside the approved
 * thing" — and 0M.9 gave that determination its own governed home on the
 * participant. It is resolved here for the **Storefront's owner**, whose
 * clearance `storefrontExposure` has always been about. There is deliberately no
 * parameter for it: a caller able to pass `APPROVED` would be a caller able to
 * make a Listing sellable, and no eligibility read may offer that.
 *
 * Absence of a governed decision yields `NOT_APPROVED`, so a participant nobody
 * has assessed cannot sell.
 *
 * Expect `buyerActive: false` through 0M.7 in the ordinary case — a drafting
 * participant is not `ACTIVE`, and the contract reports every blocking reason
 * rather than only the first.
 */
export async function evaluateBuyerEligibility(
  internalListingId: string,
  supplied: { productAvailability: GeneralAvailabilityState },
  deps: ListingServiceDeps = {},
): Promise<ListingBuyerEligibility> {
  const db = deps.db ?? getPrisma();
  try {
    const { currentVersion } = await readSnapshotInTx(db, internalListingId);
    const placement = currentVersion.placement;

    const storefront = await db.storefront.findUnique({
      where: { internalStorefrontId: currentVersion.storefrontId },
    });
    if (storefront === null) throw new ListingStorefrontNotFoundError();

    const controller = await db.marketplaceParticipant.findUnique({
      where: { id: currentVersion.controllingParticipantId },
    });
    if (controller === null) throw new ControllerParticipantNotFoundError();

    const role = await db.marketplaceRoleAssignment.findFirst({
      where: {
        participantId: controller.id,
        role: placement.listingType === "PROMOTED" ? "PROMOTER" : "SELLER",
      },
    });

    /* Promoted Listings need the accepted Offer's own commercial state, read
       from the EXACT accepted version and never from the Offer's current one.

       And, separately, whether the Seller CURRENTLY offers it at all — Phase
       1.15, Ruling 1. Resolved from the stable `Offer` record by the same
       `offerSourceRecordId` the dependency names, so this read agrees with the
       checkout seam rather than reporting a Listing buyable that checkout would
       refuse. */
    let offer: { lifecycle: string; availability: string } | undefined;
    let currentOffer: { lifecycle: string; availability: string } | undefined;
    if (placement.listingType === "PROMOTED") {
      const offerRow = await db.offerSourceRecordVersionRow.findUnique({
        where: {
          offerSourceRecordId_sourceRecordVersion: {
            offerSourceRecordId: placement.offerDependency.offerSourceRecordId,
            sourceRecordVersion: placement.offerDependency.acceptedOfferSourceRecordVersion,
          },
        },
      });
      if (offerRow !== null) {
        offer = { lifecycle: offerRow.lifecycle, availability: offerRow.availability };
      }
      const stableOffer = await db.offer.findUnique({
        where: { offerSourceRecordId: placement.offerDependency.offerSourceRecordId },
      });
      if (stableOffer !== null) {
        currentOffer = {
          lifecycle: stableOffer.lifecycle,
          availability: stableOffer.availability,
        };
      }
    }

    return evaluateListingBuyerEligibility({
      lifecycle: currentVersion.lifecycle,
      listingType: placement.listingType,
      productAvailability: supplied.productAvailability,
      storefrontExposure: {
        lifecycle: storefront.lifecycle as never,
        visibility: storefront.visibility as never,
        goLiveApproval: await resolveCommerceApproval(db, storefront.ownerParticipantId),
      },
      controllingParticipantStatus: controller.status as never,
      controllingRoleStatus: (role?.status ?? "NONE") as never,
      ...(offer === undefined ? {} : { offer: offer as never }),
      ...(currentOffer === undefined ? {} : { currentOffer: currentOffer as never }),
      ...(placement.listingType === "PROMOTED"
        ? { upstreamReviewState: placement.upstreamReviewState }
        : {}),
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ListingPersistenceFailureError("evaluateBuyerEligibility", error);
  }
}

// — Writes —

/** Verify the three placement references exist, so a caller learns which is missing. */
async function requirePlacementReferences(
  tx: Tx,
  input: { internalProductId: string; storefrontId: string; controllingParticipantId: string },
): Promise<void> {
  const product = await tx.product.findUnique({
    where: { internalProductId: input.internalProductId },
  });
  if (product === null) throw new ListingProductNotFoundError();

  const storefront = await tx.storefront.findUnique({
    where: { internalStorefrontId: input.storefrontId },
  });
  if (storefront === null) throw new ListingStorefrontNotFoundError();

  const controller = await tx.marketplaceParticipant.findUnique({
    where: { id: input.controllingParticipantId },
  });
  if (controller === null) throw new ControllerParticipantNotFoundError();
}

async function insertFirstVersion(
  tx: Tx,
  args: {
    internalListingId: string;
    listingSourceRecordId: string;
    storefrontId: string;
    internalProductId: string;
    controllingParticipantId: string;
    placement: Placement;
    authorizedByParticipantId: string;
    authorizedByActorId: string;
    recordedAt: Date;
  },
): Promise<void> {
  await tx.listing.create({
    data: {
      internalListingId: args.internalListingId,
      listingSourceRecordId: args.listingSourceRecordId,
      currentSourceRecordVersion: "1",
      listingType: args.placement.listingType,
      internalProductId: args.internalProductId,
      storefrontId: args.storefrontId,
      controllingParticipantId: args.controllingParticipantId,
      lifecycle: INITIAL_LISTING_LIFECYCLE_STATE,
    },
  });

  await tx.listingSourceRecordVersionRow.create({
    data: {
      listingSourceRecordId: args.listingSourceRecordId,
      sourceRecordVersion: "1",
      supersedesSourceRecordVersion: null,
      internalListingId: args.internalListingId,
      sourceSystem: "monacado",
      sourceRecordType: "Listing",
      sourceClass: "governed-database-record",
      storefrontId: args.storefrontId,
      internalProductId: args.internalProductId,
      controllingParticipantId: args.controllingParticipantId,
      lifecycle: INITIAL_LISTING_LIFECYCLE_STATE,
      ...placementToColumns(args.placement),
      authorizedByParticipantId: args.authorizedByParticipantId,
      authorizedByActorId: args.authorizedByActorId,
      recordedAt: args.recordedAt,
    },
  });
}

function mapWriteError(stage: string, error: unknown): never {
  if (isDomainError(error)) throw error;
  if (isUniqueViolation(error)) throw new DuplicateListingSourceVersionError(error);
  if (isForeignKeyViolation(error)) throw new ListingProductNotFoundError(error);
  throw new ListingPersistenceFailureError(stage, error);
}

/**
 * Create one draft SELLER_DIRECT Listing and its first immutable source version.
 *
 * The first version is `DRAFT`: 0M.4A's lifecycle starts there, and going live
 * is a separate act. The scheduled sale's cross-field rules are 0M.4A's own,
 * applied when the placement is parsed.
 */
export async function createSellerDirectListing(
  input: unknown,
  deps: ListingServiceDeps = {},
): Promise<ListingSnapshot> {
  const parsed = CreateSellerDirectListingInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;

  const placement = parsePlacement({
    listingType: "SELLER_DIRECT",
    retail: data.retail,
    sale: data.sale ?? null,
  });

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoListingIdProvider;
  const internalListingId = ids.nextInternalListingId();
  const listingSourceRecordId = ids.nextListingSourceRecordId();
  const at = new Date(data.now);

  try {
    return await db.$transaction(async (tx) => {
      await requirePlacementReferences(tx, data);

      const subject = await resolveSubject(tx, data.actingAccountId);
      const decision = decideForBranch("SELLER_DIRECT", subject);
      requireAllowed(decision);
      requireController(subject, data.controllingParticipantId, decision.capability);

      await insertFirstVersion(tx, {
        internalListingId,
        listingSourceRecordId,
        storefrontId: data.storefrontId,
        internalProductId: data.internalProductId,
        controllingParticipantId: data.controllingParticipantId,
        placement,
        authorizedByParticipantId: data.controllingParticipantId,
        authorizedByActorId: data.authorizedByActorId,
        recordedAt: at,
      });

      return await readSnapshotInTx(tx, internalListingId);
    });
  } catch (error) {
    mapWriteError("createSellerDirectListing", error);
  }
}

/**
 * Create one draft PROMOTED Listing bound to an exact accepted Offer version.
 *
 * The sequence, and each step matters:
 *
 *   1. verify Product, Storefront, and controller exist;
 *   2. authorize with 0M.1's `canCreatePromotedListing`, and require the subject
 *      to BE the controller;
 *   3. read the **exact** named Offer source version, confirm it is for this
 *      Product, and derive the accepted economics from it;
 *   4. validate promoter viability with 0M.4A's own calculator, discarding the
 *      result — it is a check, not a stored fact;
 *   5. insert the Listing and its first version in one transaction.
 *
 * The composite foreign key onto the Offer version's unique key makes step 3's
 * guarantee structural as well as procedural: the database refuses a row naming
 * a version that does not exist.
 */
export async function createPromotedListing(
  input: unknown,
  deps: ListingServiceDeps = {},
): Promise<ListingSnapshot> {
  const parsed = CreatePromotedListingInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoListingIdProvider;
  const internalListingId = ids.nextInternalListingId();
  const listingSourceRecordId = ids.nextListingSourceRecordId();
  const at = new Date(data.now);

  try {
    return await db.$transaction(async (tx) => {
      await requirePlacementReferences(tx, data);

      const subject = await resolveSubject(tx, data.actingAccountId);
      const decision = decideForBranch("PROMOTED", subject);
      requireAllowed(decision);
      requireController(subject, data.controllingParticipantId, decision.capability);

      const accepted = await resolveAcceptedOffer(tx, {
        offerSourceRecordId: data.acceptedOfferSourceRecordId,
        sourceRecordVersion: data.acceptedOfferSourceRecordVersion,
        internalProductId: data.internalProductId,
      });

      requireViablePromotedEconomics({
        commercialRetailPriceMinorUnits: data.retail.retailPriceMinorUnits,
        currency: data.retail.retailPriceCurrency,
        offerWholesalePriceMinorUnits:
          accepted.dependencyBase.acceptedWholesalePriceMinorUnits,
        offerWholesalePriceCurrency:
          accepted.dependencyBase.acceptedWholesalePriceCurrency,
        sellerFundedCommissionMinorUnits: accepted.sellerFundedCommissionMinorUnits,
        policy: data.acquisitionPolicy,
      });

      const placement = parsePlacement({
        listingType: "PROMOTED",
        retail: data.retail,
        offerDependency: { ...accepted.dependencyBase, acceptedAt: data.now },
        /* 0M.4A's own decision, from the accepted version against the Offer's
           current one. No category moved between them at acceptance time. */
        upstreamReviewState: evaluateUpstreamOfferReview({
          acceptedOfferSourceRecordVersion:
            accepted.dependencyBase.acceptedOfferSourceRecordVersion,
          currentOfferSourceRecordVersion: accepted.currentOfferSourceRecordVersion,
          changeCategoriesSinceAccepted: [],
        }),
      });

      await insertFirstVersion(tx, {
        internalListingId,
        listingSourceRecordId,
        storefrontId: data.storefrontId,
        internalProductId: data.internalProductId,
        controllingParticipantId: data.controllingParticipantId,
        placement,
        authorizedByParticipantId: data.controllingParticipantId,
        authorizedByActorId: data.authorizedByActorId,
        recordedAt: at,
      });

      return await readSnapshotInTx(tx, internalListingId);
    });
  } catch (error) {
    mapWriteError("createPromotedListing", error);
  }
}

/**
 * Mint a new immutable source version from an authorized material change.
 *
 * The sequence:
 *
 *   1. read the current version — the comparison basis;
 *   2. build the next placement, **rebinding the Offer only when a caller names
 *      a different exact version**;
 *   3. ask `materialListingChangesBetween` — driven by 0M.4A's own
 *      `MATERIAL_LISTING_FIELDS` — whether anything material changed;
 *   4. check any lifecycle move against 0M.4A's transition table;
 *   5. authorize, and require the subject to be the controller;
 *   6. insert the new version and advance the pointer **in one transaction**.
 *
 * Historical rows are never touched. The stable record's denormalized lifecycle
 * and type move with the pointer in the same transaction.
 */
export async function createListingSourceVersion(
  input: unknown,
  deps: ListingServiceDeps = {},
): Promise<ListingSnapshot> {
  const parsed = UpdateListingInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;

  const db = deps.db ?? getPrisma();
  const at = new Date(data.now);

  try {
    return await db.$transaction(async (tx) => {
      const stable = await tx.listing.findUnique({
        where: { internalListingId: data.internalListingId },
      });
      if (stable === null) throw new ListingNotFoundError();

      const currentRow = await tx.listingSourceRecordVersionRow.findUnique({
        where: {
          listingSourceRecordId_sourceRecordVersion: {
            listingSourceRecordId: stable.listingSourceRecordId,
            sourceRecordVersion: stable.currentSourceRecordVersion,
          },
        },
      });
      if (currentRow === null) {
        throw new CorruptListingRecordError(["currentSourceRecordVersion"]);
      }
      const current = versionRowToSourceVersion(currentRow);
      const currentPlacement = current.placement;

      const retail = data.retail ?? currentPlacement.retail;

      let nextPlacementCandidate: unknown;
      if (currentPlacement.listingType === "SELLER_DIRECT") {
        nextPlacementCandidate = {
          listingType: "SELLER_DIRECT",
          retail,
          sale: data.sale === undefined ? currentPlacement.sale : data.sale,
        };
      } else {
        /* The accepted binding moves ONLY when a caller names a different exact
           version. Nothing here consults the Offer's current-version pointer to
           decide what this Listing accepted. */
        let dependency = currentPlacement.offerDependency;
        let upstreamReviewState = currentPlacement.upstreamReviewState;

        if (
          data.acceptedOfferSourceRecordVersion !== undefined &&
          data.acceptedOfferSourceRecordVersion !==
            currentPlacement.offerDependency.acceptedOfferSourceRecordVersion
        ) {
          const accepted = await resolveAcceptedOffer(tx, {
            offerSourceRecordId: currentPlacement.offerDependency.offerSourceRecordId,
            sourceRecordVersion: data.acceptedOfferSourceRecordVersion,
            internalProductId: current.internalProductId,
          });

          if (data.acquisitionPolicy !== undefined) {
            requireViablePromotedEconomics({
              commercialRetailPriceMinorUnits: retail.retailPriceMinorUnits,
              currency: retail.retailPriceCurrency,
              offerWholesalePriceMinorUnits:
                accepted.dependencyBase.acceptedWholesalePriceMinorUnits,
              offerWholesalePriceCurrency:
                accepted.dependencyBase.acceptedWholesalePriceCurrency,
              sellerFundedCommissionMinorUnits: accepted.sellerFundedCommissionMinorUnits,
              policy: data.acquisitionPolicy,
            });
          }

          dependency = { ...accepted.dependencyBase, acceptedAt: data.now };
          upstreamReviewState = evaluateUpstreamOfferReview({
            acceptedOfferSourceRecordVersion:
              accepted.dependencyBase.acceptedOfferSourceRecordVersion,
            currentOfferSourceRecordVersion: accepted.currentOfferSourceRecordVersion,
            changeCategoriesSinceAccepted: [],
          });
        } else if (data.retail !== undefined && data.acquisitionPolicy !== undefined) {
          requireViablePromotedEconomics({
            commercialRetailPriceMinorUnits: retail.retailPriceMinorUnits,
            currency: retail.retailPriceCurrency,
            offerWholesalePriceMinorUnits:
              currentPlacement.offerDependency.acceptedWholesalePriceMinorUnits,
            offerWholesalePriceCurrency:
              currentPlacement.offerDependency.acceptedWholesalePriceCurrency,
            /* Read from the accepted version, which stays authoritative. */
            sellerFundedCommissionMinorUnits: (
              await resolveAcceptedOffer(tx, {
                offerSourceRecordId: currentPlacement.offerDependency.offerSourceRecordId,
                sourceRecordVersion:
                  currentPlacement.offerDependency.acceptedOfferSourceRecordVersion,
                internalProductId: current.internalProductId,
              })
            ).sellerFundedCommissionMinorUnits,
            policy: data.acquisitionPolicy,
          });
        }

        nextPlacementCandidate = {
          listingType: "PROMOTED",
          retail,
          offerDependency: dependency,
          upstreamReviewState,
        };
      }

      const nextPlacement = parsePlacement(nextPlacementCandidate);
      const nextLifecycle = data.lifecycle ?? current.lifecycle;

      const changed: MaterialListingField[] = materialListingChangesBetween(
        {
          storefrontId: current.storefrontId,
          internalProductId: current.internalProductId,
          controllingParticipantId: current.controllingParticipantId,
          lifecycle: current.lifecycle,
          placement: currentPlacement,
        },
        {
          storefrontId: current.storefrontId,
          internalProductId: current.internalProductId,
          controllingParticipantId: current.controllingParticipantId,
          lifecycle: nextLifecycle,
          placement: nextPlacement,
        },
      );
      if (changed.length === 0) throw new NoMaterialListingChangeError();

      const subject = await resolveSubject(tx, data.actingAccountId);
      const decision = decideForBranch(currentPlacement.listingType, subject);
      requireAllowed(decision);
      requireController(subject, current.controllingParticipantId, decision.capability);

      if (
        nextLifecycle !== current.lifecycle &&
        !isValidListingLifecycleTransition(current.lifecycle, nextLifecycle)
      ) {
        throw new ListingNotAuthorizedError(decision.capability, [
          "PARTICIPANT_STATUS_NOT_ELIGIBLE",
        ]);
      }

      /* Phase 1.15 — going live is not a drafting act.
       *
       * `decideForBranch` above returns a DRAFTING capability, and `RESTRICTED`
       * is a deliberate member of `DRAFTING_PARTICIPANT_STATUSES` so a restricted
       * participant can correct the work that caused the restriction. Correct for
       * drafting, and wrong for this: `DRAFT → ACTIVE` puts new items in front of
       * buyers, and it was authorized by nothing else. A restricted participant
       * could keep listing while every other commerce gate refused them.
       *
       * Deliberately NOT a new scope. Taking a Listing live is the broad act of
       * participating in the marketplace, which admission already governs — a
       * `listing:activate` scope would be a fourth name for the question
       * `RESTRICTED` and `SUSPENDED` answer, and a name is not a control. Any
       * active restriction refuses it; suspension refuses it harder.
       *
       * Only the going-live branch. Suspending, ending, or withdrawing a Listing
       * stays available, on the same reasoning as the Offer and Storefront
       * stand-down paths. */
      if (nextLifecycle === "ACTIVE" && current.lifecycle !== "ACTIVE") {
        await assertListingMayBecomeOperational(tx, current.controllingParticipantId);
      }

      await tx.listingSourceRecordVersionRow.create({
        data: {
          listingSourceRecordId: stable.listingSourceRecordId,
          sourceRecordVersion: data.sourceRecordVersion,
          supersedesSourceRecordVersion: current.sourceRecordVersion,
          internalListingId: data.internalListingId,
          sourceSystem: "monacado",
          sourceRecordType: "Listing",
          sourceClass: "governed-database-record",
          storefrontId: current.storefrontId,
          internalProductId: current.internalProductId,
          controllingParticipantId: current.controllingParticipantId,
          lifecycle: nextLifecycle,
          ...placementToColumns(nextPlacement),
          authorizedByParticipantId: current.controllingParticipantId,
          authorizedByActorId: data.authorizedByActorId,
          recordedAt: at,
        },
      });

      await tx.listing.update({
        where: { internalListingId: data.internalListingId },
        data: {
          currentSourceRecordVersion: data.sourceRecordVersion,
          lifecycle: nextLifecycle,
          listingType: nextPlacement.listingType,
        },
      });

      return await readSnapshotInTx(tx, data.internalListingId);
    });
  } catch (error) {
    mapWriteError("createListingSourceVersion", error);
  }
}
