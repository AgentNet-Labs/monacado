/**
 * Opaque identity generation for the Order and post-sale records (Phase 0M.9) —
 * SERVER ONLY.
 *
 * Same construction as every other identity provider in this repository:
 * `crypto.randomBytes` over the Crockford alphabet, `byte % 32` bias-free because
 * 256 is an exact multiple of the 32-character alphabet.
 *
 * None of these identifiers encodes anything. An order id carries no buyer, no
 * amount, no date, and no sequence — an identifier that encoded a buyer would be
 * a buyer identifier, and this phase's whole premise is that Monacado holds as
 * little about a buyer as a commercial record can function on.
 *
 * A **provider transaction reference is never minted here**: it is an external
 * string an adapter returns, and generating one would mean Monacado had invented
 * evidence of a payment nobody executed. A **guest claim code** is not minted
 * here either — it is a credential, not an identifier, and it lives in
 * `guest-claim-code.ts` where its digest rule lives with it.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import {
  ORDER_ID_RE,
  PROCEEDS_OBLIGATION_ID_RE,
  PURCHASE_EVIDENCE_ID_RE,
  REVIEW_SUBMISSION_AUTHORITY_ID_RE,
  REVIEW_SUBMISSION_ID_RE,
} from "../../contracts/marketplace/identity";

const OPAQUE_BODY_LENGTH = 26;

function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/** Injectable identity source; a test supplies deterministic ids. */
export interface OrderIdProvider {
  nextOrderId(): string;
  nextProceedsObligationId(): string;
  nextPurchaseEvidenceId(): string;
  /**
   * The submission and its authority are minted together because 0M.1 binds them
   * one-to-one: the submission IS the grant, so one existing without the other
   * would be either an ungranted review or a grant over nothing.
   */
  nextReviewSubmissionId(): string;
  nextReviewSubmissionAuthorityId(): string;
}

export const cryptoOrderIdProvider: OrderIdProvider = {
  nextOrderId: () => `mon:order:${randomOpaqueBody()}`,
  nextProceedsObligationId: () => `mon:pobl:${randomOpaqueBody()}`,
  nextPurchaseEvidenceId: () => `mon:pvev:${randomOpaqueBody()}`,
  nextReviewSubmissionId: () => `mon:rsub:${randomOpaqueBody()}`,
  nextReviewSubmissionAuthorityId: () => `mon:rauth:${randomOpaqueBody()}`,
};

/** Shapes asserted by a test rather than guarded at runtime — they hold by construction. */
export const ORDER_ID_PATTERNS = {
  order: ORDER_ID_RE,
  proceedsObligation: PROCEEDS_OBLIGATION_ID_RE,
  purchaseEvidence: PURCHASE_EVIDENCE_ID_RE,
  reviewSubmission: REVIEW_SUBMISSION_ID_RE,
  reviewSubmissionAuthority: REVIEW_SUBMISSION_AUTHORITY_ID_RE,
} as const;
