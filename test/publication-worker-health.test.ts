/**
 * Publication-worker health assessment tests (Phase 0E.7.3).
 *
 * NO DATABASE and NO NETWORK. `assessPublicationWorkerHealth` is a pure function of
 * a bounded record set and two thresholds, which is exactly why the whole
 * precedence policy can be exercised here rather than through fixtures.
 *
 * Every instant below is explicit. Nothing reads a clock.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAILURE_STREAK,
  MAX_HEALTH_FRESHNESS_SECONDS,
  MAX_RECENT_RUN_LIMIT,
  MAX_WORKER_RUN_ISSUE_CODES,
  MIN_HEALTH_FRESHNESS_SECONDS,
  WORKER_HEALTH_ASSESSMENTS,
  WORKER_RUN_STATUSES,
  AssessPublicationWorkerHealthInput,
  ListRecentPublicationWorkerRunsInput,
  PublicationWorkerRunRecord,
  StartPublicationWorkerRunInput,
  CompletePublicationWorkerRunInput,
  FailPublicationWorkerRunInput,
  AbandonStalePublicationWorkerRunsInput,
  assessPublicationWorkerHealth,
  isTerminalWorkerRunStatus,
  normalizeWorkerRunIssueCodes,
  type PublicationWorkerRunRecord as RunRecord,
  type WorkerHealthAssessment,
} from "../src/contracts/product/publication-worker-run";

const NOW = "2026-11-10T12:00:00.000Z";
const FRESH = 3_600; // one hour

/** Shift an ISO instant by whole seconds. */
const shift = (iso: string, seconds: number): string =>
  new Date(Date.parse(iso) + seconds * 1_000).toISOString();

let seq = 0;
function run(overrides: Partial<RunRecord> = {}): RunRecord {
  seq += 1;
  return PublicationWorkerRunRecord.parse({
    cycleId: `cyc-H${String(seq).padStart(4, "0")}`,
    status: "COMPLETED",
    outcome: "COMPLETED",
    exitCode: 0,
    maximumRuns: 5,
    runsAttempted: 2,
    itemsClaimed: 1,
    stoppedForNoWork: false,
    shutdownRequested: false,
    expiredClaimsExamined: 0,
    expiredClaimsRecovered: 0,
    expiredClaimsSkipped: 0,
    issueCodes: [],
    startedAt: shift(NOW, -120),
    completedAt: shift(NOW, -60),
    ...overrides,
  });
}

const assess = (
  runs: RunRecord[],
  options: { assessedAt?: string; freshnessSeconds?: number; failureStreakThreshold?: number } = {},
) =>
  assessPublicationWorkerHealth(
    AssessPublicationWorkerHealthInput.parse({
      assessedAt: options.assessedAt ?? NOW,
      freshnessSeconds: options.freshnessSeconds ?? FRESH,
      ...(options.failureStreakThreshold !== undefined
        ? { failureStreakThreshold: options.failureStreakThreshold }
        : {}),
      runs,
    }),
  );

const assessmentOf = (runs: RunRecord[], options = {}): WorkerHealthAssessment =>
  assess(runs, options).assessment;

// — Contract shape —

describe("worker-run contracts", () => {
  it("closes the status and assessment vocabularies", () => {
    expect([...WORKER_RUN_STATUSES]).toEqual(["STARTED", "COMPLETED", "FAILED", "ABANDONED"]);
    expect([...WORKER_HEALTH_ASSESSMENTS]).toEqual([
      "NO_HISTORY",
      "HEALTHY",
      "DEGRADED",
      "STALE",
      "FAILED",
    ]);
    expect(isTerminalWorkerRunStatus("STARTED")).toBe(false);
    for (const terminal of ["COMPLETED", "FAILED", "ABANDONED"]) {
      expect(isTerminalWorkerRunStatus(terminal)).toBe(true);
    }
  });

  it("rejects unknown fields on every lifecycle input", () => {
    expect(
      StartPublicationWorkerRunInput.safeParse({
        cycleId: "cyc-A",
        startedAt: NOW,
        maximumRuns: 1,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      AbandonStalePublicationWorkerRunsInput.safeParse({
        startedBefore: NOW,
        abandonedAt: NOW,
        limit: 1,
        sneak: 1,
      }).success,
    ).toBe(false);
    expect(
      ListRecentPublicationWorkerRunsInput.safeParse({ limit: 5, filter: "x" }).success,
    ).toBe(false);
  });

  it("bounds counters, exit codes, and the cycle id", () => {
    const base = {
      cycleId: "cyc-A",
      completedAt: NOW,
      outcome: "COMPLETED",
      exitCode: 0,
      runsAttempted: 1,
      itemsClaimed: 1,
      stoppedForNoWork: false,
      shutdownRequested: false,
      expiredClaimsExamined: 0,
      expiredClaimsRecovered: 0,
      expiredClaimsSkipped: 0,
      issueCodes: [],
    };
    expect(CompletePublicationWorkerRunInput.safeParse(base).success).toBe(true);
    expect(CompletePublicationWorkerRunInput.safeParse({ ...base, exitCode: 256 }).success).toBe(false);
    expect(CompletePublicationWorkerRunInput.safeParse({ ...base, exitCode: -1 }).success).toBe(false);
    expect(CompletePublicationWorkerRunInput.safeParse({ ...base, runsAttempted: -1 }).success).toBe(false);
    expect(CompletePublicationWorkerRunInput.safeParse({ ...base, itemsClaimed: 101 }).success).toBe(false);
    // A cycle id that could carry structure into stored or emitted output.
    for (const bad of ["", "a".repeat(65), 'cyc-{"a":1}', "cyc with space", "cyc,comma"]) {
      expect(CompletePublicationWorkerRunInput.safeParse({ ...base, cycleId: bad }).success).toBe(false);
    }
  });

  it("refuses unsafe issue codes rather than truncating them", () => {
    const base = {
      cycleId: "cyc-A",
      completedAt: NOW,
      exitCode: 1,
      issueCodes: ["WORKER_CYCLE_FAILURE"],
    };
    expect(FailPublicationWorkerRunInput.safeParse(base).success).toBe(true);
    for (const bad of [
      "connect ECONNREFUSED 10.0.0.1:3306",
      "lower_case",
      "mysql://root@127.0.0.1",
      "Bearer abc",
      "HAS,COMMA",
      "A".repeat(65),
    ]) {
      expect(FailPublicationWorkerRunInput.safeParse({ ...base, issueCodes: [bad] }).success).toBe(false);
    }
    // A failure must say something about itself.
    expect(FailPublicationWorkerRunInput.safeParse({ ...base, issueCodes: [] }).success).toBe(false);
    // And the list is capped.
    const many = Array.from({ length: MAX_WORKER_RUN_ISSUE_CODES + 1 }, (_, i) => `CODE_${i}`);
    expect(FailPublicationWorkerRunInput.safeParse({ ...base, issueCodes: many }).success).toBe(false);
  });

  it("deduplicates and sorts issue codes deterministically", () => {
    expect(normalizeWorkerRunIssueCodes(["B_CODE", "A_CODE", "B_CODE"])).toEqual([
      "A_CODE",
      "B_CODE",
    ]);
    // Order-independence is what makes an identical terminal replay recognisable.
    expect(normalizeWorkerRunIssueCodes(["X", "Y"])).toEqual(normalizeWorkerRunIssueCodes(["Y", "X"]));
  });

  it("bounds the recent-run limit and the freshness window", () => {
    for (const limit of [0, -1, MAX_RECENT_RUN_LIMIT + 1, 2.5]) {
      expect(ListRecentPublicationWorkerRunsInput.safeParse({ limit }).success).toBe(false);
    }
    expect(ListRecentPublicationWorkerRunsInput.safeParse({ limit: 1 }).success).toBe(true);
    expect(ListRecentPublicationWorkerRunsInput.safeParse({ limit: MAX_RECENT_RUN_LIMIT }).success).toBe(true);

    const health = { assessedAt: NOW, runs: [] };
    for (const freshnessSeconds of [0, MAX_HEALTH_FRESHNESS_SECONDS + 1]) {
      expect(AssessPublicationWorkerHealthInput.safeParse({ ...health, freshnessSeconds }).success).toBe(false);
    }
    expect(
      AssessPublicationWorkerHealthInput.safeParse({
        ...health,
        freshnessSeconds: MIN_HEALTH_FRESHNESS_SECONDS,
      }).success,
    ).toBe(true);
    // The considered window is itself bounded.
    expect(
      AssessPublicationWorkerHealthInput.safeParse({
        ...health,
        freshnessSeconds: FRESH,
        runs: Array.from({ length: MAX_RECENT_RUN_LIMIT + 1 }, () => run()),
      }).success,
    ).toBe(false);
  });
});

// — Health policy —

describe("publication worker health", () => {
  it("returns NO_HISTORY when there is no terminal run", () => {
    const result = assess([]);
    expect(result.assessment).toBe("NO_HISTORY");
    expect(result.reasonCodes).toEqual(["NO_TERMINAL_RUNS"]);
    expect(result.mostRecentRunAt).toBeUndefined();
    expect(result.counts.considered).toBe(0);

    // A STARTED row is work in flight, not evidence about health.
    const started = assess([run({ status: "STARTED", outcome: null, completedAt: null })]);
    expect(started.assessment).toBe("NO_HISTORY");
  });

  it("returns HEALTHY for a recent coherent run", () => {
    for (const outcome of [
      "COMPLETED",
      "NO_WORK",
      "RUN_LIMIT_REACHED",
      "SHUTDOWN_REQUESTED",
    ] as const) {
      const result = assess([run({ outcome })]);
      expect(result.assessment).toBe("HEALTHY");
      expect(result.reasonCodes).toEqual(["LATEST_RUN_COHERENT"]);
      expect(result.mostRecentOutcome).toBe(outcome);
      expect(result.ageSeconds).toBe(60);
    }
  });

  it("treats NO_WORK as healthy rather than a separate idle state", () => {
    // A worker that ran and found nothing did its job; there is no queue backlog
    // and nothing for an operator to do.
    const result = assess([run({ outcome: "NO_WORK", stoppedForNoWork: true, itemsClaimed: 0 })]);
    expect(result.assessment).toBe("HEALTHY");
  });

  it("returns DEGRADED when the latest run carries operational issues", () => {
    const result = assess([run({ issueCodes: ["MONITORING_HOOK_FAILURE"] })]);
    expect(result.assessment).toBe("DEGRADED");
    expect(result.reasonCodes).toContain("LATEST_RUN_HAS_ISSUES");
    expect(result.counts.withIssues).toBe(1);
  });

  it("returns DEGRADED for a failure in the window below the streak threshold", () => {
    const result = assess([
      run({ completedAt: shift(NOW, -60) }),
      run({ status: "FAILED", outcome: "FAILED", exitCode: 1, completedAt: shift(NOW, -600) }),
    ]);
    expect(result.assessment).toBe("DEGRADED");
    expect(result.reasonCodes).toContain("RECENT_FAILURES_PRESENT");
    expect(result.counts.failed).toBe(1);
  });

  it("returns DEGRADED for repeated RUN_LIMIT_REACHED backlog pressure", () => {
    const result = assess([
      run({ outcome: "RUN_LIMIT_REACHED", completedAt: shift(NOW, -60) }),
      run({ outcome: "RUN_LIMIT_REACHED", completedAt: shift(NOW, -300) }),
    ]);
    expect(result.assessment).toBe("DEGRADED");
    expect(result.reasonCodes).toContain("REPEATED_RUN_LIMIT_REACHED");

    // One alone is ordinary: the bound did its job.
    expect(assessmentOf([run({ outcome: "RUN_LIMIT_REACHED" })])).toBe("HEALTHY");
  });

  it("returns STALE when the latest terminal run is outside the window", () => {
    const result = assess([run({ completedAt: shift(NOW, -FRESH - 1) })]);
    expect(result.assessment).toBe("STALE");
    expect(result.reasonCodes).toEqual(["LATEST_RUN_STALE"]);
    expect(result.ageSeconds).toBe(FRESH + 1);

    // Exactly at the boundary is still fresh.
    expect(assessmentOf([run({ completedAt: shift(NOW, -FRESH) })])).toBe("HEALTHY");
  });

  it("returns FAILED when the latest terminal run failed or was abandoned", () => {
    const failed = assess([run({ status: "FAILED", outcome: "FAILED", exitCode: 1 })]);
    expect(failed.assessment).toBe("FAILED");
    expect(failed.reasonCodes).toContain("LATEST_RUN_FAILED");

    const abandoned = assess([
      run({ status: "ABANDONED", outcome: null, exitCode: null, issueCodes: ["WORKER_RUN_STALE"] }),
    ]);
    expect(abandoned.assessment).toBe("FAILED");
    expect(abandoned.reasonCodes).toContain("LATEST_RUN_ABANDONED");
    expect(abandoned.counts.abandoned).toBe(1);
  });

  it("returns FAILED on a consecutive-failure streak even when the latest is coherent", () => {
    // Latest coherent, but the two before it failed — the streak rule looks from the
    // newest backwards, so a coherent latest breaks the streak.
    const broken = assess([
      run({ completedAt: shift(NOW, -60) }),
      run({ status: "FAILED", outcome: "FAILED", exitCode: 1, completedAt: shift(NOW, -120) }),
      run({ status: "FAILED", outcome: "FAILED", exitCode: 1, completedAt: shift(NOW, -180) }),
    ]);
    expect(broken.assessment).toBe("DEGRADED");

    // Two failures at the head reach the default threshold.
    const streak = assess([
      run({ status: "FAILED", outcome: "FAILED", exitCode: 1, completedAt: shift(NOW, -60) }),
      run({ status: "ABANDONED", outcome: null, exitCode: null, completedAt: shift(NOW, -120) }),
    ]);
    expect(streak.assessment).toBe("FAILED");
    expect(streak.reasonCodes).toContain("CONSECUTIVE_FAILURES");
    expect(DEFAULT_FAILURE_STREAK).toBe(2);
  });

  it("honours an explicit failure-streak threshold", () => {
    const runs = [
      run({ status: "FAILED", outcome: "FAILED", exitCode: 1, completedAt: shift(NOW, -60) }),
    ];
    expect(assessmentOf(runs, { failureStreakThreshold: 1 })).toBe("FAILED");
    expect(assess(runs, { failureStreakThreshold: 5 }).reasonCodes).not.toContain(
      "CONSECUTIVE_FAILURES",
    );
  });

  it("applies precedence NO_HISTORY > FAILED > STALE > DEGRADED > HEALTHY", () => {
    // A failed run that is ALSO stale and ALSO carries issues: FAILED wins, because
    // the last thing the worker did was break.
    const failedStaleIssues = assess([
      run({
        status: "FAILED",
        outcome: "FAILED",
        exitCode: 1,
        issueCodes: ["MONITORING_HOOK_FAILURE"],
        completedAt: shift(NOW, -FRESH - 500),
      }),
    ]);
    expect(failedStaleIssues.assessment).toBe("FAILED");

    // A stale run that ALSO carries issues: STALE wins — freshness is the first
    // thing to fix, and an out-of-window run says nothing current about degradation.
    const staleIssues = assess([
      run({ issueCodes: ["MONITORING_HOOK_FAILURE"], completedAt: shift(NOW, -FRESH - 500) }),
    ]);
    expect(staleIssues.assessment).toBe("STALE");
  });

  it("uses the supplied assessment instant, not a real clock", () => {
    const record = run({ completedAt: shift(NOW, -60) });
    // Fresh as of NOW; stale as of two hours later. Same data, different answer.
    expect(assessmentOf([record], { assessedAt: NOW })).toBe("HEALTHY");
    expect(assessmentOf([record], { assessedAt: shift(NOW, 7_200) })).toBe("STALE");
    expect(assess([record], { assessedAt: NOW }).assessedAt).toBe(NOW);
  });

  it("refuses a run that completed after the assessment instant", () => {
    // Not clamped to age zero: assessing health as of a moment before a run
    // finished is a contradiction, and hiding it would mask a clock or ordering bug.
    expect(() => assess([run({ completedAt: shift(NOW, 1) })])).toThrow(RangeError);
  });

  it("orders terminal runs deterministically regardless of input order", () => {
    const newest = run({ outcome: "NO_WORK", completedAt: shift(NOW, -60) });
    const older = run({ status: "FAILED", outcome: "FAILED", exitCode: 1, completedAt: shift(NOW, -600) });
    const forwards = assess([newest, older]);
    const backwards = assess([older, newest]);
    expect(forwards.mostRecentCycleId).toBe(newest.cycleId);
    expect(backwards.mostRecentCycleId).toBe(newest.cycleId);
    expect(forwards.assessment).toBe(backwards.assessment);

    // Ties break on identity, so a shared instant still yields one stable answer.
    const at = shift(NOW, -60);
    const a = run({ cycleId: "cyc-AAA", completedAt: at });
    const b = run({ cycleId: "cyc-BBB", completedAt: at });
    expect(assess([a, b]).mostRecentCycleId).toBe("cyc-BBB");
    expect(assess([b, a]).mostRecentCycleId).toBe("cyc-BBB");
  });

  it("declares its scope and never claims full-system health", () => {
    const result = assess([run()]);
    expect(result.scope).toBe("PUBLICATION_WORKER_ONLY");
    const text = JSON.stringify(result);
    for (const forbidden of ["database", "registrar", "resolver", "checkout", "stripe"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("exposes no database internals or sensitive material", () => {
    const result = assess([
      run({ issueCodes: ["MONITORING_HOOK_FAILURE", "CLEANUP_FAILURE"] }),
    ]);
    const text = JSON.stringify(result);
    for (const forbidden of [
      '"id"',
      "mysql://",
      "DATABASE_URL",
      "Bearer",
      "authorization",
      "mon:lock:",
      "contentHash",
      "payload",
      "ECONNREFUSED",
      "at Object.",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
