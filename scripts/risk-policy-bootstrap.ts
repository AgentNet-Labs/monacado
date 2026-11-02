/**
 * `risk-policy:bootstrap` — put a first risk policy version in force (Phase
 * 1.46). SERVER ONLY.
 *
 * ```
 *   npm run risk-policy:bootstrap -- --target=production --actor=<mon:acct:…> \
 *     --policy-id=<mon:rpol:…> --max-order=<minor units>
 *   … --execute --confirm="BOOTSTRAP risk-policy <mon:rpol:…|NEW> MAX <n> USD BY <mon:acct:…> ON production"
 * ```
 *
 * The actor must actively hold `risk-policy:govern`. `--policy-id` should be
 * the value `MONACADO_RISK_POLICY_ID` already names; omitted, a new id is
 * minted and printed, and setting the variable is a separate owner step. The
 * version requires Seller commerce approval and payment readiness; currency is
 * USD. See `src/server/risk/risk-policy-bootstrap.ts`.
 *
 * Dry run unless `--execute` and the exact `--confirm=` phrase. Target isolation,
 * output, and exit codes as `operator-entitlement.ts`.
 */

import "dotenv/config";
import "../src/server/server-only";
import {
  RiskPolicyBootstrapRefusedError,
  bootstrapRiskPolicy,
  inspectRiskPolicyBootstrap,
  type RiskPolicyControls,
} from "../src/server/risk/risk-policy-bootstrap";
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

export interface RiskPolicyBootstrapOptions {
  target: OperatorTarget;
  actorAccountId: string;
  policyId: string | null;
  controls: RiskPolicyControls;
  execute: boolean;
  confirm: string | undefined;
}

export function parseRiskPolicyBootstrapOptions(argv: readonly string[]): RiskPolicyBootstrapOptions {
  const { values, flags } = parseOperatorArgs(argv, {
    values: ["target", "actor", "policy-id", "max-order", "confirm"],
    flags: ["execute"],
  });
  const target = parseOperatorTarget(values.target);
  const actorAccountId = (values.actor ?? "").trim();
  if (actorAccountId === "") throw new OperatorUsageError("--actor=<accountId> is required");
  const maxOrder = (values["max-order"] ?? "").trim();
  if (!/^[1-9][0-9]{0,14}$/.test(maxOrder)) {
    throw new OperatorUsageError("--max-order=<positive integer minor units> is required");
  }
  const policyId = (values["policy-id"] ?? "").trim();
  return {
    target,
    actorAccountId,
    policyId: policyId === "" ? null : policyId,
    controls: {
      currency: "USD",
      maxSingleOrderCommercialAmountMinorUnits: Number(maxOrder),
      requireSellerCommerceApproval: true,
      requireSellerPaymentReadiness: true,
    },
    execute: flags.has("execute"),
    confirm: values.confirm,
  };
}

export function riskPolicyBootstrapConfirmPhrase(options: RiskPolicyBootstrapOptions): string {
  return `BOOTSTRAP risk-policy ${options.policyId ?? "NEW"} MAX ${options.controls.maxSingleOrderCommercialAmountMinorUnits} ${options.controls.currency} BY ${options.actorAccountId} ON ${options.target}`;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  deps: OperatorCommandDeps = {},
): Promise<number> {
  let options: RiskPolicyBootstrapOptions;
  let mode: "DRY_RUN" | "EXECUTE";
  let url: string;
  try {
    options = parseRiskPolicyBootstrapOptions(argv);
    url = resolveOperatorDatabaseUrl(options.target, env);
    mode = evaluateExecution({
      execute: options.execute,
      confirm: options.confirm,
      expectedPhrase: riskPolicyBootstrapConfirmPhrase(options),
    });
  } catch (error) {
    out(formatOperatorJson({ result: "USAGE_ERROR", message: error instanceof OperatorUsageError ? error.message : "usage error" }));
    return 2;
  }

  const ownsClient = deps.db === undefined;
  const db = deps.db ?? createOperatorClient(url);
  const base = {
    command: "risk-policy:bootstrap",
    target: options.target,
    mode,
    actorAccountId: options.actorAccountId,
    policyId: options.policyId,
    controls: options.controls,
  };
  try {
    if (mode === "DRY_RUN") {
      const preflight = await inspectRiskPolicyBootstrap(options, { db });
      out(formatOperatorJson({ ...base, result: "DRY_RUN", preflight, confirmPhrase: riskPolicyBootstrapConfirmPhrase(options) }));
      return 0;
    }
    const outcome = await bootstrapRiskPolicy(
      { ...options, now: (deps.now ?? (() => new Date().toISOString()))() },
      { db },
    );
    out(formatOperatorJson({ ...base, result: outcome.outcome, policyId: outcome.policyId, policyVersion: outcome.policyVersion }));
    return 0;
  } catch (error) {
    if (error instanceof RiskPolicyBootstrapRefusedError) {
      out(formatOperatorJson({ ...base, result: "REFUSED", refusal: error.refusal }));
      return 1;
    }
    out(formatOperatorJson({ ...base, result: "FAILED", error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
    return 75;
  } finally {
    if (ownsClient) await db.$disconnect();
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].includes("risk-policy-bootstrap");

if (invokedDirectly) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 75;
    });
}
