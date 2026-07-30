/**
 * Publication-worker health query (Phase 0E.7.3) — SERVER ONLY.
 *
 * Reads a **bounded** window of recent worker runs and hands them to the pure
 * Phase 0E.7.3 assessment. The split is deliberate: all the policy lives in a
 * function with no database, so every precedence rule can be exercised
 * exhaustively, and this module is only the bounded read that feeds it.
 *
 * What this does NOT do: no unbounded history scan, no secret lookup, no network
 * call, no queue mutation, no worker execution, no automatic stale-run
 * reconciliation, and no HTTP route. It is an internal service an operator or a
 * future deployment wrapper may call — nothing is exposed publicly in this phase.
 *
 * **Scope.** The result describes publication-worker operational health and
 * nothing else. It is not database health, Registrar availability, Resolver
 * health, checkout health, or Monacado service health — worker history cannot
 * support those claims, and the result carries an explicit `scope` marker so a
 * consumer cannot quietly treat it as a system-wide signal.
 */

import "../server-only";
import {
  AssessPublicationWorkerHealthInput,
  assessPublicationWorkerHealth,
  type PublicationWorkerHealth,
} from "../../contracts/product/publication-worker-run";
import { getPrisma } from "../db/client";
import { PublicationWorkerRunRepository } from "./publication-worker-run-repository";
import { InvalidWorkerRunInputError } from "./worker-run-errors";

type Db = ReturnType<typeof getPrisma>;

/**
 * The query's own inputs. Time and both thresholds are explicit — there is no
 * default "now" and no default freshness window, because a health answer whose
 * meaning depends on an unstated threshold is not an answer an operator can act on.
 */
export interface GetPublicationWorkerHealthOptions {
  assessedAt: string;
  freshnessSeconds: number;
  failureStreakThreshold?: number;
  /** How many recent runs to consider. Bounded 1…100. */
  limit: number;
  db?: Db;
}

/**
 * Assess health from the most recent terminal runs.
 *
 * Only terminal rows are read: a STARTED row is evidence that something is in
 * flight, not evidence about health, and including it would make every healthy
 * invocation briefly look ambiguous. A command that died leaves a STARTED row that
 * becomes ABANDONED through explicit reconciliation, and *then* counts against
 * health — which is why abandonment is an operator action rather than an inference
 * this query makes on its own.
 */
export async function getPublicationWorkerHealth(
  options: GetPublicationWorkerHealthOptions,
): Promise<PublicationWorkerHealth> {
  const repository = new PublicationWorkerRunRepository(options.db);

  // The repository validates and bounds `limit`; an out-of-range value is refused
  // there rather than clamped here.
  const runs = await repository.listRecentPublicationWorkerRuns({
    limit: options.limit,
    terminalOnly: true,
  });

  const parsed = AssessPublicationWorkerHealthInput.safeParse({
    assessedAt: options.assessedAt,
    freshnessSeconds: options.freshnessSeconds,
    ...(options.failureStreakThreshold !== undefined
      ? { failureStreakThreshold: options.failureStreakThreshold }
      : {}),
    runs,
  });
  if (!parsed.success) {
    throw new InvalidWorkerRunInputError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }

  try {
    return assessPublicationWorkerHealth(parsed.data);
  } catch (error) {
    // The assessment refuses a run that completed after `assessedAt`. Surfaced as
    // an input fault naming the field, never as a raw RangeError.
    if (error instanceof RangeError) {
      throw new InvalidWorkerRunInputError(["assessedAt"]);
    }
    throw error;
  }
}
