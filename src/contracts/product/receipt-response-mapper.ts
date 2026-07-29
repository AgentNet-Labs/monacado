/**
 * Transport response → receipt envelope mapping (Phase 0E.6.4).
 *
 * Pure and total: no I/O, no clock, no randomness. Given the same response it
 * produces the same envelope, or the same refusal.
 *
 * **Most REGISTER responses are not receipts.** A response echoes an attempt and
 * states a verdict; an authoritative receipt additionally asserts *what was
 * registered, under which identifier, and when*. The `RegisterResponseEnvelope`
 * marks those fields optional precisely because a Registrar may acknowledge
 * without registering.
 *
 * So this mapper's real job is to say **no**. It never invents a receiptId, a
 * registration identifier, a registered content hash, a `registeredAt`, or a
 * Registrar identity — fabricating any of them would manufacture authority the
 * Registrar never granted, and the resulting "receipt" would resolve a
 * publication on the strength of a value this system made up.
 *
 * Nothing calls this automatically. The single-run orchestrator still does not
 * ingest its own response; promoting a response to a receipt is a caller's
 * explicit decision.
 */

import { ExternalReceiptEnvelope, type ExternalReceiptEnvelope as Envelope } from "./receipt-ingestion";
import type { RegisterResponseEnvelope } from "./registrar-transport";

/** Either a complete envelope, or the reason it is not one. */
export type ReceiptEnvelopeMapping =
  | { authoritative: true; envelope: Envelope }
  | { authoritative: false; missingFields: string[] };

/**
 * Fields an authoritative receipt requires that a response may legitimately omit.
 *
 * `receiptId` is deliberately NOT in this list — it is supplied by the caller,
 * because minting an identifier for someone else's assertion is precisely the
 * fabrication this mapper exists to prevent.
 */
const REQUIRED_FOR_AUTHORITY = [
  "registrarId",
  "nodeId",
  "capsuleId",
  "registeredContentHash",
  "registeredAt",
] as const;

/**
 * Map a validated Phase 0E.6.1 response onto an ingestion envelope.
 *
 * `receiptId` is supplied by the caller, which is what keeps this honest: a
 * caller promoting a response to a receipt must name it, and that naming is the
 * decision, not a side effect of parsing.
 */
export function mapRegistrarTransportResponseToReceiptEnvelope(
  response: RegisterResponseEnvelope,
  context: { receiptId: string; publicationId: string },
): ReceiptEnvelopeMapping {
  const missingFields: string[] = [];
  for (const field of REQUIRED_FOR_AUTHORITY) {
    if (response[field] === undefined) missingFields.push(field);
  }
  // An acceptance that registered nothing identifiable is not a receipt.
  if (response.status === "ACCEPTED" && response.registrarRegistrationId === undefined) {
    missingFields.push("registrarRegistrationId");
  }
  if (missingFields.length > 0) return { authoritative: false, missingFields };

  const candidate = {
    receiptId: context.receiptId,
    submissionAttemptId: response.submissionAttemptId,
    publicationId: context.publicationId,
    ...(response.registrarRegistrationId !== undefined
      ? { registrarRegistrationId: response.registrarRegistrationId }
      : {}),
    registrarId: response.registrarId,
    nodeId: response.nodeId,
    capsuleId: response.capsuleId,
    registeredContentHash: response.registeredContentHash,
    receiptStatus: response.status,
    registeredAt: response.registeredAt,
    receiptDetails: {
      ...(response.statusCode !== undefined ? { registrarStatusCode: response.statusCode } : {}),
      ...(response.rejectionCode !== undefined ? { rejectionCode: response.rejectionCode } : {}),
      ...(response.rejectionReason !== undefined
        ? { rejectionReason: response.rejectionReason }
        : {}),
    },
  };

  const parsed = ExternalReceiptEnvelope.safeParse(candidate);
  if (!parsed.success) {
    // Shape survived the presence check but failed validation — report the
    // failing paths, never the values.
    return {
      authoritative: false,
      missingFields: Array.from(
        new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)")),
      ),
    };
  }
  return { authoritative: true, envelope: parsed.data };
}
