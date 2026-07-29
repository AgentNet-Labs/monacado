/**
 * Registrar receipt ingestion contract (Phase 0E.6.4).
 *
 * The boundary where a receipt obtained **outside this system** enters it. The
 * envelope is the widest attack surface in the Product publication path — it
 * arrives from elsewhere and decides whether a publication becomes registered —
 * so it is validated at its narrowest here.
 *
 * Two properties matter:
 *
 *   1. **Nothing internal may be supplied from outside.** A caller cannot hand
 *      us a lock token, a claim-token hash, a capsule payload, a database row
 *      id, or a credential. Those are refused structurally by `strictObject`
 *      rather than stripped, so an attempt to smuggle one fails loudly instead
 *      of being silently discarded.
 *
 *   2. **The envelope decides nothing.** It is mapped onto the existing
 *      `RegistrarReceiptInput` and handed to the Phase 0E.4 receipt service,
 *      which owns reconciliation, state transitions, and payload disposal.
 *
 * `receivedAt` is supplied explicitly. No clock is read.
 */

import { z } from "zod";
import {
  ReceiptDetails,
  ReceiptId,
  ReceiptStatus,
  RegistrarRegistrationId,
} from "./product-registrar-receipt";
import { PublicationId } from "./product-publication";
import { SubmissionAttemptId } from "./product-submission-attempt";
import { AnsNodeId, CapsuleId, ContentHash } from "../capsule/envelope";
import { RegistrarId } from "./product-node";

/**
 * Where a receipt came from. Deliberately three, all of which exist today.
 *
 * `WEBHOOK` and `POLLER` are absent because neither is implemented: a source
 * value naming a mechanism that does not exist would let a caller claim a
 * provenance nothing can verify.
 */
export const RECEIPT_INGESTION_SOURCES = ["MANUAL", "TRANSPORT_RESPONSE", "TEST_ADAPTER"] as const;
export const ReceiptIngestionSource = z.enum(RECEIPT_INGESTION_SOURCES);
export type ReceiptIngestionSource = z.infer<typeof ReceiptIngestionSource>;

/**
 * The externally supplied receipt.
 *
 * Every field is one a Registrar can legitimately assert. Absent by
 * construction: `lockToken`, `claimTokenHash`, `payload`, row ids, credentials,
 * and any free-form metadata bag.
 */
export const ExternalReceiptEnvelope = z.strictObject({
  receiptId: ReceiptId,
  /** The exact outbound attempt this receipt claims to answer. */
  submissionAttemptId: SubmissionAttemptId,
  publicationId: PublicationId,
  /** Required for an ACCEPTED receipt; a rejection may register nothing. */
  registrarRegistrationId: RegistrarRegistrationId.optional(),
  registrarId: RegistrarId,
  nodeId: AnsNodeId,
  capsuleId: CapsuleId,
  /** What the Registrar claims it registered. Reconciled, never trusted. */
  registeredContentHash: ContentHash,
  receiptStatus: ReceiptStatus,
  /** The Registrar's clock. */
  registeredAt: z.iso.datetime(),
  receiptDetails: ReceiptDetails,
});
export type ExternalReceiptEnvelope = z.infer<typeof ExternalReceiptEnvelope>;

/** Input to one ingestion. */
export const IngestRegistrarReceiptInput = z.strictObject({
  envelope: ExternalReceiptEnvelope,
  /** Our clock, supplied explicitly by the caller. */
  receivedAt: z.iso.datetime(),
  source: ReceiptIngestionSource,
  /**
   * The Registrar identity trusted runtime context expects, when the caller has
   * one. Checked against the attempt's IMMUTABLE registrarId — not against the
   * envelope, which would merely confirm the envelope agrees with itself.
   */
  expectedRegistrarId: RegistrarId.optional(),
});
export type IngestRegistrarReceiptInput = z.infer<typeof IngestRegistrarReceiptInput>;

/**
 * The five ways an ingestion can end.
 *
 * Acceptance and rejection are crossed with match and mismatch because they are
 * genuinely independent: a Registrar can accept something while describing a
 * different Node, and that is neither a clean acceptance nor a rejection.
 */
export const RECEIPT_INGESTION_OUTCOMES = [
  "ACCEPTED_MATCHED",
  "ACCEPTED_MISMATCH",
  "REJECTED_MATCHED",
  "REJECTED_MISMATCH",
  "IDEMPOTENT_REPLAY",
] as const;
export const ReceiptIngestionOutcome = z.enum(RECEIPT_INGESTION_OUTCOMES);
export type ReceiptIngestionOutcome = z.infer<typeof ReceiptIngestionOutcome>;

/**
 * What one ingestion did.
 *
 * Identifiers and state names only. No hash VALUE appears — `mismatchedFields`
 * names which fields disagreed, which is what an operator needs, without
 * disclosing what either side said.
 */
export const ReceiptIngestionResult = z.strictObject({
  outcome: ReceiptIngestionOutcome,
  receiptId: ReceiptId,
  submissionAttemptId: SubmissionAttemptId,
  publicationId: PublicationId,
  /** Domain state after the existing receipt service applied its rules. */
  registrationState: z.string().min(1),
  reconciliationState: z.string().min(1),
  remediationState: z.string().min(1),
  outboxStatus: z.string().min(1),
  /** WHICH fields disagreed — never the values on either side. */
  mismatchedFields: z.array(z.string().min(1)),
  payloadDisposed: z.boolean(),
});
export type ReceiptIngestionResult = z.infer<typeof ReceiptIngestionResult>;
