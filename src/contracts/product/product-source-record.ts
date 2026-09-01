/**
 * Product source-record persistence contract (Phase 0C) — offline, DB-free.
 *
 * The Product **source record** is the authoritative Monacado application record.
 * The Product **capsule candidate** is a derived semantic representation of ONE
 * identified source-record version. This module defines the normalized,
 * Zod-authored source-record schema and the deterministic mapping between:
 *
 *   authoritative source record → capsule candidate → source projection
 *
 * No Prisma/SQL/repository/migration/network/publication code lives here. The
 * published ANS capsule is finalised later (Registrar Node ID, capsule ID,
 * Publisher, publishedAt, policy refs) and is NOT the database source record.
 */

import { z } from "zod";
import {
  INTERNAL_CREATOR_ID_RE,
  INTERNAL_PRODUCT_ID_RE,
  SOURCE_RECORD_ID_RE,
} from "../capsule/identity";
import { SemVer } from "../capsule/envelope";
import { findForbiddenFields } from "../integrity/forbidden-fields";
import { candidateHash } from "../integrity/hash";
import { canonicalJsonString } from "../integrity/canonical-json";
import {
  ProductData,
  ProductCapsuleCandidate,
  type ProductCapsuleCandidate as ProductCapsuleCandidateT,
} from "./product.capsule";
import { generateProductCandidate } from "./product.factory";
import { ProductTaxClassification } from "./product-tax-classification";
import { MARKETPLACE_PARTICIPANT_ID_RE } from "../capsule/identity";

// — Opaque internal identifiers (distinct from ANS Node/capsule IDs) —

export const SourceRecordId = z
  .string()
  .regex(SOURCE_RECORD_ID_RE, "sourceRecordId must be opaque (mon:srec:<opaque>); not an ANS Node/capsule ID or URL");
export const InternalProductId = z
  .string()
  .regex(INTERNAL_PRODUCT_ID_RE, "internalProductId must be opaque (mon:product:<opaque>)");
export const InternalCreatorId = z
  .string()
  .regex(INTERNAL_CREATOR_ID_RE, "creator authority id must be opaque (mon:creator:<opaque>)");

// — Internal authority (distinct from published ANS Publisher metadata) —

export const AUTHORITY_SCOPES = ["product-facts"] as const;
export const AUTHORIZATION_STATES = ["authorized", "pending", "revoked"] as const;

/**
 * Minimum internal authority establishing who may author the Product facts.
 * This is INTERNAL and must never be published as a `sourceAuthority` capsule
 * field. It is not the full account/organisation/permissions system.
 */
export const CreatorParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "creatorParticipantId must be opaque (mon:mpart:<opaque>)");

export const InternalProductAuthority = z.strictObject({
  creatorId: InternalCreatorId,
  authorityScope: z.enum(AUTHORITY_SCOPES),
  authorizationState: z.enum(AUTHORIZATION_STATES),
  authorizationRef: z.string().min(1).optional(),

  /**
   * The MarketplaceParticipant holding creator authority over these facts
   * (Phase 1.18) — the resolution of `creatorId` into an identity marketplace
   * authorization can be evaluated against.
   *
   * **OPTIONAL FOR HISTORICAL READABILITY ONLY, and absence is not a default.**
   * Rows written before participants existed carry a `mon:creator:` reference
   * matching no participant, and a required field would make every one of them
   * unreadable — the same posture `taxClassification` and
   * `RegistrarReceipt.submissionAttemptId` take. A historical absence stays
   * readable and can never be repaired into a participant that did not exist.
   *
   * What absence means downstream is decided, not guessed:
   * `participantHoldsProductAuthority` grants Product authority to **nobody**
   * when this is missing, so an unattributed Product can back no Offer and no
   * seller-direct Listing. Fail-closed, not a fallback.
   *
   * It is set at the authenticated write path from the resolved acting
   * participant, never supplied as an authorization claim, and it is never
   * published: `authority` is excluded from projection as a whole object.
   */
  creatorParticipantId: CreatorParticipantId.optional(),
});
export type InternalProductAuthority = z.infer<typeof InternalProductAuthority>;

// — Internal record status (NOT ANS lifecycle) —

/**
 * Internal Monacado authoring/marketplace record status. Deliberately NOT named
 * lifecycle/lifecycleState/nodeState/capsuleState, and never copied into the
 * capsule candidate or published capsule. (Full activation/moderation workflow
 * is out of scope for this phase.)
 */
export const RECORD_STATUSES = ["draft", "authoring-complete", "withdrawn"] as const;
export const RecordStatus = z.enum(RECORD_STATUSES);
export type RecordStatus = z.infer<typeof RecordStatus>;

// — The normalized Product source record —

/** Base object shape (no cross-field refinements) — used for JSON Schema export. */
export const ProductSourceRecordBase = z.strictObject({
  // Source-record identity
  sourceRecordId: SourceRecordId,
  sourceRecordVersion: z.string().min(1),
  internalProductId: InternalProductId,
  // Source-system identity (constrained per Phase 0B.1)
  sourceSystem: z.literal("monacado"),
  sourceRecordType: z.literal("Product"),
  sourceClass: z.literal("governed-database-record"),
  // Internal authority
  authority: InternalProductAuthority,
  // Product facts (Product/Offer boundary enforced by ProductData + scan)
  facts: ProductData,
  // Record control (deterministic mapping/audit only)
  //
  // Timestamp semantics (four distinct events — never conflated):
  //   createdAt          : creation of the authoritative Product source record;
  //   updatedAt          : latest governed modification to that source record;
  //   acquiredAt         : time the source information represented by the
  //                        capsule was acquired;
  //   capsuleGeneratedAt : time the governed workflow generated THIS capsule
  //                        candidate from the identified source-record version.
  //
  // capsuleSemver is a persisted capsule-mapping control (not an authoritative
  // Product fact, not publication metadata) that makes candidate generation
  // deterministic; it is subject to reassessment when publication and Registrar
  // persistence are designed.
  capsuleSemver: SemVer,
  mappingVersion: z.string().min(1),
  recordStatus: RecordStatus,
  /**
   * How this Product is taxed, in Monacado's provider-neutral vocabulary
   * (Phase 1.6).
   *
   * **Not a Product fact and not a capsule field** — it sits here beside
   * `recordStatus` rather than inside `facts`, so it is versioned with the record
   * and never projected into the published capsule. See
   * `product-tax-classification.ts` for why a fiscal characterization does not
   * belong under creator authority.
   *
   * **Optional for backward compatibility only.** Every source version written
   * before this fact existed has none, and requiring it would invalidate them
   * retroactively — a source-version model exists so history stays readable.
   * **Absence is not a default**: a production tax calculation refuses an
   * unclassified Product rather than guessing a category, because a guessed
   * category is a tax rate nobody chose.
   */
  taxClassification: ProductTaxClassification.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  acquiredAt: z.iso.datetime(),
  capsuleGeneratedAt: z.iso.datetime(),
});

export const ProductSourceRecordSchema = ProductSourceRecordBase
  .superRefine((record, ctx) => {
    if (record.sourceRecordId === record.internalProductId) {
      ctx.addIssue({
        code: "custom",
        path: ["internalProductId"],
        message: "internalProductId must differ from sourceRecordId",
      });
    }
    for (const finding of findForbiddenFields(record)) {
      ctx.addIssue({
        code: "custom",
        path: finding.path.split(/[.[\]]+/).filter(Boolean),
        message: `Forbidden field "${finding.key}" at ${finding.path} (${finding.reason}); Offer/commercial/payment/private data must not enter the Product source record.`,
      });
    }
  });
export type ProductSourceRecord = z.infer<typeof ProductSourceRecordSchema>;

export interface SourceRecordValidationResult {
  ok: boolean;
  value?: ProductSourceRecord;
  errors?: string[];
}

export function validateProductSourceRecord(value: unknown): SourceRecordValidationResult {
  const result = ProductSourceRecordSchema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

// — Mapping: source record → capsule candidate —

/**
 * Deterministically map a source record to a Product capsule candidate. Validates
 * the record first, derives ANS provenance from source-record fields (Asserted),
 * preserves exact source identity/version, and introduces no publication metadata
 * and no undocumented defaults. Same valid record → same candidate + hash.
 *
 * Provenance field mapping (a pure function of the validated record — no
 * runtime clock is read):
 *   provenance.acquiredAt      ← record.acquiredAt
 *   provenance.generatedAt     ← record.capsuleGeneratedAt   (the capsule
 *                                generation event; NOT updatedAt/createdAt/
 *                                acquiredAt and never the system clock)
 *   provenance.generatorVersion← record.mappingVersion
 *   metadata.version           ← record.capsuleSemver
 */
export function productSourceRecordToCapsuleCandidate(record: unknown): ProductCapsuleCandidate {
  const parsed = ProductSourceRecordSchema.parse(record);
  return generateProductCandidate({
    source: {
      sourceRecordId: parsed.sourceRecordId,
      sourceRecordVersion: parsed.sourceRecordVersion,
      sourceSystem: parsed.sourceSystem,
      sourceRecordType: parsed.sourceRecordType,
      sourceClass: parsed.sourceClass,
      acquiredAt: parsed.acquiredAt,
      facts: parsed.facts,
    },
    version: parsed.capsuleSemver,
    generatedAt: parsed.capsuleGeneratedAt,
    generatorVersion: parsed.mappingVersion,
  });
}

// — Mapping: candidate → source projection (integrity comparison) —

/**
 * The subset of source-record fields represented in (and reconstructable from)
 * the capsule candidate. Fields intentionally EXCLUDED from the candidate — and
 * therefore from this projection — are internal and justified:
 *   - internalProductId  : internal application id, never published/derived;
 *   - authority          : internal authorship authority, never published;
 *   - recordStatus       : internal authoring state, never published;
 *   - taxClassification  : Monacado fiscal control fact (Phase 1.6), never
 *                          published and never a creator assertion;
 *   - createdAt          : internal audit timestamp (record creation);
 *   - updatedAt          : internal audit timestamp (last governed modification;
 *                          distinct from the capsule-generation event).
 * capsuleGeneratedAt IS recoverable via provenance.generatedAt.
 */
export interface ProductSourceProjection {
  sourceRecordId: string;
  sourceRecordVersion: string;
  sourceSystem: string;
  sourceRecordType: string;
  sourceClass: string;
  capsuleSemver: string;
  mappingVersion: string;
  acquiredAt: string;
  capsuleGeneratedAt: string;
  facts: ProductData;
}

/** Fields present on the source record but intentionally absent from the projection. */
export const PROJECTION_EXCLUDED_FIELDS = [
  "internalProductId",
  "authority",
  "recordStatus",
  /* Phase 1.6 — a Monacado fiscal control fact, never a published creator
     assertion. See product-tax-classification.ts. */
  "taxClassification",
  "createdAt",
  "updatedAt",
] as const;

export function productCapsuleCandidateToSourceProjection(
  candidate: ProductCapsuleCandidateT,
): ProductSourceProjection {
  const p = candidate.metadata.provenance;
  return {
    sourceRecordId: p.sourceRecordId,
    sourceRecordVersion: p.sourceRecordVersion,
    sourceSystem: p.sourceSystem,
    sourceRecordType: p.sourceRecordType,
    sourceClass: p.sourceClass,
    capsuleSemver: candidate.metadata.version,
    mappingVersion: p.generatorVersion,
    acquiredAt: p.acquiredAt,
    capsuleGeneratedAt: p.generatedAt,
    facts: candidate.data,
  };
}

// — Verification —

export interface MappingMismatch {
  field: string;
  expected: unknown;
  actual: unknown;
}

export type MappingVerification =
  | { ok: true; candidateHash: string }
  | { ok: false; reason: string; mismatches: MappingMismatch[] };

/**
 * Verify that a candidate is the exact deterministic mapping of a source record.
 * Returns a typed success (with the candidate hash) or a structured failure with
 * field-level diagnostics. Recomputes the expected candidate from the record and
 * compares canonical content and hash, plus granular projection fields.
 */
export function verifyProductSourceCandidateMapping(
  record: unknown,
  candidate: unknown,
): MappingVerification {
  const rec = ProductSourceRecordSchema.safeParse(record);
  if (!rec.success) {
    return { ok: false, reason: "invalid-source-record", mismatches: [] };
  }
  const cand = ProductCapsuleCandidate.safeParse(candidate);
  if (!cand.success) {
    return { ok: false, reason: "invalid-candidate", mismatches: [] };
  }

  const expected = productSourceRecordToCapsuleCandidate(rec.data);
  const mismatches: MappingMismatch[] = [];

  const expectedHash = candidateHash(expected);
  const actualHash = candidateHash(cand.data);
  if (expectedHash !== actualHash) {
    mismatches.push({ field: "candidateHash", expected: expectedHash, actual: actualHash });
  }

  const proj = productCapsuleCandidateToSourceProjection(cand.data);
  const check = (field: string, expectedVal: unknown, actualVal: unknown) => {
    if (canonicalJsonString(expectedVal) !== canonicalJsonString(actualVal)) {
      mismatches.push({ field, expected: expectedVal, actual: actualVal });
    }
  };
  check("sourceRecordId", rec.data.sourceRecordId, proj.sourceRecordId);
  check("sourceRecordVersion", rec.data.sourceRecordVersion, proj.sourceRecordVersion);
  check("sourceSystem", rec.data.sourceSystem, proj.sourceSystem);
  check("sourceRecordType", rec.data.sourceRecordType, proj.sourceRecordType);
  check("mappingVersion", rec.data.mappingVersion, proj.mappingVersion);
  check("capsuleSemver", rec.data.capsuleSemver, proj.capsuleSemver);
  check("capsuleGeneratedAt", rec.data.capsuleGeneratedAt, proj.capsuleGeneratedAt);
  check("facts", rec.data.facts, proj.facts);
  check("facts.relationships.creator", rec.data.facts.relationships.creator, proj.facts.relationships.creator);

  if (mismatches.length > 0) {
    return { ok: false, reason: "mapping-mismatch", mismatches };
  }
  return { ok: true, candidateHash: actualHash };
}

// — Revision —

export class SourceRecordRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRecordRevisionError";
  }
}

export interface ReviseSourceRecordInput {
  prior: ProductSourceRecord;
  /** Must be a NEW sourceRecordVersion. */
  sourceRecordVersion: string;
  updatedAt: string;
  /**
   * The generation timestamp for THIS mapping event. Required and must be
   * explicitly supplied by the caller for every revision — never inherited,
   * defaulted, copied, or derived from the prior record. It is an event
   * timestamp, not a uniqueness token: an explicitly supplied value equal to the
   * prior record's value is permitted.
   */
  capsuleGeneratedAt: string;
  facts?: ProductData;
  capsuleSemver?: string;
  mappingVersion?: string;
  recordStatus?: RecordStatus;
  /**
   * A corrected or newly supplied tax classification (Phase 1.6).
   *
   * Omitted, the prior version's value carries forward — the ordinary
   * immutable-version behaviour every other field here has. There is no way to
   * *clear* it: a Product that was classified does not become unclassified, and a
   * revision that could erase the fact would be a revision that could quietly
   * remove a sale's tax basis.
   */
  taxClassification?: ProductTaxClassification;
  /** Hostile inputs — if provided and changed, revision is rejected. */
  sourceRecordId?: string;
  internalProductId?: string;
}

/**
 * Produce a revised source record. Requires a new sourceRecordVersion and an
 * explicitly supplied capsuleGeneratedAt (the mapping event for this revision —
 * caller-supplied, never inherited; an equal value is permitted). Preserves
 * sourceRecordId and internalProductId (rejects attempts to change them); permits
 * governed Product fact changes; re-validates (rejecting Offer/payment fields).
 * No optimistic locking / transactions / concurrency here.
 */
export function reviseProductSourceRecord(input: ReviseSourceRecordInput): ProductSourceRecord {
  const prior = ProductSourceRecordSchema.parse(input.prior);

  if (input.sourceRecordId !== undefined && input.sourceRecordId !== prior.sourceRecordId) {
    throw new SourceRecordRevisionError("sourceRecordId is immutable and may not change on revision");
  }
  if (input.internalProductId !== undefined && input.internalProductId !== prior.internalProductId) {
    throw new SourceRecordRevisionError("internalProductId is immutable and may not change on revision");
  }
  if (input.sourceRecordVersion === prior.sourceRecordVersion) {
    throw new SourceRecordRevisionError("a meaningful revision requires a new sourceRecordVersion");
  }
  // capsuleGeneratedAt must be explicitly supplied for every revision (an event
  // timestamp, not a uniqueness token). It is never inherited/defaulted/derived
  // from the prior record. An explicitly supplied value EQUAL to the prior one
  // is legitimate (same-precision events, imported/deterministic workflows), so
  // equality is not rejected. The `next` object below always overrides the
  // spread's prior value with the explicit input — no silent carry-forward.
  if (input.capsuleGeneratedAt === undefined || input.capsuleGeneratedAt === null) {
    throw new SourceRecordRevisionError(
      "capsuleGeneratedAt must be explicitly supplied for every revision; it is never inherited from the prior record",
    );
  }

  const next = {
    ...prior,
    sourceRecordVersion: input.sourceRecordVersion,
    updatedAt: input.updatedAt,
    capsuleGeneratedAt: input.capsuleGeneratedAt,
    ...(input.facts !== undefined ? { facts: input.facts } : {}),
    ...(input.capsuleSemver !== undefined ? { capsuleSemver: input.capsuleSemver } : {}),
    ...(input.mappingVersion !== undefined ? { mappingVersion: input.mappingVersion } : {}),
    ...(input.recordStatus !== undefined ? { recordStatus: input.recordStatus } : {}),
    ...(input.taxClassification !== undefined
      ? { taxClassification: input.taxClassification }
      : {}),
  };
  return ProductSourceRecordSchema.parse(next);
}
