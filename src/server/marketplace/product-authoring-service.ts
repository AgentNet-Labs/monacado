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
 *
 * There is deliberately **no Product-count allowance** (Phase 1.33): the
 * Product library consumes no capacity. Capacity is counted in active Listings
 * per Storefront, at Listing activation — see
 * docs/MARKETPLACE_ASSORTMENT_AND_LISTING_RULES.md.
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
} from "../product/errors";

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
}
