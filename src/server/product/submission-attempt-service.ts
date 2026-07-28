/**
 * Publication submission attempts (Phase 0E.5.3) — three narrow, fully OFFLINE
 * operations: prepare, dispatch, and abandon.
 *
 * A worker's `lockToken` says WHO may work on an outbox item right now. A
 * submission attempt says WHAT was sent, and is the thing a Registrar receipt
 * must name. Preparing an attempt records intent; dispatching records a future
 * transport adapter's confirmation that the request left. **Neither performs a
 * network call** — there is no HTTP client, no Publisher credential, and no
 * Registrar polling anywhere in this service.
 *
 * The raw lock token is never persisted: it is hashed one-way at the boundary,
 * so a leaked row yields no reusable credential.
 */

import { Prisma } from "@prisma/client";
import type {
  ProductPublication as PublicationRow,
  PublicationOutbox as OutboxRow,
  PublicationSubmissionAttempt as AttemptRow,
} from "@prisma/client";
import {
  ABANDONABLE_ATTEMPT_STATUSES,
  ATTEMPT_IDENTITY_FIELDS,
  AbandonSubmissionAttemptInput,
  DispatchSubmissionAttemptInput,
  PrepareSubmissionAttemptInput,
  PublicationSubmissionAttemptWrite,
  SubmissionAttemptPreparationResult,
  isAllowedAttemptTransition,
  type PrepareSubmissionAttemptInput as PrepareInput,
  type SubmissionAttemptPreparationResult as PreparationResult,
  type SubmissionAttemptStatus,
} from "../../contracts/product/product-submission-attempt";
import { tokenBindingHash } from "../../contracts/integrity/hash";
import { getPrisma } from "../db/client";
import { attemptRowToDomain, domainToAttemptCreateInput } from "./submission-attempt-mapper";
import { DatabaseError, ValidationError } from "./errors";
import {
  AttemptAlreadyExistsForClaimError,
  AttemptReplayConflictError,
  ClaimLeaseExpiredError,
  ClaimNoLongerOwnedError,
  ClaimTokenHashMismatchError,
  InvalidAttemptTransitionError,
  SubmissionAttemptError,
  SubmissionAttemptNotFoundError,
} from "./submission-attempt-errors";
import { PublicationClosedError, PublicationResolvedError } from "./remediation-errors";

type Db = ReturnType<typeof getPrisma>;

/** The only outbox state that can own a live submission attempt. */
const CLAIMED_STATUS = "PROCESSING" as const;

/** The only operation submitted in this phase. */
const OPERATION = "REGISTER" as const;

const iso = (d: Date): string => d.toISOString();
const instant = (value: string): string => new Date(value).toISOString();

const zodIssues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export class PublicationSubmissionAttemptService {
  constructor(private readonly db: Db = getPrisma()) {}

  /**
   * Prepare one immutable attempt against a live claim, binding it to exactly
   * what will be sent: this outbox `attemptCount`, the REGISTER operation, the
   * expected Registrar, Node, capsule, published content hash, and payload hash.
   *
   * Returns the attempt together with the ALREADY-PERSISTED payload a future
   * transport layer will send. The payload is handed over, never regenerated
   * and never altered.
   */
  async preparePublicationSubmissionAttempt(input: unknown): Promise<PreparationResult> {
    const parsed = PrepareSubmissionAttemptInput.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid submission-attempt preparation input", zodIssues(parsed.error));
    }
    const req = parsed.data;
    const claimTokenHash = tokenBindingHash(req.lockToken);

    // — Load publication, work item, and Node —
    const publicationRow = await this.db.productPublication.findUnique({
      where: { publicationId: req.publicationId },
    });
    if (!publicationRow) throw new SubmissionAttemptNotFoundError("Publication not found");

    const outboxRow = await this.db.publicationOutbox.findUnique({
      where: { outboxId: req.outboxId },
    });
    if (!outboxRow) throw new SubmissionAttemptNotFoundError("Outbox item not found");
    if (outboxRow.publicationId !== req.publicationId) {
      throw new ClaimNoLongerOwnedError("The outbox item belongs to a different publication");
    }

    // — Idempotent replay of an identical preparation —
    const existing = await this.db.publicationSubmissionAttempt.findUnique({
      where: { submissionAttemptId: req.submissionAttemptId },
    });
    if (existing) {
      const conflicts = this.replayConflicts(existing, req, outboxRow, publicationRow, claimTokenHash);
      if (conflicts.length > 0) {
        throw new AttemptReplayConflictError(
          "A submission attempt with this id already exists with conflicting values",
          conflicts,
        );
      }
      return this.preparationResult(existing, outboxRow, true);
    }

    // — A settled publication has nothing left to submit —
    if (publicationRow.remediationState === "CLOSED") throw new PublicationClosedError();
    if (
      publicationRow.remediationState === "RESOLVED" ||
      publicationRow.registrationState === "ACCEPTED"
    ) {
      throw new PublicationResolvedError();
    }

    // — The claim must be live, owned, and unexpired —
    this.assertLiveClaim(outboxRow, req.lockToken, req.preparedAt);

    // — The capsule body must still exist to be sent —
    if (outboxRow.payload === null) {
      throw new ClaimNoLongerOwnedError("The capsule payload is no longer retained");
    }

    // The Registrar expected to answer is the one that issued the Node binding.
    const nodeRow = await this.db.productNode.findUnique({ where: { nodeId: publicationRow.nodeId } });
    if (!nodeRow) throw new SubmissionAttemptNotFoundError("Product Node not found");

    const write = PublicationSubmissionAttemptWrite.parse({
      submissionAttemptId: req.submissionAttemptId,
      publicationId: req.publicationId,
      outboxId: req.outboxId,
      // Bound to THIS claim: one attempt per outbox attemptCount.
      attemptNumber: outboxRow.attemptCount,
      operation: OPERATION,
      nodeId: publicationRow.nodeId,
      capsuleId: publicationRow.capsuleId,
      registrarId: nodeRow.registrarId,
      expectedContentHash: publicationRow.publishedContentHash,
      payloadHash: outboxRow.payloadHash,
      claimTokenHash,
      attemptStatus: "PREPARED",
      preparedAt: req.preparedAt,
    } satisfies PublicationSubmissionAttemptWrite);

    try {
      const created = await this.db.publicationSubmissionAttempt.create({
        data: domainToAttemptCreateInput(write),
      });
      return this.preparationResult(created, outboxRow, false);
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  /**
   * Record that a transport adapter sent the request. Still no network call —
   * this is the adapter reporting back, so the attempt can be answered.
   */
  async markPublicationSubmissionAttemptDispatched(input: unknown) {
    const parsed = DispatchSubmissionAttemptInput.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid dispatch input", zodIssues(parsed.error));
    }
    const req = parsed.data;

    const attemptRow = await this.requireAttempt(req.submissionAttemptId);
    if (attemptRow.claimTokenHash !== tokenBindingHash(req.lockToken)) {
      throw new ClaimTokenHashMismatchError();
    }

    // Identical replay is a no-op; a different dispatch time is a conflict.
    if (attemptRow.attemptStatus === "DISPATCHED") {
      if (
        attemptRow.dispatchedAt !== null &&
        iso(attemptRow.dispatchedAt) === instant(req.dispatchedAt)
      ) {
        return attemptRowToDomain(attemptRow);
      }
      throw new AttemptReplayConflictError(
        "This attempt was already dispatched at a different time",
        ["dispatchedAt"],
      );
    }

    this.assertTransition(attemptRow.attemptStatus, "DISPATCHED");
    if (Date.parse(req.dispatchedAt) < attemptRow.preparedAt.getTime()) {
      throw new AttemptReplayConflictError("dispatchedAt precedes preparedAt", ["dispatchedAt"]);
    }

    // The claim must still be live and owned at dispatch time.
    const outboxRow = await this.db.publicationOutbox.findUnique({
      where: { outboxId: attemptRow.outboxId },
    });
    if (!outboxRow) throw new SubmissionAttemptNotFoundError("Outbox item not found");
    this.assertLiveClaim(outboxRow, req.lockToken, req.dispatchedAt);

    const updated = await this.guardedTransition(
      { submissionAttemptId: req.submissionAttemptId, attemptStatus: "PREPARED" },
      { attemptStatus: "DISPATCHED", dispatchedAt: new Date(req.dispatchedAt) },
      req.submissionAttemptId,
    );
    return updated;
  }

  /**
   * Abandon an attempt whose claim can no longer validly resolve it — the lease
   * expired, or a governed decision replaced the claim. Nothing is deleted and
   * the identifier is never reused; a retry prepares a NEW attempt under a later
   * outbox `attemptNumber`.
   *
   * Never invoked by a scheduler: callers, stale-claim recovery, and remediation
   * drive it explicitly.
   */
  async markPublicationSubmissionAttemptAbandoned(input: unknown) {
    const parsed = AbandonSubmissionAttemptInput.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid abandonment input", zodIssues(parsed.error));
    }
    const req = parsed.data;

    const attemptRow = await this.requireAttempt(req.submissionAttemptId);
    // Identical replay is a no-op.
    if (attemptRow.attemptStatus === "ABANDONED") return attemptRowToDomain(attemptRow);
    this.assertTransition(attemptRow.attemptStatus, "ABANDONED");

    return this.guardedTransition(
      {
        submissionAttemptId: req.submissionAttemptId,
        attemptStatus: { in: [...ABANDONABLE_ATTEMPT_STATUSES] },
      },
      { attemptStatus: "ABANDONED", abandonedAt: new Date(req.abandonedAt) },
      req.submissionAttemptId,
    );
  }

  /** Read one attempt as a validated domain object. */
  async getPublicationSubmissionAttempt(submissionAttemptId: string) {
    return attemptRowToDomain(await this.requireAttempt(submissionAttemptId));
  }

  /** Read the attempt history for a publication, oldest first. */
  async listPublicationSubmissionAttempts(publicationId: string) {
    const rows = await this.db.publicationSubmissionAttempt.findMany({
      where: { publicationId },
      orderBy: { id: "asc" },
    });
    return rows.map(attemptRowToDomain);
  }

  // — Internals —

  private async requireAttempt(submissionAttemptId: string): Promise<AttemptRow> {
    const row = await this.db.publicationSubmissionAttempt.findUnique({
      where: { submissionAttemptId },
    });
    if (!row) throw new SubmissionAttemptNotFoundError();
    return row;
  }

  private assertTransition(from: string, to: SubmissionAttemptStatus): void {
    if (!isAllowedAttemptTransition(from as SubmissionAttemptStatus, to)) {
      throw new InvalidAttemptTransitionError(from, to);
    }
  }

  /** The work item must be claimed, by this token, with an unexpired lease. */
  private assertLiveClaim(outboxRow: OutboxRow, lockToken: string, at: string): void {
    if (outboxRow.outboxStatus !== CLAIMED_STATUS) {
      throw new ClaimNoLongerOwnedError(
        `The outbox item must be ${CLAIMED_STATUS} to submit`,
        outboxRow.outboxStatus,
      );
    }
    if (outboxRow.lockToken !== lockToken) throw new ClaimNoLongerOwnedError();
    if (outboxRow.leaseExpiresAt === null || outboxRow.leaseExpiresAt.getTime() <= Date.parse(at)) {
      throw new ClaimLeaseExpiredError();
    }
  }

  /** A guarded update re-asserting the status we decided against. */
  private async guardedTransition(
    where: Prisma.PublicationSubmissionAttemptWhereInput,
    data: Prisma.PublicationSubmissionAttemptUncheckedUpdateManyInput,
    submissionAttemptId: string,
  ) {
    try {
      const res = await this.db.publicationSubmissionAttempt.updateMany({ where, data });
      if (res.count !== 1) {
        throw new InvalidAttemptTransitionError(
          "(changed)",
          String(data.attemptStatus ?? "(unknown)"),
          "The attempt changed concurrently and the transition was refused",
        );
      }
      return attemptRowToDomain(await this.requireAttempt(submissionAttemptId));
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  /** Fields that must agree for a repeated attempt id to be an idempotent replay. */
  private replayConflicts(
    row: AttemptRow,
    req: PrepareInput,
    outboxRow: OutboxRow,
    publicationRow: PublicationRow,
    claimTokenHash: string,
  ): string[] {
    const rowView: Record<string, unknown> = {
      publicationId: row.publicationId,
      outboxId: row.outboxId,
      attemptNumber: row.attemptNumber,
      operation: row.operation,
      nodeId: row.nodeId,
      capsuleId: row.capsuleId,
      registrarId: row.registrarId,
      expectedContentHash: row.expectedContentHash,
      payloadHash: row.payloadHash,
      claimTokenHash: row.claimTokenHash,
      preparedAt: iso(row.preparedAt),
    };
    const reqView: Record<string, unknown> = {
      publicationId: req.publicationId,
      outboxId: req.outboxId,
      attemptNumber: outboxRow.attemptCount,
      operation: OPERATION,
      nodeId: publicationRow.nodeId,
      capsuleId: publicationRow.capsuleId,
      // The Registrar is derived, so a replay compares what the row recorded.
      registrarId: row.registrarId,
      expectedContentHash: publicationRow.publishedContentHash,
      payloadHash: outboxRow.payloadHash,
      claimTokenHash,
      preparedAt: instant(req.preparedAt),
    };
    return ATTEMPT_IDENTITY_FIELDS.filter((f) => rowView[f] !== reqView[f]);
  }

  private preparationResult(
    attemptRow: AttemptRow,
    outboxRow: OutboxRow,
    alreadyPrepared: boolean,
  ): PreparationResult {
    return SubmissionAttemptPreparationResult.parse({
      attempt: attemptRowToDomain(attemptRow),
      // Handed over as persisted — never regenerated, never altered.
      payload: outboxRow.payload ?? undefined,
      alreadyPrepared,
    });
  }

  /** No token, hash value, payload, receipt, credential, or Prisma text leaks. */
  private mapWriteError(e: unknown): Error {
    if (e instanceof SubmissionAttemptError) return e;

    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = String((e.meta as { target?: unknown } | undefined)?.target ?? "");
      if (target.includes("attemptNumber") || target.includes("outboxId")) {
        return new AttemptAlreadyExistsForClaimError();
      }
      return new AttemptReplayConflictError("A conflicting submission attempt already exists", [
        "submissionAttemptId",
      ]);
    }
    return new DatabaseError(
      "Submission attempt operation failed",
      e instanceof Error ? e.message : undefined,
    );
  }
}
