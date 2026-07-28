/**
 * Registrar runtime configuration (Phase 0E.6.2) — SERVER ONLY.
 *
 * The boundary between deployment configuration and the Phase 0E.6.1 transport.
 * It answers three questions and nothing else: is the Registrar enabled, where
 * are we permitted to send, and *where is the secret kept*.
 *
 * Two properties matter most:
 *
 *   1. **No secret value ever enters the parsed configuration object.** The
 *      configuration stores the NAME of the variable holding the bearer token,
 *      never the token. Anything that logs or serialises the configuration is
 *      therefore safe by construction rather than by discipline.
 *
 *   2. **Disabled by default.** There are no production defaults for the
 *      endpoint, the Registrar identity, or the allow-list. An unconfigured
 *      deployment sends nothing rather than guessing.
 *
 * This module performs no DNS resolution and no network call.
 */

import "../server-only";
import { z } from "zod";
import { RegistrarId } from "../../contracts/product/product-node";
import {
  MAX_RESPONSE_BYTES,
  MIN_RESPONSE_BYTES,
  TransportTimeoutMs,
} from "../../contracts/product/registrar-transport";
import { findEndpointIssues, isLoopbackHost } from "../../contracts/product/registrar-endpoint-safety";

// — Credential mode —

/**
 * One narrow mode. A bearer token, read from a named environment variable at the
 * moment it is needed. Extra schemes are deliberately absent: speculative auth
 * mechanisms are surface area with no caller.
 */
export const CREDENTIAL_MODES = ["BEARER_ENV"] as const;
export const CredentialMode = z.enum(CREDENTIAL_MODES);
export type CredentialMode = z.infer<typeof CredentialMode>;

/** Environment variable names: conventional, and never a value. */
export const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

// — Configuration —

/**
 * The validated, **secret-free** configuration of an ENABLED Registrar.
 *
 * `bearerTokenEnvVar` is a variable NAME. Resolving it to a value happens only
 * inside the credential provider, only when a request is about to be signed.
 */
export const RegistrarRuntimeConfig = z.strictObject({
  registrarId: RegistrarId,
  /** Absolute endpoint URL. Must match one allowed origin exactly. */
  endpointUrl: z.string().min(1).max(2_048),
  /** Exact origins we may send to. At least one; wildcards refused. */
  allowedOrigins: z.array(z.string().min(1).max(2_048)).min(1),
  timeoutMs: TransportTimeoutMs,
  maxResponseBytes: z.int().min(MIN_RESPONSE_BYTES).max(MAX_RESPONSE_BYTES),
  credentialMode: CredentialMode,
  /** The NAME of the variable holding the bearer token. Never the token. */
  bearerTokenEnvVar: z.string().regex(ENV_VAR_NAME_RE, "must be an environment variable name"),
  /**
   * Permits plain `http:` to a loopback host. TEST ONLY — a production-ready
   * configuration must use HTTPS, and this flag makes that an explicit,
   * greppable decision rather than an accident of which host was configured.
   */
  allowLoopbackHttp: z.boolean(),
});
export type RegistrarRuntimeConfig = z.infer<typeof RegistrarRuntimeConfig>;

// — Exact-origin allow-listing —

/**
 * Normalise a URL to `scheme://host:port` with the effective port filled in, so
 * `https://r.example` and `https://r.example:443` compare equal.
 *
 * Returns `undefined` for anything unparseable or wildcarded. Wildcards are
 * refused outright: an allow-list entry that matches a family of hosts is not an
 * allow-list, and suffix matching (`endsWith`) is exactly how `evil-r.example`
 * slips past a rule meant for `r.example`. Matching here is string equality of
 * normalised origins — nothing else.
 */
export function normalizeOrigin(url: string): string | undefined {
  if (url.includes("*")) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (parsed.hostname === "") return undefined;
  const port = parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
}

export interface AllowListIssue {
  rule: string;
  reason: string;
}

/**
 * Validate an endpoint against configured origins and production scheme rules.
 *
 * Layered on top of the Phase 0E.6.1 shape checks, not instead of them: those
 * prove an endpoint is *safe to speak to at all*, this proves it is one we were
 * *told* to speak to. Issues name the failing rule and never echo the URL.
 */
export function findAllowListIssues(
  endpointUrl: string,
  allowedOrigins: readonly string[],
  options: { allowLoopbackHttp: boolean },
): AllowListIssue[] {
  const issues: AllowListIssue[] = [];

  // Shape and SSRF rules first — scheme, credentials, fragment, host.
  for (const issue of findEndpointIssues(endpointUrl)) {
    issues.push(issue);
  }

  const endpointOrigin = normalizeOrigin(endpointUrl);
  if (endpointOrigin === undefined) {
    issues.push({ rule: "endpoint-origin", reason: "the endpoint has no comparable origin" });
    return issues;
  }

  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return issues;
  }

  // Production must be HTTPS. Loopback http: is permitted only when explicitly
  // enabled for tests — never as a side effect of the host happening to be local.
  if (parsed.protocol === "http:") {
    if (!options.allowLoopbackHttp) {
      issues.push({
        rule: "https-required",
        reason: "a production-ready endpoint must use https:",
      });
    } else if (!isLoopbackHost(parsed.hostname)) {
      issues.push({
        rule: "loopback-only",
        reason: "http: is permitted only for loopback endpoints in test mode",
      });
    }
  }

  // Every allow-list entry must itself be a concrete origin.
  const normalizedAllowed: string[] = [];
  for (const entry of allowedOrigins) {
    const normalized = normalizeOrigin(entry);
    if (normalized === undefined) {
      issues.push({
        rule: "allow-list-entry",
        reason: "an allowed origin is wildcarded or not a concrete origin",
      });
      continue;
    }
    normalizedAllowed.push(normalized);
  }

  if (!normalizedAllowed.includes(endpointOrigin)) {
    issues.push({
      rule: "origin-not-allowed",
      reason: "the endpoint origin does not exactly match any allowed origin",
    });
  }

  return issues;
}

// — Environment loading —

/** The minimal environment shape the loader needs. Injected, never read globally. */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export const ENV_KEYS = {
  enabled: "MONACADO_REGISTRAR_ENABLED",
  registrarId: "MONACADO_REGISTRAR_ID",
  endpoint: "MONACADO_REGISTRAR_ENDPOINT",
  allowedOrigins: "MONACADO_REGISTRAR_ALLOWED_ORIGINS",
  timeoutMs: "MONACADO_REGISTRAR_TIMEOUT_MS",
  maxResponseBytes: "MONACADO_REGISTRAR_MAX_RESPONSE_BYTES",
  credentialMode: "MONACADO_REGISTRAR_CREDENTIAL_MODE",
  bearerTokenEnv: "MONACADO_REGISTRAR_BEARER_TOKEN_ENV",
  allowLoopbackHttp: "MONACADO_REGISTRAR_ALLOW_LOOPBACK_HTTP",
} as const;

/** Fields required once the Registrar is enabled. */
const REQUIRED_WHEN_ENABLED = [
  ENV_KEYS.registrarId,
  ENV_KEYS.endpoint,
  ENV_KEYS.allowedOrigins,
  ENV_KEYS.credentialMode,
  ENV_KEYS.bearerTokenEnv,
] as const;

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

/**
 * Four distinct outcomes, because they call for different operator responses:
 *
 *   DISABLED   — nothing configured, nothing sent. The default, and not a fault.
 *   INCOMPLETE — someone turned it on but did not finish. Names missing keys.
 *   INVALID    — values are present but wrong. Names offending fields.
 *   READY      — a validated, secret-free configuration.
 */
export type RegistrarConfigurationLoad =
  | { state: "DISABLED" }
  | { state: "INCOMPLETE"; missingFields: string[] }
  | { state: "INVALID"; issues: string[] }
  | { state: "READY"; config: RegistrarRuntimeConfig };

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
 * Load and validate Registrar configuration from an INJECTED environment.
 *
 * The environment object is supplied by the caller — production passes
 * `process.env` at the application boundary. Nothing here, and nothing in the
 * HTTP adapter, reaches for `process.env` itself.
 *
 * The full environment is never returned, logged, or embedded in an issue; only
 * the keys this module knows about are read, and only their names are reported.
 */
export function loadRegistrarRuntimeConfiguration(
  env: EnvironmentSource,
): RegistrarConfigurationLoad {
  const enabled = parseBool(env[ENV_KEYS.enabled]) ?? false;
  if (!enabled) return { state: "DISABLED" };

  const missingFields = REQUIRED_WHEN_ENABLED.filter((key) => trim(env[key]) === undefined);
  if (missingFields.length > 0) return { state: "INCOMPLETE", missingFields: [...missingFields] };

  const rawTimeout = trim(env[ENV_KEYS.timeoutMs]);
  const rawMaxBytes = trim(env[ENV_KEYS.maxResponseBytes]);

  const candidate = {
    registrarId: trim(env[ENV_KEYS.registrarId]),
    endpointUrl: trim(env[ENV_KEYS.endpoint]),
    allowedOrigins: (trim(env[ENV_KEYS.allowedOrigins]) ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== ""),
    timeoutMs: rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout),
    maxResponseBytes:
      rawMaxBytes === undefined ? DEFAULT_MAX_RESPONSE_BYTES : Number(rawMaxBytes),
    credentialMode: trim(env[ENV_KEYS.credentialMode]),
    bearerTokenEnvVar: trim(env[ENV_KEYS.bearerTokenEnv]),
    allowLoopbackHttp: parseBool(env[ENV_KEYS.allowLoopbackHttp]) ?? false,
  };

  const parsed = RegistrarRuntimeConfig.safeParse(candidate);
  if (!parsed.success) {
    // Field paths and rule messages only — never a value from the environment.
    return {
      state: "INVALID",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  // The endpoint must satisfy both shape safety and the exact allow-list.
  const allowListIssues = findAllowListIssues(parsed.data.endpointUrl, parsed.data.allowedOrigins, {
    allowLoopbackHttp: parsed.data.allowLoopbackHttp,
  });
  if (allowListIssues.length > 0) {
    return {
      state: "INVALID",
      issues: allowListIssues.map((i) => `endpointUrl: ${i.rule} — ${i.reason}`),
    };
  }

  return { state: "READY", config: parsed.data };
}
