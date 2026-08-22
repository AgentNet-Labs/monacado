/**
 * Order policy view (Phase 1.3) — SERVER ONLY.
 *
 * **The four things a receipt needs, and nothing else.** Not a receipt engine —
 * no rendering, no template, no PDF, no delivery. This answers the questions a
 * future receipt will ask, so that building one is a presentation problem rather
 * than a policy archaeology problem.
 *
 * ```
 * 1. which policy version governed this purchase
 * 2. the buyer-facing sections of it
 * 3. the seller's effective support contact
 * 4. the commercial policy the sale was priced under
 * ```
 *
 * ## Why the Order binds a version
 *
 * A receipt opened next year must show the disclosures that applied **when the
 * purchase was made**, not whichever version happens to be current when somebody
 * clicks. So checkout records `(marketplacePolicyId, marketplacePolicyVersion)`
 * on the Order, exactly as it already records the commercial policy binding.
 *
 * **No prose is copied onto the Order.** The version is authoritative; a copied
 * paragraph would be a second answer able to disagree with it — and the copy is
 * always the one that gets read.
 *
 * Every Phase-1.3-era Order carries one: checkout refuses to place an Order it
 * cannot bind (`MARKETPLACE_POLICY_UNAVAILABLE`).
 *
 * ## Orders that predate the binding
 *
 * The columns are additive and nullable, so Orders written before Phase 1.3 carry
 * no version. Those return `policyVersion: null` rather than falling back to the
 * current one: showing a buyer today's terms for a purchase made under yesterday's
 * would be worse than showing none, because it would look authoritative. Nothing
 * backfills them.
 *
 * ## Two different clocks, deliberately
 *
 * | | Time semantics |
 * | --- | --- |
 * | governing policy | the version **stored on the Order** — a historical snapshot |
 * | seller support destination | the **current** effective contact, read now |
 *
 * A receipt opened next year must show the disclosures that applied when the
 * purchase was made. Support, in the same breath, must route to a mailbox that
 * works today — sending a buyer to the address that worked at checkout would send
 * them nowhere. So no support address is snapshotted onto the Order.
 */

import "../server-only";
import type {
  MarketplacePolicyVersionRecord,
  PolicySection,
} from "../../contracts/marketplace/marketplace-policy";
import { selectSectionsForAudience } from "../../contracts/marketplace/marketplace-policy";
import type { EffectiveSupportContact } from "../../contracts/marketplace/participant-email-contact";
import { getPrisma } from "../db/client";
import { readMarketplacePolicy } from "./marketplace-policy-service";
import { resolveSellerSupportContactIn } from "./support-contact-service";
import { PolicyError, PolicyPersistenceFailureError } from "./policy-errors";

type Db = ReturnType<typeof getPrisma>;

/**
 * Everything a receipt or checkout disclosure needs about one Order.
 *
 * The commercial policy is carried as a **reference**, never as figures: what
 * Monacado retained is on the `0M.T1` snapshot, and restating it here would put
 * a marketplace's commercial position into a buyer-facing view.
 */
export interface OrderPolicyView {
  orderId: string;
  /** `null` for an Order placed before the binding existed. */
  policyVersion: MarketplacePolicyVersionRecord | null;
  /** Buyer-facing sections of the version that governed. Empty when unbound. */
  buyerSections: PolicySection[];
  /** The seller's effective support contact at the time of asking. */
  sellerSupportContact: EffectiveSupportContact;
  /** The exact commercial policy the sale was priced under. A reference only. */
  commercialPolicy: { policyId: string; policyVersion: string };
}

export async function readOrderPolicyView(
  orderId: string,
  deps: { db?: Db } = {},
): Promise<OrderPolicyView> {
  const db = deps.db ?? getPrisma();

  try {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        policyId: true,
        policyVersion: true,
        marketplacePolicyId: true,
        marketplacePolicyVersion: true,
        sellerParticipantId: true,
      },
    });
    if (order === null) {
      throw new PolicyError("ORDER_NOT_FOUND", "No such order");
    }

    /* The seller's contact, resolved through the single canonical resolver.
       Read at ASK TIME rather than bound to the Order: a buyer needing support
       needs the address that works now, not the one that worked at checkout. */
    const sellerSupportContact = await resolveSellerSupportContactIn(
      db,
      order.sellerParticipantId,
    );

    if (order.marketplacePolicyId === null || order.marketplacePolicyVersion === null) {
      return {
        orderId: order.id,
        policyVersion: null,
        buyerSections: [],
        sellerSupportContact,
        commercialPolicy: {
          policyId: order.policyId,
          policyVersion: order.policyVersion,
        },
      };
    }

    /* Verified against the source: a stored version whose prose has moved is
       refused rather than shown. */
    const { version, document } = await readMarketplacePolicy(
      order.marketplacePolicyId,
      order.marketplacePolicyVersion,
      { db },
    );

    return {
      orderId: order.id,
      policyVersion: version,
      buyerSections: selectSectionsForAudience(document, "BUYER"),
      sellerSupportContact,
      commercialPolicy: {
        policyId: order.policyId,
        policyVersion: order.policyVersion,
      },
    };
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyPersistenceFailureError("readOrderPolicyView", error);
  }
}
