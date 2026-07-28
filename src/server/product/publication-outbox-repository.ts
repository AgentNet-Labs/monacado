/**
 * Publication-outbox processing repository (Phase 0E.3) — worker-facing state
 * transitions and concurrency control, fully OFFLINE.
 *
 * It decides WHICH item a worker may work on and records WHAT happened. It does
 * NOT submit anything: no network call, no Publisher submission, no Registrar
 * processing, no receipt, no reconciliation, and no payload disposal. There is
 * deliberately no loop and no scheduled polling — a caller claims exactly one
 * item per call and drives its own cadence.
 *
 * Concurrency rests on GUARDED UPDATES (compare-and-set), not on read-then-write:
 * every state change is an `updateMany` whose WHERE clause re-asserts the
 * precondition it depends on, so a row that changed underneath us matches zero
 * rows and the caller is told, rather than silently overwriting another worker.
 *
 * Lease expiry and lock stealing are DEFERRED: a claim held by a crashed worker
 * stays held in this phase. See docs/PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md.
 */

import { randomBytes } from "node:crypto";
import type { PublicationOutbox as OutboxRow, Prisma } from "@prisma/client";
import {
  CLAIMABLE_OUTBOX_STATUSES,
  CancelOutboxInput,
  ClaimOutboxInput,
  CompleteOutboxInput,
  DeadLetterOutboxInput,
  LEASE_EXPIRED_ERROR_CODE,
  LEASE_EXPIRED_ERROR_SUMMARY,
  PublicationOutboxClaim,
  RecoverExpiredClaimsInput,
  RetryOutboxInput,
  StaleClaimRecoveryResult,
  isAllowedOutboxTransition,
  resolveLeaseExpiry,
  type PublicationOutboxClaim as Claim,
  type StaleClaimRecoveryResult as RecoveryResult,
} from "../../contracts/product/product-publication-outbox";
import type {
  OutboxStatus,
  ProductPublicationOutbox as OutboxDomain,
} from "../../contracts/product/product-publication";
import { CROCKFORD_ALPHABET, makeLockToken } from "../../contracts/capsule/identity";
import { getPrisma } from "../db/client";
import { outboxRowToDomain } from "./publication-mapper";
import { DatabaseError, ValidationError } from "./errors";
import {
  InvalidLeaseDurationError,
  InvalidLeaseExpiryError,
  InvalidOutboxTransitionError,
  NoEligibleOutboxItemError,
  OutboxClaimConflictError,
  OutboxLockTokenMismatchError,
  OutboxNotFoundError,
  StaleClaimError,
  UnsafeErrorMetadataError,
} from "./outbox-errors";

type Db = ReturnType<typeof getPrisma>;

/** The only operation type processed in this phase. */
const OPERATION_TYPE = "REGISTER" as const;

/** Statuses a due item may be claimed from (mutable copy for Prisma's `in`). */
const CLAIMABLE: OutboxStatus[] = [...CLAIMABLE_OUTBOX_STATUSES];

const zodIssues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/** Generate a fresh opaque lock token (26 Crockford chars from CSPRNG bytes). */
function generateLockToken(): string {
  const bytes = randomBytes(26);
  let body = "";
  for (let i = 0; i < 26; i += 1) {
    body += CROCKFORD_ALPHABET[bytes[i]! % 32];
  }
  return makeLockToken(body);
}

export class PublicationOutboxRepository {
  constructor(private readonly db: Db = getPrisma()) {}

  /**
   * Claim the next eligible item and transition it to PROCESSING.
   *
   * Eligibility: status PENDING or RETRYABLE, and `availableAt <= now`.
   * Ordering: `availableAt` ascending, then creation order (`id`) — fully
   * deterministic, so two callers see the same next item.
   *
   * The claim itself is a single guarded UPDATE that re-asserts eligibility and
   * that the row is still unclaimed. Of two concurrent claimers, exactly one
   * matches a row; the other is told the item was taken. No loop is attempted.
   */
  async claimNextPublicationOutbox(input: unknown): Promise<Claim> {
    const parsed = ClaimOutboxInput.safeParse(input);
    if (!parsed.success) throw this.claimInputError(parsed.error);
    const now = new Date(parsed.data.now);

    // The lease is computed HERE, from explicitly supplied inputs — the
    // repository never reads a clock.
    const leaseExpiresAt = new Date(resolveLeaseExpiry(parsed.data));
    if (leaseExpiresAt.getTime() <= now.getTime()) {
      throw new InvalidLeaseExpiryError("The claim lease must expire after it is taken", [
        "leaseExpiresAt: must be strictly later than lockedAt",
      ]);
    }

    // Deterministic selection of the next candidate.
    const candidate = await this.db.publicationOutbox.findFirst({
      where: {
        operationType: OPERATION_TYPE,
        outboxStatus: { in: CLAIMABLE },
        availableAt: { lte: now },
      },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!candidate) throw new NoEligibleOutboxItemError();

    const lockToken = generateLockToken();

    // Guarded transition: the WHERE clause re-asserts every precondition, so a
    // row claimed by another worker in the meantime matches zero rows.
    let claimed: Prisma.BatchPayload;
    try {
      claimed = await this.db.publicationOutbox.updateMany({
        where: {
          id: candidate.id,
          outboxStatus: { in: CLAIMABLE },
          availableAt: { lte: now },
          lockToken: null,
        },
        data: {
          outboxStatus: "PROCESSING",
          lockToken,
          lockedAt: now,
          leaseExpiresAt,
          attemptCount: { increment: 1 },
        },
      });
    } catch (e) {
      throw new DatabaseError("Outbox claim failed", e instanceof Error ? e.message : undefined);
    }
    if (claimed.count !== 1) throw new OutboxClaimConflictError();

    // lockToken is unique and freshly generated, so this is unambiguously ours.
    const row = await this.db.publicationOutbox.findUnique({ where: { lockToken } });
    if (!row) throw new OutboxClaimConflictError();

    return PublicationOutboxClaim.parse({
      outbox: outboxRowToDomain(row),
      lockToken,
    } satisfies Claim);
  }

  /** PROCESSING → RETRYABLE. Reschedules the item and records why it failed. */
  async markPublicationOutboxRetryable(input: unknown): Promise<OutboxDomain> {
    const parsed = RetryOutboxInput.safeParse(input);
    if (!parsed.success) throw this.inputError("Invalid retry input", parsed.error);
    const req = parsed.data;

    return this.resolveClaim(req.outboxId, req.lockToken, "RETRYABLE", {
      outboxStatus: "RETRYABLE",
      lockToken: null,
      lockedAt: null,
      leaseExpiresAt: null,
      availableAt: new Date(req.availableAt),
      lastErrorCode: req.errorCode,
      lastErrorSummary: req.errorSummary,
    });
  }

  /** PROCESSING → COMPLETED. The payload is retained for Phase 0E.4. */
  async markPublicationOutboxCompleted(input: unknown): Promise<OutboxDomain> {
    const parsed = CompleteOutboxInput.safeParse(input);
    if (!parsed.success) throw this.inputError("Invalid completion input", parsed.error);
    const req = parsed.data;

    return this.resolveClaim(req.outboxId, req.lockToken, "COMPLETED", {
      outboxStatus: "COMPLETED",
      lockToken: null,
      lockedAt: null,
      leaseExpiresAt: null,
      completedAt: new Date(req.completedAt),
    });
  }

  /** PROCESSING → DEAD_LETTER. Terminal failure; the payload is retained. */
  async markPublicationOutboxDeadLetter(input: unknown): Promise<OutboxDomain> {
    const parsed = DeadLetterOutboxInput.safeParse(input);
    if (!parsed.success) throw this.inputError("Invalid dead-letter input", parsed.error);
    const req = parsed.data;

    return this.resolveClaim(req.outboxId, req.lockToken, "DEAD_LETTER", {
      outboxStatus: "DEAD_LETTER",
      lockToken: null,
      lockedAt: null,
      leaseExpiresAt: null,
      lastErrorCode: req.errorCode,
      lastErrorSummary: req.errorSummary,
    });
  }

  /**
   * PENDING | RETRYABLE → CANCELLED. Needs no lock token: an unclaimed item has
   * no owner. A PROCESSING item cannot be cancelled out from under its worker.
   */
  async cancelPublicationOutbox(input: unknown): Promise<OutboxDomain> {
    const parsed = CancelOutboxInput.safeParse(input);
    if (!parsed.success) throw this.inputError("Invalid cancellation input", parsed.error);
    const { outboxId } = parsed.data;

    const current = await this.requireRow(outboxId);
    this.assertTransition(current.outboxStatus, "CANCELLED");

    const updated = await this.guardedUpdate(
      { outboxId, outboxStatus: { in: CLAIMABLE } },
      // Defensive: a claimable item holds no lease, but never leave one behind.
      { outboxStatus: "CANCELLED", lockToken: null, lockedAt: null, leaseExpiresAt: null },
    );
    return this.readBack(updated, outboxId);
  }

  /**
   * Recover stale claims: PROCESSING items whose lease has expired, returned to
   * RETRYABLE so a crashed or abandoned worker cannot strand them forever.
   *
   * This is a CALLER-DRIVEN sweep of at most `limit` rows. There is deliberately
   * no loop-until-empty, no background scheduler, and no polling — the caller
   * decides when and how often to sweep.
   *
   * Each row is taken with a guarded update that re-asserts PROCESSING, an
   * expired lease, AND the exact lockToken observed during selection. Two
   * concurrent sweeps therefore cannot both recover the same row: the loser
   * matches zero rows and counts it as skipped rather than failing the sweep.
   *
   * A live (unexpired) claim is never touched — this is lease EXPIRY, not lock
   * stealing. Terminal items are excluded by the PROCESSING filter, which also
   * excludes anything a Registrar receipt already completed.
   */
  async recoverExpiredPublicationOutboxClaims(input: unknown): Promise<RecoveryResult> {
    const parsed = RecoverExpiredClaimsInput.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid stale-claim recovery input", zodIssues(parsed.error));
    }
    const { now, limit } = parsed.data;
    const nowDate = new Date(now);
    // Documented default: a recovered item becomes eligible immediately at `now`.
    const availableAt = parsed.data.availableAt ?? now;
    const availableAtDate = new Date(availableAt);

    const candidates = await this.db.publicationOutbox.findMany({
      where: {
        outboxStatus: "PROCESSING",
        leaseExpiresAt: { lte: nowDate },
        // Defence in depth: an accepted, reconciled publication must never have
        // its work item resurrected. Such an item is already COMPLETED, so the
        // status filter alone suffices — this makes the guarantee explicit.
        NOT: {
          publication: {
            is: { registrationState: "ACCEPTED", reconciliationState: "MATCHED" },
          },
        },
      },
      orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, outboxId: true, lockToken: true },
    });

    const recovered: OutboxDomain[] = [];
    let skipped = 0;

    for (const candidate of candidates) {
      const won = await this.guardedUpdate(
        {
          id: candidate.id,
          outboxStatus: "PROCESSING",
          leaseExpiresAt: { lte: nowDate },
          lockToken: candidate.lockToken,
        },
        {
          outboxStatus: "RETRYABLE",
          lockToken: null,
          lockedAt: null,
          leaseExpiresAt: null,
          availableAt: availableAtDate,
          // attemptCount, payload, and payloadHash are deliberately untouched.
          lastErrorCode: LEASE_EXPIRED_ERROR_CODE,
          lastErrorSummary: LEASE_EXPIRED_ERROR_SUMMARY,
        },
      );
      if (won !== 1) {
        // Another concurrent sweep took it first. Not an error.
        skipped += 1;
        continue;
      }
      recovered.push(outboxRowToDomain(await this.requireRow(candidate.outboxId)));
    }

    return StaleClaimRecoveryResult.parse({
      now,
      availableAt,
      examined: candidates.length,
      recoveredCount: recovered.length,
      skippedCount: skipped,
      recovered,
    } satisfies RecoveryResult);
  }

  /** Read one outbox item as a validated domain object. */
  async getPublicationOutboxById(outboxId: string): Promise<OutboxDomain> {
    return outboxRowToDomain(await this.requireRow(outboxId));
  }

  // — Internals —

  private async requireRow(outboxId: string): Promise<OutboxRow> {
    const row = await this.db.publicationOutbox.findUnique({ where: { outboxId } });
    if (!row) throw new OutboxNotFoundError();
    return row;
  }

  private assertTransition(from: string, to: OutboxStatus): void {
    if (!isAllowedOutboxTransition(from as OutboxStatus, to)) {
      throw new InvalidOutboxTransitionError(from, to);
    }
  }

  /**
   * Resolve a claimed item. Checks are ordered deliberately:
   *   1. the item exists;
   *   2. the transition is permitted from its CURRENT state — so a terminal item
   *      reports an invalid transition rather than a token mismatch caused by
   *      the token having already been cleared;
   *   3. the presented token owns the claim;
   *   4. a guarded update re-asserts (token, PROCESSING) atomically.
   */
  private async resolveClaim(
    outboxId: string,
    lockToken: string,
    to: OutboxStatus,
    data: Prisma.PublicationOutboxUncheckedUpdateManyInput,
  ): Promise<OutboxDomain> {
    const current = await this.requireRow(outboxId);
    // A claimable item holds NO claim at all, so a caller presenting a token for
    // it is necessarily working from a claim that expired and was recovered.
    // Reported distinctly (but still as an invalid transition) so the caller can
    // tell "your lease lapsed" from "that transition never made sense".
    if (CLAIMABLE.includes(current.outboxStatus as OutboxStatus)) {
      throw new StaleClaimError(current.outboxStatus, to);
    }
    this.assertTransition(current.outboxStatus, to);
    if (current.lockToken !== lockToken) throw new OutboxLockTokenMismatchError();

    const updated = await this.guardedUpdate(
      { outboxId, lockToken, outboxStatus: "PROCESSING" },
      data,
    );
    return this.readBack(updated, outboxId);
  }

  private async guardedUpdate(
    where: Prisma.PublicationOutboxWhereInput,
    data: Prisma.PublicationOutboxUncheckedUpdateManyInput,
  ): Promise<number> {
    try {
      const res = await this.db.publicationOutbox.updateMany({ where, data });
      return res.count;
    } catch (e) {
      throw new DatabaseError(
        "Outbox state transition failed",
        e instanceof Error ? e.message : undefined,
      );
    }
  }

  private async readBack(count: number, outboxId: string): Promise<OutboxDomain> {
    // Zero rows means the row changed between our checks and the guarded update.
    if (count !== 1) throw new OutboxClaimConflictError();
    return outboxRowToDomain(await this.requireRow(outboxId));
  }

  /**
   * Map a rejected input to a structured error, distinguishing "you sent a
   * secret or an oversized summary" from "you sent a malformed identifier".
   * Issue text names the offending field and the rule CLASS only — never the
   * offending value.
   */
  /**
   * Map a rejected claim input, separating the two lease failure modes from any
   * other malformed field so a caller learns which one it got wrong.
   */
  private claimInputError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): Error {
    const issues = zodIssues(error);
    if (issues.some((i) => i.startsWith("leaseDurationSeconds"))) {
      return new InvalidLeaseDurationError("Invalid claim lease duration", issues);
    }
    if (issues.some((i) => i.startsWith("leaseExpiresAt"))) {
      return new InvalidLeaseExpiryError("Invalid claim lease expiry", issues);
    }
    return new ValidationError("Invalid claim input", issues);
  }

  private inputError(
    message: string,
    error: { issues: Array<{ path: PropertyKey[]; message: string }> },
  ): Error {
    const issues = zodIssues(error);
    const unsafe = issues.filter((i) => /^error(Code|Summary)\b/.test(i));
    if (unsafe.length > 0) {
      return new UnsafeErrorMetadataError(
        "Proposed outbox error metadata was refused as unsafe or out of bounds",
        unsafe,
      );
    }
    return new ValidationError(message, issues);
  }
}
