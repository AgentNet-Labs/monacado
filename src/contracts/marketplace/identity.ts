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

import { MARKETPLACE_PARTICIPANT_ID_RE, OPAQUE_BODY } from "../capsule/identity";

/**
 * Marketplace participant (`mon:mpart:<opaque>`).
 *
 * Distinct from the account id by construction. One account may hold at most one
 * participant, but the identifiers are never interchangeable: the account id
 * answers "who authenticated", the participant id answers "who is transacting in
 * the marketplace", and collapsing them would make every marketplace record
 * reachable from an authentication key.
 */
export { MARKETPLACE_PARTICIPANT_ID_RE };

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

/**
 * One notification obligation (`mon:nobl:<opaque>`) — Phase 0M.N1.
 *
 * Names the durable record that **Monacado owes a notice**, not any message sent.
 * Delivery — email, SMS, push, or anything else — is `0M.N2` and has no identity
 * here. Operational only, never published.
 */
export const NOTIFICATION_OBLIGATION_ID_RE = new RegExp(`^mon:nobl:${OPAQUE_BODY}$`);

/**
 * Notification delivery attempt identity (`mon:ndlv:<opaque>`) — Phase 1.1.
 *
 * Distinct from `mon:nobl:`, and the distinction is the whole point: an
 * obligation is what Monacado **owes**, a delivery is what Monacado **attempted**.
 * One obligation may have several delivery attempts across channels, and a buyer
 * delivery has no obligation behind it at all. Sharing an identifier space would
 * make "was it owed?" and "was it sent?" the same question.
 */
export const NOTIFICATION_DELIVERY_ID_RE = new RegExp(`^mon:ndlv:${OPAQUE_BODY}$`);

/**
 * One durable outbound email delivery (Phase 1.5).
 *
 * Distinct from `mon:ndlv:`, which is `1.1`'s single-attempt evidence row. This
 * names a message Monacado has **committed to sending** and will keep trying to
 * send, which is a different thing with a different lifetime.
 */
export const OUTBOUND_EMAIL_DELIVERY_ID_RE = new RegExp(`^mon:oeml:${OPAQUE_BODY}$`);

/** One suppressed destination (Phase 1.5). Never encodes the address. */
export const EMAIL_SUPPRESSION_ID_RE = new RegExp(`^mon:esup:${OPAQUE_BODY}$`);

/** One ingested provider email event (Phase 1.5). */
export const PROVIDER_EMAIL_EVENT_ID_RE = new RegExp(`^mon:pevt:${OPAQUE_BODY}$`);

/**
 * Order tax evidence identity (`mon:taxe:<opaque>`) — Phase 1.2.
 *
 * Names the *evidence*, not the calculation. A provider's own calculation
 * reference is an external string recorded beside this one; conflating them
 * would make Monacado's audit record depend on a vendor's identifier space.
 */
/**
 * Order buyer snapshot identity (`mon:obsn:<opaque>`) — Phase 1.2 correction.
 *
 * Names the private transactional record of who bought one Order. Deliberately
 * distinct from every account and participant identity: a snapshot is **not an
 * identity**, not a profile, and not reusable — buying twice as a guest produces
 * two snapshots, because each records who bought *that* order.
 */
/**
 * Marketplace policy identity (`mon:mpol:<opaque>`) — Phase 1.3.
 *
 * The **stable** policy, distinct from any one version of it. Deliberately not
 * `mon:cpol:`: a commercial policy decides what Monacado *earns*, a marketplace
 * policy states what every party *undertakes*, and an Order binds both
 * separately so a fee change and a terms change can never move together.
 */
export const MARKETPLACE_POLICY_ID_RE = new RegExp(`^mon:mpol:${OPAQUE_BODY}$`);

/**
 * Participant policy acceptance identity (`mon:pacc:<opaque>`) — Phase 1.3.
 *
 * One accepted (participant × policy version × audience). Distinct from
 * `mon:pcap:`, which records Monacado's *own* clearance decision about a
 * participant — this records the participant's undertaking to Monacado, and the
 * two travel in opposite directions.
 */
export const PARTICIPANT_POLICY_ACCEPTANCE_ID_RE = new RegExp(`^mon:pacc:${OPAQUE_BODY}$`);

/** Participant email contact identity (`mon:pemc:<opaque>`) — Phase 1.3. */
export const PARTICIPANT_EMAIL_CONTACT_ID_RE = new RegExp(`^mon:pemc:${OPAQUE_BODY}$`);

/**
 * Email verification challenge identity (`mon:evch:<opaque>`) — Phase 1.3.
 *
 * Names the **challenge**, never the credential. The token itself is never an
 * identifier and never stored — only its digest.
 */
export const EMAIL_VERIFICATION_CHALLENGE_ID_RE = new RegExp(`^mon:evch:${OPAQUE_BODY}$`);

export const ORDER_BUYER_SNAPSHOT_ID_RE = new RegExp(`^mon:obsn:${OPAQUE_BODY}$`);

export const ORDER_TAX_EVIDENCE_ID_RE = new RegExp(`^mon:taxe:${OPAQUE_BODY}$`);

/**
 * Order tax transaction identity (`mon:txtax:${OPAQUE_BODY}`) — Phase 1.7.
 *
 * Distinct from `mon:taxe:`, and necessarily so. Tax evidence records **what an
 * engine was asked and answered before the buyer was charged**; a tax transaction
 * records **what was reported to the provider once the charge succeeded**. They
 * are different facts about different instants, and one of them can exist without
 * the other — a refused payment leaves evidence and no transaction. Sharing an
 * identifier space would make "was this reported?" and "what was calculated?" the
 * same question.
 */
export const ORDER_TAX_TRANSACTION_ID_RE = new RegExp(`^mon:txtax:${OPAQUE_BODY}$`);

/**
 * Transaction reversal identity (`mon:txrev:${OPAQUE_BODY}`) — Phase 1.2.
 *
 * Distinct from `mon:txsnp:`, and necessarily so: a reversal is **new
 * accounting evidence about** a snapshot, never a correction of one. Sharing an
 * identifier space would invite exactly the in-place edit `0M.T1` forbids.
 */
export const TRANSACTION_REVERSAL_ID_RE = new RegExp(`^mon:txrev:${OPAQUE_BODY}$`);

/**
 * Risk policy identity (`mon:rpol:<opaque>`) — Phase 1.2.
 *
 * Deliberately **not** `mon:cpol:`. A commercial policy decides what Monacado
 * *earns*; a risk policy decides what Monacado *permits*. Merging them would let
 * a change to one silently move the other, and an Order binds both separately.
 */
export const RISK_POLICY_ID_RE = new RegExp(`^mon:rpol:${OPAQUE_BODY}$`);

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

/**
 * One immutable per-sale economic snapshot (`mon:txsnp:<opaque>`) — Phase 0M.T1.
 *
 * Names the authoritative record of **what one sale's economics were**, bound to
 * the exact Listing source version, the exact Offer source version where the sale
 * was promoted, and the exact commercial policy version it ran under.
 *
 * It is **not** an Order identity — `0M.9` mints those and binds one to a
 * snapshot. It is not a provider transaction reference either: that is an
 * external string on the separate settlement row, never a Monacado identity
 * (ADR §11.5 keeps the two layers apart).
 *
 * Operational and financial. Not a Node, not a capsule identity, never published:
 * what any party earned on a sale is nobody's business but the counterparties'.
 */
export const TRANSACTION_ECONOMIC_SNAPSHOT_ID_RE = new RegExp(`^mon:txsnp:${OPAQUE_BODY}$`);

/**
 * One buyer Order (`mon:order:<opaque>`) — Phase 0M.9.
 *
 * The authoritative record of one buyer's purchase of one Listing: who bought,
 * what they were quoted, and where the payment got to. It is **not** the record
 * of what the sale earned each party — that is the `0M.T1` economic snapshot,
 * which binds to an Order and is never merged into it.
 *
 * Operational and financial. Not a Node, not a capsule identity, never published:
 * ADR §11.10 and the roadmap both require that buyer identity is not published by
 * default, and an order identifier is the thread that leads to it.
 */
export const ORDER_ID_RE = new RegExp(`^mon:order:${OPAQUE_BODY}$`);

/**
 * One proceeds obligation (`mon:pobl:<opaque>`) — Phase 0M.9.
 *
 * Names what Monacado **owes one party for one sale** — the seller's proceeds, or
 * a promoter's net proceeds. It is an accounting claim, never a payout: no
 * transfer, batch, schedule, or provider payout identifier has a field on it.
 *
 * Distinct from `mon:nobl:`, which names an obligation to *tell someone
 * something*. Money owed and a notice owed are different obligations and never
 * share an identifier space.
 */
export const PROCEEDS_OBLIGATION_ID_RE = new RegExp(`^mon:pobl:${OPAQUE_BODY}$`);

/**
 * One governed commerce-approval decision (`mon:pcap:<opaque>`) — Phase 0M.9.
 *
 * Names Monacado's determination that a participant may **transact** — the
 * go-live approval `0M.3A` defined as a supplied decision input and deliberately
 * refused to store as a Storefront fact. It is a decision *about a participant*,
 * recorded against the participant, so the approver's judgement never lives
 * inside the approved thing.
 *
 * Operational only, never published: whether Monacado has cleared someone to sell
 * is nobody's business but the marketplace's.
 */
export const PARTICIPANT_COMMERCE_APPROVAL_ID_RE = new RegExp(`^mon:pcap:${OPAQUE_BODY}$`);

/**
 * One buyer refund (`mon:refnd:<opaque>`) — Phase 1.9.
 *
 * Names Monacado's own authoritative record that funds were returned for one
 * Order, distinct from every provider refund identifier — a Stripe `re_…` is a
 * *field* on that row, never the row's identity, so the lifecycle never becomes
 * provider-shaped.
 *
 * Deliberately **not** `mon:txrev:`. `TransactionReversal` (Phase 1.2) is the
 * accounting entry stating what each party gave back; a refund is the
 * **execution** that produced it, with attempts, failures, and a lease. One
 * identifier space for both would make "what was given back?" and "did the
 * provider call succeed?" the same question — the same distinction `1.7` drew
 * between `mon:taxe:` and `mon:txtax:`.
 *
 * Operational only. Not a Node, not a capsule identity, never published.
 */
export const ORDER_REFUND_ID_RE = new RegExp(`^mon:refnd:${OPAQUE_BODY}$`);

/**
 * One tax reversal (`mon:txrvs:<opaque>`) — Phase 1.9.
 *
 * Names Monacado's record that a sale's *tax* was reversed with the provider,
 * which is an independently durable fact from the payment refund that occasioned
 * it: a refunded payment whose tax reversal has not succeeded is a real,
 * recoverable state, and one identifier covering both would make it
 * inexpressible.
 *
 * Distinct from `mon:txtax:`, which names the **original** report. The original
 * is never rewritten; this names the new record appended beside it.
 */
export const ORDER_TAX_REVERSAL_ID_RE = new RegExp(`^mon:txrvs:${OPAQUE_BODY}$`);

/**
 * One proceeds recovery exception (`mon:precx:<opaque>`) — Phase 1.9.
 *
 * Names the durable record that a refunded sale left a proceeds obligation
 * Monacado had **already paid**, or had already made payout-eligible. It is a
 * *seam*, not an execution: nothing here claws anything back, and the row exists
 * precisely so that the alternative — silently rewriting a settled
 * `ProceedsObligation` — is never necessary.
 *
 * Operational only, never published.
 */
export const PROCEEDS_RECOVERY_EXCEPTION_ID_RE = new RegExp(`^mon:precx:${OPAQUE_BODY}$`);

/**
 * One seller's refund policy identity (`mon:srpol:<opaque>`) — Phase 1.9.
 *
 * Deliberately **not** `mon:mpol:`. A marketplace policy states what every party
 * undertakes to Monacado and there is exactly one of them; a seller refund policy
 * is one seller's own declared terms, and there is one per seller. Sharing an
 * identifier space would make "whose terms are these?" a question you had to look
 * up rather than read.
 *
 * Also not `mon:cpol:`: a commercial policy decides what Monacado *earns*, and a
 * refund policy decides what a *seller* promises a buyer. An Order binds all
 * three separately, so a fee change, a terms change, and a seller's returns
 * change can never move together.
 *
 * Operational only. Not a Node, not a capsule identity, never published — though
 * its *reference* appears in the private Refund capsule, because "which policy
 * governed this refund" is the first question an internal audit asks.
 */
export const SELLER_REFUND_POLICY_ID_RE = new RegExp(`^mon:srpol:${OPAQUE_BODY}$`);

/**
 * Payment dispute identity (`mon:dspt:<opaque>`) — Phase 1.11.
 *
 * Distinct from `mon:txrev:` deliberately. A dispute is the PROVIDER's assertion
 * that a cardholder's bank reversed a payment; a reversal is MONACADO's own
 * accounting entry. A dispute may exist for weeks before any entry is written,
 * and a dispute that is won produces none at all — so one identifier space for
 * both would name two different facts and invite a reader to assume the second
 * whenever they saw the first.
 */
export const TRANSACTION_DISPUTE_ID_RE = new RegExp(`^mon:dspt:${OPAQUE_BODY}$`);

/**
 * Dispute provider-event identity (`mon:dsevt:<opaque>`) — Phase 1.11.
 *
 * Distinct from `mon:pevt:` (`ProviderEmailEvent`): both are provider-event
 * ledgers, and sharing a space would make an email bounce and a chargeback
 * notice indistinguishable by identifier alone.
 */
export const TRANSACTION_DISPUTE_EVENT_ID_RE = new RegExp(`^mon:dsevt:${OPAQUE_BODY}$`);

/**
 * Seller risk-review policy identity (`mon:srrp:<opaque>`) — Phase 1.13.
 *
 * Deliberately **not** `mon:rpol:`. `mon:rpol:` names Phase 1.2's synchronous
 * transaction gate, resolved at checkout and bound to one Order; this names the
 * heuristics that decide which sellers a HUMAN looks at, resolved when a report
 * runs and bound to no transaction at all. One identifier space for both would
 * let a reader take a review threshold for a gate limit — and a review threshold
 * mistaken for a gate is an automatic denial nobody authorised.
 */
export const SELLER_RISK_REVIEW_POLICY_ID_RE = new RegExp(`^mon:srrp:${OPAQUE_BODY}$`);

/**
 * Participant risk-review identity (`mon:prrev:<opaque>`) — Phase 1.13.
 *
 * Distinct from `mon:mact:` (an activation review) and `mon:prst:` (a
 * restriction). All three are governed judgements about a participant, and the
 * distinction is the point: an activation decides admission, a restriction
 * withholds capability, and this decides only whether somebody should look.
 * Sharing a space would make "we reviewed them" and "we restricted them"
 * indistinguishable by identifier — which is the exact conflation this phase
 * refuses to permit.
 */
export const PARTICIPANT_RISK_REVIEW_ID_RE = new RegExp(`^mon:prrev:${OPAQUE_BODY}$`);

/**
 * Governed participant suspension identity (`mon:psus:<opaque>`) — Phase 1.14.
 *
 * Deliberately **not** `mon:prst:`. A restriction withholds one named capability
 * and leaves the participant able to correct the work that caused it; a
 * suspension withdraws admission and withholds that too. One identifier space for
 * both would let a reader take the milder for the heavier — which is exactly the
 * conflation Phase 0M.8 refused to permit when it declined to write the status at
 * all.
 */
export const PARTICIPANT_SUSPENSION_ID_RE = new RegExp(`^mon:psus:${OPAQUE_BODY}$`);

/**
 * Participant reconsideration identity (`mon:prrcn:<opaque>`) — Phase 1.14.
 *
 * Distinct from `mon:prrev:` (a Staff risk review). A review is Monacado looking
 * at a participant; a reconsideration is a participant asking Monacado to look
 * again at one decision. Different subject, different author, different record.
 */
export const PARTICIPANT_RECONSIDERATION_ID_RE = new RegExp(`^mon:prrcn:${OPAQUE_BODY}$`);

/**
 * Participant closure identity (`mon:pcls:<opaque>`) — Phase 1.17.
 *
 * Deliberately **not** `mon:psus:` and not `mon:prst:`. Those name adverse acts
 * Monacado takes against a participant; this names the participant's own act of
 * ending their participation. Sharing an identifier space with either would let
 * a reader take a person's decision to leave for a decision made about them,
 * which is the same conflation `mon:psus:` was minted to avoid one step further
 * out.
 */
export const PARTICIPANT_CLOSURE_ID_RE = new RegExp(`^mon:pcls:${OPAQUE_BODY}$`);
