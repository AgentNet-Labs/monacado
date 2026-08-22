/**
 * Participant email contacts and verification (Phase 1.3).
 *
 * Two things, kept apart on purpose:
 *
 *   - a **contact** — an address Monacado may use for a stated purpose, and the
 *     state of Monacado's belief that it works;
 *   - a **challenge** — one time-boxed attempt to prove somebody controls it.
 *
 * ## Why a contact carries a state and not just a timestamp
 *
 * `ParticipantProfile.emailVerifiedAt` already records *that* verification
 * happened, and it cannot express what a support address needs to express: an
 * address that verified last year and has been bouncing since is not verified in
 * any useful sense, and a nullable timestamp has no way to say so. A state can
 * degrade; an instant cannot.
 *
 * ## Why the primary address is not stored here
 *
 * `0M.5` was explicit — "the address already lives on `Account` and a second copy
 * here would be a second thing to leak." That still holds. A `PRIMARY_PROFILE`
 * contact therefore stores **no address at all**: it records the *state* of the
 * address on `Account`, and resolution reads the address from there. Only a
 * `DEDICATED_SUPPORT` address is stored, because it exists nowhere else and is
 * deliberately disclosed to customers.
 *
 * ## Why a token is never stored
 *
 * A verification link is a bearer credential. Stored in plaintext, a table read
 * is a set of working account takeovers. Only a SHA-256 digest is kept — the same
 * construction `0M.9` uses for a guest claim code and `1.1` for a delivery
 * destination — and the raw token is returned exactly once, to be put in a link
 * and then forgotten.
 *
 * Pure types and pure decisions. No I/O, no clock, no mail.
 */

import { z } from "zod";
import {
  EMAIL_VERIFICATION_CHALLENGE_ID_RE,
  PARTICIPANT_EMAIL_CONTACT_ID_RE,
} from "./identity";
import { AccountEmail } from "../account/account";

// — Identity —

export const ParticipantEmailContactId = z
  .string()
  .regex(PARTICIPANT_EMAIL_CONTACT_ID_RE, "contactId must be mon:pemc:<opaque>");
export type ParticipantEmailContactId = z.infer<typeof ParticipantEmailContactId>;

export const EmailVerificationChallengeId = z
  .string()
  .regex(EMAIL_VERIFICATION_CHALLENGE_ID_RE, "challengeId must be mon:evch:<opaque>");
export type EmailVerificationChallengeId = z.infer<typeof EmailVerificationChallengeId>;

// — Purpose —

/**
 * What an address is for.
 *
 * Two purposes, one row each, so a seller can be mid-way through verifying a new
 * support address without that touching the primary address anything else
 * depends on. The precedence between them is `resolveEffectiveSupportContact`'s
 * and lives in exactly one place.
 */
export const EMAIL_CONTACT_PURPOSES = [
  /** The address on the participant's `Account`. No copy is stored here. */
  "PRIMARY_PROFILE",
  /** An address the seller nominated specifically for customer support. */
  "DEDICATED_SUPPORT",
] as const;
export const EmailContactPurpose = z.enum(EMAIL_CONTACT_PURPOSES);
export type EmailContactPurpose = z.infer<typeof EmailContactPurpose>;

// — State —

/**
 * Monacado's belief about whether an address works.
 *
 *   - `UNVERIFIED` — nobody has proved control of it. It is **never** customer-
 *     facing, and a nominated-but-unverified support address does not displace a
 *     working one.
 *   - `VERIFIED` — control was proved and nothing since has suggested otherwise.
 *   - `REVERIFY_REQUIRED` — it verified once and something has since indicated it
 *     no longer works. **Not** `UNVERIFIED`: the distinction records that the
 *     address was once good, which is what tells an operator this is a regression
 *     rather than an unfinished setup.
 *   - `DELIVERY_FAILED` — delivery has hard-failed. Terminal until replaced.
 *
 * The last two exist so a previously verified address can become unusable
 * **without** rewriting history. Nothing in this phase transitions into them
 * automatically — see `BOUNCE_POSTURE`.
 */
export const EMAIL_CONTACT_STATES = [
  "UNVERIFIED",
  "VERIFIED",
  "REVERIFY_REQUIRED",
  "DELIVERY_FAILED",
] as const;
export const EmailContactState = z.enum(EMAIL_CONTACT_STATES);
export type EmailContactState = z.infer<typeof EmailContactState>;

/** States in which an address may be used to reach a customer. Exactly one. */
export function isUsableContactState(state: EmailContactState): boolean {
  return state === "VERIFIED";
}

/**
 * What this phase does and does not do about bounces.
 *
 * **Does:** provide the states a degraded address needs, and a resolver that
 * fails closed when none is usable.
 *
 * **Does not:** ingest provider feedback, classify bounces, maintain a
 * suppression list, or score a domain's reputation. Those need the delivery
 * feedback loop `0M.N2` owns, and a reputation system built without one would be
 * scoring addresses on no evidence.
 *
 * A future hard-bounce or complaint signal transitions a `VERIFIED` contact to
 * `REVERIFY_REQUIRED` or `DELIVERY_FAILED`; the seller then supplies and verifies
 * a replacement. Everything needed for that transition exists now except the
 * signal.
 */
export const BOUNCE_POSTURE = {
  statesAvailable: ["REVERIFY_REQUIRED", "DELIVERY_FAILED"],
  automaticTransitions: "NONE_IN_THIS_PHASE",
  futureSignalSource: "PROVIDER_FEEDBACK_0M_N2",
  onDegradation: "SELLER_SUPPLIES_AND_VERIFIES_REPLACEMENT",
} as const;

// — Contact record —

/**
 * One address a participant may be reached at, for one purpose.
 *
 * `address` is `null` for `PRIMARY_PROFILE` — the address lives on `Account` and
 * is read from there. It is required for `DEDICATED_SUPPORT`, which exists
 * nowhere else.
 */
export const ParticipantEmailContactRecord = z
  .strictObject({
    contactId: ParticipantEmailContactId,
    participantId: z.string().min(1).max(191),
    purpose: EmailContactPurpose,
    /** `null` for `PRIMARY_PROFILE`; the address itself for `DEDICATED_SUPPORT`. */
    address: AccountEmail.nullable(),
    state: EmailContactState,
    verifiedAt: z.iso.datetime().nullable(),
    /** When the state last degraded. Kept so a regression is dateable. */
    degradedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine(
    (c) => (c.purpose === "DEDICATED_SUPPORT" ? c.address !== null : c.address === null),
    "a dedicated support contact carries its address; a primary contact never stores a copy",
  )
  .refine(
    (c) => (c.state === "VERIFIED" ? c.verifiedAt !== null : true),
    "a VERIFIED contact must record when it was verified",
  );
export type ParticipantEmailContactRecord = z.infer<typeof ParticipantEmailContactRecord>;

// — Effective support contact —

/**
 * Why a seller has no usable support address.
 *
 * Bounded codes, so an activation refusal is actionable without free text.
 */
export const SUPPORT_CONTACT_UNAVAILABLE_REASONS = [
  /** Nothing has been verified at all. */
  "NO_VERIFIED_ADDRESS",
  /** The only verified address has since degraded. */
  "VERIFIED_ADDRESS_REQUIRES_REVERIFICATION",
] as const;
export const SupportContactUnavailableReason = z.enum(SUPPORT_CONTACT_UNAVAILABLE_REASONS);
export type SupportContactUnavailableReason = z.infer<typeof SupportContactUnavailableReason>;

/**
 * The address customers are given, and which contact supplied it.
 *
 * `source` is carried so a support surface can explain *why* an address is the
 * one shown, which is the first question anybody asks when it is the wrong one.
 */
export const EffectiveSupportContact = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    address: AccountEmail,
    source: EmailContactPurpose,
  }),
  z.strictObject({
    available: z.literal(false),
    reason: SupportContactUnavailableReason,
  }),
]);
export type EffectiveSupportContact = z.infer<typeof EffectiveSupportContact>;

/**
 * **The one place support-address precedence is decided.**
 *
 * ```
 * 1. a VERIFIED dedicated support address, if one is configured
 * 2. otherwise the VERIFIED primary account address
 * 3. otherwise: no valid support contact
 * ```
 *
 * Two properties matter more than the ordering:
 *
 *   - **An unverified dedicated address never displaces a working primary one.**
 *     A seller who types a new address and has not yet clicked the link keeps the
 *     contact customers already had. The alternative — switching optimistically —
 *     would make every typo an outage on the one channel a buyer uses to complain
 *     about it.
 *   - **A degraded dedicated address falls back rather than failing.** If the
 *     nominated address stops working but the primary still verifies, customers
 *     keep a route through. Only when nothing is usable does this return
 *     unavailable, and activation then fails closed.
 *
 * Pure: it takes state and returns an answer. Every surface — checkout, receipt,
 * digital delivery, seller services — must call this rather than reimplementing
 * the precedence, because four copies of a fallback rule is four chances to
 * disclose the wrong address.
 */
export function resolveEffectiveSupportContact(input: {
  /** The address on `Account`, and Monacado's belief about it. */
  primary: { address: string; state: EmailContactState } | null;
  /** The nominated support address, if the seller configured one. */
  dedicated: { address: string; state: EmailContactState } | null;
}): EffectiveSupportContact {
  if (input.dedicated !== null && isUsableContactState(input.dedicated.state)) {
    return {
      available: true,
      address: input.dedicated.address,
      source: "DEDICATED_SUPPORT",
    };
  }
  if (input.primary !== null && isUsableContactState(input.primary.state)) {
    return { available: true, address: input.primary.address, source: "PRIMARY_PROFILE" };
  }

  /* Distinguish "never set up" from "was working and broke": an operator needs
     to know whether to chase onboarding or an outage. */
  const everVerified =
    (input.primary !== null && input.primary.state !== "UNVERIFIED") ||
    (input.dedicated !== null && input.dedicated.state !== "UNVERIFIED");
  return {
    available: false,
    reason: everVerified
      ? "VERIFIED_ADDRESS_REQUIRES_REVERIFICATION"
      : "NO_VERIFIED_ADDRESS",
  };
}

// — Verification challenge —

/** Hex SHA-256 of the issued token. The token itself is never stored. */
export const VerificationTokenDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "tokenDigest must be a lowercase hex SHA-256");

export const CHALLENGE_STATES = ["PENDING", "CONSUMED", "EXPIRED", "SUPERSEDED"] as const;
export const ChallengeState = z.enum(CHALLENGE_STATES);
export type ChallengeState = z.infer<typeof ChallengeState>;

/** How long an issued challenge stands. Short: it is a bearer credential. */
export const VERIFICATION_TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** Bytes of randomness behind a token. 256 bits, as everything else here. */
export const VERIFICATION_TOKEN_BYTES = 32;

/**
 * One attempt to prove control of an address.
 *
 * **Single-use**: consuming it moves it to `CONSUMED`, and the unique digest
 * index means a replayed link finds a challenge that is no longer pending.
 * Issuing a new challenge for the same contact `SUPERSEDED`s any outstanding one,
 * so a token from an abandoned attempt cannot be used later.
 *
 * Note what is absent: the token, the address in plaintext for a primary contact,
 * an IP address, a user agent, and any attempt counter. A challenge records that
 * a proof was issued and what became of it — nothing about the person.
 */
export const EmailVerificationChallengeRecord = z.strictObject({
  challengeId: EmailVerificationChallengeId,
  participantId: z.string().min(1).max(191),
  purpose: EmailContactPurpose,
  /** Digest of the address proved, so a challenge cannot be redirected. */
  addressDigest: z.string().regex(/^[0-9a-f]{64}$/),
  tokenDigest: VerificationTokenDigest,
  state: ChallengeState,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  consumedAt: z.iso.datetime().nullable(),
});
export type EmailVerificationChallengeRecord = z.infer<
  typeof EmailVerificationChallengeRecord
>;

/**
 * What verification does and does not prove.
 *
 * Syntax and a signed one-time link prove **control of a mailbox at that
 * address** at one instant. They do not prove continued reachability, and this
 * phase does not pretend otherwise — which is why `REVERIFY_REQUIRED` exists.
 *
 * **SMTP mailbox probing is deliberately not used.** `VRFY` and dial-up
 * connection tests are unreliable (catch-all domains accept everything,
 * greylisting rejects everything on first contact), widely treated as abuse, and
 * prove nothing about who controls the mailbox even when they answer.
 */
export const VERIFICATION_METHOD = {
  syntax: "REQUIRED",
  domainRouting: "BEST_EFFORT_ADVISORY",
  ownership: "SIGNED_SINGLE_USE_LINK",
  smtpMailboxProbing: "NOT_USED",
  proves: "CONTROL_AT_ONE_INSTANT",
} as const;

// — Never here —

/**
 * Named as never-persistable, and refused by the shapes above.
 */
export const NEVER_ON_EMAIL_CONTACT = [
  // the credential itself — a stored token is a working takeover
  "token",
  "verificationToken",
  "tokenPlaintext",
  "verificationLink",
  "signedUrl",
  // tracking — a challenge records a proof, not a person
  "ipAddress",
  "userAgent",
  "deviceFingerprint",
  "geoLocation",
  // reputation machinery this phase does not build
  "bounceScore",
  "reputationScore",
  "suppressionList",
] as const;
