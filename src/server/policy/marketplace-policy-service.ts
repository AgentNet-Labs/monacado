/**
 * Marketplace policy governance (Phase 1.3) — SERVER ONLY.
 *
 * Mirrors `commercial-policy-service.ts` deliberately rather than inventing a
 * second convention: immutable versions, at most one `ACTIVE` enforced by the
 * `activeMarker` unique index, retired versions still readable so a past
 * acceptance stays legible.
 *
 * ## The content check
 *
 * Every read that returns a document **verifies the stored hash against the
 * source**. That is the one guarantee the whole design rests on: a governance row
 * saying "version 1.0.0 is active" is worthless if the prose behind 1.0.0 can
 * change underneath it. A mismatch is refused, not served — publishing terms
 * nobody governed is worse than publishing none.
 *
 * ## No effective-version fallback
 *
 * No `ACTIVE` version is a refusal, never "use the newest draft". The same rule
 * `0M.R1` applies, and the same reason `0M.9` made absent commerce approval mean
 * `NOT_APPROVED`: the safe reading of silence is "no".
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  MarketplacePolicyVersionRecord,
  type MarketplacePolicyDocument,
} from "../../contracts/marketplace/marketplace-policy";
import {
  MARKETPLACE_POLICY_DOCUMENTS,
  marketplacePolicyContentHash,
} from "../../contracts/marketplace/marketplace-policy-content";
import { getPrisma } from "../db/client";
import {
  NoActivePolicyError,
  PolicyContentMismatchError,
  PolicyError,
  PolicyPersistenceFailureError,
  PolicyVersionNotFoundError,
} from "./policy-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface PolicyServiceDeps {
  db?: Db;
  /**
   * The registry of policy source documents, keyed by version.
   *
   * Injected only so a test can exercise version succession without waiting for
   * a second real policy to be written. It is a **source** seam, not a content
   * seam: whatever registry is supplied, the hash is still derived from the
   * document and still checked on read, so nothing here weakens the binding.
   */
  documents?: ReadonlyMap<string, MarketplacePolicyDocument>;
}

const resolveDocument = (
  deps: PolicyServiceDeps,
  policyVersion: string,
): MarketplacePolicyDocument | null =>
  (deps.documents ?? MARKETPLACE_POLICY_DOCUMENTS).get(policyVersion) ?? null;

interface VersionRow {
  policyId: string;
  policyVersion: string;
  status: string;
  title: string;
  contentRef: string;
  contentHash: string;
  requiresReacceptance: boolean;
  effectiveFrom: Date;
  recordedByAccountId: string;
  recordedAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

function rowToRecord(row: VersionRow): MarketplacePolicyVersionRecord {
  const parsed = MarketplacePolicyVersionRecord.safeParse({
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    status: row.status,
    title: row.title,
    contentRef: row.contentRef,
    contentHash: row.contentHash,
    requiresReacceptance: row.requiresReacceptance,
    effectiveFrom: row.effectiveFrom.toISOString(),
    recordedByAccountId: row.recordedByAccountId,
    recordedAt: row.recordedAt.toISOString(),
    activatedAt: row.activatedAt === null ? null : row.activatedAt.toISOString(),
    retiredAt: row.retiredAt === null ? null : row.retiredAt.toISOString(),
  });
  if (!parsed.success) {
    throw new PolicyError("CORRUPT_POLICY_VERSION", "A persisted policy version is malformed");
  }
  return parsed.data;
}

/** Register the stable policy identity. Idempotent. */
export async function ensureMarketplacePolicy(
  input: { policyId: string; label: string; now: string },
  deps: PolicyServiceDeps = {},
): Promise<void> {
  const db = deps.db ?? getPrisma();
  await db.marketplacePolicy.upsert({
    where: { id: input.policyId },
    create: { id: input.policyId, label: input.label, createdAt: new Date(input.now) },
    update: {},
  });
}

/**
 * Record one immutable version, created `DRAFT`.
 *
 * The content hash is **derived from the source document**, never supplied: a
 * caller-provided hash could name content that does not exist, which is exactly
 * the binding this is meant to prevent.
 */
export async function recordMarketplacePolicyVersion(
  input: {
    policyId: string;
    policyVersion: string;
    contentRef: string;
    requiresReacceptance: boolean;
    effectiveFrom: string;
    recordedByAccountId: string;
    recordedAt: string;
  },
  deps: PolicyServiceDeps = {},
): Promise<MarketplacePolicyVersionRecord> {
  const db = deps.db ?? getPrisma();
  const document = resolveDocument(deps, input.policyVersion);
  if (document === null) throw new PolicyVersionNotFoundError();

  try {
    const row = await db.marketplacePolicyVersionRow.create({
      data: {
        policyId: input.policyId,
        policyVersion: input.policyVersion,
        /* DRAFT and no other status. There is no `status` parameter, so a caller
           cannot record a version as already governing anybody. */
        status: "DRAFT",
        title: document.title,
        contentRef: input.contentRef,
        contentHash: marketplacePolicyContentHash(document),
        requiresReacceptance: input.requiresReacceptance,
        effectiveFrom: new Date(input.effectiveFrom),
        recordedByAccountId: input.recordedByAccountId,
        recordedAt: new Date(input.recordedAt),
        activeMarker: null,
      },
    });
    return rowToRecord(row);
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyPersistenceFailureError("recordMarketplacePolicyVersion", error);
  }
}

/**
 * Activate one version, retiring whichever currently stands.
 *
 * One transaction, so there is never an instant with two active versions or none.
 * A `RETIRED` version does not come back: reactivating one would make "which
 * terms applied when" unanswerable.
 */
export async function activateMarketplacePolicyVersion(
  input: {
    policyId: string;
    policyVersion: string;
    activatedByAccountId: string;
    activatedAt: string;
  },
  deps: PolicyServiceDeps = {},
): Promise<MarketplacePolicyVersionRecord> {
  const db = deps.db ?? getPrisma();
  return await db.$transaction(async (tx) => {
    const current = await tx.marketplacePolicyVersionRow.findFirst({
      where: { policyId: input.policyId, status: "ACTIVE" },
    });
    if (current !== null) {
      await tx.marketplacePolicyVersionRow.update({
        where: { seq: current.seq },
        data: {
          status: "RETIRED",
          retiredAt: new Date(input.activatedAt),
          activeMarker: null,
        },
      });
    }
    const target = await tx.marketplacePolicyVersionRow.findUnique({
      where: {
        policyId_policyVersion: {
          policyId: input.policyId,
          policyVersion: input.policyVersion,
        },
      },
    });
    if (target === null) throw new PolicyVersionNotFoundError();
    if (target.status === "RETIRED") {
      throw new PolicyError(
        "POLICY_VERSION_RETIRED",
        "A retired policy version cannot be reactivated",
      );
    }
    const row = await tx.marketplacePolicyVersionRow.update({
      where: { seq: target.seq },
      data: {
        status: "ACTIVE",
        activeMarker: input.policyId,
        activatedAt: new Date(input.activatedAt),
      },
    });
    return rowToRecord(row);
  });
}

// — Reads —

/** The version currently governing, or `null`. */
export async function getActiveMarketplacePolicyVersionIn(
  tx: Tx,
  policyId: string,
): Promise<MarketplacePolicyVersionRecord | null> {
  const row = await tx.marketplacePolicyVersionRow.findFirst({
    where: { policyId, status: "ACTIVE" },
  });
  return row === null ? null : rowToRecord(row);
}

export async function getActiveMarketplacePolicyVersion(
  policyId: string,
  deps: PolicyServiceDeps = {},
): Promise<MarketplacePolicyVersionRecord | null> {
  return getActiveMarketplacePolicyVersionIn(deps.db ?? getPrisma(), policyId);
}

export async function getMarketplacePolicyVersion(
  policyId: string,
  policyVersion: string,
  deps: PolicyServiceDeps = {},
): Promise<MarketplacePolicyVersionRecord | null> {
  const db = deps.db ?? getPrisma();
  const row = await db.marketplacePolicyVersionRow.findUnique({
    where: { policyId_policyVersion: { policyId, policyVersion } },
  });
  return row === null ? null : rowToRecord(row);
}

/**
 * The governed record **and** the content it binds to, checked against each other.
 *
 * The check is the point. A governance row asserting a version is worthless if
 * the prose behind it can move; a mismatch means exactly that has happened, and
 * it is refused rather than served.
 */
export async function readMarketplacePolicy(
  policyId: string,
  policyVersion: string,
  deps: PolicyServiceDeps = {},
): Promise<{ version: MarketplacePolicyVersionRecord; document: MarketplacePolicyDocument }> {
  const version = await getMarketplacePolicyVersion(policyId, policyVersion, deps);
  if (version === null) throw new PolicyVersionNotFoundError();

  const document = resolveDocument(deps, policyVersion);
  if (document === null) throw new PolicyVersionNotFoundError();
  if (marketplacePolicyContentHash(document) !== version.contentHash) {
    throw new PolicyContentMismatchError(policyVersion);
  }
  return { version, document };
}

/** The active version and its verified content. Refuses when none is active. */
export async function readActiveMarketplacePolicy(
  policyId: string,
  deps: PolicyServiceDeps = {},
): Promise<{ version: MarketplacePolicyVersionRecord; document: MarketplacePolicyDocument }> {
  const active = await getActiveMarketplacePolicyVersion(policyId, deps);
  if (active === null) throw new NoActivePolicyError();
  return readMarketplacePolicy(policyId, active.policyVersion, deps);
}
