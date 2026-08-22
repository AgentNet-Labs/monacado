/**
 * Participant email contacts and verification (Phase 1.3) — SERVER ONLY.
 *
 * Issues one-time challenges, consumes them, and maintains the contact states the
 * support resolver reads.
 *
 * ## The token never touches storage
 *
 * `issueVerificationChallenge` returns the raw token **once**. Only its SHA-256
 * digest is written — the same construction `0M.9` uses for a guest claim code
 * and `1.1` for a delivery destination. A plaintext token column is a table of
 * working account takeovers, and it is the kind of column that gets added "just
 * for debugging" and never removed.
 *
 * ## Single-use, and unforgeably so
 *
 * Consuming moves the challenge to `CONSUMED` inside the same transaction that
 * verifies the contact, so a replayed link finds a challenge that is no longer
 * pending. Issuing a new challenge `SUPERSEDED`s any outstanding one for the same
 * contact, so a token from an abandoned attempt cannot be used later.
 *
 * ## Every refusal looks the same
 *
 * `VerificationRefusedError` carries a bounded reason and no detail. Telling a
 * caller that a token exists but has expired — rather than that it never existed
 * — is the difference between a failure and an oracle, and the same reasoning
 * `claimGuestOrder` applies.
 *
 * ## No mailbox probing
 *
 * Syntax is checked and ownership is proved by a one-time link. SMTP `VRFY` and
 * dial-up probes are unreliable (catch-all domains accept everything, greylisting
 * rejects everything on first contact), widely treated as abuse, and prove
 * nothing about who controls a mailbox even when they answer.
 */

import "../server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  EmailVerificationChallengeRecord,
  ParticipantEmailContactRecord,
  VERIFICATION_TOKEN_BYTES,
  VERIFICATION_TOKEN_TTL_SECONDS,
  type EmailContactPurpose,
  type EmailContactState,
} from "../../contracts/marketplace/participant-email-contact";
import { AccountEmail, normalizeEmail } from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { cryptoPolicyIdProvider, type PolicyIdProvider } from "./policy-ids";
import {
  PolicyError,
  PolicyPersistenceFailureError,
  VerificationRefusedError,
} from "./policy-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface VerificationDeps {
  db?: Db;
  ids?: PolicyIdProvider;
  /** Injected so a test can assert the digest of a known token. */
  tokens?: { nextVerificationToken(): string };
}

/** 256 bits, base64url. High entropy: it is the whole access control. */
export const cryptoVerificationTokenProvider = {
  nextVerificationToken: (): string =>
    randomBytes(VERIFICATION_TOKEN_BYTES).toString("base64url"),
};

/** Hex SHA-256. The only form of a token that is ever written down. */
export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Normalised-address digest, so a challenge cannot be redirected after issue. */
export function addressDigest(address: string): string {
  return createHash("sha256").update(normalizeEmail(address), "utf8").digest("hex");
}

interface ContactRow {
  id: string;
  participantId: string;
  purpose: string;
  address: string | null;
  state: string;
  verifiedAt: Date | null;
  degradedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function contactToRecord(row: ContactRow): ParticipantEmailContactRecord {
  const parsed = ParticipantEmailContactRecord.safeParse({
    contactId: row.id,
    participantId: row.participantId,
    purpose: row.purpose,
    address: row.address,
    state: row.state,
    verifiedAt: row.verifiedAt === null ? null : row.verifiedAt.toISOString(),
    degradedAt: row.degradedAt === null ? null : row.degradedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new PolicyError("CORRUPT_EMAIL_CONTACT", "A persisted email contact is malformed");
  }
  return parsed.data;
}

// — Contacts —

/**
 * Register or replace a contact for one purpose.
 *
 * Always lands `UNVERIFIED`: there is no parameter through which a caller could
 * assert an address is already verified, which is what makes verification mean
 * something. Replacing a `DEDICATED_SUPPORT` address resets it to `UNVERIFIED`
 * and supersedes any outstanding challenge — so a seller who mistypes an address
 * and retypes it cannot accidentally verify the first.
 *
 * A `PRIMARY_PROFILE` contact stores **no address**: it records the state of the
 * address on `Account`, which is where it lives.
 */
export async function upsertEmailContact(
  input: {
    participantId: string;
    purpose: EmailContactPurpose;
    /** Required for `DEDICATED_SUPPORT`; must be absent for `PRIMARY_PROFILE`. */
    address?: string;
    now: string;
  },
  deps: VerificationDeps = {},
): Promise<ParticipantEmailContactRecord> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoPolicyIdProvider;

  let address: string | null = null;
  if (input.purpose === "DEDICATED_SUPPORT") {
    const parsed = AccountEmail.safeParse((input.address ?? "").trim());
    if (!parsed.success) {
      throw new PolicyError("INVALID_EMAIL_ADDRESS", "That is not a usable email address");
    }
    address = normalizeEmail(parsed.data);
  } else if (input.address !== undefined) {
    /* 0M.5: the primary address lives on Account and a second copy here would be
       a second thing to leak. Refused rather than silently dropped. */
    throw new PolicyError(
      "PRIMARY_ADDRESS_NOT_STORED",
      "A primary profile contact never stores a copy of the address",
    );
  }

  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.participantEmailContact.findUnique({
        where: {
          participantId_purpose: {
            participantId: input.participantId,
            purpose: input.purpose,
          },
        },
      });

      /* An address that did not change keeps its state — re-saving a form must
         not un-verify a working contact. */
      if (existing !== null && existing.address === address) {
        return contactToRecord(existing);
      }

      const row =
        existing === null
          ? await tx.participantEmailContact.create({
              data: {
                id: ids.nextEmailContactId(),
                participantId: input.participantId,
                purpose: input.purpose,
                address,
                state: "UNVERIFIED",
                createdAt: new Date(input.now),
              },
            })
          : await tx.participantEmailContact.update({
              where: { id: existing.id },
              data: {
                address,
                state: "UNVERIFIED",
                verifiedAt: null,
                degradedAt: null,
              },
            });

      /* A challenge issued for the old address must not verify the new one. */
      await tx.emailVerificationChallenge.updateMany({
        where: { contactId: row.id, state: "PENDING" },
        data: { state: "SUPERSEDED" },
      });

      return contactToRecord(row);
    });
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyPersistenceFailureError("upsertEmailContact", error);
  }
}

export async function getEmailContact(
  participantId: string,
  purpose: EmailContactPurpose,
  deps: VerificationDeps = {},
): Promise<ParticipantEmailContactRecord | null> {
  const db = deps.db ?? getPrisma();
  const row = await db.participantEmailContact.findUnique({
    where: { participantId_purpose: { participantId, purpose } },
  });
  return row === null ? null : contactToRecord(row);
}

/**
 * Degrade a previously verified contact.
 *
 * The transition a future bounce signal will drive. Nothing calls it
 * automatically in this phase — see `BOUNCE_POSTURE` — but the path exists so a
 * verified address can become unusable **without** rewriting history: the
 * `verifiedAt` instant is kept, and `degradedAt` records when it stopped being
 * trustworthy.
 */
export async function degradeEmailContact(
  input: {
    participantId: string;
    purpose: EmailContactPurpose;
    to: Extract<EmailContactState, "REVERIFY_REQUIRED" | "DELIVERY_FAILED">;
    at: string;
  },
  deps: VerificationDeps = {},
): Promise<ParticipantEmailContactRecord> {
  const db = deps.db ?? getPrisma();
  const row = await db.participantEmailContact.update({
    where: {
      participantId_purpose: {
        participantId: input.participantId,
        purpose: input.purpose,
      },
    },
    data: { state: input.to, degradedAt: new Date(input.at) },
  });
  return contactToRecord(row);
}

// — Challenges —

export interface IssuedChallenge {
  challenge: EmailVerificationChallengeRecord;
  /**
   * The raw token, returned **once** and stored nowhere.
   *
   * The caller puts it in a link and forgets it. Monacado kept only the digest
   * and cannot reissue this token — a fresh challenge is the remedy.
   */
  token: string;
}

function challengeToRecord(row: {
  id: string;
  participantId: string;
  purpose: string;
  addressDigest: string;
  tokenDigest: string;
  state: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}): EmailVerificationChallengeRecord {
  const parsed = EmailVerificationChallengeRecord.safeParse({
    challengeId: row.id,
    participantId: row.participantId,
    purpose: row.purpose,
    addressDigest: row.addressDigest,
    tokenDigest: row.tokenDigest,
    state: row.state,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt === null ? null : row.consumedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new PolicyError("CORRUPT_CHALLENGE", "A persisted verification challenge is malformed");
  }
  return parsed.data;
}

/**
 * Issue one time-boxed proof-of-control challenge.
 *
 * Any outstanding challenge for the contact is `SUPERSEDED` first, so exactly one
 * token is live at a time and an abandoned attempt cannot be completed later.
 */
export async function issueVerificationChallenge(
  input: {
    participantId: string;
    purpose: EmailContactPurpose;
    /** The address being proved — from `Account` for a primary contact. */
    address: string;
    issuedAt: string;
  },
  deps: VerificationDeps = {},
): Promise<IssuedChallenge> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoPolicyIdProvider;
  const tokens = deps.tokens ?? cryptoVerificationTokenProvider;

  const contact = await db.participantEmailContact.findUnique({
    where: {
      participantId_purpose: { participantId: input.participantId, purpose: input.purpose },
    },
  });
  if (contact === null) {
    throw new PolicyError("EMAIL_CONTACT_NOT_FOUND", "No such email contact");
  }

  const token = tokens.nextVerificationToken();
  const expiresAt = new Date(
    new Date(input.issuedAt).getTime() + VERIFICATION_TOKEN_TTL_SECONDS * 1_000,
  );

  try {
    return await db.$transaction(async (tx) => {
      await tx.emailVerificationChallenge.updateMany({
        where: { contactId: contact.id, state: "PENDING" },
        data: { state: "SUPERSEDED" },
      });
      const row = await tx.emailVerificationChallenge.create({
        data: {
          id: ids.nextVerificationChallengeId(),
          contactId: contact.id,
          participantId: input.participantId,
          purpose: input.purpose,
          addressDigest: addressDigest(input.address),
          tokenDigest: hashVerificationToken(token),
          state: "PENDING",
          issuedAt: new Date(input.issuedAt),
          expiresAt,
        },
      });
      return { challenge: challengeToRecord(row), token };
    });
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyPersistenceFailureError("issueVerificationChallenge", error);
  }
}

/**
 * Consume one challenge and verify its contact.
 *
 * One transaction: a consumed challenge without a verified contact — or the
 * reverse — is impossible rather than unlikely.
 *
 * The digest is compared with `timingSafeEqual`. The lookup is already by unique
 * index so the timing signal is small, but a constant-time compare costs nothing
 * and removes the question.
 */
export async function consumeVerificationChallenge(
  input: { token: string; at: string },
  deps: VerificationDeps = {},
): Promise<ParticipantEmailContactRecord> {
  const db = deps.db ?? getPrisma();
  const digest = hashVerificationToken(input.token);

  try {
    return await db.$transaction(async (tx) => {
      const challenge = await tx.emailVerificationChallenge.findUnique({
        where: { tokenDigest: digest },
      });
      /* Every refusal is the same error: distinguishing "no such token" from
         "expired" would make this an oracle for probing which tokens exist. */
      if (challenge === null) throw new VerificationRefusedError("INVALID_OR_EXPIRED");

      const stored = Buffer.from(challenge.tokenDigest, "hex");
      const offered = Buffer.from(digest, "hex");
      if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
        throw new VerificationRefusedError("INVALID_OR_EXPIRED");
      }

      if (challenge.state === "CONSUMED") {
        throw new VerificationRefusedError("ALREADY_CONSUMED");
      }
      if (challenge.state !== "PENDING") {
        throw new VerificationRefusedError("INVALID_OR_EXPIRED");
      }
      if (challenge.expiresAt.getTime() <= new Date(input.at).getTime()) {
        await tx.emailVerificationChallenge.update({
          where: { id: challenge.id },
          data: { state: "EXPIRED" },
        });
        throw new VerificationRefusedError("INVALID_OR_EXPIRED");
      }

      await tx.emailVerificationChallenge.update({
        where: { id: challenge.id },
        data: { state: "CONSUMED", consumedAt: new Date(input.at) },
      });

      const contact = await tx.participantEmailContact.update({
        where: { id: challenge.contactId },
        data: { state: "VERIFIED", verifiedAt: new Date(input.at), degradedAt: null },
      });
      return contactToRecord(contact);
    });
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyPersistenceFailureError("consumeVerificationChallenge", error);
  }
}

/** Shared read, usable inside and outside a transaction. */
export async function listEmailContactsIn(
  tx: Tx,
  participantId: string,
): Promise<ParticipantEmailContactRecord[]> {
  const rows = await tx.participantEmailContact.findMany({ where: { participantId } });
  return rows.map(contactToRecord);
}
