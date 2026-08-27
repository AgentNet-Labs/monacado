/**
 * `dispute:status` — what the dispute book currently holds (Phase 1.11).
 * SERVER ONLY.
 *
 * ```
 *   npm run dispute:status                     # backlog + what needs an operator
 *   npm run dispute:status -- --json           # machine-readable only
 *   npm run dispute:status -- --all            # include settled disputes
 *   npm run dispute:status -- --reconcile      # local reconciliation sweep
 *   npm run dispute:status -- --evidence=<orderId>   # what Monacado holds
 * ```
 *
 * ## Entirely read-only
 *
 * Unlike `refund:status`, this has **no write flag at all** — not even a governed
 * one. A dispute's state belongs to the provider: Monacado observes it, and an
 * operator tool that could edit it would be a second answer able to disagree
 * with the webhook. Responding to a dispute happens in the provider's dashboard,
 * which is what `ASSEMBLE_EVIDENCE_AND_SUBMIT_IN_DASHBOARD` says out loud.
 *
 * ## No provider call, ever
 *
 * Every fact comes from Monacado's own rows. A status command that had to reach
 * the provider would stop working at the moment a credential problem made it
 * most useful — and for disputes, unlike refunds, the clock does not stop while
 * somebody fixes it.
 *
 * ## No buyer PII, and no amounts
 *
 * The summary carries counts and ages and no identifiers at all. The per-row
 * view carries Order, dispute, and provider object references — which identify a
 * transaction, not a person — and **no name, email, address, or amount**. A
 * disputed amount is a purchase amount, and it is also a statement about what a
 * specific person is contesting.
 */

import "dotenv/config";
import { disconnectPrisma } from "../src/server/db/client";
import {
  evaluateDisputeOperationsReadiness,
  inspectOpenDisputes,
} from "../src/server/marketplace/dispute-operations-service";
import {
  reconcileOpenDisputes,
  summarizeDisputeReconciliation,
} from "../src/server/marketplace/dispute-reconciliation-service";
import { assembleDisputeEvidenceMetadata } from "../src/server/marketplace/dispute-evidence-metadata-service";
import type {
  DisputeEvidenceAvailability,
  DisputeInspection,
  DisputeOperationsReadiness,
} from "../src/contracts/marketplace/dispute-operations";

export interface StatusCommandOptions {
  json: boolean;
  includeResolved: boolean;
  reconcile: boolean;
  evidenceForOrderId: string | null;
}

export function parseCommandOptions(argv: readonly string[]): StatusCommandOptions {
  const flagValue = (prefix: string): string | null => {
    const arg = argv.find((a) => a.startsWith(prefix));
    const value = arg === undefined ? "" : arg.slice(prefix.length).trim();
    return value === "" ? null : value;
  };
  return {
    json: argv.includes("--json"),
    includeResolved: argv.includes("--all"),
    reconcile: argv.includes("--reconcile"),
    evidenceForOrderId: flagValue("--evidence="),
  };
}

export interface StatusCommandOutcome {
  operations: DisputeOperationsReadiness;
  /** Rows needing attention. Live only, unless `--all`. */
  attention: DisputeInspection[];
  /** Present only for a `--reconcile` run. */
  reconciliation: {
    reconciled: number;
    consistent: number;
    needingOperator: number;
    findingCounts: Record<string, number>;
  } | null;
  /** Present only for an `--evidence=` run. */
  evidence: DisputeEvidenceAvailability[] | null;
}

const bullet = (label: string, value: unknown): string => `  ${label.padEnd(34)} ${String(value)}`;

function formatAge(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7_200) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h`;
}

function formatDeadline(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds <= 0) return "PASSED";
  return formatAge(seconds);
}

export function formatReport(outcome: StatusCommandOutcome): string {
  const b = outcome.operations.backlog;
  const lines: string[] = [
    "dispute status",
    "",
    bullet("healthy", outcome.operations.healthy),
    bullet("blockers", outcome.operations.blockers.join(", ") || "none"),
    "",
    bullet("open", b.open),
    bullet("response required", b.needsResponse),
    bullet("under review", b.underReview),
    bullet("won", b.won),
    bullet("lost", b.lost),
    bullet("closed, no liability", b.closed),
    bullet("manual remediation required", b.manualRemediationRequired),
    "",
    bullet("funds withdrawn", b.fundsWithdrawn),
    bullet("funds reinstated", b.fundsReinstated),
    "",
    bullet("unattributed", b.unattributed),
    bullet("deadline within 72h", b.deadlineWithinWarning),
    bullet("deadline within 24h", b.deadlineWithinCritical),
    bullet("deadline passed", b.deadlinePassedUnresolved),
    bullet("no response permitted", b.noResponsePermitted),
    bullet("observation stale", b.observationStale),
    bullet("tax consequence unresolved", b.taxConsequenceUnresolved),
    bullet("held obligations", b.heldObligations),
    bullet("open recovery exceptions", b.openRecoveryExceptions),
    bullet("oldest unresolved", formatAge(b.oldestUnresolvedAgeSeconds)),
    bullet("soonest deadline", formatDeadline(b.soonestDeadlineSeconds)),
  ];

  if (outcome.attention.length > 0) {
    lines.push("", `  needing attention (${outcome.attention.length}):`);
    for (const row of outcome.attention.slice(0, 30)) {
      lines.push(
        `    ${row.orderId ?? "(unattributed)"}  ${row.status}` +
          `  funds=${row.fundsState}` +
          `  due=${formatDeadline(row.secondsUntilDeadline)}` +
          `  age=${formatAge(row.ageSeconds)}` +
          `  held=${row.heldObligationCount}` +
          `  recovery=${row.openRecoveryExceptionCount}` +
          `  → ${row.action}  [${row.disputeId}]`,
      );
    }
  }

  if (outcome.reconciliation !== null) {
    const r = outcome.reconciliation;
    lines.push(
      "",
      "  reconciliation:",
      bullet("  reconciled", r.reconciled),
      bullet("  consistent", r.consistent),
      bullet("  needing operator", r.needingOperator),
    );
    for (const [code, count] of Object.entries(r.findingCounts).sort()) {
      lines.push(bullet(`    ${code}`, count));
    }
  }

  if (outcome.evidence !== null) {
    lines.push("", "  evidence Monacado holds:");
    for (const item of outcome.evidence) {
      lines.push(
        bullet(
          `    ${item.evidenceCode}`,
          item.available ? `yes  [${item.monacadoRecordRef ?? "-"}]` : "no",
        ),
      );
    }
  }

  return lines.join("\n");
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = console.log,
): Promise<number> {
  const options = parseCommandOptions(argv);
  const at = new Date().toISOString();

  const operations = await evaluateDisputeOperationsReadiness({ at });
  const attention = await inspectOpenDisputes({
    at,
    limit: 100,
    includeResolved: options.includeResolved,
  });

  const reconciliation = options.reconcile
    ? summarizeDisputeReconciliation(await reconcileOpenDisputes({ at, limit: 200 }))
    : null;

  const evidence =
    options.evidenceForOrderId === null
      ? null
      : await assembleDisputeEvidenceMetadata(options.evidenceForOrderId);

  const outcome: StatusCommandOutcome = { operations, attention, reconciliation, evidence };

  if (!options.json) out(formatReport(outcome));
  out(JSON.stringify(outcome, null, 2));

  /* Non-zero when an operator has something to do. A status command that always
     succeeded would be one nobody could gate a launch review on. */
  if (reconciliation !== null && reconciliation.needingOperator > 0) return 1;
  return operations.healthy ? 0 : 1;
}

/* Executed only when run as a command, never on import. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("dispute-status");

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
