/**
 * The governed seller risk-review policy (Phase 1.13) — SERVER ONLY.
 *
 * Resolving the heuristics a review runs under, and publishing a new set.
 *
 * ## These are review heuristics, not enforcement limits
 *
 * Crossing a threshold here puts a seller in front of a person. It authorises
 * nothing, denies nothing, and restricts nothing — which is exactly why these
 * live apart from `RiskPolicy`, whose every field is a gate evaluated at
 * checkout against one Order. Phase 1.12 settled the general question when it
 * moved the chargeback fee to its own policy: a value resolved at a different
 * moment than the sale needs its own policy, or "which version applies" has more
 * than one defensible answer.
 *
 * ## Resolution has exactly one answer, and the database enforces it
 *
 * `activeMarker` is `policyId` while a version is `ACTIVE` and `NULL` otherwise,
 * under a unique index — so "which heuristics stand right now" is a single-row
 * lookup that cannot return two, because MySQL refuses the second `ACTIVE` row
 * rather than this module remembering to retire the incumbent.
 *
 * ## There is no fallback, and that is the point
 *
 * `resolveActiveReviewPolicy` returns `null` when nothing stands, and the report
 * refuses rather than ranking sellers against numbers nobody activated. A
 * compiled default would be the mistake Phase 1.12 had to undo — correct and
 * unchangeable in one stroke — with a worse consequence here, because the
 * numbers decide whose livelihood gets looked at.
 *
 * ## Publishing is two decisions
 *
 * Recording a version governs nobody; activating one changes which sellers
 * tomorrow's report surfaces. Separate calls, for the reason `policy:bootstrap`
 * keeps them separate.
 */

import "../server-only";
import {
  SELLER_RISK_REVIEW_POLICY_KEY,
  type SellerRiskReviewPolicyVersionRecord,
} from "../../contracts/marketplace/seller-risk-review";
import { getPrisma } from "../db/client";
import { SellerRiskRequestError } from "./seller-risk-errors";
import {
  cryptoSellerRiskReviewPolicyIdProvider,
  type SellerRiskReviewPolicyIdProvider,
} from "./seller-risk-ids";

export interface ReviewPolicyDeps {
  db?: ReturnType<typeof getPrisma>;
  ids?: SellerRiskReviewPolicyIdProvider;
}

/** The thresholds a report actually applies, resolved once per run. */
export interface ActiveReviewPolicy {
  policyId: string;
  policyVersion: string;
  minimumRateSampleCount: number;
  minimumBaselineSampleCount: number;
  refundCountRateReviewBasisPoints: number;
  chargebackCountRateReviewBasisPoints: number;
  chargebackToRefundRatioReviewBasisPoints: number;
  velocityReviewBasisPoints: number;
  averageTicketShiftReviewBasisPoints: number;
  volumeSpikeReviewBasisPoints: number;
  jurisdictionConcentrationReviewBasisPoints: number;
  newJurisdictionReviewCount: number;
  promoterConcentrationReviewBasisPoints: number;
  attentionScoreFloor: number;
}

/**
 * A STARTING POINT AN OPERATOR MUST ACTIVATE, never a value anything falls back
 * to.
 *
 * Exported so `risk:review:policy --record` has something to write and so the
 * numbers are reviewable in source rather than typed at a terminal. Nothing
 * resolves it implicitly: an unactivated deployment refuses to rank rather than
 * ranking against these.
 *
 * The values are deliberately conservative — high enough that an ordinary seller
 * having an ordinary bad fortnight does not surface. They are NOT calibrated
 * against outcomes, because no outcome data exists yet to calibrate against, and
 * a threshold tuned on nothing is a guess with a version number. That is the
 * honest reason they are governed and changeable rather than fixed here.
 */
export const SELLER_RISK_REVIEW_BOOTSTRAP_DEFAULT = {
  label: "Monacado seller risk review heuristics",
  /* Ten sales before a rate is published as a rate. Below it, one chargeback
     reads as 10 000 basis points and means nothing. */
  minimumRateSampleCount: 10,
  minimumBaselineSampleCount: 10,
  /* 500bp = 5%. */
  refundCountRateReviewBasisPoints: 500,
  /* 100bp = 1%, near where card networks begin to take an interest. */
  chargebackCountRateReviewBasisPoints: 100,
  /* 5000bp: as many chargebacks as refunds is a seller buyers do not come to. */
  chargebackToRefundRatioReviewBasisPoints: 5_000,
  /* A tripling, in each case. */
  velocityReviewBasisPoints: 20_000,
  averageTicketShiftReviewBasisPoints: 20_000,
  volumeSpikeReviewBasisPoints: 30_000,
  /* 8000bp = 80% of orders into one jurisdiction. */
  jurisdictionConcentrationReviewBasisPoints: 8_000,
  newJurisdictionReviewCount: 5,
  /* 9000bp = 90% of a seller's volume through one promoter. */
  promoterConcentrationReviewBasisPoints: 9_000,
  attentionScoreFloor: 25,
} as const;

export async function resolveActiveReviewPolicy(
  deps: ReviewPolicyDeps = {},
): Promise<ActiveReviewPolicy | null> {
  const db = deps.db ?? getPrisma();
  const policy = await db.sellerRiskReviewPolicy.findUnique({
    where: { policyKey: SELLER_RISK_REVIEW_POLICY_KEY },
    select: { id: true },
  });
  if (policy === null) return null;

  const row = await db.sellerRiskReviewPolicyVersionRow.findFirst({
    where: { policyId: policy.id, status: "ACTIVE" },
  });
  if (row === null) return null;

  return {
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    minimumRateSampleCount: row.minimumRateSampleCount,
    minimumBaselineSampleCount: row.minimumBaselineSampleCount,
    refundCountRateReviewBasisPoints: row.refundCountRateReviewBasisPoints,
    chargebackCountRateReviewBasisPoints: row.chargebackCountRateReviewBasisPoints,
    chargebackToRefundRatioReviewBasisPoints: row.chargebackToRefundRatioReviewBasisPoints,
    velocityReviewBasisPoints: row.velocityReviewBasisPoints,
    averageTicketShiftReviewBasisPoints: row.averageTicketShiftReviewBasisPoints,
    volumeSpikeReviewBasisPoints: row.volumeSpikeReviewBasisPoints,
    jurisdictionConcentrationReviewBasisPoints: row.jurisdictionConcentrationReviewBasisPoints,
    newJurisdictionReviewCount: row.newJurisdictionReviewCount,
    promoterConcentrationReviewBasisPoints: row.promoterConcentrationReviewBasisPoints,
    attentionScoreFloor: row.attentionScoreFloor,
  };
}

export async function readReviewPolicyVersions(
  deps: ReviewPolicyDeps = {},
): Promise<SellerRiskReviewPolicyVersionRecord[]> {
  const db = deps.db ?? getPrisma();
  const policy = await db.sellerRiskReviewPolicy.findUnique({
    where: { policyKey: SELLER_RISK_REVIEW_POLICY_KEY },
    select: { id: true },
  });
  if (policy === null) return [];

  const rows = await db.sellerRiskReviewPolicyVersionRow.findMany({
    where: { policyId: policy.id },
    orderBy: [{ effectiveFrom: "asc" }, { seq: "asc" }],
  });

  return rows.map((row) => ({
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    status: row.status as SellerRiskReviewPolicyVersionRecord["status"],
    minimumRateSampleCount: row.minimumRateSampleCount,
    minimumBaselineSampleCount: row.minimumBaselineSampleCount,
    refundCountRateReviewBasisPoints: row.refundCountRateReviewBasisPoints,
    chargebackCountRateReviewBasisPoints: row.chargebackCountRateReviewBasisPoints,
    chargebackToRefundRatioReviewBasisPoints: row.chargebackToRefundRatioReviewBasisPoints,
    velocityReviewBasisPoints: row.velocityReviewBasisPoints,
    averageTicketShiftReviewBasisPoints: row.averageTicketShiftReviewBasisPoints,
    volumeSpikeReviewBasisPoints: row.volumeSpikeReviewBasisPoints,
    jurisdictionConcentrationReviewBasisPoints: row.jurisdictionConcentrationReviewBasisPoints,
    newJurisdictionReviewCount: row.newJurisdictionReviewCount,
    promoterConcentrationReviewBasisPoints: row.promoterConcentrationReviewBasisPoints,
    attentionScoreFloor: row.attentionScoreFloor,
    effectiveFrom: row.effectiveFrom.toISOString(),
    recordedByAccountId: row.recordedByAccountId,
    recordedAt: row.recordedAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
    retiredByAccountId: row.retiredByAccountId,
  }));
}

export interface RecordReviewPolicyInput {
  policyVersion: string;
  thresholds?: Partial<Omit<ActiveReviewPolicy, "policyId" | "policyVersion">>;
  effectiveFrom: string;
  recordedByAccountId: string;
  at: string;
  label?: string;
}

/** Record a DRAFT version. Governs nobody until activated. */
export async function recordReviewPolicyVersion(
  input: RecordReviewPolicyInput,
  deps: ReviewPolicyDeps = {},
): Promise<SellerRiskReviewPolicyVersionRecord> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoSellerRiskReviewPolicyIdProvider;

  const values = { ...SELLER_RISK_REVIEW_BOOTSTRAP_DEFAULT, ...(input.thresholds ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (key === "label") continue;
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new SellerRiskRequestError(`${key} must be a non-negative integer`);
    }
  }

  const policy =
    (await db.sellerRiskReviewPolicy.findUnique({
      where: { policyKey: SELLER_RISK_REVIEW_POLICY_KEY },
      select: { id: true },
    })) ??
    (await db.sellerRiskReviewPolicy.create({
      data: {
        id: ids.nextSellerRiskReviewPolicyId(),
        policyKey: SELLER_RISK_REVIEW_POLICY_KEY,
        label: input.label ?? SELLER_RISK_REVIEW_BOOTSTRAP_DEFAULT.label,
      },
      select: { id: true },
    }));

  const existing = await db.sellerRiskReviewPolicyVersionRow.findUnique({
    where: {
      policyId_policyVersion: { policyId: policy.id, policyVersion: input.policyVersion },
    },
  });
  if (existing !== null) {
    /* A version label names one immutable set of thresholds. Re-recording it
       with different numbers is refused rather than applied: every review opened
       under it cites this label to explain why that seller was surfaced. */
    if (
      existing.refundCountRateReviewBasisPoints !== values.refundCountRateReviewBasisPoints ||
      existing.chargebackCountRateReviewBasisPoints !==
        values.chargebackCountRateReviewBasisPoints ||
      existing.attentionScoreFloor !== values.attentionScoreFloor ||
      existing.minimumRateSampleCount !== values.minimumRateSampleCount
    ) {
      throw new SellerRiskRequestError(
        "This review policy version already exists with different thresholds",
      );
    }
    return (await readReviewPolicyVersions(deps)).find(
      (v) => v.policyVersion === input.policyVersion,
    )!;
  }

  await db.sellerRiskReviewPolicyVersionRow.create({
    data: {
      policyId: policy.id,
      policyVersion: input.policyVersion,
      status: "DRAFT",
      minimumRateSampleCount: values.minimumRateSampleCount,
      minimumBaselineSampleCount: values.minimumBaselineSampleCount,
      refundCountRateReviewBasisPoints: values.refundCountRateReviewBasisPoints,
      chargebackCountRateReviewBasisPoints: values.chargebackCountRateReviewBasisPoints,
      chargebackToRefundRatioReviewBasisPoints: values.chargebackToRefundRatioReviewBasisPoints,
      velocityReviewBasisPoints: values.velocityReviewBasisPoints,
      averageTicketShiftReviewBasisPoints: values.averageTicketShiftReviewBasisPoints,
      volumeSpikeReviewBasisPoints: values.volumeSpikeReviewBasisPoints,
      jurisdictionConcentrationReviewBasisPoints:
        values.jurisdictionConcentrationReviewBasisPoints,
      newJurisdictionReviewCount: values.newJurisdictionReviewCount,
      promoterConcentrationReviewBasisPoints: values.promoterConcentrationReviewBasisPoints,
      attentionScoreFloor: values.attentionScoreFloor,
      effectiveFrom: new Date(input.effectiveFrom),
      recordedByAccountId: input.recordedByAccountId,
      recordedAt: new Date(input.at),
      activeMarker: null,
    },
  });

  return (await readReviewPolicyVersions(deps)).find(
    (v) => v.policyVersion === input.policyVersion,
  )!;
}

/**
 * Activate a recorded version, retiring whatever stands.
 *
 * One transaction, so there is never an instant with two active versions or
 * none. It touches no review row: a review already opened cites the version that
 * surfaced it, and re-pointing it at newer thresholds would rewrite why somebody
 * was looked at.
 */
export async function activateReviewPolicyVersion(
  input: { policyVersion: string; activatedByAccountId: string; at: string },
  deps: ReviewPolicyDeps = {},
): Promise<SellerRiskReviewPolicyVersionRecord> {
  const db = deps.db ?? getPrisma();

  const policy = await db.sellerRiskReviewPolicy.findUnique({
    where: { policyKey: SELLER_RISK_REVIEW_POLICY_KEY },
    select: { id: true },
  });
  if (policy === null) throw new SellerRiskRequestError("No review policy has been recorded");

  const target = await db.sellerRiskReviewPolicyVersionRow.findUnique({
    where: {
      policyId_policyVersion: { policyId: policy.id, policyVersion: input.policyVersion },
    },
  });
  if (target === null) throw new SellerRiskRequestError("That review policy version is not recorded");
  if (target.status === "ACTIVE") {
    return (await readReviewPolicyVersions(deps)).find(
      (v) => v.policyVersion === input.policyVersion,
    )!;
  }
  /* A retired version never returns. Reviving one would make "which thresholds
     stood when" unanswerable from the row's own history. */
  if (target.status === "RETIRED") {
    throw new SellerRiskRequestError("That review policy version is retired");
  }

  await db.$transaction(async (tx) => {
    const standing = await tx.sellerRiskReviewPolicyVersionRow.findFirst({
      where: { policyId: policy.id, status: "ACTIVE" },
      select: { seq: true },
    });
    if (standing !== null) {
      await tx.sellerRiskReviewPolicyVersionRow.update({
        where: { seq: standing.seq },
        data: {
          status: "RETIRED",
          retiredAt: new Date(input.at),
          retiredByAccountId: input.activatedByAccountId,
          activeMarker: null,
        },
      });
    }
    await tx.sellerRiskReviewPolicyVersionRow.update({
      where: { seq: target.seq },
      data: { status: "ACTIVE", activeMarker: policy.id },
    });
  });

  return (await readReviewPolicyVersions(deps)).find(
    (v) => v.policyVersion === input.policyVersion,
  )!;
}
