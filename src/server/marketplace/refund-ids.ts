/**
 * Opaque identity for refunds and their consequences (Phase 1.9) — SERVER ONLY.
 *
 * The same construction as every other identity provider here. A refund id
 * encodes nothing — not the Order, the amount, the reason, the buyer, or the
 * provider's own reference.
 *
 * **A provider refund reference is never minted here.** It is an external string
 * Stripe returns, and generating one would mean Monacado had invented evidence
 * that money went back.
 *
 * The lock token is a *claim* credential, not an identity: it is compared, never
 * published, and a new one is minted for every claim.
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

export interface RefundIdProvider {
  nextRefundId(): string;
  nextTaxReversalId(): string;
  nextProceedsRecoveryExceptionId(): string;
  /**
   * The `1.2` accounting entry's identity.
   *
   * Minted here rather than by `1.2`'s own provider because the entry is created
   * inside this phase's transaction, and a test that drives a refund end to end
   * should not have to inject two id providers to get one deterministic run.
   */
  nextReversalId(): string;
  /**
   * One seller's stable refund-policy identity (Phase 1.9 correction).
   *
   * Minted here rather than by a policy module of its own for the same reason
   * `nextReversalId` is: a test that drives seller onboarding through to a refund
   * should not have to inject a fourth id provider to get one deterministic run.
   */
  nextSellerRefundPolicyId(): string;
  nextLockToken(): string;
}

export const cryptoRefundIdProvider: RefundIdProvider = {
  nextRefundId: () => `mon:refnd:${randomOpaqueBody()}`,
  nextTaxReversalId: () => `mon:txrvs:${randomOpaqueBody()}`,
  nextProceedsRecoveryExceptionId: () => `mon:precx:${randomOpaqueBody()}`,
  nextReversalId: () => `mon:txrev:${randomOpaqueBody()}`,
  nextSellerRefundPolicyId: () => `mon:srpol:${randomOpaqueBody()}`,
  nextLockToken: () => randomBytes(24).toString("hex"),
};
