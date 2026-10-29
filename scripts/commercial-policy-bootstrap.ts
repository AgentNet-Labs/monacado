/**
 * `commercial-policy:bootstrap` — put the standard commercial policy in force
 * (first-operator governance phase). SERVER ONLY.
 *
 * ```
 *   npm run commercial-policy:bootstrap -- --target=production --actor=<mon:acct:…>
 *   npm run commercial-policy:bootstrap -- --target=production --actor=<mon:acct:…> \
 *     --execute --confirm="BOOTSTRAP commercial-policy STANDARD_V1 BY <mon:acct:…> ON production"
 * ```
 *
 * The actor must actively hold `commercial-policy:govern`. The command records
 * and activates `MONACADO_STANDARD_POLICY_V1` (USD, 750 bp, 100 minor units,
 * HALF_UP) under a policy keyed `STANDARD_V1`, or — if exactly one equivalent
 * policy is already ACTIVE — writes nothing and reports that policy. Any ACTIVE
 * policy with different economics is a refusal. Either way it prints the policy
 * id, which is the value `MONACADO_CHECKOUT_POLICY_ID` must name; setting that
 * variable is a separate, owner-performed step.
 *
 * Dry run unless `--execute` and the exact `--confirm=` phrase. Target isolation,
 * output, and exit codes as `operator-entitlement.ts`.
 */

import "dotenv/config";
import "../src/server/server-only";
import {
  CommercialPolicyBootstrapRefusedError,
  STANDARD_COMMERCIAL_POLICY_BOOTSTRAP_KEY,
  bootstrapStandardCommercialPolicy,
  inspectStandardCommercialPolicy,
} from "../src/server/marketplace/commercial-policy-bootstrap";
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
import type { OperatorCommandDeps } from "./operator-entitlement";

export interface CommercialPolicyBootstrapOptions {
  target: OperatorTarget;
  actorAccountId: string;
  execute: boolean;
  confirm: string | undefined;
}

export function parseCommercialPolicyBootstrapOptions(
  argv: readonly string[],
): CommercialPolicyBootstrapOptions {
  const { values, flags } = parseOperatorArgs(argv, {
    values: ["target", "actor", "confirm"],
    flags: ["execute"],
  });
  const target = parseOperatorTarget(values.target);
  const actorAccountId = (values.actor ?? "").trim();
  if (actorAccountId === "") throw new OperatorUsageError("--actor=<accountId> is required");
  return { target, actorAccountId, execute: flags.has("execute"), confirm: values.confirm };
}

export function commercialPolicyBootstrapConfirmPhrase(
  options: CommercialPolicyBootstrapOptions,
): string {
  return `BOOTSTRAP commercial-policy ${STANDARD_COMMERCIAL_POLICY_BOOTSTRAP_KEY} BY ${options.actorAccountId} ON ${options.target}`;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  deps: OperatorCommandDeps = {},
): Promise<number> {
  let options: CommercialPolicyBootstrapOptions;
  let mode: "DRY_RUN" | "EXECUTE";
  let url: string;
  try {
    options = parseCommercialPolicyBootstrapOptions(argv);
    url = resolveOperatorDatabaseUrl(options.target, env);
    mode = evaluateExecution({
      execute: options.execute,
      confirm: options.confirm,
      expectedPhrase: commercialPolicyBootstrapConfirmPhrase(options),
    });
  } catch (error) {
    out(formatOperatorJson({ result: "USAGE_ERROR", message: error instanceof OperatorUsageError ? error.message : "usage error" }));
    return 2;
  }

  const ownsClient = deps.db === undefined;
  const db = deps.db ?? createOperatorClient(url);
  const base = {
    command: "commercial-policy:bootstrap",
    target: options.target,
    mode,
    actorAccountId: options.actorAccountId,
    bootstrapKey: STANDARD_COMMERCIAL_POLICY_BOOTSTRAP_KEY,
  };
  try {
    if (mode === "DRY_RUN") {
      const preflight = await inspectStandardCommercialPolicy(
        { actorAccountId: options.actorAccountId },
        { db },
      );
      out(formatOperatorJson({
        ...base,
        result: "DRY_RUN",
        preflight,
        confirmPhrase: commercialPolicyBootstrapConfirmPhrase(options),
      }));
      return 0;
    }
    const outcome = await bootstrapStandardCommercialPolicy(
      {
        actorAccountId: options.actorAccountId,
        now: (deps.now ?? (() => new Date().toISOString()))(),
      },
      { db },
    );
    out(formatOperatorJson({
      ...base,
      result: outcome.outcome,
      policyId: outcome.policyId,
      policyVersion: outcome.policyVersion,
    }));
    return 0;
  } catch (error) {
    if (error instanceof CommercialPolicyBootstrapRefusedError) {
      out(formatOperatorJson({ ...base, result: "REFUSED", refusal: error.refusal }));
      return 1;
    }
    out(formatOperatorJson({ ...base, result: "FAILED", error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
    return 75;
  } finally {
    if (ownsClient) await db.$disconnect();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("commercial-policy-bootstrap");

if (invokedDirectly) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 75;
    });
}
