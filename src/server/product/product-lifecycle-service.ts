/**
 * Product lifecycle from the database (Phase 1.39) — SERVER ONLY.
 *
 * Gathers the authoritative facts `deriveProductLifecycle`
 * (`contracts/product/product-lifecycle.ts`) decides on, and nothing else. The
 * lifecycle is never stored: every caller — the account page, activation, and
 * suspension — derives it here, from the rows as this transaction sees them.
 *
 * Reads only. It takes a transaction, so activation and suspension decide on the
 * same rows they write.
 *
 * Facts read:
 *   - the CURRENT source version: completeness, tax classification, authority;
 *   - every version written since the current activation (continuity);
 *   - the authoring participant's account (email verification, declared names —
 *     never `Account.name`), status, SELLER role, payment readiness, commerce
 *     approval, governed standing, and the append-only counts the activation
 *     basis compares;
 *   - Product suspensions and the current activation.
 *
 * No Storefront, Listing, Offer, Order, payment, or publication row is read.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  deriveProductLifecycle,
  taxClassificationReady,
  type ProductActivationBasis,
  type ProductActivationBasisNow,
  type ProductActivationReadinessFacts,
  type ProductLifecycle,
} from "../../contracts/product/product-lifecycle";
import type { ParticipantStatus, PaymentReadinessStatus } from "../../contracts/marketplace/participant";
import { getPrisma } from "../db/client";
import { resolveCommerceApproval } from "../marketplace/participant-commerce-approval-service";
import { readProductActivationStanding } from "../marketplace/participant-standing-service";
import {
  readPaymentEnabledSinceIn,
  readReadinessIn,
} from "../marketplace/payment-account-service";
import { AmbiguousPaymentReadinessError } from "../marketplace/payment-account-errors";
import { versionGrantsProductAuthority } from "../marketplace/product-authority-service";
import {
  PRODUCT_COMPLETENESS_COLUMNS,
  evaluateCompletenessOfVersionRow,
} from "./product-completeness-service";

type Tx = ReturnType<typeof getPrisma> | Prisma.TransactionClient;

/** The version columns lifecycle reads: completeness, tax, and authority. */
const LIFECYCLE_VERSION_COLUMNS = {
  ...PRODUCT_COMPLETENESS_COLUMNS,
  seq: true,
  taxClassification: true,
  authorityCreatorParticipantId: true,
  authorityAuthorizationState: true,
  authorityScope: true,
} as const;

/** The participant-level facts, shared by every Product the participant authors. */
interface ParticipantLifecycleFacts {
  readiness: Pick<ProductActivationReadinessFacts, "account" | "participant">;
  basisNow: Omit<ProductActivationBasisNow, "productSuspensionCount">;
}

export interface ProductLifecycleRead {
  internalProductId: string;
  productRef: string;
  sourceRecordId: string;
  currentSourceRecordVersion: string;
  currentVersionSeq: bigint;
  /** The participant the CURRENT version grants creator authority to, if any. */
  authorityParticipantId: string | null;
  lifecycle: ProductLifecycle;
  basisNow: ProductActivationBasisNow;
  /** The current activation row's id, whether or not it is in effect. */
  currentActivationId: string | null;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * Payment readiness and when it entered `ENABLED`. Two linked accounts is a state
 * the readiness reader refuses to reduce; here it reads as not ready — the
 * fail-closed answer — rather than taking a page down.
 */
async function readPaymentFacts(
  tx: Tx,
  participantId: string,
): Promise<{ readiness: string; enabledSince: Date | null }> {
  try {
    const readiness: PaymentReadinessStatus = await readReadinessIn(tx, participantId);
    const enabledSince = await readPaymentEnabledSinceIn(tx, participantId);
    /* ENABLED with no recorded entry instant cannot anchor an activation basis,
       so it is reported as its own not-ready marker rather than as ENABLED —
       and never disguised as some other provider state. */
    return {
      readiness: readiness === "ENABLED" && enabledSince === null ? "ENABLED_UNDATED" : readiness,
      enabledSince,
    };
  } catch (error) {
    if (error instanceof AmbiguousPaymentReadinessError) {
      return { readiness: "AMBIGUOUS", enabledSince: null };
    }
    throw error;
  }
}

async function readParticipantLifecycleFacts(
  tx: Tx,
  participantId: string | null,
): Promise<ParticipantLifecycleFacts> {
  const empty: ParticipantLifecycleFacts = {
    readiness: { account: { emailVerifiedAt: null, firstName: null, lastName: null }, participant: null },
    basisNow: {
      participantId: null,
      emailVerifiedAt: null,
      sellerRoleActivatedAt: null,
      paymentEnabledSince: null,
      restrictionCount: 0,
      participantSuspensionCount: 0,
      nonApprovalDecisionCount: 0,
    },
  };
  if (participantId === null) return empty;

  const participant = await tx.marketplaceParticipant.findUnique({
    where: { id: participantId },
    select: {
      status: true,
      account: { select: { emailVerifiedAt: true, firstName: true, lastName: true } },
    },
  });
  if (participant === null) return empty;

  const [sellerRole, standing, payment, approval, restrictionCount, suspensionCount, nonApprovals] =
    await Promise.all([
      tx.marketplaceRoleAssignment.findUnique({
        where: { participantId_role: { participantId, role: "SELLER" } },
        select: { status: true, activatedAt: true },
      }),
      readProductActivationStanding(tx, participantId),
      readPaymentFacts(tx, participantId),
      resolveCommerceApproval(tx, participantId),
      tx.participantRestriction.count({ where: { participantId } }),
      tx.participantSuspension.count({ where: { participantId } }),
      tx.participantCommerceApproval.count({
        where: { participantId, decision: { not: "APPROVED" } },
      }),
    ]);

  /* An ACTIVE role with no recorded activation instant cannot anchor a basis;
     it reads as its own not-active marker rather than as a hole. */
  const sellerRoleActivatedAt = sellerRole?.status === "ACTIVE" ? sellerRole.activatedAt : null;
  const sellerRoleStatus =
    sellerRole === null
      ? null
      : sellerRole.status === "ACTIVE" && sellerRoleActivatedAt === null
        ? "ACTIVE_UNDATED"
        : sellerRole.status;

  return {
    readiness: {
      account: {
        emailVerifiedAt: iso(participant.account.emailVerifiedAt),
        firstName: participant.account.firstName,
        lastName: participant.account.lastName,
      },
      participant: {
        status: participant.status as ParticipantStatus,
        suspended: standing.suspended,
        productActivationRestricted: standing.productActivationRestricted,
        sellerRoleStatus,
        paymentReadiness: payment.readiness,
        commerceApproval: approval,
      },
    },
    basisNow: {
      participantId,
      emailVerifiedAt: iso(participant.account.emailVerifiedAt),
      sellerRoleActivatedAt: iso(sellerRoleActivatedAt),
      paymentEnabledSince: iso(payment.enabledSince),
      restrictionCount,
      participantSuspensionCount: suspensionCount,
      nonApprovalDecisionCount: nonApprovals,
    },
  };
}

/** The recorded basis of one activation row, as the contract compares it. */
function basisOfActivationRow(row: {
  participantId: string;
  basisEmailVerifiedAt: Date;
  basisSellerRoleActivatedAt: Date;
  basisPaymentEnabledSince: Date;
  basisRestrictionCount: number;
  basisParticipantSuspensionCount: number;
  basisNonApprovalDecisionCount: number;
  basisProductSuspensionCount: number;
}): ProductActivationBasis {
  return {
    participantId: row.participantId,
    emailVerifiedAt: row.basisEmailVerifiedAt.toISOString(),
    sellerRoleActivatedAt: row.basisSellerRoleActivatedAt.toISOString(),
    paymentEnabledSince: row.basisPaymentEnabledSince.toISOString(),
    restrictionCount: row.basisRestrictionCount,
    participantSuspensionCount: row.basisParticipantSuspensionCount,
    nonApprovalDecisionCount: row.basisNonApprovalDecisionCount,
    productSuspensionCount: row.basisProductSuspensionCount,
  };
}

/**
 * The effective lifecycle of one Product, or `null` when the Product (or its
 * current version) does not exist.
 *
 * `participantFacts` lets a caller deriving several Products of one participant
 * read the participant-level facts once; it never changes the answer.
 */
export async function readProductLifecycleIn(
  tx: Tx,
  internalProductId: string,
  participantFacts: Map<string, ParticipantLifecycleFacts> = new Map(),
): Promise<ProductLifecycleRead | null> {
  const product = await tx.product.findUnique({
    where: { internalProductId },
    select: { productRef: true, sourceRecordId: true, currentSourceRecordVersion: true },
  });
  if (product === null) return null;

  const current = await tx.productSourceRecordVersionRow.findUnique({
    where: {
      sourceRecordId_sourceRecordVersion: {
        sourceRecordId: product.sourceRecordId,
        sourceRecordVersion: product.currentSourceRecordVersion,
      },
    },
    select: LIFECYCLE_VERSION_COLUMNS,
  });
  if (current === null) return null;

  const authorityParticipantId =
    current.authorityCreatorParticipantId !== null &&
    versionGrantsProductAuthority(current, current.authorityCreatorParticipantId)
      ? current.authorityCreatorParticipantId
      : null;

  const cacheKey = authorityParticipantId ?? "";
  let facts = participantFacts.get(cacheKey);
  if (facts === undefined) {
    facts = await readParticipantLifecycleFacts(tx, authorityParticipantId);
    participantFacts.set(cacheKey, facts);
  }

  const [activeSuspensions, productSuspensionCount, activation] = await Promise.all([
    tx.productSuspension.count({ where: { internalProductId, status: "ACTIVE" } }),
    tx.productSuspension.count({ where: { internalProductId } }),
    tx.productActivation.findUnique({ where: { currentForProductId: internalProductId } }),
  ]);

  let activationAuthority = null;
  if (activation !== null) {
    const later = await tx.productSourceRecordVersionRow.findMany({
      where: { sourceRecordId: product.sourceRecordId, seq: { gt: activation.activatedVersionSeq } },
      select: LIFECYCLE_VERSION_COLUMNS,
    });
    const laterVersionsHeld = later.every(
      (v) =>
        evaluateCompletenessOfVersionRow(v).complete &&
        taxClassificationReady({ classification: v.taxClassification, deliveryMode: v.factDeliveryMode }) &&
        versionGrantsProductAuthority(v, activation.participantId),
    );
    activationAuthority = {
      basis: basisOfActivationRow(activation),
      laterVersionsHeld,
      suspensionsRecordingThisActivation: await tx.productSuspension.count({
        where: { activationIdBeforeSuspension: activation.id },
      }),
    };
  }

  const basisNow: ProductActivationBasisNow = { ...facts.basisNow, productSuspensionCount };
  const lifecycle = deriveProductLifecycle({
    readiness: {
      productSuspended: activeSuspensions > 0,
      contentComplete: evaluateCompletenessOfVersionRow(current).complete,
      account: facts.readiness.account,
      participant: facts.readiness.participant,
      tax: { classification: current.taxClassification, deliveryMode: current.factDeliveryMode },
    },
    basisNow,
    activation: activationAuthority,
  });

  return {
    internalProductId,
    productRef: product.productRef,
    sourceRecordId: product.sourceRecordId,
    currentSourceRecordVersion: product.currentSourceRecordVersion,
    currentVersionSeq: current.seq,
    authorityParticipantId,
    lifecycle,
    basisNow,
    currentActivationId: activation?.id ?? null,
  };
}
