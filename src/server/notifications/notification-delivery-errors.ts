/**
 * `NotificationDelivery` errors — **LEGACY, READ-ONLY** (Phase 1.1; writer
 * retired in Phase 1.5). SERVER ONLY.
 *
 * ```
 *   LEGACY / READ-ONLY.  NO NEW EMAIL DELIVERY WRITES.
 *   Use `outbound-email-errors.ts` and `OutboundEmailDelivery` instead.
 * ```
 *
 * Only what the historical **reads** and the mapper still raise. The write-path
 * error went with the writer.
 *
 * Bounded, and deliberately few. **No error here carries a destination address,
 * a rendered body, or a provider message** — an error object is the first place
 * private detail leaks into a log, and this subsystem exists precisely to keep
 * an address out of storage.
 */

import "../server-only";

export class NotificationDeliveryServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NotificationDeliveryServiceError";
    this.code = code;
  }
}

export class DeliveryPersistenceFailureError extends NotificationDeliveryServiceError {
  readonly operation: string;
  readonly cause?: unknown;
  constructor(operation: string, cause?: unknown) {
    super("DELIVERY_PERSISTENCE_FAILURE", `Notification delivery failed to persist: ${operation}`);
    this.name = "DeliveryPersistenceFailureError";
    this.operation = operation;
    this.cause = cause;
  }
}
