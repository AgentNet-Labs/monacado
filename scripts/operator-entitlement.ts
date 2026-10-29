/**
 * `operator:bootstrap`, `operator:grant`, `operator:revoke` — governed
 * entitlement changes (first-operator governance phase). SERVER ONLY.
 *
 * ```
 *   npm run operator:bootstrap -- --target=production --account=<mon:acct:…> --capability=entitlement:govern
 *   npm run operator:grant     -- --target=production --actor=<mon:acct:…> --account=<mon:acct:…> --capability=commercial-policy:govern
 *   npm run operator:revoke    -- --target=production --actor=<mon:acct:…> --account=<mon:acct:…> --capability=commercial-policy:govern
 * ```
 *
 * Each is a dry run unless `--execute` and the exact `--confirm=` phrase it
 * prints are given. A dry run reads and reports the state the act would meet;
 * it writes nothing. See `operator-target.ts` for target isolation.
 *
 * What these commands never do: create an account (the operator signs up and
 * verifies like anyone else), read an account id or capability from the
 * environment, or print a URL, host, email, or name.
 *
 * `bootstrap` is the once-ever first grant of `entitlement:govern`. A rerun for
 * the account that received it reports `ALREADY_BOOTSTRAPPED` and writes nothing.
 * `grant` / `revoke` act as an `entitlement:govern` holder on
 * `commercial-policy:govern` or `marketplace-policy:govern` only.
 *
 * Exit codes: `0` success, no-op, or dry run; `1` refusal; `2` usage error;
 * `75` a failure worth retrying against a working database.
 */

import "dotenv/config";
import "../src/server/server-only";
import type { PrismaClient } from "@prisma/client";
import {
  bootstrapFirstEntitlement,
  grantEntitlementAsGovernor,
  inspectEntitlementGovernance,
  revokeEntitlementAsGovernor,
} from "../src/server/account/entitlement-governance-service";
import {
  EntitlementGovernanceRefusedError,
  InvalidEntitlementGovernanceInputError,
} from "../src/server/account/entitlement-governance-errors";
import {
  OperatorUsageError,
  createOperatorClient,
  evaluateExecution,
  formatOperatorJson,
  parseOperatorArgs,
  parseOperatorTarget,
  resolveOperatorDatabaseUrl,
  type OperatorTarget,
} from "./operator-target";

export const OPERATOR_ENTITLEMENT_COMMANDS = ["bootstrap", "grant", "revoke"] as const;
export type OperatorEntitlementCommand = (typeof OPERATOR_ENTITLEMENT_COMMANDS)[number];

export interface OperatorEntitlementOptions {
  command: OperatorEntitlementCommand;
  target: OperatorTarget;
  accountId: string;
  capability: string;
  actorAccountId: string | null;
  execute: boolean;
  confirm: string | undefined;
}

export function parseOperatorEntitlementOptions(argv: readonly string[]): OperatorEntitlementOptions {
  const [command, ...rest] = argv;
  if (!(OPERATOR_ENTITLEMENT_COMMANDS as readonly string[]).includes(command ?? "")) {
    throw new OperatorUsageError("first argument must be bootstrap, grant, or revoke");
  }
  const cmd = command as OperatorEntitlementCommand;
  const { values, flags } = parseOperatorArgs(rest, {
    values: cmd === "bootstrap"
      ? ["target", "account", "capability", "confirm"]
      : ["target", "actor", "account", "capability", "confirm"],
    flags: ["execute"],
  });
  const target = parseOperatorTarget(values.target);
  const accountId = (values.account ?? "").trim();
  const capability = (values.capability ?? "").trim();
  if (accountId === "") throw new OperatorUsageError("--account=<accountId> is required");
  if (capability === "") throw new OperatorUsageError("--capability=<capability> is required");
  let actorAccountId: string | null = null;
  if (cmd !== "bootstrap") {
    actorAccountId = (values.actor ?? "").trim();
    if (actorAccountId === "") throw new OperatorUsageError("--actor=<accountId> is required");
  }
  return {
    command: cmd,
    target,
    accountId,
    capability,
    actorAccountId,
    execute: flags.has("execute"),
    confirm: values.confirm,
  };
}

/** The exact phrase `--confirm=` must carry. Names the act, the accounts, and the target. */
export function operatorEntitlementConfirmPhrase(options: OperatorEntitlementOptions): string {
  switch (options.command) {
    case "bootstrap":
      return `BOOTSTRAP ${options.capability} FOR ${options.accountId} ON ${options.target}`;
    case "grant":
      return `GRANT ${options.capability} TO ${options.accountId} BY ${options.actorAccountId} ON ${options.target}`;
    case "revoke":
      return `REVOKE ${options.capability} FROM ${options.accountId} BY ${options.actorAccountId} ON ${options.target}`;
  }
}

export interface OperatorCommandDeps {
  /** Supplied by tests; otherwise a client is built from the target's one URL variable. */
  db?: PrismaClient;
  now?: () => string;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  deps: OperatorCommandDeps = {},
): Promise<number> {
  let options: OperatorEntitlementOptions;
  let mode: "DRY_RUN" | "EXECUTE";
  let url: string;
  try {
    options = parseOperatorEntitlementOptions(argv);
    url = resolveOperatorDatabaseUrl(options.target, env);
    mode = evaluateExecution({
      execute: options.execute,
      confirm: options.confirm,
      expectedPhrase: operatorEntitlementConfirmPhrase(options),
    });
  } catch (error) {
    out(formatOperatorJson({ result: "USAGE_ERROR", message: error instanceof OperatorUsageError ? error.message : "usage error" }));
    return 2;
  }

  const ownsClient = deps.db === undefined;
  const db = deps.db ?? createOperatorClient(url);
  const base = {
    command: options.command,
    target: options.target,
    mode,
    accountId: options.accountId,
    capability: options.capability,
    actorAccountId: options.actorAccountId,
  };
  try {
    const inspection = await inspectEntitlementGovernance(
      { accountId: options.accountId, capability: options.capability },
      { db },
    );
    const preflight = {
      accountExists: inspection.account.exists,
      accountStatus: inspection.account.status,
      emailVerifiedVia: inspection.account.emailVerifiedVia,
      accountHoldsCapability: inspection.account.holdsCapability,
      activeHolderCount: inspection.activeHolderCount,
      firstGrantAccountId: inspection.firstGrantAccountId,
    };
    if (mode === "DRY_RUN") {
      out(formatOperatorJson({
        ...base,
        result: "DRY_RUN",
        preflight,
        confirmPhrase: operatorEntitlementConfirmPhrase(options),
      }));
      return 0;
    }

    const actedAt = (deps.now ?? (() => new Date().toISOString()))();
    if (options.command === "bootstrap") {
      const outcome = await bootstrapFirstEntitlement(
        { accountId: options.accountId, capability: options.capability, actedAt },
        { db },
      );
      out(formatOperatorJson({ ...base, result: outcome.outcome, actId: outcome.act.actId, actedAt: outcome.act.actedAt, preflight }));
      return 0;
    }
    const change = {
      actorAccountId: options.actorAccountId,
      accountId: options.accountId,
      capability: options.capability,
      actedAt,
    };
    const outcome = options.command === "grant"
      ? await grantEntitlementAsGovernor(change, { db })
      : await revokeEntitlementAsGovernor(change, { db });
    out(formatOperatorJson({
      ...base,
      result: options.command === "grant" ? "GRANTED" : "REVOKED",
      actId: outcome.act.actId,
      actedAt: outcome.act.actedAt,
      preflight,
    }));
    return 0;
  } catch (error) {
    if (error instanceof EntitlementGovernanceRefusedError) {
      out(formatOperatorJson({ ...base, result: "REFUSED", refusal: error.refusal, reasonCodes: [...error.reasonCodes] }));
      return 1;
    }
    if (error instanceof InvalidEntitlementGovernanceInputError) {
      out(formatOperatorJson({ ...base, result: "USAGE_ERROR", fields: error.fields }));
      return 2;
    }
    /* The class name, never the message or cause chain: a database error can
       carry a connection string. */
    out(formatOperatorJson({ ...base, result: "FAILED", error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
    return 75;
  } finally {
    if (ownsClient) await db.$disconnect();
  }
}

/* Executed only when run as a command, never on import. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("operator-entitlement");

if (invokedDirectly) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 75;
    });
}
