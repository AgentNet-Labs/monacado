/**
 * Notice of a governed decision about a participant (Phase 1.14) — SERVER ONLY.
 *
 * ## The obligation IS the notice
 *
 * 0M.N1's rule holds: an obligation is the record that Monacado OWES a notice,
 * and the participant's Monacado account is the canonical channel. This phase
 * sends no email. That is not an omission — no verified contact is guaranteed
 * after activation, a suppressed address fails permanently, and "a channel
 * outside Monacado's control cannot be the system of record for an obligation."
 * A notice that depended on mail would be a notice that silently did not happen.
 * Marketplace Policy 1.3.0 is worded to match: it says a notice is recorded and
 * made available, and promises no email and no advance warning.
 *
 * ## Written in the same transaction as the decision
 *
 * A participant restricted with no notice owed, or told about a restriction that
 * rolled back, are both worse than one insert more in the transaction — which is
 * the reason `upsertObligationInTx` is exported at all.
 *
 * ## The subject is the DECISION, never the participant
 *
 * `notificationObligationKey` hashes recipient, category, subject, and context.
 * With the participant as subject, two decisions about one participant sharing a
 * context code would collapse into ONE obligation and the second would silently
 * never be raised — verbatim the collision the dispute notices were written to
 * avoid. So the subject ref is the restriction or suspension id.
 *
 * ## What a notice carries
 *
 * The decision, what it withheld, when it took effect, and the bounded reason
 * CATEGORY. Never the observation, rate, threshold, score, ranking, or review
 * policy behind it — 1.2.0's standing term that "the classifications and the
 * evidence behind such a decision are private operational records", extended
 * from a transaction to a participant. The obligation model structurally cannot
 * carry them anyway: it has no body, no subject line, and no rendered content.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import type { ParticipantDecisionContextCode } from "../../contracts/marketplace/notification-obligation";
import { upsertObligationInTx } from "./notification-obligation-service";

export interface ParticipantDecisionNoticeInput {
  participantId: string;
  /** The restriction or suspension id. NEVER the participant id — see header. */
  decisionId: string;
  contextCode: ParticipantDecisionContextCode;
  obligationId: string;
  at: string;
}

/**
 * Record that a participant is owed notice of a decision about their standing.
 *
 * Idempotent by the derived obligation key, so replaying the imposing path
 * raises one obligation rather than a second, and an already-acknowledged
 * obligation is not returned to unread.
 */
export async function recordParticipantDecisionNoticeInTx(
  tx: Prisma.TransactionClient,
  input: ParticipantDecisionNoticeInput,
): Promise<void> {
  await upsertObligationInTx(tx, {
    id: input.obligationId,
    recipientParticipantId: input.participantId,
    category: "PARTICIPANT_STANDING_CHANGED",
    subject: { kind: "PARTICIPANT_DECISION", ref: input.decisionId, versionRef: null },
    contextCode: input.contextCode,
    createdAt: input.at,
  });
}
