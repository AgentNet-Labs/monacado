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

/**
 * Internal Offer identifier (`mon:offer:<opaque>`).
 *
 * The enduring identity of one authoritative Offer record, in the same internal
 * form as `mon:product:` and `mon:creator:`. It is **not** an ANS Node ID and not
 * a capsule ID: the public identity an Offer may eventually carry is issued by
 * the Registrar and mapped in a later phase (ADR §11.5).
 */
export const INTERNAL_OFFER_ID_RE = new RegExp(`^mon:offer:${OPAQUE_BODY}$`);

/**
 * Internal Storefront identifier (`mon:storefront:<opaque>`).
 *
 * The enduring identity of one authoritative Storefront record. Like
 * `mon:offer:`, it is **not** an ANS Node ID, **not** a capsule identity, and
 * **not** a public URL — the storefront's public routing name is a separate
 * `publicHandle`, and any public Node is Registrar-issued in a later phase.
 */
export const INTERNAL_STOREFRONT_ID_RE = new RegExp(`^mon:storefront:${OPAQUE_BODY}$`);

/**
 * Internal Listing identifier (`mon:listing:<opaque>`).
 *
 * The enduring identity of one authoritative Listing record — the buyer-facing
 * placement of a Product in a Storefront. Like `mon:offer:` and
 * `mon:storefront:`, it is **not** an ANS Node ID and **not** a capsule identity:
 * a Listing's public identity, if it is ever warranted, is Registrar-issued and
 * mapped in a later phase (ADR §11.5).
 *
 * It encodes neither the storefront, the product, the listing type, nor the
 * controlling participant. A Listing that changed hands or type would otherwise
 * carry a lie in its own identifier.
 */
export const INTERNAL_LISTING_ID_RE = new RegExp(`^mon:listing:${OPAQUE_BODY}$`);

/**
 * One Storefront governance assignment (`mon:sgov:<opaque>`).
 *
 * Names one appointment of one participant to `SUPER_OWNER` or `ADMIN` on one
 * Storefront. Operational only — governance is never published, because who
 * administers a storefront is nobody's business but the marketplace's
 * (0M.3A `NEVER_PROJECTION_ELIGIBLE_STOREFRONT_DATA`).
 */
export const STOREFRONT_GOVERNANCE_ASSIGNMENT_ID_RE = new RegExp(`^mon:sgov:${OPAQUE_BODY}$`);

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

/**
 * Stable commercial-policy identity (`mon:cpol:<opaque>`) — Phase 0M.R1.
 *
 * The enduring identity of one Monacado wholesale-acquisition policy, and
 * exactly what `MonacadoWholesaleAcquisitionPolicy.policyId` carries. Its
 * *versions* have no opaque identity of their own: they are keyed by
 * `(policyId, policyVersion)`, the same composite the Offer source versions use,
 * so a future transaction binds to a pair that cannot drift onto "whatever is
 * current".
 *
 * Operational only. Not a Node, not a capsule identity, never published.
 */
export const COMMERCIAL_POLICY_ID_RE = new RegExp(`^mon:cpol:${OPAQUE_BODY}$`);

/**
 * One governed participant restriction (`mon:prst:<opaque>`) — Phase 0M.R1.
 *
 * The machine-readable evidence behind `MarketplaceParticipant.status =
 * RESTRICTED`. Operational only, never published: which participant is
 * restricted and why is nobody's business but the marketplace's.
 */
export const PARTICIPANT_RESTRICTION_ID_RE = new RegExp(`^mon:prst:${OPAQUE_BODY}$`);

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
