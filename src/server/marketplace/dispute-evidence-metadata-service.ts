/**
 * What Monacado holds that could answer a dispute (Phase 1.11, corrected in
 * 1.12) — SERVER ONLY.
 *
 * **Derived, never stored.** There is deliberately no dispute-evidence table for
 * anything in this map.
 *
 * Every entry below already exists as an authoritative record. Copying them into
 * an evidence table would create a second answer able to disagree with the
 * record it describes — and the two most valuable entries, the receipt and the
 * buyer correspondence, would turn such a table into a mail archive holding
 * cardholder addresses, which every notification contract in this repository
 * refuses to keep.
 *
 * So this returns **availability and a reference**, never a value. An operator
 * assembling a response follows the references to the authoritative rows.
 *
 * ## Three corrections this phase makes to 1.11
 *
 * 1.11 shipped this map with three claims that were wrong in ways that only
 * matter once something acts on them. 1.12 is that something, so they are fixed
 * here rather than recorded.
 *
 * 1. **`PRODUCT_DESCRIPTION_AT_SALE` was a mutable pointer.** It reported
 *    `available: true` against `Order.internalListingId` — the *stable* Listing
 *    row, whose current source version moves every time the seller edits.
 *    Following it resolves what the listing says **today**, and the bound
 *    `ListingSourceRecordVersionRow` carries placement and price only, with no
 *    title or description at all. A seller who edited a product after a
 *    chargeback would have silently rewritten Monacado's evidence.
 *    `RECEIPT_LINE_DESCRIPTION_GAP` already ruled `liveReadSubstitution:
 *    "REFUSED"` for exactly this, and this file contradicted it.
 *
 *    The Order still binds no Product source version, so the honest answer is
 *    **conditional**: the tax transaction recorded for the sale pins the exact
 *    Product source version whose classification produced the rate, and that
 *    pin is a sale-time fact rather than a live read. Where it exists, the
 *    description is evidenceable; where it does not, this reports `false`
 *    rather than pointing at something mutable.
 *
 * 2. **`CUSTOMER_COMMUNICATION` counted mail sent to the seller.** The query
 *    filtered on subject alone, and `SALE_RECORDED` mail goes to the seller and
 *    the promoter. A sale where only the seller was emailed reported that
 *    Monacado held buyer correspondence. Submitting that to a card network as
 *    customer communication would be a false statement to a bank. It now filters
 *    on `audience: "BUYER"`.
 *
 * 3. **`RECEIPT_AND_DELIVERY_PROOF` overstated what the status means.**
 *    `OutboundEmailDelivery.status === "DELIVERED"` means an email provider
 *    accepted responsibility for the message, not that it reached an inbox. That
 *    is still real evidence — Monacado sent the receipt and a provider took it —
 *    but it is *send-and-accept* proof. Where a provider event genuinely
 *    confirms delivery, the reference points at that event instead, so an
 *    operator can tell the strong case from the ordinary one.
 *
 * ## Two entries that can never be satisfied
 *
 * `SHIPPING_DOCUMENTATION` and `ACCESS_ACTIVITY_LOG` are reported `available:
 * false` unconditionally, because no carrier, tracking, fulfilment, or
 * entitlement-access field exists anywhere in this repository. **Physical-goods
 * representment cannot be evidenced today.** They are named rather than omitted
 * so the gap is visible before a dispute rather than during one.
 */

import "../server-only";
import {
  DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE,
  type DisputeEvidenceAvailability,
} from "../../contracts/marketplace/dispute-operations";
import { getPrisma } from "../db/client";

export interface DisputeEvidenceDeps {
  db?: ReturnType<typeof getPrisma>;
}

/**
 * Assemble the evidence availability map for one sale.
 *
 * Read-only. No provider call, no write, and no buyer value is returned — the
 * references are Monacado's own record identifiers.
 */
export async function assembleDisputeEvidenceMetadata(
  orderId: string,
  deps: DisputeEvidenceDeps = {},
): Promise<DisputeEvidenceAvailability[]> {
  const db = deps.db ?? getPrisma();

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      paidAt: true,
      sellerRefundPolicyId: true,
      sellerRefundPolicyVersion: true,
      marketplacePolicyId: true,
      marketplacePolicyVersion: true,
    },
  });
  /* No Order, no evidence. An empty list rather than a list of `false`s: the
     question "what do we hold about this sale" has no answer when there is no
     sale, and fabricating one would read as "we hold nothing", which is a
     different and weaker claim. */
  if (order === null) return [];

  /* The single most valuable thing Monacado holds: provable dispatch of a
     receipt to the cardholder's own address. The DELIVERY row is referenced, not
     its destination — `OutboundEmailDelivery` stores a digest rather than an
     address, which is precisely why referencing it is safe. */
  const receiptDelivery = await db.outboundEmailDelivery.findFirst({
    where: { subjectKind: "ORDER", subjectRef: orderId, purpose: "ORDER_CONFIRMATION" },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, providerMessageRef: true },
  });

  /* The stronger claim, where the provider made it. A delivery event is the
     provider's own confirmation rather than its acceptance, and referencing it
     lets an operator tell a strong representment from an ordinary one. */
  const confirmedDelivery =
    receiptDelivery?.providerMessageRef == null
      ? null
      : await db.providerEmailEvent.findFirst({
          where: { providerMessageRef: receiptDelivery.providerMessageRef, eventType: "DELIVERED" },
          orderBy: { occurredAt: "asc" },
          select: { id: true },
        });

  /* BUYER ONLY. Filtering on the subject alone counted seller and promoter mail
     as buyer correspondence — see correction 2 in this module's header. */
  const communicationCount = await db.outboundEmailDelivery.count({
    where: { subjectKind: "ORDER", subjectRef: orderId, audience: "BUYER" },
  });

  /* Referenced by Order, and ONLY by Order. This row carries the seller support
     address that was disclosed with the purchase, and the address itself is
     never returned from here — an availability map that leaked a contact value
     would be the first place buyer-adjacent detail escaped. */
  const contactEvidence = await db.orderRefundContactEvidence.findUnique({
    where: { orderId },
    select: { orderId: true },
  });

  /* The sale-time Product source version, pinned by the tax transaction rather
     than joined through a mutable listing pointer. See correction 1. */
  const taxTransaction = await db.orderTaxTransaction.findUnique({
    where: { orderId },
    select: { productSourceRecordId: true, productSourceRecordVersion: true },
  });

  const out: DisputeEvidenceAvailability[] = [
    {
      evidenceCode: "RECEIPT_AND_DELIVERY_PROOF",
      available: receiptDelivery !== null && receiptDelivery.status === "DELIVERED",
      monacadoRecordRef: confirmedDelivery?.id ?? receiptDelivery?.id ?? null,
    },
    {
      evidenceCode: "CUSTOMER_COMMUNICATION",
      available: communicationCount > 0,
      monacadoRecordRef: communicationCount > 0 ? orderId : null,
    },
    {
      evidenceCode: "REFUND_POLICY_VERSION_BOUND_AT_PURCHASE",
      available: order.sellerRefundPolicyId !== null && order.sellerRefundPolicyVersion !== null,
      monacadoRecordRef:
        order.sellerRefundPolicyId === null || order.sellerRefundPolicyVersion === null
          ? null
          : `${order.sellerRefundPolicyId}@${order.sellerRefundPolicyVersion}`,
    },
    {
      evidenceCode: "MARKETPLACE_POLICY_VERSION_AT_PURCHASE",
      available: order.marketplacePolicyId !== null && order.marketplacePolicyVersion !== null,
      monacadoRecordRef:
        order.marketplacePolicyId === null || order.marketplacePolicyVersion === null
          ? null
          : `${order.marketplacePolicyId}@${order.marketplacePolicyVersion}`,
    },
    {
      evidenceCode: "PRODUCT_DESCRIPTION_AT_SALE",
      available: taxTransaction !== null,
      monacadoRecordRef:
        taxTransaction === null
          ? null
          : `${taxTransaction.productSourceRecordId}@${taxTransaction.productSourceRecordVersion}`,
    },
    {
      evidenceCode: "SERVICE_DATE",
      available: order.paidAt !== null,
      monacadoRecordRef: order.paidAt === null ? null : orderId,
    },
    {
      evidenceCode: "DISCLOSED_SELLER_CONTACT",
      available: contactEvidence !== null,
      monacadoRecordRef: contactEvidence?.orderId ?? null,
    },
  ];

  /* The two nothing can satisfy. Reported rather than omitted. */
  for (const code of DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE) {
    out.push({ evidenceCode: code, available: false, monacadoRecordRef: null });
  }

  return out;
}
