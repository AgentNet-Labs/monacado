/**
 * Who may author a Product — the governed decision, asked inside the write
 * (Phase 1.32) — SERVER ONLY.
 *
 * `createProductSourceRecordAs` resolves the acting participant to stamp it as
 * creator authority; this is where that participant's right to author is
 * DECIDED, and it runs inside the repository's write transaction through
 * `CreateInitialInput.authorize`. Three questions, in the order every governed
 * write here asks them:
 *
 *   1. **Is the actor still the participant being credited?** Re-resolved from
 *      the account in this transaction; a mismatch is a refusal, never a
 *      silent re-attribution.
 *   2. **Authority** — `canCreateDraftProduct` (0M.1): a SELLER role in a
 *      drafting status, on a participant permitted to draft, on an enabled
 *      account. A promoter curates other creators' Products and never asserts
 *      their facts (ADR §2), so a promoter-only participant is refused.
 *   3. **Standing** — a closed participation authors nothing further, and a
 *      suspension withholds authoring. A RESTRICTED participant still drafts,
 *      deliberately: restrictions never gate drafting.
 *   4. **Allowance** — owned < allowed, where owned is every Product whose
 *      current source version credits this participant, and allowed is
 *      `INCLUDED_PRODUCT_ALLOWANCE` plus any paid Product entitlement (none
 *      exists yet). Otherwise `ProductUpgradeRequiredError`.
 *
 * Asked here rather than in `marketplace-application-service`, which resolves
 * identity and decides nothing, so that the decision and the write see the same
 * rows.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { canCreateDraftProduct, isAllowed } from "../../contracts/marketplace/capability";
import { resolveActingSubject } from "./acting-subject-service";
import { assertParticipantMayAuthorMarketplaceState } from "./participant-standing-service";
import { assertParticipantLifecycleIsLive } from "./participant-closure-service";
import {
  ProductCreatorNotEligibleError,
  ProductCreatorParticipantRequiredError,
  ProductUpgradeRequiredError,
} from "../product/errors";
import { INCLUDED_PRODUCT_ALLOWANCE } from "../../contracts/product/product-source-record";

export async function assertAccountMayAuthorProductIn(
  tx: Prisma.TransactionClient,
  actingAccountId: string,
  creditedParticipantId: string,
): Promise<void> {
  const subject = await resolveActingSubject(tx, actingAccountId);
  const participantId = subject.participant?.participantId;
  if (participantId === undefined) throw new ProductCreatorParticipantRequiredError();
  if (participantId !== creditedParticipantId) throw new ProductCreatorNotEligibleError();

  if (!isAllowed(canCreateDraftProduct(subject))) throw new ProductCreatorNotEligibleError();

  await assertParticipantLifecycleIsLive(tx, participantId);
  await assertParticipantMayAuthorMarketplaceState(tx, participantId);

  await assertProductAllowanceIn(tx, participantId);
}

/**
 * The Product allowance: owned < allowed, safe under concurrency.
 *
 * The same construction as the Storefront allowance (Phase 1.30): the
 * participant row is locked for the rest of the write transaction, so a second
 * request for the same Seller waits here until the first commits or rolls back;
 * and the count is a LOCKING read, which sees the latest committed rows rather
 * than this transaction's earlier snapshot, so the waiter counts the Product the
 * first one wrote. Two requests for the last free slot cannot both pass.
 *
 * Owned is counted from each Product's CURRENT version, the same present-fact
 * reading `participantHoldsProductAuthority` and the account page use. No schema
 * constraint: a larger allowance needs no migration.
 */
async function assertProductAllowanceIn(
  tx: Prisma.TransactionClient,
  participantId: string,
): Promise<void> {
  const allowed = INCLUDED_PRODUCT_ALLOWANCE;
  await tx.$queryRaw`SELECT id FROM MarketplaceParticipant WHERE id = ${participantId} FOR UPDATE`;
  const [{ owned }] = await tx.$queryRaw<Array<{ owned: bigint }>>`
    SELECT COUNT(*) AS owned
    FROM Product p
    JOIN ProductSourceRecordVersionRow v
      ON v.sourceRecordId = p.sourceRecordId
     AND v.sourceRecordVersion = p.currentSourceRecordVersion
    WHERE v.authorityCreatorParticipantId = ${participantId}
    FOR SHARE`;
  if (Number(owned) >= allowed) throw new ProductUpgradeRequiredError();
}
