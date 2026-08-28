/**
 * Opaque identity for disputes and their provider events (Phase 1.11) —
 * SERVER ONLY.
 *
 * The same construction as every other identity provider here. A dispute id
 * encodes nothing — not the Order, the amount, the reason, the outcome, the
 * buyer, or the provider's own reference.
 *
 * **A provider dispute reference is never minted here.** It is an external
 * string the provider issues, and generating one would mean Monacado had
 * invented evidence that a bank reversed a payment.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";

const OPAQUE_BODY_LENGTH = 26;

function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

export interface DisputeIdProvider {
  nextDisputeId(): string;
  nextDisputeEventId(): string;
  /**
   * The `1.2` accounting entry's identity, for a lost dispute.
   *
   * Minted here for the reason `refund-ids` mints it too: the entry is created
   * inside this phase's transaction, and a test driving a dispute end to end
   * should not have to inject two id providers to get one deterministic run.
   */
  nextReversalId(): string;
  /** The recovery exception a dispute raises against an already-paid claim. */
  nextProceedsRecoveryExceptionId(): string;
  /** One item of evidence assembled for a dispute (Phase 1.12). */
  nextDisputeEvidenceItemId(): string;
  /** One governed evidence package prepared for a dispute (Phase 1.12). */
  nextDisputeEvidencePreparationId(): string;
  /** The seller fee a finalized lost chargeback assesses (Phase 1.12). */
  nextSellerChargebackFeeId(): string;
}

export const cryptoDisputeIdProvider: DisputeIdProvider = {
  nextDisputeId: () => `mon:dspt:${randomOpaqueBody()}`,
  nextDisputeEventId: () => `mon:dsevt:${randomOpaqueBody()}`,
  nextReversalId: () => `mon:txrev:${randomOpaqueBody()}`,
  nextProceedsRecoveryExceptionId: () => `mon:precx:${randomOpaqueBody()}`,
  nextDisputeEvidenceItemId: () => `mon:evitm:${randomOpaqueBody()}`,
  nextDisputeEvidencePreparationId: () => `mon:evprp:${randomOpaqueBody()}`,
  nextSellerChargebackFeeId: () => `mon:cbfee:${randomOpaqueBody()}`,
};
