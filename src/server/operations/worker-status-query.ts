/**
 * Worker-status query parsing (Phase 0E.7.4.2B) — SERVER ONLY.
 *
 * A pure, strict parser over `URLSearchParams`. No framework object, no clock, no
 * database, no randomness — so the whole parameter policy can be exercised
 * exhaustively without a request.
 *
 * **Allow-list, not deny-list.** Four parameters are recognised; anything else is
 * refused. There is deliberately no way for a caller to supply `assessedAt`, an
 * actor, a capability, an ordering, a cursor, a filter, a database id, or a Prisma
 * clause — those are not "unsupported yet", they are absent from the vocabulary.
 *
 * **Integers are strict.** `Number()` and `parseInt()` are both too permissive for
 * a security boundary: `parseInt("5abc")` is 5, `Number(" 5 ")` is 5, `Number("")`
 * is 0, and `Number("1e2")` is 100. A caller who sent one of those did not mean
 * what a lenient parse would decide they meant, so every one is refused.
 */

import "../server-only";
import {
  MAX_BACKLOG_PRESSURE_STREAK,
  MAX_FAILURE_STREAK,
  MAX_HEALTH_FRESHNESS_SECONDS,
  MAX_RECENT_RUN_LIMIT,
  MIN_BACKLOG_PRESSURE_STREAK,
  MIN_FAILURE_STREAK,
  MIN_HEALTH_FRESHNESS_SECONDS,
  MIN_RECENT_RUN_LIMIT,
} from "../../contracts/product/publication-worker-run";

/**
 * Defaults for a bare request.
 *
 * `freshnessSeconds` is 15 minutes rather than the hour the health contract
 * permits: an operator opening this route is asking "is the worker running *now*",
 * and a window wide enough to call an hour-old run fresh would answer a different
 * question. A caller who wants the wider view asks for it explicitly.
 */
export const WORKER_STATUS_QUERY_DEFAULTS = {
  recentRunLimit: 20,
  freshnessSeconds: 900,
  failureStreakThreshold: 2,
  backlogPressureThreshold: 2,
} as const;

/** The complete recognised vocabulary. */
export const WORKER_STATUS_QUERY_PARAMETERS = [
  "recentRunLimit",
  "freshnessSeconds",
  "failureStreakThreshold",
  "backlogPressureThreshold",
] as const;
export type WorkerStatusQueryParameter = (typeof WORKER_STATUS_QUERY_PARAMETERS)[number];

export interface WorkerStatusQuery {
  recentRunLimit: number;
  freshnessSeconds: number;
  failureStreakThreshold: number;
  backlogPressureThreshold: number;
}

export type WorkerStatusQueryParse =
  | { ok: true; query: WorkerStatusQuery }
  | { ok: false; fields: string[] };

/** Unsigned decimal digits only. Nothing else is an integer at this boundary. */
const STRICT_INTEGER_RE = /^[0-9]+$/;

const BOUNDS: Record<WorkerStatusQueryParameter, { min: number; max: number }> = {
  recentRunLimit: { min: MIN_RECENT_RUN_LIMIT, max: MAX_RECENT_RUN_LIMIT },
  freshnessSeconds: { min: MIN_HEALTH_FRESHNESS_SECONDS, max: MAX_HEALTH_FRESHNESS_SECONDS },
  failureStreakThreshold: { min: MIN_FAILURE_STREAK, max: MAX_FAILURE_STREAK },
  backlogPressureThreshold: {
    min: MIN_BACKLOG_PRESSURE_STREAK,
    max: MAX_BACKLOG_PRESSURE_STREAK,
  },
};

/**
 * Parse and bound the query string.
 *
 * Returns offending parameter **names** on failure — never their values. A
 * rejected query is exactly where an operator might have pasted something they
 * should not have, and echoing it back would put it in a log.
 */
export function parseWorkerStatusQuery(params: URLSearchParams): WorkerStatusQueryParse {
  const fields: string[] = [];

  // Unknown parameters are a failure, not something to ignore: silently dropping
  // one would let a caller believe a filter or an ordering had been applied.
  for (const name of new Set(params.keys())) {
    if (!(WORKER_STATUS_QUERY_PARAMETERS as readonly string[]).includes(name)) {
      fields.push(name.slice(0, 64));
    }
  }

  const parsed: Partial<WorkerStatusQuery> = {};
  for (const name of WORKER_STATUS_QUERY_PARAMETERS) {
    const values = params.getAll(name);
    if (values.length === 0) {
      parsed[name] = WORKER_STATUS_QUERY_DEFAULTS[name];
      continue;
    }
    // `?limit=1&limit=2` is ambiguous. Picking either one guesses at intent, and
    // guessing about a bound is how a caller gets more data than they asked for.
    if (values.length > 1) {
      fields.push(name);
      continue;
    }
    const raw = values[0]!;
    if (!STRICT_INTEGER_RE.test(raw)) {
      fields.push(name);
      continue;
    }
    const value = Number(raw);
    const { min, max } = BOUNDS[name];
    // Refused, never clamped: a clamped bound answers a question nobody asked.
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      fields.push(name);
      continue;
    }
    parsed[name] = value;
  }

  if (fields.length > 0) {
    return { ok: false, fields: Array.from(new Set(fields)).sort() };
  }
  return { ok: true, query: parsed as WorkerStatusQuery };
}
