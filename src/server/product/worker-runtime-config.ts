/**
 * Publication worker runtime configuration (Phase 0E.7.2) — SERVER ONLY.
 *
 * The boundary between deployment configuration and one bounded worker cycle. It
 * answers exactly one question: **may this command run a cycle, and with what
 * bounds?** Everything about *where* to send and *where the secret lives* already
 * belongs to the Phase 0E.6.2 Registrar configuration, which this module composes
 * rather than duplicates.
 *
 * Three properties matter most:
 *
 *   1. **Disabled by default.** There is no default `maximumRuns`, no default
 *      lease, and no default retry delay. An unconfigured deployment runs
 *      nothing. A default that could accidentally publish is the one mistake this
 *      module exists to prevent.
 *
 *   2. **No secret value ever enters the parsed configuration.** The worker
 *      configuration holds bounds, a mode, and an optional correlation id. The
 *      credential's *location* stays in the Registrar configuration; its value is
 *      resolved only when a request is signed.
 *
 *   3. **Nothing here reads `process.env`.** The environment is injected. Only the
 *      executable entry point reaches for the real one.
 *
 * There is no arbitrary metadata map: every field is named, typed, and bounded,
 * so a cycle cannot be handed configuration nobody validated.
 */

import "../server-only";
import { z } from "zod";
import {
  MAX_CYCLE_RUNS,
  MIN_CYCLE_RUNS,
} from "../../contracts/product/publication-worker-cycle";
import {
  LeaseDurationSeconds,
  MAX_RECOVERY_LIMIT,
  MIN_RECOVERY_LIMIT,
} from "../../contracts/product/product-publication-outbox";
import {
  ENV_KEYS as REGISTRAR_ENV_KEYS,
  loadRegistrarRuntimeConfiguration,
  type EnvironmentSource,
  type RegistrarRuntimeConfig,
} from "../registrar/registrar-runtime-config";

// — Bounds —

/**
 * Fixed retry delay bounds. A lower bound because an immediate retry is a busy
 * loop wearing a delay's clothing; an upper bound because a delay measured in
 * weeks is indistinguishable from losing the item.
 */
export const MIN_RETRY_DELAY_SECONDS = 1;
export const MAX_RETRY_DELAY_SECONDS = 86_400; // 24 hours

/**
 * Cycle-id shape: bounded, and restricted to characters that cannot smuggle
 * structure into the monitoring output. The id is echoed in every emitted line,
 * so an operator-supplied value is treated as untrusted input rather than trusted
 * because it came from the environment.
 */
export const CYCLE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

// — Monitoring output mode —

/**
 * Two modes, both fully implemented. `SILENT` exists because a caller embedding
 * the command (db:check, a test) needs the cycle without the stream noise; there
 * is no third "verbose" mode, because the JSON-lines output is already the
 * complete safe event set.
 */
export const WORKER_OUTPUT_MODES = ["JSON_LINES", "SILENT"] as const;
export const WorkerOutputMode = z.enum(WORKER_OUTPUT_MODES);
export type WorkerOutputMode = z.infer<typeof WorkerOutputMode>;

// — Configuration —

/**
 * The validated, **secret-free** operational configuration of one bounded cycle.
 *
 * `recovery` mirrors the Phase 0E.7.1 cycle input deliberately: presence enables
 * one bounded sweep, absence disables it entirely. An `enabled` boolean paired
 * with an optional limit would admit the state "enabled with no limit", which has
 * no meaning and would need a runtime assertion the type system can prevent.
 */
export const WorkerRuntimeConfig = z.strictObject({
  maximumRuns: z.int().min(MIN_CYCLE_RUNS).max(MAX_CYCLE_RUNS),
  leaseDurationSeconds: LeaseDurationSeconds,
  retryDelaySeconds: z.int().min(MIN_RETRY_DELAY_SECONDS).max(MAX_RETRY_DELAY_SECONDS),
  outputMode: WorkerOutputMode,
  recovery: z
    .strictObject({ limit: z.int().min(MIN_RECOVERY_LIMIT).max(MAX_RECOVERY_LIMIT) })
    .optional(),
  cycleId: z.string().regex(CYCLE_ID_RE, "must be a short opaque correlation id").optional(),
});
export type WorkerRuntimeConfig = z.infer<typeof WorkerRuntimeConfig>;

// — Environment keys —

export const WORKER_ENV_KEYS = {
  enabled: "MONACADO_PUBLICATION_WORKER_ENABLED",
  maximumRuns: "MONACADO_PUBLICATION_WORKER_MAX_RUNS",
  leaseSeconds: "MONACADO_PUBLICATION_WORKER_LEASE_SECONDS",
  retryDelaySeconds: "MONACADO_PUBLICATION_WORKER_RETRY_DELAY_SECONDS",
  recoveryEnabled: "MONACADO_PUBLICATION_WORKER_RECOVERY_ENABLED",
  recoveryLimit: "MONACADO_PUBLICATION_WORKER_RECOVERY_LIMIT",
  outputMode: "MONACADO_PUBLICATION_WORKER_OUTPUT_MODE",
  cycleId: "MONACADO_PUBLICATION_WORKER_CYCLE_ID",
} as const;

/** Prefix owned by this loader. Used to detect misspelled variables. */
export const WORKER_ENV_PREFIX = "MONACADO_PUBLICATION_WORKER_";

/** Fields required once the worker is enabled. No defaults exist for any of them. */
const REQUIRED_WHEN_ENABLED = [
  WORKER_ENV_KEYS.maximumRuns,
  WORKER_ENV_KEYS.leaseSeconds,
  WORKER_ENV_KEYS.retryDelaySeconds,
] as const;

const KNOWN_WORKER_KEYS: ReadonlySet<string> = new Set(Object.values(WORKER_ENV_KEYS));

// — Load outcomes —

/**
 * Four states, matching the Phase 0E.6.2 vocabulary because callers must act
 * differently on each:
 *
 *   DISABLED   — not enabled. The default, and **not a fault**.
 *   INCOMPLETE — enabled but unfinished. Names the missing KEYS.
 *   INVALID    — values present but wrong. Names FIELDS and rules.
 *   READY      — a validated, secret-free configuration plus a READY Registrar.
 *
 * A malformed or unfinished load is deliberately a state rather than an
 * exception: an operator running a one-shot command needs a safe, machine-
 * readable answer and a non-zero exit code, not a stack trace.
 */
export type WorkerRuntimeConfigurationLoad =
  | { state: "DISABLED" }
  | { state: "INCOMPLETE"; missingFields: string[] }
  | { state: "INVALID"; issues: string[] }
  | {
      state: "READY";
      config: WorkerRuntimeConfig;
      /** The composed Phase 0E.6.2 load, already proven READY. */
      registrar: { state: "READY"; config: RegistrarRuntimeConfig };
    };

const trim = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const parseBool = (value: string | undefined): boolean | undefined => {
  const v = trim(value)?.toLowerCase();
  if (v === undefined) return undefined;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
};

/**
 * Every variable under this loader's prefix that it does not recognise.
 *
 * Checked, and checked **first**, because the dangerous typo is in the switch
 * itself: `MONACADO_PUBLICATION_WORKER_ENABLE=true` would otherwise leave the
 * worker silently disabled and an operator convinced it was running. Failing
 * loudly on an unrecognised variable costs a clear error; failing quietly costs a
 * queue that never drains.
 *
 * Only NAMES are reported — never a value.
 */
export function findUnknownWorkerEnvKeys(env: EnvironmentSource): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith(WORKER_ENV_PREFIX) && !KNOWN_WORKER_KEYS.has(key))
    .sort();
}

/**
 * Load and validate worker configuration from an INJECTED environment.
 *
 * The environment object is supplied by the caller; the executable entry point is
 * the only place that passes `process.env`. The full environment is never
 * returned, logged, or embedded in an issue: only the keys this loader owns are
 * read, and only their names are reported.
 *
 * An unrecognised value for the enable flag resolves to **disabled**, matching
 * the Registrar loader — a switch that cannot be understood must fail closed.
 * Every *other* malformed boolean is `INVALID`, because failing closed on a
 * secondary flag would silently change what the cycle does.
 */
export function loadPublicationWorkerRuntimeConfiguration(
  env: EnvironmentSource,
): WorkerRuntimeConfigurationLoad {
  const unknown = findUnknownWorkerEnvKeys(env);
  if (unknown.length > 0) {
    return {
      state: "INVALID",
      issues: unknown.map((key) => `${key}: not a recognised worker configuration variable`),
    };
  }

  const enabled = parseBool(env[WORKER_ENV_KEYS.enabled]) ?? false;
  if (!enabled) return { state: "DISABLED" };

  // — Enabled: every cycle input is required, and the Registrar must be ready —

  const rawRecoveryEnabled = trim(env[WORKER_ENV_KEYS.recoveryEnabled]);
  const recoveryEnabled =
    rawRecoveryEnabled === undefined ? false : parseBool(rawRecoveryEnabled);
  if (recoveryEnabled === undefined) {
    return {
      state: "INVALID",
      issues: [`${WORKER_ENV_KEYS.recoveryEnabled}: must be a boolean`],
    };
  }

  const missingFields = REQUIRED_WHEN_ENABLED.filter((key) => trim(env[key]) === undefined);
  const missing: string[] = [...missingFields];
  if (recoveryEnabled && trim(env[WORKER_ENV_KEYS.recoveryLimit]) === undefined) {
    missing.push(WORKER_ENV_KEYS.recoveryLimit);
  }
  if (missing.length > 0) return { state: "INCOMPLETE", missingFields: missing };

  const rawOutputMode = trim(env[WORKER_ENV_KEYS.outputMode]);
  const rawRecoveryLimit = trim(env[WORKER_ENV_KEYS.recoveryLimit]);

  const candidate = {
    maximumRuns: Number(trim(env[WORKER_ENV_KEYS.maximumRuns])),
    leaseDurationSeconds: Number(trim(env[WORKER_ENV_KEYS.leaseSeconds])),
    retryDelaySeconds: Number(trim(env[WORKER_ENV_KEYS.retryDelaySeconds])),
    outputMode: rawOutputMode ?? "JSON_LINES",
    ...(recoveryEnabled ? { recovery: { limit: Number(rawRecoveryLimit) } } : {}),
    ...(trim(env[WORKER_ENV_KEYS.cycleId]) !== undefined
      ? { cycleId: trim(env[WORKER_ENV_KEYS.cycleId]) }
      : {}),
  };

  const parsed = WorkerRuntimeConfig.safeParse(candidate);
  if (!parsed.success) {
    // Field paths and rule messages only — never a value from the environment.
    return {
      state: "INVALID",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  // The Registrar configuration is composed, not re-implemented. Its own
  // exact-origin allow-list runs here, and it reads no secret.
  const registrar = loadRegistrarRuntimeConfiguration(env);
  switch (registrar.state) {
    case "DISABLED":
      // An enabled worker with a disabled Registrar is an unfinished
      // configuration, not a no-op: the operator asked for a cycle that could
      // never send anything.
      return { state: "INCOMPLETE", missingFields: [REGISTRAR_ENV_KEYS.enabled] };
    case "INCOMPLETE":
      return { state: "INCOMPLETE", missingFields: [...registrar.missingFields] };
    case "INVALID":
      return { state: "INVALID", issues: [...registrar.issues] };
    case "READY":
      return { state: "READY", config: parsed.data, registrar };
  }
}
