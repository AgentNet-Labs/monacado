/**
 * The marketplace application boundary — SERVER ONLY (Phase 1.18, extended 1.19).
 *
 * **The governed way to reach an Offer, Listing, Storefront, or refund
 * mutation.** Each
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
 * Phase 1.18 wired five commands — authoring a Product source record, taking a
 * Storefront live, mutating an Offer's commercial source version, and creating
 * a Listing on either branch — and named the ones it left out:
 *
 * > "`assignStorefrontGovernance` and `setGovernanceAssignmentStatus` are the
 * > ones worth naming: appointing and revoking governance is the authority that
 * > can restore every other, so they are the first commands a future route
 * > phase should wire here rather than call directly."
 *
 * **Phase 1.19 wires them, and closes the debt beside them.** Five more
 * commands: the two governance mutations, `openDraftStorefront` (whose
 * self-ownership is the only basis on which a first `SUPER_OWNER` can later be
 * appointed), and the two refund-request paths.
 *
 * The refund commands differ from the others in one way worth stating. The
 * Offer, Listing, and Storefront commands supply `actingAccountId` through
 * `withActor`; the refund commands construct a whole `verification` from the
 * actor instead, because the refund service distinguishes three requesters and
 * a caller must not be able to choose which one it is. There is deliberately
 * **no guest command** — a guest holds no account, and fabricating one would
 * create exactly the account 0M.9 promised not to.
 *
 * The remaining mutations keep their existing service entry points, and are
 * equally safe by construction now that no authority input can be forged on any
 * of them — this layer adds the actor guarantee, not the authority one.
 */

import "../server-only";
import type { ActingAccount } from "../account/acting-participant-boundary";
import { createOfferSourceVersion } from "./offer-service";
import type { OfferServiceDeps, OfferSnapshot } from "./offer-service";
import { createSellerDirectListing, createPromotedListing } from "./listing-service";
import type { ListingServiceDeps, ListingSnapshot } from "./listing-service";
import {
  assignStorefrontGovernance,
  createDraftStorefront,
  createStorefrontSourceVersion,
  setGovernanceAssignmentStatus,
} from "./storefront-service";
import type { StorefrontServiceDeps, StorefrontSnapshot } from "./storefront-service";
import type { StorefrontGovernanceAssignmentRecord } from "../../contracts/marketplace/storefront-record";
import { initiateRefundRequest } from "./refund-initiation-service";
import type { InitiateRefundRequestInput } from "./refund-initiation-service";
import type { RefundServiceDeps } from "./order-refund-service";
import type { OrderRefundRecord } from "../../contracts/marketplace/order-refund";
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
 * Create a draft Storefront owned by the acting participant.
 *
 * Wired here because of what it bootstraps rather than what it writes. A
 * Storefront begins with no governance assignments at all, and the owner's
 * self-ownership is the only basis on which the first `SUPER_OWNER` can be
 * appointed — so an actor forged at this step pre-authorizes every governance
 * appointment that follows it. The draft itself is `DRAFT` and `PRIVATE` by
 * construction; the authority it confers is the part worth protecting.
 */
export async function openDraftStorefront(
  actor: ActingAccount,
  input: ApplicationCommandInput,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontSnapshot> {
  return await createDraftStorefront(withActor(input, actor), deps);
}

/**
 * Appoint a participant to a Storefront governance role, or change one.
 *
 * **The authority that can restore every other**, which is why Phase 1.18's own
 * note named it first among the commands a later phase should wire here rather
 * than call directly. Phase 1.19 is that phase.
 *
 * The appointee (`participantId`) and the role remain the caller's to state —
 * they are the act, not a claim about the caller. What the caller can no longer
 * state is who is doing the appointing.
 */
export async function appointStorefrontGovernance(
  actor: ActingAccount,
  input: ApplicationCommandInput,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontGovernanceAssignmentRecord> {
  return await assignStorefrontGovernance(withActor(input, actor), deps);
}

/**
 * Suspend, revoke, or restore a Storefront governance assignment.
 *
 * The other half of the pair, and the half that removes authority rather than
 * granting it. Revocation is a state change rather than a delete, so this is
 * also the command that writes the record of who used to hold power — which is
 * exactly why the actor behind it must be resolved rather than claimed.
 */
export async function setStorefrontGovernanceStatus(
  actor: ActingAccount,
  input: ApplicationCommandInput,
  deps: StorefrontServiceDeps = {},
): Promise<StorefrontGovernanceAssignmentRecord> {
  return await setGovernanceAssignmentStatus(withActor(input, actor), deps);
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

// — Refund initiation (Phase 1.19) —

/**
 * What a refund requester may state.
 *
 * `verification` is removed rather than restated, and that omission is the
 * control: the two commands below construct it from the resolved actor, so
 * there is no member through which a caller could name the account they are
 * acting as, claim `OPERATOR`, or present a claim code belonging to somebody
 * else's Order alongside an account id.
 *
 * `Omit` rather than a fresh type, so a field added to the service input
 * reaches these commands automatically and a field *renamed* breaks the build
 * here rather than silently going unsupplied.
 */
export type RefundRequestCommandInput = Omit<InitiateRefundRequestInput, "verification">;

/**
 * An authenticated buyer asks for their own money back.
 *
 * The account is the session's, full stop. `initiateRefundRequest` still checks
 * it against the Order's own `buyerAccountId`/`claimedByAccountId` — that check
 * establishes *whose Order this is* and is not weakened here. What this command
 * establishes is the other half: that the account being checked is the account
 * that actually asked.
 *
 * Both halves are needed and neither substitutes for the other. Ownership
 * without identity meant anyone who knew an account id and an Order id could
 * request somebody's refund; identity without ownership would let any signed-in
 * account request anybody's.
 */
export async function requestOrderRefundAsBuyer(
  actor: ActingAccount,
  input: RefundRequestCommandInput,
  deps: RefundServiceDeps = {},
): Promise<OrderRefundRecord> {
  return await initiateRefundRequest(
    { ...input, verification: { kind: "BUYER_ACCOUNT", accountId: actor.accountId } },
    deps,
  );
}

/**
 * An entitled operator starts a refund on a buyer's behalf.
 *
 * A separate command from its buyer sibling rather than one branching on a
 * caller-supplied kind — the same reason a promoter and a seller reach the
 * marketplace through different Listing commands. One command choosing its
 * verification from the payload is how an ordinary buyer eventually receives
 * the operator path.
 *
 * **This command does not decide anything.** The `refund:initiate` entitlement
 * is resolved and asserted inside `initiateRefundRequest`, against persisted
 * state, before any Order is read. Deciding out here would be a forgeable
 * conclusion one layer up and would open a window in which a revoked grant
 * could go unseen — the property this whole layer exists to preserve.
 *
 * **And it does not move money.** A refund request commits a `PENDING`
 * obligation; the refund processor executes it later, under its own gate. An
 * authenticated request is not a provider call.
 */
export async function requestOrderRefundAsOperator(
  actor: ActingAccount,
  input: RefundRequestCommandInput,
  deps: RefundServiceDeps = {},
): Promise<OrderRefundRecord> {
  return await initiateRefundRequest(
    { ...input, verification: { kind: "OPERATOR", actingAccountId: actor.accountId } },
    deps,
  );
}

/* A guest refund request is deliberately absent from this module.
   
   A guest holds no account, so there is nothing for this boundary to supply.
   `initiateRefundRequest` with `kind: "GUEST_CLAIM_CODE"` remains the path, and
   it is already the right shape: the claim code is a real credential, verified
   against a stored digest, and every failure answers identically so that
   nothing here becomes an oracle for which Orders exist.
   
   Minting an `ActingAccount` for a guest would fabricate exactly the account
   0M.9 promised not to create, and would do it at the moment a buyer is asking
   for their money back. */
