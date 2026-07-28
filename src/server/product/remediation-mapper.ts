/**
 * Prisma ⇄ domain mapping for publication remediations (Phase 0E.5.2).
 *
 * Remediations are immutable, so there is only a read mapper and a create
 * mapper — no update input exists. Every row read is reconstructed into a
 * validated domain object; malformed persisted data surfaces as a structured
 * contract violation. Raw Prisma rows never escape the adapter.
 */

import type { Prisma, PublicationRemediation as RemediationRow } from "@prisma/client";
import {
  PublicationRemediation,
  type PublicationRemediation as RemediationDomain,
  type PublicationRemediationWrite,
} from "../../contracts/product/product-publication-remediation";
import { PersistedRemediationContractViolationError } from "./remediation-errors";

const iso = (d: Date): string => d.toISOString();

const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/** Reconstruct a validated domain remediation from a persisted row. */
export function remediationRowToDomain(row: RemediationRow): RemediationDomain {
  const candidate = {
    id: row.id.toString(),
    remediationId: row.remediationId,
    publicationId: row.publicationId,
    ...(row.outboxId !== null ? { outboxId: row.outboxId } : {}),
    remediationAction: row.remediationAction,
    priorRegistrationState: row.priorRegistrationState,
    priorReconciliationState: row.priorReconciliationState,
    priorOutboxStatus: row.priorOutboxStatus,
    priorRemediationState: row.priorRemediationState,
    reasonCode: row.reasonCode,
    ...(row.reasonSummary !== null ? { reasonSummary: row.reasonSummary } : {}),
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    ...(row.retryAvailableAt !== null ? { retryAvailableAt: iso(row.retryAvailableAt) } : {}),
    createdAt: iso(row.createdAt),
  };

  const parsed = PublicationRemediation.safeParse(candidate);
  if (!parsed.success) {
    // Field paths and messages only — never receipt or payload contents.
    throw new PersistedRemediationContractViolationError(
      "Persisted publication remediation violates the PublicationRemediation contract",
      issues(parsed.error),
    );
  }
  return parsed.data;
}

/** Build the Prisma create input for a remediation from validated domain data. */
export function domainToRemediationCreateInput(
  remediation: PublicationRemediationWrite,
): Prisma.PublicationRemediationUncheckedCreateInput {
  return {
    remediationId: remediation.remediationId,
    publicationId: remediation.publicationId,
    outboxId: remediation.outboxId ?? null,
    remediationAction: remediation.remediationAction,
    priorRegistrationState: remediation.priorRegistrationState,
    priorReconciliationState: remediation.priorReconciliationState,
    priorOutboxStatus: remediation.priorOutboxStatus,
    priorRemediationState: remediation.priorRemediationState,
    reasonCode: remediation.reasonCode,
    reasonSummary: remediation.reasonSummary ?? null,
    decidedBy: remediation.decidedBy,
    decidedAt: new Date(remediation.decidedAt),
    retryAvailableAt:
      remediation.retryAvailableAt !== undefined ? new Date(remediation.retryAvailableAt) : null,
  };
}
