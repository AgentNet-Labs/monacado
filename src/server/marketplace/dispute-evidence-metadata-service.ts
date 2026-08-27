/**
 * What Monacado holds that could answer a dispute (Phase 1.11) — SERVER ONLY.
 *
 * **Derived, never stored.** There is deliberately no dispute-evidence table.
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
      internalListingId: true,
    },
  });
  /* No Order, no evidence. An empty list rather than a list of `false`s: the
     question "what do we hold about this sale" has no answer when there is no
     sale, and fabricating one would read as "we hold nothing", which is a
     different and weaker claim. */
  if (order === null) return [];

  /* The single most valuable thing Monacado holds: provable delivery of a
     receipt to the cardholder's own address. The DELIVERY row is referenced, not
     its destination — `OutboundEmailDelivery` stores a digest rather than an
     address, which is precisely why referencing it is safe. */
  const receiptDelivery = await db.outboundEmailDelivery.findFirst({
    where: { subjectKind: "ORDER", subjectRef: orderId, purpose: "ORDER_CONFIRMATION" },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true },
  });

  const communicationCount = await db.outboundEmailDelivery.count({
    where: { subjectKind: "ORDER", subjectRef: orderId },
  });

  /* Referenced by Order, and ONLY by Order. This row carries the seller support
     address that was disclosed with the purchase, and the address itself is
     never returned from here — an availability map that leaked a contact value
     would be the first place buyer-adjacent detail escaped. */
  const contactEvidence = await db.orderRefundContactEvidence.findUnique({
    where: { orderId },
    select: { orderId: true },
  });

  const out: DisputeEvidenceAvailability[] = [
    {
      evidenceCode: "RECEIPT_AND_DELIVERY_PROOF",
      available: receiptDelivery !== null && receiptDelivery.status === "DELIVERED",
      monacadoRecordRef: receiptDelivery?.id ?? null,
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
      available: true,
      monacadoRecordRef: order.internalListingId,
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
