/**
 * mName — the Monacado-assigned marketplace identifier (Phase 1.43) — pure.
 *
 * One `MarketplaceParticipant` has exactly one mName, the same whether it acts
 * as Seller, Promoter, or both, however many Storefronts it owns. It is the ONLY
 * participant identity another participant ever sees (Contract §4, §5):
 * declared first / last names, `Account.name`, email, and every internal id stay
 * private.
 *
 * What it is: short, opaque, globally unique, stable, and safe to say aloud,
 * type, search, and sort. What it is NOT: a personal name, a Storefront or
 * brand name, an `Account.name` alias, an email-derived handle, a sequence, or
 * an encoding of any internal id. Monacado assigns it when the participant row
 * is created; the participant never chooses or edits it.
 *
 * ## Alphabet — 30 characters, lowercase
 *
 *   `23456789abcdefghjkmnpqrstvwxyz`
 *
 * The Crockford base-32 set, lowercased, minus `0` and `1`. Crockford already
 * drops `i`, `l`, `o`, and `u`; dropping `0` and `1` too leaves no 0/O or 1/l/I
 * pair at all, even in a font that draws them alike. Lowercase only, so there is
 * no case to mistype.
 *
 * ## Shape — at least one letter AND at least one digit
 *
 * An mName is never all letters, so it can never spell a word — no brand, no
 * profanity, no impersonation of "shop" or "admin" — and never all digits, so it
 * never reads as a number, a price, or a sequence position.
 *
 * ## Staged length
 *
 * Issuance starts at {@link MARKETPLACE_NAME_MIN_LENGTH} and moves to the next
 * length only once the names already issued fill {@link MARKETPLACE_NAME_STAGE_OCCUPANCY}
 * of the current length's namespace — so a random draw at the current length
 * collides with probability below that bound. An issued mName never changes when
 * later ones are longer.
 */

import { z } from "zod";

export const MARKETPLACE_NAME_DIGITS = "23456789" as const;
export const MARKETPLACE_NAME_LETTERS = "abcdefghjkmnpqrstvwxyz" as const;
export const MARKETPLACE_NAME_ALPHABET = `${MARKETPLACE_NAME_DIGITS}${MARKETPLACE_NAME_LETTERS}` as const;

/** The shortest length ever issued. */
export const MARKETPLACE_NAME_MIN_LENGTH = 4;
/** The longest length the column holds. Far beyond any stage the occupancy rule reaches. */
export const MARKETPLACE_NAME_MAX_LENGTH = 16;
/** Move to the next length once issued names fill this share of the current one. */
export const MARKETPLACE_NAME_STAGE_OCCUPANCY = 0.25;

const CHARS = `[${MARKETPLACE_NAME_DIGITS}${MARKETPLACE_NAME_LETTERS}]`;
export const MARKETPLACE_NAME_RE = new RegExp(
  `^(?=${CHARS}*[${MARKETPLACE_NAME_DIGITS}])(?=${CHARS}*[${MARKETPLACE_NAME_LETTERS}])${CHARS}{${MARKETPLACE_NAME_MIN_LENGTH},${MARKETPLACE_NAME_MAX_LENGTH}}$`,
);

export const MarketplaceName = z.string().regex(MARKETPLACE_NAME_RE, "mName is outside the issued shape");
export type MarketplaceName = z.infer<typeof MarketplaceName>;

export function isMarketplaceName(value: string): boolean {
  return MARKETPLACE_NAME_RE.test(value);
}

/**
 * Distinct mNames of exactly `length` characters: every string over the
 * alphabet, less the all-letter and the all-digit ones.
 */
export function marketplaceNameCapacity(length: number): number {
  return (
    MARKETPLACE_NAME_ALPHABET.length ** length -
    MARKETPLACE_NAME_LETTERS.length ** length -
    MARKETPLACE_NAME_DIGITS.length ** length
  );
}

/**
 * The length a new mName is drawn at, given how many have been issued.
 *
 * `issued` counts every issued mName, at every length, against the CURRENT
 * length's capacity — a conservative bound, since names already issued at
 * longer lengths cannot collide with a shorter draw. It never moves backwards,
 * because an issued mName is never cleared.
 */
export function marketplaceNameStageLength(issued: number): number {
  let length = MARKETPLACE_NAME_MIN_LENGTH;
  while (
    length < MARKETPLACE_NAME_MAX_LENGTH &&
    issued >= marketplaceNameCapacity(length) * MARKETPLACE_NAME_STAGE_OCCUPANCY
  ) {
    length += 1;
  }
  return length;
}

/**
 * A caller-supplied mName (a search box, `?seller=`) as the stored form, or
 * `null` when it cannot be one. Trimmed and lowercased; nothing else is
 * rewritten — an mName is never guessed from a near miss.
 */
export function parseMarketplaceNameLookup(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return isMarketplaceName(candidate) ? candidate : null;
}
