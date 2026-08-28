/**
 * Stable dispute-evidence idempotency keys (Phase 1.12) — SERVER ONLY.
 *
 * The same question `refund-idempotency` asks — *is this the same request we
 * already made?* — with one difference that inverts the answer.
 *
 * ## Why the refund key's shape would be a bug here
 *
 * A refund has exactly one logical request, so `1.9` keys on the refund row's
 * own identity and every retry of every attempt reuses it. That is correct
 * there and **wrong here.**
 *
 * A dispute legitimately produces several distinct requests to the same
 * provider URL: stage evidence, revise it, then finalise. A key derived from the
 * dispute alone would make the second request return the *first* one's cached
 * response — HTTP 200, a plausible dispute object, and the revision silently
 * never applied. No error, no failed assertion, and no evidence at the bank.
 * That failure is invisible in a way a duplicate refund is not, which is why the
 * key is derived from the **logical request** rather than from the dispute.
 *
 * ## Three inputs, all durable
 *
 * `revision` is a persisted column, not a counter held in memory. It has to
 * survive a crash so that a retry after one reuses the key rather than minting a
 * fresh request against a one-shot endpoint.
 *
 * `finalSubmission` is an input because staging and finalising are different
 * acts against the same resource. Sharing a key between them would let a stage
 * return a finalise's cached result, or the reverse.
 *
 * ## It discloses nothing
 *
 * Every input is an opaque Monacado or provider identifier plus two scalars.
 * What leaves is 64 hex characters behind a namespace. No amount, buyer, reason,
 * or address is an input, so none can be recovered from the output.
 */

import "../server-only";
import { createHash } from "node:crypto";
import { canonicalJsonString } from "../../contracts/integrity/canonical-json";

/** Namespaces the key so it can never collide with a refund, tax, or payment key. */
export const DISPUTE_EVIDENCE_IDEMPOTENCY_KEY_PREFIX = "mon-dsevd-";

export function disputeEvidenceIdempotencyKey(input: {
  disputeId: string;
  providerDisputeRef: string;
  revision: number;
  finalSubmission: boolean;
}): string {
  const material = canonicalJsonString({
    disputeId: input.disputeId,
    providerDisputeRef: input.providerDisputeRef,
    revision: input.revision,
    finalSubmission: input.finalSubmission,
  });
  return `${DISPUTE_EVIDENCE_IDEMPOTENCY_KEY_PREFIX}${createHash("sha256")
    .update(material)
    .digest("hex")}`;
}
