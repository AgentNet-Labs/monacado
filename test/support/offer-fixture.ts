/**
 * Offer rows for suites that need an Offer as an UPSTREAM fact (Phase 1.42).
 *
 * Listing, checkout, accounting, and notification suites need a promoted
 * Listing's Offer to exist, carry terms, and be ACTIVE or stood down — not to
 * re-prove the Seller act gates, which `offer-persistence.integration.test.ts`
 * and `offer-concurrency.integration.test.ts` own. Since Phase 1.42 the only
 * service path to an ACTIVE Offer requires an ACTIVE Product and full Seller
 * readiness, so these seed the authoritative rows directly — the same shape the
 * service writes (an Offer, STANDING versions, a linear act chain), with
 * economics from the one calculator.
 *
 * Synthetic data only; every suite deletes what it seeded.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import {
  calculateOfferEconomics,
  type OfferCommercialTerms,
  type OfferLifecycleState,
} from "../../src/contracts/marketplace/offer-source";
import { termsToColumns } from "../../src/server/marketplace/offer-mapper";
import { randomApplicationRef } from "../../src/server/application-reference";

type Db = PrismaClient | Prisma.TransactionClient;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const opaque = (): string => Array.from(randomBytes(26), (b) => CROCKFORD[b % 32]).join("");

/** Promoted-resale terms as a suite most often wants them. */
export const usdTerms = (wholesale: number, basisPoints: number): OfferCommercialTerms => ({
  price: { type: "PAID", wholesalePriceMinorUnits: wholesale, wholesalePriceCurrency: "USD" },
  promotion: {
    type: "PROMOTABLE",
    commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: basisPoints },
  },
});

export interface SeededOffer {
  record: { internalOfferId: string; offerSourceRecordId: string; offerRef: string; internalProductId: string };
}

async function insertStandingVersion(
  db: Db,
  offer: { internalOfferId: string; offerSourceRecordId: string; internalProductId: string; sellerParticipantId: string },
  version: { label: string; supersedes: string | null; terms: OfferCommercialTerms; actingAccountId: string; now: string },
): Promise<void> {
  const economics = calculateOfferEconomics(version.terms);
  await db.offerSourceRecordVersionRow.create({
    data: {
      offerSourceRecordId: offer.offerSourceRecordId,
      sourceRecordVersion: version.label,
      supersedesSourceRecordVersion: version.supersedes,
      internalOfferId: offer.internalOfferId,
      sourceSystem: "monacado",
      sourceRecordType: "Offer",
      sourceClass: "governed-database-record",
      internalProductId: offer.internalProductId,
      sellerParticipantId: offer.sellerParticipantId,
      termsKind: "STANDING",
      basisStandingVersion: null,
      ...termsToColumns(version.terms),
      promotionEffectiveFrom: null,
      promotionEffectiveUntil: null,
      calculatedCommissionMinorUnits: BigInt(economics.calculatedCommissionMinorUnits),
      calculatedCreatorGrossProceedsMinorUnits: BigInt(economics.calculatedCreatorGrossProceedsMinorUnits),
      commissionCalculationPolicyVersion: economics.commissionCalculationPolicyVersion,
      authorizedBySellerParticipantId: offer.sellerParticipantId,
      authorizedByActorId: version.actingAccountId,
      recordedAt: new Date(version.now),
    },
  });
}

/**
 * A DRAFT Offer with STANDING version "1" — the rows `createOfferAs` writes,
 * named by internal ids so an upstream suite needs no session or ref. Pass
 * `state` to append the acts that reach it (ACTIVE: ACTIVATE; PAUSED: ACTIVATE,
 * PAUSE; WITHDRAWN: WITHDRAW).
 */
export async function seedOffer(
  input: {
    internalProductId: string;
    sellerParticipantId: string;
    terms: OfferCommercialTerms;
    actingAccountId: string;
    now: string;
    state?: "DRAFT" | "ACTIVE" | "PAUSED" | "WITHDRAWN";
    offerEffectiveUntil?: string | null;
  },
  deps: { db: Db },
): Promise<SeededOffer> {
  const db = deps.db;
  const offer = {
    internalOfferId: `mon:offer:${opaque()}`,
    offerSourceRecordId: `mon:srec:${opaque()}`,
    offerRef: randomApplicationRef(),
    internalProductId: input.internalProductId,
    sellerParticipantId: input.sellerParticipantId,
  };
  await db.offer.create({
    data: {
      ...offer,
      currentSourceRecordVersion: "1",
      currentPromotionVersion: null,
      nonTerminalForProductId: input.state === "WITHDRAWN" ? null : input.internalProductId,
    },
  });
  await insertStandingVersion(db, offer, {
    label: "1",
    supersedes: null,
    terms: input.terms,
    actingAccountId: input.actingAccountId,
    now: input.now,
  });
  const state = input.state ?? "DRAFT";
  if (state === "ACTIVE" || state === "PAUSED") {
    await recordOfferAct(db, offer.internalOfferId, {
      act: "ACTIVATE",
      actingAccountId: input.actingAccountId,
      now: input.now,
      offerEffectiveUntil: input.offerEffectiveUntil ?? null,
    });
  }
  if (state === "PAUSED") {
    await recordOfferAct(db, offer.internalOfferId, { act: "PAUSE", actingAccountId: input.actingAccountId, now: input.now });
  }
  if (state === "WITHDRAWN") {
    await recordOfferAct(db, offer.internalOfferId, { act: "WITHDRAW", actingAccountId: input.actingAccountId, now: input.now });
  }
  return { record: offer };
}

/** A new STANDING version, with the pointer moved — what `reviseOfferTermsAs` writes. */
export async function seedOfferStandingVersion(
  input: { internalOfferId: string; terms: OfferCommercialTerms; actingAccountId: string; now: string },
  deps: { db: Db },
): Promise<string> {
  const db = deps.db;
  const offer = await db.offer.findUniqueOrThrow({ where: { internalOfferId: input.internalOfferId } });
  const count = await db.offerSourceRecordVersionRow.count({ where: { internalOfferId: offer.internalOfferId } });
  const label = String(count + 1);
  await insertStandingVersion(db, offer, {
    label,
    supersedes: String(count),
    terms: input.terms,
    actingAccountId: input.actingAccountId,
    now: input.now,
  });
  await db.offer.update({ where: { internalOfferId: offer.internalOfferId }, data: { currentSourceRecordVersion: label } });
  return label;
}

const TARGET: Record<"ACTIVATE" | "PAUSE" | "RESUME" | "WITHDRAW", "ACTIVE" | "PAUSED" | "WITHDRAWN"> = {
  ACTIVATE: "ACTIVE",
  PAUSE: "PAUSED",
  RESUME: "ACTIVE",
  WITHDRAW: "WITHDRAWN",
};

/** Append one lifecycle act to the chain, exactly as `appendAct` does. Not gated. */
export async function recordOfferAct(
  db: Db,
  internalOfferId: string,
  act: {
    act: "ACTIVATE" | "PAUSE" | "RESUME" | "WITHDRAW";
    /** Defaults to the Seller participant's own account. */
    actingAccountId?: string;
    now: string;
    offerEffectiveUntil?: string | null;
  },
): Promise<void> {
  const offer = await db.offer.findUniqueOrThrow({ where: { internalOfferId } });
  const actedByAccountId =
    act.actingAccountId ??
    (await db.marketplaceParticipant.findUniqueOrThrow({ where: { id: offer.sellerParticipantId } })).accountId;
  const current = await db.offerAct.findUnique({ where: { currentForOfferId: internalOfferId } });
  if (current !== null) {
    await db.offerAct.update({ where: { id: current.id }, data: { currentForOfferId: null } });
  }
  const to = TARGET[act.act];
  await db.offerAct.create({
    data: {
      id: `mon:offeract:${opaque()}`,
      internalOfferId,
      act: act.act,
      state: to,
      previousState: (current?.state ?? "DRAFT") as OfferLifecycleState,
      supersedesActId: current?.id ?? null,
      currentForOfferId: internalOfferId,
      activatedStandingVersion: act.act === "ACTIVATE" ? offer.currentSourceRecordVersion : null,
      offerEffectiveUntil: act.offerEffectiveUntil ? new Date(act.offerEffectiveUntil) : null,
      endedPromotionVersion: null,
      actorParticipantId: offer.sellerParticipantId,
      actedByAccountId,
      actedAt: new Date(act.now),
    },
  });
  if (to === "WITHDRAWN") {
    await db.offer.update({ where: { internalOfferId }, data: { nonTerminalForProductId: null } });
  }
}
