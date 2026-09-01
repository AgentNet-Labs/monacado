/**
 * Product creator-authority fixture (Phase 1.18).
 *
 * Offer and seller-direct Listing authority is derived from the Product's
 * **current immutable source version** — specifically
 * `ProductSourceRecordVersionRow.authorityCreatorParticipantId`, in the
 * `"authorized"` state and the `"product-facts"` scope. Before Phase 1.18 a
 * test granted that authority by writing `hasProductAuthority: true` into the
 * service input, which is exactly the forgery the phase removed.
 *
 * This exists so that granting it is one call, and so that a fixture grants it
 * the only way production can: by establishing the authoritative row. A test
 * that wants "this participant does NOT hold authority" simply does not call
 * this, or names a different participant — there is no flag to set.
 */

import type { getPrisma } from "../../src/server/db/client";

type Db = ReturnType<typeof getPrisma>;

/**
 * Record `participantId` as the creator authority on this Product's current
 * source version, creating that version row if the fixture never made one.
 *
 * Several suites seed a bare `Product` row with a `currentSourceRecordVersion`
 * pointer and no version behind it, which was sufficient while nothing read the
 * version. Authority is read from it now, so the row has to exist — and a
 * Product whose current version is missing correctly grants authority to
 * nobody.
 */
export async function grantProductCreatorAuthority(
  db: Db,
  input: {
    internalProductId: string;
    participantId: string;
    /** Defaults to the states in which authority actually grants. */
    authorizationState?: string;
    authorityScope?: string;
    now?: string;
  },
): Promise<void> {
  const at = new Date(input.now ?? "2027-10-01T09:00:00.000Z");

  const product = await db.product.findUnique({
    where: { internalProductId: input.internalProductId },
  });
  if (product === null) {
    throw new Error(`no Product ${input.internalProductId}`);
  }

  const existing = await db.productSourceRecordVersionRow.findUnique({
    where: {
      sourceRecordId_sourceRecordVersion: {
        sourceRecordId: product.sourceRecordId,
        sourceRecordVersion: product.currentSourceRecordVersion,
      },
    },
  });

  const authority = {
    authorityCreatorParticipantId: input.participantId,
    authorityScope: input.authorityScope ?? "product-facts",
    authorityAuthorizationState: input.authorizationState ?? "authorized",
  };

  if (existing !== null) {
    await db.productSourceRecordVersionRow.update({
      where: { seq: existing.seq },
      data: authority,
    });
    return;
  }

  await db.productSourceRecordVersionRow.create({
    data: {
      internalProductId: input.internalProductId,
      sourceRecordId: product.sourceRecordId,
      sourceRecordVersion: product.currentSourceRecordVersion,
      sourceSystem: "monacado",
      sourceRecordType: "Product",
      sourceClass: "governed-database-record",
      authorityCreatorId: `mon:creator:${input.participantId.slice(-26).padStart(26, "0")}`,
      ...authority,
      factName: "Synthetic Product",
      factProductVersion: 1,
      factPromotable: true,
      factGeneralAvailabilityState: "available",
      factDeliveryMode: "DIGITAL",
      taxClassification: "DIGITAL_GOOD",
      factCreatorRef: `an:node:${input.participantId.slice(-26).padStart(26, "0")}`,
      capsuleSemver: "1.0.0",
      mappingVersion: "product-mapping/1.0.0",
      capsuleGeneratedAt: at,
      acquiredAt: at,
      sourceCreatedAt: at,
      sourceUpdatedAt: at,
      recordStatus: "DRAFT",
    },
  });
}
