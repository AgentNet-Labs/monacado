/**
 * Sign-in throttle errors (Phase 1.23) — SERVER ONLY.
 *
 * Two faults, both of which mean the same thing to a caller: Monacado cannot
 * currently count sign-in attempts, so it will not verify a password. The route
 * collapses both to one bounded 503 and tells the caller nothing further.
 *
 * **No error here carries a Redis URL, a REST token, a pepper, a throttle key, a
 * normalised address, a counter value, or a provider message.** An error object
 * is the first place private detail reaches a log, and this subsystem exists to
 * keep an address out of shared storage in the first place — leaking one back out
 * through a stack trace would undo the whole point.
 */

import "../server-only";
import { attachInternalCause } from "../product/error-cause";

export type SignInThrottleErrorCode =
  | "SIGN_IN_THROTTLE_CONFIGURATION_INVALID"
  | "SIGN_IN_THROTTLE_BACKEND_UNAVAILABLE";

export class SignInThrottleError extends Error {
  readonly code: SignInThrottleErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: SignInThrottleErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "SignInThrottleError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * The throttle backend is not configured, or is configured incorrectly.
 *
 * Names the **fields** at fault, never their values — the same construction
 * `MailConfigurationError` uses.
 */
export class SignInThrottleConfigurationError extends SignInThrottleError {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(
      "SIGN_IN_THROTTLE_CONFIGURATION_INVALID",
      `Sign-in throttle configuration is invalid: ${issues.join(", ")}`,
    );
    this.name = "SignInThrottleConfigurationError";
    this.issues = issues;
  }
}

/**
 * The throttle backend was reachable in principle and did not answer usefully:
 * a network fault, a timeout, an authentication refusal, or a malformed reply.
 *
 * The provider's own message is retained only on the non-enumerable internal
 * cause, so `JSON.stringify(error)` cannot leak it.
 */
export class SignInThrottleUnavailableError extends SignInThrottleError {
  constructor(cause?: unknown) {
    super(
      "SIGN_IN_THROTTLE_BACKEND_UNAVAILABLE",
      "The sign-in throttle backend is unavailable",
      cause,
    );
    this.name = "SignInThrottleUnavailableError";
  }
}
