/**
 * Prisma ⇄ domain mapping for Registrar receipts (Phase 0E.4).
 *
 * Receipts are immutable, so there is only a read mapper and a create mapper —
 * no update input exists. Every row read is reconstructed into a validated
 * domain object; malformed persisted data surfaces as a structured contract
 * violation. Raw Prisma rows never escape the adapter.
 */

import { Prisma } from "@prisma/client";
import type { RegistrarReceipt as ReceiptRow } from "@prisma/client";
import {
  RegistrarReceipt,
  type RegistrarReceipt as RegistrarReceiptDomain,
  type RegistrarReceiptWrite,
} from "../../contracts/product/product-registrar-receipt";
import { PersistedReceiptContractViolationError } from "./receipt-errors";

const iso = (d: Date): string => d.toISOString();

const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/** Reconstruct a validated domain receipt from a persisted row. */
export function receiptRowToDomain(row: ReceiptRow): RegistrarReceiptDomain {
  const candidate = {
    id: row.id.toString(),
    receiptId: row.receiptId,
    publicationId: row.publicationId,
    ...(row.submissionAttemptId !== null ? { submissionAttemptId: row.submissionAttemptId } : {}),
    ...(row.registrarRegistrationId !== null
      ? { registrarRegistrationId: row.registrarRegistrationId }
      : {}),
    registrarId: row.registrarId,
    nodeId: row.nodeId,
    capsuleId: row.capsuleId,
    registeredContentHash: row.registeredContentHash,
    receiptStatus: row.receiptStatus,
    registeredAt: iso(row.registeredAt),
    receivedAt: iso(row.receivedAt),
    receiptDetails: row.receiptDetails,
    createdAt: iso(row.createdAt),
  };

  const parsed = RegistrarReceipt.safeParse(candidate);
  if (!parsed.success) {
    // Field paths and messages only — never hash values or capsule content.
    throw new PersistedReceiptContractViolationError(
      "Persisted Registrar receipt violates the RegistrarReceipt contract",
      issues(parsed.error),
    );
  }
  return parsed.data;
}

/**
 * Build the Prisma create input for a receipt.
 *
 * `acceptedForPublicationId` is a persistence-only column: it mirrors
 * `publicationId` for an accepted receipt that ALSO RECONCILED, and is NULL
 * otherwise, so the unique index enforces at most one *matching* accepted
 * receipt per publication. It is deliberately absent from the domain contract —
 * it carries no meaning a caller should see.
 *
 * The `reconciled` flag matters: an ACCEPTED receipt that failed reconciliation
 * is evidence about something ELSE, not a registration of this publication. If
 * it claimed the slot it would permanently block the genuine acceptance that a
 * Phase 0E.5.2 retry is meant to obtain.
 */
export function domainToReceiptCreateInput(
  receipt: RegistrarReceiptWrite,
  outboxId: string | undefined,
  reconciled: boolean,
): Prisma.RegistrarReceiptUncheckedCreateInput {
  return {
    receiptId: receipt.receiptId,
    publicationId: receipt.publicationId,
    submissionAttemptId: receipt.submissionAttemptId,
    outboxId: outboxId ?? null,
    registrarRegistrationId: receipt.registrarRegistrationId ?? null,
    registrarId: receipt.registrarId,
    nodeId: receipt.nodeId,
    capsuleId: receipt.capsuleId,
    registeredContentHash: receipt.registeredContentHash,
    receiptStatus: receipt.receiptStatus,
    registeredAt: new Date(receipt.registeredAt),
    receivedAt: new Date(receipt.receivedAt),
    receiptDetails: receipt.receiptDetails as unknown as Prisma.InputJsonValue,
    acceptedForPublicationId:
      receipt.receiptStatus === "ACCEPTED" && reconciled ? receipt.publicationId : null,
  };
}
