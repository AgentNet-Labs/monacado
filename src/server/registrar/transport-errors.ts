/**
 * Structured Registrar-transport errors (Phase 0E.6.1).
 *
 * These are the **exceptional preconditions** only: faults that mean a send
 * cannot be attempted at all — a refused endpoint, a header we will not send,
 * unusable credentials, an unsendable request, or an attempt whose claim no
 * longer permits dispatch.
 *
 * Everything that can happen *during* an exchange — timeout, connection
 * failure, oversized body, malformed response, ambiguous delivery — is NOT an
 * exception here. Those are returned as bounded, structured `TransportResult`
 * values, because a caller must be able to tell them apart and act differently,
 * and an exception is a poor carrier for a five-way classification.
 *
 * Stable codes; the original cause is retained for diagnostics but attached
 * NON-ENUMERABLE via the shared `attachInternalCause` pattern. Nothing here
 * exposes credentials, the request payload, the response body, integrity hash
 * values, a raw `lockToken`, a `claimTokenHash`, an endpoint URL, or a raw
 * network-library error — an endpoint can carry a host or path that should not
 * be reflected into logs.
 */

import { attachInternalCause } from "../product/error-cause";

export type RegistrarTransportErrorCode =
  | "INVALID_REGISTRAR_ENDPOINT"
  | "FORBIDDEN_TRANSPORT_HEADER"
  | "MISSING_REGISTRAR_CREDENTIALS"
  | "REGISTER_REQUEST_CONTRACT_FAILURE"
  | "DISPATCH_STATE_CONFLICT";

export class RegistrarTransportError extends Error {
  readonly code: RegistrarTransportErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: RegistrarTransportErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "RegistrarTransportError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** The endpoint failed a shape/safety rule. Rule names only — never the URL. */
export class InvalidRegistrarEndpointError extends RegistrarTransportError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super("INVALID_REGISTRAR_ENDPOINT", "The Registrar endpoint is not permitted");
    this.name = "InvalidRegistrarEndpointError";
    this.issues = issues;
  }
}

/** A credential provider supplied a header we will not send. */
export class ForbiddenTransportHeaderError extends RegistrarTransportError {
  readonly headerNames: string[];
  constructor(headerNames: string[]) {
    super(
      "FORBIDDEN_TRANSPORT_HEADER",
      "One or more supplied headers are not permitted on a Registrar request",
    );
    this.name = "ForbiddenTransportHeaderError";
    this.headerNames = headerNames;
  }
}

/** The credential provider returned nothing usable. The value is never echoed. */
export class MissingRegistrarCredentialsError extends RegistrarTransportError {
  readonly issues: string[];
  constructor(issues: string[] = []) {
    super("MISSING_REGISTRAR_CREDENTIALS", "No usable Registrar credentials were provided");
    this.name = "MissingRegistrarCredentialsError";
    this.issues = issues;
  }
}

/** The request could not be built or serialised, so nothing was sent. */
export class RegisterRequestContractFailureError extends RegistrarTransportError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super("REGISTER_REQUEST_CONTRACT_FAILURE", "The REGISTER request failed its contract");
    this.name = "RegisterRequestContractFailureError";
    this.issues = issues;
  }
}

/** The attempt or its claim is not in a state that permits sending. */
export class DispatchStateConflictError extends RegistrarTransportError {
  readonly conflictingFields: string[];
  constructor(message: string, conflictingFields: string[]) {
    super("DISPATCH_STATE_CONFLICT", message);
    this.name = "DispatchStateConflictError";
    this.conflictingFields = conflictingFields;
  }
}
