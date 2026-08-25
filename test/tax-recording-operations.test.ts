/**
 * Tax recording operations contract tests (Phase 1.8).
 *
 * **NO NETWORK, NO STRIPE ACCOUNT, NO CREDENTIAL, NO AGENTNET PUBLICATION.**
 *
 * Persistence — that a due row is processed, a live claim is not stolen, an
 * expired claim recovers, a requeue works — lives in
 * `tax-recording-operations.integration.test.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CALCULATION_EXPIRY_REMEDIATION,
  NON_REQUEUEABLE_FAILURE_REMEDIATION,
  REQUEUEABLE_FAILURE_CODES,
  TAX_RECORDING_EVENTS,
  TAX_RECORDING_OPERATIONS_POLICY,
  TaxRecordingBacklog,
  TaxRecordingInspection,
  backlogIsHealthy,
  isRequeueableFailure,
  operatorActionFor,
} from "../src/contracts/marketplace/tax-recording-operations";
import { TAX_TRANSACTION_RETRY_POLICY } from "../src/contracts/marketplace/tax-transaction";
import {
  MAX_REQUEST_LIMIT,
  TAX_RECORDER_ENDPOINT_PATH,
  TAX_RECORDER_SCHEDULE_GUIDANCE,
  handleTaxRecorderRequest,
  isAuthorizedTaxRecorderRequest,
  isTaxRecorderSecretConfigured,
} from "../src/server/tax/tax-recorder-route-handler";
import { evaluateTaxReadiness } from "../src/server/tax/tax-readiness";
import { parseCommandOptions } from "../scripts/tax-recording-status";

const AT = "2028-08-01T10:00:00.000Z";
const SECRET = "p18-dispatcher-secret-value";

const backlog = (over: Record<string, unknown> = {}) =>
  TaxRecordingBacklog.parse({
    pending: 0,
    retryPending: 0,
    inProgress: 0,
    recorded: 0,
    permanentlyFailed: 0,
    dueNow: 0,
    expiredClaims: 0,
    oldestUnresolvedAgeSeconds: null,
    paidOrdersMissingTaxTransaction: 0,
    calculationExpired: 0,
    evaluatedAt: AT,
    ...over,
  });

// — 1 · The dispatcher gate —

describe("1.8 · the dispatcher endpoint refuses everything without the secret", () => {
  const env = { MONACADO_TAX_RECORDER_SECRET: SECRET };

  it("refuses absent, wrong-scheme, and wrong secrets identically", () => {
    expect(isAuthorizedTaxRecorderRequest(null, env)).toBe(false);
    expect(isAuthorizedTaxRecorderRequest("", env)).toBe(false);
    expect(isAuthorizedTaxRecorderRequest(SECRET, env)).toBe(false);
    expect(isAuthorizedTaxRecorderRequest(`Basic ${SECRET}`, env)).toBe(false);
    expect(isAuthorizedTaxRecorderRequest("Bearer wrong", env)).toBe(false);
    expect(isAuthorizedTaxRecorderRequest(`Bearer ${SECRET}x`, env)).toBe(false);
    expect(isAuthorizedTaxRecorderRequest(`Bearer ${SECRET}`, env)).toBe(true);
    /* Case-insensitive scheme, exact secret. */
    expect(isAuthorizedTaxRecorderRequest(`bearer ${SECRET}`, env)).toBe(true);
  });

  it("refuses everything when no secret is configured", () => {
    expect(isAuthorizedTaxRecorderRequest(`Bearer ${SECRET}`, {})).toBe(false);
    expect(isAuthorizedTaxRecorderRequest("Bearer ", {})).toBe(false);
    expect(isTaxRecorderSecretConfigured({})).toBe(false);
    /* An unconfigured dispatcher is not a permissive one. */
    expect(isTaxRecorderSecretConfigured({ MONACADO_TAX_RECORDER_SECRET: "  " })).toBe(false);
    expect(isTaxRecorderSecretConfigured(env)).toBe(true);
  });

  it("uses a dedicated secret, not the email dispatcher's", () => {
    expect(
      isAuthorizedTaxRecorderRequest(`Bearer ${SECRET}`, {
        MONACADO_EMAIL_DISPATCHER_SECRET: SECRET,
      }),
    ).toBe(false);
  });

  it("answers 401 with a body that names nothing", async () => {
    for (const header of [null, "Bearer wrong", `Basic ${SECRET}`]) {
      const result = await handleTaxRecorderRequest(
        { authorizationHeader: header, limitParam: null, now: AT },
        { env },
      );
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: "UNAUTHORIZED" });
      /* No variable name, no hint at which condition failed, no tax config. */
      const serialized = JSON.stringify(result.body);
      expect(serialized).not.toContain("MONACADO");
      expect(serialized).not.toContain(SECRET);
    }
  });
});

// — 2 · Bounded invocation —

describe("1.8 · an authorized request runs one bounded cycle", () => {
  const env = { MONACADO_TAX_RECORDER_SECRET: SECRET };

  it("invokes the recorder and returns counts only", async () => {
    let seenLimit: number | undefined;
    const result = await handleTaxRecorderRequest(
      { authorizationHeader: `Bearer ${SECRET}`, limitParam: null, now: AT },
      {
        env,
        db: {
          orderTaxTransaction: {
            async updateMany() {
              return { count: 0 };
            },
            async findMany(args: { take?: number }) {
              seenLimit = args.take;
              return [];
            },
          },
        } as never,
      },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ran: true,
      claimed: 0,
      recorded: 0,
      retryScheduled: 0,
      permanentlyFailed: 0,
      staleClaimsRecovered: 0,
      claimConflicts: 0,
    });
    /* Bounded: a request is not a drain. */
    expect(seenLimit).toBe(TAX_RECORDING_OPERATIONS_POLICY.defaultCycleLimit);
  });

  it("clamps an oversized limit and ignores a nonsense one", async () => {
    const seen: Array<number | undefined> = [];
    const db = {
      orderTaxTransaction: {
        async updateMany() {
          return { count: 0 };
        },
        async findMany(args: { take?: number }) {
          seen.push(args.take);
          return [];
        },
      },
    } as never;

    for (const limitParam of ["9999", "abc", "-4"]) {
      await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${SECRET}`, limitParam, now: AT },
        { env, db },
      );
    }
    expect(seen[0]).toBe(MAX_REQUEST_LIMIT);
    expect(seen[1]).toBe(TAX_RECORDING_OPERATIONS_POLICY.defaultCycleLimit);
    expect(seen[2]).toBe(TAX_RECORDING_OPERATIONS_POLICY.defaultCycleLimit);
  });

  it("answers 503 when a cycle fails, because the work is still due", async () => {
    const result = await handleTaxRecorderRequest(
      { authorizationHeader: `Bearer ${SECRET}`, limitParam: null, now: AT },
      {
        env,
        db: {
          orderTaxTransaction: {
            async updateMany() {
              throw new Error("connection lost to mysql://root:hunter2@db.internal");
            },
          },
        } as never,
      },
    );
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "TAX_RECORDING_UNAVAILABLE" });
    /* The error is discarded: it can carry a query, a row, or a connection
       string. */
    expect(JSON.stringify(result.body)).not.toContain("hunter2");
  });

  it("accepts both verbs at the same path, so a GET-only scheduler can fire", () => {
    const route = readFileSync(
      new URL("../app/api/internal/operations/tax-recorder/route.ts", import.meta.url),
      "utf8",
    );
    expect(route).toContain("export async function GET");
    expect(route).toContain("export async function POST");
    /* Both funnel through ONE helper, so there is no second, laxer path: the
       gate cannot be bypassed by picking a verb. */
    expect(route.match(/return runCycle\(request\);/g)?.length).toBe(2);
    expect(route.match(/handleTaxRecorderRequest\(/g)?.length).toBe(1);
    expect(TAX_RECORDER_ENDPOINT_PATH).toBe("/api/internal/operations/tax-recorder");
  });

  it("recommends a five-minute cadence without committing a cron that could fail to deploy", () => {
    /* The cadence is DOCUMENTED, not declared. Vercel caps Hobby cron at once
       per day, and the repository holds no authoritative statement of which plan
       Monacado production runs on — committing a minute-level schedule would
       commit a deployment that fails at deploy time on a plan nobody has ruled
       out. */
    expect(TAX_RECORDER_SCHEDULE_GUIDANCE.recommendedCron).toBe("*/5 * * * *");
    expect(TAX_RECORDER_SCHEDULE_GUIDANCE.recommendedIntervalSeconds).toBe(300);
    expect(TAX_RECORDER_SCHEDULE_GUIDANCE.vercelMinuteLevelCronRequiresPlan).toBe(
      "PRO_OR_ENTERPRISE",
    );
    /* And downgrading to daily to fit Hobby is explicitly NOT the answer: once a
       day is not a tax-recording cadence. */
    expect(TAX_RECORDER_SCHEDULE_GUIDANCE.vercelHobbyCronCadence).toBe("DAILY");
    expect(TAX_RECORDER_SCHEDULE_GUIDANCE.dailyCadenceAdequate).toBe(false);
    /* The scheduler need not be Vercel at all. */
    expect(TAX_RECORDER_SCHEDULE_GUIDANCE.externalSchedulerAcceptable).toBe(true);
    expect(TAX_RECORDER_SCHEDULE_GUIDANCE.productionPrerequisite).toBe(true);
  });

  it("commits no cron declaration anywhere in the repository", () => {
    expect(TAX_RECORDER_SCHEDULE_GUIDANCE.committedCronDeclaration).toBe("NONE");
    /* Asserted against the filesystem, not merely stated: a deployment file
       reintroducing a plan-dependent schedule must fail this. */
    expect(existsSync(new URL("../vercel.json", import.meta.url))).toBe(false);
    /* And the endpoint a future scheduler will call is still named once, here. */
    expect(TAX_RECORDER_ENDPOINT_PATH).toBe("/api/internal/operations/tax-recorder");
  });
});

// — 3 · Backlog and operator action —

describe("1.8 · the backlog says what is stuck and what to do about it", () => {
  it("is healthy when nothing is failed, missing, or overdue", () => {
    expect(backlogIsHealthy(backlog())).toBe(true);
    expect(backlogIsHealthy(backlog({ pending: 3, dueNow: 3, oldestUnresolvedAgeSeconds: 60 }))).toBe(
      true,
    );
  });

  it("is unhealthy on permanent failures, missing rows, or an overdue tail", () => {
    expect(backlogIsHealthy(backlog({ permanentlyFailed: 1 }))).toBe(false);
    expect(backlogIsHealthy(backlog({ paidOrdersMissingTaxTransaction: 1 }))).toBe(false);
    expect(
      backlogIsHealthy(
        backlog({
          oldestUnresolvedAgeSeconds: TAX_RECORDING_OPERATIONS_POLICY.maxOverdueSeconds + 1,
        }),
      ),
    ).toBe(false);
  });

  it("sets the overdue threshold past the retry tail and short of expiry", () => {
    const tail = TAX_TRANSACTION_RETRY_POLICY.backoffSeconds.reduce((a, b) => a + b, 0);
    /* Ordinary backoff must never trip it… */
    expect(TAX_RECORDING_OPERATIONS_POLICY.maxOverdueSeconds).toBeGreaterThan(tail);
    /* …and a stopped scheduler must trip it well before a calculation expires. */
    expect(TAX_RECORDING_OPERATIONS_POLICY.maxOverdueSeconds).toBeLessThan(7 * 24 * 60 * 60);
  });

  it("names an action for every state, and never says 'retry' where retry cannot help", () => {
    expect(operatorActionFor({ recordingStatus: "RECORDED", lastFailureCode: null })).toBe("NONE");
    expect(operatorActionFor({ recordingStatus: "PENDING", lastFailureCode: null })).toBe(
      "AWAIT_SCHEDULED_CYCLE",
    );
    expect(operatorActionFor({ recordingStatus: "IN_PROGRESS", lastFailureCode: null })).toBe(
      "AWAIT_IN_FLIGHT_ATTEMPT",
    );
    expect(
      operatorActionFor({
        recordingStatus: "FAILED_PERMANENT",
        lastFailureCode: "PROVIDER_UNAVAILABLE",
      }),
    ).toBe("REQUEUE_AFTER_PROVIDER_RECOVERY");
    expect(
      operatorActionFor({
        recordingStatus: "FAILED_PERMANENT",
        lastFailureCode: "PROVIDER_NOT_CONFIGURED",
      }),
    ).toBe("CORRECT_CONFIGURATION_THEN_REQUEUE");
    /* The three a retry cannot fix. */
    expect(
      operatorActionFor({
        recordingStatus: "FAILED_PERMANENT",
        lastFailureCode: "CALCULATION_EXPIRED",
      }),
    ).toBe("OPERATOR_TAX_ADJUSTMENT_REQUIRED");
    expect(
      operatorActionFor({
        recordingStatus: "FAILED_PERMANENT",
        lastFailureCode: "DUPLICATE_REFERENCE",
      }),
    ).toBe("RECONCILE_PROVIDER_TRANSACTION");
    expect(
      operatorActionFor({
        recordingStatus: "FAILED_PERMANENT",
        lastFailureCode: "EVIDENCE_INCONSISTENT",
      }),
    ).toBe("INVESTIGATE_RECORD_DIVERGENCE");
  });

  it("refuses to call a non-requeueable failure requeueable", () => {
    for (const code of REQUEUEABLE_FAILURE_CODES) {
      expect(isRequeueableFailure(code), code).toBe(true);
    }
    for (const code of Object.keys(NON_REQUEUEABLE_FAILURE_REMEDIATION)) {
      expect(isRequeueableFailure(code as never), code).toBe(false);
    }
    expect(isRequeueableFailure(null)).toBe(false);
  });

  it("says plainly that an expired calculation is not a retry problem", () => {
    expect(CALCULATION_EXPIRY_REMEDIATION.retryable).toBe(false);
    expect(CALCULATION_EXPIRY_REMEDIATION.automaticRecalculation).toBe("REFUSED");
    /* And why: re-pricing a historical sale at today's rates would fabricate a
       tax record indistinguishable from a correct one. */
    expect(CALCULATION_EXPIRY_REMEDIATION.reason).toContain("HISTORICAL SALE");
    expect(CALCULATION_EXPIRY_REMEDIATION.surfacedState).toEqual([
      "A_PAID_ORDER_EXISTS",
      "TAX_TRANSACTION_RECORDING_INCOMPLETE",
      "OPERATOR_REMEDIATION_REQUIRED",
    ]);
  });

  it("keeps buyer identity out of the backlog and the inspection shape", () => {
    for (const forbidden of [
      "buyerName",
      "buyerEmail",
      "email",
      "billingAddress",
      "shippingAddress",
      "amount",
      "taxAmountMinorUnits",
    ]) {
      expect(TaxRecordingBacklog.safeParse({ ...backlog(), [forbidden]: "x" }).success, forbidden).toBe(
        false,
      );
    }
    const inspection = {
      orderId: "mon:order:X",
      taxTransactionId: "mon:txtax:X",
      recordingStatus: "FAILED_PERMANENT",
      attemptCount: 8,
      requeueCount: 0,
      lastFailureCode: "PROVIDER_UNAVAILABLE",
      nextAttemptAt: null,
      providerCalculationRef: "taxcalc_1",
      providerTaxTransactionRef: null,
      action: "REQUEUE_AFTER_PROVIDER_RECOVERY",
      requeueable: true,
      ageSeconds: 10,
    };
    expect(TaxRecordingInspection.safeParse(inspection).success).toBe(true);
    for (const forbidden of ["buyerEmail", "billingAddress", "taxAmountMinorUnits"]) {
      expect(
        TaxRecordingInspection.safeParse({ ...inspection, [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });
});

// — 4 · Readiness —

describe("1.8 · a recorder nothing runs is not operationally ready", () => {
  const calculable = {
    MONACADO_TAX_ENABLED: "true",
    MONACADO_TAX_PROVIDER: "STRIPE_TAX",
    MONACADO_STRIPE_SECRET_KEY: "sk_test_x",
    MONACADO_TAX_STRIPE_TAX_CODE_DIGITAL_GOOD: "txcd_TEST_DIGITAL",
  };

  it("blocks when the dispatcher secret is missing", () => {
    const report = evaluateTaxReadiness(AT, calculable);
    /* It can calculate and it can record — and nothing can invoke it. */
    expect(report.calculationConfigured).toBe(true);
    expect(report.taxTransactionRecordingAvailable).toBe(true);
    expect(report.taxLifecycleReady).toBe(false);
    expect(report.blockers).toContain("TAX_RECORDER_DISPATCHER_NOT_CONFIGURED");
    expect(report.recorderOperations.dispatcherSecretConfigured).toBe(false);
    expect(report.state).toBe("TAX_RECORDER_OPERATIONS_REQUIRED");
  });

  it("blocks when no schedule is declared", () => {
    const report = evaluateTaxReadiness(AT, {
      ...calculable,
      MONACADO_TAX_RECORDER_SECRET: SECRET,
    });
    expect(report.blockers).toContain("TAX_RECORDER_SCHEDULE_NOT_DECLARED");
    expect(report.recorderOperations.scheduleDeclaration).toBeNull();
    expect(report.taxLifecycleReady).toBe(false);
  });

  it("clears once both are stated, and still refuses live commerce", () => {
    const report = evaluateTaxReadiness(AT, {
      ...calculable,
      MONACADO_TAX_RECORDER_SECRET: SECRET,
      MONACADO_TAX_RECORDER_SCHEDULE: "vercel-cron:*/5 * * * *",
    });
    expect(report.recorderOperations.operationallyInvocable).toBe(true);
    expect(report.taxLifecycleReady).toBe(true);
    expect(report.satisfied).toContain("TAX_RECORDER_DISPATCHER");
    expect(report.satisfied).toContain("TAX_RECORDER_SCHEDULE");
    /* Still not live: that gate is unchanged and unclearable. */
    expect(report.liveTaxCommercePermitted).toBe(false);
  });

  it("never reads a credential value into the report", () => {
    const report = evaluateTaxReadiness(AT, {
      ...calculable,
      MONACADO_TAX_RECORDER_SECRET: SECRET,
      MONACADO_TAX_RECORDER_SCHEDULE: "vercel-cron",
    });
    const printed = JSON.stringify(report);
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain("sk_test_x");
    /* Variable NAMES are what an operator needs, and are not secrets. */
    expect(printed).toContain("MONACADO_TAX_RECORDER_SECRET");
  });

  it("does not perform a provider call to answer any of it", () => {
    const source = readFileSync(
      new URL("../src/server/tax/tax-readiness.ts", import.meta.url),
      "utf8",
    );
    const imports = (source.match(/^import .*$/gm) ?? []).join("\n").toLowerCase();
    for (const forbidden of ["stripe-client", "stripe-tax-adapter", "stripe-tax-transaction"]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
  });
});

// — 5 · Observability and command shape —

describe("1.8 · operational output carries counts, never buyer data", () => {
  it("names a closed set of cycle events", () => {
    expect(TAX_RECORDING_EVENTS).toEqual([
      "tax_recording_cycle_started",
      "tax_recording_cycle_completed",
      "tax_recording_cycle_failed",
    ]);
  });

  it("reads its command flags without touching a database", () => {
    expect(parseCommandOptions([])).toEqual({
      json: false,
      includeRetrying: false,
      requeueId: null,
    });
    expect(parseCommandOptions(["--json", "--all", "--requeue=mon:txtax:ABC"])).toEqual({
      json: true,
      includeRetrying: true,
      requeueId: "mon:txtax:ABC",
    });
    /* An empty flag is not an id. */
    expect(parseCommandOptions(["--requeue="]).requeueId).toBeNull();
  });
});
