/**
 * Receipt ingestion errors (Phase 0E.6.4).
 *
 * Only two. The ingestion boundary delegates almost everything to the Phase
 * 0E.4 receipt service, which already reports attempt-not-found, attempt-not-
 * dispatched, attempt-abandoned, attempt-already-answered, binding mismatch, and
 * replay conflict with precise names. Re-raising those under new names would
 * give one fault two vocabularies and force callers to catch both.
 *
 * What is genuinely new is exactly two things: a malformed external envelope,
 * and a Registrar identity that disagrees with trusted runtime context.
 *
 * A transport response that is not an authoritative receipt is deliberately NOT
 * an error. Most REGISTER responses are legitimately acknowledgements rather
 * than receipts, so the mapper returns a refusal VALUE naming the missing
 * fields. An error class for it was written and removed as unreachable.
 *
 * Errors carry codes and field names only — never the receipt body, a hash
 * value, a payload, a credential, a token, an endpoint, or a raw Prisma/Zod
 * message. Internal causes use the shared non-enumerable pattern.
 */

import { attachInternalCause } from "./error-cause";

export type ReceiptIngestionErrorCode =
  | "INVALID_RECEIPT_ENVELOPE"
  | "EXPECTED_REGISTRAR_MISMATCH";

export class ReceiptIngestionError extends Error {
  readonly code: ReceiptIngestionErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: ReceiptIngestionErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "ReceiptIngestionError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * The external envelope is malformed, or carries a field it must not.
 *
 * `fields` names paths only. The offending VALUE is never echoed: an envelope
 * rejected for smuggling a `payload` or a `lockToken` is exactly the case where
 * echoing it would write the smuggled material into a log.
 */
export class InvalidReceiptEnvelopeError extends ReceiptIngestionError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_RECEIPT_ENVELOPE", "The external Registrar receipt envelope is invalid");
    this.name = "InvalidReceiptEnvelopeError";
    this.fields = fields;
  }
}

/**
 * Trusted runtime context expects a different Registrar than the one the attempt
 * was addressed to.
 *
 * Compared against the attempt's IMMUTABLE `registrarId`, not the envelope's —
 * checking the envelope against itself would prove only that it is internally
 * consistent, which a forged envelope also is. Neither identifier is echoed.
 */
export class ExpectedRegistrarMismatchError extends ReceiptIngestionError {
  constructor(message = "The receipt does not come from the expected Registrar") {
    super("EXPECTED_REGISTRAR_MISMATCH", message);
    this.name = "ExpectedRegistrarMismatchError";
  }
}
