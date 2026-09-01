/**
 * Product authority resolution — the single reader (Phase 1.18).
 *
 * **The question this answers is "does this participant hold creator authority
 * over this Product", and it is answered from the database.** Before this phase
 * it was answered by the caller: `CreateDraftOfferInput` and `UpdateOfferInput`
 * each carried `hasProductAuthority: z.boolean()`, and `canCreateDraftOffer`
 * believed it. Anyone able to reach the service could draft, reprice, and
 * activate an Offer over another creator's Product by writing `true`. The
 * Listing path did not even ask — it checked that the Product row *existed*.
 *
 * The authority is read where it is actually recorded: on the Product's
 * **current immutable source version**, which is the version whose facts the
 * Offer or Listing is placing. `ProductSourceRecordVersionRow` carries both
 * halves of the 0E.1 authority — the opaque `mon:creator:<opaque>` reference
 * that has always been there, and the `authorityCreatorParticipantId` foreign
 * key Phase 0M.5 added beside it.
 *
 * **It fails closed on a NULL, and that is the whole design.** The participant
 * column is nullable for a stated migration-safety reason: rows written before
 * participants existed name a `mon:creator:` reference that matches no
 * participant, and backfilling one would fabricate an authority nobody held.
 * A version that cannot say which participant holds its creator authority
 * therefore grants that authority to **nobody**, rather than to whoever asks.
 * That is a refusal, not an outage, and it is the honest reading of a record
 * that genuinely does not know.
 *
 * **Only `"authorized"` grants.** The 0E.1 vocabulary is
 * `"authorized" | "pending" | "revoked"`; the latter two are the states in
 * which a creator reference exists and confers nothing, so treating a non-NULL
 * participant as sufficient would let a revoked authority keep selling.
 *
 * **Storefront ownership is not Product authority**, and nothing here consults
 * a Storefront. Owning the shop a Product is placed in says nothing about who
 * may set that Product's facts, and merging the two would let a shop owner
 * reprice a creator's work.
 *
 * **Reads only, and decides nothing.** This module produces one fact. The pure
 * 0M.2A decisions in `offer-source.ts` weigh it exactly as they always did —
 * only its provenance moved.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

/**
 * The authorization state in which a creator reference actually confers
 * authority. The other two members of the 0E.1 vocabulary — `"pending"` and
 * `"revoked"` — are states in which the reference exists and grants nothing.
 */
const GRANTING_AUTHORIZATION_STATE = "authorized";

/**
 * The scope under which Product facts are authored. A single-member vocabulary
 * today; checked rather than assumed, so a later scope cannot silently inherit
 * the authority this one carries.
 */
const PRODUCT_FACTS_SCOPE = "product-facts";

/**
 * Does `participantId` hold creator authority over this Product?
 *
 * `participantId` is `null` for a guest or an authenticated non-participant,
 * and the answer is `false` — asked separately rather than folded into the
 * caller's own null check, so that "no participant" and "wrong participant"
 * cannot take different code paths.
 *
 * A missing Product, or a Product whose current source version is missing,
 * yields `false`. Neither is reported as a distinct condition: the caller has
 * already established that the Product exists before asking, and an authority
 * reader that answered "no such Product" would be a second, weaker existence
 * oracle beside the one the caller already owns.
 */
export async function participantHoldsProductAuthority(
  tx: Tx,
  internalProductId: string,
  participantId: string | null | undefined,
): Promise<boolean> {
  if (participantId === null || participantId === undefined) return false;

  const product = await tx.product.findUnique({
    where: { internalProductId },
    select: { sourceRecordId: true, currentSourceRecordVersion: true },
  });
  if (product === null) return false;

  /* The CURRENT version, not any version. Authority is a present fact: a
     participant who authored version 1 and has since been superseded does not
     retain authority over what the Product says now. Reading the whole history
     and accepting a match anywhere would make revocation unexpressible. */
  const version = await tx.productSourceRecordVersionRow.findUnique({
    where: {
      sourceRecordId_sourceRecordVersion: {
        sourceRecordId: product.sourceRecordId,
        sourceRecordVersion: product.currentSourceRecordVersion,
      },
    },
    select: {
      authorityCreatorParticipantId: true,
      authorityAuthorizationState: true,
      authorityScope: true,
    },
  });
  if (version === null) return false;

  // Fails closed on a historical NULL: see the module note.
  if (version.authorityCreatorParticipantId === null) return false;

  return (
    version.authorityCreatorParticipantId === participantId &&
    version.authorityAuthorizationState === GRANTING_AUTHORIZATION_STATE &&
    version.authorityScope === PRODUCT_FACTS_SCOPE
  );
}
