/**
 * Registrar transport composition root (Phase 0E.6.2) — SERVER ONLY.
 *
 * The single place where validated configuration becomes a usable Phase 0E.6.1
 * transport. Everything downstream receives an already-constructed transport and
 * an already-validated endpoint; nothing downstream reads the environment.
 *
 * The load-bearing rule here is that the **allow-list is re-applied at
 * construction**, not merely at load. Configuration can be loaded once at boot
 * and a transport built much later, from a configuration object that could have
 * been assembled by hand rather than by the loader. Re-checking costs a URL
 * parse and removes the entire class of "constructed from an object that never
 * passed the allow-list".
 *
 * This module performs no network call. Constructing a transport proves the
 * configuration is *coherent*; it proves nothing about the Registrar being
 * reachable, and deliberately does not try to.
 */

import "../server-only";
import {
  RegistrarEndpoint,
  type RegistrarCredentialProvider,
} from "../../contracts/product/registrar-transport";
import { HttpRegistrarRegisterTransport } from "./http-register-transport";
import { EnvBearerCredentialProvider } from "./env-credential-provider";
import {
  findAllowListIssues,
  type EnvironmentSource,
  type RegistrarRuntimeConfig,
} from "./registrar-runtime-config";
import {
  EndpointNotAllowListedError,
  RuntimeTransportConstructionFailureError,
  UnsupportedCredentialModeError,
} from "./runtime-config-errors";

/** What the composition root hands to a caller: a transport and where to send. */
export interface ConfiguredRegistrarTransport {
  transport: HttpRegistrarRegisterTransport;
  endpoint: RegistrarEndpoint;
  registrarId: RegistrarRuntimeConfig["registrarId"];
}

export interface CreateConfiguredRegistrarTransportOptions {
  /** Source of the bearer secret. Injected so tests never touch `process.env`. */
  secretSource: EnvironmentSource;
  /** Test seam only; production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam only; production builds an `EnvBearerCredentialProvider`. */
  credentialProvider?: RegistrarCredentialProvider;
}

/**
 * Build a transport from a validated configuration.
 *
 * Order matters: the allow-list is re-asserted **before** anything touches the
 * secret source, so a misconfigured endpoint never causes a credential to be
 * read at all.
 */
export function createConfiguredRegistrarTransport(
  config: RegistrarRuntimeConfig,
  options: CreateConfiguredRegistrarTransportOptions,
): ConfiguredRegistrarTransport {
  if (config.credentialMode !== "BEARER_ENV") {
    throw new UnsupportedCredentialModeError(config.credentialMode);
  }

  // Re-apply the allow-list. Never trust that this object came from the loader.
  const issues = findAllowListIssues(config.endpointUrl, config.allowedOrigins, {
    allowLoopbackHttp: config.allowLoopbackHttp,
  });
  if (issues.length > 0) {
    // Rules only — the endpoint URL is never echoed.
    throw new EndpointNotAllowListedError(
      `The Registrar endpoint is not permitted: ${issues.map((i) => i.rule).join(", ")}`,
    );
  }

  const parsedEndpoint = RegistrarEndpoint.safeParse({
    url: config.endpointUrl,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  });
  if (!parsedEndpoint.success) {
    // Field paths only; no raw Zod detail and no values.
    throw new RuntimeTransportConstructionFailureError(
      Array.from(new Set(parsedEndpoint.error.issues.map((i) => i.path.join(".") || "endpoint"))),
    );
  }

  const credentialProvider =
    options.credentialProvider ?? new EnvBearerCredentialProvider(config, options.secretSource);

  const transport = new HttpRegistrarRegisterTransport({
    credentialProvider,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });

  return { transport, endpoint: parsedEndpoint.data, registrarId: config.registrarId };
}

// — Readiness —

/**
 * A startup-safe summary. Reports whether the Registrar path *could* run, using
 * codes and field names only, so it is safe to log at boot.
 *
 * `READY` means the configuration is coherent and a credential is present — it
 * does **not** mean the Registrar answered, because this phase contacts nothing.
 */
export type RegistrarRuntimeReadiness =
  | { status: "DISABLED" }
  | { status: "READY"; registrarId: RegistrarRuntimeConfig["registrarId"] }
  | { status: "INVALID"; code: string; fields: string[] };

/**
 * Check readiness without sending anything.
 *
 * Deliberately includes a credential *presence* check: a deployment that is
 * perfectly configured but missing its secret should discover that at boot, not
 * on the first publication attempt hours later. Presence only — the value is
 * never returned, logged, or retained.
 */
export function validateRegistrarRuntimeReadiness(
  config: RegistrarRuntimeConfig | undefined,
  secretSource: EnvironmentSource,
): RegistrarRuntimeReadiness {
  if (config === undefined) return { status: "DISABLED" };

  try {
    createConfiguredRegistrarTransport(config, { secretSource });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "INVALID";
    const fields =
      error instanceof Error && "fields" in error && Array.isArray(error.fields)
        ? (error.fields as string[])
        : [];
    return { status: "INVALID", code, fields };
  }

  // Presence of the secret, never its value.
  const secret = secretSource[config.bearerTokenEnvVar];
  if (secret === undefined || secret.trim() === "") {
    return { status: "INVALID", code: "MISSING_CREDENTIAL_SECRET", fields: [] };
  }

  return { status: "READY", registrarId: config.registrarId };
}
