/**
 * The Postmark event boundary (Phase 1.5) — SERVER ONLY.
 *
 * Two jobs, both of which have to happen **before** a provider event is allowed
 * to change any Monacado state: prove the request is Postmark's, and translate it
 * out of Postmark's vocabulary into Monacado's.
 *
 * ## Authentication, and an honest note about what Postmark offers
 *
 * **Postmark does not sign its webhooks.** There is no HMAC header to verify. Its
 * documented mechanisms for securing a webhook endpoint are HTTP Basic
 * credentials embedded in the webhook URL and a custom header, so a shared secret
 * compared in constant time is the strongest thing the provider actually
 * supports. That is recorded here rather than left for somebody to discover while
 * searching for a signature that does not exist.
 *
 * Both forms are accepted because an operator configures whichever the Postmark
 * UI makes easy, and both carry the same secret over the same TLS.
 *
 * The comparison is `timingSafeEqual` over SHA-256 digests: hashing first means
 * two secrets of different lengths compare in constant time too, which a raw
 * buffer compare cannot do without leaking the length.
 *
 * ## Normalisation, and what is deliberately not suppressed
 *
 * An unrecognised bounce type becomes `TRANSIENT_BOUNCE`, which suppresses
 * nothing. Suppressing on a type Monacado does not understand would silence a
 * real customer on the strength of a vendor string nobody read — and the retry
 * policy already handles anything genuinely transient.
 *
 * Only `HardBounce`, `BadEmailAddress`, and a spam complaint suppress.
 *
 * ## The payload is read and thrown away
 *
 * A bounce payload carries the recipient address, the subject line, and
 * frequently a quoted copy of the original message — which for a verification
 * message is a live bearer credential. The address is used in memory to find the
 * affected contact and is then reduced to a digest; **nothing else from the
 * payload is persisted**, and there is no column for it.
 */

import "../server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { normalizeEmail } from "../../contracts/account/account";
import type { ProviderEmailEventType } from "../../contracts/marketplace/outbound-email";

export const POSTMARK_PROVIDER = "POSTMARK" as const;

/** The header an operator may configure instead of Basic credentials. */
export const WEBHOOK_SECRET_HEADER = "x-monacado-webhook-secret";

/**
 * Constant-time secret comparison.
 *
 * Digest first, then compare: two secrets of different lengths then compare in
 * constant time as well, which `timingSafeEqual` alone cannot do — it throws on a
 * length mismatch, and throwing *is* the leak.
 */
export function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Whether this request carries the configured secret.
 *
 * Accepts `Authorization: Basic <base64>` — the password half, so any username
 * works and an operator may embed credentials in the webhook URL as Postmark
 * documents — or the custom header carrying the secret directly.
 */
export function isAuthenticPostmarkRequest(
  headers: { authorization: string | null; webhookSecret: string | null },
  expectedSecret: string,
): boolean {
  if (expectedSecret === "") return false;

  if (headers.webhookSecret !== null && headers.webhookSecret !== "") {
    return secretMatches(headers.webhookSecret, expectedSecret);
  }

  const authorization = headers.authorization ?? "";
  if (!authorization.toLowerCase().startsWith("basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return secretMatches(decoded.slice(separator + 1), expectedSecret);
}

// — Normalisation —

/**
 * One provider event, in Monacado's words.
 *
 * `address` is **transient**: it exists so ingestion can find the affected
 * contact, and is reduced to a digest before anything is written.
 */
export interface NormalizedEmailEvent {
  provider: typeof POSTMARK_PROVIDER;
  providerEventId: string;
  eventType: ProviderEmailEventType;
  /** Transient. Never persisted — the digest is. */
  address: string;
  providerMessageRef: string | null;
  occurredAt: string;
}

/**
 * Bounce types that mean the address is permanently unusable.
 *
 * Short and explicit. Everything else in a bounce record is treated as
 * transient — a full mailbox, a greylist, a DNS blip — because the retry policy
 * exists for exactly those and suppressing on one turns a temporary condition
 * into a permanent one the recipient is never told about.
 *
 * @see https://postmarkapp.com/developer/webhooks/bounce-webhook
 */
const HARD_BOUNCE_TYPES = new Set(["HardBounce", "BadEmailAddress"]);
const COMPLAINT_TYPES = new Set(["SpamComplaint", "SpamNotification"]);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * Translate one Postmark webhook body, or refuse it.
 *
 * Returns `null` for a record type Monacado does not act on — an open, a click, a
 * subscription change. Those are answered `200` and ignored: a provider that gets
 * an error for an event it was never asked about will retry it forever.
 */
export function normalizePostmarkEvent(
  payload: unknown,
  receivedAt: string,
): NormalizedEmailEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;

  const recordType = asString(body.RecordType);
  if (recordType === null) return null;

  const providerMessageRef = asString(body.MessageID);

  if (recordType === "Delivery") {
    const address = asString(body.Recipient);
    if (address === null) return null;
    return {
      provider: POSTMARK_PROVIDER,
      /* A delivery record carries no bounce id, so the message id is the event
         identity. One delivery confirmation per message is exactly right. */
      providerEventId: `Delivery:${providerMessageRef ?? normalizeEmail(address)}`,
      eventType: "DELIVERED",
      address,
      providerMessageRef,
      occurredAt: asString(body.DeliveredAt) ?? receivedAt,
    };
  }

  if (recordType !== "Bounce" && recordType !== "SpamComplaint") return null;

  const address = asString(body.Email);
  if (address === null) return null;
  const bounceType = asString(body.Type) ?? recordType;

  const eventType: ProviderEmailEventType =
    recordType === "SpamComplaint" || COMPLAINT_TYPES.has(bounceType)
      ? "SPAM_COMPLAINT"
      : HARD_BOUNCE_TYPES.has(bounceType)
        ? "HARD_BOUNCE"
        : "TRANSIENT_BOUNCE";

  const bounceId = body.ID;
  const providerEventId =
    typeof bounceId === "number" || typeof bounceId === "string"
      ? `${recordType}:${String(bounceId)}`
      : `${recordType}:${providerMessageRef ?? normalizeEmail(address)}`;

  return {
    provider: POSTMARK_PROVIDER,
    providerEventId,
    eventType,
    address,
    providerMessageRef,
    occurredAt: asString(body.BouncedAt) ?? receivedAt,
  };
}
