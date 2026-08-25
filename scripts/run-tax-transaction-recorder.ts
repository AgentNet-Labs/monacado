/**
 * `tax:record:once` — run ONE bounded tax-transaction recording cycle
 * (Phase 1.7). SERVER ONLY.
 *
 * ```
 *   npm run tax:record:once             # one cycle
 *   npm run tax:record:once -- --json   # machine-readable only
 * ```
 *
 * The same shape as `worker:publication:once` and `email:dispatch:once`: **one
 * cycle, no loop, no scheduler, no daemon**. Deciding to run a second cycle stays
 * entirely outside this file, which is what makes it safe to run by hand, from a
 * protected endpoint, or from a future scheduler without any of them inheriting a
 * hidden loop.
 *
 * ## What it does, and what it cannot
 *
 * It reports paid sales' tax to the configured provider. It **cannot** create a
 * payment, move an Order's lifecycle, alter an economic snapshot, execute a
 * refund, file a return, or publish anything: none of those functions is reachable
 * from here.
 *
 * A deployment with no tax provider configured records a normalised
 * `PROVIDER_NOT_CONFIGURED` against each claimed row and leaves them retryable —
 * it does not throw, and it does not silently drop the obligation.
 *
 * ## Output carries no secret
 *
 * Counts and bounded failure codes. No credential, no provider payload, no
 * address, and no amount.
 */

import "dotenv/config";
import { disconnectPrisma } from "../src/server/db/client";
import {
  runTaxTransactionRecordingCycle,
  type TaxRecordingCycleOutcome,
} from "../src/server/tax/tax-transaction-recorder";
import { listUnreportedTaxTransactions } from "../src/server/tax/tax-transaction-service";

export interface RecorderCommandOptions {
  json: boolean;
  limit: number;
}

export function parseCommandOptions(argv: readonly string[]): RecorderCommandOptions {
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const parsed = limitArg === undefined ? NaN : Number.parseInt(limitArg.slice("--limit=".length), 10);
  return {
    json: argv.includes("--json"),
    limit: Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 25,
  };
}

export interface RecorderCommandOutcome {
  cycle: TaxRecordingCycleOutcome;
  /** How many paid sales are still unreported after this cycle, and why. */
  outstanding: Array<{
    orderId: string;
    recordingStatus: string;
    attemptCount: number;
    lastFailureCode: string | null;
    nextAttemptAt: string | null;
  }>;
}

const bullet = (label: string, value: unknown): string => `  ${label.padEnd(28)} ${String(value)}`;

export function formatReport(outcome: RecorderCommandOutcome): string {
  const c = outcome.cycle;
  const lines = [
    "tax transaction recording — one cycle",
    "",
    bullet("claimed", c.claimed),
    bullet("recorded", c.recorded),
    bullet("retry scheduled", c.retryScheduled),
    bullet("permanently failed", c.permanentlyFailed),
    bullet("stale claims recovered", c.staleClaimsRecovered),
    "",
    bullet("still unreported", outcome.outstanding.length),
  ];
  for (const row of outcome.outstanding.slice(0, 20)) {
    lines.push(
      `    ${row.orderId}  ${row.recordingStatus}  attempts=${row.attemptCount}` +
        `  last=${row.lastFailureCode ?? "-"}  next=${row.nextAttemptAt ?? "-"}`,
    );
  }
  return lines.join("\n");
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = console.log,
): Promise<number> {
  const options = parseCommandOptions(argv);
  const cycle = await runTaxTransactionRecordingCycle({
    at: new Date().toISOString(),
    limit: options.limit,
  });
  const unreported = await listUnreportedTaxTransactions({ limit: 100 });
  const outcome: RecorderCommandOutcome = {
    cycle,
    outstanding: unreported.map((r) => ({
      orderId: r.orderId,
      recordingStatus: r.recordingStatus,
      attemptCount: r.attemptCount,
      lastFailureCode: r.lastFailureCode,
      nextAttemptAt: r.nextAttemptAt,
    })),
  };

  if (!options.json) out(formatReport(outcome));
  out(JSON.stringify(outcome, null, 2));
  /* Non-zero when something is permanently stuck: that needs an operator, and a
     command that always succeeded would be one nobody could gate on. */
  return cycle.permanentlyFailed > 0 ? 1 : 0;
}

/* Executed only when run as a command, never on import. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("run-tax-transaction-recorder");

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
