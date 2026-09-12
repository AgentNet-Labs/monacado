/**
 * Account email verification (Phase 1.27) — SERVER ONLY.
 *
 * Proves that whoever registered an address can read mail sent to it. Until this
 * phase Monacado had no such proof for a login address at all: `createAccount`
 * made an `ACTIVE` account and `authenticateAccount` let it straight in, so a
 * person could register with somebody else's address and hold an account keyed to
 * it forever.
 *
 * ## Why this is not the participant verifier
 *
 * `src/server/policy/email-verification-service.ts` already does this shape of
 * work, and it cannot be reused. Its challenge row requires a `contactId` into
 * `ParticipantEmailContact` and a `participantId` into `MarketplaceParticipant` —
 * both non-nullable — so verifying a bare Account through it would mean creating
 * a marketplace participant for somebody who has done nothing but register. That
 * would collapse the separation the schema is built around, where "has a login"
 * and "may sell" are different facts. The architecture ruling for this phase
 * forbids it in as many words.
 *
 * So this is a parallel implementation with the same discipline and a different
 * subject, and the two never meet: different tables, different id prefixes
 * (`mon:aevc:` against `mon:evch:`), different routes, and different consumers.
 * **Neither verifier can consume the other's token**, because each looks its
 * token up in its own table and a digest that is not there is simply not valid.
 *
 * ## The token is never stored
 *
 * `issueAccountEmailChallenge` returns the raw token exactly once, to its caller,
 * and persists only `sha256(token)`. A dump of this table yields no working link.
 * Matching is by digest through a unique index, and the comparison that decides
 * acceptance is `timingSafeEqual` rather than `===`.
 *
 * ## A challenge is bound to an address, not just to an account
 *
 * `addressDigest` captures the normalised address at issuance, and consumption
 * re-derives it from the account's **current** address and refuses on mismatch.
 * Without that, a link mailed to an old address would still verify an account
 * after its address changed — which would let somebody who briefly controlled an
 * address verify an account that no longer uses it.
 */

import "../server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  ACCOUNT_VERIFICATION_TOKEN_BYTES,
  ACCOUNT_VERIFICATION_TOKEN_TTL_SECONDS,
  AccountEmailChallengeRecord,
  normalizeEmail,
  type AccountEmailChallengeRecord as ChallengeRecord,
} from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import { AccountPersistenceFailureError } from "./account-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

/** Injectable token source, so a test can pin a token exactly. */
export interface AccountVerificationTokenProvider {
  nextVerificationToken(): string;
}

export const cryptoAccountVerificationTokens: AccountVerificationTokenProvider = {
  nextVerificationToken: () => randomBytes(ACCOUNT_VERIFICATION_TOKEN_BYTES).toString("base64url"),
};

/** Injectable challenge-id source. */
export interface AccountChallengeIdProvider {
  nextChallengeId(): string;
}

const OPAQUE_BODY_LENGTH = 26;

export const cryptoAccountChallengeIds: AccountChallengeIdProvider = {
  nextChallengeId: () => {
    const bytes = randomBytes(OPAQUE_BODY_LENGTH);
    let out = "";
    for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
      out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
    }
    return `mon:aevc:${out}`;
  },
};

export interface AccountVerificationDeps {
  db?: Tx;
  ids?: AccountChallengeIdProvider;
  tokens?: AccountVerificationTokenProvider;
}

/** The only stored form of a token. */
export function hashAccountVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** SHA-256 of the normalised address a challenge is bound to. */
export function accountAddressDigest(address: string): string {
  return createHash("sha256").update(normalizeEmail(address)).digest("hex");
}

/**
 * The refusal a consumer gets. One type, two reasons, and the distinction is
 * **internal only** — `account-verification-route-handler.ts` collapses them
 * into a bounded outcome, and neither reason reaches a caller as text.
 */
export class AccountVerificationRefusedError extends Error {
  readonly reason: "INVALID_OR_EXPIRED" | "ALREADY_CONSUMED";
  constructor(reason: "INVALID_OR_EXPIRED" | "ALREADY_CONSUMED") {
    super("account email verification refused");
    this.name = "AccountVerificationRefusedError";
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
  return AccountEmailChallengeRecord.parse({
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

export interface IssuedAccountChallenge {
  challenge: ChallengeRecord;
  /** The ONLY time the raw token exists outside the caller's hands. */
  token: string;
}

/**
 * Mint a challenge for an account's current address, superseding any outstanding
 * one.
 *
 * Supersession rather than accumulation: a person who asks for a second link
 * expects the second one to be the live one, and leaving the first valid would
 * mean a link they have already abandoned still verifies their account. It also
 * bounds how many working links can exist for an address at once — exactly one.
 */
export async function issueAccountEmailChallenge(
  input: { accountId: string; address: string; issuedAt: string },
  deps: AccountVerificationDeps = {},
): Promise<IssuedAccountChallenge> {
  const db = (deps.db ?? getPrisma()) as Db;
  const ids = deps.ids ?? cryptoAccountChallengeIds;
  const tokens = deps.tokens ?? cryptoAccountVerificationTokens;

  const token = tokens.nextVerificationToken();
  const issuedAt = new Date(input.issuedAt);
  const expiresAt = new Date(
    issuedAt.getTime() + ACCOUNT_VERIFICATION_TOKEN_TTL_SECONDS * 1000,
  );

  try {
    const row = await db.accountEmailVerificationChallenge.create({
      data: {
        id: ids.nextChallengeId(),
        accountId: input.accountId,
        addressDigest: accountAddressDigest(input.address),
        tokenDigest: hashAccountVerificationToken(token),
        state: "PENDING",
        issuedAt,
        expiresAt,
      },
    });

    /* Supersede AFTER the new row exists, so a crash between the two leaves the
       person with two working links rather than none. Two is recoverable; none
       is a dead end that needs an operator. */
    await db.accountEmailVerificationChallenge.updateMany({
      where: { accountId: input.accountId, state: "PENDING", id: { not: row.id } },
      data: { state: "SUPERSEDED" },
    });

    return { challenge: toRecord(row), token };
  } catch (error) {
    throw new AccountPersistenceFailureError("issue-account-email-challenge", error);
  }
}

/**
 * Consume a token, verify the account's address, and mark the challenge used.
 *
 * Everything happens in one transaction: the challenge flips to `CONSUMED` and
 * the account's `emailVerifiedAt` is set together, so a crash cannot leave a
 * spent token beside an unverified account.
 *
 * The refusal is uniform across "never existed", "expired", and "superseded".
 * Only an already-consumed challenge is distinguished, and only internally —
 * it is a genuinely different situation for a person who clicked their link
 * twice, and the route turns it into reassurance rather than an error.
 */
export async function consumeAccountEmailChallenge(
  input: { token: string; at: string },
  deps: AccountVerificationDeps = {},
): Promise<{ accountId: string }> {
  const db = (deps.db ?? getPrisma()) as Db;
  const presentedDigest = hashAccountVerificationToken(input.token);
  const at = new Date(input.at);

  return db.$transaction(async (tx) => {
    const row = await tx.accountEmailVerificationChallenge.findUnique({
      where: { tokenDigest: presentedDigest },
    });
    if (row === null) throw new AccountVerificationRefusedError("INVALID_OR_EXPIRED");

    /* The unique index already found this row BY the digest, so this comparison
       cannot fail in practice. It is here because the digest is a secret-derived
       value and comparing it with `===` would be the habit that matters
       somewhere it is reachable. */
    const a = Buffer.from(row.tokenDigest, "hex");
    const b = Buffer.from(presentedDigest, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AccountVerificationRefusedError("INVALID_OR_EXPIRED");
    }

    if (row.state === "CONSUMED") throw new AccountVerificationRefusedError("ALREADY_CONSUMED");
    if (row.state !== "PENDING") throw new AccountVerificationRefusedError("INVALID_OR_EXPIRED");

    if (row.expiresAt.getTime() <= at.getTime()) {
      /* Recorded lazily, on the attempt that discovers it. There is no sweeper,
         and a row that nobody ever comes back for simply stays PENDING and
         unusable — which is the same thing from every angle that matters. */
      await tx.accountEmailVerificationChallenge.update({
        where: { id: row.id },
        data: { state: "EXPIRED" },
      });
      throw new AccountVerificationRefusedError("INVALID_OR_EXPIRED");
    }

    const account = await tx.account.findUnique({ where: { id: row.accountId } });
    if (account === null) throw new AccountVerificationRefusedError("INVALID_OR_EXPIRED");

    /* The binding check. A challenge issued for one address cannot verify a
       different one, so changing an account's address invalidates links already
       in flight to the old one. */
    if (accountAddressDigest(account.normalizedEmail) !== row.addressDigest) {
      throw new AccountVerificationRefusedError("INVALID_OR_EXPIRED");
    }

    await tx.accountEmailVerificationChallenge.update({
      where: { id: row.id },
      data: { state: "CONSUMED", consumedAt: at },
    });

    await tx.account.update({
      where: { id: account.id },
      data: { emailVerifiedAt: at, emailVerifiedVia: "SELF_SERVICE_TOKEN" },
    });

    return { accountId: account.id };
  });
}
