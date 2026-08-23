/**
 * Durable outbound email errors (Phase 1.5) — SERVER ONLY.
 *
 * Bounded and deliberately few. **No error here carries a destination address, a
 * rendered body, a provider response, or a verification token** — an error object
 * is the first place private detail reaches a log, and this subsystem exists
 * precisely to keep an address out of storage.
 */

import "../server-only";

export class OutboundEmailServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OutboundEmailServiceError";
    this.code = code;
  }
}

/** A persisted row could not be reconstructed into a valid domain record. */
export class CorruptOutboundEmailRecordError extends OutboundEmailServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("CORRUPT_OUTBOUND_EMAIL_RECORD", "A persisted outbound email record is malformed");
    this.name = "CorruptOutboundEmailRecordError";
    this.fields = fields;
  }
}

/**
 * A claim could not be resolved: it expired, was recovered, or is somebody
 * else's. Never a reason to send again — the row is already back in the queue.
 */
export class DeliveryClaimConflictError extends OutboundEmailServiceError {
  constructor() {
    super("DELIVERY_CLAIM_CONFLICT", "That outbound email claim is no longer held");
    this.name = "DeliveryClaimConflictError";
  }
}

export class OutboundEmailPersistenceFailureError extends OutboundEmailServiceError {
  readonly operation: string;
  readonly cause?: unknown;
  constructor(operation: string, cause?: unknown) {
    super("OUTBOUND_EMAIL_PERSISTENCE_FAILURE", `Outbound email persistence failed: ${operation}`);
    this.name = "OutboundEmailPersistenceFailureError";
    this.operation = operation;
    this.cause = cause;
  }
}

/** Mail configuration is invalid. Names the FIELDS at fault, never their values. */
export class MailConfigurationError extends OutboundEmailServiceError {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super("MAIL_CONFIGURATION_INVALID", `Mail configuration is invalid: ${issues.join(", ")}`);
    this.name = "MailConfigurationError";
    this.issues = issues;
  }
}
