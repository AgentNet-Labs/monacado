/**
 * `policy:bootstrap` — put the shipped Marketplace Policy into the database
 * (Phase 1.4). SERVER ONLY.
 *
 * Phase 1.3 made an `ACTIVE` marketplace policy a prerequisite for participant
 * activation and for every checkout, and shipped no operator path to create one.
 * This is that path: one command, one bounded outcome, no loop, no scheduler, and
 * no daemon — the same shape as `worker:publication:once`.
 *
 * ```
 *   npm run policy:bootstrap           # record the shipped version as DRAFT
 *   npm run policy:bootstrap:activate  # record if needed, then ACTIVATE it
 *   npm run policy:bootstrap:inspect   # read and report; write nothing
 *
 *   npm run policy:bootstrap -- --version=1.1.0   # a specific shipped version
 * ```
 *
 * ## Which version (Phase 1.10)
 *
 * A deployment ships more than one version now, so `--version=` selects which,
 * defaulting to the newest. A version this deployment does not ship is a **usage
 * error** (exit 2) rather than a fallback: an operator typing a version is
 * stating which terms they mean to publish, and publishing different ones because
 * the typed ones do not exist would be the worst possible reading of a typo.
 *
 * Recording a version as DRAFT while a different one is ACTIVE is **permitted and
 * ordinary** — that is how the next governed version is published. Activating it
 * over a standing version is still refused here.
 *
 * ## Activation is a separate word
 *
 * Recording a version governs nobody. Activating one starts governing live
 * participants and live sales, so it is a distinct invocation rather than a
 * default — a command that activated as a side effect of "initialise the
 * database" would be doing the consequential half by accident.
 *
 * ## Production writes are gated, not forbidden
 *
 * This command is eventually the way a production deployment gets its governing
 * policy, so refusing production permanently would be refusing the job. Instead a
 * **mutating** run against a production-classified environment requires
 * `--confirm-production`, and without it refuses **before the database client is
 * constructed and before any write**.
 *
 * The confirmation is an argv flag and deliberately **not** an environment
 * variable: a variable is set once in a deployment and then silently applies to
 * every later invocation, which is exactly the accidental supply this gate exists
 * to prevent. It has to be typed, each time, by the person doing it.
 *
 * `NODE_ENV` **classifies** the target; it never authorises one. Nothing here
 * reads `DATABASE_URL`, a CI variable, or a hostname to decide what is permitted —
 * an inferred authorisation is one nobody granted.
 *
 * `--inspect` never mutates and therefore never needs the confirmation, in any
 * environment.
 *
 * ## Two confirmations are two decisions
 *
 * `--confirm-production` authorises **writing**. It does not authorise
 * **activating** — a production activation needs `policy:bootstrap:activate`
 * *and* `--confirm-production`, because "yes, write to production" and "yes, start
 * governing live sellers and live sales with these terms" are different answers
 * and must not be given by one word.
 *
 * ## What it prints
 *
 * Before any production-capable mutation — permitted or refused — a preflight
 * block naming the policy id, the version, the source hash, the requested action,
 * and the environment classification, so an operator can check what they are
 * about to do against what they meant to do.
 *
 * Then the outcome:
 *
 * The policy id, the version, the content ref, the source hash, the persisted
 * state, the action, and whether activation occurred — as human lines and as one
 * JSON object for a script. **Never** `DATABASE_URL`, never any other environment
 * variable, never an account email, and never policy prose.
 *
 * ## Exit codes
 *
 * `0` for a success or a no-change, `1` for a refusal, `2` for a usage error,
 * `75` (`EX_TEMPFAIL`) for a failure that is worth retrying against a working
 * database. `process.exit` is never called: the exit code is set and the process
 * is allowed to drain, as `run-publication-worker.ts` established.
 */

import "dotenv/config";
import "../src/server/server-only";
import { disconnectPrisma } from "../src/server/db/client";
import {
  bootstrapMarketplacePolicy,
  type BootstrapMode,
  type PolicyBootstrapDeps,
  type PolicyBootstrapOutcome,
} from "../src/server/policy/marketplace-policy-bootstrap";
import {
  LATEST_MARKETPLACE_POLICY_VERSION,
  MARKETPLACE_POLICY_CONTENT_REFS,
  MARKETPLACE_POLICY_DOCUMENTS,
  marketplacePolicyContentHash,
} from "../src/contracts/marketplace/marketplace-policy-content";

export interface CommandOptions {
  mode: BootstrapMode;
  activate: boolean;
  recordedByAccountId: string;
  /** Explicit authorisation to WRITE to a production-classified target. */
  confirmProduction: boolean;
  /**
   * Which shipped version to act on (Phase 1.10).
   *
   * Defaults to the newest this deployment ships. A version string that names no
   * shipped document is a **usage error** rather than a fallback: an operator who
   * mistypes a version is asking to publish terms, and publishing different ones
   * because the typed ones do not exist would be the worst possible reading of
   * the mistake.
   */
  policyVersion: string;
}

/**
 * What kind of target this is.
 *
 * A **classification**, never an authorisation. It decides whether a confirmation
 * is demanded; it never decides that one was given.
 */
export const ENVIRONMENT_CLASSIFICATIONS = ["PRODUCTION", "NON_PRODUCTION"] as const;
export type EnvironmentClassification = (typeof ENVIRONMENT_CLASSIFICATIONS)[number];

/**
 * Classify the target from `NODE_ENV`, and from nothing else.
 *
 * Deliberately not derived from `DATABASE_URL`, a CI variable, or a hostname.
 * Those are guesses, and a guess that says "this looks like production" is one
 * word away from a guess that says "…so this must be authorised".
 */
export function classifyEnvironment(
  env: Record<string, string | undefined>,
): EnvironmentClassification {
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production"
    ? "PRODUCTION"
    : "NON_PRODUCTION";
}

/** Why a run was permitted, or what it is missing. */
export const GATE_DECISIONS = [
  /** `--inspect`: reads only, so nothing to confirm. */
  "READ_ONLY",
  /** Not a production target. */
  "NON_PRODUCTION",
  /** A production target, and the operator confirmed the write. */
  "PRODUCTION_CONFIRMED",
  /** A production target with no confirmation. Refused before any write. */
  "PRODUCTION_CONFIRMATION_REQUIRED",
] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

export interface GateResult {
  permitted: boolean;
  decision: GateDecision;
  environment: EnvironmentClassification;
}

/**
 * May this invocation write?
 *
 * Pure, and separated from the command so the decision is testable without a
 * database, a clock, or a process. Note what it does **not** consider: whether
 * activation was asked for. Confirming a production write never implies
 * activation — that is `--activate`'s to say, and only its.
 */
export function evaluateProductionGate(input: {
  mode: BootstrapMode;
  environment: EnvironmentClassification;
  confirmProduction: boolean;
}): GateResult {
  const base = { environment: input.environment };
  if (input.mode === "INSPECT") {
    return { ...base, permitted: true, decision: "READ_ONLY" };
  }
  if (input.environment !== "PRODUCTION") {
    return { ...base, permitted: true, decision: "NON_PRODUCTION" };
  }
  return input.confirmProduction
    ? { ...base, permitted: true, decision: "PRODUCTION_CONFIRMED" }
    : { ...base, permitted: false, decision: "PRODUCTION_CONFIRMATION_REQUIRED" };
}

export class BootstrapUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapUsageError";
  }
}

/**
 * Read the invocation.
 *
 * The recording account comes from `MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID` or
 * `--recorded-by`. It is **required**: a governance row records who recorded the
 * version, and a command that invented a recorder would be manufacturing the one
 * fact the row exists to hold.
 */
export function parseCommandOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): CommandOptions {
  let mode: BootstrapMode = "APPLY";
  let activate = false;
  let confirmProduction = false;
  let policyVersion: string = LATEST_MARKETPLACE_POLICY_VERSION;
  let recordedByAccountId = (env.MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID ?? "").trim();

  for (const arg of argv) {
    if (arg === "--inspect") mode = "INSPECT";
    else if (arg === "--activate") activate = true;
    else if (arg.startsWith("--version=")) {
      policyVersion = arg.slice("--version=".length).trim();
    }
    /* Read from argv ONLY. There is deliberately no environment variable for
       this: a variable is set once and then silently authorises every later
       invocation, which is the accidental supply the gate exists to prevent. */
    else if (arg === "--confirm-production") confirmProduction = true;
    else if (arg.startsWith("--recorded-by=")) {
      recordedByAccountId = arg.slice("--recorded-by=".length).trim();
    } else {
      throw new BootstrapUsageError(`unrecognised argument: ${arg}`);
    }
  }

  if (recordedByAccountId === "") {
    throw new BootstrapUsageError(
      "no recording account: set MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID or pass --recorded-by=<accountId>",
    );
  }
  if (!MARKETPLACE_POLICY_DOCUMENTS.has(policyVersion)) {
    throw new BootstrapUsageError(
      `unknown policy version: ${policyVersion} (shipped: ${[...MARKETPLACE_POLICY_DOCUMENTS.keys()].join(", ")})`,
    );
  }
  return { mode, activate, recordedByAccountId, confirmProduction, policyVersion };
}

/**
 * What an operator is about to do, printed before a production-capable mutation.
 *
 * Everything here is known from the **source module and the invocation** — no
 * database read is needed to produce it — so it can be shown before a client is
 * constructed and before anything could be written. `requestedAction` is what was
 * *asked for*; what actually happens still depends on what is already persisted,
 * and is reported afterwards.
 */
export function formatPreflight(input: {
  environment: EnvironmentClassification;
  mode: BootstrapMode;
  activate: boolean;
  /** Which shipped version. Defaults to the newest, exactly as parsing does. */
  policyVersion?: string;
}): string {
  const version = input.policyVersion ?? LATEST_MARKETPLACE_POLICY_VERSION;
  /* `parseCommandOptions` refuses an unshipped version before this is reached,
     so the lookups resolve. The fallbacks exist so a preflight can never throw
     on the path whose whole purpose is telling an operator what is about to
     happen. */
  const document = MARKETPLACE_POLICY_DOCUMENTS.get(version);
  return [
    "Monacado — marketplace policy bootstrap (preflight)",
    `  environment:      ${input.environment}`,
    `  mode:             ${input.mode}`,
    `  policy id:        ${document?.policyId ?? "(unknown version)"}`,
    `  policy version:   ${version}`,
    `  content ref:      ${MARKETPLACE_POLICY_CONTENT_REFS.get(version) ?? "(unknown version)"}`,
    `  source hash:      ${document === undefined ? "(unknown version)" : marketplacePolicyContentHash(document)}`,
    `  requested action: ${input.activate ? "RECORD_AND_ACTIVATE" : "RECORD_ONLY"}`,
  ].join("\n");
}

/**
 * The report.
 *
 * An allow-list of fields, built from the outcome and from nothing else, so
 * there is no path by which an environment value could reach the output.
 */
export function formatReport(outcome: PolicyBootstrapOutcome): string {
  const lines = [
    "Monacado — marketplace policy bootstrap",
    `  mode:             ${outcome.mode}`,
    `  policy id:        ${outcome.policyId}`,
    `  policy version:   ${outcome.policyVersion}`,
    `  content ref:      ${outcome.contentRef ?? "(none)"}`,
    `  source hash:      ${outcome.sourceHash ?? "(none)"}`,
    `  persisted hash:   ${outcome.persistedHash ?? "(none)"}`,
    `  persisted state:  ${outcome.persistedState}`,
    /* Named for what the flag governs. "reacceptance: required" read as though an
       already-active participant had to click Accept again before trading, which
       is not Monacado's rule: for them an updated version takes effect after
       notice and continued use is the acceptance. The flag has only ever meant
       that a NEW participant accepts this version at onboarding. */
    `  onboarding accept: ${outcome.requiresReacceptance ? "required" : "not required"}`,
    `  standing active:  ${outcome.standingActiveVersion ?? "(none)"}`,
    `  action:           ${outcome.action}`,
    `  applied:          ${outcome.applied ? "yes" : "no"}`,
    `  activated:        ${outcome.activated ? "yes" : "no"}`,
  ];
  if (outcome.refusal !== null) lines.push(`  refused:          ${outcome.refusal}`);
  if (outcome.conflictingActiveVersion !== null) {
    lines.push(`  active version:   ${outcome.conflictingActiveVersion}`);
  }
  return lines.join("\n");
}

/** The machine-readable half. Exactly the outcome, with nothing added. */
export function formatJson(outcome: PolicyBootstrapOutcome): string {
  return JSON.stringify(outcome);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  out: (line: string) => void = (line) => console.log(line),
  /**
   * Passed straight through to the bootstrap. Injected **only** so a test can
   * exercise the command against its own policy identity — recording and
   * activating versions of the real one would rewrite the terms every other
   * suite's participants are activated under. A command invocation supplies
   * nothing here and the defaults apply.
   */
  deps: PolicyBootstrapDeps = {},
): Promise<number> {
  let options: CommandOptions;
  try {
    options = parseCommandOptions(argv, env);
  } catch (error) {
    out(error instanceof Error ? error.message : "usage error");
    return 2;
  }

  const gate = evaluateProductionGate({
    mode: options.mode,
    environment: classifyEnvironment(env),
    confirmProduction: options.confirmProduction,
  });

  /* Shown before the database client is constructed, so the operator sees what
     is about to happen whether or not it is permitted to happen. */
  if (gate.environment === "PRODUCTION" && options.mode === "APPLY") {
    out(
      formatPreflight({
        environment: gate.environment,
        mode: options.mode,
        activate: options.activate,
        policyVersion: options.policyVersion,
      }),
    );
  }

  if (!gate.permitted) {
    out(`refused: ${gate.decision}`);
    out(
      "a mutating bootstrap against a production target requires --confirm-production",
    );
    return 1;
  }

  let outcome: PolicyBootstrapOutcome;
  try {
    outcome = await bootstrapMarketplacePolicy(
      {
        recordedByAccountId: options.recordedByAccountId,
        now: new Date().toISOString(),
        activate: options.activate,
        mode: options.mode,
        policyVersion: options.policyVersion,
      },
      deps,
    );
  } catch (error) {
    /* The message, never the cause chain: a database error can carry a
       connection string, and this command prints to a terminal and a log. */
    out(`failed: ${error instanceof Error ? error.name : "UNKNOWN_ERROR"}`);
    return 75;
  }

  out(formatReport(outcome));
  out(formatJson(outcome));
  return outcome.action === "REFUSED" ? 1 : 0;
}

/* Executed only when run as a command, never on import — the test imports this
   module for `parseCommandOptions` and `formatReport`. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("bootstrap-marketplace-policy");

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
