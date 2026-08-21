/**
 * Notification delivery (Phase 1.1) — the first concrete channel.
 *
 * `0M.N1` recorded what Monacado **owes**. This records what Monacado
 * **attempted**, and keeps the two strictly apart.
 *
 * ## Delivery never becomes the system of record
 *
 * `AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` §3a is binding and unambiguous:
 *
 * > **The canonical channel is the Monacado admin panel.** Email, SMS, and push
 * > may be added later and are supplemental — they may accompany the notice and
 * > can never replace it. A channel outside Monacado's control cannot be the
 * > system of record for an obligation.
 *
 * So a `NotificationDelivery` row is **evidence of an attempt, never an
 * obligation**. It has no status a participant can act on, it does not satisfy,
 * close, or advance a `NotificationObligation`, and nothing in this module writes
 * to one. A failed delivery leaves the obligation exactly as owed as it was; a
 * successful one does too, because being told by email is not the same as having
 * seen the notice in the panel.
 *
 * ## Two recipients, one mechanism
 *
 * | Recipient | Obligation exists? | Why |
 * | --- | --- | --- |
 * | seller / promoter | **yes** — `0M.N1` wrote it | they are participants; the panel is canonical and email is supplemental |
 * | buyer (account or guest) | **no** | `0M.N1` keys obligations on participants by design, and a buyer need not be one |
 *
 * That asymmetry is `0M.N1`'s, deliberately, and this phase does **not**
 * redesign it. `obligationId` is therefore nullable: present when a delivery
 * accompanies an obligation, absent when it carries a fact to somebody the
 * obligation model was never meant to address. **No participant is fabricated to
 * satisfy a foreign key** — `0M.9` promised guest checkout creates none, and
 * inventing one to make a notice fit would break that promise for the
 * convenience of a column.
 *
 * ## The address is not stored
 *
 * Only a SHA-256 digest of the normalised address is persisted — the same
 * construction, and the same reasoning, as `0M.9`'s guest claim code. Monacado
 * therefore keeps the ability to prove *that* it wrote to a given address, to
 * deduplicate, and to answer a support question, without becoming a store of
 * buyer email addresses. The raw address exists only in memory, only for the
 * duration of one send.
 *
 * Pure types and pure decisions. No I/O, no clock, no template, no rendering.
 */

import { z } from "zod";
import { NOTIFICATION_DELIVERY_ID_RE } from "./identity";
import {
  NotificationCategory,
  NotificationObligationId,
  NotificationSubject,
} from "./notification-obligation";

// — Identity —

export const NotificationDeliveryId = z
  .string()
  .regex(NOTIFICATION_DELIVERY_ID_RE, "deliveryId must be mon:ndlv:<opaque>");
export type NotificationDeliveryId = z.infer<typeof NotificationDeliveryId>;

// — Channel —

/**
 * How Monacado attempted to reach someone.
 *
 * One member. `SMS` and `PUSH` are named by §3a as future supplemental channels
 * and are deliberately **absent** rather than declared-and-unimplemented: an enum
 * member with no producer is a promise the code does not keep, and `0M.N1`
 * already learned that lesson by naming its unproduced categories explicitly.
 */
export const DELIVERY_CHANNELS = ["EMAIL"] as const;
export const DeliveryChannel = z.enum(DELIVERY_CHANNELS);
export type DeliveryChannel = z.infer<typeof DeliveryChannel>;

// — Audience —

/**
 * Which side of the transaction the recipient stands on.
 *
 * Not a role and not a capability — it is who this *message* is for, which is why
 * `BUYER` sits beside `SELLER` and `PROMOTER` despite a buyer holding no
 * marketplace role at all. It is part of the deduplication key, so a promoter who
 * is also the buyer of something else receives both messages.
 */
export const DELIVERY_AUDIENCES = ["BUYER", "SELLER", "PROMOTER"] as const;
export const DeliveryAudience = z.enum(DELIVERY_AUDIENCES);
export type DeliveryAudience = z.infer<typeof DeliveryAudience>;

// — Destination —

/** Hex SHA-256 of the normalised destination. The address itself is never stored. */
export const DestinationDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "destinationDigest must be a lowercase hex SHA-256");
export type DestinationDigest = z.infer<typeof DestinationDigest>;

// — Status —

/**
 * Three states, and no more.
 *
 *   - `ATTEMPTED` — the row was claimed and the provider has not yet answered.
 *     A row left here means the process died mid-send, which is exactly the state
 *     an operator needs to see rather than one silently retried.
 *   - `ACCEPTED` — the provider took responsibility for the message. **Not
 *     "delivered"**: an inbox acceptance is the provider's to know and Monacado
 *     would be guessing.
 *   - `FAILED` — the provider refused it, with a bounded reason.
 *
 * Terminal in both non-`ATTEMPTED` states. There is no `RETRYING`, no
 * `nextAttemptAt`, and no backoff curve: this phase sends at most once per
 * deduplication key, because for transactional mail a duplicate receipt is worse
 * than a missing one, and a retry policy is a scheduler nobody asked for yet.
 */
export const DELIVERY_STATUSES = ["ATTEMPTED", "ACCEPTED", "FAILED"] as const;
export const DeliveryStatus = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const INITIAL_DELIVERY_STATUS: DeliveryStatus = "ATTEMPTED";

// — Failure —

/**
 * Why a send did not happen, as a closed Monacado vocabulary.
 *
 * **No provider text, SMTP response, bounce body, or exception message.** The
 * same rule `0M.9` applies to `PaymentFailureCode` and for the same reason: a
 * free-text failure is where a recipient's address, a rendered body, or a
 * credential eventually lands.
 */
export const DELIVERY_FAILURE_CODES = [
  /** The provider rejected the destination as unusable. */
  "DESTINATION_REJECTED",
  /** The provider refused the message itself. */
  "MESSAGE_REJECTED",
  /** The provider was unreachable, timed out, or errored. */
  "PROVIDER_UNAVAILABLE",
  /** Monacado is not configured to send on this channel. */
  "CHANNEL_NOT_CONFIGURED",
  /** The provider failed in a way Monacado does not classify further. */
  "UNSPECIFIED_FAILURE",
] as const;
export const DeliveryFailureCode = z.enum(DELIVERY_FAILURE_CODES);
export type DeliveryFailureCode = z.infer<typeof DeliveryFailureCode>;

// — Deduplication identity —

const KEY_SEPARATOR = "|";
const KEY_ABSENT = "~";

export class NotificationDeliveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NotificationDeliveryError";
    this.code = code;
  }
}

/**
 * The deduplication identity of one delivery.
 *
 * Derived, never supplied, and enforced by a unique index — the same construction
 * `0M.N1` chose, for the same reason: two components are nullable and MySQL
 * treats each NULL in a unique index as distinct, so a composite index would
 * silently permit exactly the duplicates this prevents.
 *
 * **The destination is not in the key, and that is deliberate.** Keying on the
 * address would send a second receipt to a buyer who corrected their email on a
 * retry, and would let anyone who could influence the address manufacture a
 * duplicate send. One order, one audience, one category, one message.
 */
export function notificationDeliveryKey(input: {
  audience: DeliveryAudience;
  /** The participant addressed, or `null` for a buyer who holds no participant. */
  recipientParticipantId: string | null;
  category: NotificationCategory;
  subject: { kind: string; ref: string };
  channel: DeliveryChannel;
}): string {
  const components = [
    input.audience,
    input.recipientParticipantId ?? KEY_ABSENT,
    input.category,
    input.subject.kind,
    input.subject.ref,
    input.channel,
  ];
  for (const component of components) {
    if (component.includes(KEY_SEPARATOR)) {
      throw new NotificationDeliveryError(
        "DELIVERY_KEY_COMPONENT_INVALID",
        "a delivery key component may not contain the separator",
      );
    }
  }
  return components.join(KEY_SEPARATOR);
}

// — Record —

/**
 * One attempt to reach one recipient about one thing.
 *
 * Note what has no field: the destination address, a subject line, a rendered
 * body, an HTML part, a template name, a locale, a provider credential, an
 * endpoint, a bounce payload, or a retry schedule.
 */
export const NotificationDeliveryRecord = z.strictObject({
  deliveryId: NotificationDeliveryId,
  /** Present when this accompanies a `0M.N1` obligation; absent for a buyer. */
  obligationId: NotificationObligationId.nullable(),
  audience: DeliveryAudience,
  recipientParticipantId: z.string().min(1).max(191).nullable(),
  category: NotificationCategory,
  subject: NotificationSubject,
  channel: DeliveryChannel,
  destinationDigest: DestinationDigest,
  status: DeliveryStatus,
  failureCode: DeliveryFailureCode.nullable(),
  /** The provider's own identifier for the message, for correlation only. */
  providerMessageRef: z.string().min(1).max(191).nullable(),
  attemptedAt: z.iso.datetime(),
  /** When the provider accepted responsibility. Never an inbox-delivery claim. */
  acceptedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type NotificationDeliveryRecord = z.infer<typeof NotificationDeliveryRecord>;

// — The mail boundary —

/**
 * A message to send, in Monacado's own vocabulary.
 *
 * Plain text only. No HTML part, no attachment, no template id, no merge
 * variables, and no tracking pixel — every one of those is a way for private
 * detail or a third party's script to enter a transactional message, and none is
 * needed to tell somebody their order was paid.
 *
 * The body is assembled from **bounded domain facts** by the notice service; a
 * caller cannot pass arbitrary text through this type into a buyer's inbox
 * because nothing outside that service constructs one.
 */
export const MailMessage = z.strictObject({
  /** The raw destination. Transient — the caller holds it, nothing persists it. */
  to: z.string().min(3).max(320),
  subject: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000),
});
export type MailMessage = z.infer<typeof MailMessage>;

/**
 * What a provider says when it takes a message.
 *
 * A discriminated union on the same principle as `BuyerPaymentResult`: accepted
 * carries a reference and no failure code; refused carries a bounded code and no
 * reference. There is no "accepted but…" shape.
 */
export const MailAccepted = z.strictObject({
  outcome: z.literal("ACCEPTED"),
  providerMessageRef: z.string().min(1).max(191),
});

export const MailRefused = z.strictObject({
  outcome: z.literal("REFUSED"),
  failureCode: DeliveryFailureCode,
});

export const MailResult = z.discriminatedUnion("outcome", [MailAccepted, MailRefused]);
export type MailResult = z.infer<typeof MailResult>;

/**
 * The single boundary across which Monacado sends mail.
 *
 * Provider-neutral by construction: nothing here names a vendor, an API shape, a
 * template system, or a credential. An adapter authenticates however it likes;
 * a credential in a message object is a credential in a log.
 *
 * An implementation **must not throw for an ordinary refusal** — a refused
 * message is a `MailResult`, not an exception, so the delivery layer records
 * evidence rather than losing it in a stack trace.
 */
export interface MailPort {
  send(message: MailMessage): Promise<MailResult>;
}

// — Never on a delivery —

/**
 * Named as never-persistable, and not admissible through any input above.
 *
 * The first group is **the message itself**, which would make this table a mail
 * archive. The second is **recipient personal data**, which is why the digest
 * exists. The third is **credentials**, which belong to an adapter.
 */
export const NEVER_ON_NOTIFICATION_DELIVERY = [
  // the message — this is evidence of an attempt, not an archive of what was said
  "subjectLine",
  "body",
  "html",
  "renderedBody",
  "templateId",
  "attachments",
  // recipient personal data — the digest is the whole point
  "destination",
  "toAddress",
  "recipientEmail",
  "recipientName",
  "recipientPhone",
  // credentials — the adapter's problem
  "apiKey",
  "smtpPassword",
  "accessToken",
  "webhookSecret",
] as const;
