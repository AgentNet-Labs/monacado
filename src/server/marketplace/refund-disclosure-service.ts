/**
 * Refund disclosure and receipt reads (Phase 1.9 correction) — SERVER ONLY.
 *
 * Two reads, and the difference between them is the whole point:
 *
 * ```
 * readListingRefundPolicyDisclosure   the seller's ACTIVE policy   → before purchase
 * readOrderRefundReceipt              the version the ORDER BOUND  → on the receipt
 * ```
 *
 * **Reads only.** Nothing here writes, and nothing contacts a provider.
 *
 * ## The receipt never substitutes today's terms
 *
 * `readOrderRefundReceipt` reads the version stored on the Order and returns
 * `null` with a bounded reason where none is bound. It does **not** fall back to
 * the seller's current policy — showing a buyer today's terms for a purchase made
 * under yesterday's would be worse than showing none, because it would look
 * authoritative. `1.3`'s `readOrderPolicyView` made the identical call about
 * marketplace terms; this is that rule applied to the seller's.
 *
 * ## The support contact: frozen for the receipt, live for convenience
 *
 * `readOrderRefundReceipt` renders `purchaseTimeRefundContact` from
 * `OrderRefundContactEvidence`, captured at checkout and **never refreshed**. A
 * receipt is evidence of a disclosure; substituting an address the buyer was
 * never shown would make it evidence of nothing.
 *
 * The seller's **current** contact is returned separately as
 * `currentSellerSupportContact`, through the single canonical resolver, purely so
 * a buyer acting today can reach a mailbox that still works. It is structurally
 * unable to alter the historical value, and **an old receipt reproduces without
 * it** — including for a seller who has since gone dark entirely.
 */

import "../server-only";
import {
  OrderRefundReceiptView,
  RefundPolicyDisclosure,
} from "../../contracts/marketplace/refund-disclosure";
import {
  selectSellerRefundSection,
  type RefundProcedureKind,
} from "../../contracts/marketplace/seller-refund-policy";
import { getPrisma } from "../db/client";
import { resolveSellerSupportContactIn } from "../policy/support-contact-service";
import {
  getActiveSellerRefundPolicyVersionIn,
  readSellerRefundPolicyVersionIn,
} from "./seller-refund-policy-service";
import { resolveSaleCounterparties } from "./checkout-service";
import { versionRowToSourceVersion } from "./listing-mapper";

type Db = ReturnType<typeof getPrisma>;

export interface RefundDisclosureDeps {
  db?: Db;
}

const UNAVAILABLE = (at: string): RefundPolicyDisclosure =>
  RefundPolicyDisclosure.parse({
    available: false,
    sellerParticipantId: null,
    policyId: null,
    policyVersion: null,
    document: null,
    refundsAllowed: null,
    refundWindowDays: null,
    shippingRefundable: null,
    procedureKind: null,
    contentHash: null,
    evaluatedAt: at,
  });

/**
 * The refund policy a purchase of this Listing **right now** would bind.
 *
 * The pre-purchase disclosure hook, and deliberately the smallest one that works:
 * a listing page or a checkout surface calls it and renders the complete
 * document. No UI is built here.
 *
 * ## It resolves the SELLER, not the Listing's controller
 *
 * On a promoted Listing those are different people, and the returns terms belong
 * to whoever supplies the Product — the same party `resolveSaleCounterparties`
 * names as the seller and `0M.9` pays seller proceeds to. A promoter does not
 * declare returns terms for goods that are not theirs, and disclosing the
 * promoter's policy would disclose terms nobody will honour.
 *
 * `available: false` is a real answer, and checkout refuses the sale on it.
 */
export async function readListingRefundPolicyDisclosure(
  internalListingId: string,
  at: string,
  deps: RefundDisclosureDeps = {},
): Promise<RefundPolicyDisclosure> {
  const db = deps.db ?? getPrisma();

  const listing = await db.listing.findUnique({
    where: { internalListingId },
    select: { listingSourceRecordId: true, currentSourceRecordVersion: true },
  });
  if (listing === null || listing.currentSourceRecordVersion === null) {
    return UNAVAILABLE(at);
  }

  const versionRow = await db.listingSourceRecordVersionRow.findUnique({
    where: {
      listingSourceRecordId_sourceRecordVersion: {
        listingSourceRecordId: listing.listingSourceRecordId,
        sourceRecordVersion: listing.currentSourceRecordVersion,
      },
    },
  });
  if (versionRow === null) return UNAVAILABLE(at);

  let sellerParticipantId: string;
  try {
    const sourceVersion = versionRowToSourceVersion(versionRow);
    ({ sellerParticipantId } = await resolveSaleCounterparties(db, sourceVersion));
  } catch {
    /* A Listing whose seller cannot be resolved has no disclosable terms, and
       checkout will refuse it for the same reason before any Order exists. */
    return UNAVAILABLE(at);
  }

  const policy = await getActiveSellerRefundPolicyVersionIn(db, sellerParticipantId);
  if (policy === null) {
    return RefundPolicyDisclosure.parse({
      ...UNAVAILABLE(at),
      sellerParticipantId,
    });
  }

  return RefundPolicyDisclosure.parse({
    available: true,
    sellerParticipantId,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    /* THE COMPLETE DOCUMENT. A disclosure a buyer cannot read in full is not a
       disclosure, and a summary would be a claim the terms might not support. */
    document: policy.document,
    refundsAllowed: policy.terms.refundsAllowed,
    refundWindowDays: policy.terms.refundWindowDays,
    shippingRefundable: policy.terms.shippingRefundability,
    procedureKind: policy.terms.procedureKind,
    contentHash: policy.contentHash,
    evaluatedAt: at,
  });
}

/**
 * The refund policy that **governed** this Order, as a receipt must state it.
 *
 * Complete historical terms, the exact version reference a later reader can
 * produce them from, the procedure, and where to send it.
 *
 * Returns a bounded `unavailableReason` rather than a fallback. A pre-correction
 * Order is `POLICY_NOT_BOUND`; a bound version whose content has moved is
 * `POLICY_UNREADABLE` — refused rather than shown, because a receipt must render
 * what the buyer was actually shown or say that it cannot.
 */
export async function readOrderRefundReceipt(
  orderId: string,
  at: string,
  deps: RefundDisclosureDeps = {},
): Promise<OrderRefundReceiptView> {
  const db = deps.db ?? getPrisma();

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      sellerParticipantId: true,
      sellerRefundPolicyId: true,
      sellerRefundPolicyVersion: true,
      /* The frozen disclosure. Read with the Order, so a receipt never has to
         reach for a seller's current configuration to assemble itself. */
      refundContactEvidence: {
        select: {
          contactAddress: true,
          contactSource: true,
          contactState: true,
          capturedAt: true,
        },
      },
    },
  });
  if (order === null) {
    return OrderRefundReceiptView.parse({
      orderId,
      policyVersion: null,
      policyRef: null,
      procedure: null,
      currentSellerSupportContact: null,
      unavailableReason: "ORDER_NOT_FOUND",
      evaluatedAt: at,
    });
  }

  /* Resolved for CONVENIENCE ONLY, and deliberately after the historical read is
     already possible: nothing below depends on it, and a failure to resolve one
     cannot stop an old receipt rendering. */
  const currentSupport = await resolveSellerSupportContactIn(db, order.sellerParticipantId);
  const currentSellerSupportContact = currentSupport.available ? currentSupport.address : null;

  if (order.sellerRefundPolicyId === null || order.sellerRefundPolicyVersion === null) {
    /* NOTHING IS SUBSTITUTED. An Order placed before the binding existed shows no
       policy rather than the seller's current one. */
    return OrderRefundReceiptView.parse({
      orderId,
      policyVersion: null,
      policyRef: null,
      procedure: null,
      currentSellerSupportContact,
      unavailableReason: "POLICY_NOT_BOUND",
      evaluatedAt: at,
    });
  }

  let policy;
  try {
    /* Deliberately NOT filtered by status: the version an Order was sold under is
       very often RETIRED by the time anybody opens the receipt, and one that
       could not render a retired version would break the day a seller updates
       their terms. */
    policy = await readSellerRefundPolicyVersionIn(
      db,
      order.sellerRefundPolicyId,
      order.sellerRefundPolicyVersion,
    );
  } catch {
    policy = null;
  }
  if (policy === null) {
    return OrderRefundReceiptView.parse({
      orderId,
      policyVersion: null,
      policyRef: null,
      procedure: null,
      currentSellerSupportContact,
      unavailableReason: "POLICY_UNREADABLE",
      evaluatedAt: at,
    });
  }

  const procedureSection = selectSellerRefundSection(policy.document, "PROCEDURE");
  const evidence = order.refundContactEvidence;

  return OrderRefundReceiptView.parse({
    orderId,
    policyVersion: policy,
    policyRef: {
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      contentHash: policy.contentHash,
    },
    procedure: {
      kind: policy.terms.procedureKind as RefundProcedureKind,
      /* Required by `sellerRefundPolicyIssues`, so a recorded version always has
         one. Asserted with a fallback rather than a throw: a receipt that failed
         to render because of a missing section would deny the buyer everything
         else on it. */
      instructions:
        procedureSection?.body ??
        "Contact the seller through the support address on this receipt to request a refund.",
      /* THE VALUE THE BUYER WAS SHOWN. Frozen, and `null` only for an Order
         placed before this evidence was captured — never a fallback to whatever
         the seller's address is today. */
      purchaseTimeRefundContact:
        evidence === null || evidence === undefined
          ? null
          : {
              address: evidence.contactAddress,
              source: evidence.contactSource,
              state: evidence.contactState,
              capturedAt: evidence.capturedAt.toISOString(),
            },
      requiresBuyerAccount: false,
    },
    /* Beside it, never instead of it. */
    currentSellerSupportContact,
    unavailableReason: null,
    evaluatedAt: at,
  });
}
