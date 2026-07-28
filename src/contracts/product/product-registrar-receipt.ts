/**
 * Registrar receipt and reconciliation contracts (Phase 0E.4).
 *
 * A **receipt** is the immutable record of what the Registrar said about one
 * publication. **Reconciliation** is the separate question of whether that
 * receipt actually refers to the publication we expected — matching Registrar,
 * Node, capsule, and content hash.
 *
 * The two are deliberately distinct: a receipt can say ACCEPTED and still fail
 * reconciliation, and such a receipt must never mark a publication registered.
 * Expected values are recorded once at preparation and are **never rewritten**
 * to agree with a receipt.
 *
 * This phase is OFFLINE. Receipts arrive as validated input from a caller; there
 * is no live Registrar call, no Publisher submission, and no Resolver lookup.
 *
 * Zod is the single authored source of truth; types are inferred. No passthrough,
 * `any`, or unrestricted JSON — `ReceiptDetails` is a narrow closed structure.
 */

import { z } from "zod";
import { AnsNodeId, CapsuleId, ContentHash } from "../capsule/envelope";
import { RECEIPT_ID_RE } from "../capsule/identity";
import { RegistrarId } from "./product-node";
import {
  PublicationId,
  ProductPublication,
  ProductPublicationOutbox,
  RegistrationState,
  ReconciliationState,
} from "./product-publication";
import { SafeErrorCode, SafeErrorSummary } from "./safe-error-metadata";
import { SubmissionAttemptId } from "./product-submission-attempt";

/** Opaque internal identifier for one recorded receipt. */
export const ReceiptId = z
  .string()
  .regex(RECEIPT_ID_RE, "receiptId must be opaque (mon:rcpt:<opaque>)");

/**
 * The Registrar's OWN registration identifier for the registered capsule. It is
 * issued by an external system, so it is bounded rather than opaque-formatted —
 * but it is never used as a Node ID, capsule ID, or Monacado identity.
 */
export const RegistrarRegistrationId = z.string().min(1).max(191);

/** Bounded receipt verdict. No submission/pending/partial states in this phase. */
export const RECEIPT_STATUSES = ["ACCEPTED", "REJECTED"] as const;
export const ReceiptStatus = z.enum(RECEIPT_STATUSES);
export type ReceiptStatus = z.infer<typeof ReceiptStatus>;

/**
 * Narrow, closed receipt detail structure — explicitly NOT a metadata bag.
 * Free-text fields reuse the Phase 0E.3 safe-metadata contracts, so credentials,
 * connection strings, integrity hashes, and capsule content are refused at the
 * boundary. The capsule body is never stored on a receipt.
 */
export const ReceiptDetails = z.strictObject({
  /** Registrar's own status/result code, e.g. `REGISTERED` or `POLICY_REFUSED`. */
  registrarStatusCode: SafeErrorCode.optional(),
  /** Machine-readable rejection code (REJECTED receipts). */
  rejectionCode: SafeErrorCode.optional(),
  /** Short, bounded, human-readable rejection reason (REJECTED receipts). */
  rejectionReason: SafeErrorSummary.optional(),
  /** Policy the Registrar evaluated against (structural linkage only). */
  registrarPolicyRef: z.string().min(1).max(191).optional(),
  registrarPolicyVersion: z.string().min(1).max(64).optional(),
});
export type ReceiptDetails = z.infer<typeof ReceiptDetails>;

// — Receipt input —

const ReceiptCoreFields = {
  receiptId: ReceiptId,
  publicationId: PublicationId,
  /**
   * The exact outbound attempt this receipt answers (Phase 0E.5.3). Required for
   * every receipt recorded through the service; only historical rows predating
   * that phase may lack one.
   */
  submissionAttemptId: SubmissionAttemptId,
  /**
   * Optional because a REJECTED receipt may carry no registration identifier —
   * nothing was registered. Required for ACCEPTED (refined below).
   */
  registrarRegistrationId: RegistrarRegistrationId.optional(),
  registrarId: RegistrarId,
  nodeId: AnsNodeId,
  capsuleId: CapsuleId,
  /** The content hash the Registrar reports having registered. */
  registeredContentHash: ContentHash,
  receiptStatus: ReceiptStatus,
  /** When the Registrar registered it (its clock). */
  registeredAt: z.iso.datetime(),
  /** When Monacado received the receipt (our clock, supplied explicitly). */
  receivedAt: z.iso.datetime(),
  receiptDetails: ReceiptDetails,
} as const;

const requireRegistrationIdForAccepted = (
  value: { receiptStatus: ReceiptStatus; registrarRegistrationId?: string },
  ctx: z.RefinementCtx,
): void => {
  if (value.receiptStatus === "ACCEPTED" && value.registrarRegistrationId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["registrarRegistrationId"],
      message: "an ACCEPTED receipt must carry the Registrar's registration identifier",
    });
  }
};

export const RegistrarReceiptInput = z
  .strictObject(ReceiptCoreFields)
  .superRefine(requireRegistrationIdForAccepted);
export type RegistrarReceiptInput = z.infer<typeof RegistrarReceiptInput>;

// — Persisted receipt —

/**
 * A validated, persisted Registrar receipt. Immutable once written: there is no
 * update operation, and the row carries no `updatedAt`.
 */
export const RegistrarReceipt = z
  .strictObject({
    id: z.string().min(1),
    ...ReceiptCoreFields,
    /**
     * Historical receipts recorded before Phase 0E.5.3 carry no attempt binding.
     * They stay READABLE, but the service can never create another like them.
     */
    submissionAttemptId: SubmissionAttemptId.optional(),
    createdAt: z.iso.datetime(),
  })
  .superRefine(requireRegistrationIdForAccepted);
export type RegistrarReceipt = z.infer<typeof RegistrarReceipt>;

/** The validated receipt before persistence assigns the row id and timestamp. */
export const RegistrarReceiptWrite = z
  .strictObject(ReceiptCoreFields)
  .superRefine(requireRegistrationIdForAccepted);
export type RegistrarReceiptWrite = z.infer<typeof RegistrarReceiptWrite>;

// — Reconciliation —

/**
 * The fields compared between a receipt and its publication. A receipt matches
 * only when ALL of them agree; any disagreement is a MISMATCH.
 */
export const RECONCILED_FIELDS = [
  "registrarId",
  "nodeId",
  "capsuleId",
  "registeredContentHash",
] as const;
export type ReconciledField = (typeof RECONCILED_FIELDS)[number];
export const ReconciledField = z.enum(RECONCILED_FIELDS);

/**
 * The outcome of recording one receipt: the resulting publication and outbox
 * state, the immutably recorded receipt, and — on failure to reconcile — which
 * fields disagreed. Only field NAMES are reported, never the compared values
 * (which include content hashes).
 */
export const ReconciliationResult = z.strictObject({
  publication: ProductPublication,
  outbox: ProductPublicationOutbox,
  receipt: RegistrarReceipt,
  registrationState: RegistrationState,
  reconciliationState: ReconciliationState,
  /** Names of the fields that disagreed. Empty when reconciliation MATCHED. */
  mismatchedFields: z.array(ReconciledField),
  /** True when the transient capsule payload was disposed of by this call. */
  payloadDisposed: z.boolean(),
  /** True when this call returned an existing identical receipt (idempotent replay). */
  alreadyRecorded: z.boolean(),
});
export type ReconciliationResult = z.infer<typeof ReconciliationResult>;

/**
 * Compare a receipt against the publication it claims to describe. Pure: it
 * reads both sides and reports disagreement without mutating anything.
 */
export function reconcileReceiptFields(
  expected: {
    registrarId?: string;
    nodeId: string;
    capsuleId: string;
    publishedContentHash: string;
  },
  receipt: {
    registrarId: string;
    nodeId: string;
    capsuleId: string;
    registeredContentHash: string;
  },
): ReconciledField[] {
  const mismatched: ReconciledField[] = [];
  // `expected.registrarId` comes from the Node that issued this publication's
  // Node binding; a publication carries no Registrar identity of its own.
  if (expected.registrarId !== undefined && expected.registrarId !== receipt.registrarId) {
    mismatched.push("registrarId");
  }
  if (expected.nodeId !== receipt.nodeId) mismatched.push("nodeId");
  if (expected.capsuleId !== receipt.capsuleId) mismatched.push("capsuleId");
  if (expected.publishedContentHash !== receipt.registeredContentHash) {
    mismatched.push("registeredContentHash");
  }
  return mismatched;
}

/**
 * Receipt fields that must agree for a repeated receipt to be an idempotent
 * replay rather than a conflict.
 */
export const RECEIPT_IDENTITY_FIELDS = [
  "publicationId",
  "submissionAttemptId",
  "registrarRegistrationId",
  "registrarId",
  "nodeId",
  "capsuleId",
  "registeredContentHash",
  "receiptStatus",
  "registeredAt",
] as const;
export type ReceiptIdentityField = (typeof RECEIPT_IDENTITY_FIELDS)[number];
