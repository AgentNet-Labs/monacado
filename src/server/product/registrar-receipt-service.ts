/**
 * Registrar receipt recording and reconciliation (Phase 0E.4) — one narrow,
 * fully OFFLINE operation: `recordRegistrarReceipt`.
 *
 * A receipt is EVIDENCE of what the Registrar said. Reconciliation is the
 * separate question of whether that evidence actually refers to the publication
 * we prepared. The two are never conflated: an ACCEPTED receipt that fails
 * reconciliation records a MISMATCH and does **not** mark the publication
 * registered, does **not** complete the outbox item, and does **not** dispose of
 * the capsule payload.
 *
 * Expected values (Node, capsule, content hash, all recorded at preparation) are
 * NEVER rewritten to agree with a receipt.
 *
 * No network call, no Publisher submission, no Registrar polling, no Resolver
 * lookup, no worker loop. Receipts arrive as validated input from a caller.
 */

import { Prisma } from "@prisma/client";
import type { ProductPublication as PublicationRow, PublicationOutbox as OutboxRow } from "@prisma/client";
import {
  RECEIPT_IDENTITY_FIELDS,
  ReconciliationResult,
  RegistrarReceiptInput,
  type ReconciledField,
  type ReconciliationResult as ReconciliationResultDomain,
  type RegistrarReceiptInput as ReceiptInput,
} from "../../contracts/product/product-registrar-receipt";
import type {
  ReconciliationState,
  RegistrationState,
  RemediationState,
} from "../../contracts/product/product-publication";
import {
  reconcileReceiptAgainstAttempt,
} from "../../contracts/product/product-submission-attempt";
import { getPrisma } from "../db/client";
import { outboxRowToDomain, publicationRowToDomain } from "./publication-mapper";
import { domainToReceiptCreateInput, receiptRowToDomain } from "./receipt-mapper";
import { DatabaseError, ValidationError } from "./errors";
import { PersistedOutboxContractViolationError } from "./publication-errors";
import {
  InvalidReceiptStateError,
  ReceiptConflictError,
  ReceiptPublicationNotFoundError,
  ReconciliationFailureError,
} from "./receipt-errors";
import {
  AttemptAbandonedError,
  AttemptAlreadyHasReceiptError,
  AttemptNotDispatchedError,
  ReceiptAttemptMismatchError,
  SubmissionAttemptNotFoundError,
} from "./submission-attempt-errors";

type Db = ReturnType<typeof getPrisma>;

/** The outbox state a receipt can resolve: the attempt that produced it. */
const RESOLVABLE_OUTBOX_STATUS = "PROCESSING" as const;

const iso = (d: Date): string => d.toISOString();
const instant = (value: string): string => new Date(value).toISOString();

const zodIssues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/**
 * The four state outcomes, decided purely from the receipt verdict and whether
 * reconciliation matched. This table IS the documented rule (see
 * docs/PRODUCT_REGISTRAR_RECEIPTS.md).
 */
function decideOutcome(
  receiptStatus: "ACCEPTED" | "REJECTED",
  matched: boolean,
): {
  registrationState: RegistrationState;
  reconciliationState: ReconciliationState;
  /** Whether a governed human decision is now needed, or has been settled. */
  remediationState: RemediationState;
  /** Target outbox status, or undefined to leave the outbox untouched. */
  outboxTarget?: "COMPLETED" | "DEAD_LETTER";
  disposePayload: boolean;
} {
  if (receiptStatus === "ACCEPTED" && matched) {
    return {
      registrationState: "ACCEPTED",
      reconciliationState: "MATCHED",
      // Settled — nothing left for anyone to decide.
      remediationState: "RESOLVED",
      outboxTarget: "COMPLETED",
      disposePayload: true,
    };
  }
  if (receiptStatus === "ACCEPTED") {
    // Accepted but about something else: unresolved, pending remediation. The
    // publication is NOT registered and the payload is retained as evidence.
    return {
      registrationState: "PENDING",
      reconciliationState: "MISMATCH",
      // A person must decide what to do about a receipt that names something else.
      remediationState: "REQUIRED",
      disposePayload: false,
    };
  }
  if (matched) {
    // A definitive refusal of THIS publication. Terminal for the work item; the
    // payload is retained for investigation and future remediation.
    return {
      registrationState: "REJECTED",
      reconciliationState: "MATCHED",
      // A definitive refusal needs a decision: retry, or close.
      remediationState: "REQUIRED",
      outboxTarget: "DEAD_LETTER",
      disposePayload: false,
    };
  }
  // A refusal that does not identify this publication. It is kept as immutable
  // mismatch evidence, but it CANNOT mark this publication REJECTED: the receipt
  // names another Registrar, Node, capsule, or content hash, so its verdict is
  // not about us. Registration is left unresolved (PENDING) pending remediation,
  // the work item is untouched, and the payload is retained.
  return {
    registrationState: "PENDING",
    reconciliationState: "MISMATCH",
    remediationState: "REQUIRED",
    disposePayload: false,
  };
}

export class RegistrarReceiptService {
  constructor(private readonly db: Db = getPrisma()) {}

  /**
   * Record one Registrar receipt, reconcile it against the expected publication,
   * and apply the resulting states atomically.
   */
  async recordRegistrarReceipt(input: unknown): Promise<ReconciliationResultDomain> {
    const parsed = RegistrarReceiptInput.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid Registrar receipt input", zodIssues(parsed.error));
    }
    const req = parsed.data;

    // — 1-2. Load the publication and its outbox item —
    const publicationRow = await this.db.productPublication.findUnique({
      where: { publicationId: req.publicationId },
    });
    if (!publicationRow) throw new ReceiptPublicationNotFoundError();

    const outboxRow = await this.db.publicationOutbox.findUnique({
      where: { publicationId: req.publicationId },
    });
    if (!outboxRow) {
      throw new InvalidReceiptStateError("Publication has no outbox item to reconcile");
    }

    // — Phase 0E.5.3: the receipt must name the exact attempt it answers —
    const attemptRow = await this.db.publicationSubmissionAttempt.findUnique({
      where: { submissionAttemptId: req.submissionAttemptId },
    });
    if (!attemptRow) throw new SubmissionAttemptNotFoundError();

    // — 5. Idempotent replay of an identical receipt —
    const existing = await this.db.registrarReceipt.findUnique({
      where: { receiptId: req.receiptId },
    });
    if (existing) {
      const conflicts = this.receiptConflicts(existing, req);
      if (conflicts.length > 0) {
        throw new ReceiptConflictError(
          "A receipt with this receiptId already exists with conflicting values",
          conflicts,
        );
      }
      return this.result(publicationRow, outboxRow, existing, true, []);
    }

    // The attempt must belong to this publication and work item, must actually
    // have been sent, and must not have been abandoned or already answered.
    if (
      attemptRow.publicationId !== req.publicationId ||
      attemptRow.outboxId !== outboxRow.outboxId
    ) {
      throw new ReceiptAttemptMismatchError(
        "The named submission attempt belongs to a different publication or work item",
        ["publicationId", "outboxId"],
      );
    }
    if (attemptRow.attemptStatus === "ABANDONED") throw new AttemptAbandonedError();
    if (attemptRow.attemptStatus === "RECEIPT_RECORDED") throw new AttemptAlreadyHasReceiptError();
    if (attemptRow.attemptStatus !== "DISPATCHED") {
      throw new AttemptNotDispatchedError(attemptRow.attemptStatus);
    }

    // — 6. A different receipt already carrying this registration identifier —
    if (req.registrarRegistrationId !== undefined) {
      const byRegistration = await this.db.registrarReceipt.findUnique({
        where: { registrarRegistrationId: req.registrarRegistrationId },
      });
      if (byRegistration) {
        throw new ReceiptConflictError(
          "This Registrar registration identifier is already recorded on another receipt",
          ["registrarRegistrationId"],
        );
      }
    }

    // — 4. Reconcile against the attempt's IMMUTABLE expectation —
    //
    // The attempt captured what was actually sent, at send time, and can never
    // have drifted; the publication is the same values but mutable in principle.
    // A disagreement is still a MISMATCH to be RECORDED as evidence, never a
    // hard failure — that is what keeps the Phase 0E.4 mismatch and Phase 0E.5.2
    // remediation flows reachable.
    const mismatchedFields = reconcileReceiptAgainstAttempt(attemptRow, req) as ReconciledField[];
    const matched = mismatchedFields.length === 0;
    const outcome = decideOutcome(req.receiptStatus, matched);

    // — 9. An acceptance may not overwrite a recorded rejection or mismatch —
    this.assertNoPriorVerdictConflict(publicationRow, req.receiptStatus, matched);

    // A matching acceptance resolves the claimed attempt, so the item must be
    // in the state a claim leaves it in.
    if (outcome.outboxTarget !== undefined && outboxRow.outboxStatus !== RESOLVABLE_OUTBOX_STATUS) {
      throw new InvalidReceiptStateError(
        `Outbox item must be ${RESOLVABLE_OUTBOX_STATUS} to be resolved by a receipt`,
        outboxRow.outboxStatus,
      );
    }

    // — 7-9. Record and apply, atomically —
    try {
      const { publication, outbox, receipt } = await this.db.$transaction(async (tx) => {
        const createdReceipt = await tx.registrarReceipt.create({
          // Only an acceptance that RECONCILED claims the "one accepted receipt
          // per publication" slot — see domainToReceiptCreateInput.
          data: domainToReceiptCreateInput(req, outboxRow.outboxId, matched),
        });

        const updatedPublication = await tx.productPublication.update({
          where: { publicationId: req.publicationId },
          data: {
            registrationState: outcome.registrationState,
            reconciliationState: outcome.reconciliationState,
            remediationState: outcome.remediationState,
            // publicationStatus is deliberately untouched: preparation state is
            // not a registration outcome. No REGISTERED status is introduced.
          },
        });

        let updatedOutbox = outboxRow;
        if (outcome.outboxTarget !== undefined) {
          updatedOutbox = await tx.publicationOutbox.update({
            where: { outboxId: outboxRow.outboxId },
            data: {
              outboxStatus: outcome.outboxTarget,
              lockToken: null,
              lockedAt: null,
              // Leaving PROCESSING always releases the claim lease, so a
              // receipt-completed item can never be picked up by the
              // stale-claim sweep (Phase 0E.5.1).
              leaseExpiresAt: null,
              ...(outcome.outboxTarget === "COMPLETED"
                ? { completedAt: new Date(req.receivedAt) }
                : {}),
              // Dispose of the transient capsule body ONLY on a matching
              // acceptance. payloadHash, candidateHash, publishedContentHash,
              // source pointers, and mappingVersion are all retained.
              ...(outcome.disposePayload ? { payload: Prisma.DbNull } : {}),
              ...(outcome.outboxTarget === "DEAD_LETTER"
                ? {
                    lastErrorCode: req.receiptDetails.rejectionCode ?? "REGISTRAR_REJECTED",
                    lastErrorSummary:
                      req.receiptDetails.rejectionReason ??
                      "The Registrar rejected this publication.",
                  }
                : {}),
            },
          });
        }

        // The attempt is answered — atomically, with the receipt and state.
        const answered = await tx.publicationSubmissionAttempt.updateMany({
          where: { submissionAttemptId: req.submissionAttemptId, attemptStatus: "DISPATCHED" },
          data: { attemptStatus: "RECEIPT_RECORDED" },
        });
        if (answered.count !== 1) {
          throw new AttemptAlreadyHasReceiptError(
            "The submission attempt changed concurrently and could not be answered",
          );
        }

        return { publication: updatedPublication, outbox: updatedOutbox, receipt: createdReceipt };
      });

      return this.result(publication, outbox, receipt, false, mismatchedFields);
    } catch (e) {
      throw this.mapCommitError(e);
    }
  }

  /**
   * Assert the cross-entity disposal invariant: once a publication is ACCEPTED
   * and MATCHED, the transient capsule body must exist nowhere.
   *
   * The outbox contract alone cannot check this — it permits a retained payload
   * in `COMPLETED`, because a Phase 0E.3 completion without a Registrar receipt
   * legitimately keeps its body. Only reading both rows together settles it.
   */
  async assertPayloadDisposed(publicationId: string): Promise<void> {
    const publicationRow = await this.db.productPublication.findUnique({
      where: { publicationId },
    });
    if (!publicationRow) throw new ReceiptPublicationNotFoundError();
    const outboxRow = await this.db.publicationOutbox.findUnique({ where: { publicationId } });
    if (!outboxRow) {
      throw new InvalidReceiptStateError("Publication has no outbox item");
    }
    const reconciled =
      publicationRow.registrationState === "ACCEPTED" &&
      publicationRow.reconciliationState === "MATCHED";
    if (reconciled && outboxRow.payload !== null) {
      throw new PersistedOutboxContractViolationError(
        "A reconciled publication must not retain its capsule payload",
        ["payload: retained after an accepted, matched Registrar receipt"],
      );
    }
  }

  /** Read the receipts recorded for a publication, oldest first. */
  async listRegistrarReceipts(publicationId: string) {
    const rows = await this.db.registrarReceipt.findMany({
      where: { publicationId },
      orderBy: { id: "asc" },
    });
    return rows.map(receiptRowToDomain);
  }

  // — Internals —

  /**
   * The Registrar expected to have registered this capsule: the one that issued
   * the Node binding. A publication carries no Registrar identity of its own, so
   * this is derived from the Node rather than invented.
   */
  private async expectedRegistrarId(nodeId: string): Promise<string | undefined> {
    const node = await this.db.productNode.findUnique({ where: { nodeId } });
    return node?.registrarId;
  }

  /** Fields that must agree for a repeated receiptId to be an idempotent replay. */
  private receiptConflicts(row: { [k: string]: unknown }, req: ReceiptInput): string[] {
    const rowView: Record<string, unknown> = {
      publicationId: row.publicationId,
      submissionAttemptId: (row.submissionAttemptId as string | null) ?? undefined,
      registrarRegistrationId: (row.registrarRegistrationId as string | null) ?? undefined,
      registrarId: row.registrarId,
      nodeId: row.nodeId,
      capsuleId: row.capsuleId,
      registeredContentHash: row.registeredContentHash,
      receiptStatus: row.receiptStatus,
      registeredAt: iso(row.registeredAt as Date),
    };
    const reqView: Record<string, unknown> = {
      publicationId: req.publicationId,
      submissionAttemptId: req.submissionAttemptId,
      registrarRegistrationId: req.registrarRegistrationId,
      registrarId: req.registrarId,
      nodeId: req.nodeId,
      capsuleId: req.capsuleId,
      registeredContentHash: req.registeredContentHash,
      receiptStatus: req.receiptStatus,
      registeredAt: instant(req.registeredAt),
    };
    return RECEIPT_IDENTITY_FIELDS.filter((f) => rowView[f] !== reqView[f]);
  }

  /**
   * An ACCEPTED verdict may not silently overturn an already-recorded rejection
   * or mismatch. Remediation of those is an explicit future flow, not a side
   * effect of a later receipt arriving.
   */
  private assertNoPriorVerdictConflict(
    publication: PublicationRow,
    receiptStatus: "ACCEPTED" | "REJECTED",
    matched: boolean,
  ): void {
    if (receiptStatus !== "ACCEPTED" || !matched) return;

    // A governed CLOSE decision is final in this phase. A later acceptance is
    // still recorded as evidence by the caller if they choose, but it must never
    // quietly undo the decision — reopening is an explicit future phase.
    if (publication.remediationState === "CLOSED") {
      throw new ReceiptConflictError(
        "This publication was closed by a governed remediation decision and cannot be accepted",
        ["remediationState"],
      );
    }

    // A RETRY authorisation is exactly the explicit remediation flow the two
    // guards below were waiting for: it clears the prior verdict back to PENDING
    // and permits a fresh attempt to be accepted.
    if (publication.remediationState === "RETRY_AUTHORIZED") return;

    if (publication.registrationState === "REJECTED") {
      throw new ReceiptConflictError(
        "An accepted receipt cannot overwrite a recorded rejection without an explicit remediation flow",
        ["registrationState"],
      );
    }
    if (publication.reconciliationState === "MISMATCH") {
      throw new ReceiptConflictError(
        "An accepted receipt cannot overwrite a recorded mismatch without an explicit remediation flow",
        ["reconciliationState"],
      );
    }
    if (publication.registrationState === "ACCEPTED") {
      throw new ReceiptConflictError(
        "This publication already has an accepted receipt",
        ["registrationState"],
      );
    }
  }

  private result(
    publicationRow: PublicationRow,
    outboxRow: OutboxRow,
    receiptRow: Parameters<typeof receiptRowToDomain>[0],
    alreadyRecorded: boolean,
    mismatchedFields: ReconciledField[],
  ): ReconciliationResultDomain {
    const publication = publicationRowToDomain(publicationRow);
    const outbox = outboxRowToDomain(outboxRow);
    const receipt = receiptRowToDomain(receiptRow);
    return ReconciliationResult.parse({
      publication,
      outbox,
      receipt,
      registrationState: publication.registrationState,
      reconciliationState: publication.reconciliationState,
      mismatchedFields,
      payloadDisposed: outbox.payload === undefined,
      alreadyRecorded,
    });
  }

  /**
   * Map a failed commit to a structured error. Unique-constraint violations are
   * reported as the specific conflict they are. No connection details,
   * credentials, payloads, lock tokens, or hash values are ever included.
   */
  private mapCommitError(e: unknown): Error {
    if (e instanceof ReceiptConflictError || e instanceof InvalidReceiptStateError) return e;

    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = String((e.meta as { target?: unknown } | undefined)?.target ?? "");
      if (target.includes("acceptedForPublicationId")) {
        return new ReceiptConflictError(
          "This publication already has an accepted receipt",
          ["acceptedReceipt"],
          e.code,
        );
      }
      if (target.includes("registrarRegistrationId")) {
        return new ReceiptConflictError(
          "This Registrar registration identifier is already recorded",
          ["registrarRegistrationId"],
          e.code,
        );
      }
      if (target.includes("receiptId")) {
        return new ReceiptConflictError("This receiptId is already recorded", ["receiptId"], e.code);
      }
      return new ReceiptConflictError("A conflicting receipt already exists", ["receipt"], e.code);
    }

    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      return new ReconciliationFailureError(
        "Receipt reconciliation could not be committed",
        e.code,
      );
    }
    return new DatabaseError(
      "Receipt recording failed",
      e instanceof Error ? e.message : undefined,
    );
  }
}
