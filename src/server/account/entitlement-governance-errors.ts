/**
 * Entitlement governance errors (first-operator governance phase) — SERVER ONLY.
 *
 * One refusal class carrying a closed code, so an operator command can report
 * exactly why nothing was written without ever echoing an id, an address, or a
 * database message. Persistence failures are separate: they are worth retrying,
 * a refusal is not.
 */

import "../server-only";
import type { EntitlementGovernanceRefusal } from "../../contracts/account/entitlement-governance";
import { attachInternalCause } from "../product/error-cause";

export class EntitlementGovernanceRefusedError extends Error {
  readonly refusal: EntitlementGovernanceRefusal;
  /** The pure authorization decision's reason codes, when the actor was refused. */
  readonly reasonCodes: readonly string[];
  constructor(refusal: EntitlementGovernanceRefusal, reasonCodes: readonly string[] = []) {
    super(`Entitlement governance refused: ${refusal}`);
    this.name = "EntitlementGovernanceRefusedError";
    this.refusal = refusal;
    this.reasonCodes = reasonCodes;
  }
}

export class InvalidEntitlementGovernanceInputError extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("Invalid entitlement governance input");
    this.name = "InvalidEntitlementGovernanceInputError";
    this.fields = fields;
  }
}

export class EntitlementGovernancePersistenceFailureError extends Error {
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(operation: string, internalCause?: unknown) {
    super(`Entitlement governance persistence failure: ${operation}`);
    this.name = "EntitlementGovernancePersistenceFailureError";
    attachInternalCause(this, internalCause);
  }
}
