/**
 * The governed seller chargeback fee policy (Phase 1.12) — SERVER ONLY.
 *
 * Resolving what a chargeback costs, and publishing a new answer.
 *
 * ## Resolution has exactly one answer, and the database enforces it
 *
 * `activeMarker` is `policyId` while a version is `ACTIVE` and `NULL` otherwise,
 * under a unique index. So "what does a finalized chargeback cost right now" is a
 * single-row lookup that cannot return two rows — not because this module
 * remembers to retire the incumbent, but because the second `ACTIVE` row is
 * refused by MySQL. The same technique `CommercialPolicyVersionRow` and
 * `SellerRefundPolicyVersionRow` use.
 *
 * ## There is no fallback, and that is the point
 *
 * `resolveActiveChargebackFeePolicy` returns `null` when no version stands. It
 * does **not** reach for `SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT`. A silent
 * fallback would reintroduce the compiled `$30` this design exists to remove,
 * while looking governed — and a seller charged a fee no operator ever activated
 * is worse than a fee not charged.
 *
 * ## Publishing is two decisions, not one
 *
 * Recording a version governs nobody; activating one changes what the next
 * finalized chargeback costs. They are separate calls for the reason
 * `policy:bootstrap` keeps them separate: a command that activated as a side
 * effect of "add the new value" would be doing the consequential half by
 * accident.
 *
 * ## Prospective only
 *
 * Activation retires the incumbent and installs the successor in one transaction.
 * It touches no `SellerChargebackFee` row, because every assessment snapshotted
 * both its amount and its governing version pair at the moment it was made. A
 * fee change reaches the next chargeback and never a past one.
 */

import "../server-only";
import {
  SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT,
  SELLER_CHARGEBACK_FEE_POLICY_KEY,
  type SellerChargebackFeePolicyVersionView,
} from "../../contracts/marketplace/chargeback-fee";
import { getPrisma } from "../db/client";
import { DisputeEvidenceRefusedError } from "./dispute-errors";

export interface ChargebackFeePolicyDeps {
  db?: ReturnType<typeof getPrisma>;
  ids?: { nextChargebackFeePolicyId(): string };
}

/** The resolved governing value, or `null` when nothing stands. */
export interface ActiveChargebackFeePolicy {
  policyId: string;
  policyVersion: string;
  amountMinorUnits: number;
  currency: string;
}

/**
 * The version standing right now, or `null`.
 *
 * `null` is a real answer and callers must treat it as one. Nothing here
 * substitutes a default.
 */
export async function resolveActiveChargebackFeePolicy(
  deps: ChargebackFeePolicyDeps = {},
): Promise<ActiveChargebackFeePolicy | null> {
  const db = deps.db ?? getPrisma();
  const policy = await db.sellerChargebackFeePolicy.findUnique({
    where: { policyKey: SELLER_CHARGEBACK_FEE_POLICY_KEY },
    select: { id: true },
  });
  if (policy === null) return null;

  const version = await db.sellerChargebackFeePolicyVersionRow.findFirst({
    where: { policyId: policy.id, status: "ACTIVE" },
    select: { policyId: true, policyVersion: true, amountMinorUnits: true, currency: true },
  });
  if (version === null) return null;

  return {
    policyId: version.policyId,
    policyVersion: version.policyVersion,
    amountMinorUnits: Number(version.amountMinorUnits),
    currency: version.currency,
  };
}

/** Every version, newest recorded first. Retired ones stay readable. */
export async function readChargebackFeePolicyVersions(
  deps: ChargebackFeePolicyDeps = {},
): Promise<SellerChargebackFeePolicyVersionView[]> {
  const db = deps.db ?? getPrisma();
  const policy = await db.sellerChargebackFeePolicy.findUnique({
    where: { policyKey: SELLER_CHARGEBACK_FEE_POLICY_KEY },
    select: { id: true, policyKey: true },
  });
  if (policy === null) return [];

  const rows = await db.sellerChargebackFeePolicyVersionRow.findMany({
    where: { policyId: policy.id },
    orderBy: { recordedAt: "desc" },
  });
  return rows.map((row) => ({
    policyId: row.policyId,
    policyKey: policy.policyKey,
    policyVersion: row.policyVersion,
    status: row.status as SellerChargebackFeePolicyVersionView["status"],
    amountMinorUnits: Number(row.amountMinorUnits),
    currency: row.currency,
    effectiveFrom: row.effectiveFrom.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    retiredAt: row.retiredAt === null ? null : row.retiredAt.toISOString(),
  }));
}

/**
 * Record a new version as `DRAFT`.
 *
 * Idempotent on `(policyId, policyVersion)`: re-running with the same version
 * returns the existing row rather than a second one. Recording a `DRAFT` beside a
 * standing `ACTIVE` version is ordinary — that is how the next value is
 * published.
 *
 * **Refuses to redefine a version that already exists with different numbers.**
 * A version label names one immutable amount forever; quietly changing what
 * `1.0.0` means would make every fee assessed under it unexplainable.
 */
export async function recordChargebackFeePolicyVersion(
  input: {
    policyVersion: string;
    amountMinorUnits: number;
    currency: string;
    effectiveFrom: string;
    recordedByAccountId: string;
    at: string;
    label?: string;
  },
  deps: ChargebackFeePolicyDeps = {},
): Promise<SellerChargebackFeePolicyVersionView> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids;

  if (!Number.isInteger(input.amountMinorUnits) || input.amountMinorUnits < 0) {
    throw new DisputeEvidenceRefusedError("FEE_AMOUNT_NOT_A_NON_NEGATIVE_INTEGER");
  }
  if (input.currency.length !== 3) {
    throw new DisputeEvidenceRefusedError("FEE_CURRENCY_NOT_ISO_4217");
  }

  const policy =
    (await db.sellerChargebackFeePolicy.findUnique({
      where: { policyKey: SELLER_CHARGEBACK_FEE_POLICY_KEY },
      select: { id: true },
    })) ??
    (await db.sellerChargebackFeePolicy.create({
      data: {
        id: ids?.nextChargebackFeePolicyId() ?? `mon:cbfp:${SELLER_CHARGEBACK_FEE_POLICY_KEY}`,
        policyKey: SELLER_CHARGEBACK_FEE_POLICY_KEY,
        label: input.label ?? SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT.label,
      },
      select: { id: true },
    }));

  const existing = await db.sellerChargebackFeePolicyVersionRow.findUnique({
    where: {
      policyId_policyVersion: { policyId: policy.id, policyVersion: input.policyVersion },
    },
  });
  if (existing !== null) {
    /* A version label names one immutable amount. Re-recording it with different
       numbers is refused rather than applied, because every fee already assessed
       under it cites this label to explain itself. */
    if (
      Number(existing.amountMinorUnits) !== input.amountMinorUnits ||
      existing.currency !== input.currency
    ) {
      throw new DisputeEvidenceRefusedError("FEE_VERSION_ALREADY_EXISTS_WITH_DIFFERENT_VALUE");
    }
    return (await readChargebackFeePolicyVersions(deps)).find(
      (v) => v.policyVersion === input.policyVersion,
    )!;
  }

  await db.sellerChargebackFeePolicyVersionRow.create({
    data: {
      policyId: policy.id,
      policyVersion: input.policyVersion,
      status: "DRAFT",
      amountMinorUnits: BigInt(input.amountMinorUnits),
      currency: input.currency,
      effectiveFrom: new Date(input.effectiveFrom),
      recordedByAccountId: input.recordedByAccountId,
      recordedAt: new Date(input.at),
      /* NULL while DRAFT. Only an ACTIVE row claims the unique marker. */
      activeMarker: null,
    },
  });

  return (await readChargebackFeePolicyVersions(deps)).find(
    (v) => v.policyVersion === input.policyVersion,
  )!;
}

/**
 * Activate a recorded version, retiring whatever stands.
 *
 * One transaction, so there is never an instant with two active versions or
 * none. **Prospective only**: no `SellerChargebackFee` row is read or written
 * here, because every assessment already snapshotted its governing value.
 */
export async function activateChargebackFeePolicyVersion(
  input: { policyVersion: string; activatedByAccountId: string; at: string },
  deps: ChargebackFeePolicyDeps = {},
): Promise<SellerChargebackFeePolicyVersionView> {
  const db = deps.db ?? getPrisma();

  const policy = await db.sellerChargebackFeePolicy.findUnique({
    where: { policyKey: SELLER_CHARGEBACK_FEE_POLICY_KEY },
    select: { id: true },
  });
  if (policy === null) throw new DisputeEvidenceRefusedError("NO_FEE_POLICY_RECORDED");

  const target = await db.sellerChargebackFeePolicyVersionRow.findUnique({
    where: {
      policyId_policyVersion: { policyId: policy.id, policyVersion: input.policyVersion },
    },
  });
  if (target === null) throw new DisputeEvidenceRefusedError("FEE_VERSION_NOT_RECORDED");
  if (target.status === "ACTIVE") {
    return (await readChargebackFeePolicyVersions(deps)).find(
      (v) => v.policyVersion === input.policyVersion,
    )!;
  }
  /* A retired version never returns. Reviving one would make "which value stood
     when" unanswerable from the row's own history. */
  if (target.status === "RETIRED") {
    throw new DisputeEvidenceRefusedError("FEE_VERSION_RETIRED");
  }

  await db.$transaction(async (tx) => {
    const standing = await tx.sellerChargebackFeePolicyVersionRow.findFirst({
      where: { policyId: policy.id, status: "ACTIVE" },
      select: { seq: true },
    });
    if (standing !== null) {
      await tx.sellerChargebackFeePolicyVersionRow.update({
        where: { seq: standing.seq },
        data: {
          status: "RETIRED",
          retiredAt: new Date(input.at),
          retiredByAccountId: input.activatedByAccountId,
          /* Released in the same statement that retires it, so the unique marker
             is free for the successor inside this transaction. */
          activeMarker: null,
        },
      });
    }
    await tx.sellerChargebackFeePolicyVersionRow.update({
      where: { seq: target.seq },
      data: { status: "ACTIVE", activeMarker: policy.id },
    });
  });

  return (await readChargebackFeePolicyVersions(deps)).find(
    (v) => v.policyVersion === input.policyVersion,
  )!;
}
