/**
 * `dispute:evidence:*` — assemble, review, and send a dispute response
 * (Phase 1.12). SERVER ONLY.
 *
 * ```
 *   npm run dispute:evidence:status                        # what is answerable, and what is not prepared
 *   npm run dispute:evidence:status -- --json              # machine-readable only
 *   npm run dispute:evidence:status -- --dispute=<id>      # one package
 *
 *   npm run dispute:evidence:prepare -- --dispute=<id>
 *   npm run dispute:evidence:prepare -- --dispute=<id> --request-seller-statement
 *
 *   npm run dispute:evidence:submit -- --dispute=<id>                  # DRY RUN: contacts nobody
 *   npm run dispute:evidence:submit -- --dispute=<id> --approve        # records approval only
 *   npm run dispute:evidence:submit -- --dispute=<id> --confirm=<providerDisputeRef>
 * ```
 *
 * ## How this narrows `dispute:status`'s "no write flag at all"
 *
 * That rule was about **provider-owned state**: a dispute's status belongs to the
 * webhook, and an operator tool that could edit it would be a second answer able
 * to disagree. That rule is kept exactly. What is written here is Monacado's own
 * conduct — a package, an approval, an attempt — and none of it touches `status`,
 * `fundsState`, `evidenceDueBy`, or the provider's submission counters.
 *
 * ## The dry run is the default, and that is deliberate
 *
 * Every other governed operator write in this repository requires a flag. So does
 * this one — but the act here is **one-shot and irreversible**, so no flag means
 * *contact nobody*, and `--confirm=` takes the provider's own dispute reference
 * retyped. A mistyped id spends the only submission there is.
 *
 * ## No buyer PII, and no amounts
 *
 * Counts, ages, evidence **codes**, and record pointers. No name, email, address,
 * or amount reaches this output — a disputed amount is a purchase amount and a
 * statement about what a specific person is contesting. Seller attestations print
 * as vocabulary members, never as prose, because there is no prose to print.
 */

import "dotenv/config";
import { disconnectPrisma } from "../src/server/db/client";
import {
  approveDisputeEvidence,
  prepareDisputeEvidence,
  readPackage,
  submitDisputeEvidence,
  type DisputeEvidencePackageView,
} from "../src/server/marketplace/dispute-evidence-service";
import {
  recordDisputeEvidenceSubmissionFailure,
  recordDisputeEvidenceSubmittedNotice,
  requestSellerDisputeEvidence,
} from "../src/server/notifications/dispute-notice-service";
import { inspectOpenDisputes } from "../src/server/marketplace/dispute-operations-service";
import { evaluateDisputeReadiness } from "../src/server/operations/dispute-readiness";
import { DisputeEvidenceRefusedError } from "../src/server/marketplace/dispute-errors";
import { createStripeDisputeEvidenceAdapter } from "../src/server/payments/stripe-dispute-evidence-adapter";
import {
  MONACADO_REPRESENTMENT_RULING,
  SELLER_DEFENSE_WORKFLOW,
} from "../src/contracts/marketplace/dispute-evidence";

export type EvidenceCommand = "status" | "prepare" | "submit";

export interface EvidenceCommandOptions {
  command: EvidenceCommand;
  json: boolean;
  disputeId: string | null;
  requestSellerStatement: boolean;
  approve: boolean;
  confirm: string | null;
  /**
   * The internal Account recorded as having approved a package.
   *
   * `null` unless `--approve` was passed, and non-null whenever it was —
   * parsing refuses otherwise.
   */
  approvingAccountId: string | null;
}

/**
 * A malformed or under-specified invocation. Exits 2, before any database work.
 *
 * Carries `reason` rather than relying on `message`, matching how every refusal
 * in this script is reported: the file deliberately never prints `error.message`
 * because a database error's message can carry a connection string, and a test
 * asserts that absence. `reason` is self-authored guidance with nothing
 * external in it.
 */
export class EvidenceUsageError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "EvidenceUsageError";
    this.reason = reason;
  }
}

/**
 * Read the invocation.
 *
 * The approving account comes from `MONACADO_OPERATOR_ACCOUNT_ID` or
 * `--approving-account=`, and is **required whenever `--approve` is passed**.
 *
 * Until Phase 1.19 this read `env.MONACADO_OPERATOR_ACCOUNT_ID ?? "operator"`.
 * The variable was undocumented and unset, so the literal `"operator"` was the
 * live path — and it was stamped into `approvedByAccountId`, the column that
 * authorises an irreversible, one-shot transmission to a card network. An
 * approval nobody signed is not an approval, and a placeholder is worse than no
 * record because it looks like one.
 *
 * Every other command needs no actor: `status`, `prepare`, and an unapproved
 * `submit` write rows, but none of them writes an actor column.
 */
export function parseCommandOptions(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): EvidenceCommandOptions {
  const flagValue = (prefix: string): string | null => {
    const arg = argv.find((a) => a.startsWith(prefix));
    const value = arg === undefined ? "" : arg.slice(prefix.length).trim();
    return value === "" ? null : value;
  };
  const command: EvidenceCommand = argv.includes("--prepare")
    ? "prepare"
    : argv.includes("--submit")
      ? "submit"
      : "status";
  const approve = argv.includes("--approve");
  const supplied =
    flagValue("--approving-account=") ?? (env.MONACADO_OPERATOR_ACCOUNT_ID ?? "").trim();
  const approvingAccountId = supplied === "" ? null : supplied;

  if (approve && approvingAccountId === null) {
    throw new EvidenceUsageError(
      "no approving account: set MONACADO_OPERATOR_ACCOUNT_ID or pass --approving-account=<accountId>",
    );
  }

  return {
    command,
    json: argv.includes("--json"),
    disputeId: flagValue("--dispute="),
    requestSellerStatement: argv.includes("--request-seller-statement"),
    approve,
    confirm: flagValue("--confirm="),
    approvingAccountId,
  };
}

export interface EvidenceCommandOutcome {
  command: EvidenceCommand;
  /** Whether Monacado may represent at all. Permanently true since the ruling. */
  representmentAuthorised: boolean;
  /** Configuration posture, so "why did nothing send" is answerable here. */
  submissionConfigured: boolean;
  /** The seller's defence path, printed so the ordering is visible to an operator. */
  workflow: readonly string[];
  readinessBlockers: string[];
  /** Counts only. */
  backlog: {
    answerable: number;
    deadlinePassed: number;
    noResponsePermitted: number;
  };
  /** Present only for a run naming one dispute. */
  package: DisputeEvidencePackageView | null;
  /** Present when a run refused. A bounded code, never prose. */
  refusedReason: string | null;
  sellerStatementRequested: boolean;
  /** True when a submit ran without `--confirm=` and therefore contacted nobody. */
  dryRun: boolean;
}

const bullet = (label: string, value: unknown): string => `  ${label.padEnd(34)} ${String(value)}`;

export function formatReport(outcome: EvidenceCommandOutcome): string {
  const lines: string[] = [
    `dispute evidence ${outcome.command}`,
    "",
    bullet("representment authorised", outcome.representmentAuthorised),
    bullet("submission configured", outcome.submissionConfigured),
    bullet("workflow", outcome.workflow.join(" → ")),
    bullet("answerable disputes", outcome.backlog.answerable),
    bullet("deadline passed", outcome.backlog.deadlinePassed),
    bullet("no response permitted", outcome.backlog.noResponsePermitted),
  ];

  if (outcome.readinessBlockers.length > 0) {
    lines.push("", "blockers");
    for (const blocker of outcome.readinessBlockers) lines.push(`  ${blocker}`);
  }

  if (outcome.package !== null) {
    const p = outcome.package;
    lines.push(
      "",
      "package",
      bullet("dispute", p.disputeId),
      bullet("preparation", p.preparationId),
      bullet("revision", p.revision),
      bullet("status", p.status),
      bullet("completeness", p.completeness),
      bullet("approved", p.approved),
      bullet("submitted", p.submitted),
      bullet("evidence codes", p.itemCodes.join(", ") || "-"),
      bullet("seller attestations", p.attestationClaims.join(", ") || "-"),
      bullet("failure", p.failureCode ?? "-"),
    );
  }

  if (outcome.sellerStatementRequested) {
    lines.push("", "  seller evidence requested");
  }
  if (outcome.dryRun) {
    lines.push("", "  DRY RUN — no provider was contacted. Re-run with --confirm=<providerDisputeRef>.");
  }
  if (outcome.refusedReason !== null) {
    lines.push("", `  ${outcome.command} REFUSED: ${outcome.refusedReason}`);
  }
  return lines.join("\n");
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = console.log,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  let options: EvidenceCommandOptions;
  try {
    options = parseCommandOptions(argv, env);
  } catch (error) {
    /* Refused BEFORE a database client is used and before any row is read.
       Exit 2 is this repository's usage code, matching `policy:bootstrap`. */
    out(error instanceof EvidenceUsageError ? error.reason : "usage error");
    return 2;
  }
  const at = new Date().toISOString();

  const readiness = evaluateDisputeReadiness(at, env);
  const rows = await inspectOpenDisputes({ at, limit: 200 });
  const backlog = {
    answerable: rows.filter((r) => r.action === "ASSEMBLE_EVIDENCE_AND_SUBMIT_IN_DASHBOARD").length,
    deadlinePassed: rows.filter((r) => r.action === "DEADLINE_PASSED_NO_ACTION_POSSIBLE").length,
    noResponsePermitted: rows.filter((r) => r.action === "NO_RESPONSE_PERMITTED_RECORD_ONLY").length,
  };

  const outcome: EvidenceCommandOutcome = {
    command: options.command,
    representmentAuthorised: MONACADO_REPRESENTMENT_RULING.ruling === "RESOLVED",
    submissionConfigured: readiness.providerSubmissionConfigured,
    workflow: SELLER_DEFENSE_WORKFLOW,
    readinessBlockers: [...readiness.blockers],
    backlog,
    package: null,
    refusedReason: null,
    sellerStatementRequested: false,
    dryRun: false,
  };

  try {
    if (options.command === "prepare") {
      if (options.disputeId === null) throw new DisputeEvidenceRefusedError("DISPUTE_NOT_NAMED");
      outcome.package = await prepareDisputeEvidence({ disputeId: options.disputeId, at });
      if (options.requestSellerStatement) {
        const requested = await requestSellerDisputeEvidence({
          disputeId: options.disputeId,
          requestId: outcome.package.preparationId,
          at,
        });
        outcome.sellerStatementRequested = requested.obligationId !== null;
      }
    } else if (options.command === "submit") {
      if (options.disputeId === null) throw new DisputeEvidenceRefusedError("DISPUTE_NOT_NAMED");
      const prepared = await prepareDisputeEvidence({ disputeId: options.disputeId, at });

      if (options.approve) {
        /* The approving account was required at parse time and is resolved
           against persisted entitlement state by `approveDisputeEvidence`
           itself — the account must exist, be ACTIVE, and hold
           `dispute:evidence:approve`. Nothing is recorded for a caller who
           holds none, because an approval nobody could make is not an
           approval. Non-null by construction on this branch. */
        outcome.package = await approveDisputeEvidence({
          preparationId: prepared.preparationId,
          actingAccountId: options.approvingAccountId!,
          at,
        });
      } else {
        outcome.package = prepared;
      }

      if (options.confirm === null) {
        /* No provider is contacted. The default is inert because the act is
           irreversible. */
        outcome.dryRun = true;
      } else {
        outcome.dryRun = false;
        try {
          outcome.package = await submitDisputeEvidence(
            { preparationId: prepared.preparationId, at },
            { env, port: createStripeDisputeEvidenceAdapter({ env }) },
          );
          await recordDisputeEvidenceSubmittedNotice({ disputeId: options.disputeId, at });
        } catch (error) {
          if (error instanceof DisputeEvidenceRefusedError) {
            await recordDisputeEvidenceSubmissionFailure({ disputeId: options.disputeId, at });
          }
          throw error;
        }
      }
    } else if (options.disputeId !== null) {
      const prepared = await prepareDisputeEvidence({ disputeId: options.disputeId, at });
      outcome.package = await readPackage(prepared.preparationId);
    }
  } catch (error) {
    /* The reason code alone. A database error can carry a connection string, and
       this prints to a terminal and to a log. */
    outcome.refusedReason =
      error instanceof DisputeEvidenceRefusedError ? error.reason : "REFUSED";
  }

  if (!options.json) out(formatReport(outcome));
  out(JSON.stringify(outcome, null, 2));

  if (outcome.refusedReason !== null) return 1;
  return outcome.readinessBlockers.length === 0 ? 0 : 1;
}

/* Executed only when run as a command, never on import. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("dispute-evidence");

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
