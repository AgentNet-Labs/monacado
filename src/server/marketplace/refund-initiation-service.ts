/**
 * Buyer-initiated refund requests (Phase 1.9 correction) — SERVER ONLY.
 *
 * How a buyer actually starts a refund, and the one property that shapes the
 * whole module:
 *
 * > **A guest buyer must be able to initiate a refund without creating an
 * > account.**
 *
 * `0M.9` made guest checkout first-class and deliberately fabricated no Account
 * for it. A refund path that required one would retro-fit exactly the account the
 * buyer declined to create — and it would strand every guest purchase ever made,
 * which is the majority of them on a marketplace with no sign-up wall.
 *
 * ## The verification is the credential the purchase already established
 *
 * A guest proves the purchase with the claim code handed to them once at
 * checkout, of which **only a SHA-256 digest is stored**. Nothing new is minted,
 * no account is created, and the raw code is compared and discarded — never
 * persisted, never logged, never echoed in an error.
 *
 * That is the same credential `claimGuestOrder` already accepts, through the same
 * `hashGuestClaimCode` helper. A second verification mechanism would be a second
 * thing to get wrong about the one secret standing between a stranger and
 * somebody's purchase history.
 *
 * ## Refusals are identical, deliberately
 *
 * A wrong claim code, an unknown Order, and an Order belonging to somebody else
 * all answer `REFUND_INITIATION_REFUSED` with nothing else. Distinguishing them
 * would turn this into an oracle for which Order ids exist and which codes are
 * close — the same reasoning `0M.9`'s `GuestClaimRefusedError` follows.
 *
 * ## It decides nothing about the refund itself
 *
 * Verification establishes *who is asking*. Whether the refund may happen is
 * `evaluateRefundEligibility`'s, unchanged and unweakened: the seller's bound
 * policy, the window, the lines, and the amount are all decided there. A buyer
 * asking politely does not widen what the terms allow.
 *
 * ## And it reads nothing from the seller's CURRENT configuration
 *
 * Everything that governs the request comes from evidence attached to the
 * historical purchase: the policy version bound to the Order, and — for the
 * instructions a buyer follows — the contact frozen on
 * `OrderRefundContactEvidence`, which `readOrderRefundReceipt` returns without
 * needing an account.
 *
 * So a seller changing their support address, nominating a dedicated one, or
 * publishing tighter terms **cannot invalidate a buyer's purchase-time refund
 * rights or alter the policy governing their request**. That is not incidental:
 * a guest holds no account, so the purchase evidence is the only thing standing
 * between them and a seller's later change of mind.
 *
 * **This is not a support portal.** It is the smallest service contract that lets
 * a buyer — account holder or guest — start a governed refund.
 */

import "../server-only";
import type {
  RefundInitiationVerificationKind,
} from "../../contracts/marketplace/refund-disclosure";
import type { RefundReasonCode } from "../../contracts/marketplace/order-refund";
import type { OrderRefundRecord } from "../../contracts/marketplace/order-refund";
import { getPrisma } from "../db/client";
import { hashGuestClaimCode } from "./guest-claim-code";
import { RefundError } from "./refund-errors";
import { requestOrderRefund, type RefundServiceDeps } from "./order-refund-service";

/**
 * The buyer could not be established as the buyer of this Order.
 *
 * One name for every way of failing, and it carries **no Order id, no claim code,
 * and no account id** — an error that echoed a rejected credential would put it
 * in every log that captured the failure.
 */
export class RefundInitiationRefusedError extends RefundError {
  constructor() {
    super("REFUND_REFUSED", "This refund request could not be verified");
    this.name = "RefundInitiationRefusedError";
  }
}

/**
 * How the requester proves they are the buyer.
 *
 * A discriminated union rather than a bag of optional fields, so a caller cannot
 * supply an account id and a claim code together and leave the service choosing
 * which to trust.
 */
export type RefundInitiationVerification =
  | { kind: "GUEST_CLAIM_CODE"; guestClaimCode: string }
  | { kind: "BUYER_ACCOUNT"; accountId: string }
  | { kind: "OPERATOR"; actingAccountId: string };

export interface InitiateRefundRequestInput {
  orderId: string;
  verification: RefundInitiationVerification;
  reasonCode: RefundReasonCode;
  /** Whole lines. Omit to request every line on the Order. */
  selectedLineRefs?: readonly string[];
  requestedAt: string;
}

/**
 * Verify that the requester is this Order's buyer, without creating anything.
 *
 * Returns the account to record against the refund, or `null` for a guest — who
 * legitimately has none, and for whom **none is fabricated**.
 *
 * A guest who has since claimed their Order into an account may still use their
 * code: `claimGuestOrder` leaves `buyerKind` as `GUEST_BUYER` and the digest in
 * place, because the sale was made by a guest, and the code they were handed is
 * still the credential they hold.
 */
async function verifyBuyer(
  db: ReturnType<typeof getPrisma>,
  orderId: string,
  verification: RefundInitiationVerification,
): Promise<{ requestedByAccountId: string | null }> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      buyerKind: true,
      buyerAccountId: true,
      claimedByAccountId: true,
      guestClaimCodeDigest: true,
    },
  });
  /* An unknown Order answers exactly as a wrong credential does. */
  if (order === null) throw new RefundInitiationRefusedError();

  switch (verification.kind) {
    case "GUEST_CLAIM_CODE": {
      if (order.guestClaimCodeDigest === null) throw new RefundInitiationRefusedError();
      /* The raw code exists in this scope and nowhere else. Compared by digest,
         never stored, never logged. */
      if (hashGuestClaimCode(verification.guestClaimCode) !== order.guestClaimCodeDigest) {
        throw new RefundInitiationRefusedError();
      }
      /* NO ACCOUNT IS FABRICATED. A guest's refund records no acting account,
         which is the accurate statement: nobody with an account asked. */
      return { requestedByAccountId: null };
    }

    case "BUYER_ACCOUNT": {
      const isBuyer =
        order.buyerAccountId === verification.accountId ||
        order.claimedByAccountId === verification.accountId;
      if (!isBuyer) throw new RefundInitiationRefusedError();
      return { requestedByAccountId: verification.accountId };
    }

    case "OPERATOR": {
      /* An operator acting on a buyer's behalf. The ENTITLEMENT that permits it
         is checked by whatever route exposes this — an internal command or a
         protected endpoint — on the same terms as every other operator action in
         this repository. What is recorded here is WHO acted, which is the fact a
         later audit needs. */
      return { requestedByAccountId: verification.actingAccountId };
    }
  }
}

/**
 * A buyer asks for their money back.
 *
 * Verifies who is asking, then delegates every commercial decision to
 * `requestOrderRefund` — which applies the seller's **bound** policy, the
 * declared window, the line selection, and the derived amount. Nothing here
 * widens what the terms allow, and nothing here names a monetary figure.
 *
 * The requestor kind is recorded honestly: `BUYER` for the two buyer paths and
 * `OPERATOR` for the third, so an audit can tell who set a refund in motion.
 */
export async function initiateRefundRequest(
  input: InitiateRefundRequestInput,
  deps: RefundServiceDeps = {},
): Promise<OrderRefundRecord> {
  const db = deps.db ?? getPrisma();
  const { requestedByAccountId } = await verifyBuyer(db, input.orderId, input.verification);

  return requestOrderRefund(
    {
      orderId: input.orderId,
      reasonCode: input.reasonCode,
      requestorKind: input.verification.kind === "OPERATOR" ? "OPERATOR" : "BUYER",
      requestedByAccountId,
      requestedAt: input.requestedAt,
      ...(input.selectedLineRefs === undefined
        ? {}
        : { selectedLineRefs: input.selectedLineRefs }),
    },
    deps,
  );
}

export type { RefundInitiationVerificationKind };
