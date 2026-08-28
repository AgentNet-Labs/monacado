/**
 * `chargeback:fee` — inspect and govern the seller chargeback fee (Phase 1.12).
 * SERVER ONLY.
 *
 * ```
 *   npm run chargeback:fee                        # inspect: current value and every version
 *   npm run chargeback:fee -- --json              # machine-readable only
 *
 *   npm run chargeback:fee:record -- --version=1.1.0 --amount=3500 --currency=USD
 *   npm run chargeback:fee:activate -- --version=1.1.0
 *
 *   # a mutating run against a production-classified target:
 *   npm run chargeback:fee:activate -- --version=1.1.0 --confirm-production
 * ```
 *
 * ## Why this exists at all
 *
 * The first cut of Phase 1.12 compiled `$30` into the assessment path. That made
 * the fee correct and unchangeable in the same stroke. This is the governed path
 * that replaces the deployment: an admin records a new value and, as a separate
 * decision, activates it.
 *
 * ## Recording and activating are two decisions
 *
 * Recording a version governs nobody — it is a value sitting in the database with
 * `DRAFT` on it. Activating one changes what the **next** finalized chargeback
 * costs a seller. A command that activated as a side effect of "add the new
 * amount" would be doing the consequential half by accident, which is exactly the
 * split `policy:bootstrap` already draws.
 *
 * ## Prospective only, and the database enforces it
 *
 * Activation retires the incumbent and installs the successor in one transaction,
 * under a unique `activeMarker` index that permits at most one `ACTIVE` version.
 * It reads and writes no `SellerChargebackFee` row: every assessment snapshotted
 * its amount, currency, and governing version pair when it was made, so a fee
 * change reaches the next chargeback and can never reach a past one.
 *
 * ## Production writes are gated, not forbidden
 *
 * This is eventually how a production deployment gets its fee, so refusing
 * production permanently would be refusing the job. A **mutating** run against a
 * production-classified environment requires `--confirm-production`, and without
 * it refuses **before the database client is constructed and before any write**.
 *
 * The confirmation is an argv flag and deliberately **not** an environment
 * variable: a variable is set once and then silently applies to every later
 * invocation, which is the accidental supply this gate exists to prevent.
 * `NODE_ENV` **classifies** the target; it never authorises one. Inspection never
 * mutates and never needs the confirmation.
 *
 * ## No buyer detail, and no seller detail
 *
 * A fee policy is a commercial value. Nothing here reads or prints an Order, a
 * participant, a buyer, or an assessed fee — only versions and amounts.
 */

import "dotenv/config";
import { disconnectPrisma } from "../src/server/db/client";
import {
  activateChargebackFeePolicyVersion,
  readChargebackFeePolicyVersions,
  recordChargebackFeePolicyVersion,
  resolveActiveChargebackFeePolicy,
} from "../src/server/marketplace/chargeback-fee-policy-service";
import { SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT } from "../src/contracts/marketplace/chargeback-fee";
import { DisputeEvidenceRefusedError } from "../src/server/marketplace/dispute-errors";
import type { SellerChargebackFeePolicyVersionView } from "../src/contracts/marketplace/chargeback-fee";

export type FeeCommand = "inspect" | "record" | "activate";

export interface FeeCommandOptions {
  command: FeeCommand;
  json: boolean;
  version: string | null;
  amountMinorUnits: number | null;
  currency: string | null;
  confirmProduction: boolean;
}

export class FeeUsageError extends Error {}

export function parseCommandOptions(argv: readonly string[]): FeeCommandOptions {
  const flagValue = (prefix: string): string | null => {
    const arg = argv.find((a) => a.startsWith(prefix));
    const value = arg === undefined ? "" : arg.slice(prefix.length).trim();
    return value === "" ? null : value;
  };
  const command: FeeCommand = argv.includes("--record")
    ? "record"
    : argv.includes("--activate")
      ? "activate"
      : "inspect";

  const rawAmount = flagValue("--amount=");
  let amountMinorUnits: number | null = null;
  if (rawAmount !== null) {
    /* Parsed strictly. An amount is minor units and nothing else: a typo that
       silently became NaN, or `30` meaning thirty cents when the operator meant
       thirty dollars, is a governed commercial value set wrong. */
    if (!/^\d+$/.test(rawAmount)) {
      throw new FeeUsageError("--amount= must be a whole number of minor units");
    }
    amountMinorUnits = Number(rawAmount);
  }

  const currency = flagValue("--currency=");
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    throw new FeeUsageError("--currency= must be a three-letter ISO 4217 code");
  }

  return {
    command,
    json: argv.includes("--json"),
    version: flagValue("--version="),
    amountMinorUnits,
    currency,
    confirmProduction: argv.includes("--confirm-production"),
  };
}

export interface FeeCommandOutcome {
  command: FeeCommand;
  /** The value a finalized chargeback would carry right now, or null. */
  active: { policyVersion: string; amountMinorUnits: number; currency: string } | null;
  versions: SellerChargebackFeePolicyVersionView[];
  refusedReason: string | null;
}

const bullet = (label: string, value: unknown): string => `  ${label.padEnd(34)} ${String(value)}`;

export function formatReport(outcome: FeeCommandOutcome): string {
  const lines: string[] = [`chargeback fee ${outcome.command}`, ""];
  if (outcome.active === null) {
    /* Stated loudly. No active version means finalized losses assess NOTHING —
       the fail-closed posture, not a silent $30. */
    lines.push(bullet("active version", "NONE — no fee is being assessed"));
  } else {
    lines.push(
      bullet("active version", outcome.active.policyVersion),
      bullet("amount (minor units)", outcome.active.amountMinorUnits),
      bullet("currency", outcome.active.currency),
    );
  }

  if (outcome.versions.length > 0) {
    lines.push("", "versions");
    for (const v of outcome.versions) {
      lines.push(
        `  ${v.policyVersion.padEnd(12)} ${v.status.padEnd(9)} ${String(v.amountMinorUnits).padStart(8)} ${v.currency}  effective=${v.effectiveFrom}`,
      );
    }
  }
  if (outcome.refusedReason !== null) {
    lines.push("", `  ${outcome.command} REFUSED: ${outcome.refusedReason}`);
  }
  return lines.join("\n");
}

/** Classifies the target. Never authorises one. */
function isProductionTarget(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "production";
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = console.log,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  let options: FeeCommandOptions;
  try {
    options = parseCommandOptions(argv);
  } catch (error) {
    out(error instanceof FeeUsageError ? error.message : "usage error");
    return 2;
  }

  const mutating = options.command !== "inspect";
  if (mutating && isProductionTarget(env) && !options.confirmProduction) {
    /* Refused BEFORE a database client is constructed and before any write. */
    out("REFUSED: a mutating run against a production target requires --confirm-production");
    return 2;
  }

  const at = new Date().toISOString();
  const outcome: FeeCommandOutcome = {
    command: options.command,
    active: null,
    versions: [],
    refusedReason: null,
  };

  try {
    if (options.command === "record") {
      if (options.version === null) throw new FeeUsageError("--version= is required");
      if (options.amountMinorUnits === null) throw new FeeUsageError("--amount= is required");
      await recordChargebackFeePolicyVersion({
        policyVersion: options.version,
        amountMinorUnits: options.amountMinorUnits,
        currency: options.currency ?? SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT.currency,
        effectiveFrom: at,
        /* The acting account, as the durable internal Account id. Never an email. */
        recordedByAccountId: env.MONACADO_OPERATOR_ACCOUNT_ID ?? "operator",
        at,
      });
    } else if (options.command === "activate") {
      if (options.version === null) throw new FeeUsageError("--version= is required");
      await activateChargebackFeePolicyVersion({
        policyVersion: options.version,
        activatedByAccountId: env.MONACADO_OPERATOR_ACCOUNT_ID ?? "operator",
        at,
      });
    }
  } catch (error) {
    if (error instanceof FeeUsageError) {
      out(error.message);
      await disconnectPrisma();
      return 2;
    }
    /* The reason code alone. A database error can carry a connection string, and
       this prints to a terminal and to a log. */
    outcome.refusedReason =
      error instanceof DisputeEvidenceRefusedError ? error.reason : "REFUSED";
  }

  outcome.active = await resolveActiveChargebackFeePolicy();
  outcome.versions = await readChargebackFeePolicyVersions();

  if (!options.json) out(formatReport(outcome));
  out(JSON.stringify(outcome, null, 2));

  if (outcome.refusedReason !== null) return 1;
  /* Non-zero when no fee is being assessed: a deployment silently charging
     nothing is a finding, not a healthy state. */
  return outcome.active === null ? 1 : 0;
}

/* Executed only when run as a command, never on import. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("chargeback-fee-policy");

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
