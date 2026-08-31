/**
 * Participant standing enforcement errors (Phase 1.15).
 *
 * The same two rules every error module here follows — no error carries private
 * data, internal causes are non-enumerable — plus the rule this domain needs
 * most:
 *
 *   **A denial never explains the decision behind it.** It says the action is
 *   unavailable and which of the two governed states caused that
 *   (`PARTICIPANT_SUSPENDED` or `ACTION_RESTRICTED`), and stops. The reason code
 *   on the restriction, the risk review it was imposed under, the rates that
 *   informed it, and the operator's rationale are all absent by construction:
 *   none of them is a field on any error below.
 *
 * This matters more here than elsewhere because a denial travels further than a
 * restriction record does. It reaches logs, an operator console, and — once
 * collapsed by the surfaces that face buyers — the public internet. An error
 * that carried the reason would make every checkout attempt a probe for a
 * counterparty's standing.
 */

import { attachInternalCause } from "../product/error-cause";
import type { ParticipantActionDenialCode } from "../../contracts/marketplace/restriction-enforcement";

export type ParticipantStandingErrorCode =
  | "PARTICIPANT_ACTION_NOT_PERMITTED"
  | "PARTICIPANT_STANDING_PERSISTENCE_FAILURE";

export class ParticipantStandingError extends Error {
  readonly code: ParticipantStandingErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: ParticipantStandingErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "ParticipantStandingError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * A governed action was refused because of the participant's standing.
 *
 * `denialCode` distinguishes suspension from restriction, because the two are
 * different acts with different remedies and an operator told the milder one
 * about the heavier would misjudge what the participant has to do next.
 *
 * `deniedCapability` names the marketplace capability the ACTION required — a
 * member of the closed scope vocabulary, decided by the seam rather than read
 * off the participant's records. It deliberately does **not** enumerate which
 * restrictions the participant holds: the caller learns that this action is
 * unavailable, never the shape of everything else being withheld.
 */
export class ParticipantActionNotPermittedError extends ParticipantStandingError {
  readonly denialCode: ParticipantActionDenialCode;
  readonly deniedCapability: string | null;
  constructor(denialCode: ParticipantActionDenialCode, deniedCapability: string | null = null) {
    super("PARTICIPANT_ACTION_NOT_PERMITTED", "This action is not available for this participant");
    this.name = "ParticipantActionNotPermittedError";
    this.denialCode = denialCode;
    this.deniedCapability = deniedCapability;
  }
}

export class ParticipantStandingPersistenceFailureError extends ParticipantStandingError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super(
      "PARTICIPANT_STANDING_PERSISTENCE_FAILURE",
      "A participant standing read failed",
      cause,
    );
    this.name = "ParticipantStandingPersistenceFailureError";
    this.stage = stage;
  }
}
