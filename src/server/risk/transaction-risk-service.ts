/**
 * The transaction risk gate (Phase 1.2) — SERVER ONLY.
 *
 * One synchronous decision, taken **before an Order is written and before any
 * payment is initiated**: may this transaction proceed?
 *
 * ## Every reason, not the first
 *
 * The evaluator collects all applicable denial codes rather than short-circuiting,
 * on the same reasoning as `evaluateListingBuyerEligibility`: an operator who
 * fixes one blocker only to meet the next has been told the truth twice and
 * helped once.
 *
 * ## It reads; it never writes
 *
 * No row is created, updated, or advanced here. A denied transaction leaves
 * **nothing behind** — no Order, no risk log, no counter — because a denial log
 * is a manual-review workflow's foundation and this phase explicitly builds none.
 *
 * ## Fails closed, and in three distinct ways
 *
 *   - **no active policy** → `RISK_POLICY_NOT_CONFIGURED`. Never a default limit.
 *   - **wrong currency** → `CURRENCY_NOT_PERMITTED`. A threshold in one currency
 *     says nothing about an amount in another, and comparing them numerically
 *     would be comparing dollars to yen.
 *   - **unreadable state** → the caller receives an exception and must refuse.
 *     A gate that cannot read is not a gate that permits.
 *
 * ## What it does not do
 *
 * No fraud score, no model, no velocity window, no reserve, no chargeback
 * prediction, no review queue. Every one needs data Monacado does not have and an
 * operational function that does not exist, and a score with nobody to review it
 * is a number that blocks buyers for reasons no one can explain.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  RiskDecision,
  canonicalizeDenialReasons,
  type RiskDenialReasonCode,
} from "../../contracts/marketplace/transaction-risk";
import { getPrisma } from "../db/client";
import { getActiveRiskPolicyVersionIn } from "./risk-policy-service";
import { RiskEvaluationFailureError } from "./risk-errors";
import { resolveCommerceApproval } from "../marketplace/participant-commerce-approval-service";
import { readReadinessIn } from "../marketplace/payment-account-service";
import { commerceBlockingScopesForRole } from "../../contracts/marketplace/restriction-enforcement";
import type { MarketplaceRole } from "../../contracts/marketplace/participant";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface RiskGateDeps {
  db?: Db;
}

/**
 * What the gate is asked about.
 *
 * Every field is derived from `prepareCheckout`'s output — the bound Listing
 * version, the resolved counterparties, and the quoted commercial amount — so a
 * caller cannot describe a transaction other than the one being priced.
 */
export interface TransactionRiskSubject {
  currency: string;
  /** The merchandise amount alone. Tax and shipping are not commercial amounts. */
  commercialRetailAmountMinorUnits: number;
  sellerParticipantId: string;
  promoterParticipantId: string | null;
  /** Whose clearance governs exposure — the Storefront's owner (`0M.9` §2). */
  storefrontOwnerParticipantId: string;
}

/**
 * Whether a participant currently holds an active restriction that withholds
 * commerce.
 *
 * **Not redundant with listing eligibility.** Any active restriction sets the
 * participant `RESTRICTED`, and `0M.7`'s persisted eligibility read already
 * refuses a Listing whose **controller** is in that state. But on a promoted sale
 * the party owed seller proceeds is the **Offer's** seller, who is not the
 * controller and whose status that read never looks at. This gate answers about
 * every party to the transaction, which is the case eligibility cannot cover.
 *
 * Reads `0M.R1`'s own records rather than inventing a second notion of "blocked".
 * `offer:publish` and `payout:receive` are the two scopes that bear on whether a
 * sale should happen at all: one withholds the right to offer, the other the
 * right to be paid, and booking proceeds for somebody barred from receiving them
 * creates a liability with no route to settlement.
 *
 * **Phase 1.15 — the scope list is no longer written here, and it is now
 * role-aware.** It comes from `commerceBlockingScopesForRole`, so this gate and
 * the standing seam in `beginCheckout` cannot disagree about which capabilities
 * bear on a sale. The role argument corrects a real defect: this function read
 * one flat list for both parties, so a PROMOTER restricted on `offer:publish` —
 * a capability a promoter never exercises — was refused, while the same flat
 * list gave a seller and a promoter identical treatment on scopes that do not
 * apply to both.
 *
 * This gate remains a *second* reader rather than the only one. It is retained
 * unchanged in purpose, and the authoritative participant-standing decision now
 * lives outside the risk policy, where it cannot be turned off by activating a
 * different policy version.
 */
async function hasCommerceBlockingRestriction(
  tx: Tx,
  participantId: string,
  role: MarketplaceRole,
): Promise<boolean> {
  const scopes = commerceBlockingScopesForRole(role);
  if (scopes.length === 0) return false;
  const count = await tx.participantRestriction.count({
    where: {
      participantId,
      status: "ACTIVE",
      scope: { in: [...scopes] },
    },
  });
  return count > 0;
}

/**
 * Evaluate one transaction against the active risk policy.
 *
 * `policyId` names *which* risk policy governs this deployment; its version is
 * resolved here from what is `ACTIVE`, and the decision names the exact
 * `(policyId, policyVersion)` that produced it — so an allowed transaction is as
 * explicable after the fact as a denied one.
 */
export async function evaluateTransactionRisk(
  subject: TransactionRiskSubject,
  policyId: string,
  at: string,
  deps: RiskGateDeps = {},
): Promise<RiskDecision> {
  const db = deps.db ?? getPrisma();

  try {
    const policy = await getActiveRiskPolicyVersionIn(db, policyId);

    /* No configured control is a denial, not a permissive default. The safe
       reading of silence is "no" — 0M.9's own rule for absent approval. */
    if (policy === null) {
      return RiskDecision.parse({
        decision: "DENY",
        reasonCodes: ["RISK_POLICY_NOT_CONFIGURED"],
        policyId: null,
        policyVersion: null,
        evaluatedAt: at,
      });
    }

    const reasons: RiskDenialReasonCode[] = [];

    /* A threshold in one currency says nothing about an amount in another.
       Checked BEFORE the amount, so a mismatch is never silently compared. */
    if (policy.currency !== subject.currency) {
      reasons.push("CURRENCY_NOT_PERMITTED");
    } else if (
      subject.commercialRetailAmountMinorUnits >
      policy.maxSingleOrderCommercialAmountMinorUnits
    ) {
      reasons.push("ORDER_AMOUNT_EXCEEDS_LIMIT");
    }

    if (await hasCommerceBlockingRestriction(db, subject.sellerParticipantId, "SELLER")) {
      reasons.push("SELLER_RESTRICTED");
    }
    if (
      subject.promoterParticipantId !== null &&
      (await hasCommerceBlockingRestriction(db, subject.promoterParticipantId, "PROMOTER"))
    ) {
      reasons.push("PROMOTER_RESTRICTED");
    }

    if (policy.requireSellerCommerceApproval) {
      /* The Storefront OWNER's clearance, which is whose `storefrontExposure`
         has always been about — 0M.9 §2. On a promoted sale that is the
         promoter, because the promoter owns the shop the sale happens in. */
      const approval = await resolveCommerceApproval(db, subject.storefrontOwnerParticipantId);
      if (approval !== "APPROVED") reasons.push("SELLER_NOT_COMMERCE_APPROVED");
    }

    if (policy.requireSellerPaymentReadiness) {
      /* 0M.8's persisted readiness. Booking proceeds for a seller who can never
         be paid creates a liability with no route to settlement. */
      const readiness = await readReadinessIn(db, subject.sellerParticipantId);
      if (readiness !== "ENABLED") reasons.push("SELLER_PAYMENT_NOT_READY");
    }

    return RiskDecision.parse({
      decision: reasons.length === 0 ? "ALLOW" : "DENY",
      reasonCodes: canonicalizeDenialReasons(reasons),
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      evaluatedAt: at,
    });
  } catch (error) {
    /* A gate that cannot read is not a gate that permits. The caller must
       refuse; it is given no decision to misread as an allowance. */
    throw new RiskEvaluationFailureError(error);
  }
}
