/**
 * `refund:process:once` — run ONE bounded refund cycle (Phase 1.9). SERVER ONLY.
 *
 * ```
 *   npm run refund:process:once             # one cycle
 *   npm run refund:process:once -- --json   # machine-readable only
 * ```
 *
 * The same shape as `worker:publication:once`, `email:dispatch:once`, and
 * `tax:record:once`: **one cycle, no loop, no scheduler, no daemon**. Deciding to
 * run a second cycle stays entirely outside this file, which is what makes it
 * safe to run by hand, from the protected endpoint, or from a future scheduler
 * without any of them inheriting a hidden loop.
 *
 * One invocation runs **both halves** — due payment refunds, then due tax
 * reversals, including ones committed moments earlier in the same cycle. That
 * ordering is what lets an ordinary refund complete in a single run.
 *
 * ## What it does, and what it cannot
 *
 * It executes refunds Monacado has already committed to and reverses the
 * corresponding tax. It **cannot** create a refund, decide that one is owed,
 * refund a partial amount, alter an economic snapshot, rewrite a sale's tax
 * facts, claw back a payout, file a return, or publish anything: none of those
 * functions is reachable from here.
 *
 * A deployment with no payment provider configured records a normalised
 * `PROVIDER_NOT_CONFIGURED` against each claimed row and leaves them retryable —
 * it does not throw, and it does not silently drop a buyer's refund.
 *
 * ## Output carries no secret and no buyer
 *
 * Counts and bounded failure codes, plus Order and refund identifiers in the
 * outstanding list. No credential, no provider payload, no address, and **no
 * amount** — a refund amount is also a purchase amount.
 */

import "dotenv/config";
import { disconnectPrisma } from "../src/server/db/client";
import {
  runRefundCycle,
  type RefundCycleOutcome,
} from "../src/server/marketplace/refund-processor";
import { listUnresolvedRefunds } from "../src/server/marketplace/order-refund-service";
import { listUnresolvedTaxReversals } from "../src/server/tax/tax-reversal-service";

export interface ProcessorCommandOptions {
  json: boolean;
  limit: number;
}

export function parseCommandOptions(argv: readonly string[]): ProcessorCommandOptions {
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const parsed =
    limitArg === undefined ? NaN : Number.parseInt(limitArg.slice("--limit=".length), 10);
  return {
    json: argv.includes("--json"),
    limit: Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 25,
  };
}

interface OutstandingRow {
  kind: "PAYMENT_REFUND" | "TAX_REVERSAL";
  orderId: string;
  status: string;
  attemptCount: number;
  lastFailureCode: string | null;
  nextAttemptAt: string | null;
}

export interface ProcessorCommandOutcome {
  cycle: RefundCycleOutcome;
  /** What is still unfinished after this cycle, and why. */
  outstanding: OutstandingRow[];
}

const bullet = (label: string, value: unknown): string => `  ${label.padEnd(30)} ${String(value)}`;

export function formatReport(outcome: ProcessorCommandOutcome): string {
  const c = outcome.cycle;
  const lines = [
    "refund processing — one cycle",
    "",
    "  payment refunds",
    bullet("  claimed", c.refundsClaimed),
    bullet("  executed", c.refundsExecuted),
    bullet("  retry scheduled", c.refundsRetryScheduled),
    bullet("  permanently failed", c.refundsPermanentlyFailed),
    "",
    "  tax reversals",
    bullet("  claimed", c.taxReversalsClaimed),
    bullet("  executed", c.taxReversalsExecuted),
    bullet("  retry scheduled", c.taxReversalsRetryScheduled),
    bullet("  permanently failed", c.taxReversalsPermanentlyFailed),
    "",
    bullet("stale claims recovered", c.staleClaimsRecovered),
    bullet("claim conflicts", c.claimConflicts),
    bullet("recovery exceptions raised", c.recoveryExceptionsRaised),
    "",
    bullet("still unresolved", outcome.outstanding.length),
  ];
  for (const row of outcome.outstanding.slice(0, 20)) {
    lines.push(
      `    ${row.kind.padEnd(14)} ${row.orderId}  ${row.status}` +
        `  attempts=${row.attemptCount}  last=${row.lastFailureCode ?? "-"}` +
        `  next=${row.nextAttemptAt ?? "-"}`,
    );
  }
  return lines.join("\n");
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = console.log,
): Promise<number> {
  const options = parseCommandOptions(argv);
  const cycle = await runRefundCycle({
    at: new Date().toISOString(),
    limit: options.limit,
  });

  const refunds = await listUnresolvedRefunds({ limit: 100 });
  const reversals = await listUnresolvedTaxReversals({ limit: 100 });

  const outcome: ProcessorCommandOutcome = {
    cycle,
    outstanding: [
      ...refunds.map((r): OutstandingRow => ({
        kind: "PAYMENT_REFUND",
        orderId: r.orderId,
        status: r.status,
        attemptCount: r.attemptCount,
        lastFailureCode: r.lastFailureCode,
        nextAttemptAt: r.nextAttemptAt,
      })),
      ...reversals.map((r): OutstandingRow => ({
        kind: "TAX_REVERSAL",
        orderId: r.orderId,
        status: r.status,
        attemptCount: r.attemptCount,
        lastFailureCode: r.lastFailureCode,
        nextAttemptAt: r.nextAttemptAt,
      })),
    ],
  };

  if (!options.json) out(formatReport(outcome));
  out(JSON.stringify(outcome, null, 2));

  /* Non-zero when something is permanently stuck: that needs an operator, and a
     command that always succeeded would be one nobody could gate on. */
  return cycle.refundsPermanentlyFailed > 0 || cycle.taxReversalsPermanentlyFailed > 0 ? 1 : 0;
}

/* Executed only when run as a command, never on import. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("run-refund-processor");

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
