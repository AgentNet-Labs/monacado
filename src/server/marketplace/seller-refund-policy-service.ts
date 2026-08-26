/**
 * Seller refund policy persistence (Phase 1.9) — SERVER ONLY.
 *
 * The smallest versioned-policy capability a sale needs in order to bind the
 * terms in force at purchase time — and it is deliberately the **same** pattern
 * `marketplace-policy-service.ts` and `commercial-policy-service.ts` already use
 * rather than a fourth convention:
 *
 * ```
 * ensureSellerRefundPolicy        the stable identity. Idempotent.
 * recordSellerRefundPolicyVersion one IMMUTABLE version, created DRAFT.
 * activateSellerRefundPolicyVersion  retires whichever stood. One transaction.
 * getActiveSellerRefundPolicyVersion what checkout binds.
 * readSellerRefundPolicyVersion      what a refund and a receipt read.
 * ```
 *
 * ## There is no `status` parameter, and no update path for terms
 *
 * A version is recorded `DRAFT` and nothing else, so a caller cannot record terms
 * as already governing somebody. Once recorded, the terms and the document are
 * never rewritten — only `status`, `activatedAt`, `retiredAt`, and the active
 * marker move. That is what makes "which terms was this buyer shown" answerable
 * years later.
 *
 * ## `RETIRED` stays readable and bindable
 *
 * `readSellerRefundPolicyVersion` does not filter by status. An Order sold under
 * version 1 must stay explicable after the seller publishes version 2, and a
 * receipt that could not render a retired version would be one that breaks the
 * day a seller updates their terms.
 *
 * ## The content hash is derived, never supplied
 *
 * A caller-provided hash could name content that does not exist, which is exactly
 * the binding this is meant to prevent. `readSellerRefundPolicyVersion`
 * re-derives it and **refuses a row whose content has moved** — the same check
 * `readMarketplacePolicy` makes.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { canonicalHash } from "../../contracts/integrity/hash";
import {
  SellerRefundPolicyDocument,
  SellerRefundPolicyVersionRecord,
  SellerRefundPolicyError,
  SellerRefundTerms,
  sellerRefundPolicyIssues,
  type RefundEligibilityCondition,
} from "../../contracts/marketplace/seller-refund-policy";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface SellerRefundPolicyIdProvider {
  nextSellerRefundPolicyId(): string;
}

export interface SellerRefundPolicyDeps {
  db?: Db;
  ids?: SellerRefundPolicyIdProvider;
}

/**
 * The exact bytes a version pins.
 *
 * Over terms **and** document together, because a policy is both: enforced terms
 * that changed without the prose changing, or the reverse, are each a version
 * saying something it did not say before.
 */
export function sellerRefundPolicyContentHash(input: {
  terms: SellerRefundTerms;
  document: SellerRefundPolicyDocument;
}): string {
  return canonicalHash({ terms: input.terms, document: input.document });
}

const CONDITION_SEPARATOR = ",";

interface VersionRow {
  policyId: string;
  policyVersion: string;
  sellerParticipantId: string;
  status: string;
  refundsAllowed: boolean;
  eligibilityConditions: string;
  refundWindowDays: number | null;
  shippingRefundability: string;
  procedureKind: string;
  documentJson: string;
  contentHash: string;
  effectiveFrom: Date;
  recordedByAccountId: string;
  recordedAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

function rowToRecord(row: VersionRow): SellerRefundPolicyVersionRecord {
  let document: unknown;
  try {
    document = JSON.parse(row.documentJson);
  } catch {
    throw new SellerRefundPolicyError(
      "CORRUPT_SELLER_REFUND_POLICY",
      "A persisted seller refund policy document is malformed",
    );
  }

  const parsed = SellerRefundPolicyVersionRecord.safeParse({
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    sellerParticipantId: row.sellerParticipantId,
    status: row.status,
    terms: {
      refundsAllowed: row.refundsAllowed,
      eligibilityConditions:
        row.eligibilityConditions === ""
          ? []
          : row.eligibilityConditions.split(CONDITION_SEPARATOR),
      refundWindowDays: row.refundWindowDays,
      shippingRefundability: row.shippingRefundability,
      procedureKind: row.procedureKind,
    },
    document,
    contentHash: row.contentHash,
    effectiveFrom: row.effectiveFrom.toISOString(),
    recordedByAccountId: row.recordedByAccountId,
    recordedAt: row.recordedAt.toISOString(),
    activatedAt: row.activatedAt === null ? null : row.activatedAt.toISOString(),
    retiredAt: row.retiredAt === null ? null : row.retiredAt.toISOString(),
  });
  if (!parsed.success) {
    throw new SellerRefundPolicyError(
      "CORRUPT_SELLER_REFUND_POLICY",
      "A persisted seller refund policy row is malformed",
    );
  }

  /* The stored content must still hash to what the row claims. A version whose
     terms or prose have moved without a version bump is refused rather than
     shown — a buyer's receipt must render what they were actually shown. */
  const derived = sellerRefundPolicyContentHash({
    terms: parsed.data.terms,
    document: parsed.data.document,
  });
  if (derived !== parsed.data.contentHash) {
    throw new SellerRefundPolicyError(
      "SELLER_REFUND_POLICY_CONTENT_MOVED",
      "A persisted seller refund policy no longer matches its recorded hash",
    );
  }

  return parsed.data;
}

// — Identity —

/** Register one seller's stable policy identity. Idempotent. */
export async function ensureSellerRefundPolicy(
  input: { sellerParticipantId: string; label: string; now: string },
  deps: SellerRefundPolicyDeps = {},
): Promise<string> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids;
  if (ids === undefined) {
    throw new SellerRefundPolicyError(
      "SELLER_REFUND_POLICY_ID_PROVIDER_REQUIRED",
      "an id provider is required",
    );
  }

  const existing = await db.sellerRefundPolicy.findUnique({
    where: { sellerParticipantId: input.sellerParticipantId },
    select: { id: true },
  });
  if (existing !== null) return existing.id;

  const created = await db.sellerRefundPolicy.create({
    data: {
      id: ids.nextSellerRefundPolicyId(),
      sellerParticipantId: input.sellerParticipantId,
      label: input.label,
      createdAt: new Date(input.now),
    },
  });
  return created.id;
}

// — Versions —

/**
 * Record one immutable version, created `DRAFT`.
 *
 * **Refuses a document that contradicts its terms** before anything is written —
 * `sellerRefundPolicyIssues` catches a missing required section, a window
 * declared on a policy that refunds nothing, and the rest. The failure this
 * prevents is a seller whose enforced terms withhold shipping and whose prose
 * promises it back: whichever the buyer read, one of them was a lie, and the
 * buyer read the prose.
 */
export async function recordSellerRefundPolicyVersion(
  input: {
    policyId: string;
    policyVersion: string;
    sellerParticipantId: string;
    terms: SellerRefundTerms;
    document: SellerRefundPolicyDocument;
    effectiveFrom: string;
    recordedByAccountId: string;
    recordedAt: string;
  },
  deps: SellerRefundPolicyDeps = {},
): Promise<SellerRefundPolicyVersionRecord> {
  const db = deps.db ?? getPrisma();

  const terms = SellerRefundTerms.parse(input.terms);
  const document = SellerRefundPolicyDocument.parse(input.document);

  const issues = sellerRefundPolicyIssues({ terms, document });
  if (issues.length > 0) {
    throw new SellerRefundPolicyError(
      "SELLER_REFUND_POLICY_INCOHERENT",
      "This refund policy's document does not agree with its terms",
      issues,
    );
  }

  try {
    const row = await db.sellerRefundPolicyVersionRow.create({
      data: {
        policyId: input.policyId,
        policyVersion: input.policyVersion,
        sellerParticipantId: input.sellerParticipantId,
        /* DRAFT and no other status. There is no `status` parameter, so a caller
           cannot record terms as already governing anybody. */
        status: "DRAFT",
        refundsAllowed: terms.refundsAllowed,
        eligibilityConditions: terms.eligibilityConditions.join(CONDITION_SEPARATOR),
        refundWindowDays: terms.refundWindowDays,
        shippingRefundability: terms.shippingRefundability,
        procedureKind: terms.procedureKind,
        documentJson: JSON.stringify(document),
        contentHash: sellerRefundPolicyContentHash({ terms, document }),
        effectiveFrom: new Date(input.effectiveFrom),
        recordedByAccountId: input.recordedByAccountId,
        recordedAt: new Date(input.recordedAt),
        activeMarker: null,
      },
    });
    return rowToRecord(row);
  } catch (error) {
    if (error instanceof SellerRefundPolicyError) throw error;
    throw new SellerRefundPolicyError(
      "SELLER_REFUND_POLICY_PERSISTENCE_FAILURE",
      "The seller refund policy version could not be recorded",
    );
  }
}

/**
 * Activate one version, retiring whichever currently stands.
 *
 * One transaction, so there is never an instant with two active versions or none
 * — and a `RETIRED` version does not come back, because reactivating one would
 * make "which terms applied when" unanswerable.
 *
 * **Retirement does not touch a single Order.** Historical sales keep the version
 * they were sold under; that is the whole point of binding one.
 */
export async function activateSellerRefundPolicyVersion(
  input: {
    policyId: string;
    policyVersion: string;
    activatedAt: string;
  },
  deps: SellerRefundPolicyDeps = {},
): Promise<SellerRefundPolicyVersionRecord> {
  const db = deps.db ?? getPrisma();
  return await db.$transaction(async (tx) => {
    const current = await tx.sellerRefundPolicyVersionRow.findFirst({
      where: { policyId: input.policyId, status: "ACTIVE" },
    });
    if (current !== null) {
      await tx.sellerRefundPolicyVersionRow.update({
        where: { seq: current.seq },
        data: {
          status: "RETIRED",
          retiredAt: new Date(input.activatedAt),
          activeMarker: null,
        },
      });
    }

    const target = await tx.sellerRefundPolicyVersionRow.findUnique({
      where: {
        policyId_policyVersion: {
          policyId: input.policyId,
          policyVersion: input.policyVersion,
        },
      },
    });
    if (target === null) {
      throw new SellerRefundPolicyError(
        "SELLER_REFUND_POLICY_VERSION_NOT_FOUND",
        "No such seller refund policy version",
      );
    }
    if (target.status === "RETIRED") {
      throw new SellerRefundPolicyError(
        "SELLER_REFUND_POLICY_VERSION_RETIRED",
        "A retired refund policy version cannot be reactivated",
      );
    }

    const row = await tx.sellerRefundPolicyVersionRow.update({
      where: { seq: target.seq },
      data: {
        status: "ACTIVE",
        activatedAt: new Date(input.activatedAt),
        activeMarker: input.policyId,
      },
    });
    return rowToRecord(row);
  });
}

// — Reads —

/**
 * The version checkout would bind for one seller, or `null`.
 *
 * `null` is the honest answer for a seller who has declared nothing, and checkout
 * **refuses the sale** rather than selling under terms nobody stated.
 */
export async function getActiveSellerRefundPolicyVersionIn(
  tx: Tx,
  sellerParticipantId: string,
): Promise<SellerRefundPolicyVersionRecord | null> {
  const row = await tx.sellerRefundPolicyVersionRow.findFirst({
    where: { sellerParticipantId, status: "ACTIVE" },
  });
  return row === null ? null : rowToRecord(row);
}

export async function getActiveSellerRefundPolicyVersion(
  sellerParticipantId: string,
  deps: SellerRefundPolicyDeps = {},
): Promise<SellerRefundPolicyVersionRecord | null> {
  const db = deps.db ?? getPrisma();
  return getActiveSellerRefundPolicyVersionIn(db, sellerParticipantId);
}

/**
 * One exact version, whatever its status.
 *
 * **Deliberately not filtered by status.** A refund and a receipt read the
 * version an Order was sold under, and that version is very often `RETIRED` by
 * the time anybody asks.
 */
export async function readSellerRefundPolicyVersionIn(
  tx: Tx,
  policyId: string,
  policyVersion: string,
): Promise<SellerRefundPolicyVersionRecord | null> {
  const row = await tx.sellerRefundPolicyVersionRow.findUnique({
    where: { policyId_policyVersion: { policyId, policyVersion } },
  });
  return row === null ? null : rowToRecord(row);
}

export async function readSellerRefundPolicyVersion(
  policyId: string,
  policyVersion: string,
  deps: SellerRefundPolicyDeps = {},
): Promise<SellerRefundPolicyVersionRecord | null> {
  const db = deps.db ?? getPrisma();
  return readSellerRefundPolicyVersionIn(db, policyId, policyVersion);
}

/** Every version of one seller's policy, newest first. An operator's view. */
export async function listSellerRefundPolicyVersions(
  sellerParticipantId: string,
  deps: SellerRefundPolicyDeps = {},
): Promise<SellerRefundPolicyVersionRecord[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.sellerRefundPolicyVersionRow.findMany({
    where: { sellerParticipantId },
    orderBy: { recordedAt: "desc" },
  });
  return rows.map(rowToRecord);
}

export type { RefundEligibilityCondition };
