/**
 * Structured Registrar runtime-configuration errors (Phase 0E.6.2).
 *
 * Every error here reports **field names and issue codes only**. A configuration
 * fault is exactly the situation where a careless message leaks the thing it is
 * complaining about — a token, a full environment dump, or a URL with embedded
 * credentials — so none of those may appear.
 *
 * In particular: the *value* of a secret is never included, and neither is a
 * credential-bearing endpoint. The NAME of the secret variable is treated as
 * potentially sensitive too, and is never echoed.
 *
 * Stable codes; the original cause is retained for diagnostics but attached
 * NON-ENUMERABLE via the shared `attachInternalCause` pattern.
 *
 * Every class here has a real throw site. Malformed and incomplete *loads* are
 * deliberately NOT errors — `loadRegistrarRuntimeConfiguration` returns them as
 * `INVALID` / `INCOMPLETE` states, because a caller must distinguish four
 * outcomes and act differently on each, and an exception is a poor carrier for
 * that. Error classes for those states existed briefly and were removed as
 * unreachable vocabulary.
 */

import { attachInternalCause } from "../product/error-cause";

export type RegistrarRuntimeConfigErrorCode =
  | "ENDPOINT_NOT_ALLOW_LISTED"
  | "UNSUPPORTED_CREDENTIAL_MODE"
  | "MISSING_CREDENTIAL_SECRET"
  | "INVALID_CREDENTIAL_SECRET"
  | "TRANSPORT_CONSTRUCTION_FAILURE";

export class RegistrarRuntimeConfigError extends Error {
  readonly code: RegistrarRuntimeConfigErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: RegistrarRuntimeConfigErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "RegistrarRuntimeConfigError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * The endpoint is well-formed but is not one of the configured allowed origins.
 * The URL is NEVER echoed — it may carry credentials or an internal path.
 */
export class EndpointNotAllowListedError extends RegistrarRuntimeConfigError {
  constructor(message = "The Registrar endpoint does not match any allowed origin") {
    super("ENDPOINT_NOT_ALLOW_LISTED", message);
    this.name = "EndpointNotAllowListedError";
  }
}

/** A credential mode was requested that this phase does not implement. */
export class UnsupportedCredentialModeError extends RegistrarRuntimeConfigError {
  readonly mode: string;
  constructor(mode: string) {
    super("UNSUPPORTED_CREDENTIAL_MODE", `Credential mode ${mode} is not supported`);
    this.name = "UnsupportedCredentialModeError";
    this.mode = mode;
  }
}

/**
 * The named secret variable is absent or blank. The variable NAME is not
 * included: knowing which variable holds the token is itself a small disclosure.
 */
export class MissingCredentialSecretError extends RegistrarRuntimeConfigError {
  constructor(message = "The configured Registrar credential secret is not set") {
    super("MISSING_CREDENTIAL_SECRET", message);
    this.name = "MissingCredentialSecretError";
  }
}

/** The secret exists but is unusable as a header value. Never echoed. */
export class InvalidCredentialSecretError extends RegistrarRuntimeConfigError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super("INVALID_CREDENTIAL_SECRET", "The configured Registrar credential secret is not usable");
    this.name = "InvalidCredentialSecretError";
    this.issues = issues;
  }
}

/** The transport could not be constructed from an otherwise valid configuration. */
export class RuntimeTransportConstructionFailureError extends RegistrarRuntimeConfigError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super(
      "TRANSPORT_CONSTRUCTION_FAILURE",
      "The Registrar transport could not be constructed from this configuration",
      cause,
    );
    this.name = "RuntimeTransportConstructionFailureError";
    this.fields = fields;
  }
}
