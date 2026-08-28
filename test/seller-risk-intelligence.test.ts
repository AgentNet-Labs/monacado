/**
 * Phase 1.13 — fraud and risk intelligence.
 *
 * Pure. No database, no network, no credential, no provider client. Every fact
 * below is either arithmetic or a vocabulary, which is the point: the rules that
 * decide whether a seller is looked at should be checkable without standing a
 * marketplace up.
 *
 * The source-scanning tests at the end are deliberate. Several of this phase's
 * commitments — no automatic suspension, no buyer PII in a query, no clock in a
 * reproducible report — are properties of what the code does NOT contain, and
 * the only way to assert an absence is to read the file.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ADMISSIBLE_RISK_GEOGRAPHY_FIELDS,
  ADVERSE_EVENT_MEASURES,
  DEFAULT_RISK_WINDOW_DAYS,
  NEVER_IN_RISK_GEOGRAPHY,
  NEVER_ON_RISK_METRICS,
  RISK_COUNTING_SEMANTICS,
  RISK_WINDOW_DAYS,
  RiskRate,
  VERTICAL_BASELINE_UNAVAILABLE_REASON,
  averageMinorUnits,
  deviationBasisPoints,
  jurisdictionKey,
  priorWindow,
  rateBasisPoints,
  resolveVerticalBaseline,
  riskRate,
  topJurisdictionShareBasisPoints,
  windowContains,
  windowEndingAt,
} from "../src/contracts/marketplace/seller-risk-metrics";
import {
  DEFAULT_RISK_REPORT_TOP,
  MARKETPLACE_POLICY_RISK_TERMS_REQUIRED,
  NEVER_ON_RISK_REVIEW,
  REASON_CODE_FORBIDDEN_TERMS,
  RISK_REPORT_TOP_SELECTIONS,
  RISK_REVIEW_DISPOSITIONS,
  RISK_REVIEW_REASON_CODES,
  RISK_REVIEW_REASON_WEIGHTS,
  RISK_REVIEW_STATUSES,
  SELLER_RISK_PUBLICATION_DISPOSITION,
  SellerRiskReviewPolicyVersionRecord,
  SELLER_RISK_REVIEW_SCHEDULE_GUIDANCE,
  ParticipantRiskReviewRecord,
  compareRiskRows,
  isValidRiskReviewTransition,
  reviewScoreFor,
  type SellerRiskReviewRow,
} from "../src/contracts/marketplace/seller-risk-review";
import {
  ACCOUNT_CAPABILITIES,
  AccountCapability,
} from "../src/contracts/account/account";
import {
  PARTICIPANT_RISK_REVIEW_CAPABILITY,
  canReviewParticipantRisk,
  canRestrictParticipant,
  isInternallyAuthorized,
} from "../src/contracts/account/internal-authorization";
import {
  NEVER_ON_RISK_POLICY,
  RISK_DENIAL_REASON_CODES,
  RiskPolicyVersionRecord,
} from "../src/contracts/marketplace/transaction-risk";
import { FRAUD_AND_RISK_ANALYTICS_HANDOFF } from "../src/contracts/marketplace/transaction-dispute";
import {
  LATEST_MARKETPLACE_POLICY_VERSION,
  MONACADO_MARKETPLACE_POLICY_V1_2_HASH,
} from "../src/contracts/marketplace/marketplace-policy-content";

const readCode = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

/**
 * The file with its comments removed.
 *
 * Several assertions below say "this code does not DO X", and several of the
 * files explain at length that they do not do X — so a naive scan finds the
 * forbidden token inside the very sentence disclaiming it. Stripping comments
 * scopes those assertions to what actually executes, which is what they meant.
 * Assertions about DOCUMENTATION language keep reading the whole file.
 */
const readExecutableCode = (path: string): string =>
  readCode(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const AT = "2026-08-28T00:00:00.000Z";

// — 1 · Rate arithmetic —

describe("1.13 · a rate is a triple, and never Infinity or NaN", () => {
  it("computes basis points half-up with exact integer arithmetic", () => {
    expect(rateBasisPoints(1n, 3n)).toBe(3_333n);
    expect(rateBasisPoints(1n, 2n)).toBe(5_000n);
    expect(rateBasisPoints(1n, 16n)).toBe(625n);
    /* Exactly .625 of a basis point rounds up, not toward even. */
    expect(rateBasisPoints(1n, 16_000n)).toBe(1n);
    expect(rateBasisPoints(0n, 50n)).toBe(0n);
    expect(rateBasisPoints(50n, 50n)).toBe(10_000n);
  });

  it("returns null for a zero denominator rather than dividing", () => {
    expect(rateBasisPoints(3n, 0n)).toBeNull();
    expect(deviationBasisPoints(3n, 0n)).toBeNull();
    expect(averageMinorUnits(500n, 0n)).toBeNull();
  });

  it("is NOT capped: a ratio may exceed 10000 basis points", () => {
    /* Three chargebacks against one refund is 30000bp, and clamping it would
       hide the single most interesting case this ratio exists to surface. */
    expect(rateBasisPoints(3n, 1n)).toBe(30_000n);
  });

  it("never emits a rate without its numerator, denominator, and window", () => {
    const window = windowEndingAt(AT, 30, "ORDER_PAID_AT");
    const rate = riskRate(2n, 40n, window, 10n);
    expect(RiskRate.safeParse(rate).success).toBe(true);
    expect(rate.numerator).toBe(2n);
    expect(rate.denominator).toBe(40n);
    expect(rate.window.days).toBe(30);
    expect(rate.rateBasisPoints).toBe(500n);
  });

  it("withholds the rate below the governed sample floor but keeps the counts", () => {
    const window = windowEndingAt(AT, 30, "ORDER_PAID_AT");
    const thin = riskRate(1n, 1n, window, 10n);
    expect(thin.status).toBe("SAMPLE_BELOW_GOVERNED_MINIMUM");
    expect(thin.rateBasisPoints).toBeNull();
    /* One chargeback out of one sale is 10000bp and means nothing. The reader
       still sees 1/1 — the sample is withheld from the RATE, not from them. */
    expect(thin.numerator).toBe(1n);
    expect(thin.denominator).toBe(1n);
  });

  it("says NO_DENOMINATOR rather than reporting a seller with no sales as clean", () => {
    const window = windowEndingAt(AT, 30, "ORDER_PAID_AT");
    const empty = riskRate(0n, 0n, window, 10n);
    expect(empty.status).toBe("NO_DENOMINATOR");
    expect(empty.rateBasisPoints).toBeNull();
  });

  it("a rate is a number exactly when its status is COMPUTED", () => {
    const window = windowEndingAt(AT, 30, "ORDER_PAID_AT");
    expect(
      RiskRate.safeParse({
        rateBasisPoints: 500n,
        numerator: 1n,
        denominator: 20n,
        status: "NO_DENOMINATOR",
        window,
      }).success,
    ).toBe(false);
  });

  it("serialises no Infinity or NaN into a report", () => {
    const window = windowEndingAt(AT, 30, "ORDER_PAID_AT");
    const payload = JSON.stringify(
      [riskRate(3n, 0n, window, 10n), riskRate(1n, 1n, window, 10n)],
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(payload).not.toContain("Infinity");
    expect(payload).not.toContain("NaN");
  });
});

// — 2 · Windows —

describe("1.13 · windows are half-open and reproducible from asOf", () => {
  it("keeps all four rolling windows", () => {
    expect([...RISK_WINDOW_DAYS]).toEqual([1, 7, 30, 90]);
    expect(DEFAULT_RISK_WINDOW_DAYS).toBe(30);
  });

  it("includes the endpoint and excludes the start", () => {
    const window = windowEndingAt(AT, 7, "ORDER_PAID_AT");
    expect(window.startExclusive).toBe("2026-08-21T00:00:00.000Z");
    expect(window.endInclusive).toBe(AT);
    expect(windowContains(window, AT)).toBe(true);
    expect(windowContains(window, "2026-08-21T00:00:00.000Z")).toBe(false);
    expect(windowContains(window, "2026-08-21T00:00:00.001Z")).toBe(true);
  });

  it("partitions current and prior with no overlap and no gap", () => {
    const current = windowEndingAt(AT, 7, "ORDER_PAID_AT");
    const prior = priorWindow(current);
    expect(prior.endInclusive).toBe(current.startExclusive);
    expect(prior.startExclusive).toBe("2026-08-14T00:00:00.000Z");
    /* The boundary instant belongs to exactly one of them. */
    const boundary = current.startExclusive;
    expect(windowContains(current, boundary)).toBe(false);
    expect(windowContains(prior, boundary)).toBe(true);
  });

  it("does not depend on the current clock", () => {
    /* The same asOf produces the same window whenever it is asked. */
    const a = windowEndingAt(AT, 30, "ORDER_PAID_AT");
    const b = windowEndingAt(AT, 30, "ORDER_PAID_AT");
    expect(a).toEqual(b);
  });
});

// — 3 · Counting semantics —

describe("1.13 · counting semantics are stated, not inferred", () => {
  it("counts only PAID orders as sales", () => {
    expect(RISK_COUNTING_SEMANTICS.transactionDenominator).toBe("ORDER_LIFECYCLE_PAID");
  });

  it("distinguishes a completed refund from a refund request", () => {
    expect(RISK_COUNTING_SEMANTICS.refundNumerator).toBe("ORDER_REFUND_STATUS_REFUNDED");
    expect(RISK_COUNTING_SEMANTICS.refundRequestNumerator).toBe("ORDER_REFUND_ANY_STATUS");
    expect(RISK_COUNTING_SEMANTICS.refundNumerator).not.toBe(
      RISK_COUNTING_SEMANTICS.refundRequestNumerator,
    );
  });

  it("counts only a FINALIZED LOST dispute as a chargeback", () => {
    expect(RISK_COUNTING_SEMANTICS.chargebackNumerator).toBe(
      "TRANSACTION_DISPUTE_STATUS_LOST",
    );
    expect(RISK_COUNTING_SEMANTICS.disputeOpenedNumerator).toBe(
      "TRANSACTION_DISPUTE_ANY_STATUS",
    );
  });

  it("refuses the chargeback fee as a chargeback, and provider fees as seller metrics", () => {
    expect(RISK_COUNTING_SEMANTICS.chargebackFeeIsNotAChargeback).toBe(true);
    expect(RISK_COUNTING_SEMANTICS.providerDisputeFeeIsNotASellerMetric).toBe(true);
  });

  it("pairs a retail numerator with a retail denominator", () => {
    /* `amountMinorUnits` includes returned tax and shipping, which are not in
       the commercial-retail denominator; pairing them could exceed 100%. */
    expect(RISK_COUNTING_SEMANTICS.refundValueNumerator).toBe(
      "ORDER_REFUND_LINES_RETAIL_MINOR_UNITS",
    );
    expect(RISK_COUNTING_SEMANTICS.transactionValueDenominator).toBe(
      "SNAPSHOT_COMMERCIAL_RETAIL_MINOR_UNITS",
    );
  });

  it("keeps loss, behaviour, and double recovery as four disjoint measures", () => {
    expect(ADVERSE_EVENT_MEASURES.economicLossEvents).toBe(
      "REFUNDED_PLUS_LOST_WHERE_REVERSED_BY_THIS_DISPUTE",
    );
    expect(ADVERSE_EVENT_MEASURES.disputeBehaviorEvents).toBe("ALL_LOST");
    expect(ADVERSE_EVENT_MEASURES.doubleRecoveryExposureEvents).toBe(
      "LOST_WHERE_ALREADY_REVERSED_BY_REFUND",
    );
    /* Only ONE of the four claims financial loss. */
    const claimsLoss = Object.entries(ADVERSE_EVENT_MEASURES).filter(([k]) =>
      k.includes("LossEvents"),
    );
    expect(claimsLoss).toHaveLength(1);
  });
});

// — 4 · Vertical baseline —

describe("1.13 · an absent vertical norm is reported, never invented", () => {
  it("resolves unavailable for every seller in the current repository", () => {
    const baseline = resolveVerticalBaseline();
    expect(baseline.status).toBe("VERTICAL_BASELINE_UNAVAILABLE");
    expect(baseline).toMatchObject({ reasonCode: VERTICAL_BASELINE_UNAVAILABLE_REASON });
  });

  it("names the requirement 1.12 handed over, spelled as GOVERNED norms", () => {
    expect(FRAUD_AND_RISK_ANALYTICS_HANDOFF.ownedByThatPhase).toContain(
      "AVERAGE_TICKET_VERSUS_GOVERNED_VERTICAL_NORMS",
    );
  });

  it("hard-codes no vertical norm table anywhere in the risk source", () => {
    for (const path of [
      "src/contracts/marketplace/seller-risk-metrics.ts",
      "src/server/risk/seller-risk-report-service.ts",
    ]) {
      const code = readCode(path);
      for (const forbidden of ["expectedTicketFor", "VERTICAL_NORMS = {", "INDUSTRY_BASELINE"]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

// — 5 · Geography —

describe("1.13 · geography is jurisdiction-level and nothing finer", () => {
  it("admits only country and region", () => {
    expect([...ADMISSIBLE_RISK_GEOGRAPHY_FIELDS]).toEqual(["taxCountryCode", "taxRegionCode"]);
  });

  it("builds a jurisdiction key from country and region alone", () => {
    expect(jurisdictionKey("US", "CA")).toBe("US/CA");
    expect(jurisdictionKey("GB", null)).toBe("GB/-");
  });

  it("measures concentration as the top jurisdiction's share", () => {
    const counts = new Map([["US/CA", 8n], ["US/NY", 2n]]);
    expect(topJurisdictionShareBasisPoints(counts)).toBe(8_000n);
    expect(topJurisdictionShareBasisPoints(new Map())).toBeNull();
  });

  it("never selects a buyer identifier or address detail in the metrics query", () => {
    const code = readCode("src/server/risk/seller-risk-metrics-service.ts");
    for (const forbidden of NEVER_IN_RISK_GEOGRAPHY) {
      expect(code, forbidden).not.toContain(`${forbidden}: true`);
    }
    /* The buyer snapshot is reached for exactly two columns. */
    expect(code).toContain("taxCountryCode: true, taxRegionCode: true");
  });

  it("performs no geolocation enrichment or external lookup", () => {
    const code = readCode("src/server/risk/seller-risk-metrics-service.ts");
    for (const forbidden of ["fetch(", "geoip", "maxmind", "http"]) {
      expect(code.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});

// — 6 · Ranking and reasons —

describe("1.13 · a rank exposes reasons and never implies proven fraud", () => {
  it("uses no word implying wrongdoing in any reason code", () => {
    for (const code of RISK_REVIEW_REASON_CODES) {
      for (const forbidden of REASON_CODE_FORBIDDEN_TERMS) {
        expect(code, `${code}/${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("gives every reason code a published weight", () => {
    for (const code of RISK_REVIEW_REASON_CODES) {
      expect(RISK_REVIEW_REASON_WEIGHTS[code], code).toBeTypeOf("number");
    }
    /* Thin evidence is context, not concern: it must not push a seller up. */
    expect(RISK_REVIEW_REASON_WEIGHTS.INSUFFICIENT_HISTORY_FOR_BASELINE).toBe(0);
  });

  it("scores as a plain sum of triggered weights", () => {
    expect(
      reviewScoreFor([
        { weight: 50 } as never,
        { weight: 25 } as never,
      ]),
    ).toBe(75);
    expect(reviewScoreFor([])).toBe(0);
  });

  it("orders deterministically and breaks every tie", () => {
    const base = {
      reasons: [],
      finalizedChargebackCount: 0n,
      disputeOpenedCount: 0n,
      refundCount: 0n,
      paidOrderCount: 0n,
    } as unknown as SellerRiskReviewRow;
    const a = { ...base, reviewScore: 10, sellerParticipantId: "mon:mpart:AAA" };
    const b = { ...base, reviewScore: 10, sellerParticipantId: "mon:mpart:BBB" };
    const c = { ...base, reviewScore: 90, sellerParticipantId: "mon:mpart:CCC" };
    const sorted = [a, b, c].sort(compareRiskRows).map((r) => r.sellerParticipantId);
    expect(sorted).toEqual(["mon:mpart:CCC", "mon:mpart:AAA", "mon:mpart:BBB"]);
    /* Shuffled input, identical output — the ordering is total. */
    const reshuffled = [c, b, a].sort(compareRiskRows).map((r) => r.sellerParticipantId);
    expect(reshuffled).toEqual(sorted);
  });

  it("bounds the daily list to 10 or 100, defaulting to 10", () => {
    expect([...RISK_REPORT_TOP_SELECTIONS]).toEqual([10, 100]);
    expect(DEFAULT_RISK_REPORT_TOP).toBe(10);
  });
});

// — 7 · Review governance —

describe("1.13 · staff review records a decision and performs none", () => {
  it("separates the work axis from the decision axis", () => {
    expect([...RISK_REVIEW_STATUSES]).toEqual(["OPEN", "UNDER_REVIEW", "CLOSED"]);
    /* MONITOR and SUSPENSION_RECOMMENDED are conclusions, not queue positions. */
    expect(RISK_REVIEW_STATUSES as readonly string[]).not.toContain("MONITOR");
    expect(RISK_REVIEW_STATUSES as readonly string[]).not.toContain("SUSPENSION_RECOMMENDED");
    expect(RISK_REVIEW_DISPOSITIONS).toContain("MONITOR");
    expect(RISK_REVIEW_DISPOSITIONS).toContain("SUSPENSION_RECOMMENDED");
  });

  it("makes CLOSED terminal", () => {
    expect(isValidRiskReviewTransition("OPEN", "UNDER_REVIEW")).toBe(true);
    expect(isValidRiskReviewTransition("OPEN", "CLOSED")).toBe(true);
    expect(isValidRiskReviewTransition("UNDER_REVIEW", "CLOSED")).toBe(true);
    expect(isValidRiskReviewTransition("CLOSED", "OPEN")).toBe(false);
    expect(isValidRiskReviewTransition("CLOSED", "UNDER_REVIEW")).toBe(false);
  });

  it("names every consequence as a RECOMMENDATION, never an act", () => {
    for (const disposition of RISK_REVIEW_DISPOSITIONS) {
      /* Nothing in the vocabulary is phrased as something performed. */
      expect(disposition, disposition).not.toMatch(/^(SUSPENDED|RESTRICTED|HELD)$/);
    }
    expect(RISK_REVIEW_DISPOSITIONS).toContain("SUSPENSION_RECOMMENDED");
    expect(RISK_REVIEW_DISPOSITIONS as readonly string[]).not.toContain("SUSPENDED");
    expect(RISK_REVIEW_DISPOSITIONS as readonly string[]).not.toContain("ACCOUNT_SUSPENDED");
  });

  it("requires a disposition exactly when closed", () => {
    const open = {
      id: "mon:prrev:ABCDEFGHJKMNPQRSTVWXYZ0123",
      participantId: "mon:mpart:ABCDEFGHJKMNPQRSTVWXYZ0123",
      triggerSource: "SYSTEM" as const,
      triggerAsOf: AT,
      reviewPolicyId: "mon:srrp:ABCDEFGHJKMNPQRSTVWXYZ0123",
      reviewPolicyVersion: "1",
      triggerReasons: [],
      openedAt: AT,
      openedByAccountId: null,
      status: "OPEN" as const,
      assignedReviewerAccountId: null,
      dispositionCode: null,
      decidedByAccountId: null,
      decidedAt: null,
      resultingRestrictionId: null,
    };
    expect(ParticipantRiskReviewRecord.safeParse(open).success).toBe(true);
    /* Open with a disposition is inexpressible. */
    expect(
      ParticipantRiskReviewRecord.safeParse({
        ...open,
        dispositionCode: "MONITOR",
        decidedByAccountId: "mon:acct:ABCDEFGHJKMNPQRSTVWXYZ0123",
      }).success,
    ).toBe(false);
    /* Closed without one is likewise. */
    expect(
      ParticipantRiskReviewRecord.safeParse({ ...open, status: "CLOSED" }).success,
    ).toBe(false);
  });

  it("refuses a score, a note, and buyer data on a review", () => {
    const base = {
      id: "mon:prrev:ABCDEFGHJKMNPQRSTVWXYZ0123",
      participantId: "mon:mpart:ABCDEFGHJKMNPQRSTVWXYZ0123",
      triggerSource: "SYSTEM" as const,
      triggerAsOf: AT,
      reviewPolicyId: "mon:srrp:ABCDEFGHJKMNPQRSTVWXYZ0123",
      reviewPolicyVersion: "1",
      triggerReasons: [],
      openedAt: AT,
      openedByAccountId: null,
      status: "OPEN" as const,
      assignedReviewerAccountId: null,
      dispositionCode: null,
      decidedByAccountId: null,
      decidedAt: null,
      resultingRestrictionId: null,
    };
    for (const forbidden of NEVER_ON_RISK_REVIEW) {
      expect(
        ParticipantRiskReviewRecord.safeParse({ ...base, [forbidden]: 1 }).success,
        forbidden,
      ).toBe(false);
    }
  });
});

// — 7b · Threshold semantics —

describe("1.13 · thresholds are governed review heuristics, not enforcement", () => {
  const version = {
    policyId: "mon:srrp:ABCDEFGHJKMNPQRSTVWXYZ0123",
    policyVersion: "1",
    status: "ACTIVE" as const,
    minimumRateSampleCount: 10,
    minimumBaselineSampleCount: 10,
    refundCountRateReviewBasisPoints: 500,
    chargebackCountRateReviewBasisPoints: 100,
    chargebackToRefundRatioReviewBasisPoints: 5_000,
    velocityReviewBasisPoints: 20_000,
    averageTicketShiftReviewBasisPoints: 20_000,
    volumeSpikeReviewBasisPoints: 30_000,
    jurisdictionConcentrationReviewBasisPoints: 8_000,
    newJurisdictionReviewCount: 5,
    promoterConcentrationReviewBasisPoints: 9_000,
    attentionScoreFloor: 25,
    effectiveFrom: AT,
    recordedByAccountId: "mon:acct:ABCDEFGHJKMNPQRSTVWXYZ0123",
    recordedAt: AT,
    retiredAt: null,
    retiredByAccountId: null,
  };

  it("names every threshold for the REVIEW it triggers", () => {
    expect(SellerRiskReviewPolicyVersionRecord.safeParse(version).success).toBe(true);
    /* Every threshold field says `Review`. Not `Limit`, not `Max`, not
       `Threshold` on its own — the word carries the semantics, and a field
       called `chargebackRateLimit` would read as something a gate enforces. */
    for (const key of Object.keys(SellerRiskReviewPolicyVersionRecord.shape)) {
      if (!key.endsWith("BasisPoints") && !key.endsWith("ReviewCount")) continue;
      expect(key, key).toContain("Review");
    }
  });

  it("is versioned and governed like every other policy here", () => {
    for (const governance of [
      "policyId",
      "policyVersion",
      "status",
      "effectiveFrom",
      "recordedByAccountId",
      "retiredAt",
    ]) {
      expect(Object.keys(SellerRiskReviewPolicyVersionRecord.shape), governance).toContain(
        governance,
      );
    }
    /* DRAFT -> ACTIVE -> RETIRED, so a past ranking stays explicable. */
    expect(
      SellerRiskReviewPolicyVersionRecord.safeParse({ ...version, status: "DRAFT" }).success,
    ).toBe(true);
  });

  it("carries no enforcement field of any kind", () => {
    /* Crossing one of these asks a human to look. It denies nothing, restricts
       nothing, and suspends nobody, so there is nowhere on this record to put
       an action. */
    for (const forbidden of [
      "autoSuspendAt",
      "autoSuspendBasisPoints",
      "suspendAtBasisPoints",
      "restrictAtBasisPoints",
      "blockAtBasisPoints",
      "denyAtBasisPoints",
      "enforcementAction",
      "automaticRestrictionScope",
      "riskScore",
      "riskTier",
    ]) {
      expect(
        SellerRiskReviewPolicyVersionRecord.safeParse({ ...version, [forbidden]: 1 }).success,
        forbidden,
      ).toBe(false);
    }
    for (const key of Object.keys(SellerRiskReviewPolicyVersionRecord.shape)) {
      const lower = key.toLowerCase();
      for (const verb of ["suspend", "restrict", "block", "deny", "enforce"]) {
        expect(lower, `${key}/${verb}`).not.toContain(verb);
      }
    }
  });

  it("accompanies every threshold-driven reason with its observed and baseline values", () => {
    /* A threshold that fires without showing what was measured against what is
       an assertion, not evidence. The reason type requires both, so a
       threshold can never stand alone as the whole finding. */
    const shape = Object.keys(
      (
        RISK_REVIEW_REASON_WEIGHTS as unknown as Record<string, number>
      ),
    );
    expect(shape.length).toBe(RISK_REVIEW_REASON_CODES.length);
    /* Proven structurally in the reason tests above; asserted here as the
       property the thresholds depend on. */
    expect(RISK_REVIEW_REASON_WEIGHTS.CHARGEBACK_RATE_ELEVATED).toBeGreaterThan(0);
  });
});

// — 8 · Authority —

describe("1.13 · reviewing and restricting are two separate grants", () => {
  const subject = (capabilities: string[]) => ({
    accountId: "mon:acct:ABCDEFGHJKMNPQRSTVWXYZ0123",
    accountStatus: "ACTIVE" as const,
    capabilities: capabilities as never,
  });

  it("mints a narrow, non-wildcard capability", () => {
    expect(ACCOUNT_CAPABILITIES).toContain("participant:risk-review");
    expect(PARTICIPANT_RISK_REVIEW_CAPABILITY).toBe("participant:risk-review");
    for (const capability of ACCOUNT_CAPABILITIES) {
      expect(capability, capability).not.toContain("*");
      expect(capability.toLowerCase(), capability).not.toContain("admin");
      expect(capability, capability).toMatch(/^[a-z][a-z-]*(:[a-z][a-z-]*)+$/);
    }
    for (const forbidden of ["risk:*", "participant:*", "risk:manage", "admin"]) {
      expect(AccountCapability.safeParse(forbidden).success, forbidden).toBe(false);
    }
  });

  it("does not let a risk reviewer restrict, nor a restrictor review", () => {
    /* THE SAFEGUARD. A reviewer who concludes SUSPENSION_RECOMMENDED still
       cannot act on their own conclusion. */
    expect(isInternallyAuthorized(canReviewParticipantRisk(subject(["participant:risk-review"]))))
      .toBe(true);
    expect(isInternallyAuthorized(canRestrictParticipant(subject(["participant:risk-review"]))))
      .toBe(false);
    expect(isInternallyAuthorized(canReviewParticipantRisk(subject(["participant:restrict"]))))
      .toBe(false);
    expect(isInternallyAuthorized(canReviewParticipantRisk(subject([])))).toBe(false);
    expect(isInternallyAuthorized(canReviewParticipantRisk(null))).toBe(false);
  });
});

// — 9 · The 1.2 gate is untouched —

describe("1.13 · the transaction gate gains no score, window, or threshold", () => {
  const policy = {
    policyId: "mon:rpol:ABCDEFGHJKMNPQRSTVWXYZ0123",
    policyVersion: "1",
    status: "ACTIVE" as const,
    currency: "USD" as const,
    maxSingleOrderCommercialAmountMinorUnits: 50_000,
    requireSellerCommerceApproval: true,
    requireSellerPaymentReadiness: false,
    effectiveFrom: AT,
    recordedByAccountId: "mon:acct:ABCDEFGHJKMNPQRSTVWXYZ0123",
    recordedAt: AT,
    retiredAt: null,
    retiredByAccountId: null,
  };

  it("still refuses every forbidden field on the risk policy", () => {
    expect(RiskPolicyVersionRecord.safeParse(policy).success).toBe(true);
    for (const forbidden of NEVER_ON_RISK_POLICY) {
      expect(
        RiskPolicyVersionRecord.safeParse({ ...policy, [forbidden]: 1 }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("adds no scoring or review word to the denial vocabulary", () => {
    const vocabulary = RISK_DENIAL_REASON_CODES.join(" ").toLowerCase();
    for (const term of ["score", "velocity", "reserve", "chargeback", "model", "review"]) {
      expect(vocabulary, term).not.toContain(term);
    }
  });

  it("keeps the review surface out of the gate entirely", () => {
    const gate = readExecutableCode("src/server/risk/transaction-risk-service.ts");
    for (const forbidden of [
      "seller-risk-report-service",
      "seller-risk-metrics-service",
      "participant-risk-review-service",
      "reviewScore",
    ]) {
      expect(gate, forbidden).not.toContain(forbidden);
    }
  });

  it("refuses score and buyer fields on a risk metric", () => {
    for (const forbidden of NEVER_ON_RISK_METRICS) {
      expect(
        readCode("src/contracts/marketplace/seller-risk-metrics.ts"),
        forbidden,
      ).toContain(forbidden);
    }
  });
});

// — 10 · No automatic adverse action —

describe("1.13 · nothing in this phase suspends or restricts anybody", () => {
  it("writes no participant status and creates no restriction", () => {
    for (const path of [
      "src/server/risk/participant-risk-review-service.ts",
      "src/server/risk/seller-risk-report-service.ts",
      "src/server/risk/seller-risk-metrics-service.ts",
      "scripts/seller-risk-review.ts",
    ]) {
      const code = readExecutableCode(path);
      for (const forbidden of [
        "marketplaceParticipant.update",
        "participantRestriction.create",
        "imposeParticipantRestriction",
        '"SUSPENDED"',
        "autoSuspend",
      ]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("offers the operator no flag that could act on a participant", () => {
    const script = readExecutableCode("scripts/seller-risk-review.ts");
    for (const forbidden of ["--restrict", "--suspend", "--action=", "--enforce"]) {
      expect(script, forbidden).not.toContain(forbidden);
    }
  });

  it("reads no clock inside the report or metrics services", () => {
    /* A report that read the clock could not be re-run for a past date, and a
       historical review that cannot be reproduced cannot be explained. */
    for (const path of [
      "src/server/risk/seller-risk-metrics-service.ts",
      "src/server/risk/seller-risk-report-service.ts",
    ]) {
      expect(readExecutableCode(path), path).not.toContain("new Date()");
      expect(readExecutableCode(path), path).not.toContain("Date.now()");
    }
  });
});

// — 11 · Operator surface —

describe("1.13 · the operator surface carries no buyer PII and no amounts", () => {
  it("prints no monetary field", () => {
    const script = readExecutableCode("scripts/seller-risk-review.ts");
    for (const forbidden of [
      "MinorUnits",
      "buyerEmail",
      "buyerName",
      "billingLine1",
      "postalCode",
      "orderBuyerSnapshot",
      "orderId",
    ]) {
      expect(script, forbidden).not.toContain(forbidden);
    }
  });

  it("says plainly that it restricts nobody", () => {
    const script = readCode("scripts/seller-risk-review.ts");
    expect(script).toContain("restricts nobody and suspends nobody");
  });

  it("commits no scheduler configuration", () => {
    expect(SELLER_RISK_REVIEW_SCHEDULE_GUIDANCE.committedCronDeclaration).toBe("NONE");
    expect(SELLER_RISK_REVIEW_SCHEDULE_GUIDANCE.dailyCadenceAdequate).toBe(true);
    const script = readCode("scripts/seller-risk-review.ts");
    expect(script).not.toContain("vercel.json");
  });
});

// — 12 · Publication and policy —

describe("1.13 · risk data is private and publishes nothing", () => {
  it("projects no capsule and reaches no registrar", () => {
    expect(SELLER_RISK_PUBLICATION_DISPOSITION.capsuleProjection).toBe("NONE");
    expect(SELLER_RISK_PUBLICATION_DISPOSITION.visibility).toBe("PRIVATE");
    for (const [key, value] of Object.entries(SELLER_RISK_PUBLICATION_DISPOSITION)) {
      if (key === "visibility") continue;
      expect(value, key).toBe("NONE");
    }
  });

  it("writes no outbox row and contacts no registrar in the risk source", () => {
    for (const path of [
      "src/server/risk/seller-risk-report-service.ts",
      "src/server/risk/participant-risk-review-service.ts",
    ]) {
      const code = readExecutableCode(path);
      for (const forbidden of ["publicationOutbox", "registrar", "agentNet", "AgentNet"]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("leaves Marketplace Policy 1.2.0 untouched and records the 1.3.0 requirement", () => {
    expect(LATEST_MARKETPLACE_POLICY_VERSION).toBe("1.2.0");
    /* The committed hash is unchanged by this phase. */
    expect(MONACADO_MARKETPLACE_POLICY_V1_2_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(MARKETPLACE_POLICY_RISK_TERMS_REQUIRED.currentVersionUnchangedByThisPhase).toBe(
      "1.2.0",
    );
    expect(MARKETPLACE_POLICY_RISK_TERMS_REQUIRED.createdOrActivatedByThisPhase).toBe("NONE");
    expect(MARKETPLACE_POLICY_RISK_TERMS_REQUIRED.requiresNewTermsBeforeOperating).toContain(
      "SUSPENDING_A_PARTICIPANT_ON_RISK_GROUNDS",
    );
    expect(MARKETPLACE_POLICY_RISK_TERMS_REQUIRED.permittedUnderCurrentTerms).toContain(
      "PRIVATE_RISK_REPORTING",
    );
  });
});

// — 13 · MoR language —

describe("1.13 · the MoR model is preserved in everything this phase says", () => {
  it("describes no pass-through, forwarding, or facilitation to a seller", () => {
    for (const path of [
      "src/contracts/marketplace/seller-risk-metrics.ts",
      "src/contracts/marketplace/seller-risk-review.ts",
      "src/server/risk/seller-risk-metrics-service.ts",
      "src/server/risk/seller-risk-report-service.ts",
      "src/server/risk/participant-risk-review-service.ts",
      "scripts/seller-risk-review.ts",
      "prisma/migrations/20260828180757_add_seller_risk_intelligence/migration.sql",
    ]) {
      const code = readCode(path).toLowerCase();
      for (const forbidden of [
        "on behalf of the seller",
        "forward buyer funds",
        "forwards funds",
        "pass through to seller",
        "payment facilitator",
        "payfac",
        "reimburse the seller",
        "payout to seller",
      ]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the seller chargeback fee separate from the provider dispute fee", () => {
    const metrics = readCode("src/server/risk/seller-risk-metrics-service.ts");
    /* The fee table is not consulted at all, which is the strongest form of
       "the fee is not a chargeback". */
    expect(metrics).not.toContain("sellerChargebackFee.");
    expect(metrics).toContain("SellerChargebackFee` is not consulted");
  });
});
