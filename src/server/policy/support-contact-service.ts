/**
 * Seller support contact resolution (Phase 1.3) — SERVER ONLY.
 *
 * **The one place a seller's customer-facing support address is decided.**
 *
 * Checkout, receipts, digital-delivery support routing, and seller-facing
 * surfaces must all call this. Four copies of a fallback rule is four chances to
 * disclose the wrong address — and the wrong address here means a buyer's
 * complaint reaches nobody.
 *
 * The precedence itself lives in the pure `resolveEffectiveSupportContact`
 * contract function; this supplies it with persisted state. Splitting them means
 * the rule is testable without a database and the lookup is testable without
 * restating the rule.
 *
 * ## Where each address comes from
 *
 * | Purpose | Address read from |
 * | --- | --- |
 * | `PRIMARY_PROFILE` | the participant's `Account.email` — never copied here |
 * | `DEDICATED_SUPPORT` | the contact row, which is the only place it exists |
 *
 * That asymmetry is `0M.5`'s rule kept: "the address already lives on `Account`
 * and a second copy here would be a second thing to leak."
 *
 * ## Privacy
 *
 * A seller's primary address is **operational private data**. It becomes
 * customer-facing only by being resolved here as the effective support contact —
 * which is an explicit disclosure decision the seller makes by activating without
 * nominating an alternative. Nothing publishes it into a capsule, and a seller
 * who wants a different public address nominates one.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  resolveEffectiveSupportContact,
  type EffectiveSupportContact,
  type EmailContactState,
} from "../../contracts/marketplace/participant-email-contact";
import { getPrisma } from "../db/client";
import { PolicyPersistenceFailureError } from "./policy-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

/**
 * The effective support contact for one participant.
 *
 * Returns `available: false` rather than throwing when nothing is usable: a
 * seller without a support contact is an ordinary, explicable state that
 * activation must refuse, not an exception a caller has to catch.
 */
export async function resolveSellerSupportContactIn(
  tx: Tx,
  participantId: string,
): Promise<EffectiveSupportContact> {
  const participant = await tx.marketplaceParticipant.findUnique({
    where: { id: participantId },
    select: { account: { select: { email: true } } },
  });

  const contacts = await tx.participantEmailContact.findMany({ where: { participantId } });
  const primaryContact = contacts.find((c) => c.purpose === "PRIMARY_PROFILE") ?? null;
  const dedicatedContact = contacts.find((c) => c.purpose === "DEDICATED_SUPPORT") ?? null;

  /* The primary ADDRESS comes from Account; the primary STATE comes from the
     contact row. Neither alone is enough: an address with no verification state
     cannot be trusted, and a state with no address cannot be used. */
  const accountEmail = participant?.account?.email ?? null;
  const primary =
    accountEmail === null || primaryContact === null
      ? null
      : { address: accountEmail, state: primaryContact.state as EmailContactState };

  const dedicated =
    dedicatedContact === null || dedicatedContact.address === null
      ? null
      : {
          address: dedicatedContact.address,
          state: dedicatedContact.state as EmailContactState,
        };

  return resolveEffectiveSupportContact({ primary, dedicated });
}

export async function resolveSellerSupportContact(
  participantId: string,
  deps: { db?: Db } = {},
): Promise<EffectiveSupportContact> {
  const db = deps.db ?? getPrisma();
  try {
    return await resolveSellerSupportContactIn(db, participantId);
  } catch (error) {
    throw new PolicyPersistenceFailureError("resolveSellerSupportContact", error);
  }
}

/**
 * Whether this participant has a usable support contact.
 *
 * The narrow question activation asks. Kept as its own function so the activation
 * path cannot accidentally treat an unavailable contact's *reason* as a value.
 */
export async function hasUsableSupportContactIn(
  tx: Tx,
  participantId: string,
): Promise<boolean> {
  return (await resolveSellerSupportContactIn(tx, participantId)).available;
}
