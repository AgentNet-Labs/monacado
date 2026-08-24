/**
 * `tax:readiness` — report whether this deployment's tax integration is fit to
 * charge real buyers (Phase 1.6). SERVER ONLY.
 *
 * ```
 *   npm run tax:readiness            # configuration + catalogue classification
 *   npm run tax:readiness -- --no-db # configuration only; never opens a database
 *   npm run tax:readiness -- --json  # machine-readable only
 * ```
 *
 * ## Read-only, and that is enforced rather than promised
 *
 * **No write of any kind.** No provider call, no configuration change, no
 * activation. The only database access is a single aggregate count of how much
 * of the catalogue is classified, and `--no-db` removes even that — so this can
 * be run against an environment nobody wants a connection opened to.
 *
 * It also **makes no tax calculation**. `1.2`'s live-readiness check proved the
 * tax adapter worked by performing one; with Stripe Tax selected that would mean
 * a live API call to a payment provider every time somebody ran a command
 * documented as read-only. Configuration is inspected instead, and the report
 * says so rather than implying more than it checked.
 *
 * ## No secrets, by construction
 *
 * The report contains environment variable **names**, booleans, bounded codes,
 * and counts. It cannot contain a credential because the readiness evaluator
 * never returns one — `evaluateTaxReadiness` checks a key's *presence and
 * prefix* and returns neither. That is what makes this safe to run on a shared
 * screen during a launch review, which is the only situation it exists for.
 *
 * ## Exit codes
 *
 * `0` when calculation is configured **and** the registration and filing
 * postures have been stated; `1` otherwise. Non-zero is the useful default for a
 * launch checklist — a readiness command that always succeeded would be a
 * readiness command nobody could gate on.
 */

import "dotenv/config";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { summarizeProductTaxClassificationReadiness } from "../src/server/product/product-tax-facts-service";
import {
  evaluateTaxReadiness,
  type TaxReadinessReport,
} from "../src/server/tax/tax-readiness";

export interface TaxReadinessCommandOptions {
  json: boolean;
  useDb: boolean;
}

export function parseCommandOptions(argv: readonly string[]): TaxReadinessCommandOptions {
  return {
    json: argv.includes("--json"),
    /* Opt OUT rather than opt in: the catalogue figure is the half of this
       report an operator cannot get anywhere else, and defaulting to skipping it
       would make the command quietly less useful than it looks. */
    useDb: !argv.includes("--no-db"),
  };
}

/** How much of the sellable catalogue could actually be taxed. */
export interface CatalogueClassificationReadiness {
  state: "READ" | "SKIPPED" | "UNAVAILABLE";
  totalProducts: number | null;
  classified: number | null;
  unclassified: number | null;
}

export interface TaxReadinessCommandOutcome {
  readiness: TaxReadinessReport;
  catalogue: CatalogueClassificationReadiness;
  /** Calculation configured, and both compliance postures stated. */
  launchReviewPasses: boolean;
}

const bullet = (label: string, value: unknown): string => `  ${label.padEnd(34)} ${String(value)}`;

export function formatReport(outcome: TaxReadinessCommandOutcome): string {
  const r = outcome.readiness;
  const lines: string[] = [
    "tax readiness",
    "",
    bullet("state", r.state),
    bullet("provider", r.provider ?? `(unrecognised: "${r.selectedProviderName}")`),
    bullet("provider mode", r.providerMode ?? "(none)"),
    bullet("production-capable provider", r.productionCapableProvider),
    bullet("calculation configured", r.calculationConfigured),
    "",
    bullet("classifications mapped", r.classificationMapping.mapped.join(", ") || "(none)"),
    bullet("classifications unmapped", r.classificationMapping.unmapped.join(", ") || "(none)"),
    "",
    bullet("registration posture", r.registration.posture),
    bullet("registration config ref", r.registration.configRefPresent ? "present" : "missing"),
    bullet("registration complete", r.registration.complete),
    "",
    bullet("filing posture", r.filing.posture),
    bullet("Monacado files/remits", r.filing.monacadoFiles),
    bullet("provider tax transactions", r.filing.providerRecordsTransactions),
    "",
    bullet("live tax commerce permitted", r.liveTaxCommercePermitted),
    "",
    bullet("catalogue classification", outcome.catalogue.state),
  ];
  if (outcome.catalogue.state === "READ") {
    lines.push(
      bullet("  products (current version)", outcome.catalogue.totalProducts),
      bullet("  classified", outcome.catalogue.classified),
      bullet("  unclassified", outcome.catalogue.unclassified),
    );
  }
  lines.push(
    "",
    "  env vars present:",
    ...r.requiredEnvVars.present.map((name) => `    + ${name}`),
    "  env vars missing:",
    ...r.requiredEnvVars.missing.map((name) => `    - ${name}`),
    "",
    "  blockers:",
    ...(r.blockers.length === 0 ? ["    (none)"] : r.blockers.map((b) => `    ! ${b}`)),
    "  satisfied:",
    ...(r.satisfied.length === 0 ? ["    (none)"] : r.satisfied.map((sat) => `    ✓ ${sat}`)),
  );
  return lines.join("\n");
}

export function formatJson(outcome: TaxReadinessCommandOutcome): string {
  return JSON.stringify(outcome, null, 2);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = console.log,
): Promise<number> {
  const options = parseCommandOptions(argv);
  const readiness = evaluateTaxReadiness(new Date().toISOString());

  let catalogue: CatalogueClassificationReadiness = {
    state: "SKIPPED",
    totalProducts: null,
    classified: null,
    unclassified: null,
  };
  if (options.useDb) {
    try {
      const summary = await summarizeProductTaxClassificationReadiness(getPrisma());
      catalogue = { state: "READ", ...summary };
    } catch {
      /* An unreadable catalogue is reported as UNAVAILABLE, never as zero
         unclassified: a check that could not run has not passed, and a readiness
         report that turned a connection failure into a clean bill of health
         would be worse than no report. The error itself is discarded — a
         database error can carry a connection string, and this prints to a
         terminal and a log. */
      catalogue = { state: "UNAVAILABLE", totalProducts: null, classified: null, unclassified: null };
    }
  }

  const outcome: TaxReadinessCommandOutcome = {
    readiness,
    catalogue,
    launchReviewPasses:
      readiness.calculationConfigured &&
      readiness.registration.complete &&
      readiness.filing.posture !== "UNCONFIGURED" &&
      catalogue.state !== "UNAVAILABLE" &&
      (catalogue.unclassified ?? 0) === 0,
  };

  if (!options.json) out(formatReport(outcome));
  out(formatJson(outcome));
  return outcome.launchReviewPasses ? 0 : 1;
}

/* Executed only when run as a command, never on import — the test imports this
   module for `parseCommandOptions` and `formatReport`. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes("tax-readiness");

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
