/**
 * `operator:commerce-approve`, `operator:tax-classify` — the two operational
 * acts a first sale needs from Monacado staff (Phase 1.46). SERVER ONLY.
 *
 * ```
 *   npm run operator:commerce-approve -- --target=production --actor=<mon:acct:…> \
 *     --participant=<participant id> [--decision=APPROVED] [--reason=REQUIREMENTS_MET]
 *   npm run operator:tax-classify -- --target=production --actor=<mon:acct:…> \
 *     --product-ref=<productRef> --classification=DIGITAL_GOOD
 * ```
 *
 * The actor is the separate operational staff account (owner ruling), holding
 * `participant:commerce-approve` or `product:tax-classify` through a governed
 * grant (`operator:grant`). Each act goes through its existing governed service
 * unchanged — the entitlement check, the self-action refusal, and the
 * append-only history are theirs.
 *
 * Dry run unless `--execute` and the exact `--confirm=` phrase it prints. A dry
 * run reads the current decision or classification and writes nothing. Target
 * isolation, output, and exit codes as `operator-entitlement.ts`.
 */

import "dotenv/config";
import "../src/server/server-only";
import {
  getCurrentCommerceApproval,
  recordCommerceApproval,
} from "../src/server/marketplace/participant-commerce-approval-service";
import {
  CommerceApprovalPersistenceFailureError,
  CommerceApprovalServiceError,
} from "../src/server/marketplace/participant-commerce-approval-errors";
import { classifyProductTaxAs } from "../src/server/marketplace/product-tax-classification-service";
import {
  ConcurrencyConflictError,
  DatabaseError,
  ProductRepositoryError,
} from "../src/server/product/errors";
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

export const OPERATOR_COMMERCE_COMMANDS = ["commerce-approve", "tax-classify"] as const;
export type OperatorCommerceCommand = (typeof OPERATOR_COMMERCE_COMMANDS)[number];

export type OperatorCommerceOptions =
  | {
      command: "commerce-approve";
      target: OperatorTarget;
      actorAccountId: string;
      participantId: string;
      decision: string;
      reasonCode: string;
      execute: boolean;
      confirm: string | undefined;
    }
  | {
      command: "tax-classify";
      target: OperatorTarget;
      actorAccountId: string;
      productRef: string;
      classification: string;
      execute: boolean;
      confirm: string | undefined;
    };

export function parseOperatorCommerceOptions(argv: readonly string[]): OperatorCommerceOptions {
  const [command, ...rest] = argv;
  if (!(OPERATOR_COMMERCE_COMMANDS as readonly string[]).includes(command ?? "")) {
    throw new OperatorUsageError("first argument must be commerce-approve or tax-classify");
  }
  const { values, flags } = parseOperatorArgs(rest, {
    values:
      command === "commerce-approve"
        ? ["target", "actor", "participant", "decision", "reason", "confirm"]
        : ["target", "actor", "product-ref", "classification", "confirm"],
    flags: ["execute"],
  });
  const target = parseOperatorTarget(values.target);
  const actorAccountId = (values.actor ?? "").trim();
  if (actorAccountId === "") throw new OperatorUsageError("--actor=<accountId> is required");
  const common = { target, actorAccountId, execute: flags.has("execute"), confirm: values.confirm };
  if (command === "commerce-approve") {
    const participantId = (values.participant ?? "").trim();
    if (participantId === "") throw new OperatorUsageError("--participant=<participantId> is required");
    return {
      command,
      ...common,
      participantId,
      decision: (values.decision ?? "APPROVED").trim(),
      reasonCode: (values.reason ?? "REQUIREMENTS_MET").trim(),
    };
  }
  const productRef = (values["product-ref"] ?? "").trim();
  const classification = (values.classification ?? "").trim();
  if (productRef === "") throw new OperatorUsageError("--product-ref=<productRef> is required");
  if (classification === "") throw new OperatorUsageError("--classification=<classification> is required");
  return { command: "tax-classify", ...common, productRef, classification };
}

export function operatorCommerceConfirmPhrase(options: OperatorCommerceOptions): string {
  return options.command === "commerce-approve"
    ? `COMMERCE ${options.decision} ${options.participantId} (${options.reasonCode}) BY ${options.actorAccountId} ON ${options.target}`
    : `TAX-CLASSIFY ${options.productRef} AS ${options.classification} BY ${options.actorAccountId} ON ${options.target}`;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  deps: OperatorCommandDeps = {},
): Promise<number> {
  let options: OperatorCommerceOptions;
  let mode: "DRY_RUN" | "EXECUTE";
  let url: string;
  try {
    options = parseOperatorCommerceOptions(argv);
    url = resolveOperatorDatabaseUrl(options.target, env);
    mode = evaluateExecution({
      execute: options.execute,
      confirm: options.confirm,
      expectedPhrase: operatorCommerceConfirmPhrase(options),
    });
  } catch (error) {
    out(formatOperatorJson({ result: "USAGE_ERROR", message: error instanceof OperatorUsageError ? error.message : "usage error" }));
    return 2;
  }

  const ownsClient = deps.db === undefined;
  const db = deps.db ?? createOperatorClient(url);
  const { execute: _execute, confirm: _confirm, ...described } = options;
  const base = { ...described, mode };
  const now = (deps.now ?? (() => new Date().toISOString()))();
  try {
    if (options.command === "commerce-approve") {
      if (mode === "DRY_RUN") {
        const current = await getCurrentCommerceApproval(options.participantId, { db });
        out(formatOperatorJson({
          ...base,
          result: "DRY_RUN",
          preflight: { currentDecision: current?.decision ?? null, currentReasonCode: current?.reasonCode ?? null },
          confirmPhrase: operatorCommerceConfirmPhrase(options),
        }));
        return 0;
      }
      const record = await recordCommerceApproval(
        {
          participantId: options.participantId,
          decision: options.decision,
          reasonCode: options.reasonCode,
          actingAccountId: options.actorAccountId,
          decidedAt: now,
        },
        { db },
      );
      out(formatOperatorJson({ ...base, result: "RECORDED", approvalId: record.approvalId, decidedAt: record.decidedAt }));
      return 0;
    }

    if (mode === "DRY_RUN") {
      const product = await db.product.findUnique({
        where: { productRef: options.productRef },
        select: { internalProductId: true },
      });
      out(formatOperatorJson({
        ...base,
        result: "DRY_RUN",
        preflight: { productExists: product !== null },
        confirmPhrase: operatorCommerceConfirmPhrase(options),
      }));
      return 0;
    }
    const classified = await classifyProductTaxAs(
      { accountId: options.actorAccountId },
      { productRef: options.productRef, taxClassification: options.classification, now },
      { db },
    );
    out(formatOperatorJson({ ...base, result: "CLASSIFIED", taxClassification: classified.taxClassification }));
    return 0;
  } catch (error) {
    const refused =
      (error instanceof CommerceApprovalServiceError && !(error instanceof CommerceApprovalPersistenceFailureError)) ||
      (error instanceof ProductRepositoryError &&
        !(error instanceof DatabaseError) &&
        !(error instanceof ConcurrencyConflictError));
    if (refused) {
      out(formatOperatorJson({ ...base, result: "REFUSED", refusal: (error as { code: string }).code }));
      return 1;
    }
    /* The class name, never the message or cause chain. */
    out(formatOperatorJson({ ...base, result: "FAILED", error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
    return 75;
  } finally {
    if (ownsClient) await db.$disconnect();
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].includes("operator-commerce");

if (invokedDirectly) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 75;
    });
}
