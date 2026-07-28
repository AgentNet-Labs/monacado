/**
 * Prisma ⇄ domain mapping for publication submission attempts (Phase 0E.5.3).
 *
 * Identity, hashes, attempt number, and timestamps are immutable, so there is a
 * read mapper and a create mapper only — lifecycle transitions are narrow
 * guarded updates issued by the service, never a generic update input.
 *
 * Every row read is reconstructed into a validated domain object; malformed
 * persisted data surfaces as a structured contract violation. Raw Prisma rows
 * never escape the adapter, and the raw lock token never enters persistence.
 */

import type { Prisma, PublicationSubmissionAttempt as AttemptRow } from "@prisma/client";
import {
  PublicationSubmissionAttempt,
  type PublicationSubmissionAttempt as AttemptDomain,
  type PublicationSubmissionAttemptWrite,
} from "../../contracts/product/product-submission-attempt";
import { PersistedAttemptContractViolationError } from "./submission-attempt-errors";

const iso = (d: Date): string => d.toISOString();

const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/** Reconstruct a validated domain attempt from a persisted row. */
export function attemptRowToDomain(row: AttemptRow): AttemptDomain {
  const candidate = {
    id: row.id.toString(),
    submissionAttemptId: row.submissionAttemptId,
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
    attemptStatus: row.attemptStatus,
    preparedAt: iso(row.preparedAt),
    ...(row.dispatchedAt !== null ? { dispatchedAt: iso(row.dispatchedAt) } : {}),
    ...(row.abandonedAt !== null ? { abandonedAt: iso(row.abandonedAt) } : {}),
    createdAt: iso(row.createdAt),
  };

  const parsed = PublicationSubmissionAttempt.safeParse(candidate);
  if (!parsed.success) {
    // Field paths and messages only — never hash values or payload contents.
    throw new PersistedAttemptContractViolationError(
      "Persisted publication submission attempt violates its contract",
      issues(parsed.error),
    );
  }
  return parsed.data;
}

/**
 * Build the Prisma create input for an attempt from validated domain data.
 * `claimTokenHash` arrives already hashed — the raw token never reaches here.
 */
export function domainToAttemptCreateInput(
  attempt: PublicationSubmissionAttemptWrite,
): Prisma.PublicationSubmissionAttemptUncheckedCreateInput {
  return {
    submissionAttemptId: attempt.submissionAttemptId,
    publicationId: attempt.publicationId,
    outboxId: attempt.outboxId,
    attemptNumber: attempt.attemptNumber,
    operation: attempt.operation,
    nodeId: attempt.nodeId,
    capsuleId: attempt.capsuleId,
    registrarId: attempt.registrarId,
    expectedContentHash: attempt.expectedContentHash,
    payloadHash: attempt.payloadHash,
    claimTokenHash: attempt.claimTokenHash,
    attemptStatus: attempt.attemptStatus,
    preparedAt: new Date(attempt.preparedAt),
    dispatchedAt: attempt.dispatchedAt !== undefined ? new Date(attempt.dispatchedAt) : null,
    abandonedAt: attempt.abandonedAt !== undefined ? new Date(attempt.abandonedAt) : null,
  };
}
