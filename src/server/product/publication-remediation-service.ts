/**
 * Publication remediation (Phase 0E.5.2) — one narrow, fully OFFLINE operation:
 * `remediateProductPublication`.
 *
 * When a registration is refused, or a receipt turns out to describe something
 * else, someone has to decide what happens next. Nothing here decides that
 * automatically: this records ONE governed human decision and applies it.
 *
 * It never rewrites history. Registrar receipts stay exactly as recorded,
 * expected identifiers and hashes stay as prepared, and the capsule payload is
 * never regenerated or altered — RETRY re-authorises the SAME capsule, and no
 * replacement publication is created.
 *
 * No network call, no Publisher submission, no Registrar polling, no Resolver
 * lookup, no scheduler, no automatic remediation, and no reopening of a closed
 * decision.
 */

import { Prisma } from "@prisma/client";
import type {
  ProductPublication as PublicationRow,
  PublicationOutbox as OutboxRow,
  PublicationRemediation as RemediationRow,
} from "@prisma/client";
import {
  REMEDIATION_IDENTITY_FIELDS,
  RemediateProductPublicationInput,
  RemediationResult,
  publicationRemediationConsistencyIssues,
  requiresRemediation,
  type RemediateProductPublicationInput as RemediationInput,
  type RemediationResult as RemediationResultDomain,
} from "../../contracts/product/product-publication-remediation";
import type { RemediationState } from "../../contracts/product/product-publication";
import { getPrisma } from "../db/client";
import { outboxRowToDomain, publicationRowToDomain } from "./publication-mapper";
import { domainToRemediationCreateInput, remediationRowToDomain } from "./remediation-mapper";
import { DatabaseError, ValidationError } from "./errors";
import {
  InvalidRemediationActionError,
  PayloadUnavailableForRetryError,
  PublicationClosedError,
  PublicationRemediationError,
  PublicationResolvedError,
  PersistedRemediationContractViolationError,
  RemediationConflictError,
  RemediationNotRequiredError,
  RemediationPublicationNotFoundError,
  RemediationReplayConflictError,
  RetryTimeRequiredError,
} from "./remediation-errors";

type Db = ReturnType<typeof getPrisma>;

const iso = (d: Date): string => d.toISOString();
const instant = (value: string): string => new Date(value).toISOString();

const zodIssues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/**
 * Outbox states a CLOSE decision may terminate. A closed publication's work item
 * becomes DEAD_LETTER from any of these; COMPLETED and CANCELLED are already
 * finished and are not re-terminated.
 */
const CLOSEABLE_OUTBOX_STATUSES = ["PENDING", "PROCESSING", "RETRYABLE", "DEAD_LETTER"] as const;

export class PublicationRemediationService {
  constructor(private readonly db: Db = getPrisma()) {}

  /**
   * Record and apply one governed remediation decision for a publication whose
   * registration failed or could not be reconciled.
   */
  async remediateProductPublication(input: unknown): Promise<RemediationResultDomain> {
    // — 1. Validate input —
    const parsed = RemediateProductPublicationInput.safeParse(input);
    if (!parsed.success) throw this.inputError(parsed.error);
    const req = parsed.data;

    // — 2-3. Load the publication and its work item —
    const publicationRow = await this.db.productPublication.findUnique({
      where: { publicationId: req.publicationId },
    });
    if (!publicationRow) throw new RemediationPublicationNotFoundError();

    const outboxRow = await this.db.publicationOutbox.findUnique({
      where: { publicationId: req.publicationId },
    });
    if (!outboxRow) {
      throw new RemediationConflictError("Publication has no outbox item to remediate", ["outbox"]);
    }

    // — 4. Existing remediation history (idempotent replay?) —
    const existing = await this.db.publicationRemediation.findUnique({
      where: { remediationId: req.remediationId },
    });
    if (existing) {
      const conflicts = this.replayConflicts(existing, req);
      if (conflicts.length > 0) {
        throw new RemediationReplayConflictError(
          "A remediation with this remediationId already exists with conflicting values",
          conflicts,
        );
      }
      return this.result(publicationRow, outboxRow, existing, true);
    }

    // — 5. Confirm a decision is actually open, and permitted —
    this.assertRemediable(publicationRow, req.action);

    // — 6-8. Apply the decision transactionally —
    const applied =
      req.action === "RETRY"
        ? await this.applyRetry(req, publicationRow, outboxRow)
        : await this.applyClose(req, publicationRow, outboxRow);

    // — 9. Return validated domain objects —
    return this.result(applied.publication, applied.outbox, applied.remediation, false);
  }

  /**
   * Assert the cross-entity remediation invariants. No single row can express
   * these: they relate the publication's decision to the state of its work item
   * and whether the capsule body still exists.
   *
   *   RETRY_AUTHORIZED — the work item must be waiting to be re-claimed AND must
   *                      still hold the capsule body;
   *   CLOSED           — no claim ownership may remain;
   *   RESOLVED         — registration must say ACCEPTED/MATCHED and the transient
   *                      body must be gone.
   */
  async assertRemediationConsistency(publicationId: string): Promise<void> {
    const publicationRow = await this.db.productPublication.findUnique({
      where: { publicationId },
    });
    if (!publicationRow) throw new RemediationPublicationNotFoundError();
    const outboxRow = await this.db.publicationOutbox.findUnique({ where: { publicationId } });
    if (!outboxRow) {
      throw new RemediationConflictError("Publication has no outbox item", ["outbox"]);
    }

    const issues = publicationRemediationConsistencyIssues(
      {
        remediationState: publicationRow.remediationState,
        registrationState: publicationRow.registrationState,
        reconciliationState: publicationRow.reconciliationState,
      },
      {
        outboxStatus: outboxRow.outboxStatus,
        ...(outboxRow.payload !== null ? { payload: outboxRow.payload } : {}),
      },
    );
    if (issues.length > 0) {
      throw new PersistedRemediationContractViolationError(
        "Persisted publication and outbox state are inconsistent with the recorded remediation",
        issues,
      );
    }
  }

  /** Read the remediation history for a publication, oldest first. */
  async listPublicationRemediations(publicationId: string) {
    const rows = await this.db.publicationRemediation.findMany({
      where: { publicationId },
      orderBy: { id: "asc" },
    });
    return rows.map(remediationRowToDomain);
  }

  // — Guards —

  /**
   * A decision may be taken only while one is genuinely open. The terminal
   * states report distinctly so a caller learns WHY it was refused rather than
   * just that it was.
   */
  private assertRemediable(publication: PublicationRow, action: string): void {
    const state = publication.remediationState as RemediationState;
    if (state === "CLOSED") throw new PublicationClosedError();
    if (state === "RESOLVED") throw new PublicationResolvedError();
    if (state === "RETRY_AUTHORIZED") {
      // A retry is already outstanding. Neither a second retry nor a close may
      // pre-empt it: the publication must first come back to REQUIRED through a
      // later receipt outcome.
      throw new InvalidRemediationActionError(
        action,
        state,
        `A retry is already authorised; ${action} requires the publication to return to REQUIRED through a later receipt`,
      );
    }
    if (!requiresRemediation(state)) throw new RemediationNotRequiredError(state);
  }

  // — RETRY —

  private async applyRetry(
    req: RemediationInput,
    publicationRow: PublicationRow,
    outboxRow: OutboxRow,
  ): Promise<{ publication: PublicationRow; outbox: OutboxRow; remediation: RemediationRow }> {
    if (req.retryAvailableAt === undefined) throw new RetryTimeRequiredError();

    // There must be adverse evidence to retry against.
    const hasEvidence =
      publicationRow.registrationState === "REJECTED" ||
      publicationRow.reconciliationState === "MISMATCH";
    if (!hasEvidence) {
      throw new RemediationConflictError(
        "RETRY requires a recorded rejection or reconciliation mismatch",
        ["registrationState", "reconciliationState"],
      );
    }

    // The capsule body must still exist — this phase never regenerates it.
    if (outboxRow.payload === null) throw new PayloadUnavailableForRetryError();

    // Finished work cannot be re-authorised.
    if (outboxRow.outboxStatus === "COMPLETED") {
      throw new RemediationConflictError("A completed work item cannot be retried", ["outboxStatus"]);
    }

    // A matching acceptance already settles the question. The authoritative
    // signal is the publication's own registration state: an ACCEPTED receipt
    // that failed reconciliation is evidence about something else and must NOT
    // block the retry it exists to justify.
    if (publicationRow.registrationState === "ACCEPTED") {
      throw new RemediationConflictError(
        "A matching accepted receipt already settled this publication",
        ["registrationState"],
      );
    }

    return this.commit(req, publicationRow, outboxRow, {
      publicationData: {
        remediationState: "RETRY_AUTHORIZED",
        // The prior verdict no longer stands: a fresh attempt is authorised and
        // its outcome is not yet known.
        registrationState: "PENDING",
        reconciliationState: "PENDING",
      },
      outboxData: {
        outboxStatus: "RETRYABLE",
        availableAt: new Date(req.retryAvailableAt),
        // Release any claim ownership and the previous completion stamp.
        lockToken: null,
        lockedAt: null,
        leaseExpiresAt: null,
        completedAt: null,
        // Documented decision: the previous attempt's error metadata is CLEARED.
        // It describes an attempt that has been superseded by this authorisation,
        // and leaving it would misreport freshly-authorised work as already
        // failed. The evidence survives in the immutable receipt and in this
        // remediation record. attemptCount, payload, and payloadHash are untouched.
        lastErrorCode: null,
        lastErrorSummary: null,
      },
    });
  }

  // — CLOSE —

  private async applyClose(
    req: RemediationInput,
    publicationRow: PublicationRow,
    outboxRow: OutboxRow,
  ): Promise<{ publication: PublicationRow; outbox: OutboxRow; remediation: RemediationRow }> {
    const closeable = (CLOSEABLE_OUTBOX_STATUSES as readonly string[]).includes(
      outboxRow.outboxStatus,
    );
    if (!closeable) {
      throw new RemediationConflictError(
        `A ${outboxRow.outboxStatus} work item cannot be closed`,
        ["outboxStatus"],
      );
    }

    return this.commit(req, publicationRow, outboxRow, {
      publicationData: {
        remediationState: "CLOSED",
        // Registration and reconciliation evidence is retained exactly as it
        // stands — closing records a decision, it does not revise the verdict.
      },
      outboxData: {
        outboxStatus: "DEAD_LETTER",
        lockToken: null,
        lockedAt: null,
        leaseExpiresAt: null,
        // payload, payloadHash, attemptCount, and the previous error metadata
        // are all retained as evidence.
      },
    });
  }

  // — Commit —

  private async commit(
    req: RemediationInput,
    publicationRow: PublicationRow,
    outboxRow: OutboxRow,
    changes: {
      publicationData: Prisma.ProductPublicationUncheckedUpdateManyInput;
      outboxData: Prisma.PublicationOutboxUncheckedUpdateManyInput;
    },
  ): Promise<{ publication: PublicationRow; outbox: OutboxRow; remediation: RemediationRow }> {
    try {
      return await this.db.$transaction(async (tx) => {
        const remediation = await tx.publicationRemediation.create({
          data: domainToRemediationCreateInput({
            remediationId: req.remediationId,
            publicationId: req.publicationId,
            outboxId: outboxRow.outboxId,
            remediationAction: req.action,
            priorRegistrationState: publicationRow.registrationState as never,
            priorReconciliationState: publicationRow.reconciliationState as never,
            priorOutboxStatus: outboxRow.outboxStatus as never,
            priorRemediationState: publicationRow.remediationState as never,
            reasonCode: req.reasonCode,
            ...(req.reasonSummary !== undefined ? { reasonSummary: req.reasonSummary } : {}),
            decidedBy: req.decidedBy,
            decidedAt: req.decidedAt,
            ...(req.retryAvailableAt !== undefined
              ? { retryAvailableAt: req.retryAvailableAt }
              : {}),
          }),
        });

        // Guarded: the publication must still be in the state we decided against,
        // so a concurrent decision cannot be silently overwritten.
        const advanced = await tx.productPublication.updateMany({
          where: {
            publicationId: req.publicationId,
            remediationState: publicationRow.remediationState,
          },
          data: changes.publicationData,
        });
        if (advanced.count !== 1) {
          throw new RemediationConflictError(
            "The publication was remediated concurrently by another decision",
            ["remediationState"],
          );
        }

        await tx.publicationOutbox.updateMany({
          where: { outboxId: outboxRow.outboxId },
          data: changes.outboxData,
        });

        // A governed decision administratively replaces the claim, so any
        // unresolved submission attempt can no longer be validly answered
        // (Phase 0E.5.3). Abandoned in the same transaction — never deleted.
        await tx.publicationSubmissionAttempt.updateMany({
          where: {
            outboxId: outboxRow.outboxId,
            attemptStatus: { in: ["PREPARED", "DISPATCHED"] },
          },
          data: { attemptStatus: "ABANDONED", abandonedAt: new Date(req.decidedAt) },
        });

        const publication = await tx.productPublication.findUniqueOrThrow({
          where: { publicationId: req.publicationId },
        });
        const outbox = await tx.publicationOutbox.findUniqueOrThrow({
          where: { outboxId: outboxRow.outboxId },
        });
        return { publication, outbox, remediation };
      });
    } catch (e) {
      throw this.mapCommitError(e);
    }
  }

  // — Internals —

  /** Fields that must agree for a repeated remediationId to be an idempotent replay. */
  private replayConflicts(row: RemediationRow, req: RemediationInput): string[] {
    const rowView: Record<string, unknown> = {
      publicationId: row.publicationId,
      remediationAction: row.remediationAction,
      reasonCode: row.reasonCode,
      reasonSummary: row.reasonSummary ?? undefined,
      decidedBy: row.decidedBy,
      decidedAt: iso(row.decidedAt),
      retryAvailableAt: row.retryAvailableAt !== null ? iso(row.retryAvailableAt) : undefined,
    };
    const reqView: Record<string, unknown> = {
      publicationId: req.publicationId,
      remediationAction: req.action,
      reasonCode: req.reasonCode,
      reasonSummary: req.reasonSummary,
      decidedBy: req.decidedBy,
      decidedAt: instant(req.decidedAt),
      retryAvailableAt:
        req.retryAvailableAt !== undefined ? instant(req.retryAvailableAt) : undefined,
    };
    return REMEDIATION_IDENTITY_FIELDS.filter((f) => rowView[f] !== reqView[f]);
  }

  private result(
    publicationRow: PublicationRow,
    outboxRow: OutboxRow,
    remediationRow: RemediationRow,
    alreadyRemediated: boolean,
  ): RemediationResultDomain {
    const publication = publicationRowToDomain(publicationRow);
    return RemediationResult.parse({
      publication,
      outbox: outboxRowToDomain(outboxRow),
      remediation: remediationRowToDomain(remediationRow),
      remediationState: publication.remediationState,
      alreadyRemediated,
    });
  }

  /**
   * Map a rejected input to a structured error, separating the retry-time and
   * action failures from any other malformed field.
   */
  private inputError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): Error {
    const issues = zodIssues(error);
    if (issues.some((i) => i.startsWith("retryAvailableAt") && i.includes("RETRY requires"))) {
      return new RetryTimeRequiredError();
    }
    if (issues.some((i) => i.startsWith("action"))) {
      return new InvalidRemediationActionError("(invalid)", "(unknown)");
    }
    return new ValidationError("Invalid remediation input", issues);
  }

  /** No connection details, credentials, receipts, payloads, or hashes ever leak. */
  private mapCommitError(e: unknown): Error {
    if (e instanceof PublicationRemediationError) return e;

    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return new RemediationReplayConflictError(
        "A remediation with this remediationId already exists",
        ["remediationId"],
      );
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      return new RemediationConflictError(
        "The remediation decision could not be committed",
        ["transaction"],
        e.code,
      );
    }
    return new DatabaseError(
      "Remediation failed",
      e instanceof Error ? e.message : undefined,
    );
  }
}
