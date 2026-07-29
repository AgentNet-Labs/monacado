/**
 * Registrar receipt ingestion (Phase 0E.6.4) — SERVER ONLY.
 *
 * `ingestRegistrarReceipt` is the one narrow door through which a receipt
 * obtained elsewhere enters the system. It validates the envelope, checks the
 * one thing the envelope cannot check about itself, and hands the result to the
 * existing Phase 0E.4 receipt service.
 *
 * **It owns no domain rules.** Reconciliation, state transitions, remediation,
 * payload disposal, and idempotency all live in `recordRegistrarReceipt` and are
 * invoked exactly once. This module writes to no table. If the rules ever change
 * there is one place to change them, and an ingestion path that quietly diverged
 * from the receipt service would be the worst possible bug in this area — two
 * doors into the same state with different opinions about what is true.
 *
 * Deliberately absent: any network call, credential lookup, endpoint lookup, or
 * `process.env` read. A receipt arrives as data; nothing is fetched.
 *
 * **Trust boundary.** Callers are assumed already trusted. Authentication,
 * authorisation, and webhook signature verification are NOT implemented and are
 * documented as deferred — this must not be exposed to an untrusted caller as
 * it stands.
 */

import "../server-only";
import type { getPrisma } from "../db/client";
import { getPrisma as prisma } from "../db/client";
import {
  IngestRegistrarReceiptInput,
  ReceiptIngestionResult,
  type ReceiptIngestionOutcome,
  type ReceiptIngestionResult as IngestionResult,
} from "../../contracts/product/receipt-ingestion";
import { RegistrarReceiptService } from "./registrar-receipt-service";
import {
  ExpectedRegistrarMismatchError,
  InvalidReceiptEnvelopeError,
} from "./receipt-ingestion-errors";

type Db = ReturnType<typeof getPrisma>;

export interface IngestRegistrarReceiptDeps {
  db?: Db;
  /** Injectable so a test can assert the delegate is called exactly once. */
  receipts?: RegistrarReceiptService;
}

/**
 * Map the receipt service's reconciliation result onto one bounded outcome.
 *
 * An idempotent replay wins over everything: re-reporting `ACCEPTED_MATCHED`
 * would tell a caller its call caused a transition, when in fact the state was
 * already there and nothing happened.
 */
function classify(result: {
  alreadyRecorded: boolean;
  receiptStatus: string;
  reconciliationState: string;
}): ReceiptIngestionOutcome {
  if (result.alreadyRecorded) return "IDEMPOTENT_REPLAY";
  const matched = result.reconciliationState === "MATCHED";
  if (result.receiptStatus === "ACCEPTED") {
    return matched ? "ACCEPTED_MATCHED" : "ACCEPTED_MISMATCH";
  }
  return matched ? "REJECTED_MATCHED" : "REJECTED_MISMATCH";
}

/**
 * Ingest exactly one externally obtained Registrar receipt.
 *
 * The attempt guards this phase requires — the attempt exists, is DISPATCHED,
 * is not ABANDONED, has no conflicting authoritative receipt, and binds to the
 * named publication and outbox — are all enforced inside `recordRegistrarReceipt`
 * and are therefore NOT repeated here. Delegating rather than duplicating is the
 * point: two implementations of the same guard eventually disagree.
 */
export async function ingestRegistrarReceipt(
  input: unknown,
  deps: IngestRegistrarReceiptDeps = {},
): Promise<IngestionResult> {
  const parsed = IngestRegistrarReceiptInput.safeParse(input);
  if (!parsed.success) {
    // Paths only. A rejected envelope may contain exactly the material we must
    // not write down.
    throw new InvalidReceiptEnvelopeError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const req = parsed.data;
  const db = deps.db ?? prisma();
  const receipts = deps.receipts ?? new RegistrarReceiptService(db);

  // — The one check the receipt service cannot make —
  //
  // It reconciles a receipt against the publication and the attempt. It has no
  // notion of which Registrar this deployment is currently configured to talk
  // to, so a caller holding that context supplies it here. Compared against the
  // ATTEMPT's immutable registrarId: comparing against the envelope would prove
  // only that a forged envelope is self-consistent.
  if (req.expectedRegistrarId !== undefined) {
    const attemptRow = await db.publicationSubmissionAttempt.findUnique({
      where: { submissionAttemptId: req.envelope.submissionAttemptId },
      select: { registrarId: true },
    });
    // A missing attempt is not diagnosed here — the receipt service reports it
    // precisely, and guessing at it would duplicate that vocabulary.
    if (attemptRow !== null && attemptRow.registrarId !== req.expectedRegistrarId) {
      throw new ExpectedRegistrarMismatchError();
    }
  }

  // — Exactly one delegation. Every authoritative mutation happens in there. —
  const recorded = await receipts.recordRegistrarReceipt({
    receiptId: req.envelope.receiptId,
    publicationId: req.envelope.publicationId,
    submissionAttemptId: req.envelope.submissionAttemptId,
    ...(req.envelope.registrarRegistrationId !== undefined
      ? { registrarRegistrationId: req.envelope.registrarRegistrationId }
      : {}),
    registrarId: req.envelope.registrarId,
    nodeId: req.envelope.nodeId,
    capsuleId: req.envelope.capsuleId,
    registeredContentHash: req.envelope.registeredContentHash,
    receiptStatus: req.envelope.receiptStatus,
    registeredAt: req.envelope.registeredAt,
    receivedAt: req.receivedAt,
    receiptDetails: req.envelope.receiptDetails,
  });

  return ReceiptIngestionResult.parse({
    outcome: classify({
      alreadyRecorded: recorded.alreadyRecorded,
      receiptStatus: recorded.receipt.receiptStatus,
      reconciliationState: recorded.reconciliationState,
    }),
    receiptId: recorded.receipt.receiptId,
    submissionAttemptId: req.envelope.submissionAttemptId,
    publicationId: recorded.publication.publicationId,
    registrationState: recorded.registrationState,
    reconciliationState: recorded.reconciliationState,
    remediationState: recorded.publication.remediationState,
    outboxStatus: recorded.outbox.outboxStatus,
    // Field NAMES only — never what either side actually said.
    mismatchedFields: recorded.mismatchedFields,
    payloadDisposed: recorded.payloadDisposed,
  });
}
