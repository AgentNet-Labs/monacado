/**
 * `email:dispatch:once` — one bounded outbound-email dispatch cycle (Phase 1.5).
 * SERVER ONLY.
 *
 * Validate configuration, run **exactly one** cycle, emit safe machine-readable
 * output, release what it owns, and return. The same shape as
 * `worker:publication:once`, and the same reasons:
 *
 * There is no daemon, no scheduler, no cron, no `setTimeout`/`setInterval`, no
 * sleep, no polling, no self-rescheduling, and no loop around the cycle. Deciding
 * to run a second cycle stays entirely outside, which is what makes this safe to
 * run by hand or from a future scheduler without either inheriting a hidden loop.
 *
 * ## It never calls `process.exit`
 *
 * The exit code is set and the process is allowed to drain, so a pending write is
 * not truncated and an in-flight send is not abandoned mid-request — which is the
 * exact ambiguity the claim lease exists to survive, and there is no reason to
 * manufacture more of it.
 *
 * ## What it prints
 *
 * Counts, and the policy it ran under. **Never** `DATABASE_URL`, never a provider
 * token, never a recipient address, never a subject line, and never a body. There
 * is no code path from a message to this output.
 *
 * ## Exit codes
 *
 * `0` for a completed cycle, `75` (`EX_TEMPFAIL`) for a failure worth retrying
 * against a working database or provider.
 */

import "dotenv/config";
import "../src/server/server-only";
import { disconnectPrisma } from "../src/server/db/client";
import { resolvedMailProvider } from "../src/server/notifications/mail-port";
import {
  DEFAULT_DISPATCH_LIMIT,
  DISPATCHER_POLICY,
  runEmailDispatchCycle,
  type EmailDispatchCycleResult,
} from "../src/server/notifications/email-dispatcher";

export interface DispatchCommandOptions {
  limit: number;
}

export function parseDispatchOptions(argv: readonly string[]): DispatchCommandOptions {
  let limit = DEFAULT_DISPATCH_LIMIT;
  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      const parsed = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
    }
  }
  return { limit };
}

/**
 * The report.
 *
 * An allow-list built from the cycle result and the policy constants, so there is
 * no path by which an environment value, an address, or a message could reach the
 * output. The provider is its **name**, never its credential.
 */
export function formatDispatchReport(
  result: EmailDispatchCycleResult,
  provider: string,
  limit: number,
): string {
  return [
    "Monacado — outbound email dispatch",
    `  provider:            ${provider}`,
    `  limit:               ${limit}`,
    `  max attempts:        ${DISPATCHER_POLICY.maxAttempts}`,
    `  recovered:           ${result.recovered}`,
    `  claimed:             ${result.claimed}`,
    `  delivered:           ${result.delivered}`,
    `  retry scheduled:     ${result.retryScheduled}`,
    `  permanently failed:  ${result.permanentlyFailed}`,
    `  suppressed:          ${result.suppressed}`,
    `  claim conflicts:     ${result.claimConflicts}`,
  ].join("\n");
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  out: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const { limit } = parseDispatchOptions(argv);
  const provider = resolvedMailProvider(env);

  try {
    const result = await runEmailDispatchCycle({ now: new Date().toISOString(), limit });
    out(formatDispatchReport(result, provider, limit));
    out(JSON.stringify({ provider, limit, ...result }));
    return 0;
  } catch (error) {
    /* The name, never the cause chain: a database or provider error can carry a
       connection string, a token, or a rendered body. */
    out(`failed: ${error instanceof Error ? error.name : "UNKNOWN_ERROR"}`);
    return 75;
  }
}

/* Executed only when run as a command, never on import — a test imports this
   module for `parseDispatchOptions` and `formatDispatchReport`. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("run-email-dispatcher");

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
