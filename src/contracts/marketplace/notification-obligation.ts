/**
 * Notification obligation records (Phase 0M.N1).
 *
 * **An obligation is the record that Monacado owes a notice. It is not a
 * message.** Nothing here sends, renders, addresses, schedules, or retries
 * anything; there is no channel, no template, no body, no subject line, and no
 * delivery attempt. `0M.N2` owns all of that, and the separation is what makes
 * the obligation durable independently of whether any channel worked.
 *
 * Six properties shape everything below:
 *
 *   1. **The obligation is the system of record, and the admin panel is its
 *      canonical channel** (`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` §3a).
 *      Email, SMS, and push may later *accompany* a notice and can never replace
 *      it: a channel outside Monacado's control cannot be the record of an
 *      obligation.
 *
 *   2. **Deduplication is structural, not remembered.** The governed rule is one
 *      obligation per **promoter participant × exact Offer source version ×
 *      change category** — a promoter carrying one Offer in five storefronts has
 *      one thing to decide, and five notices would be five chances to miss the
 *      one that mattered. `notificationObligationKey` computes that identity, and
 *      a unique index enforces it.
 *
 *   3. **Recipients are participants, never addresses.** An obligation binds to a
 *      persisted `MarketplaceParticipant`. An email address is a delivery
 *      destination and a mutable contact detail — keying an obligation on one
 *      would hand a promoter's notices to whoever holds the address next, which
 *      is the same reason the identity foundation refuses to key authorization on
 *      email.
 *
 *   4. **Category and subject are separate axes**, which is what makes this model
 *      survive `0M.9`. The *category* says what kind of thing is owed; the
 *      *subject* says what it is about, as a kind plus a reference plus an
 *      optional exact version. An order-confirmation obligation is a new category
 *      and a new subject kind — not a new table, and not a column added to an
 *      Offer-shaped schema.
 *
 *   5. **Explicit fields, never a payload bag.** No JSON blob, no rendered body,
 *      no free text. Everything the record carries is an identifier, a member of
 *      a closed vocabulary, or an instant — so an obligation is safe to render,
 *      safe to log, and cannot become the place private notice content
 *      accumulates.
 *
 *   6. **History is never destroyed.** Acknowledging, resolving, and archiving
 *      are state changes with their own instants. Nothing here deletes.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import {
  INTERNAL_OFFER_ID_RE,
  MARKETPLACE_PARTICIPANT_ID_RE,
  NOTIFICATION_OBLIGATION_ID_RE,
} from "./identity";
import { OfferBusinessChangeCategory } from "./offer-source";

// — Identity —

export const NotificationObligationId = z
  .string()
  .regex(NOTIFICATION_OBLIGATION_ID_RE, "obligationId must be mon:nobl:<opaque>");
export type NotificationObligationId = z.infer<typeof NotificationObligationId>;

const ParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "recipientParticipantId must be mon:mpart:<opaque>");

// — Category —

/**
 * What kind of notice is owed.
 *
 * Closed, and deliberately **not** Offer-shaped. `0M.N1` implements the one
 * governed obligation that already exists; the rest are named here because
 * naming them is how the vocabulary stays a vocabulary rather than becoming a
 * free-form string the day `0M.9` needs a second member.
 *
 * Adding a category is a bounded, additive change: a new member, no new table,
 * no new column. **This phase creates rows for `OFFER_CHANGE` only** — the
 * others have no producer, which a test asserts.
 */
export const NOTIFICATION_CATEGORIES = [
  // — Implemented in 0M.N1 —
  /** A governed Offer change a promoter must be told about (Storefront §3a). */
  "OFFER_CHANGE",

  // — Named for 0M.9; no producer exists yet —
  /** A buyer's order was accepted. */
  "ORDER_CONFIRMATION",
  /**
   * A buyer's order ended without payment — abandoned, expired, or cancelled.
   *
   * Added in Phase 1.1, as the additive change this vocabulary was designed to
   * take: a new member, no new table, no new column. It is deliberately **not**
   * `PAYMENT_FAILED`, which asserts that a provider reported a failure. Nobody
   * declined an expired checkout; the buyer simply never finished, and the Order
   * lifecycle draws exactly that distinction between `PAYMENT_FAILED` and
   * `CANCELLED`.
   */
  "ORDER_CANCELLED",
  /** A seller or promoter has a sale to fulfil or account for. */
  "SALE_RECORDED",
  /** A payment attempt failed. */
  "PAYMENT_FAILED",
  /** A payout or settlement changed state. */
  "PAYOUT_STATE_CHANGED",
  /** A refund or chargeback was raised. */
  "REFUND_OR_CHARGEBACK",
  /** A buyer became eligible to submit a review. */
  "REVIEW_ELIGIBILITY",
  /** Monacado requires an operational action from the participant. */
  "OPERATIONAL_ACTION_REQUIRED",
] as const;
export const NotificationCategory = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

/** The categories this phase has a producer for. Asserted by a test. */
export const IMPLEMENTED_NOTIFICATION_CATEGORIES = [
  "OFFER_CHANGE",
] as const satisfies readonly NotificationCategory[];

// — Subject —

/**
 * What the obligation is *about*.
 *
 * A kind plus a reference, rather than a column per domain. `OFFER` is the only
 * kind with a producer today; `ORDER`, `PAYMENT`, `PAYOUT`, and `REVIEW` are
 * named so `0M.9` extends a vocabulary instead of migrating a schema.
 */
export const NOTIFICATION_SUBJECT_KINDS = [
  "OFFER",
  "ORDER",
  "PAYMENT",
  "PAYOUT",
  "REVIEW",
] as const;
export const NotificationSubjectKind = z.enum(NOTIFICATION_SUBJECT_KINDS);
export type NotificationSubjectKind = z.infer<typeof NotificationSubjectKind>;

/**
 * The subject an obligation concerns.
 *
 * `subjectVersionRef` is present **because some obligations are version-specific
 * and some are not**. An Offer-change notice is about one exact source version —
 * "the Offer moved to version 3" — and a promoter who has answered version 3
 * must still be told about version 4. An order confirmation is about an order,
 * which has no version axis, and forcing one would be a sentinel nobody could
 * read.
 */
export const NotificationSubject = z.strictObject({
  kind: NotificationSubjectKind,
  /** The domain identifier. Opaque to this model — never parsed or interpreted. */
  ref: z.string().min(1).max(191),
  /** The exact version, where the obligation is version-specific. */
  versionRef: z.string().min(1).max(64).nullable(),
});
export type NotificationSubject = z.infer<typeof NotificationSubject>;

// — Context —

/**
 * The bounded sub-reason within a category.
 *
 * For `OFFER_CHANGE` this is the `OfferBusinessChangeCategory` the committed
 * classifier already produces — **reused, never restated**, so the notice and
 * the classification can never disagree about what changed.
 *
 * `null` where a category needs no sub-reason. It is deliberately not free text:
 * a context that could hold a sentence would become where the notice body lived,
 * and then where private detail lived.
 */
export const NotificationContextCode = OfferBusinessChangeCategory;
export type NotificationContextCode = z.infer<typeof NotificationContextCode>;

// — Lifecycle —

/**
 * The four states `POST_0E7_MARKETPLACE_ROADMAP.md` §0M.N already names:
 * unread / acknowledged / resolved / archived. No fifth was invented.
 *
 *   - `UNREAD` — owed, and not yet looked at.
 *   - `ACKNOWLEDGED` — the recipient has seen it. **Informational only.**
 *     Storefront §3a is explicit that acknowledgement alone never reactivates a
 *     Listing; nothing here confers any commercial effect either.
 *   - `RESOLVED` — the thing it asked for has been done.
 *   - `ARCHIVED` — terminal, and out of the working view.
 */
export const NOTIFICATION_OBLIGATION_STATUSES = [
  "UNREAD",
  "ACKNOWLEDGED",
  "RESOLVED",
  "ARCHIVED",
] as const;
export const NotificationObligationStatus = z.enum(NOTIFICATION_OBLIGATION_STATUSES);
export type NotificationObligationStatus = z.infer<typeof NotificationObligationStatus>;

export const INITIAL_NOTIFICATION_OBLIGATION_STATUS: NotificationObligationStatus = "UNREAD";

/**
 * Valid transitions, as an exhaustive table.
 *
 * Forward-only. An obligation may skip states — resolving something never opened
 * is ordinary, and archiving an obsolete one directly is too — but nothing goes
 * back: "unread again" would erase that someone looked, and re-opening a
 * resolved obligation would misrepresent a second event as the first.
 *
 * `ARCHIVED` is terminal, and **archiving is not deletion**: the row stays, with
 * every instant it accumulated.
 */
export const NOTIFICATION_OBLIGATION_TRANSITIONS: Record<
  NotificationObligationStatus,
  readonly NotificationObligationStatus[]
> = Object.freeze({
  UNREAD: ["ACKNOWLEDGED", "RESOLVED", "ARCHIVED"],
  ACKNOWLEDGED: ["RESOLVED", "ARCHIVED"],
  RESOLVED: ["ARCHIVED"],
  ARCHIVED: [],
});

export function isValidNotificationObligationTransition(
  from: NotificationObligationStatus,
  to: NotificationObligationStatus,
): boolean {
  return NOTIFICATION_OBLIGATION_TRANSITIONS[from].includes(to);
}

/** Statuses an obligation still awaits action in — the admin panel's working set. */
export const OPEN_NOTIFICATION_OBLIGATION_STATUSES = [
  "UNREAD",
  "ACKNOWLEDGED",
] as const satisfies readonly NotificationObligationStatus[];

export function isOpenNotificationObligation(status: NotificationObligationStatus): boolean {
  return (
    OPEN_NOTIFICATION_OBLIGATION_STATUSES as readonly NotificationObligationStatus[]
  ).includes(status);
}

// — Deduplication identity —

const KEY_SEPARATOR = "|";
/** Stands in for an absent component. Not a value any component may take. */
const KEY_ABSENT = "~";

/**
 * The deduplication identity of one obligation.
 *
 * Derived, never supplied: the service computes it from the tuple and a unique
 * index enforces it, so "one notice per promoter × exact Offer version × change
 * category" is a database guarantee rather than a rule a caller remembers.
 *
 * A derived key rather than a composite index because **two components are
 * nullable**, and MySQL treats each NULL in a unique index as distinct — a
 * composite index over them would silently permit exactly the duplicates this
 * exists to prevent. The sentinel makes absence a value the index can compare.
 *
 * Order-sensitive and separator-delimited. No component may contain the
 * separator or equal the sentinel; both are refused at the boundary rather than
 * escaped, because an escaping scheme is a second thing to get right.
 */
export function notificationObligationKey(input: {
  recipientParticipantId: string;
  category: NotificationCategory;
  subject: NotificationSubject;
  contextCode: NotificationContextCode | null;
}): string {
  const components = [
    input.recipientParticipantId,
    input.category,
    input.subject.kind,
    input.subject.ref,
    input.subject.versionRef ?? KEY_ABSENT,
    input.contextCode ?? KEY_ABSENT,
  ];

  for (const component of components) {
    if (component.includes(KEY_SEPARATOR)) {
      throw new NotificationObligationError(
        "OBLIGATION_KEY_COMPONENT_INVALID",
        "an obligation key component may not contain the separator",
      );
    }
  }
  return components.join(KEY_SEPARATOR);
}

export class NotificationObligationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NotificationObligationError";
    this.code = code;
  }
}

// — Record —

/**
 * One durable obligation.
 *
 * Note what has no field, and could not be given one without changing this
 * `strictObject`: a channel, an email address, a phone number, a device token, a
 * subject line, a body, a rendered template, a locale, a delivery attempt, a
 * retry count, a provider message id, or a free-text note. Delivery is `0M.N2`,
 * and a model that could hold a message would become one.
 */
export const NotificationObligationRecord = z.strictObject({
  obligationId: NotificationObligationId,
  recipientParticipantId: ParticipantId,
  category: NotificationCategory,
  subject: NotificationSubject,
  contextCode: NotificationContextCode.nullable(),
  status: NotificationObligationStatus,

  /** The instant the obligation arose. Supplied, never a clock read. */
  createdAt: z.iso.datetime(),
  acknowledgedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),

  updatedAt: z.iso.datetime(),
});
export type NotificationObligationRecord = z.infer<typeof NotificationObligationRecord>;

// — Inputs —

/**
 * Record one obligation.
 *
 * The general entry point, and the one `0M.9` will use for its own categories.
 * Created `UNREAD` and at no other status — there is no `status` parameter, so a
 * caller cannot record an obligation as already handled.
 */
export const CreateNotificationObligationInput = z.strictObject({
  recipientParticipantId: ParticipantId,
  category: NotificationCategory,
  subject: NotificationSubject,
  contextCode: NotificationContextCode.nullable(),
  createdAt: z.iso.datetime(),
});
export type CreateNotificationObligationInput = z.infer<
  typeof CreateNotificationObligationInput
>;

/**
 * Record every obligation one governed Offer change creates.
 *
 * Takes the Offer's internal identity, the exact source version the change
 * produced, and the categories the **committed classifier** returned. The
 * classifier is not re-run and its rules are not restated: a notice that
 * disagreed with `classifyOfferBusinessChanges` about what changed would be
 * worse than no notice.
 *
 * Recipients are resolved by the service from persisted promoted Listings, not
 * supplied — a caller naming its own recipient list could miss a promoter, and
 * missing one is the failure this obligation exists to prevent.
 */
export const RecordOfferChangeObligationsInput = z.strictObject({
  internalOfferId: z.string().regex(INTERNAL_OFFER_ID_RE, "internalOfferId must be mon:offer:<opaque>"),
  offerSourceRecordId: z.string().min(1).max(191),
  /** The version the change produced — what the notice is about. */
  effectiveOfferSourceRecordVersion: z.string().min(1).max(64),
  /** The version promoters are currently bound to — who the notice is for. */
  priorOfferSourceRecordVersion: z.string().min(1).max(64),
  /** Exactly what `classifyOfferBusinessChanges` returned. */
  changeCategories: z
    .array(OfferBusinessChangeCategory)
    .min(1)
    .max(4)
    .refine((c) => new Set(c).size === c.length, "change categories must be distinct"),
  createdAt: z.iso.datetime(),
});
export type RecordOfferChangeObligationsInput = z.infer<
  typeof RecordOfferChangeObligationsInput
>;

export const AdvanceNotificationObligationInput = z.strictObject({
  obligationId: NotificationObligationId,
  to: NotificationObligationStatus,
  at: z.iso.datetime(),
});
export type AdvanceNotificationObligationInput = z.infer<
  typeof AdvanceNotificationObligationInput
>;

// — Never on an obligation —

/**
 * Named as never-persistable, and not admissible through any input above.
 *
 * The first group is **delivery** — `0M.N2`'s subject, and the thing this model
 * must not quietly become. The second is private recipient data, which an
 * obligation has no reason to hold because it addresses a participant rather
 * than a person.
 */
export const NEVER_ON_NOTIFICATION_OBLIGATION = [
  // delivery — 0M.N2
  "channel",
  "emailAddress",
  "phoneNumber",
  "deviceToken",
  "subjectLine",
  "body",
  "htmlBody",
  "template",
  "renderedContent",
  "locale",
  "deliveryAttempts",
  "retryCount",
  "lastDeliveryError",
  "providerMessageId",
  "sentAt",
  // private recipient data
  "recipientEmail",
  "recipientName",
  "legalName",
  "address",
  "freeTextNote",
  "internalNote",
] as const;
