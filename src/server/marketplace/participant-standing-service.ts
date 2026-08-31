/**
 * Participant standing — the single enforcement reader (Phase 1.15).
 *
 * **One place answers "may this participant do this."** Before this phase there
 * were two readers, in two modules, disagreeing about what they were for: a
 * scope-exact count inside the proceeds ledger, and a flat two-scope list inside
 * the checkout risk gate. Neither read `ParticipantSuspension` at all, so a
 * suspended seller was invisible to both — the heavier act had less effect than
 * the lighter one.
 *
 * Everything here reads **governed decisions only**:
 * `ParticipantSuspension` and `ParticipantRestriction`. Never a risk score,
 * never a rate, never a review disposition, never a threshold. Phase 1.13's
 * analytics and Phase 1.14's reviews produce evidence for a human; only what
 * that human then decided, recorded as one of these two rows, can deny anything
 * here. There is no code path from a number to a refusal.
 *
 * **Reads only.** No function in this module writes, and none imposes,
 * lifts, suspends, or reinstates. Enforcement consumes governed state; it never
 * creates it.
 *
 * **Participant status is deliberately not consulted.** Status is derived — any
 * active restriction reconciles it to `RESTRICTED` — so a seam asking "is this
 * participant restricted for THIS capability" and reading status back would get
 * the coarsest fact available and apply it to the narrowest question. The
 * authoritative records are the rows, and these functions read the rows.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "../db/client";
import {
  RestrictionScope,
  type RestrictionScope as Scope,
} from "../../contracts/marketplace/participant-restriction";
import {
  commerceBlockingScopesForRole,
  evaluateParticipantAction,
  type ParticipantStanding,
} from "../../contracts/marketplace/restriction-enforcement";
import type { MarketplaceRole } from "../../contracts/marketplace/participant";
import {
  ParticipantActionNotPermittedError,
  ParticipantStandingPersistenceFailureError,
} from "./participant-standing-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

/**
 * One participant's governed standing.
 *
 * Two queries rather than a join: the suspension marker and the restriction rows
 * are separate authorities, and reading them separately keeps a corrupt or
 * unexpected value in one from silently changing the meaning of the other.
 *
 * An unrecognised stored scope is **dropped rather than thrown on**. A row
 * naming a scope this build does not know is a historical record from a
 * vocabulary that has since moved; it must not be able to take checkout down for
 * every participant. It cannot cause a *denial* either, because a scope no seam
 * requires can never match a required scope — so dropping it is conservative in
 * the only direction that matters.
 */
export async function readParticipantStanding(
  tx: Tx,
  participantId: string,
): Promise<ParticipantStanding> {
  try {
    const [suspensions, restrictions] = await Promise.all([
      tx.participantSuspension.count({ where: { participantId, status: "ACTIVE" } }),
      tx.participantRestriction.findMany({
        where: { participantId, status: "ACTIVE" },
        select: { scope: true },
      }),
    ]);

    const activeScopes: Scope[] = [];
    for (const row of restrictions) {
      const parsed = RestrictionScope.safeParse(row.scope);
      if (parsed.success && !activeScopes.includes(parsed.data)) activeScopes.push(parsed.data);
    }

    return { suspended: suspensions > 0, activeScopes };
  } catch (error) {
    throw new ParticipantStandingPersistenceFailureError("readParticipantStanding", error);
  }
}

/**
 * Refuse unless this participant may perform an action requiring these scopes.
 *
 * The generic seam every specific one below is built from. Suspension dominates;
 * see `evaluateParticipantAction`.
 */
export async function assertParticipantMayPerform(
  tx: Tx,
  participantId: string,
  requiredScopes: readonly Scope[],
): Promise<void> {
  const standing = await readParticipantStanding(tx, participantId);
  const decision = evaluateParticipantAction({ standing, requiredScopes });
  if (decision.allowed) return;
  throw new ParticipantActionNotPermittedError(
    decision.denialCode!,
    decision.denialCode === "ACTION_RESTRICTED"
      ? (requiredScopes.find((s) => standing.activeScopes.includes(s)) ?? null)
      : null,
  );
}

/**
 * May this Storefront become operationally reachable?
 *
 * The seam named by `storefront:activate`. Gates **going live and widening
 * exposure only** — never standing a Storefront down. An owner who cannot be
 * paid must still be able to close or hide their shop, and requiring an intact
 * commerce gate to stop trading would trap exactly the participant who most
 * needs to stop.
 *
 * Gates the operational effect, not the authorship: the source version is still
 * minted, and a restricted owner may still edit presentation and correct the
 * work that caused the restriction. Only the field value that makes the shop
 * reachable is refused.
 */
export async function assertStorefrontMayBecomeOperational(
  tx: Tx,
  ownerParticipantId: string,
): Promise<void> {
  await assertParticipantMayPerform(tx, ownerParticipantId, ["storefront:activate"]);
}

/**
 * May this Offer become — or stay — commercially live?
 *
 * The seam named by `offer:publish`. Gates activation and resumption; never
 * suspend, end, or withdraw, for the reason `canSuspendOffer` already gives in
 * the Offer source model: a seller whose commerce was just withheld must still
 * be able to take their Offer down.
 */
export async function assertOfferMayBecomeCommerciallyLive(
  tx: Tx,
  sellerParticipantId: string,
): Promise<void> {
  await assertParticipantMayPerform(tx, sellerParticipantId, ["offer:publish"]);
}

/**
 * May this Listing become operationally available to buyers?
 *
 * **Status is the control here, not a scope** — deliberately, and this is the
 * ruling Phase 1.15 makes rather than inherits. Taking a Listing live is the
 * broad act of participating in the marketplace, which is what admission governs;
 * inventing a `listing:activate` scope would have been a fourth name for a
 * question `RESTRICTED` and `SUSPENDED` already answer, and a name is not a
 * control.
 *
 * The gap it closes is real: `DRAFT → ACTIVE` on a Listing was authorized by the
 * DRAFTING capability, and `RESTRICTED` is a member of
 * `DRAFTING_PARTICIPANT_STATUSES` on purpose — so a restricted participant could
 * put new items in front of buyers while every other commerce gate refused them.
 * A drafting gate is the right authority for drafting and the wrong one for
 * going live.
 *
 * Expressed as "no active restriction of any kind, and no suspension" rather
 * than by reading the derived status, so the seam consults the same
 * authoritative rows as every other seam here.
 */
export async function assertListingMayBecomeOperational(
  tx: Tx,
  controllingParticipantId: string,
): Promise<void> {
  const standing = await readParticipantStanding(tx, controllingParticipantId);
  if (standing.suspended) {
    throw new ParticipantActionNotPermittedError("PARTICIPANT_SUSPENDED");
  }
  if (standing.activeScopes.length > 0) {
    throw new ParticipantActionNotPermittedError("ACTION_RESTRICTED", standing.activeScopes[0]!);
  }
}

/**
 * May this participant author NEW marketplace state?
 *
 * The drafting seam, and it refuses on **suspension only** (Phase 1.16).
 *
 * WHY A ROW READ IS REQUIRED HERE. Drafting eligibility is decided by
 * `permitsDrafting`, which excludes `SUSPENDED` — so for an admitted participant
 * the derived status already carries the answer. It does not for a participant
 * suspended before admission: a suspension withdraws admission, there is none to
 * withdraw, and Phase 1.16 deliberately refuses to manufacture an admitted
 * `SUSPENDED` status for them. Their honest stored status stays at their
 * onboarding stage, `permitsDrafting` keeps returning true, and without this the
 * suspension reached nothing. The authoritative row has to be read because the
 * projection cannot express this case — which is the whole reason enforcement
 * reads rows.
 *
 * RESTRICTIONS ARE DELIBERATELY NOT CONSULTED, and this is the asymmetry the
 * architecture turns on. `RESTRICTED` is a member of
 * `DRAFTING_PARTICIPANT_STATUSES` on purpose: a restriction withholds *commerce*,
 * never the ability to correct the work that caused it, and `activation:submit`
 * is excluded from the restrictable vocabulary for the same reason. A restricted
 * participant must keep drafting, or the restriction becomes unanswerable.
 * Suspension is the heavier act and withdraws participation itself.
 *
 * SCOPED TO AUTHORING, not to standing down. It gates the acts that bring new
 * marketplace state into existence; it never gates suspending, ending,
 * withdrawing, closing, or any historical or support obligation. A suspended
 * participant must still be able to stop, and Monacado must still be able to
 * refund, dispute, and correct on their completed sales.
 */
export async function assertParticipantMayAuthorMarketplaceState(
  tx: Tx,
  participantId: string,
): Promise<void> {
  if (await isParticipantSuspended(tx, participantId)) {
    throw new ParticipantActionNotPermittedError("PARTICIPANT_SUSPENDED");
  }
}

/** One party to a prospective sale, and the role they play in it. */
export interface TransactingParty {
  readonly participantId: string;
  readonly role: MarketplaceRole;
}

/**
 * May these parties transact a NEW sale?
 *
 * The seam that closes the phase's headline gap. Three properties matter:
 *
 *   1. **Every party, not just the Listing's controller.** On a promoted sale the
 *      controller is the PROMOTER, so the Offer's seller — the party whose goods
 *      are sold and who is owed proceeds — was never checked. A suspended seller
 *      kept selling indefinitely through any promoted Listing.
 *
 *   2. **Role-appropriate scopes.** A promoter is not evaluated against
 *      `offer:publish`, a capability they never exercise. The pre-1.15 gate read
 *      one flat list for both parties and so withheld the wrong capability from
 *      the wrong party.
 *
 *   3. **Suspension dominates, per party.** Independently: a restriction or
 *      suspension on the seller refuses the sale, and one on the promoter refuses
 *      the sale, and neither is inferred from the other. A Seller×Promoter risk
 *      anomaly is evidence about a relationship and never enforcement against a
 *      party who was not themselves decided against.
 *
 * **Future commerce only.** This runs before any Order row exists. It never
 * reaches a completed sale, a refund, a dispute, a tax correction, or a recorded
 * obligation — restricting a participant withholds what they may do next, never
 * what Monacado already owes or already promised a buyer.
 */
export async function assertPartiesMayTransact(
  tx: Tx,
  parties: readonly TransactingParty[],
): Promise<void> {
  for (const party of parties) {
    await assertParticipantMayPerform(
      tx,
      party.participantId,
      commerceBlockingScopesForRole(party.role),
    );
  }
}

/**
 * Does an active suspension stand?
 *
 * Narrow by design, for the seams that must refuse a suspended participant
 * without asking about any scope — settlement being the one that matters, where
 * a suspension previously had no effect at all while a restriction did.
 */
export async function isParticipantSuspended(
  tx: Tx,
  participantId: string,
): Promise<boolean> {
  return (await readParticipantStanding(tx, participantId)).suspended;
}
