/**
 * Product publication preparation (Phase 0E.2) — one narrow, fully OFFLINE
 * operation: `prepareProductPublication`.
 *
 * It regenerates the capsule deterministically from the EXACT persisted
 * source-record version (Phase 0C mapper), finalises it (Phase 0B.1 finaliser),
 * validates it, and durably records BOTH the immutable publication and its one
 * REGISTER outbox item **in a single transaction**.
 *
 * It does NOT: call the network, contact a Publisher/Registrar/Resolver, claim
 * or process outbox work, retry, record receipts, reconcile, or dispose of
 * payloads. No capsule-generation or hashing logic is re-implemented here — the
 * existing contract functions are reused.
 */

import { Prisma } from "@prisma/client";
import {
  ProductPublicationPreparationInput,
  ProductPublicationPreparationResult,
  ProductPublicationOutboxWrite,
  ProductPublicationWrite,
  IDEMPOTENCY_COMPARED_FIELDS,
  deriveOutboxId,
  hasSupersedesRevokesConflict,
  outboxPayloadHash,
  publicationIdempotencyKey,
  type ProductPublicationPreparationResult as PreparationResult,
} from "../../contracts/product/product-publication";
import {
  candidateHash as computeCandidateHash,
  publishedContentHash as computePublishedContentHash,
} from "../../contracts/integrity/hash";
import { productSourceRecordToCapsuleCandidate } from "../../contracts/product/product-source-record";
import type { ProductSourceRecord } from "../../contracts/product/product-source-record";
import { finalizeProductCapsule } from "../../contracts/product/product.factory";
import { ProductPublisherError } from "../../contracts/product/product.authority";
import {
  validatePublishedProductCapsule,
  type PublishedProductCapsule,
} from "../../contracts/product/product.capsule";
import { getPrisma } from "../db/client";
import { versionRowToDomain } from "./persistence-mapper";
import {
  domainToOutboxCreateInput,
  domainToPublicationCreateInput,
  outboxRowToDomain,
  publicationRowToDomain,
} from "./publication-mapper";
import { DatabaseError } from "./errors";
import { ProductNodeNotFoundError } from "./node-errors";
import {
  AtomicPreparationFailureError,
  DuplicateCapsuleIdError,
  IdempotencyConflictError,
  InvalidPublicationInputError,
  NodeNotEligibleError,
  ProductNodeMismatchError,
  ProductPublicationError,
  ProductSourceMismatchError,
  PublicationConflictError,
  PublicationProductNotFoundError,
  SourceRecordVersionNotFoundError,
} from "./publication-errors";

type Db = ReturnType<typeof getPrisma>;

/** The only Node lifecycle state eligible for publication preparation. */
export const PUBLICATION_ELIGIBLE_LIFECYCLE_STATE = "Active" as const;

/** The only outbox operation supported in this phase. */
const OPERATION_TYPE = "REGISTER" as const;

/** Normalise an ISO timestamp so equal instants compare equal. */
const instant = (value: string): string => new Date(value).toISOString();

const zodIssues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export class ProductPublicationService {
  constructor(private readonly db: Db = getPrisma()) {}

  /**
   * Prepare (or idempotently return) the durable publication record and its one
   * PENDING REGISTER outbox item for an exact Product source-record version.
   */
  async prepareProductPublication(input: unknown): Promise<PreparationResult> {
    const req = this.parseInput(input);

    // — 1-2. Product identity and the EXACT immutable source-record version —
    const product = await this.db.product.findUnique({
      where: { internalProductId: req.internalProductId },
    });
    if (!product) throw new PublicationProductNotFoundError();

    const versionRow = await this.db.productSourceRecordVersionRow.findUnique({
      where: {
        sourceRecordId_sourceRecordVersion: {
          sourceRecordId: req.sourceRecordId,
          sourceRecordVersion: req.sourceRecordVersion,
        },
      },
    });
    if (!versionRow) throw new SourceRecordVersionNotFoundError();

    const record: ProductSourceRecord = versionRowToDomain(versionRow);
    if (record.internalProductId !== req.internalProductId) {
      throw new ProductSourceMismatchError();
    }

    // — 3-5. Product Node: exists, belongs to this Product, and is Active —
    const nodeRow = await this.db.productNode.findUnique({ where: { nodeId: req.nodeId } });
    if (!nodeRow) throw new ProductNodeNotFoundError();
    if (nodeRow.internalProductId !== req.internalProductId) {
      throw new ProductNodeMismatchError();
    }
    if (nodeRow.lifecycleState !== PUBLICATION_ELIGIBLE_LIFECYCLE_STATE) {
      throw new NodeNotEligibleError(nodeRow.lifecycleState);
    }

    // The stated capsule semver must match the source record's mapping control,
    // so a stale or mismatched intent is rejected rather than silently overridden.
    if (req.capsuleSemver !== record.capsuleSemver) {
      throw new InvalidPublicationInputError(
        "capsuleSemver does not match the source-record version's capsuleSemver mapping control",
        ["capsuleSemver: inconsistent with the persisted source record"],
      );
    }

    // — 6-9. Regenerate, finalise, validate, hash —
    const candidate = productSourceRecordToCapsuleCandidate(record);
    const candidateHash = computeCandidateHash(candidate);

    const capsule = this.finalize(req, candidate);
    const validated = validatePublishedProductCapsule(capsule);
    if (!validated.ok || !validated.capsule) {
      throw new InvalidPublicationInputError(
        "Finalised Product capsule failed validation",
        validated.errors ?? [],
      );
    }
    const published: PublishedProductCapsule = validated.capsule;

    // Verify the capsule's own content hash, then hash the payload as stored.
    const recomputedContentHash = computePublishedContentHash(published);
    if (recomputedContentHash !== published.metadata.contentHash) {
      throw new InvalidPublicationInputError("Published capsule contentHash verification failed", [
        "metadata.contentHash: does not match the canonical capsule content",
      ]);
    }
    const publishedContentHash = published.metadata.contentHash;
    const payloadHash = outboxPayloadHash(published);

    // — Deterministic idempotency identity —
    const idempotencyKey = publicationIdempotencyKey({
      nodeId: req.nodeId,
      sourceRecordId: req.sourceRecordId,
      sourceRecordVersion: req.sourceRecordVersion,
      capsuleId: req.capsuleId,
      operationType: OPERATION_TYPE,
    });
    const outboxId = deriveOutboxId(idempotencyKey);

    const submitted = {
      capsuleId: req.capsuleId,
      capsuleSemver: req.capsuleSemver,
      publishedBy: req.publishedBy,
      publishedAt: instant(req.publishedAt),
      nodePolicyRef: req.nodePolicy.ref,
      nodePolicyVersion: req.nodePolicy.version,
      capsulePolicyRef: req.capsulePolicy.ref,
      capsulePolicyVersion: req.capsulePolicy.version,
      candidateHash,
      publishedContentHash,
      supersedesCapsuleId: req.supersedes,
      revokesCapsuleId: req.revokes,
    };

    // — Idempotent repeat? (service-level comparison on top of DB uniqueness) —
    const existing = await this.db.publicationOutbox.findUnique({
      where: { idempotencyKey },
      include: { publication: true },
    });
    if (existing) {
      const publication = publicationRowToDomain(existing.publication);
      const outbox = outboxRowToDomain(existing);
      const conflicts = IDEMPOTENCY_COMPARED_FIELDS.filter(
        (f) => (publication[f] ?? undefined) !== (submitted[f] ?? undefined),
      ) as string[];
      if (outbox.payloadHash !== payloadHash) conflicts.push("payloadHash");
      if (conflicts.length > 0) {
        throw new IdempotencyConflictError(
          "A publication with this preparation identity already exists with conflicting values",
          conflicts,
        );
      }
      return this.result(publication, outbox, true);
    }

    // — Non-idempotent conflicts that DB uniqueness would also catch —
    await this.assertNoConflictingPublication(req);

    // — Atomic preparation —
    return await this.commit(req, {
      idempotencyKey,
      outboxId,
      candidateHash,
      publishedContentHash,
      payloadHash,
      payload: published,
      mappingVersion: record.mappingVersion,
      capsuleGeneratedAt: record.capsuleGeneratedAt,
    });
  }

  // — Input —

  private parseInput(input: unknown): ProductPublicationPreparationInput {
    const parsed = ProductPublicationPreparationInput.safeParse(input);
    if (!parsed.success) {
      throw new InvalidPublicationInputError(
        "Invalid Product publication preparation input",
        zodIssues(parsed.error),
      );
    }
    // Supersession and revocation are mutually exclusive assertions.
    if (hasSupersedesRevokesConflict(parsed.data)) {
      throw new InvalidPublicationInputError(
        "supersedes and revokes are mutually exclusive; a publication may assert at most one",
        ["supersedes/revokes: both present"],
      );
    }
    return parsed.data;
  }

  /** Finalise the candidate, mapping contract failures to structured input errors. */
  private finalize(
    req: ProductPublicationPreparationInput,
    candidate: ReturnType<typeof productSourceRecordToCapsuleCandidate>,
  ): PublishedProductCapsule {
    try {
      return finalizeProductCapsule({
        candidate,
        capsuleId: req.capsuleId,
        bindsToNode: req.nodeId,
        publishedBy: req.publishedBy,
        publishedAt: req.publishedAt,
        nodePolicy: req.nodePolicy,
        capsulePolicy: req.capsulePolicy,
        ...(req.supersedes !== undefined ? { supersedes: req.supersedes } : {}),
        ...(req.revokes !== undefined ? { revokes: req.revokes } : {}),
      });
    } catch (e) {
      if (e instanceof ProductPublisherError) {
        throw new InvalidPublicationInputError(e.message, ["publishedBy: not the Monacado Publisher"]);
      }
      if (e instanceof Error && e.name === "ZodError") {
        throw new InvalidPublicationInputError("Product capsule finalisation failed validation", [
          e.message,
        ]);
      }
      throw e;
    }
  }

  // — Conflict pre-checks —

  private async assertNoConflictingPublication(
    req: ProductPublicationPreparationInput,
  ): Promise<void> {
    const byCapsule = await this.db.productPublication.findUnique({
      where: { capsuleId: req.capsuleId },
    });
    if (byCapsule) throw new DuplicateCapsuleIdError();

    const bySourceVersion = await this.db.productPublication.findUnique({
      where: {
        nodeId_sourceRecordId_sourceRecordVersion: {
          nodeId: req.nodeId,
          sourceRecordId: req.sourceRecordId,
          sourceRecordVersion: req.sourceRecordVersion,
        },
      },
    });
    if (bySourceVersion) {
      throw new PublicationConflictError(
        "A different publication already exists for this Node and source-record version",
        ["capsuleId"],
      );
    }

    const byPublicationId = await this.db.productPublication.findUnique({
      where: { publicationId: req.publicationId },
    });
    if (byPublicationId) {
      throw new PublicationConflictError("This publicationId is already in use", ["publicationId"]);
    }
  }

  // — Atomic commit —

  private async commit(
    req: ProductPublicationPreparationInput,
    derived: {
      idempotencyKey: string;
      outboxId: string;
      candidateHash: string;
      publishedContentHash: string;
      payloadHash: string;
      payload: PublishedProductCapsule;
      mappingVersion: string;
      capsuleGeneratedAt: string;
    },
  ): Promise<PreparationResult> {
    // Validated domain write models — never loose records.
    const publicationWrite = ProductPublicationWrite.parse({
      publicationId: req.publicationId,
      internalProductId: req.internalProductId,
      sourceRecordId: req.sourceRecordId,
      sourceRecordVersion: req.sourceRecordVersion,
      nodeId: req.nodeId,
      capsuleId: req.capsuleId,
      capsuleSemver: req.capsuleSemver,
      publishedBy: req.publishedBy,
      publishedAt: req.publishedAt,
      nodePolicyRef: req.nodePolicy.ref,
      nodePolicyVersion: req.nodePolicy.version,
      capsulePolicyRef: req.capsulePolicy.ref,
      capsulePolicyVersion: req.capsulePolicy.version,
      candidateHash: derived.candidateHash,
      publishedContentHash: derived.publishedContentHash,
      mappingVersion: derived.mappingVersion,
      capsuleGeneratedAt: derived.capsuleGeneratedAt,
      ...(req.supersedes !== undefined ? { supersedesCapsuleId: req.supersedes } : {}),
      ...(req.revokes !== undefined ? { revokesCapsuleId: req.revokes } : {}),
      // The publication row is created PREPARED and advanced to QUEUED once its
      // outbox item exists — both inside the one transaction below.
      publicationStatus: "PREPARED",
      // Nothing has been submitted to a Registrar, so there is no verdict and
      // nothing to reconcile. Only recording a receipt (Phase 0E.4) changes these.
      registrationState: "NOT_SUBMITTED",
      reconciliationState: "NOT_REQUIRED",
      // Nothing has gone wrong, so there is nothing for a person to decide.
      remediationState: "NOT_REQUIRED",
    } satisfies ProductPublicationWrite);

    const outboxWrite = ProductPublicationOutboxWrite.parse({
      outboxId: derived.outboxId,
      publicationId: req.publicationId,
      idempotencyKey: derived.idempotencyKey,
      operationType: OPERATION_TYPE,
      payload: derived.payload,
      payloadHash: derived.payloadHash,
      outboxStatus: "PENDING",
      attemptCount: 0,
      availableAt: req.availableAt,
    } satisfies ProductPublicationOutboxWrite);

    try {
      const { publicationRow, outboxRow } = await this.db.$transaction(async (tx) => {
        await tx.productPublication.create({ data: domainToPublicationCreateInput(publicationWrite) });
        const createdOutbox = await tx.publicationOutbox.create({
          data: domainToOutboxCreateInput(outboxWrite),
        });
        // Publication and outbox both exist — the publication is now QUEUED.
        const queued = await tx.productPublication.update({
          where: { publicationId: req.publicationId },
          data: { publicationStatus: "QUEUED" },
        });
        return { publicationRow: queued, outboxRow: createdOutbox };
      });

      return this.result(publicationRowToDomain(publicationRow), outboxRowToDomain(outboxRow), false);
    } catch (e) {
      throw this.mapCommitError(e);
    }
  }

  /**
   * Map a failed atomic preparation to a structured error. Unique-constraint
   * violations are reported as the specific conflict they are; anything else is
   * an atomic-preparation or database failure. No connection details, credentials,
   * or payload contents are ever included.
   */
  private mapCommitError(e: unknown): Error {
    if (e instanceof ProductPublicationError) return e;

    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = String(
        (e.meta as { target?: unknown } | undefined)?.target ?? "",
      );
      if (target.includes("capsuleId")) {
        return new DuplicateCapsuleIdError("This capsule ID is already published", e.code);
      }
      if (target.includes("idempotencyKey")) {
        return new PublicationConflictError(
          "A publication with this preparation identity already exists",
          ["idempotencyKey"],
          e.code,
        );
      }
      if (target.includes("outboxId")) {
        return new PublicationConflictError("This outbox item already exists", ["outboxId"], e.code);
      }
      if (target.includes("publicationId")) {
        return new PublicationConflictError("This publicationId is already in use", ["publicationId"], e.code);
      }
      return new PublicationConflictError(
        "A conflicting publication already exists for this Node and source-record version",
        ["nodeId", "sourceRecordId", "sourceRecordVersion"],
        e.code,
      );
    }

    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      return new AtomicPreparationFailureError(
        "Publication preparation could not be committed atomically",
        e.code,
      );
    }

    return new DatabaseError(
      "Publication preparation failed",
      e instanceof Error ? e.message : undefined,
    );
  }

  private result(
    publication: ReturnType<typeof publicationRowToDomain>,
    outbox: ReturnType<typeof outboxRowToDomain>,
    alreadyPrepared: boolean,
  ): PreparationResult {
    return ProductPublicationPreparationResult.parse({ publication, outbox, alreadyPrepared });
  }

  // — Reads (validated domain objects only) —

  /** Read a prepared publication by its opaque publication ID. */
  async getProductPublication(publicationId: string) {
    const row = await this.db.productPublication.findUnique({ where: { publicationId } });
    if (!row) throw new PublicationProductNotFoundError("Publication not found");
    return publicationRowToDomain(row);
  }

  /** Read the REGISTER outbox item for a prepared publication. */
  async getPublicationOutbox(publicationId: string) {
    const row = await this.db.publicationOutbox.findUnique({ where: { publicationId } });
    if (!row) throw new PublicationProductNotFoundError("Publication outbox item not found");
    return outboxRowToDomain(row);
  }
}
