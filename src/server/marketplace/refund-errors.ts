/**
 * Refund and tax-reversal errors (Phase 1.9).
 *
 * The four rules `0M.9`'s errors follow, inherited unchanged, plus one this phase
 * has particular reason to restate:
 *
 *   1. **No error carries private data**, and none carries a monetary value. An
 *      amount in an error message puts a party's economics into a log nobody
 *      decided to publish them in — and a refund amount is also a purchase
 *      amount.
 *   2. **Internal causes are non-enumerable**, so `JSON.stringify(error)` cannot
 *      leak a driver message or a connection string.
 *   3. **No error carries a provider reference.** A charge or refund id is
 *      external evidence tying Monacado's record to a movement of money, and a
 *      reference in an error message is a reference in a log aggregator.
 *   4. **No error carries buyer identity.**
 *
 * And the fifth, particular to refunds: **no error carries a refusal narrative**.
 * A refund refusal is a bounded `RefundRefusalCode` and nothing else. The moment
 * an error can carry prose about *why* a refund was declined, it becomes the
 * place a support agent's opinion about a customer is written down.
 */

import { attachInternalCause } from "../product/error-cause";
import type { RefundRefusalCode } from "../../contracts/marketplace/order-refund";

export type RefundErrorCode =
  | "INVALID_REFUND_INPUT"
  | "REFUND_NOT_FOUND"
  | "REFUND_REFUSED"
  | "REFUND_ALREADY_EXISTS"
  | "TAX_REVERSAL_NOT_FOUND"
  | "REFUND_REQUEUE_REFUSED"
  | "PROCEEDS_RECOVERY_NOT_FOUND"
  | "INVALID_PROCEEDS_RECOVERY_TRANSITION"
  | "CORRUPT_REFUND_RECORD"
  | "CORRUPT_TAX_REVERSAL_RECORD"
  | "CORRUPT_PROCEEDS_RECOVERY_RECORD"
  | "REFUND_PERSISTENCE_FAILURE";

export class RefundError extends Error {
  readonly code: RefundErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: RefundErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "RefundError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * A refund request was refused before any provider was contacted.
 *
 * Carries **every** refusal, not the first — the same rule the risk gate and the
 * readiness check follow. An Order that is both unpaid *and* missing a provider
 * reference has two problems, and reporting one would send an operator back for
 * the second.
 *
 * The message names the codes and nothing else: no amount, no charge reference,
 * no buyer, and no sentence explaining Monacado's commercial reasoning.
 */
export class RefundRefusedError extends RefundError {
  readonly refusals: readonly RefundRefusalCode[];
  constructor(refusals: readonly RefundRefusalCode[]) {
    super("REFUND_REFUSED", `This Order may not be refunded: ${refusals.join(", ")}`);
    this.name = "RefundRefusedError";
    this.refusals = refusals;
  }
}

/**
 * A second refund was requested for one Order.
 *
 * A **refusal**, never treated as idempotent, and the asymmetry with `0M.9`'s
 * payment replay is intentional — `1.2` drew it first: a repeated payment
 * confirmation is a provider redelivering one fact, whereas a second refund of
 * one sale is either a duplicate credit or a partial refund arriving under the
 * wrong name. Both deserve to be surfaced.
 *
 * Note that this is distinct from a *retried* refund. Retrying an existing
 * refund row is idempotent by construction, through a stable provider
 * idempotency key; what is refused here is a second refund **record**.
 */
export class RefundAlreadyExistsError extends RefundError {
  constructor() {
    super("REFUND_ALREADY_EXISTS", "This Order has already been refunded");
    this.name = "RefundAlreadyExistsError";
  }
}

export class RefundNotFoundError extends RefundError {
  constructor() {
    super("REFUND_NOT_FOUND", "No such refund");
    this.name = "RefundNotFoundError";
  }
}

export class TaxReversalNotFoundError extends RefundError {
  constructor() {
    super("TAX_REVERSAL_NOT_FOUND", "No such tax reversal");
    this.name = "TaxReversalNotFoundError";
  }
}

/**
 * An operator requeue was refused.
 *
 * `reason` is a bounded code an operator tool renders beside the failure, so the
 * next action can be named rather than guessed at. `1.8`'s rule, unchanged: a
 * retry button that does nothing is worse than no button.
 */
export class RefundRequeueRefusedError extends RefundError {
  readonly reason: string;
  constructor(reason: string) {
    super("REFUND_REQUEUE_REFUSED", `This refund work may not be requeued: ${reason}`);
    this.name = "RefundRequeueRefusedError";
    this.reason = reason;
  }
}

export class ProceedsRecoveryNotFoundError extends RefundError {
  constructor() {
    super("PROCEEDS_RECOVERY_NOT_FOUND", "No such proceeds recovery exception");
    this.name = "ProceedsRecoveryNotFoundError";
  }
}

export class InvalidProceedsRecoveryTransitionError extends RefundError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(
      "INVALID_PROCEEDS_RECOVERY_TRANSITION",
      `A proceeds recovery exception cannot move from ${from} to ${to}`,
    );
    this.name = "InvalidProceedsRecoveryTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class RefundPersistenceFailureError extends RefundError {
  readonly operation: string;
  constructor(operation: string, internalCause?: unknown) {
    super("REFUND_PERSISTENCE_FAILURE", `Refund persistence failed: ${operation}`, internalCause);
    this.name = "RefundPersistenceFailureError";
    this.operation = operation;
  }
}

export function isRefundError(error: unknown): error is RefundError {
  return error instanceof RefundError;
}
