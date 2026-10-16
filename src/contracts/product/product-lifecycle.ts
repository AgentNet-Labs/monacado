/**
 * Product lifecycle and explicit Product activation (Phase 1.39) — pure.
 *
 * Contract §9.1 defines four states and §9.2 the explicit Seller act that
 * creates `ACTIVE`. This module states both as pure decisions over facts the
 * server gathers; it reads no database, clock, or environment.
 *
 * ## The lifecycle is derived, never stored
 *
 * | State        | Derived when                                                     |
 * | ------------ | ---------------------------------------------------------------- |
 * | `SUSPENDED`  | a Monacado `ProductSuspension` stands (dominates everything)      |
 * | `INCOMPLETE` | the current source version fails `PRODUCT_COMPLETENESS_V1`        |
 * | `ACTIVE`     | complete, every readiness gate passes NOW, and an explicit        |
 * |              | activation is in effect — readiness has held CONTINUOUSLY since   |
 * | `COMPLETE`   | otherwise                                                        |
 *
 * What is stored is authority, never the state: the Seller's activation act
 * (with the readiness basis it was granted against) and Monacado's suspension.
 *
 * ## Why continuity, and why it needs no background job
 *
 * §9.1 / §9.2: an `ACTIVE` Product that lost readiness falls to `COMPLETE`, and
 * restoring readiness must NOT restore `ACTIVE` — the Seller activates again.
 * Re-checking readiness on read handles the first half. The second half needs
 * to know that readiness lapsed at some point, even if it is fine now. Each
 * readiness fact therefore contributes a value that necessarily changes on a
 * lapse-and-restore cycle, recorded at activation:
 *
 *   - email:       `emailVerifiedAt` (re-verification writes a new instant);
 *   - SELLER role: its `activatedAt` (re-activation writes a new instant);
 *   - payment:     `readinessEnabledSince` (written on entering `ENABLED`);
 *   - standing:    COUNTS of the participant's restriction and suspension rows,
 *                  which are append-only — any new one is a lapse, even if lifted
 *                  (a restriction of any scope also moves an ACTIVE participant
 *                  to RESTRICTED, so it is a lapse of participant status too);
 *   - approval:    the COUNT of non-`APPROVED` commerce decisions (append-only);
 *   - content:     every source version written after the activated one must
 *                  itself be complete, tax-ready, and under the same authority.
 *
 * Counts and exact values, never clock order, so the answer does not depend on
 * two servers agreeing about the time. Any mismatch leaves the activation
 * permanently ineffective; only a new explicit activation creates `ACTIVE` again.
 *
 * Declared names have no lapse path today — they are set at registration and no
 * flow edits or clears them — so they are checked on every read but carry no
 * basis value. A future name-editing flow must add one.
 *
 * ## Suspension reinstatement (§9.1)
 *
 * A Product suspension records whether an activation was in effect immediately
 * before it. A suspension imposed after an activation breaks that activation's
 * continuity UNLESS it recorded that very activation — so lifting it restores
 * `ACTIVE` exactly when the Product was `ACTIVE` before, is still complete, and
 * every readiness fact held throughout; and it can never create `ACTIVE` for a
 * Product that was `COMPLETE` before.
 */

import { z } from "zod";
import type { ParticipantStatus } from "../marketplace/participant";
import {
  ProductTaxClassification,
  taxClassificationAgreesWithDelivery,
} from "./product-tax-classification";
import { DeliveryMode } from "./product.capsule";

// — States —

export const PRODUCT_LIFECYCLE_STATES = ["INCOMPLETE", "COMPLETE", "ACTIVE", "SUSPENDED"] as const;
export const ProductLifecycleState = z.enum(PRODUCT_LIFECYCLE_STATES);
export type ProductLifecycleState = z.infer<typeof ProductLifecycleState>;

/** What a suspension may record as the state immediately before it. */
export const PRE_SUSPENSION_LIFECYCLE_STATES = ["INCOMPLETE", "COMPLETE", "ACTIVE"] as const;
export type PreSuspensionLifecycleState = (typeof PRE_SUSPENSION_LIFECYCLE_STATES)[number];

// — Activation readiness —

/**
 * Why a Product cannot be activated now, as a closed vocabulary.
 *
 * Classifications only — no name, address, provider message, reason code, or
 * identifier — so the list is safe to return to the Seller it is about. Ordered:
 * the evaluator reports every blocker that applies, in this order, and a route
 * reporting one reports the first.
 */
export const PRODUCT_ACTIVATION_BLOCKERS = [
  /** A Monacado Product suspension stands. */
  "PRODUCT_SUSPENDED",
  /** The current source version fails `PRODUCT_COMPLETENESS_V1`. */
  "PRODUCT_INCOMPLETE",
  /** The Seller's account email address is not verified (Contract §4, §7). */
  "EMAIL_UNVERIFIED",
  /** No declared first name (Contract §4). A declaration, never a verification. */
  "FIRST_NAME_MISSING",
  /** No declared last name (Contract §4). */
  "LAST_NAME_MISSING",
  /** The Product's authority names no marketplace participant. */
  "PARTICIPANT_MISSING",
  /** A participant suspension stands. */
  "PARTICIPANT_SUSPENDED",
  /** A `product:activate` restriction stands. */
  "PRODUCT_ACTIVATION_RESTRICTED",
  /** The participant is not admitted (`ACTIVE`). */
  "PARTICIPANT_NOT_ACTIVE",
  /** The SELLER role is not `ACTIVE`. */
  "SELLER_ROLE_NOT_ACTIVE",
  /** Payment / underwriting readiness is not `ENABLED` (Contract §5). */
  "PAYMENT_NOT_READY",
  /** No current `APPROVED` commerce approval. */
  "COMMERCE_APPROVAL_MISSING",
  /**
   * No Monacado tax classification, or one that contradicts the delivery mode.
   * Checkout refuses either; a Product that cannot be sold cannot be ACTIVE.
   * Tax classification is Monacado-authoritative and never part of
   * completeness.
   */
  "TAX_CLASSIFICATION_NOT_READY",
] as const;
export const ProductActivationBlocker = z.enum(PRODUCT_ACTIVATION_BLOCKERS);
export type ProductActivationBlocker = z.infer<typeof ProductActivationBlocker>;

/** The current facts activation readiness is decided on. */
export interface ProductActivationReadinessFacts {
  productSuspended: boolean;
  /** `PRODUCT_COMPLETENESS_V1` over the current source version. */
  contentComplete: boolean;
  /** The authoring Seller's account. `Account.name` is deliberately absent. */
  account: { emailVerifiedAt: string | null; firstName: string | null; lastName: string | null };
  /** `null` when the Product's current authority names no participant. */
  participant: {
    status: ParticipantStatus;
    /** An ACTIVE `ParticipantSuspension` exists. */
    suspended: boolean;
    /** An ACTIVE `product:activate` restriction exists. */
    productActivationRestricted: boolean;
    /** Anything but `ACTIVE` blocks, including a marker the server reports for
        an ACTIVE role it cannot date. */
    sellerRoleStatus: string | null;
    /** Anything but `ENABLED` blocks, including a marker the server reports for
        readiness it cannot date or cannot reduce to one account. */
    paymentReadiness: string;
    /** The commerce approval in force (`NOT_APPROVED` when none). */
    commerceApproval: string;
  } | null;
  /** The current source version's Monacado tax facts. */
  tax: { classification: string | null; deliveryMode: string | null };
}

export interface ProductActivationReadiness {
  ready: boolean;
  blockers: ProductActivationBlocker[];
}

const nonBlank = (value: string | null): boolean => value !== null && value.trim() !== "";

/** Is this version's tax classification present, valid, and consistent with delivery? */
export function taxClassificationReady(tax: {
  classification: string | null;
  deliveryMode: string | null;
}): boolean {
  const classification = ProductTaxClassification.safeParse(tax.classification);
  const delivery = DeliveryMode.safeParse(tax.deliveryMode);
  return (
    classification.success &&
    delivery.success &&
    taxClassificationAgreesWithDelivery(classification.data, delivery.data)
  );
}

/**
 * THE Product activation-readiness evaluator — the one place the gates of
 * Contract §9.2 are stated. Requires no Storefront, Listing, or Offer.
 */
export function evaluateProductActivationReadiness(
  facts: ProductActivationReadinessFacts,
): ProductActivationReadiness {
  const blockers: ProductActivationBlocker[] = [];
  if (facts.productSuspended) blockers.push("PRODUCT_SUSPENDED");
  if (!facts.contentComplete) blockers.push("PRODUCT_INCOMPLETE");
  if (facts.account.emailVerifiedAt === null) blockers.push("EMAIL_UNVERIFIED");
  if (!nonBlank(facts.account.firstName)) blockers.push("FIRST_NAME_MISSING");
  if (!nonBlank(facts.account.lastName)) blockers.push("LAST_NAME_MISSING");

  const participant = facts.participant;
  if (participant === null) {
    blockers.push("PARTICIPANT_MISSING");
  } else {
    if (participant.suspended) blockers.push("PARTICIPANT_SUSPENDED");
    if (participant.productActivationRestricted) blockers.push("PRODUCT_ACTIVATION_RESTRICTED");
    if (participant.status !== "ACTIVE") blockers.push("PARTICIPANT_NOT_ACTIVE");
    if (participant.sellerRoleStatus !== "ACTIVE") blockers.push("SELLER_ROLE_NOT_ACTIVE");
    if (participant.paymentReadiness !== "ENABLED") blockers.push("PAYMENT_NOT_READY");
    if (participant.commerceApproval !== "APPROVED") blockers.push("COMMERCE_APPROVAL_MISSING");
  }

  if (!taxClassificationReady(facts.tax)) blockers.push("TAX_CLASSIFICATION_NOT_READY");

  return { ready: blockers.length === 0, blockers };
}

// — Activation basis and continuity —

/**
 * The lapse-revealing value of each readiness fact. Captured at activation;
 * compared, exactly, on every read. Instants are ISO strings, compared as
 * values — equality, never order.
 */
export interface ProductActivationBasis {
  participantId: string;
  emailVerifiedAt: string;
  sellerRoleActivatedAt: string;
  paymentEnabledSince: string;
  restrictionCount: number;
  participantSuspensionCount: number;
  nonApprovalDecisionCount: number;
  productSuspensionCount: number;
}

/** The same values, read now. A value is `null` where the fact has none now. */
export interface ProductActivationBasisNow {
  participantId: string | null;
  emailVerifiedAt: string | null;
  sellerRoleActivatedAt: string | null;
  paymentEnabledSince: string | null;
  restrictionCount: number;
  participantSuspensionCount: number;
  nonApprovalDecisionCount: number;
  productSuspensionCount: number;
}

/**
 * The basis a new activation records, or `null` when one of its instants is
 * missing — a fact that cannot be pinned cannot be shown to have held, so the
 * activation is refused rather than granted against a hole.
 */
export function activationBasisFrom(now: ProductActivationBasisNow): ProductActivationBasis | null {
  if (
    now.participantId === null ||
    now.emailVerifiedAt === null ||
    now.sellerRoleActivatedAt === null ||
    now.paymentEnabledSince === null
  ) {
    return null;
  }
  return {
    participantId: now.participantId,
    emailVerifiedAt: now.emailVerifiedAt,
    sellerRoleActivatedAt: now.sellerRoleActivatedAt,
    paymentEnabledSince: now.paymentEnabledSince,
    restrictionCount: now.restrictionCount,
    participantSuspensionCount: now.participantSuspensionCount,
    nonApprovalDecisionCount: now.nonApprovalDecisionCount,
    productSuspensionCount: now.productSuspensionCount,
  };
}

/** One recorded activation, as the derivation needs it. */
export interface ProductActivationAuthority {
  basis: ProductActivationBasis;
  /**
   * Every source version written AFTER the activated one is complete,
   * tax-ready, and authored by the activating participant. A single version
   * that was not — even one since superseded — is a lapse.
   */
  laterVersionsHeld: boolean;
  /** Product suspensions that recorded THIS activation as in effect. */
  suspensionsRecordingThisActivation: number;
}

/** Has every readiness fact held continuously since this activation? */
export function activationContinuityHolds(
  activation: ProductActivationAuthority,
  now: ProductActivationBasisNow,
): boolean {
  const basis = activation.basis;
  return (
    activation.laterVersionsHeld &&
    now.participantId === basis.participantId &&
    now.emailVerifiedAt === basis.emailVerifiedAt &&
    now.sellerRoleActivatedAt === basis.sellerRoleActivatedAt &&
    now.paymentEnabledSince === basis.paymentEnabledSince &&
    now.restrictionCount === basis.restrictionCount &&
    now.participantSuspensionCount === basis.participantSuspensionCount &&
    now.nonApprovalDecisionCount === basis.nonApprovalDecisionCount &&
    /* Every Product suspension since activation must have recorded this
       activation as in effect — the §9.1 reinstatement rule. */
    now.productSuspensionCount - basis.productSuspensionCount ===
      activation.suspensionsRecordingThisActivation
  );
}

// — Derivation —

export interface ProductLifecycleFacts {
  readiness: ProductActivationReadinessFacts;
  basisNow: ProductActivationBasisNow;
  /** The current (most recent) explicit activation, or `null` if never activated. */
  activation: ProductActivationAuthority | null;
}

export interface ProductLifecycle {
  lifecycle: ProductLifecycleState;
  /** Whether an explicit activation is in effect — true exactly when `ACTIVE`. */
  activationInEffect: boolean;
  /** Current activation readiness, for the activation decision and the page. */
  readiness: ProductActivationReadiness;
}

/** The effective lifecycle of one Product, from current authoritative facts. */
export function deriveProductLifecycle(facts: ProductLifecycleFacts): ProductLifecycle {
  const readiness = evaluateProductActivationReadiness(facts.readiness);
  if (facts.readiness.productSuspended) {
    return { lifecycle: "SUSPENDED", activationInEffect: false, readiness };
  }
  if (!facts.readiness.contentComplete) {
    return { lifecycle: "INCOMPLETE", activationInEffect: false, readiness };
  }
  const activationInEffect =
    facts.activation !== null &&
    readiness.ready &&
    activationContinuityHolds(facts.activation, facts.basisNow);
  return {
    lifecycle: activationInEffect ? "ACTIVE" : "COMPLETE",
    activationInEffect,
    readiness,
  };
}

// — Product suspension vocabulary —

/**
 * Why Monacado suspended a Product (Contract §9.1's governed grounds).
 *
 * Classifications of the concern, never findings: like the participant
 * mitigation vocabularies, no member names misconduct, so a code is safe to log
 * and to show the Seller.
 */
export const PRODUCT_SUSPENSION_REASON_CODES = [
  /** Monacado is reviewing the integrity of commerce in this Product. */
  "COMMERCE_INTEGRITY_REVIEW",
  /** Refunds or chargebacks on this Product are elevated. */
  "REFUND_OR_CHARGEBACK_LEVEL_ELEVATED",
  /** A regulatory or compliance review concerns this Product. */
  "REGULATORY_OR_COMPLIANCE_REVIEW",
  /** A safety concern about this Product. */
  "SAFETY_CONCERN",
  /** Another governed enforcement action, recorded deliberately. */
  "MANUAL_OPERATIONAL_SUSPENSION",
] as const;
export const ProductSuspensionReasonCode = z.enum(PRODUCT_SUSPENSION_REASON_CODES);
export type ProductSuspensionReasonCode = z.infer<typeof ProductSuspensionReasonCode>;

/** Why a Product suspension was lifted — its own vocabulary, as for participants. */
export const PRODUCT_SUSPENSION_LIFT_REASON_CODES = [
  "REQUIREMENT_SATISFIED",
  "REMEDIATION_COMPLETED",
  "REVIEW_CONCLUDED",
  "LIFTED_ON_RECONSIDERATION",
  /** It should not have been imposed. Recorded plainly rather than as a cure. */
  "IMPOSED_IN_ERROR",
] as const;
export const ProductSuspensionLiftReasonCode = z.enum(PRODUCT_SUSPENSION_LIFT_REASON_CODES);
export type ProductSuspensionLiftReasonCode = z.infer<typeof ProductSuspensionLiftReasonCode>;
