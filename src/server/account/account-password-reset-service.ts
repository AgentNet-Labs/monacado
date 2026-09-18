/**
 * Account password reset (Phase 1.28) — SERVER ONLY.
 *
 * Lets somebody who can read mail sent to an account's login address choose a
 * new password for it. The same discipline as `account-email-verification-service.ts`
 * — digest-only tokens, supersession, single use, a transactional consume — over
 * its own table, because it grants a different authority.
 *
 * ## It is not email verification
 *
 * Consuming a reset link proves the holder can read that inbox *today*, which is
 * close to what verification proves — and that closeness is exactly why the two
 * are kept apart. Verification has its own lifecycle, its own provenance
 * (`emailVerifiedVia`), and its own consumer; letting a reset quietly set
 * `emailVerifiedAt` would create a second, unrecorded way to verify an address.
 * So a reset changes the password and nothing about verification state.
 *
 * ## What completing a reset does, atomically
 *
 *   1. the challenge flips PENDING → CONSUMED (conditionally, so two concurrent
 *      submissions of one link cannot both succeed);
 *   2. the account's password hash is replaced;
 *   3. every live session for the account is revoked.
 *
 * All three or none. Revocation is the point of step 3: a reset is what somebody
 * does when they think a password is known to somebody else, and leaving that
 * somebody's session alive would make the reset cosmetic.
 *
 * The new password is hashed **before** the transaction opens — Argon2id takes
 * real time, and holding row locks across it would serialise every reset behind
 * the slowest hash — but only after a cheap lookup has found a live link.
 *
 * No session is created. The person signs in with the password they just chose.
 */

import "../server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  ACCOUNT_PASSWORD_RESET_TOKEN_BYTES,
  ACCOUNT_PASSWORD_RESET_TOKEN_TTL_SECONDS,
  AccountPassword,
  AccountPasswordResetChallengeRecord,
  type AccountPasswordResetChallengeRecord as ChallengeRecord,
} from "../../contracts/account/account";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import { getPrisma } from "../db/client";
import { AccountPersistenceFailureError, InvalidAccountInputError } from "./account-errors";
import {
  accountAddressDigest,
  hashAccountVerificationToken,
} from "./account-email-verification-service";
import { hashPassword } from "./password";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

/** Injectable token source, so a test can pin a token exactly. */
export interface AccountPasswordResetTokenProvider {
  nextPasswordResetToken(): string;
}

export const cryptoAccountPasswordResetTokens: AccountPasswordResetTokenProvider = {
  nextPasswordResetToken: () =>
    randomBytes(ACCOUNT_PASSWORD_RESET_TOKEN_BYTES).toString("base64url"),
};

/** Injectable challenge-id source. */
export interface AccountPasswordResetChallengeIdProvider {
  nextChallengeId(): string;
}

const OPAQUE_BODY_LENGTH = 26;

export const cryptoAccountPasswordResetChallengeIds: AccountPasswordResetChallengeIdProvider = {
  nextChallengeId: () => {
    const bytes = randomBytes(OPAQUE_BODY_LENGTH);
    let out = "";
    for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
      out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
    }
    return `mon:aprc:${out}`;
  },
};

export interface AccountPasswordResetDeps {
  db?: Tx;
  ids?: AccountPasswordResetChallengeIdProvider;
  tokens?: AccountPasswordResetTokenProvider;
}

/**
 * The only stored form of a token. The same SHA-256 construction verification
 * uses; the tables are separate, so equal construction cannot make one token
 * valid in the other's consumer.
 */
export const hashAccountPasswordResetToken = hashAccountVerificationToken;

/**
 * A refused reset. The reasons are **internal only** — the route answers every
 * one of them identically, because "this link was already used" and "this link
 * never existed" must not be distinguishable to whoever is holding it.
 */
export class AccountPasswordResetRefusedError extends Error {
  readonly reason: "INVALID_OR_EXPIRED" | "ALREADY_CONSUMED";
  constructor(reason: "INVALID_OR_EXPIRED" | "ALREADY_CONSUMED") {
    super("account password reset refused");
    this.name = "AccountPasswordResetRefusedError";
    this.reason = reason;
  }
}

type ChallengeRow = {
  id: string;
  accountId: string;
  addressDigest: string;
  tokenDigest: string;
  state: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
};

function toRecord(row: ChallengeRow): ChallengeRecord {
  return AccountPasswordResetChallengeRecord.parse({
    challengeId: row.id,
    accountId: row.accountId,
    addressDigest: row.addressDigest,
    tokenDigest: row.tokenDigest,
    state: row.state,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt === null ? null : row.consumedAt.toISOString(),
  });
}

export interface IssuedAccountPasswordResetChallenge {
  challenge: ChallengeRecord;
  /** The ONLY time the raw token exists outside the caller's hands. */
  token: string;
}

/**
 * Mint a reset challenge for an account's current address, superseding any
 * outstanding one — so exactly one reset link works at a time, and it is the
 * most recent.
 */
export async function issueAccountPasswordResetChallenge(
  input: { accountId: string; address: string; issuedAt: string },
  deps: AccountPasswordResetDeps = {},
): Promise<IssuedAccountPasswordResetChallenge> {
  const db = (deps.db ?? getPrisma()) as Db;
  const ids = deps.ids ?? cryptoAccountPasswordResetChallengeIds;
  const tokens = deps.tokens ?? cryptoAccountPasswordResetTokens;

  const token = tokens.nextPasswordResetToken();
  const issuedAt = new Date(input.issuedAt);
  const expiresAt = new Date(
    issuedAt.getTime() + ACCOUNT_PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000,
  );

  try {
    const row = await db.accountPasswordResetChallenge.create({
      data: {
        id: ids.nextChallengeId(),
        accountId: input.accountId,
        addressDigest: accountAddressDigest(input.address),
        tokenDigest: hashAccountPasswordResetToken(token),
        state: "PENDING",
        issuedAt,
        expiresAt,
      },
    });

    /* After the new row exists, as verification does: a crash between the two
       leaves two working links rather than none. */
    await db.accountPasswordResetChallenge.updateMany({
      where: { accountId: input.accountId, state: "PENDING", id: { not: row.id } },
      data: { state: "SUPERSEDED" },
    });

    return { challenge: toRecord(row), token };
  } catch (error) {
    throw new AccountPersistenceFailureError("issue-account-password-reset-challenge", error);
  }
}

/**
 * Replace an account's password with a reset token, and revoke its sessions.
 *
 * The password rule is `AccountPassword` — the same contract registration uses —
 * checked before the token is looked at, so a too-short password never spends a
 * link. It throws `InvalidAccountInputError` for that, and
 * `AccountPasswordResetRefusedError` for anything wrong with the link.
 */
export async function completeAccountPasswordReset(
  input: { token: string; password: string; at: string },
  deps: AccountPasswordResetDeps = {},
): Promise<{ accountId: string; revokedSessionCount: number }> {
  const parsedPassword = AccountPassword.safeParse(input.password);
  if (!parsedPassword.success) throw new InvalidAccountInputError(["password"]);

  const db = (deps.db ?? getPrisma()) as Db;
  const presentedDigest = hashAccountPasswordResetToken(input.token);
  const at = new Date(input.at);

  /* A cheap pre-check, so a made-up token never costs an Argon2id hash: the
     completion endpoint has no attempt budget (a 256-bit token needs none against
     guessing), and hashing first would let anybody spend server CPU for free.
     The transaction below re-checks everything authoritatively. */
  const candidate = await db.accountPasswordResetChallenge.findUnique({
    where: { tokenDigest: presentedDigest },
    select: { state: true, expiresAt: true },
  });
  if (candidate === null || candidate.state !== "PENDING" || candidate.expiresAt <= at) {
    throw new AccountPasswordResetRefusedError(
      candidate?.state === "CONSUMED" ? "ALREADY_CONSUMED" : "INVALID_OR_EXPIRED",
    );
  }

  const passwordHash = await hashPassword(parsedPassword.data);

  return db.$transaction(async (tx) => {
    const row = await tx.accountPasswordResetChallenge.findUnique({
      where: { tokenDigest: presentedDigest },
    });
    if (row === null) throw new AccountPasswordResetRefusedError("INVALID_OR_EXPIRED");

    const a = Buffer.from(row.tokenDigest, "hex");
    const b = Buffer.from(presentedDigest, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AccountPasswordResetRefusedError("INVALID_OR_EXPIRED");
    }

    if (row.state === "CONSUMED") throw new AccountPasswordResetRefusedError("ALREADY_CONSUMED");
    if (row.state !== "PENDING") throw new AccountPasswordResetRefusedError("INVALID_OR_EXPIRED");

    /* Expiry is decided here and not recorded: a write inside this transaction
       would be rolled back by the refusal that follows it. A PENDING row past
       its deadline is unusable from every angle that matters. */
    if (row.expiresAt.getTime() <= at.getTime()) {
      throw new AccountPasswordResetRefusedError("INVALID_OR_EXPIRED");
    }

    const account = await tx.account.findUnique({ where: { id: row.accountId } });
    /* A disabled account is not recovered by a link: re-enabling access is an
       operator decision, and a password change would be a step towards it. */
    if (account === null || account.status !== "ACTIVE") {
      throw new AccountPasswordResetRefusedError("INVALID_OR_EXPIRED");
    }
    if (accountAddressDigest(account.normalizedEmail) !== row.addressDigest) {
      throw new AccountPasswordResetRefusedError("INVALID_OR_EXPIRED");
    }

    /* Conditional on still being PENDING, so two concurrent submissions of the
       same link cannot both pass the read above and both replace the password. */
    const consumed = await tx.accountPasswordResetChallenge.updateMany({
      where: { id: row.id, state: "PENDING" },
      data: { state: "CONSUMED", consumedAt: at },
    });
    if (consumed.count !== 1) throw new AccountPasswordResetRefusedError("ALREADY_CONSUMED");

    /* Password only. `emailVerifiedAt` and `emailVerifiedVia` are deliberately
       absent — see the module header. */
    await tx.account.update({ where: { id: account.id }, data: { passwordHash } });

    const revoked = await tx.accountSession.updateMany({
      where: { accountId: account.id, revokedAt: null },
      data: { revokedAt: at },
    });

    return { accountId: account.id, revokedSessionCount: revoked.count };
  });
}
