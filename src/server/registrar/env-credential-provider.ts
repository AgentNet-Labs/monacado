/**
 * Environment-backed Registrar credential provider (Phase 0E.6.2) — SERVER ONLY.
 *
 * Resolves a bearer token from an injected secret source **at the moment a
 * request is about to be signed**, and never before.
 *
 * The deliberate properties:
 *
 *   - the secret is **not cached**. Caching would keep a token in memory across
 *     a rotation, so a rotated credential would keep failing until restart, and
 *     it would widen the window in which a heap dump contains it. Resolving per
 *     request costs an object property read;
 *   - the secret is **never persisted**, logged, or returned in an error;
 *   - even the variable NAME is not echoed in errors — knowing which variable
 *     holds the token is a small disclosure in itself;
 *   - exactly one mode. A speculative second auth scheme is surface area with no
 *     caller.
 */

import "../server-only";
import {
  HEADER_VALUE_RE,
  type RegistrarCredentialProvider,
  type RegistrarCredentials,
} from "../../contracts/product/registrar-transport";
import type { EnvironmentSource, RegistrarRuntimeConfig } from "./registrar-runtime-config";
import {
  InvalidCredentialSecretError,
  MissingCredentialSecretError,
  UnsupportedCredentialModeError,
} from "./runtime-config-errors";

/** Longest token we will accept, matching the transport's header-value bound. */
const MAX_SECRET_LENGTH = 8_000;

/**
 * A bearer-token provider reading one named variable from an injected source.
 *
 * The source is an interface, not `process.env`: a secret manager can be
 * substituted later without touching this class or the transport.
 */
export class EnvBearerCredentialProvider implements RegistrarCredentialProvider {
  constructor(
    private readonly config: RegistrarRuntimeConfig,
    private readonly secretSource: EnvironmentSource,
  ) {
    if (config.credentialMode !== "BEARER_ENV") {
      throw new UnsupportedCredentialModeError(config.credentialMode);
    }
  }

  /**
   * Resolve the credential. Called once per request by the transport, so a
   * rotated secret takes effect immediately.
   */
  getRegistrarCredentials(): RegistrarCredentials {
    const raw = this.secretSource[this.config.bearerTokenEnvVar];

    if (raw === undefined || raw.trim() === "") {
      // Deliberately says nothing about WHICH variable is unset.
      throw new MissingCredentialSecretError();
    }

    const secret = raw.trim();
    const issues: string[] = [];
    if (secret.length > MAX_SECRET_LENGTH) {
      issues.push("secret: exceeds the permitted length");
    }
    // A CR or LF would let a token split the request into extra headers.
    if (!HEADER_VALUE_RE.test(secret)) {
      issues.push("secret: contains CRLF or non-printable characters");
    }
    if (issues.length > 0) throw new InvalidCredentialSecretError(issues);

    // Only `authorization`. No additional headers are contributed: the transport
    // allow-list exists for callers that have a reason to add one, and this
    // provider has none.
    return { authorization: `Bearer ${secret}` };
  }
}
