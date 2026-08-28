/**
 * `risk:review` — the daily seller risk review (Phase 1.13). SERVER ONLY.
 *
 * ```
 *   npm run risk:review                              # top 10, 30-day window, today
 *   npm run risk:review -- --top=100                 # the wider list
 *   npm run risk:review -- --as-of=2026-08-27        # reproducible historical run
 *   npm run risk:review -- --window=7 --json         # machine-readable only
 *   npm run risk:review:seller -- --seller=mon:mpart:…
 *   npm run risk:review:promoter -- --seller=… [--promoter=…]
 *   npm run risk:review:policy                       # what heuristics stand
 * ```
 *
 * ## Read-only. Every flag, every time.
 *
 * This command writes nothing, contacts no provider, restricts nobody, and
 * changes no state. It has no `--restrict`, no `--suspend`, and no `--action`
 * flag, and that absence is the design: Marketplace Policy 1.2.0 authorises
 * per-transaction risk decisions and says nothing about participant-level
 * consequences, so there is nothing here for such a flag to lawfully do. A Staff
 * member who decides to act does so through the separately-entitled restriction
 * path, deliberately, as its own act.
 *
 * ## No provider call, ever
 *
 * Every fact comes from Monacado's own rows. A risk report that had to reach
 * Stripe would stop working exactly when a credential problem made it most
 * useful.
 *
 * ## No buyer PII, and no amounts
 *
 * The report carries participant ids, counts, basis points, and bounded reason
 * codes. No name, email, address, or monetary amount appears in it — the promise
 * `refund:status` and `dispute:status` already make, and it binds harder here.
 * A risk ranking surfaces small-denominator sellers preferentially, so a
 * seller-level "aggregate" with one sale behind it IS one buyer's purchase
 * amount, printed next to a rank drawing attention to it. Magnitude survives as
 * rates and deviations, which is what a reviewer actually needs: "refunds tripled
 * against your own last fortnight" is more use than a figure in dollars.
 *
 * ## Reproducible
 *
 * `--as-of` fixes the report's exclusive upper bound. The same `--as-of` and the
 * same active heuristics version produce the same output whatever the clock
 * says, which is what lets a review opened last month be explained this month.
 */

import "dotenv/config";
import { disconnectPrisma } from "../src/server/db/client";
import {
  inspectSellerPromoterRisk,
  inspectSellerRisk,
  runDailySellerRiskReport,
} from "../src/server/risk/seller-risk-report-service";
import { readReviewPolicyVersions } from "../src/server/risk/seller-risk-review-policy-service";
import { SellerRiskError } from "../src/server/risk/seller-risk-errors";
import {
  RISK_WINDOW_DAYS,
  type RiskWindowDays,
} from "../src/contracts/marketplace/seller-risk-metrics";
import {
  DEFAULT_RISK_REPORT_TOP,
  RISK_REPORT_TOP_SELECTIONS,
  SELLER_RISK_REVIEW_SCHEDULE_GUIDANCE,
  type DailySellerRiskReport,
  type RiskReportTopSelection,
  type SellerPromoterRiskRow,
  type SellerRiskReviewRow,
} from "../src/contracts/marketplace/seller-risk-review";

export class RiskUsageError extends Error {}

export interface RiskCommandOptions {
  json: boolean;
  top: RiskReportTopSelection;
  windowDays: RiskWindowDays;
  asOf: string;
  mode: "DAILY" | "SELLER" | "PROMOTER_PAIRS" | "POLICY";
  sellerParticipantId: string | null;
  promoterParticipantId: string | null;
}

export function parseCommandOptions(
  argv: readonly string[],
  now: () => string,
): RiskCommandOptions {
  const flagValue = (prefix: string): string | null => {
    const arg = argv.find((a) => a.startsWith(prefix));
    const value = arg === undefined ? "" : arg.slice(prefix.length).trim();
    return value === "" ? null : value;
  };

  const rawTop = flagValue("--top=");
  let top: RiskReportTopSelection = DEFAULT_RISK_REPORT_TOP;
  if (rawTop !== null) {
    const parsed = Number(rawTop);
    const match = RISK_REPORT_TOP_SELECTIONS.find((t) => t === parsed);
    if (match === undefined) {
      throw new RiskUsageError(
        `--top must be one of ${RISK_REPORT_TOP_SELECTIONS.join(", ")}`,
      );
    }
    top = match;
  }

  const rawWindow = flagValue("--window=");
  let windowDays: RiskWindowDays = 30;
  if (rawWindow !== null) {
    const parsed = Number(rawWindow);
    const match = RISK_WINDOW_DAYS.find((w) => w === parsed);
    if (match === undefined) {
      throw new RiskUsageError(`--window must be one of ${RISK_WINDOW_DAYS.join(", ")}`);
    }
    windowDays = match;
  }

  /* A date or a full instant. A date means the end of that UTC day, so
     `--as-of=2026-08-27` reads as "everything through the 27th" rather than
     silently meaning midnight at its start and dropping a day of sales. */
  const rawAsOf = flagValue("--as-of=");
  let asOf = now();
  if (rawAsOf !== null) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawAsOf)) {
      asOf = `${rawAsOf}T23:59:59.999Z`;
    } else if (!Number.isNaN(Date.parse(rawAsOf))) {
      asOf = new Date(rawAsOf).toISOString();
    } else {
      throw new RiskUsageError("--as-of must be YYYY-MM-DD or an ISO-8601 instant");
    }
  }

  const sellerParticipantId = flagValue("--seller=");
  const promoterParticipantId = flagValue("--promoter=");

  const mode: RiskCommandOptions["mode"] = argv.includes("--policy")
    ? "POLICY"
    : argv.includes("--promoter-pairs")
      ? "PROMOTER_PAIRS"
      : sellerParticipantId !== null
        ? "SELLER"
        : "DAILY";

  if ((mode === "SELLER" || mode === "PROMOTER_PAIRS") && sellerParticipantId === null) {
    throw new RiskUsageError("--seller=<mon:mpart:…> is required for this view");
  }

  return {
    json: argv.includes("--json"),
    top,
    windowDays,
    asOf,
    mode,
    sellerParticipantId,
    promoterParticipantId,
  };
}

export interface RiskCommandOutcome {
  mode: RiskCommandOptions["mode"];
  asOf: string;
  windowDays: RiskWindowDays;
  report: DailySellerRiskReport | null;
  seller: SellerRiskReviewRow | null;
  promoterPairs: SellerPromoterRiskRow[] | null;
  policyVersions: unknown[] | null;
  scheduleGuidance: typeof SELLER_RISK_REVIEW_SCHEDULE_GUIDANCE;
}

const bullet = (label: string, value: unknown): string => `  ${label.padEnd(34)} ${String(value)}`;

const bp = (value: bigint | null): string => (value === null ? "-" : `${value}bp`);

function formatRate(rate: {
  rateBasisPoints: bigint | null;
  numerator: bigint;
  denominator: bigint;
  status: string;
}): string {
  /* The numerator and denominator ALWAYS print, even when the rate is withheld.
     A withheld rate with a visible sample is informative; a bare "-" is not. */
  const value = rate.rateBasisPoints === null ? rate.status : `${rate.rateBasisPoints}bp`;
  return `${value} (${rate.numerator}/${rate.denominator})`;
}

function formatReasons(reasons: readonly { code: string; observed: bigint; baseline: bigint | null }[]): string {
  if (reasons.length === 0) return "    (no review reason triggered)";
  return reasons
    .map((r) => `    ${r.code} observed=${r.observed} baseline=${r.baseline ?? "-"}`)
    .join("\n");
}

function formatSellerRow(row: SellerRiskReviewRow): string {
  return [
    `  #${row.reviewRank} ${row.sellerParticipantId}  score=${row.reviewScore}${
      row.warrantsAttention ? " ATTENTION" : ""
    }`,
    `    paid=${row.paidOrderCount} (prior ${row.paidOrderCountPriorWindow})  refunds=${row.refundCount}  disputesOpened=${row.disputeOpenedCount}  chargebacksLost=${row.finalizedChargebackCount}`,
    `    refundRate=${formatRate(row.refundCountRate)}  chargebackRate=${formatRate(row.finalizedChargebackCountRate)}`,
    `    chargebackToRefund=${formatRate(row.chargebackToRefundCountRatio)}`,
    `    loss=${row.economicLossEventCount} refundBehaviour=${row.refundBehaviorEventCount} disputeBehaviour=${row.disputeBehaviorEventCount} doubleRecovery=${row.doubleRecoveryExposureEventCount}`,
    `    ticketShift=${bp(row.averageTicketShiftBasisPoints)}  orderVelocity=${bp(row.orderVelocityBasisPoints)}  valueVelocity=${bp(row.valueVelocityBasisPoints)}  volume=${bp(row.volumeSpikeBasisPoints)}`,
    `    vertical=${row.verticalBaseline.status}`,
    `    jurisdictions=${row.distinctJurisdictionCount} new=${row.newJurisdictionCount} topShare=${bp(row.topJurisdictionShareBasisPoints)}`,
    `    promoters=${row.promoterContributorCount} topShare=${bp(row.topPromoterShareBasisPoints)}`,
    formatReasons(row.reasons),
  ].join("\n");
}

export function formatReport(outcome: RiskCommandOutcome): string {
  const lines: string[] = ["seller risk review", "", bullet("as of", outcome.asOf)];
  lines.push(bullet("window (days)", outcome.windowDays));

  if (outcome.report !== null) {
    lines.push(
      bullet("review policy", `${outcome.report.reviewPolicyVersion}`),
      bullet("sellers considered", outcome.report.sellersConsidered),
      bullet("top", outcome.report.top),
      /* Printed beside the ranking, always. A seller rollup that silently
         omitted these would understate the marketplace's dispute total. */
      bullet("unattributed disputes", outcome.report.unattributedDisputeCount),
      "",
    );
    lines.push(
      outcome.report.rows.length === 0
        ? "  (no seller had a paid order in this window)"
        : outcome.report.rows.map(formatSellerRow).join("\n\n"),
    );
    if (outcome.report.promoterAnomalies.length > 0) {
      lines.push("", "  seller x promoter anomalies");
      for (const pair of outcome.report.promoterAnomalies) {
        lines.push(
          `    ${pair.sellerParticipantId} x ${pair.promoterParticipantId} share=${bp(pair.sellerShareBasisPoints)} anomaly=${bp(pair.anomalyVersusSellerExcludingPairBasisPoints)}`,
        );
      }
    }
  }

  if (outcome.seller !== null) lines.push("", formatSellerRow(outcome.seller));

  if (outcome.promoterPairs !== null) {
    lines.push("", "  seller x promoter");
    if (outcome.promoterPairs.length === 0) lines.push("    (no promoted sales in this window)");
    for (const pair of outcome.promoterPairs) {
      lines.push(
        `    ${pair.promoterParticipantId} orders=${pair.paidOrderCount} refundRate=${formatRate(pair.refundCountRate)} chargebackRate=${formatRate(pair.finalizedChargebackCountRate)} share=${bp(pair.sellerShareBasisPoints)} anomaly=${bp(pair.anomalyVersusSellerExcludingPairBasisPoints)}`,
      );
    }
  }

  if (outcome.policyVersions !== null) {
    lines.push("", bullet("recorded versions", outcome.policyVersions.length));
  }

  lines.push(
    "",
    bullet("recommended cron", SELLER_RISK_REVIEW_SCHEDULE_GUIDANCE.recommendedCron),
    bullet("committed cron", SELLER_RISK_REVIEW_SCHEDULE_GUIDANCE.committedCronDeclaration),
    "",
    "  This report is for staff attention. It restricts nobody and suspends nobody.",
  );
  return lines.join("\n");
}

/** BigInt is not JSON-serialisable; render it as a decimal string, never a float. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = console.log,
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  let options: RiskCommandOptions;
  try {
    options = parseCommandOptions(argv, now);
  } catch (error) {
    if (error instanceof RiskUsageError) {
      out(`usage: ${error.message}`);
      return 2;
    }
    throw error;
  }

  let outcome: RiskCommandOutcome;
  try {
    outcome = {
      mode: options.mode,
      asOf: options.asOf,
      windowDays: options.windowDays,
      report:
        options.mode === "DAILY"
          ? await runDailySellerRiskReport({
              asOf: options.asOf,
              windowDays: options.windowDays,
              top: options.top,
            })
          : null,
      seller:
        options.mode === "SELLER"
          ? await inspectSellerRisk({
              sellerParticipantId: options.sellerParticipantId!,
              asOf: options.asOf,
              windowDays: options.windowDays,
            })
          : null,
      promoterPairs:
        options.mode === "PROMOTER_PAIRS"
          ? await inspectSellerPromoterRisk({
              sellerParticipantId: options.sellerParticipantId!,
              promoterParticipantId: options.promoterParticipantId ?? undefined,
              asOf: options.asOf,
              windowDays: options.windowDays,
            })
          : null,
      policyVersions: options.mode === "POLICY" ? await readReviewPolicyVersions() : null,
      scheduleGuidance: SELLER_RISK_REVIEW_SCHEDULE_GUIDANCE,
    };
  } catch (error) {
    if (error instanceof SellerRiskError) {
      /* The bounded code and the message this module wrote — never a provider
         string, a stack, or a participant detail. */
      out(`refused: ${error.code}`);
      return 2;
    }
    throw error;
  }

  if (!options.json) out(formatReport(outcome));
  out(JSON.stringify(outcome, jsonReplacer, 2));

  /* Non-zero when a seller reached the governed attention floor. A review
     command that always succeeded would be one nobody could gate a daily
     operations check on. It still means "look", never "act". */
  const flagged =
    outcome.report?.rows.some((r) => r.warrantsAttention) ??
    outcome.seller?.warrantsAttention ??
    false;
  return flagged ? 1 : 0;
}

/* Executed only when run as a command, never on import. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("seller-risk-review");

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
