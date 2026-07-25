/**
 * Product capsule factory (Phase 0B.1) — offline, database-free.
 *
 * Generation (candidate) is separate from publication (finalisation), per ADR
 * §5 and §11. Generation builds a deterministic candidate from an authoritative
 * source record. Finalisation attaches all mandatory ANS publication metadata
 * (Registrar-issued Node ID, Publisher, publishedAt, policy references, capsule
 * ID) and produces an immutable published capsule. No publication worker,
 * network, or database work occurs here. Callers pass explicit synthetic ids and
 * timestamps so construction is deterministic.
 */

import {
  AN_O_CONTEXT_REF,
  COMMERCE_CONTEXT_REF,
} from "../ontology/commerce.context";
import type { PolicyRef, ProvenanceRecord, SemVer, SourceClass } from "../capsule/envelope";
import { withPublishedContentHash } from "../integrity/hash";
import {
  CAPSULE_GENERATOR_ID,
  GENERATOR_VERSION,
  assertMonacadoPublisher,
} from "./product.authority";
import {
  PRODUCT_TYPE,
  ProductCapsuleCandidate,
  PublishedProductCapsule,
  type ProductData,
} from "./product.capsule";

/** An authoritative Monacado source record (the DB record; system of record). */
export interface CapsuleSourceInput {
  sourceRecordId: string;
  sourceRecordVersion: string;
  sourceSystem: string;
  sourceRecordType: string;
  sourceClass: SourceClass;
  acquiredAt: string;
  /** The creator-authoritative Product facts held by the record. */
  facts: ProductData;
}

export interface GenerateCandidateInput {
  source: CapsuleSourceInput;
  /** Intended semantic version for this capsule. */
  version: SemVer;
  /** Deterministic generation timestamp (no Date.now). */
  generatedAt: string;
  /** Generator/mapping version stamped into provenance (defaults to GENERATOR_VERSION). */
  generatorVersion?: string;
}

function buildProvenance(
  source: CapsuleSourceInput,
  generatedAt: string,
  generatorVersion: string,
): ProvenanceRecord {
  return {
    source: `${source.sourceSystem}:${source.sourceRecordType}:${source.sourceRecordId}@${source.sourceRecordVersion}`,
    method: "governed-database-record-projection",
    acquiredAt: source.acquiredAt,
    assertionKind: "Asserted",
    sourceClass: source.sourceClass,
    sourceSystem: source.sourceSystem,
    sourceRecordType: source.sourceRecordType,
    sourceRecordId: source.sourceRecordId,
    sourceRecordVersion: source.sourceRecordVersion,
    generatedAt,
    generatorVersion,
  };
}

/** Generate a deterministic pre-publication candidate from a source record. */
export function generateProductCandidate(input: GenerateCandidateInput): ProductCapsuleCandidate {
  const candidate = {
    "@context": [COMMERCE_CONTEXT_REF, AN_O_CONTEXT_REF],
    "@type": PRODUCT_TYPE,
    metadata: {
      version: input.version,
      provenance: buildProvenance(
        input.source,
        input.generatedAt,
        input.generatorVersion ?? GENERATOR_VERSION,
      ),
    },
    data: input.source.facts,
  };
  return ProductCapsuleCandidate.parse(candidate);
}

export interface FinalizeInput {
  candidate: ProductCapsuleCandidate;
  capsuleId: string;
  /** Registrar-issued opaque ANS Node ID. */
  bindsToNode: string;
  /** Must be the Monacado Publisher (not the generator). */
  publishedBy: string;
  publishedAt: string;
  nodePolicy: PolicyRef;
  capsulePolicy: PolicyRef;
  supersedes?: string;
  revokes?: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Finalise a candidate into an immutable, ANS-conformant published capsule. */
export function finalizeProductCapsule(input: FinalizeInput): PublishedProductCapsule {
  assertMonacadoPublisher(input.publishedBy);

  const draft = {
    "@context": input.candidate["@context"],
    "@type": input.candidate["@type"],
    metadata: {
      capsuleId: input.capsuleId,
      bindsToNode: input.bindsToNode,
      publishedBy: input.publishedBy,
      publishedAt: input.publishedAt,
      version: input.candidate.metadata.version,
      provenance: input.candidate.metadata.provenance,
      nodePolicy: input.nodePolicy,
      capsulePolicy: input.capsulePolicy,
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.revokes !== undefined ? { revokes: input.revokes } : {}),
    },
    data: input.candidate.data,
  };

  const hashed = withPublishedContentHash(draft);
  return deepFreeze(PublishedProductCapsule.parse(hashed));
}

export class ProductRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductRevisionError";
  }
}

export interface ReviseSourceInput {
  current: PublishedProductCapsule;
  source: CapsuleSourceInput;
  version: SemVer;
  generatedAt: string;
}

/**
 * Produce a new candidate from a revised source record. Enforces the revision
 * rules (ADR / Phase 0B.1): a meaningful revision requires a NEW source-record
 * version and a NEW capsule semver. The caller finalises with a new capsule ID
 * and `supersedes` = the prior capsule ID.
 */
export function reviseProductSource(input: ReviseSourceInput): ProductCapsuleCandidate {
  if (input.source.sourceRecordVersion === input.current.metadata.provenance.sourceRecordVersion) {
    throw new ProductRevisionError(
      "A meaningful Product revision requires a new source-record version.",
    );
  }
  if (input.version === input.current.metadata.version) {
    throw new ProductRevisionError(
      "A meaningful Product revision requires a new capsule semantic version.",
    );
  }
  return generateProductCandidate({
    source: input.source,
    version: input.version,
    generatedAt: input.generatedAt,
  });
}

export { CAPSULE_GENERATOR_ID };
