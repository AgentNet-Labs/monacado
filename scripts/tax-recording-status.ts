/**
 * `tax:record:status` — what the tax-recording pipeline currently owes
 * (Phase 1.8). SERVER ONLY.
 *
 * ```
 *   npm run tax:record:status                   # backlog + what needs an operator
 *   npm run tax:record:status -- --json         # machine-readable only
 *   npm run tax:record:status -- --all          # include work that is merely in flight
 *   npm run tax:record:status -- --requeue=<id> # governed requeue of ONE terminal row
 * ```
 *
 * ## Read-only, apart from one explicit flag
 *
 * Without `--requeue` this writes nothing, contacts no provider, and changes no
 * state. The requeue is the single exception, it acts on exactly one named row,
 * and it refuses every failure a retry could not fix.
 *
 * ## No provider call, ever
 *
 * Every fact comes from Monacado's own rows — which is what `1.7`'s
 * audit-efficient record was for. A status command that had to reach Stripe would
 * stop working at the moment a credential problem made it most useful.
 *
 * ## No buyer PII
 *
 * The summary carries counts and ages and no identifiers at all. The per-row view
 * carries Order and tax-transaction ids and the provider's own object references
 * — which identify a transaction, not a person — and **no name, email, address,
 * or amount**.
 */

import "dotenv/config";
import { disconnectPrisma } from "../src/server/db/client";
import {
  evaluateTaxOperationsReadiness,
  inspectStuckTaxRecordings,
  requeueTaxRecording,
  TaxRequeueRefusedError,
  type TaxOperationsReadiness,
} from "../src/server/tax/tax-recording-operations-service";
import {
  CALCULATION_EXPIRY_REMEDIATION,
  type TaxRecordingInspection,
} from "../src/contracts/marketplace/tax-recording-operations";

export interface StatusCommandOptions {
  json: boolean;
  includeRetrying: boolean;
  requeueId: string | null;
}

export function parseCommandOptions(argv: readonly string[]): StatusCommandOptions {
  const requeueArg = argv.find((a) => a.startsWith("--requeue="));
  const id = requeueArg === undefined ? "" : requeueArg.slice("--requeue=".length).trim();
  return {
    json: argv.includes("--json"),
    includeRetrying: argv.includes("--all"),
    requeueId: id === "" ? null : id,
  };
}

export interface StatusCommandOutcome {
  operations: TaxOperationsReadiness;
  /** Rows needing attention. Terminal only, unless `--all`. */
  attention: TaxRecordingInspection[];
  /** Present only for a `--requeue` run. */
  requeued: TaxRecordingInspection | null;
  requeueRefusedReason: string | null;
}

const bullet = (label: string, value: unknown): string => `  ${label.padEnd(32)} ${String(value)}`;

function formatAge(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7_200) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h`;
}

export function formatReport(outcome: StatusCommandOutcome): string {
  const b = outcome.operations.backlog;
  const lines: string[] = [
    "tax recording status",
    "",
    bullet("healthy", outcome.operations.healthy),
    bullet("blockers", outcome.operations.blockers.join(", ") || "(none)"),
    "",
    bullet("pending", b.pending),
    bullet("retry pending", b.retryPending),
    bullet("in progress (claimed)", b.inProgress),
    bullet("recorded", b.recorded),
    bullet("permanently failed", b.permanentlyFailed),
    "",
    bullet("due now", b.dueNow),
    bullet("expired claims", b.expiredClaims),
    bullet("oldest unresolved", formatAge(b.oldestUnresolvedAgeSeconds)),
    bullet("paid orders w/o tax txn", b.paidOrdersMissingTaxTransaction),
    bullet("calculation expired", b.calculationExpired),
  ];

  if (b.calculationExpired > 0) {
    lines.push(
      "",
      "  calculation-expired rows CANNOT be requeued:",
      `    ${CALCULATION_EXPIRY_REMEDIATION.reason}`,
      `    required: ${CALCULATION_EXPIRY_REMEDIATION.surfacedState.join(" · ")}`,
      `    owner:    ${CALCULATION_EXPIRY_REMEDIATION.owner}`,
    );
  }

  if (outcome.requeued !== null) {
    lines.push("", `  requeued: ${outcome.requeued.taxTransactionId} → ${outcome.requeued.recordingStatus}`);
  }
  if (outcome.requeueRefusedReason !== null) {
    lines.push("", `  requeue REFUSED: ${outcome.requeueRefusedReason}`);
  }

  lines.push("", `  needing attention (${outcome.attention.length}):`);
  for (const row of outcome.attention.slice(0, 30)) {
    lines.push(
      `    ${row.orderId}  ${row.recordingStatus}  attempts=${row.attemptCount}` +
        ` requeues=${row.requeueCount}  last=${row.lastFailureCode ?? "-"}` +
        `  age=${formatAge(row.ageSeconds)}  → ${row.action}` +
        (row.requeueable ? `  [requeueable: ${row.taxTransactionId}]` : ""),
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

  let requeued: TaxRecordingInspection | null = null;
  let requeueRefusedReason: string | null = null;
  if (options.requeueId !== null) {
    try {
      requeued = await requeueTaxRecording({ taxTransactionId: options.requeueId, at });
    } catch (error) {
      /* The reason, never the cause chain: a database error can carry a
         connection string, and this prints to a terminal and a log. */
      requeueRefusedReason =
        error instanceof TaxRequeueRefusedError ? error.reason : "REQUEUE_FAILED";
    }
  }

  const operations = await evaluateTaxOperationsReadiness(at);
  const attention = await inspectStuckTaxRecordings({
    at,
    limit: 100,
    includeRetrying: options.includeRetrying,
  });

  const outcome: StatusCommandOutcome = {
    operations,
    attention,
    requeued,
    requeueRefusedReason,
  };

  if (!options.json) out(formatReport(outcome));
  out(JSON.stringify(outcome, null, 2));

  /* Non-zero when an operator has something to do. A status command that always
     succeeded would be one nobody could gate a launch review on. */
  if (requeueRefusedReason !== null) return 1;
  return operations.healthy ? 0 : 1;
}

/* Executed only when run as a command, never on import. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("tax-recording-status");

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
