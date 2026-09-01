/**
 * The marketplace application boundary — SERVER ONLY (Phase 1.18).
 *
 * **The governed way to reach an Offer, Listing, or Storefront mutation.** Each
 * command takes an `ActingAccount` — a value only `resolveActingAccount` can
 * mint, from a session cookie — and the business input a caller legitimately
 * supplies. It then calls the domain service with the acting account id filled
 * in from the resolved identity rather than from the payload.
 *
 * Two properties are worth stating, because they are what make this a boundary
 * rather than a forwarding layer:
 *
 *   1. **`actingAccountId` is written here, and overwrites whatever arrived.**
 *      The input types below have no member for it, and the spread order puts
 *      the resolved value last. A body that carries one is refused before that
 *      even matters — every domain input is a `z.strictObject`, so an unknown
 *      key fails the parse. Both controls point the same way on purpose: one is
 *      the type, the other is the runtime.
 *
 *   2. **No authorization decision is made here.** This layer establishes *who
 *      is acting*; the domain service decides *what they may do*, from the
 *      database, inside the transaction that writes. Deciding out here would
 *      reintroduce a forgeable conclusion one layer up, and would open a window
 *      between the decision and the write in which a restriction, a suspension,
 *      or a revoked governance assignment could land unseen.
 *
 * **This is not the HTTP surface, and it is not pretending to be.** No route
 * exists for these mutations, and Phase 1.18 deliberately builds none —
 * participant-facing Offer, Listing, and Storefront surfaces are their own
 * phase. What this is: the seam a future route wires to, so that wiring one
 * cannot reintroduce the forgery this phase removed. A route's remaining job is
 * to call `resolveActingAccount`, refuse `UNAUTHENTICATED` with a bounded 401,
 * and map the domain errors.
 *
 * The five commands wired here are the highest-authority mutations in the
 * module: authoring a Product source record, taking a Storefront live, mutating
 * an Offer's commercial source version, and creating a Listing on either branch.
 *
 * The remaining mutations keep their existing service entry points, and are
 * equally safe by construction now that no authority input can be forged on any
 * of them — this layer adds the actor guarantee, not the authority one.
 * `assignStorefrontGovernance` and `setGovernanceAssignmentStatus` are the ones
 * worth naming: appointing and revoking governance is the authority that can
 * restore every other, so they are the first commands a future route phase
 * should wire here rather than call directly.
 */

import "../server-only";
import type { ActingAccount } from "../account/acting-participant-boundary";
import { createOfferSourceVersion } from "./offer-service";
import type { OfferServiceDeps, OfferSnapshot } from "./offer-service";
import { createSellerDirectListing, createPromotedListing } from "./listing-service";
import type { ListingServiceDeps, ListingSnapshot } from "./listing-service";
import { createStorefrontSourceVersion } from "./storefront-service";
import type { StorefrontServiceDeps, StorefrontSnapshot } from "./storefront-service";
import { ProductRepository } from "../product/product-repository";
import type { ProductSourceRecord } from "../../contracts/product/product-source-record";
import { getPrisma } from "../db/client";
import { resolveActingSubject } from "./acting-subject-service";
import { assertParticipantMayAuthorMarketplaceState } from "./participant-standing-service";
import { assertParticipantLifecycleIsLive } from "./participant-closure-service";
import { ProductCreatorParticipantRequiredError } from "../product/errors";

/**
 * What a caller may state.
 *
 * `unknown` rather than a restated schema: the domain service owns the shape and
 * parses it, and a second copy here would be a second answer able to disagree
 * about what a valid Offer update is. The one thing this layer asserts is what
 * the caller may *not* state, and it asserts it by supplying the actor itself.
 */
export type ApplicationCommandInput = Record<string, unknown>;

/**
 * Strip any `actingAccountId` a caller sent, then supply the resolved one.
 *
 * The delete is not redundant with the spread order, and not redundant with
 * `strictObject` either. It is the third control, and the only one that holds
 * if a later input schema is relaxed to `object` — at which point a forwarded
 * body would otherwise carry a stranger's account id into a service that trusts
 * it. Cheap, and the failure it prevents is total.
 */
function withActor(
  input: ApplicationCommandInput,
  actor: ActingAccount,
): Record<string, unknown> {
  const { actingAccountId: _discarded, ...rest } = input;
  return { ...rest, actingAccountId: actor.accountId };
}

/**
 * Mutate an Offer's commercial source version — including taking it live.
 *
 * The most authority-sensitive Offer act: activation requires the full commerce
 * gates, the seller's own Product authority, and a creator economics
 * confirmation bound to this exact version.
 */
export async function submitOfferSourceVersion(
  actor: ActingAccount,
  input: ApplicationCommandInput,
  deps: OfferServiceDeps = {},
): Promise<OfferSnapshot> {
  return await createOfferSourceVersion(withActor(input, actor), deps);
}

/**
 * Mutate a Storefront's source version — including activation and go-live.
 *
 * The strictest authority path in the marketplace: an active SUPER_OWNER, an
 * admitted and payable owner, and Monacado's own go-live approval.
 */
export async function submitStorefrontSourceVersion(
  actor: ActingAccount,
  input: ApplicationCommandInput,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontSnapshot> {
  return await createStorefrontSourceVersion(withActor(input, actor), deps);
}

/**
 * Create a seller-direct Listing.
 *
 * Placing a Product in front of buyers under the seller's own authority — which
 * since Phase 1.18 requires creator authority over that Product, not merely that
 * the Product row exists.
 */
export async function openSellerDirectListing(
  actor: ActingAccount,
  input: ApplicationCommandInput,
  deps: ListingServiceDeps = {},
): Promise<ListingSnapshot> {
  return await createSellerDirectListing(withActor(input, actor), deps);
}

/**
 * Create a promoted Listing bound to an exact accepted Offer version.
 *
 * Kept beside its sibling deliberately: a promoter and a seller reach the
 * marketplace through different commands because they hold different authority,
 * and one command branching on a caller-supplied listing type is how a promoter
 * would eventually be handed a seller's path.
 */
export async function openPromotedListing(
  actor: ActingAccount,
  input: ApplicationCommandInput,
  deps: ListingServiceDeps = {},
): Promise<ListingSnapshot> {
  return await createPromotedListing(withActor(input, actor), deps);
}

/**
 * Create a Product source record under the acting participant's creator authority.
 *
 * **This is where Product authority originates (Phase 1.18).** Offer and
 * seller-direct Listing authority are derived from
 * `ProductSourceRecordVersionRow.authorityCreatorParticipantId`, and until now
 * nothing wrote it: the repository persisted only the opaque `mon:creator:`
 * reference, so a Product created by Monacado's own writer could back no
 * commerce at all. The fix belongs here rather than in a later reconstruction,
 * because this is the only moment at which an authenticated participant is
 * known to be the author.
 *
 * The participant is **resolved, never accepted**: it comes from the acting
 * account's own `MarketplaceParticipant` row, so a caller can neither claim
 * creator authority for someone else nor claim it for themselves over facts
 * they did not author. Any `creatorParticipantId` already on the record is
 * discarded for exactly that reason.
 *
 * An account holding no participant is refused. It is not an authorization
 * failure dressed up as one — the account is simply not a marketplace
 * participant, and authoring Product facts as one is not something it can do.
 *
 * The `ProductRepository` itself stays usable without a participant, and
 * deliberately: the Product domain predates the marketplace one, and the
 * publication and registrar paths author Products with no participant anywhere
 * in scope. Such a Product is not broken — it simply proves no creator
 * participant, and therefore backs no Offer and no seller-direct Listing.
 * Coupling every Product write to a marketplace identity would be a stronger
 * claim than the model makes.
 */
export async function createProductSourceRecordAs(
  actor: ActingAccount,
  record: ProductSourceRecord,
  deps: { db?: ReturnType<typeof getPrisma> } = {},
): Promise<ProductSourceRecord> {
  const db = deps.db ?? getPrisma();

  const subject = await resolveActingSubject(db, actor.accountId);
  const participantId = subject.participant?.participantId;
  if (participantId === undefined) throw new ProductCreatorParticipantRequiredError();

  /* Authority and standing stay separate questions, asked in that order — the
     same composition every other governed write in this phase uses. Resolving
     the participant answers "may this actor act as itself"; these answer "may
     that otherwise-authorized act occur now".
     
     Suspension withholds authoring, and a closed participation authors nothing
     further. A RESTRICTED participant still authors, deliberately: restrictions
     never gate drafting, because a participant must be able to correct the work
     that caused the restriction.
     
     Checked before the repository opens its own transaction, so a suspension
     landing in between could let one record through. Bounded on purpose rather
     than by oversight: the Product it stamps still backs no Offer and no
     seller-direct Listing, because both re-ask standing at their own write. */
  await assertParticipantLifecycleIsLive(db, participantId);
  await assertParticipantMayAuthorMarketplaceState(db, participantId);

  const attributed: ProductSourceRecord = {
    ...record,
    authority: { ...record.authority, creatorParticipantId: participantId },
  };

  return await new ProductRepository(db).createInitialProductSourceRecord({ record: attributed });
}
