/**
 * Shared target and confirmation handling for the operator governance commands
 * (`operator:bootstrap`, `operator:grant`, `operator:revoke`,
 * `commercial-policy:bootstrap`). SERVER ONLY.
 *
 * Four rules, each a refusal rather than a warning:
 *
 *   1. **The target is named, never inferred.** `--target=local` or
 *      `--target=production`, typed every time. There is no default.
 *
 *   2. **Each target has exactly one source, and they never substitute.**
 *      `production` reads `MONACADO_PROD_RUNTIME_DATABASE_URL` and nothing else —
 *      in particular never `DATABASE_URL`, which on an operator laptop silently
 *      names the local database. `local` reads `DATABASE_URL`. A production URL
 *      on a loopback host, or a local URL on a remote one, is refused: the name
 *      and the place must agree.
 *
 *   3. **Writing needs two words.** Without `--execute` a command is a dry run:
 *      it reads and reports, and writes nothing. With it, `--confirm=` must equal
 *      the exact phrase the command prints — naming the act, the accounts, and
 *      the target — so a pasted command line for one account or one target
 *      cannot act on another.
 *
 *   4. **Nothing secret is printed.** No URL, host, credential, email, or name;
 *      output is an allow-listed JSON object of ids and classifications.
 */

import { PrismaClient } from "@prisma/client";

export const OPERATOR_TARGETS = ["local", "production"] as const;
export type OperatorTarget = (typeof OPERATOR_TARGETS)[number];

export class OperatorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorUsageError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The environment variable each target reads. One each; never a fallback. */
export const OPERATOR_TARGET_URL_VARIABLE: Record<OperatorTarget, string> = {
  local: "DATABASE_URL",
  production: "MONACADO_PROD_RUNTIME_DATABASE_URL",
};

export function parseOperatorTarget(value: string | undefined): OperatorTarget {
  if (value === "local" || value === "production") return value;
  throw new OperatorUsageError("--target=local or --target=production is required");
}

/**
 * The database URL for a target, checked against where it points. The value is
 * returned to construct a client and is never printed or put in an error.
 */
export function resolveOperatorDatabaseUrl(
  target: OperatorTarget,
  env: Record<string, string | undefined>,
): string {
  const variable = OPERATOR_TARGET_URL_VARIABLE[target];
  const url = (env[variable] ?? "").trim();
  if (url === "") throw new OperatorUsageError(`${variable} is not set for --target=${target}`);
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "mysql:") throw new Error("scheme");
    host = parsed.hostname;
  } catch {
    throw new OperatorUsageError(`${variable} is not a mysql:// URL`);
  }
  const loopback = LOOPBACK_HOSTS.has(host);
  if (target === "production" && loopback) {
    throw new OperatorUsageError(`${variable} names a loopback host; refusing --target=production`);
  }
  if (target === "local" && !loopback) {
    throw new OperatorUsageError(`${variable} names a remote host; refusing --target=local`);
  }
  return url;
}

/**
 * A client for exactly this URL. The longer transaction window is for a remote
 * database: ~100 ms per round trip exhausts Prisma's 5 s default inside one
 * governed transaction.
 */
export function createOperatorClient(url: string): PrismaClient {
  return new PrismaClient({
    datasourceUrl: url,
    transactionOptions: { timeout: 30_000, maxWait: 10_000 },
  });
}

/** Parse `--key=value` and bare `--flag` arguments against a closed list. */
export function parseOperatorArgs(
  argv: readonly string[],
  allowed: { values: readonly string[]; flags: readonly string[] },
): { values: Record<string, string>; flags: Set<string> } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 2) {
      const key = arg.slice(2, eq);
      if (!allowed.values.includes(key)) throw new OperatorUsageError(`unrecognised argument: --${key}`);
      if (key in values) throw new OperatorUsageError(`repeated argument: --${key}`);
      values[key] = arg.slice(eq + 1);
    } else if (arg.startsWith("--") && allowed.flags.includes(arg.slice(2))) {
      flags.add(arg.slice(2));
    } else {
      /* Never echo the argument itself: an operator may have pasted a secret. */
      throw new OperatorUsageError("unrecognised argument");
    }
  }
  return { values, flags };
}

/**
 * Is this run permitted to write? A dry run always is "not writing"; an execute
 * run must carry the exact phrase.
 */
export function evaluateExecution(input: {
  execute: boolean;
  confirm: string | undefined;
  expectedPhrase: string;
}): "DRY_RUN" | "EXECUTE" {
  if (!input.execute) return "DRY_RUN";
  if (input.confirm !== input.expectedPhrase) {
    throw new OperatorUsageError(
      `--execute requires --confirm="${input.expectedPhrase}" exactly`,
    );
  }
  return "EXECUTE";
}

/** One JSON line. Callers pass an allow-listed object; nothing else reaches output. */
export function formatOperatorJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}
