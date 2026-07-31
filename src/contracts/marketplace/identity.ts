/**
 * Marketplace identifier forms (Phase 0M.1).
 *
 * Every identifier below is an **internal Monacado operational identity**. None is
 * an ANS identity: none may be used as a Node ID, a capsule ID, or a Publisher ID
 * (ADR §11.5 — the two identifier layers are distinct and must not be conflated).
 *
 * All are opaque. A participant identifier must not encode a role, a legal name, a
 * storefront name, an email address, or an activation state — the same rule the
 * account identifier already follows, and for the same reason: an identifier that
 * carries meaning becomes a thing people read, and then a thing authorization
 * accidentally keys on.
 *
 * These are **defined here rather than added to `capsule/identity.ts`** so this
 * phase alters no committed identity code.
 */

import { OPAQUE_BODY } from "../capsule/identity";

/**
 * Marketplace participant (`mon:mpart:<opaque>`).
 *
 * Distinct from the account id by construction. One account may hold at most one
 * participant, but the identifiers are never interchangeable: the account id
 * answers "who authenticated", the participant id answers "who is transacting in
 * the marketplace", and collapsing them would make every marketplace record
 * reachable from an authentication key.
 */
export const MARKETPLACE_PARTICIPANT_ID_RE = new RegExp(`^mon:mpart:${OPAQUE_BODY}$`);

/** One role assignment on one participant (`mon:mrole:<opaque>`). */
export const MARKETPLACE_ROLE_ASSIGNMENT_ID_RE = new RegExp(`^mon:mrole:${OPAQUE_BODY}$`);

/** Private participant profile (`mon:mprof:<opaque>`). Operational only, never published. */
export const PARTICIPANT_PROFILE_ID_RE = new RegExp(`^mon:mprof:${OPAQUE_BODY}$`);

/** One activation review (`mon:mact:<opaque>`). Operational only, never published. */
export const PARTICIPANT_ACTIVATION_ID_RE = new RegExp(`^mon:mact:${OPAQUE_BODY}$`);

/**
 * Payment-provider account linkage (`mon:mpay:<opaque>`).
 *
 * Names Monacado's own row, not the provider's account. A provider identifier
 * (a Stripe `acct_…`, say) is a field on that row, never the row's identity —
 * so the generic lifecycle never becomes provider-shaped.
 */
export const PARTICIPANT_PAYMENT_ACCOUNT_ID_RE = new RegExp(`^mon:mpay:${OPAQUE_BODY}$`);

/** One buyer review submission (`mon:rsub:<opaque>`). */
export const REVIEW_SUBMISSION_ID_RE = new RegExp(`^mon:rsub:${OPAQUE_BODY}$`);

/**
 * One stored grant of review-publication authority (`mon:rauth:<opaque>`).
 *
 * This is the record ADR §11.6 requires before Monacado may publish anything on a
 * participant's behalf. It is the *evidence* of authority, not the authority
 * itself — the buyer's submission is.
 */
export const REVIEW_SUBMISSION_AUTHORITY_ID_RE = new RegExp(`^mon:rauth:${OPAQUE_BODY}$`);

/**
 * Purchase-verification evidence (`mon:pvev:<opaque>`).
 *
 * Names the private record that establishes a buyer transacted. Referenced by
 * authority checks; never published (ADR §11.10).
 */
export const PURCHASE_EVIDENCE_ID_RE = new RegExp(`^mon:pvev:${OPAQUE_BODY}$`);
