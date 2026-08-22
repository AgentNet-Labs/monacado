/**
 * Policy, acceptance, and verification errors (Phase 1.3) — SERVER ONLY.
 *
 * Bounded and few. **No error carries an email address, a token, or policy
 * prose** — an error object is the first place a credential reaches a log, and a
 * verification failure is exactly the message somebody probing would read.
 */

import "../server-only";

export class PolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

export class PolicyVersionNotFoundError extends PolicyError {
  constructor() {
    super("POLICY_VERSION_NOT_FOUND", "No such marketplace policy version");
    this.name = "PolicyVersionNotFoundError";
  }
}

export class NoActivePolicyError extends PolicyError {
  constructor() {
    super("NO_ACTIVE_MARKETPLACE_POLICY", "No marketplace policy version is currently active");
    this.name = "NoActivePolicyError";
  }
}

/**
 * The stored content hash and the source document disagree.
 *
 * The failure this whole binding exists to detect: prose moved without a version
 * bump, so what a participant accepted is no longer what the source says. Refused
 * loudly rather than served, because serving it would publish terms nobody
 * governed.
 */
export class PolicyContentMismatchError extends PolicyError {
  readonly policyVersion: string;
  constructor(policyVersion: string) {
    super(
      "POLICY_CONTENT_MISMATCH",
      "The stored policy content hash does not match the source document",
    );
    this.name = "PolicyContentMismatchError";
    this.policyVersion = policyVersion;
  }
}

/**
 * A verification challenge could not be consumed.
 *
 * **Every refusal is the same error with a bounded reason**, and the reasons do
 * not distinguish "no such token" from "wrong participant": the same reasoning
 * `claimGuestOrder` applies, since distinguishing them makes this an oracle for
 * probing which tokens exist.
 */
export class VerificationRefusedError extends PolicyError {
  readonly reason: "INVALID_OR_EXPIRED" | "ALREADY_CONSUMED";
  constructor(reason: "INVALID_OR_EXPIRED" | "ALREADY_CONSUMED") {
    super("VERIFICATION_REFUSED", "That verification link is not valid");
    this.name = "VerificationRefusedError";
    this.reason = reason;
  }
}

export class PolicyPersistenceFailureError extends PolicyError {
  readonly operation: string;
  readonly cause?: unknown;
  constructor(operation: string, cause?: unknown) {
    super("POLICY_PERSISTENCE_FAILURE", `Policy persistence failed: ${operation}`);
    this.name = "PolicyPersistenceFailureError";
    this.operation = operation;
    this.cause = cause;
  }
}
