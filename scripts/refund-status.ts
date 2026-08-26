/**
 * `refund:status` — what the refund pipeline currently owes (Phase 1.9).
 * SERVER ONLY.
 *
 * ```
 *   npm run refund:status                          # backlog + what needs an operator
 *   npm run refund:status -- --json                # machine-readable only
 *   npm run refund:status -- --all                 # include work merely in flight
 *   npm run refund:status -- --reconcile           # local reconciliation sweep
 *   npm run refund:status -- --requeue-refund=<id> # governed requeue of ONE refund
 *   npm run refund:status -- --requeue-tax=<id>    # governed requeue of ONE tax reversal
 * ```
 *
 * ## Read-only, apart from one explicit flag
 *
 * Without a `--requeue-*` flag this writes nothing, contacts no provider, and
 * changes no state. The requeue is the single exception, it acts on exactly one
 * named row, and it refuses every failure a retry could not fix.
 *
 * ## No provider call, ever
 *
 * Every fact comes from Monacado's own rows — which is what the audit-efficient
 * refund and reversal records are for. A status command that had to reach Stripe
 * would stop working at the moment a credential problem made it most useful, and
 * for refunds a credential problem is one of the likeliest reasons a backlog
 * exists at all.
 *
 * ## No buyer PII, and no amounts
 *
 * The summary carries counts and ages and no identifiers at all. The per-row view
 * carries Order, refund, and provider object references — which identify a
 * transaction, not a person — and **no name, email, address, or amount**. A
 * refund amount is also a purchase amount.
 */

import "dotenv/config";
import { disconnectPrisma } from "../src/server/db/client";
import {
  evaluateRefundOperationsReadiness,
  inspectStuckRefundWork,
  requeueRefundWork,
  summarizeRefundLifecycleStates,
  type RefundOperationsReadiness,
} from "../src/server/marketplace/refund-operations-service";
import {
  reconcilePaidOrderRefunds,
  summarizeRefundReconciliation,
} from "../src/server/marketplace/refund-reconciliation-service";
import { RefundRequeueRefusedError } from "../src/server/marketplace/refund-errors";
import type { RefundInspection } from "../src/contracts/marketplace/refund-operations";

export interface StatusCommandOptions {
  json: boolean;
  includeRetrying: boolean;
  reconcile: boolean;
  requeueRefundId: string | null;
  requeueTaxReversalId: string | null;
}

export function parseCommandOptions(argv: readonly string[]): StatusCommandOptions {
  const flagValue = (prefix: string): string | null => {
    const arg = argv.find((a) => a.startsWith(prefix));
    const value = arg === undefined ? "" : arg.slice(prefix.length).trim();
    return value === "" ? null : value;
  };
  return {
    json: argv.includes("--json"),
    includeRetrying: argv.includes("--all"),
    reconcile: argv.includes("--reconcile"),
    requeueRefundId: flagValue("--requeue-refund="),
    requeueTaxReversalId: flagValue("--requeue-tax="),
  };
}

export interface StatusCommandOutcome {
  operations: RefundOperationsReadiness;
  /** How many refunds rest in each composite lifecycle state. */
  lifecycleStates: Record<string, number>;
  /** Rows needing attention. Terminal only, unless `--all`. */
  attention: RefundInspection[];
  /** Present only for a `--reconcile` run. */
  reconciliation: {
    reconciled: number;
    consistent: number;
    needingOperator: number;
    findingCounts: Record<string, number>;
  } | null;
  /** Present only for a `--requeue-*` run. */
  requeued: RefundInspection | null;
  requeueRefusedReason: string | null;
}

const bullet = (label: string, value: unknown): string => `  ${label.padEnd(34)} ${String(value)}`;

function formatAge(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7_200) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h`;
}

export function formatReport(outcome: StatusCommandOutcome): string {
  const b = outcome.operations.backlog;
  const lines: string[] = [
    "refund status",
    "",
    bullet("healthy", outcome.operations.healthy),
    bullet("blockers", outcome.operations.blockers.join(", ") || "(none)"),
    "",
    "  payment refunds",
    bullet("  pending", b.refundsPending),
    bullet("  in progress (claimed)", b.refundsInProgress),
    bullet("  retry pending", b.refundsRetryPending),
    bullet("  completed", b.refundsCompleted),
    bullet("  permanently failed", b.refundsPermanentlyFailed),
    "",
    "  tax reversals",
    bullet("  pending", b.taxReversalsPending),
    bullet("  in progress (claimed)", b.taxReversalsInProgress),
    bullet("  retry pending", b.taxReversalsRetryPending),
    bullet("  completed", b.taxReversalsCompleted),
    bullet("  permanently failed", b.taxReversalsPermanentlyFailed),
    "",
    bullet("payment refunded, tax not", b.paymentRefundedTaxNotReversed),
    bullet("manual remediation required", b.manualRemediationRequired),
    bullet("open recovery exceptions", b.openProceedsRecoveryExceptions),
    "",
    bullet("due now", b.dueNow),
    bullet("expired claims", b.expiredClaims),
    bullet("oldest unresolved", formatAge(b.oldestUnresolvedAgeSeconds)),
  ];

  if (b.manualRemediationRequired > 0) {
    lines.push(
      "",
      "  MANUAL REMEDIATION REQUIRED — money returned, tax reversal permanently",
      "  failed. NO RETRY CAN FIX THESE: putting one right is a tax adjustment",
      "  against the original sale, not another attempt.",
    );
  }

  lines.push("", "  lifecycle states:");
  for (const [state, count] of Object.entries(outcome.lifecycleStates).sort()) {
    lines.push(`    ${state.padEnd(30)} ${count}`);
  }

  if (outcome.reconciliation !== null) {
    const r = outcome.reconciliation;
    lines.push(
      "",
      "  reconciliation (local records only, no provider call):",
      bullet("  reconciled", r.reconciled),
      bullet("  consistent", r.consistent),
      bullet("  needing an operator", r.needingOperator),
    );
    for (const [finding, count] of Object.entries(r.findingCounts).sort()) {
      lines.push(`    ${finding.padEnd(38)} ${count}`);
    }
  }

  if (outcome.requeued !== null) {
    lines.push(
      "",
      `  requeued: ${outcome.requeued.kind} ${outcome.requeued.taxReversalId ?? outcome.requeued.refundId} → ${outcome.requeued.status}`,
    );
  }
  if (outcome.requeueRefusedReason !== null) {
    lines.push("", `  requeue REFUSED: ${outcome.requeueRefusedReason}`);
  }

  lines.push("", `  needing attention (${outcome.attention.length}):`);
  for (const row of outcome.attention.slice(0, 30)) {
    lines.push(
      `    ${row.kind.padEnd(14)} ${row.orderId}  ${row.status}` +
        `  attempts=${row.attemptCount} requeues=${row.requeueCount}` +
        `  last=${row.lastFailureCode ?? "-"}  age=${formatAge(row.ageSeconds)}` +
        `  → ${row.action}` +
        (row.requeueable ? `  [requeueable: ${row.taxReversalId ?? row.refundId}]` : ""),
    );
  }
  return lines.join("\n");
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = console.log,
): Promise<number> {
  const options = parseCommandOptions(argv);
  const at = new Date().toISOString();

  let requeued: RefundInspection | null = null;
  let requeueRefusedReason: string | null = null;
  const requeue =
    options.requeueRefundId !== null
      ? ({ kind: "PAYMENT_REFUND", id: options.requeueRefundId } as const)
      : options.requeueTaxReversalId !== null
        ? ({ kind: "TAX_REVERSAL", id: options.requeueTaxReversalId } as const)
        : null;

  if (requeue !== null) {
    try {
      requeued = await requeueRefundWork({ kind: requeue.kind, id: requeue.id, at });
    } catch (error) {
      /* The reason, never the cause chain: a database error can carry a
         connection string, and this prints to a terminal and a log. */
      requeueRefusedReason =
        error instanceof RefundRequeueRefusedError ? error.reason : "REQUEUE_FAILED";
    }
  }

  const operations = await evaluateRefundOperationsReadiness(at);
  const lifecycleStates = await summarizeRefundLifecycleStates();
  const attention = await inspectStuckRefundWork({
    at,
    limit: 100,
    includeRetrying: options.includeRetrying,
  });

  const reconciliation = options.reconcile
    ? summarizeRefundReconciliation(
        await reconcilePaidOrderRefunds({ at, limit: 200, refundedOnly: true }),
      )
    : null;

  const outcome: StatusCommandOutcome = {
    operations,
    lifecycleStates,
    attention,
    reconciliation,
    requeued,
    requeueRefusedReason,
  };

  if (!options.json) out(formatReport(outcome));
  out(JSON.stringify(outcome, null, 2));

  /* Non-zero when an operator has something to do. A status command that always
     succeeded would be one nobody could gate a launch review on. */
  if (requeueRefusedReason !== null) return 1;
  if (reconciliation !== null && reconciliation.needingOperator > 0) return 1;
  return operations.healthy ? 0 : 1;
}

/* Executed only when run as a command, never on import. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("refund-status");

if (invokedDirectly) {
  void main()
    .then(async (code) => {
      process.exitCode = code;
      await disconnectPrisma();
    })
    .catch(async () => {
      process.exitCode = 75;
      await disconnectPrisma();
    });
}
