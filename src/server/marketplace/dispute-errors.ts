/**
 * Dispute errors (Phase 1.11).
 *
 * The five rules `1.9`'s refund errors follow, inherited unchanged, and each of
 * them bites harder here:
 *
 *   1. **No error carries a monetary value.** A disputed amount is a purchase
 *      amount, and also a statement about what a specific buyer is contesting.
 *   2. **Internal causes are non-enumerable**, so `JSON.stringify(error)` cannot
 *      leak a driver message or a connection string.
 *   3. **No error carries a provider reference.** A dispute id in a thrown error
 *      is a dispute id in a log aggregator.
 *   4. **No error carries buyer identity.** A dispute event is the single
 *      richest source of it that reaches this system.
 *   5. **No error carries a narrative.** A dispute refusal is a bounded code and
 *      nothing else. The moment an error can hold prose about *why* a dispute
 *      could not be processed, it becomes where somebody writes down what they
 *      think of the cardholder.
 */

import { attachInternalCause } from "../product/error-cause";
import type { DisputeRemediationCode } from "../../contracts/marketplace/transaction-dispute";

export type DisputeErrorCode =
  | "INVALID_DISPUTE_INPUT"
  | "DISPUTE_NOT_FOUND"
  | "INVALID_DISPUTE_TRANSITION"
  | "DISPUTE_REMEDIATION_REQUIRED"
  | "CORRUPT_DISPUTE_RECORD"
  | "DISPUTE_PERSISTENCE_FAILURE";

export class DisputeError extends Error {
  readonly code: DisputeErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: DisputeErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "DisputeError";
    this.code = code;
    if (internalCause !== undefined) attachInternalCause(this, internalCause);
  }
}

export class InvalidDisputeInputError extends DisputeError {
  constructor(message = "The dispute observation was not valid", internalCause?: unknown) {
    super("INVALID_DISPUTE_INPUT", message, internalCause);
    this.name = "InvalidDisputeInputError";
  }
}

export class DisputeNotFoundError extends DisputeError {
  constructor() {
    super("DISPUTE_NOT_FOUND", "No such dispute");
    this.name = "DisputeNotFoundError";
  }
}

export class InvalidDisputeTransitionError extends DisputeError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super("INVALID_DISPUTE_TRANSITION", "That dispute status transition is not permitted");
    this.name = "InvalidDisputeTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Monacado recorded the dispute and will not act on it automatically.
 *
 * Carries a bounded remediation code and nothing else. Notably this is **not**
 * thrown out of the webhook path: a dispute that needs a human is still a
 * dispute that was successfully recorded, and turning that into a 500 would make
 * the provider retry an event Monacado has already stored correctly.
 */
export class DisputeRemediationRequiredError extends DisputeError {
  readonly remediationCode: DisputeRemediationCode;
  constructor(remediationCode: DisputeRemediationCode) {
    super("DISPUTE_REMEDIATION_REQUIRED", "This dispute requires an operator");
    this.name = "DisputeRemediationRequiredError";
    this.remediationCode = remediationCode;
  }
}

export class CorruptDisputeRecordError extends DisputeError {
  constructor(message = "A stored dispute record did not match its contract", internalCause?: unknown) {
    super("CORRUPT_DISPUTE_RECORD", message, internalCause);
    this.name = "CorruptDisputeRecordError";
  }
}

export class DisputePersistenceFailureError extends DisputeError {
  readonly operation: string;
  constructor(operation: string, internalCause?: unknown) {
    super("DISPUTE_PERSISTENCE_FAILURE", "A dispute operation could not be completed", internalCause);
    this.name = "DisputePersistenceFailureError";
    this.operation = operation;
  }
}
