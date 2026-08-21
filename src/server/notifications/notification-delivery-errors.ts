/**
 * Delivery errors (Phase 1.1) — SERVER ONLY.
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

export class InvalidDeliveryInputError extends NotificationDeliveryServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_DELIVERY_INPUT", "Invalid notification delivery input");
    this.name = "InvalidDeliveryInputError";
    this.fields = fields;
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
