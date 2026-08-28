/**
 * Dispute evidence preparation, review, and submission (Phase 1.12) —
 * SERVER ONLY.
 *
 * The governed path from "a dispute needs answering" to "a response left the
 * building", with an operator standing in the middle of it.
 *
 * ## Why there is an approval state at all
 *
 * Submission is one-shot and effectively irreversible: a dispute may typically
 * be answered once, and the provider's own finality flag defaults to *yes*. A
 * path that let assembled data reach a bank without a person saying so would be
 * a bug that loses money with no undo — and part of what it would send is
 * supplied by the **seller**, who is an interested party in the outcome.
 *
 * So seller-supplied material never transmits on its own. It becomes an item, the
 * item joins a package, and a named internal account approves that package
 * against a named provider observation before anything is sent.
 *
 * ## Approval is authorisation to send THIS package against THAT observation
 *
 * `basedOnProviderEventAt` is copied from the dispute when the package is
 * prepared. If a provider event arrives afterwards, the approval no longer
 * describes the dispute as it now stands, and the preparation is `SUPERSEDED`
 * rather than sent. Without that check an ageing approval quietly becomes
 * authorisation to send something nobody reviewed.
 *
 * ## Nothing here writes provider-owned state
 *
 * This module never touches `status`, `fundsState`, `evidenceDueBy`,
 * `evidenceSubmissionCount`, or any other column the webhook owns. Those are the
 * provider's assertions, rewritten wholesale on every applied delivery. A local
 * "we submitted, mark it under review" would be indistinguishable from a network
 * fact and would retire the operator's own to-do while the real deadline kept
 * running. The webhook remains the only writer.
 *
 * ## No evidence value is stored, and no buyer detail is read
 *
 * A record-backed item is a pointer plus an observation instant. A seller's
 * attestation is a member of a closed vocabulary. Nothing in this module reads
 * `OrderBuyerSnapshot`, and the projection sent to a provider is built from
 * immutable policy versions, the sale-time product pin, and the sale date —
 * never from cardholder identity.
 */

import "../server-only";
import {
  DisputeEvidenceCompleteness,
  MONACADO_REPRESENTMENT_RULING,
  SellerAttestationClaim,
  disputeEvidenceCompletenessFor,
  isValidDisputeEvidencePreparationTransition,
  type DisputeEvidencePreparationStatus,
  type DisputeEvidenceSubmissionPort,
  type SubmittableEvidenceField,
} from "../../contracts/marketplace/dispute-evidence";
import type { DisputeEvidenceCode } from "../../contracts/marketplace/dispute-operations";
import { getPrisma } from "../db/client";
import { DisputeEvidenceRefusedError, DisputeNotFoundError } from "./dispute-errors";
import { disputeEvidenceIdempotencyKey } from "./dispute-evidence-idempotency";
import { assembleDisputeEvidenceMetadata } from "./dispute-evidence-metadata-service";
import { cryptoDisputeIdProvider, type DisputeIdProvider } from "./dispute-ids";

export interface DisputeEvidenceServiceDeps {
  db?: ReturnType<typeof getPrisma>;
  ids?: DisputeIdProvider;
  env?: Record<string, string | undefined>;
  port?: DisputeEvidenceSubmissionPort;
}

/** Which authoritative table each evidence code cites. A closed vocabulary. */
const EVIDENCE_SOURCE_TABLES: Partial<Record<DisputeEvidenceCode, string>> = {
  RECEIPT_AND_DELIVERY_PROOF: "OutboundEmailDelivery",
  CUSTOMER_COMMUNICATION: "OutboundEmailDelivery",
  REFUND_POLICY_VERSION_BOUND_AT_PURCHASE: "SellerRefundPolicyVersionRow",
  MARKETPLACE_POLICY_VERSION_AT_PURCHASE: "MarketplacePolicyVersionRow",
  PRODUCT_DESCRIPTION_AT_SALE: "ProductSourceRecordVersionRow",
  SERVICE_DATE: "Order",
  DISCLOSED_SELLER_CONTACT: "OrderRefundContactEvidence",
};

/**
 * Which evidence codes are a derivation rather than a citation.
 *
 * The product description is reached through the tax transaction's sale-time pin
 * rather than a binding on the Order, so it is a claim about two records. An
 * operator about to send it to a bank should be able to see that.
 */
const DERIVED_EVIDENCE_CODES: readonly DisputeEvidenceCode[] = Object.freeze([
  "PRODUCT_DESCRIPTION_AT_SALE",
]);

export interface DisputeEvidencePackageView {
  disputeId: string;
  preparationId: string;
  revision: number;
  status: DisputeEvidencePreparationStatus;
  completeness: DisputeEvidenceCompleteness;
  /** Codes only. Never a value, and never a buyer-derived string. */
  itemCodes: DisputeEvidenceCode[];
  attestationClaims: SellerAttestationClaim[];
  approved: boolean;
  submitted: boolean;
  failureCode: string | null;
}

function assertTransition(
  from: DisputeEvidencePreparationStatus,
  to: DisputeEvidencePreparationStatus,
): void {
  if (!isValidDisputeEvidencePreparationTransition(from, to)) {
    throw new DisputeEvidenceRefusedError("INVALID_PREPARATION_TRANSITION");
  }
}

/**
 * Assemble a package for one dispute and record it as `PREPARED`.
 *
 * Idempotent in the way `1.9`'s enqueue paths are: a dispute that already has a
 * live preparation gets that one back rather than a second. Two open packages for
 * one dispute would be two answers, and only one can be sent.
 */
export async function prepareDisputeEvidence(
  input: { disputeId: string; at: string },
  deps: DisputeEvidenceServiceDeps = {},
): Promise<DisputeEvidencePackageView> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoDisputeIdProvider;

  const dispute = await db.transactionDispute.findUnique({
    where: { id: input.disputeId },
    select: {
      id: true,
      orderId: true,
      status: true,
      responsePermitted: true,
      evidenceDueBy: true,
      evidenceSubmissionCount: true,
      remediationCode: true,
      lastProviderEventAt: true,
    },
  });
  if (dispute === null) throw new DisputeNotFoundError();

  /* The eligibility gate, ordered so the checks that make the others pointless
     come first — the same ordering `disputeOperatorActionFor` already uses.
     Assembling a package for any of these wastes the only window there was. */
  if (dispute.orderId === null) throw new DisputeEvidenceRefusedError("DISPUTE_UNATTRIBUTED");
  if (dispute.remediationCode !== null) {
    throw new DisputeEvidenceRefusedError("MANUAL_REMEDIATION_REQUIRED");
  }
  if (!dispute.responsePermitted) {
    throw new DisputeEvidenceRefusedError("RESPONSE_NOT_PERMITTED");
  }
  if (dispute.evidenceSubmissionCount >= 1) {
    throw new DisputeEvidenceRefusedError("ALREADY_SUBMITTED");
  }
  if (dispute.status !== "NEEDS_RESPONSE") {
    throw new DisputeEvidenceRefusedError("DISPUTE_NOT_AWAITING_RESPONSE");
  }
  if (dispute.evidenceDueBy !== null && dispute.evidenceDueBy.getTime() <= Date.parse(input.at)) {
    throw new DisputeEvidenceRefusedError("DEADLINE_PASSED");
  }

  const existing = await db.disputeEvidencePreparation.findFirst({
    where: { disputeId: dispute.id, status: { in: ["PREPARED", "APPROVED"] } },
    orderBy: { revision: "desc" },
  });
  if (existing !== null) return readPackage(existing.id, deps);

  const availability = await assembleDisputeEvidenceMetadata(dispute.orderId, { db });
  const available = availability.filter((entry) => entry.available);

  const lastRevision = await db.disputeEvidencePreparation.findFirst({
    where: { disputeId: dispute.id },
    orderBy: { revision: "desc" },
    select: { revision: true },
  });
  const revision = (lastRevision?.revision ?? 0) + 1;
  const preparationId = ids.nextDisputeEvidencePreparationId();
  const at = new Date(input.at);

  await db.$transaction(async (tx) => {
    await tx.disputeEvidencePreparation.create({
      data: {
        id: preparationId,
        disputeId: dispute.id,
        revision,
        status: "PREPARED",
        completeness: disputeEvidenceCompletenessFor(
          available.map((entry) => entry.evidenceCode as DisputeEvidenceCode),
        ),
        /* Always a final response in this phase. Staging is modelled by the port
           and is deliberately unused: it adds a second durable state and a
           "staged but never submitted past the deadline" failure nobody has
           designed an operator action for. */
        finalSubmission: true,
        basedOnProviderEventAt: dispute.lastProviderEventAt,
        idempotencyKey: disputeEvidenceIdempotencyKey({
          disputeId: dispute.id,
          providerDisputeRef: dispute.id,
          revision,
          finalSubmission: true,
        }),
        preparedAt: at,
      },
    });

    for (const entry of available) {
      const code = entry.evidenceCode as DisputeEvidenceCode;
      const itemId = ids.nextDisputeEvidenceItemId();
      /* A citation, never a copy. `sourceRef` is followed at render time, so the
         item cannot drift from the record it describes. */
      await tx.disputeEvidenceItem.upsert({
        where: {
          disputeId_evidenceCode_sourceRef: {
            disputeId: dispute.id,
            evidenceCode: code,
            sourceRef: entry.monacadoRecordRef ?? "",
          },
        },
        update: { sourceObservedAt: at },
        create: {
          id: itemId,
          disputeId: dispute.id,
          evidenceCode: code,
          sourceKind: DERIVED_EVIDENCE_CODES.includes(code)
            ? "MONACADO_DERIVATION"
            : "MONACADO_RECORD",
          sourceTable: EVIDENCE_SOURCE_TABLES[code] ?? null,
          sourceRef: entry.monacadoRecordRef ?? "",
          sourceObservedAt: at,
          assertedByKind: "SYSTEM",
          assertedAt: at,
          validationState: "VALIDATED",
        },
      });
      const item = await tx.disputeEvidenceItem.findUnique({
        where: {
          disputeId_evidenceCode_sourceRef: {
            disputeId: dispute.id,
            evidenceCode: code,
            sourceRef: entry.monacadoRecordRef ?? "",
          },
        },
        select: { id: true },
      });
      if (item !== null) {
        await tx.disputeEvidencePreparationItem.create({
          data: { preparationId, itemId: item.id },
        });
      }
    }

    /* Any attestation the seller already supplied joins this package. It was
       recorded before the package existed, and a package that ignored it would
       ask the seller twice for something they already answered. */
    const attestations = await tx.disputeEvidenceItem.findMany({
      where: { disputeId: dispute.id, sourceKind: "SELLER_ATTESTATION" },
      select: { id: true },
    });
    for (const attestation of attestations) {
      await tx.disputeEvidencePreparationItem.create({
        data: { preparationId, itemId: attestation.id },
      });
    }
  });

  return readPackage(preparationId, deps);
}

/**
 * Record a seller's bounded factual claim about their own conduct.
 *
 * **This transmits nothing.** The claim becomes an item; sending it still
 * requires an operator to approve a package containing it. A seller is an
 * interested party in a dispute's outcome, and a path where their assertion
 * reached a bank unreviewed would be exactly the automatic transmission this
 * phase exists to prevent.
 *
 * The claim is a vocabulary member rather than prose, so the record cannot become
 * a place where somebody writes about the cardholder.
 */
export async function recordSellerAttestation(
  input: {
    disputeId: string;
    claims: readonly SellerAttestationClaim[];
    participantId: string;
    accountId: string;
    at: string;
  },
  deps: DisputeEvidenceServiceDeps = {},
): Promise<{ recorded: number }> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoDisputeIdProvider;

  const dispute = await db.transactionDispute.findUnique({
    where: { id: input.disputeId },
    select: { id: true },
  });
  if (dispute === null) throw new DisputeNotFoundError();
  if (input.claims.length === 0) throw new DisputeEvidenceRefusedError("NO_CLAIMS_SUPPLIED");

  const at = new Date(input.at);
  let recorded = 0;
  for (const claim of input.claims) {
    /* Parsed rather than trusted: a claim outside the vocabulary is refused
       rather than stored, which is what keeps this column free of prose. */
    const parsed = SellerAttestationClaim.parse(claim);
    await db.disputeEvidenceItem.create({
      data: {
        id: ids.nextDisputeEvidenceItemId(),
        disputeId: dispute.id,
        /* Attested rather than held. The seller says they hold delivery evidence;
           Monacado does not, and the code it maps to stays unavailable. */
        evidenceCode: "SHIPPING_DOCUMENTATION",
        sourceKind: "SELLER_ATTESTATION",
        attestationClaim: parsed,
        assertedByKind: "SELLER",
        assertedByAccountId: input.accountId,
        assertedByParticipantId: input.participantId,
        assertedAt: at,
        /* An operator validates a seller's assertion before it is sent. It is not
           a Monacado record and must not be treated as one. */
        validationState: "UNVALIDATED",
      },
    });
    recorded += 1;
  }
  return { recorded };
}

/**
 * Approve a prepared package for submission.
 *
 * The governed transition. Refuses if a provider event has arrived since the
 * package was prepared, because the approval would then describe a dispute that
 * has since moved.
 */
export async function approveDisputeEvidence(
  input: { preparationId: string; accountId: string; at: string },
  deps: DisputeEvidenceServiceDeps = {},
): Promise<DisputeEvidencePackageView> {
  const db = deps.db ?? getPrisma();

  const preparation = await db.disputeEvidencePreparation.findUnique({
    where: { id: input.preparationId },
    select: { id: true, status: true, disputeId: true, basedOnProviderEventAt: true },
  });
  if (preparation === null) throw new DisputeEvidenceRefusedError("PREPARATION_NOT_FOUND");
  assertTransition(preparation.status as DisputeEvidencePreparationStatus, "APPROVED");

  const dispute = await db.transactionDispute.findUnique({
    where: { id: preparation.disputeId },
    select: { lastProviderEventAt: true },
  });
  if (dispute === null) throw new DisputeNotFoundError();
  if (dispute.lastProviderEventAt.getTime() > preparation.basedOnProviderEventAt.getTime()) {
    await db.disputeEvidencePreparation.update({
      where: { id: preparation.id },
      data: { status: "SUPERSEDED" },
    });
    throw new DisputeEvidenceRefusedError("SUPERSEDED_BY_PROVIDER_EVENT");
  }

  await db.disputeEvidencePreparation.update({
    where: { id: preparation.id },
    data: {
      status: "APPROVED",
      approvedByAccountId: input.accountId,
      approvedAt: new Date(input.at),
    },
  });
  return readPackage(preparation.id, deps);
}

/**
 * Send an approved package to the provider.
 *
 * Refuses unless an operator approved it, unless the governance gate is open, and
 * unless the dispute still stands where the approval said it did. Nothing about
 * the provider's own dispute state is written here on success — the next
 * `charge.dispute.updated` delivery is what moves those columns, and it is the
 * only thing entitled to.
 */
export async function submitDisputeEvidence(
  input: { preparationId: string; at: string },
  deps: DisputeEvidenceServiceDeps = {},
): Promise<DisputeEvidencePackageView> {
  const db = deps.db ?? getPrisma();
  const env = deps.env ?? process.env;

  const preparation = await db.disputeEvidencePreparation.findUnique({
    where: { id: input.preparationId },
  });
  if (preparation === null) throw new DisputeEvidenceRefusedError("PREPARATION_NOT_FOUND");
  if (preparation.status === "SUBMITTED") {
    /* Idempotent rather than an error: a repeated submit of an already-sent
       package is the caller asking a question already answered, and answering it
       again is safer than a second provider call. */
    return readPackage(preparation.id, deps);
  }
  if (preparation.status !== "APPROVED") {
    throw new DisputeEvidenceRefusedError("NOT_APPROVED");
  }

  const dispute = await db.transactionDispute.findUnique({
    where: { id: preparation.disputeId },
    select: {
      id: true,
      orderId: true,
      providerDisputeRef: true,
      evidenceDueBy: true,
      evidenceSubmissionCount: true,
      lastProviderEventAt: true,
      responsePermitted: true,
    },
  });
  if (dispute === null) throw new DisputeNotFoundError();

  if (dispute.lastProviderEventAt.getTime() > preparation.basedOnProviderEventAt.getTime()) {
    await db.disputeEvidencePreparation.update({
      where: { id: preparation.id },
      data: { status: "SUPERSEDED" },
    });
    throw new DisputeEvidenceRefusedError("SUPERSEDED_BY_PROVIDER_EVENT");
  }
  if (!dispute.responsePermitted) {
    await refuse(db, preparation.id, "RESPONSE_NOT_PERMITTED");
    throw new DisputeEvidenceRefusedError("RESPONSE_NOT_PERMITTED");
  }
  if (dispute.evidenceDueBy !== null && dispute.evidenceDueBy.getTime() <= Date.parse(input.at)) {
    await refuse(db, preparation.id, "DEADLINE_PASSED");
    throw new DisputeEvidenceRefusedError("DEADLINE_PASSED");
  }

  if (deps.port === undefined) {
    await refuse(db, preparation.id, "PROVIDER_NOT_CONFIGURED");
    throw new DisputeEvidenceRefusedError("PROVIDER_NOT_CONFIGURED");
  }

  const evidence = await projectEvidence(dispute.orderId, preparation.id, deps);
  const result = await deps.port.submitEvidence({
    disputeId: dispute.id,
    providerDisputeRef: dispute.providerDisputeRef,
    preparationId: preparation.id,
    evidence,
    finalSubmission: preparation.finalSubmission,
    idempotencyKey: preparation.idempotencyKey,
    observedSubmissionCount: dispute.evidenceSubmissionCount,
  });

  if (result.outcome === "REFUSED") {
    await db.disputeEvidencePreparation.update({
      where: { id: preparation.id },
      data: {
        /* A transient failure keeps the package approved and retryable; a
           terminal one closes it, because a retry button that does nothing is
           worse than no button. */
        status: result.retryable ? "APPROVED" : "SUBMISSION_REFUSED",
        failureCode: result.failureCode,
        attemptCount: { increment: 1 },
      },
    });
    throw new DisputeEvidenceRefusedError(result.failureCode);
  }

  if (result.outcome === "STAGED") {
    await db.disputeEvidencePreparation.update({
      where: { id: preparation.id },
      data: { attemptCount: { increment: 1 } },
    });
    return readPackage(preparation.id, deps);
  }

  /* The durable historical fact. Written on Monacado's own row, never on the
     provider's posture columns. */
  await db.disputeEvidencePreparation.update({
    where: { id: preparation.id },
    data: {
      status: "SUBMITTED",
      submittedAt: new Date(result.submittedAt),
      providerSubmissionCountAfter: result.providerSubmissionCount,
      submittedPastDue: result.providerSubmittedPastDue,
      failureCode: null,
      attemptCount: { increment: 1 },
    },
  });
  return readPackage(preparation.id, deps);
}

async function refuse(
  db: ReturnType<typeof getPrisma>,
  preparationId: string,
  failureCode: string,
): Promise<void> {
  await db.disputeEvidencePreparation.update({
    where: { id: preparationId },
    data: { status: "SUBMISSION_REFUSED", failureCode },
  });
}

/**
 * Build the provider payload from immutable records, at call time.
 *
 * **Projected, never stored.** Every value is read now from the record the item
 * cites, which is what keeps the evidence table free of copies able to disagree
 * with their sources.
 *
 * Nothing here reads `OrderBuyerSnapshot`. The fields a cardholder's identity
 * would populate are on `NEVER_SUBMITTED_TO_PROVIDER`, and this function has no
 * route to them even if a caller asked.
 */
async function projectEvidence(
  orderId: string | null,
  preparationId: string,
  deps: DisputeEvidenceServiceDeps,
): Promise<Partial<Record<SubmittableEvidenceField, string>>> {
  const db = deps.db ?? getPrisma();
  const out: Partial<Record<SubmittableEvidenceField, string>> = {};
  if (orderId === null) return out;

  const rows = await db.disputeEvidencePreparationItem.findMany({
    where: { preparationId },
    select: { item: { select: { evidenceCode: true, sourceRef: true, sourceKind: true } } },
  });
  const codes = new Set(rows.map((row) => row.item.evidenceCode));

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { paidAt: true },
  });

  if (codes.has("SERVICE_DATE") && order?.paidAt != null) {
    out.service_date = order.paidAt.toISOString();
  }

  /* The bound versions, cited by their exact identity. A version label is a
     durable public fact about what the buyer agreed to, and carries no buyer
     detail of its own. */
  const refundPolicyRef = rows.find(
    (row) => row.item.evidenceCode === "REFUND_POLICY_VERSION_BOUND_AT_PURCHASE",
  )?.item.sourceRef;
  if (refundPolicyRef != null && refundPolicyRef.length > 0) {
    out.refund_policy_disclosure = `Seller refund policy bound at purchase: ${refundPolicyRef}`;
  }

  const marketplacePolicyRef = rows.find(
    (row) => row.item.evidenceCode === "MARKETPLACE_POLICY_VERSION_AT_PURCHASE",
  )?.item.sourceRef;
  if (marketplacePolicyRef != null && marketplacePolicyRef.length > 0) {
    out.cancellation_policy_disclosure = `Marketplace policy in force at purchase: ${marketplacePolicyRef}`;
  }

  const productRef = rows.find(
    (row) => row.item.evidenceCode === "PRODUCT_DESCRIPTION_AT_SALE",
  )?.item.sourceRef;
  if (productRef != null && productRef.length > 0) {
    const [sourceRecordId, sourceRecordVersion] = productRef.split("@");
    if (sourceRecordId != null && sourceRecordVersion != null) {
      const version = await db.productSourceRecordVersionRow.findFirst({
        where: { sourceRecordId, sourceRecordVersion },
        select: { factName: true, factDescription: true },
      });
      if (version !== null) {
        out.product_description = [version.factName, version.factDescription]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join(" — ");
      }
    }
  }

  return out;
}

/** Read one package, as codes and states only. */
export async function readPackage(
  preparationId: string,
  deps: DisputeEvidenceServiceDeps = {},
): Promise<DisputeEvidencePackageView> {
  const db = deps.db ?? getPrisma();
  const preparation = await db.disputeEvidencePreparation.findUnique({
    where: { id: preparationId },
    select: {
      id: true,
      disputeId: true,
      revision: true,
      status: true,
      completeness: true,
      approvedByAccountId: true,
      failureCode: true,
      items: {
        select: {
          item: { select: { evidenceCode: true, sourceKind: true, attestationClaim: true } },
        },
      },
    },
  });
  if (preparation === null) throw new DisputeEvidenceRefusedError("PREPARATION_NOT_FOUND");

  const status = preparation.status as DisputeEvidencePreparationStatus;
  return {
    disputeId: preparation.disputeId,
    preparationId: preparation.id,
    revision: preparation.revision,
    status,
    completeness: preparation.completeness as DisputeEvidenceCompleteness,
    itemCodes: preparation.items
      .filter((row) => row.item.sourceKind !== "SELLER_ATTESTATION")
      .map((row) => row.item.evidenceCode as DisputeEvidenceCode),
    attestationClaims: preparation.items
      .map((row) => row.item.attestationClaim)
      .filter((claim): claim is string => claim !== null)
      .map((claim) => claim as SellerAttestationClaim),
    approved: preparation.approvedByAccountId !== null,
    submitted: status === "SUBMITTED",
    failureCode: preparation.failureCode,
  };
}

export { MONACADO_REPRESENTMENT_RULING };
