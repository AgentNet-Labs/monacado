/**
 * Dispute operator reads (Phase 1.11) — SERVER ONLY.
 *
 * Read-only, local-only. **Nothing here contacts a provider**, and nothing here
 * writes: a dispute's state is the provider's to change, and an operator tool
 * that could edit it would be a second answer able to disagree with the webhook.
 *
 * The rule the summary follows, inherited from `refund-operations-service`:
 * **counts and ages in the backlog, identifiers only in the inspection.** A
 * disputed amount is a purchase amount, and it appears in neither.
 */

import "../server-only";
import {
  DISPUTE_OPERATIONS_POLICY,
  disputeBacklogIsHealthy,
  disputeOperatorActionFor,
  type DisputeBacklog,
  type DisputeInspection,
  type DisputeOperationsBlockerCode,
  type DisputeOperationsReadiness,
} from "../../contracts/marketplace/dispute-operations";
import {
  NON_TERMINAL_DISPUTE_STATUSES,
  type DisputeRemediationCode,
  type DisputeStatus,
  type DisputeTaxConsequence,
} from "../../contracts/marketplace/transaction-dispute";
import { getPrisma } from "../db/client";
import { DisputeError, DisputePersistenceFailureError } from "./dispute-errors";

export interface DisputeOperationsDeps {
  db?: ReturnType<typeof getPrisma>;
}

const secondsBetween = (from: string, to: string): number =>
  Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 1_000));

/** What the dispute book currently holds. Counts and ages only. */
export async function summarizeDisputeBacklog(
  args: { at: string },
  deps: DisputeOperationsDeps = {},
): Promise<DisputeBacklog> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.transactionDispute.findMany({
      select: {
        id: true,
        orderId: true,
        snapshotId: true,
        status: true,
        fundsState: true,
        taxConsequence: true,
        remediationCode: true,
        responsePermitted: true,
        evidenceDueBy: true,
        openedAt: true,
        lastProviderEventAt: true,
      },
    });

    const now = Date.parse(args.at);
    const counts = {
      open: 0,
      needsResponse: 0,
      underReview: 0,
      won: 0,
      lost: 0,
      closed: 0,
      manualRemediationRequired: 0,
    };
    let fundsWithdrawn = 0;
    let fundsReinstated = 0;
    let unattributed = 0;
    let deadlineWithinWarning = 0;
    let deadlineWithinCritical = 0;
    let deadlinePassedUnresolved = 0;
    let noResponsePermitted = 0;
    let observationStale = 0;
    let taxConsequenceUnresolved = 0;
    let oldestUnresolvedAgeSeconds: number | null = null;
    let soonestDeadlineSeconds: number | null = null;

    for (const row of rows) {
      const status = row.status as DisputeStatus;
      if (status === "OPEN") counts.open += 1;
      else if (status === "NEEDS_RESPONSE") counts.needsResponse += 1;
      else if (status === "UNDER_REVIEW") counts.underReview += 1;
      else if (status === "WON") counts.won += 1;
      else if (status === "LOST") counts.lost += 1;
      else if (status === "CLOSED") counts.closed += 1;
      else counts.manualRemediationRequired += 1;

      if (row.fundsState === "WITHDRAWN") fundsWithdrawn += 1;
      if (row.fundsState === "REINSTATED") fundsReinstated += 1;
      if (row.orderId === null) unattributed += 1;

      const live = NON_TERMINAL_DISPUTE_STATUSES.includes(status);
      if (live) {
        const age = secondsBetween(row.openedAt.toISOString(), args.at);
        if (oldestUnresolvedAgeSeconds === null || age > oldestUnresolvedAgeSeconds) {
          oldestUnresolvedAgeSeconds = age;
        }
        if (!row.responsePermitted) noResponsePermitted += 1;
        const staleness = secondsBetween(row.lastProviderEventAt.toISOString(), args.at);
        if (staleness > DISPUTE_OPERATIONS_POLICY.maxObservationStalenessSeconds) {
          observationStale += 1;
        }
        if (row.evidenceDueBy !== null) {
          const remaining = Math.floor((row.evidenceDueBy.getTime() - now) / 1_000);
          if (remaining <= 0) deadlinePassedUnresolved += 1;
          else {
            if (remaining <= DISPUTE_OPERATIONS_POLICY.deadlineCriticalSeconds) {
              deadlineWithinCritical += 1;
            }
            if (remaining <= DISPUTE_OPERATIONS_POLICY.deadlineWarningSeconds) {
              deadlineWithinWarning += 1;
            }
            if (soonestDeadlineSeconds === null || remaining < soonestDeadlineSeconds) {
              soonestDeadlineSeconds = remaining;
            }
          }
        }
      }

      if ((row.taxConsequence as DisputeTaxConsequence) === "REVERSAL_REQUIRED_NOT_EXPRESSIBLE") {
        taxConsequenceUnresolved += 1;
      }
    }

    /* Claims a dispute is currently holding. Counted from the same predicate the
       payout gate evaluates, so the number an operator reads and the decision
       the gate makes cannot disagree. */
    const disputedSnapshotIds = rows
      .filter((r) => NON_TERMINAL_DISPUTE_STATUSES.includes(r.status as DisputeStatus))
      .map((r) => r.snapshotId)
      .filter((id): id is string => id !== null);

    const heldObligations =
      disputedSnapshotIds.length === 0
        ? 0
        : await db.proceedsObligation.count({
            where: { snapshotId: { in: disputedSnapshotIds }, state: "PENDING" },
          });

    const openRecoveryExceptions = await db.proceedsRecoveryException.count({
      where: { causeKind: "DISPUTE", status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    });

    return {
      ...counts,
      fundsWithdrawn,
      fundsReinstated,
      unattributed,
      deadlineWithinWarning,
      deadlineWithinCritical,
      deadlinePassedUnresolved,
      noResponsePermitted,
      observationStale,
      taxConsequenceUnresolved,
      heldObligations,
      openRecoveryExceptions,
      oldestUnresolvedAgeSeconds,
      soonestDeadlineSeconds,
    };
  } catch (error) {
    if (error instanceof DisputeError) throw error;
    throw new DisputePersistenceFailureError("summarizeDisputeBacklog", error);
  }
}

/** The disputes an operator should look at, most urgent first. */
export async function inspectOpenDisputes(
  args: { at: string; includeResolved?: boolean; limit?: number },
  deps: DisputeOperationsDeps = {},
): Promise<DisputeInspection[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.transactionDispute.findMany({
      where: args.includeResolved
        ? {}
        : { status: { in: [...NON_TERMINAL_DISPUTE_STATUSES] } },
      orderBy: [{ evidenceDueBy: "asc" }, { openedAt: "asc" }],
      take: Math.max(1, Math.min(args.limit ?? 100, 500)),
    });

    const now = Date.parse(args.at);
    const out: DisputeInspection[] = [];
    for (const row of rows) {
      const heldObligationCount =
        row.snapshotId === null
          ? 0
          : await db.proceedsObligation.count({
              where: { snapshotId: row.snapshotId, state: "PENDING" },
            });
      const openRecoveryExceptionCount = await db.proceedsRecoveryException.count({
        where: { disputeId: row.id, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      });
      const paidRecoveryOpen = await db.proceedsRecoveryException.count({
        where: {
          disputeId: row.id,
          reasonCode: "PAID_BEFORE_DISPUTE",
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
        },
      });

      out.push({
        disputeId: row.id,
        orderId: row.orderId,
        providerDisputeRef: row.providerDisputeRef,
        status: row.status as DisputeStatus,
        fundsState: row.fundsState as DisputeInspection["fundsState"],
        taxConsequence: row.taxConsequence as DisputeTaxConsequence,
        remediationCode: row.remediationCode as DisputeRemediationCode | null,
        responsePermitted: row.responsePermitted,
        evidenceDueBy: row.evidenceDueBy?.toISOString() ?? null,
        secondsUntilDeadline:
          row.evidenceDueBy === null
            ? null
            : Math.floor((row.evidenceDueBy.getTime() - now) / 1_000),
        openedAt: row.openedAt.toISOString(),
        ageSeconds: secondsBetween(row.openedAt.toISOString(), args.at),
        lastProviderEventAt: row.lastProviderEventAt.toISOString(),
        observationAgeSeconds: secondsBetween(row.lastProviderEventAt.toISOString(), args.at),
        heldObligationCount,
        openRecoveryExceptionCount,
        /* Derived by the same pure function the readiness check and the tests
           use, so three places cannot agree by accident. */
        action: disputeOperatorActionFor({
          status: row.status as DisputeStatus,
          remediationCode: row.remediationCode as DisputeRemediationCode | null,
          taxConsequence: row.taxConsequence as DisputeTaxConsequence,
          responsePermitted: row.responsePermitted,
          evidenceDueBy: row.evidenceDueBy?.toISOString() ?? null,
          hasPaidRecoveryExceptionOpen: paidRecoveryOpen > 0,
          at: args.at,
        }),
      });
    }
    return out;
  } catch (error) {
    if (error instanceof DisputeError) throw error;
    throw new DisputePersistenceFailureError("inspectOpenDisputes", error);
  }
}

/** Whether the dispute book is in a state Monacado can defend. */
export async function evaluateDisputeOperationsReadiness(
  args: { at: string },
  deps: DisputeOperationsDeps = {},
): Promise<DisputeOperationsReadiness> {
  const backlog = await summarizeDisputeBacklog(args, deps);
  const blockers: DisputeOperationsBlockerCode[] = [];

  if (backlog.unattributed > 0) blockers.push("DISPUTE_UNATTRIBUTED");
  if (backlog.deadlineWithinCritical > 0) blockers.push("DISPUTE_RESPONSE_DEADLINE_NEAR");
  if (backlog.deadlinePassedUnresolved > 0) blockers.push("DISPUTE_RESPONSE_DEADLINE_PASSED");
  if (backlog.manualRemediationRequired > 0) blockers.push("DISPUTE_MANUAL_REMEDIATION_REQUIRED");
  if (backlog.observationStale > 0) blockers.push("DISPUTE_OBSERVATION_STALE");
  if (backlog.taxConsequenceUnresolved > 0) blockers.push("DISPUTE_TAX_CONSEQUENCE_UNRESOLVED");

  /* A finalized loss that assessed no fee. Counted here rather than derived from
     configuration, because the question is about ROWS: which losses went
     unassessed, whatever the policy says today. */
  const db = deps.db ?? getPrisma();
  const unassessedLosses = await db.transactionDispute.count({
    where: { status: "LOST", orderId: { not: null }, sellerChargebackFee: { is: null } },
  });
  if (unassessedLosses > 0) blockers.push("DISPUTE_CHARGEBACK_FEE_NOT_ASSESSED");

  return { healthy: blockers.length === 0 && disputeBacklogIsHealthy(backlog), blockers, backlog };
}

export { DISPUTE_OPERATIONS_POLICY };
