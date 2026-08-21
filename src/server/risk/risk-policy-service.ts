/**
 * Versioned risk policy persistence (Phase 1.2) — SERVER ONLY.
 *
 * Mirrors `commercial-policy-service.ts` deliberately rather than inventing a
 * second convention: immutable versions, at most one `ACTIVE` per policy enforced
 * by the `activeMarker` unique index, retired versions still readable so a past
 * decision stays explicable.
 *
 * The reason a threshold gets this machinery at all is that a maximum order
 * amount hard-coded in source is a number that changes with no record of who
 * changed it or what an Order was evaluated under. A risk decision that cannot be
 * reconstructed is not a control; it is a coincidence.
 *
 * **No effective-version fallback.** A policy with no `ACTIVE` version is a
 * refusal, never a default limit — the same rule `0M.R1` applies, and the same
 * reason `0M.9` made an absent commerce approval mean `NOT_APPROVED`.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  RecordRiskPolicyVersionInput,
  RiskPolicyVersionRecord,
} from "../../contracts/marketplace/transaction-risk";
import { getPrisma } from "../db/client";
import { RiskError } from "./risk-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface RiskPolicyDeps {
  db?: Db;
  ids?: { nextRiskPolicyId(): string };
}

function rowToRecord(row: {
  policyId: string;
  policyVersion: string;
  status: string;
  currency: string;
  maxSingleOrderCommercialAmountMinorUnits: bigint;
  requireSellerCommerceApproval: boolean;
  requireSellerPaymentReadiness: boolean;
  effectiveFrom: Date;
  recordedByAccountId: string;
  recordedAt: Date;
  retiredAt: Date | null;
  retiredByAccountId: string | null;
}): RiskPolicyVersionRecord {
  const parsed = RiskPolicyVersionRecord.safeParse({
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    status: row.status,
    currency: row.currency,
    maxSingleOrderCommercialAmountMinorUnits: Number(
      row.maxSingleOrderCommercialAmountMinorUnits,
    ),
    requireSellerCommerceApproval: row.requireSellerCommerceApproval,
    requireSellerPaymentReadiness: row.requireSellerPaymentReadiness,
    effectiveFrom: row.effectiveFrom.toISOString(),
    recordedByAccountId: row.recordedByAccountId,
    recordedAt: row.recordedAt.toISOString(),
    retiredAt: row.retiredAt === null ? null : row.retiredAt.toISOString(),
    retiredByAccountId: row.retiredByAccountId,
  });
  if (!parsed.success) {
    throw new RiskError("CORRUPT_RISK_POLICY", "A persisted risk policy version is malformed");
  }
  return parsed.data;
}

export async function createRiskPolicy(
  input: { label: string; now: string },
  deps: RiskPolicyDeps = {},
): Promise<{ policyId: string }> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids;
  if (ids === undefined) {
    throw new RiskError("RISK_POLICY_ID_PROVIDER_REQUIRED", "an id provider is required");
  }
  const row = await db.riskPolicy.create({
    data: {
      id: ids.nextRiskPolicyId(),
      label: input.label,
      createdAt: new Date(input.now),
    },
  });
  return { policyId: row.id };
}

/** Record one immutable version. Created `DRAFT`; activation is separate. */
export async function recordRiskPolicyVersion(
  input: unknown,
  deps: RiskPolicyDeps = {},
): Promise<RiskPolicyVersionRecord> {
  const parsed = RecordRiskPolicyVersionInput.safeParse(input);
  if (!parsed.success) {
    throw new RiskError("INVALID_RISK_POLICY_INPUT", "Invalid risk policy version input");
  }
  const v = parsed.data;
  const db = deps.db ?? getPrisma();

  const row = await db.riskPolicyVersionRow.create({
    data: {
      policyId: v.policyId,
      policyVersion: v.policyVersion,
      /* DRAFT and no other status. There is no `status` parameter, so a caller
         cannot record a version as already governing transactions. */
      status: "DRAFT",
      currency: v.currency,
      maxSingleOrderCommercialAmountMinorUnits: BigInt(
        v.maxSingleOrderCommercialAmountMinorUnits,
      ),
      requireSellerCommerceApproval: v.requireSellerCommerceApproval,
      requireSellerPaymentReadiness: v.requireSellerPaymentReadiness,
      effectiveFrom: new Date(v.effectiveFrom),
      recordedByAccountId: v.recordedByAccountId,
      recordedAt: new Date(v.recordedAt),
      activeMarker: null,
    },
  });
  return rowToRecord(row);
}

/**
 * Activate one version, retiring whichever currently stands.
 *
 * One transaction, so there is never an instant with two active versions or
 * none. The `activeMarker` unique index is the structural backstop: even a
 * concurrent activation cannot produce two.
 */
export async function activateRiskPolicyVersion(
  input: {
    policyId: string;
    policyVersion: string;
    activatedByAccountId: string;
    activatedAt: string;
  },
  deps: RiskPolicyDeps = {},
): Promise<RiskPolicyVersionRecord> {
  const db = deps.db ?? getPrisma();
  return await db.$transaction(async (tx) => {
    const current = await tx.riskPolicyVersionRow.findFirst({
      where: { policyId: input.policyId, status: "ACTIVE" },
    });
    if (current !== null) {
      await tx.riskPolicyVersionRow.update({
        where: { seq: current.seq },
        data: {
          status: "RETIRED",
          retiredAt: new Date(input.activatedAt),
          retiredByAccountId: input.activatedByAccountId,
          activeMarker: null,
        },
      });
    }
    const target = await tx.riskPolicyVersionRow.findUnique({
      where: {
        policyId_policyVersion: {
          policyId: input.policyId,
          policyVersion: input.policyVersion,
        },
      },
    });
    if (target === null) {
      throw new RiskError("RISK_POLICY_VERSION_NOT_FOUND", "No such risk policy version");
    }
    if (target.status === "RETIRED") {
      /* A retired version stays readable so past decisions remain explicable,
         but it does not come back — reactivating one would make "which controls
         applied when" unanswerable. */
      throw new RiskError("RISK_POLICY_VERSION_RETIRED", "A retired version cannot be activated");
    }
    const row = await tx.riskPolicyVersionRow.update({
      where: { seq: target.seq },
      data: { status: "ACTIVE", activeMarker: input.policyId },
    });
    return rowToRecord(row);
  });
}

/**
 * The version currently governing transactions, or `null`.
 *
 * `null` rather than a thrown error, because the caller's correct response is a
 * **denial with a reason code**, not an exception — an unconfigured deployment
 * refusing commerce is an ordinary, explicable state.
 */
export async function getActiveRiskPolicyVersionIn(
  tx: Tx,
  policyId: string,
): Promise<RiskPolicyVersionRecord | null> {
  const row = await tx.riskPolicyVersionRow.findFirst({
    where: { policyId, status: "ACTIVE" },
  });
  return row === null ? null : rowToRecord(row);
}

export async function getActiveRiskPolicyVersion(
  policyId: string,
  deps: RiskPolicyDeps = {},
): Promise<RiskPolicyVersionRecord | null> {
  return getActiveRiskPolicyVersionIn(deps.db ?? getPrisma(), policyId);
}
