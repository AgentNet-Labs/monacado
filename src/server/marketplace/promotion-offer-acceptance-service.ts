/**
 * Promoter Offer-package acceptance (Phase 1.44, Contract §16.3(7), §19) —
 * SERVER ONLY. The ONLY path that writes `PromotionOfferAcceptance`.
 *
 * `acceptOfferPackageAs` — the cycle's own Promoter accepts the exact package
 * it was shown: the exact standing version S, or S with the exact promotional
 * version P while P is SCHEDULED or RUNNING. All or nothing; one row.
 *
 * ## What must hold, asked inside the transaction, in this order
 *
 *   1. the cycle is the caller's, on this Product, and current (else 404 / 409);
 *   2. it is `APPROVED` — approval is permission, never acceptance;
 *   3. the Promoter still passes the Phase 1.41 request gate, and is not the
 *      Seller (re-asked, as approval re-asks it — ruling C);
 *   4. the Product is `ACTIVE`, and resale is `AVAILABLE` or `PAUSED` — a pause
 *      blocks commerce, not assent; `NOT_OFFERED` / `WITHDRAWN` admit none;
 *   5. the named Offer is the Product's current Offer, still authored by the
 *      Seller holding Product authority, and `ACTIVE` (DRAFT, PAUSED,
 *      WITHDRAWN, ENDED admit no NEW acceptance);
 *   6. the package named is exactly the acceptable one — the standing version,
 *      and the promotion (or its absence);
 *   7. the economics and window restated are exactly those immutable versions'.
 *
 * Not asked: payment readiness, commerce approval, restrictions, a Storefront,
 * or a Listing. Accepting terms is not transacting.
 *
 * ## Exactness and idempotency
 *
 * The request names versions, never "current", so a Seller change between view
 * and click is a deterministic 409 and never binds the Promoter to newer terms.
 * The exact package already accepted in this cycle answers `created: false`
 * with the original `acceptedAt`, writing nothing.
 *
 * ## Concurrency
 *
 * The Product row is locked `FOR UPDATE` before anything is read, as every
 * Offer act, Promotion Authorization act, and Product resale / lifecycle act
 * does — so acceptance serialises with Seller revisions, promotion schedules
 * and replacements, pauses, withdrawals, revocations, and cancellations, and
 * decides on their result. The unique (cycle, Offer, S, P-or-'') key is the
 * database's final word; a race past the lock is `PromotionAuthorizationConflictError`.
 *
 * ## What it does not do
 *
 * Writes nothing but the one acceptance row: no Offer, version, act, Promotion
 * Authorization, Product, Listing, Order, payment, notification, or capsule
 * state. Stores no retail price, no Monacado retention, and no money.
 */

import "../server-only";
import { Prisma } from "@prisma/client";
import {
  OfferPackageAcceptanceInput,
  offerPackageMismatch,
  packageEchoMatches,
  resaleAdmitsAcceptance,
} from "../../contracts/marketplace/promotion-offer-acceptance";
import { participantMayRequestPromotionAuthorization } from "../../contracts/marketplace/promotion-authorization";
import { getPrisma } from "../db/client";
import { ProductNotAvailableError, ValidationError } from "../product/errors";
import { readProductLifecycleIn } from "../product/product-lifecycle-service";
import { readProductResaleAvailabilityIn } from "../product/product-resale-availability-service";
import { participantHoldsProductAuthority } from "./product-authority-service";
import {
  PromotionAuthorizationConflictError,
  PromotionAuthorizationNotFoundError,
  PromotionAuthorizationPromoterNotEligibleError,
  PromotionAuthorizationSelfPromotionError,
  PromotionAuthorizationSupersededError,
  PromotionOfferAcceptanceRefusedError,
} from "./promotion-authorization-errors";
import {
  cryptoPromotionOfferAcceptanceIdProvider,
  type PromotionOfferAcceptanceIdProvider,
} from "./promotion-authorization-ids";
import {
  readPromotionAuthorizationByRefIn,
  readPromotionRequestFactsIn,
} from "./promotion-authorization-read-service";
import { readOfferPackageContextIn } from "./promotion-offer-acceptance-read-service";

type Db = ReturnType<typeof getPrisma>;

export interface PromotionOfferAcceptanceServiceDeps {
  db?: Db;
  ids?: PromotionOfferAcceptanceIdProvider;
}

/** References and the package only — never an internal id. */
export interface OfferPackageAcceptanceResult {
  productRef: string;
  authorizationRef: string;
  offerRef: string;
  standingVersion: string;
  promotionVersion: string | null;
  acceptedAt: string;
  /** `false` when this exact package was already accepted in this cycle. */
  created: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * The cycle's own Promoter accepts the exact Offer package it was shown.
 *
 * Throws `ValidationError` (malformed body), `ProductNotAvailableError` (no
 * such Product), `PromotionAuthorizationNotFoundError` (not this Product's, or
 * not this Promoter's — one answer), `PromotionAuthorizationSupersededError`,
 * `PromotionAuthorizationPromoterNotEligibleError`,
 * `PromotionAuthorizationSelfPromotionError`,
 * `PromotionOfferAcceptanceRefusedError` (with a closed `reason`), or
 * `PromotionAuthorizationConflictError`.
 */
export async function acceptOfferPackageAs(
  actor: { accountId: string },
  request: { productRef: string; authorizationRef: string; input: unknown; now: string },
  deps: PromotionOfferAcceptanceServiceDeps = {},
): Promise<OfferPackageAcceptanceResult> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoPromotionOfferAcceptanceIdProvider;
  const parsed = OfferPackageAcceptanceInput.safeParse(request.input);
  if (!parsed.success) throw new ValidationError("Invalid Offer acceptance", ["body: does not name an exact package"]);
  const input = parsed.data;

  const product = await db.product.findUnique({
    where: { productRef: request.productRef },
    select: { internalProductId: true, productRef: true },
  });
  if (product === null) throw new ProductNotAvailableError();
  const internalProductId = product.internalProductId;
  const promoter = await db.marketplaceParticipant.findUnique({
    where: { accountId: actor.accountId },
    select: { id: true },
  });
  if (promoter === null) throw new PromotionAuthorizationNotFoundError();
  const promoterParticipantId = promoter.id;
  const refuse = (reason: ConstructorParameters<typeof PromotionOfferAcceptanceRefusedError>[0]) =>
    new PromotionOfferAcceptanceRefusedError(reason);

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT internalProductId FROM Product WHERE internalProductId = ${internalProductId} FOR UPDATE`;

      // 1–2. The caller's own current cycle, APPROVED.
      const cycle = await readPromotionAuthorizationByRefIn(tx, internalProductId, request.authorizationRef);
      if (cycle === null || cycle.promoterParticipantId !== promoterParticipantId) {
        throw new PromotionAuthorizationNotFoundError();
      }
      if (!cycle.current) throw new PromotionAuthorizationSupersededError();
      if (cycle.state !== "APPROVED") throw refuse("AUTHORIZATION_NOT_APPROVED");

      // 3. The Promoter still qualifies, and is not the Seller.
      const facts = await readPromotionRequestFactsIn(tx, { participantId: promoterParticipantId });
      if (facts === null || !participantMayRequestPromotionAuthorization(facts.facts).eligible) {
        throw new PromotionAuthorizationPromoterNotEligibleError();
      }
      if (await participantHoldsProductAuthority(tx, internalProductId, promoterParticipantId)) {
        throw new PromotionAuthorizationSelfPromotionError();
      }

      // 4. The Product admits assent.
      const lifecycle = await readProductLifecycleIn(tx, internalProductId);
      if (lifecycle === null || lifecycle.lifecycle.lifecycle !== "ACTIVE") throw refuse("PRODUCT_NOT_ACTIVE");
      const { resaleAvailability } = await readProductResaleAvailabilityIn(tx, internalProductId);
      if (!resaleAdmitsAcceptance(resaleAvailability)) throw refuse("RESALE_NOT_OFFERED");

      // 5. The named Offer is this Product's current, ACTIVE, Seller-authored Offer.
      const context = await readOfferPackageContextIn(tx, internalProductId, request.now);
      if (
        context === null ||
        context.offer.offerRef !== input.offerRef ||
        context.offer.sellerParticipantId !== lifecycle.authorityParticipantId ||
        context.acceptable === null
      ) {
        throw refuse("OFFER_NOT_ACCEPTING");
      }

      // 6. Exactly the acceptable package.
      const requested = {
        standingVersion: input.standing.version,
        promotionVersion: input.promotion?.version ?? null,
      };
      const mismatch = offerPackageMismatch(requested, context.acceptable);
      if (mismatch !== null) throw refuse(mismatch);

      // 7. Exactly those versions' economics and window.
      const promotionVersion = context.acceptable.promotionVersion === null ? null : context.state.promotion;
      if (!packageEchoMatches(input, { standing: context.state.standing, promotion: promotionVersion })) {
        throw refuse("TERMS_MISMATCH");
      }

      const key = {
        authorizationId: cycle.id,
        offerSourceRecordId: context.offer.offerSourceRecordId,
        standingVersion: requested.standingVersion,
        promotionVersionKey: requested.promotionVersion ?? "",
      };
      const answer = (acceptedAt: Date, created: boolean): OfferPackageAcceptanceResult => ({
        productRef: product.productRef,
        authorizationRef: cycle.authorizationRef,
        offerRef: context.offer.offerRef,
        standingVersion: requested.standingVersion,
        promotionVersion: requested.promotionVersion,
        acceptedAt: acceptedAt.toISOString(),
        created,
      });

      const existing = await tx.promotionOfferAcceptance.findUnique({
        where: {
          authorizationId_offerSourceRecordId_standingVersion_promotionVersionKey: key,
        },
        select: { acceptedAt: true },
      });
      if (existing !== null) return answer(existing.acceptedAt, false);

      const acceptedAt = new Date(request.now);
      await tx.promotionOfferAcceptance.create({
        data: {
          id: ids.nextPromotionOfferAcceptanceId(),
          ...key,
          promotionVersion: requested.promotionVersion,
          acceptedByAccountId: actor.accountId,
          acceptedAt,
        },
      });
      return answer(acceptedAt, true);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new PromotionAuthorizationConflictError(error);
    throw error;
  }
}
