/**
 * mName issuance (Phase 1.43) — SERVER ONLY.
 *
 * Monacado assigns a participant's mName in the same transaction that creates
 * the `MarketplaceParticipant` row (`participant-service`), so no participant
 * exists without one. Nothing here updates an issued mName: there is no rename,
 * no participant-facing write, and no derivation from anything the participant
 * or its account holds.
 *
 * How a name is chosen:
 *
 *   1. **Random, never derived.** Each character is one `randomBytes` byte,
 *      rejection-sampled onto the 30-character alphabet (bytes 240–255 are
 *      redrawn, so the draw is unbiased). No account id, participant id, name,
 *      email, clock, or sequence goes in, so issuing order reveals nothing and
 *      neighbouring participants cannot be inferred from each other.
 *   2. **Staged length.** `marketplaceNameStageLength` over the number already
 *      issued — the shortest length whose namespace is under a quarter full.
 *   3. **Pre-checked, then decided by the database.** A drawn candidate already
 *      taken by a committed row is redrawn inside the transaction. Two
 *      transactions drawing the SAME untaken candidate at once are settled by
 *      the unique index: the loser's INSERT fails with P2002 on
 *      `marketplaceName`, its transaction rolls back whole, and
 *      `withMarketplaceNameRetry` runs it again from the start with a fresh draw.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  MARKETPLACE_NAME_ALPHABET,
  MARKETPLACE_NAME_MAX_LENGTH,
  isMarketplaceName,
  marketplaceNameStageLength,
} from "../../contracts/marketplace/marketplace-name";
import { ParticipantPersistenceFailureError } from "./participant-errors";

/** Injectable draw. Production uses the crypto default; a test scripts collisions. */
export interface MarketplaceNameProvider {
  /** One candidate of exactly `length` characters. Need not be untaken. */
  nextCandidate(length: number): string;
}

/** The largest multiple of the alphabet size that fits in a byte: bytes at or above it are redrawn. */
const UNBIASED_BYTE_LIMIT = 256 - (256 % MARKETPLACE_NAME_ALPHABET.length);

function randomCandidate(length: number): string {
  for (;;) {
    let out = "";
    while (out.length < length) {
      for (const byte of randomBytes(length * 2)) {
        if (byte < UNBIASED_BYTE_LIMIT) out += MARKETPLACE_NAME_ALPHABET[byte % MARKETPLACE_NAME_ALPHABET.length];
        if (out.length === length) break;
      }
    }
    // An all-letter or all-digit draw is not an mName; draw again.
    if (isMarketplaceName(out)) return out;
  }
}

export const cryptoMarketplaceNameProvider: MarketplaceNameProvider = {
  nextCandidate: randomCandidate,
};

/** Redraws at one length before the allocation moves up a length. */
export const MARKETPLACE_NAME_DRAWS_PER_LENGTH = 12;

/**
 * An untaken mName, as this transaction sees the table. Reads only — the
 * caller writes it on the participant row it creates.
 *
 * Twelve draws at the stage length, then twelve at the next: with the stage
 * under a quarter full, twelve consecutive collisions happen with probability
 * below 6 × 10⁻⁸, so the longer length is a safety valve rather than a path.
 */
export async function allocateMarketplaceNameIn(
  tx: Prisma.TransactionClient,
  provider: MarketplaceNameProvider = cryptoMarketplaceNameProvider,
): Promise<string> {
  const issued = await tx.marketplaceParticipant.count({ where: { marketplaceName: { not: null } } });
  const stage = marketplaceNameStageLength(issued);
  for (const length of [stage, Math.min(stage + 1, MARKETPLACE_NAME_MAX_LENGTH)]) {
    for (let draw = 0; draw < MARKETPLACE_NAME_DRAWS_PER_LENGTH; draw += 1) {
      const candidate = provider.nextCandidate(length);
      if (candidate.length !== length || !isMarketplaceName(candidate)) {
        throw new ParticipantPersistenceFailureError("allocateMarketplaceName");
      }
      const taken = await tx.marketplaceParticipant.findUnique({
        where: { marketplaceName: candidate },
        select: { id: true },
      });
      if (taken === null) return candidate;
    }
  }
  throw new ParticipantPersistenceFailureError("allocateMarketplaceName");
}

function prismaError(error: unknown): { code?: unknown; meta?: unknown } | null {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown; meta?: unknown })
    : null;
}

/** A unique violation on the mName index — a concurrent transaction issued the same candidate first. */
export function isMarketplaceNameCollision(error: unknown): boolean {
  const e = prismaError(error);
  if (e === null || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return JSON.stringify(target ?? "").includes("marketplaceName");
}

/**
 * A transaction MySQL aborted as a deadlock or write conflict. Not attributable
 * to the mName — Prisma does not say which lock — and not treated as an mName
 * collision: it is never mapped to one, and once attempts run out it surfaces
 * through the caller's ordinary error mapping. It is rerun because concurrent
 * inserts of one unique key can deadlock (the shared locks waiters take on a
 * duplicate), and because the participant-creating transaction is database
 * work only — no email, provider call, or other side effect — so a rolled-back
 * attempt leaves nothing behind and rerunning it is safe.
 */
function isWriteConflict(error: unknown): boolean {
  return prismaError(error)?.code === "P2034";
}

/** Attempts of a whole participant-creating transaction before the collision is reported. */
export const MARKETPLACE_NAME_TRANSACTION_ATTEMPTS = 5;

/**
 * Run a participant-creating transaction, rerunning it from the start when it
 * lost an mName race or MySQL aborted it as a write conflict. Every attempt is
 * a fresh transaction, so a rerun repeats every read the first attempt made.
 * Any other failure — including a P2002 on `accountId` — passes through on the
 * first attempt.
 */
export async function withMarketplaceNameRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const retryable = isMarketplaceNameCollision(error) || isWriteConflict(error);
      if (!retryable || attempt >= MARKETPLACE_NAME_TRANSACTION_ATTEMPTS) throw error;
    }
  }
}
