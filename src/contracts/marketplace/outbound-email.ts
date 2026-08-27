/**
 * Durable outbound email (Phase 1.5) — the `0M.N2` delivery mechanism.
 *
 * `0M.N1` recorded what Monacado **owes**. `1.1` recorded what Monacado
 * **attempted**, once, with no retry — and named that limitation as a pre-live
 * gate. This records what Monacado has **committed to sending**, and keeps
 * trying until it succeeds or is out of attempts.
 *
 * ## Three records, three different questions
 *
 * | Record | Question | Owner |
 * | --- | --- | --- |
 * | `NotificationObligation` | what does Monacado owe this participant? | `0M.N1` |
 * | `OutboundEmailDelivery` | did that communication get out, and if not, when do we try again? | this phase |
 * | `NotificationDelivery` | *(`1.1`)* what did one single attempt do? | superseded for email |
 *
 * **A delivery is never an obligation, and retries never touch one.** A message
 * that has permanently failed leaves the obligation exactly as owed as it was;
 * a message that was delivered does too, because being emailed is not the same
 * as having seen the notice in the panel — `AUTHORITATIVE_STOREFRONT_SOURCE_-
 * MODEL.md` §3a, unchanged.
 *
 * `obligationId` is **nullable**, and that nullability is the whole reason this
 * model exists rather than an extension of `1.1`'s. A verification link owes
 * nothing and confirms nothing: it is an account-security credential, not a
 * notice about marketplace state. Forcing it into the obligation vocabulary
 * would have made "what does Monacado owe?" a harder question to answer for the
 * convenience of one column.
 *
 * ## The body is not stored
 *
 * A delivery records a **source reference**, not a rendered message. Retrying
 * re-renders from the authoritative record — the Order, the email contact — so
 * the message that eventually arrives states what is true *now* rather than what
 * was true when the first attempt failed. Storing bodies would also make this
 * table a mail archive holding every buyer address, every amount, and, for a
 * verification message, a live bearer credential.
 *
 * Pure types and pure decisions. No I/O, no clock, no storage, no provider.
 */

import { z } from "zod";
import {
  EMAIL_SUPPRESSION_ID_RE,
  OUTBOUND_EMAIL_DELIVERY_ID_RE,
  PROVIDER_EMAIL_EVENT_ID_RE,
} from "./identity";
import { DeliveryAudience, DeliveryFailureCode } from "./notification-delivery";
import { NotificationObligationId } from "./notification-obligation";

// — Identity —

export const OutboundEmailDeliveryId = z
  .string()
  .regex(OUTBOUND_EMAIL_DELIVERY_ID_RE, "deliveryId must be mon:oeml:<opaque>");
export type OutboundEmailDeliveryId = z.infer<typeof OutboundEmailDeliveryId>;

export const EmailSuppressionId = z
  .string()
  .regex(EMAIL_SUPPRESSION_ID_RE, "suppressionId must be mon:esup:<opaque>");
export type EmailSuppressionId = z.infer<typeof EmailSuppressionId>;

export const ProviderEmailEventId = z
  .string()
  .regex(PROVIDER_EMAIL_EVENT_ID_RE, "eventId must be mon:pevt:<opaque>");
export type ProviderEmailEventId = z.infer<typeof ProviderEmailEventId>;

// — Purpose —

/**
 * What this message is for.
 *
 * Deliberately **not** `NotificationCategory`. That vocabulary answers "what is
 * owed"; this one answers "what is being sent", and the two are not the same
 * list — `EMAIL_VERIFICATION` is owed to nobody, and `OFFER_CHANGE` is owed with
 * no email producer. Where a purpose does correspond to a category, the delivery
 * carries the obligation id and the correspondence is explicit rather than
 * implied by a shared enum.
 */
export const OUTBOUND_EMAIL_PURPOSES = [
  /** A buyer's receipt for a completed sale. */
  "ORDER_CONFIRMATION",
  /** A buyer's notice that payment did not go through. */
  "PAYMENT_FAILED",
  /** A buyer's notice that the checkout window closed. */
  "ORDER_CANCELLED",
  /** A seller's or promoter's supplemental notice that a sale was recorded. */
  "SALE_RECORDED",
  /**
   * A buyer's notice that their money has been returned (Phase 1.9).
   *
   * Sent when the **payment refund** completes, not when the whole lifecycle
   * does. A buyer has no interest in whether Monacado has finished reversing the
   * sale's tax with a provider, and holding their receipt until it had would
   * withhold the one fact they actually want on the strength of a fact that is
   * none of their business.
   */
  "REFUND_COMPLETED",
  /**
   * A seller's or promoter's notice that a sale of theirs was refunded
   * (Phase 1.9).
   *
   * Deliberately distinct from `REFUND_COMPLETED`: the buyer is being told their
   * money is coming back, and the counterparty is being told a sale they were
   * credited for has been undone. Same event, different consequence, and one
   * purpose covering both would render one of them the wrong message.
   */
  "REFUND_RECORDED",
  /**
   * A seller's or promoter's notice that a sale of theirs is disputed
   * (Phase 1.11).
   *
   * Distinct from `REFUND_RECORDED` for the reason that one is distinct from
   * `REFUND_COMPLETED`: a refund is Monacado returning money because somebody
   * decided to, and a dispute is a bank reversing a payment because a cardholder
   * asked it to. Telling a seller "a sale was refunded" when their buyer went to
   * their bank would misdescribe both what happened and what the seller may need
   * to do about it.
   *
   * **There is deliberately no buyer-facing counterpart.** The cardholder
   * disputed with their bank, not with Monacado; a snapshot address may reach
   * somebody who did not file it; and anything Monacado writes to a buyer about
   * a live dispute becomes correspondence a bank may weigh. The precedent is
   * already recorded for the closest analogue — a failed tax reversal
   * deliberately emails nobody.
   */
  "DISPUTE_RECORDED",
  /** Proof-of-control for an email contact. Owed to nobody; obligation-free. */
  "EMAIL_VERIFICATION",
] as const;
export const OutboundEmailPurpose = z.enum(OUTBOUND_EMAIL_PURPOSES);
export type OutboundEmailPurpose = z.infer<typeof OutboundEmailPurpose>;

/** Purposes that never carry a `NotificationObligation`. Asserted by a test. */
export const OBLIGATION_FREE_PURPOSES = [
  "EMAIL_VERIFICATION",
] as const satisfies readonly OutboundEmailPurpose[];

// — Subject —

/**
 * The authoritative record this message is re-rendered from.
 *
 * `ORDER` resolves the buyer's address from the durable `OrderBuyerSnapshot` and
 * a participant's from their `Account`; `EMAIL_CONTACT` resolves the address
 * being proved and mints the challenge. Both are re-resolved on **every** attempt
 * — which is what makes storing no body possible, and what makes a retry state
 * what is true now.
 */
export const OUTBOUND_EMAIL_SUBJECT_KINDS = ["ORDER", "EMAIL_CONTACT"] as const;
export const OutboundEmailSubjectKind = z.enum(OUTBOUND_EMAIL_SUBJECT_KINDS);
export type OutboundEmailSubjectKind = z.infer<typeof OutboundEmailSubjectKind>;

// — Status —

/**
 * Five states, and the transitions between them.
 *
 * ```
 *   PENDING ──claim──▶ IN_PROGRESS ──accepted──▶ DELIVERED         (terminal)
 *      ▲                    │
 *      │                    ├──transient, attempts remain──▶ RETRY_PENDING
 *      │                    │                                     │
 *      └─────────────due────┘◀────────────────────────────────────┘
 *                           │
 *                           └──permanent, or attempts exhausted──▶ PERMANENTLY_FAILED
 * ```
 *
 * `IN_PROGRESS` is a **claimed** state carrying a lock token and a lease. A
 * worker that dies mid-send leaves a row here; the lease expires and the row
 * becomes eligible again, so a crash costs an attempt rather than the message.
 * That is the deliberate reversal of `1.1`: at-most-once loses a receipt
 * silently, and a bounded at-least-once loses nothing and is visible.
 */
export const OUTBOUND_DELIVERY_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "DELIVERED",
  "RETRY_PENDING",
  "PERMANENTLY_FAILED",
] as const;
export const OutboundDeliveryStatus = z.enum(OUTBOUND_DELIVERY_STATUSES);
export type OutboundDeliveryStatus = z.infer<typeof OutboundDeliveryStatus>;

export const INITIAL_OUTBOUND_DELIVERY_STATUS: OutboundDeliveryStatus = "PENDING";

/** Statuses from which a due delivery may be claimed. */
export const CLAIMABLE_DELIVERY_STATUSES = [
  "PENDING",
  "RETRY_PENDING",
] as const satisfies readonly OutboundDeliveryStatus[];

/** Statuses nothing moves out of. */
export const TERMINAL_DELIVERY_STATUSES = [
  "DELIVERED",
  "PERMANENTLY_FAILED",
] as const satisfies readonly OutboundDeliveryStatus[];

export function isTerminalDeliveryStatus(status: OutboundDeliveryStatus): boolean {
  return (TERMINAL_DELIVERY_STATUSES as readonly OutboundDeliveryStatus[]).includes(status);
}

// — Retry policy —

/**
 * How hard Monacado tries, expressed **once**.
 *
 * A constant rather than numbers spread through a dispatcher, because "how many
 * times did we try and how long did that take" is a question an operator asks
 * about the system, and an answer assembled from four call sites is not an
 * answer. Changing the policy is one edit, in one reviewed place.
 *
 * Five attempts over roughly four and a half hours. Long enough to ride out an
 * ordinary provider incident; short enough that a receipt either arrives the same
 * morning or is visibly, permanently failed rather than sitting in a queue
 * nobody reads.
 */
export const EMAIL_RETRY_POLICY = {
  /** Provider attempts, including the first. */
  maxAttempts: 5,
  /**
   * Delay before attempt *n+1*, in seconds. Increasing, and deliberately not
   * exponential-with-jitter: a handful of messages does not need to spread load,
   * and a schedule an operator can read off is worth more than one they cannot.
   */
  backoffSeconds: [60, 300, 900, 3_600, 10_800],
  /**
   * How long a claim is held before another worker may take the row.
   *
   * Longer than any send should take, so a live worker is never raced; short
   * enough that a crashed one does not strand a receipt for an hour.
   */
  claimLeaseSeconds: 300,
} as const;

/**
 * When to try again after `attemptCount` failed attempts, or `null` if done.
 *
 * The single decision that makes retrying bounded. `attemptCount` is the number
 * of attempts **already made**, so the first failure asks for index 0.
 */
export function nextAttemptDelaySeconds(attemptCount: number): number | null {
  if (attemptCount >= EMAIL_RETRY_POLICY.maxAttempts) return null;
  const index = Math.min(attemptCount - 1, EMAIL_RETRY_POLICY.backoffSeconds.length - 1);
  return EMAIL_RETRY_POLICY.backoffSeconds[Math.max(0, index)]!;
}

/** The instant of the next attempt, or `null` when the attempts are spent. */
export function nextAttemptAt(input: {
  attemptCount: number;
  failedAt: string;
}): string | null {
  const delay = nextAttemptDelaySeconds(input.attemptCount);
  if (delay === null) return null;
  return new Date(new Date(input.failedAt).getTime() + delay * 1_000).toISOString();
}

// — Normalized provider outcome —

/**
 * What a provider did, in Monacado's words.
 *
 * **Application code never reasons about a vendor's response shape.** An adapter
 * translates once, at the boundary, into these three answers; everything above it
 * decides from the answer. That is what makes replacing Postmark a new adapter
 * rather than a search for `ErrorCode` across the service layer.
 *
 * The distinction that carries the weight is `TRANSIENT` versus `PERMANENT`:
 * retrying a rejected address forever is how a sender's reputation dies, and
 * giving up on a five-minute outage is how a receipt is lost.
 */
export const SEND_OUTCOME_CLASSES = ["ACCEPTED", "TRANSIENT", "PERMANENT"] as const;
export const SendOutcomeClass = z.enum(SEND_OUTCOME_CLASSES);
export type SendOutcomeClass = z.infer<typeof SendOutcomeClass>;

/**
 * Which failures are worth another attempt.
 *
 * `CHANNEL_NOT_CONFIGURED` is **transient**, deliberately: an unconfigured
 * deployment is a condition an operator fixes, not a property of the message. It
 * still exhausts its attempts and fails permanently, so a deployment that never
 * configures mail reports exactly how many notices it did not send — which is the
 * posture `1.1` chose and this keeps.
 *
 * `DESTINATION_SUPPRESSED` is permanent by construction: the address is already
 * known bad, and the remedy is remediating the address, not resending.
 */
export const TRANSIENT_FAILURE_CODES = [
  "PROVIDER_UNAVAILABLE",
  "CHANNEL_NOT_CONFIGURED",
  "UNSPECIFIED_FAILURE",
] as const satisfies readonly DeliveryFailureCode[];

export function classifyFailure(code: DeliveryFailureCode): SendOutcomeClass {
  return (TRANSIENT_FAILURE_CODES as readonly DeliveryFailureCode[]).includes(code)
    ? "TRANSIENT"
    : "PERMANENT";
}

// — Deduplication identity —

const KEY_SEPARATOR = "|";
const KEY_ABSENT = "~";

export class OutboundEmailError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OutboundEmailError";
    this.code = code;
  }
}

/**
 * The logical identity of one message, enforced by a unique index.
 *
 * Derived, never supplied. Two webhook deliveries of one sale, or two workers
 * finalizing the same Order, produce the same key and therefore **one** row —
 * which is what stops a buyer receiving two receipts while still permitting five
 * attempts at the one they are owed.
 *
 * `discriminator` is what separates a message that may legitimately be sent again
 * from one that may not. An order receipt passes `null`: there is exactly one per
 * order per audience, forever. A verification link passes a fresh opaque value:
 * asking again **is** a new message, and superseding the previous challenge is
 * the documented behaviour rather than a duplicate to be suppressed.
 *
 * The destination is **not** in the key — the same reasoning `1.1` applied: a
 * buyer who corrected their address on a retry must not receive two receipts, and
 * anyone who could influence the address must not be able to manufacture a send.
 */
export function outboundEmailDeliveryKey(input: {
  purpose: OutboundEmailPurpose;
  recipientParticipantId: string | null;
  subjectKind: OutboundEmailSubjectKind;
  subjectRef: string;
  discriminator: string | null;
}): string {
  const components = [
    input.purpose,
    input.recipientParticipantId ?? KEY_ABSENT,
    input.subjectKind,
    input.subjectRef,
    input.discriminator ?? KEY_ABSENT,
  ];
  for (const component of components) {
    if (component.includes(KEY_SEPARATOR)) {
      throw new OutboundEmailError(
        "DELIVERY_KEY_COMPONENT_INVALID",
        "a delivery key component may not contain the separator",
      );
    }
  }
  return components.join(KEY_SEPARATOR);
}

// — Records —

export const AddressDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256 of the normalised address");

/**
 * One message Monacado has committed to sending.
 *
 * Note what has no field: the destination address, a subject line, a rendered
 * body, an HTML part, a template name, a provider credential, a raw provider
 * payload, or a verification token.
 */
export const OutboundEmailDeliveryRecord = z.strictObject({
  deliveryId: OutboundEmailDeliveryId,
  purpose: OutboundEmailPurpose,
  /** The `0M.N1` obligation this accompanies. `null` for obligation-free mail. */
  obligationId: NotificationObligationId.nullable(),
  audience: DeliveryAudience,
  recipientParticipantId: z.string().min(1).max(191).nullable(),
  subjectKind: OutboundEmailSubjectKind,
  subjectRef: z.string().min(1).max(191),
  status: OutboundDeliveryStatus,
  attemptCount: z.number().int().min(0).max(EMAIL_RETRY_POLICY.maxAttempts),
  /** When the next attempt becomes due. `null` once terminal. */
  nextAttemptAt: z.iso.datetime().nullable(),
  /** Which adapter answered. `null` until an attempt has been made. */
  provider: z.string().min(1).max(24).nullable(),
  /** The provider's own identifier, for correlation only. */
  providerMessageRef: z.string().min(1).max(191).nullable(),
  /** Where it was going, as a digest. The address itself is never stored. */
  destinationDigest: AddressDigest.nullable(),
  lastFailureCode: DeliveryFailureCode.nullable(),
  lastFailureClass: SendOutcomeClass.nullable(),
  createdAt: z.iso.datetime(),
  /** When a provider accepted responsibility. Never an inbox-delivery claim. */
  sentAt: z.iso.datetime().nullable(),
  /** When it reached a terminal state, either way. */
  finalizedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type OutboundEmailDeliveryRecord = z.infer<typeof OutboundEmailDeliveryRecord>;

// — Suppression —

/**
 * Why Monacado stopped writing to an address.
 *
 * Bounded. A soft bounce is **absent** on purpose: a full mailbox or a greylist
 * is exactly what the retry policy exists for, and suppressing on one would turn
 * a transient condition into a permanent one.
 */
export const SUPPRESSION_REASONS = [
  /** The provider reported the address does not accept mail. */
  "HARD_BOUNCE",
  /** The recipient marked a Monacado message as spam. */
  "SPAM_COMPLAINT",
  /** An operator suppressed it deliberately. */
  "MANUAL",
] as const;
export const SuppressionReason = z.enum(SUPPRESSION_REASONS);
export type SuppressionReason = z.infer<typeof SuppressionReason>;

/**
 * One address Monacado will not write to.
 *
 * **Keyed by digest, and holding no address.** A suppression list is otherwise a
 * directory of every address that ever failed — which is a more attractive table
 * to read than the one it was protecting. Monacado can still answer "may I write
 * to this address" for an address it already holds, which is the only question
 * this list needs to answer.
 *
 * `liftedAt` exists because suppression is a **state, not a verdict**: an address
 * that starts working again is remediated by proving control of it, and the row
 * remains as the evidence of why it was ever suppressed.
 */
export const EmailSuppressionRecord = z.strictObject({
  suppressionId: EmailSuppressionId,
  addressDigest: AddressDigest,
  reason: SuppressionReason,
  /** The provider event that caused it, where one did. */
  evidenceEventId: z.string().min(1).max(191).nullable(),
  suppressedAt: z.iso.datetime(),
  /** When it stopped applying. `null` while it still does. */
  liftedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type EmailSuppressionRecord = z.infer<typeof EmailSuppressionRecord>;

// — Provider events —

/**
 * What a provider told Monacado, normalised.
 *
 * A closed vocabulary, so nothing above the adapter reads a vendor's own event
 * names. `TRANSIENT_BOUNCE` is recorded and **suppresses nothing** — it exists so
 * an operator can see a soft bounce happened, not so the retry policy can be
 * second-guessed by a webhook.
 */
export const PROVIDER_EMAIL_EVENT_TYPES = [
  "HARD_BOUNCE",
  "SPAM_COMPLAINT",
  "TRANSIENT_BOUNCE",
  "DELIVERED",
] as const;
export const ProviderEmailEventType = z.enum(PROVIDER_EMAIL_EVENT_TYPES);
export type ProviderEmailEventType = z.infer<typeof ProviderEmailEventType>;

/** Event types that suppress the destination. */
export const SUPPRESSING_EVENT_TYPES = [
  "HARD_BOUNCE",
  "SPAM_COMPLAINT",
] as const satisfies readonly ProviderEmailEventType[];

export function suppressionReasonFor(
  type: ProviderEmailEventType,
): SuppressionReason | null {
  if (type === "HARD_BOUNCE") return "HARD_BOUNCE";
  if (type === "SPAM_COMPLAINT") return "SPAM_COMPLAINT";
  return null;
}

/**
 * One normalised provider event.
 *
 * `providerEventId` is the provider's own identity for it and is what makes
 * replay idempotent: a webhook endpoint is retried by every provider worth using,
 * and an ingestion that acted twice would suppress, degrade, and re-degrade on
 * every redelivery.
 *
 * **No raw payload column.** A bounce payload carries the recipient address, the
 * subject line, and frequently a quoted copy of the message body — which for a
 * verification message is a live credential. The normalised facts are kept and
 * the payload is not.
 */
export const ProviderEmailEventRecord = z.strictObject({
  eventId: ProviderEmailEventId,
  provider: z.string().min(1).max(24),
  /** The provider's identifier for this event. Unique per provider. */
  providerEventId: z.string().min(1).max(191),
  eventType: ProviderEmailEventType,
  addressDigest: AddressDigest,
  /** Correlates back to a delivery, where the provider reported one. */
  providerMessageRef: z.string().min(1).max(191).nullable(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type ProviderEmailEventRecord = z.infer<typeof ProviderEmailEventRecord>;

// — Never here —

/**
 * Named as never-persistable on any record in this module.
 *
 * The first group is **the message**, which would make this a mail archive. The
 * second is **recipient personal data**, which is why every address here is a
 * digest. The third is **credentials**, which belong to an adapter and to
 * nothing that is written down.
 */
export const NEVER_ON_OUTBOUND_EMAIL = [
  // the message — a delivery re-renders from the source, it does not store one
  "subject",
  "subjectLine",
  "body",
  "text",
  "html",
  "renderedBody",
  "templateId",
  "attachments",
  "rawWebhookPayload",
  "providerResponseBody",
  // recipient personal data — the digest is the whole point
  "destination",
  "toAddress",
  "recipientEmail",
  "recipientName",
  // credentials — never written down, never logged
  "serverToken",
  "apiKey",
  "webhookSecret",
  "verificationToken",
  "tokenPlaintext",
] as const;
