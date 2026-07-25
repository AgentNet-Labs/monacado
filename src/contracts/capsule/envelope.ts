/**
 * Capsule envelope building blocks (ANS Core v2.0 §3; ADR §10, §11).
 *
 * ANS requires a capsule to have exactly the top-level members `@context`,
 * `@type`, `metadata`, `data`. Identity, node binding, versioning, publication,
 * provenance, policy linkage, supersession/revocation, and integrity live in
 * `metadata`; factual claims live in `data`. Capsules carry NO lifecycle state
 * (that is a Registrar-managed Node property).
 *
 * Zod is the single authored executable schema (ADR §8); types are inferred.
 * AN-O terminology is used for ANS-defined concepts; Monacado-specific terms are
 * added only for genuine extensions.
 */

import { z } from "zod";
import { ANS_NODE_ID_RE, CAPSULE_ID_RE, PUBLISHER_ID_RE, looksSemantic } from "./identity";

/** `@context`: one or more ontology IRIs / inline contexts (ANS §3). */
export const ContextValue = z.union([
  z.url(),
  z.record(z.string(), z.unknown()),
  z.array(z.union([z.url(), z.record(z.string(), z.unknown())])).min(1),
]);

/** `@type`: the primary semantic class (optionally multiple). */
export const TypeValue = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** Semantic version string MAJOR.MINOR.PATCH (ANS §3 — semver mandatory). */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const SemVer = z.string().regex(SEMVER_RE, "capsule version must be semver MAJOR.MINOR.PATCH");
export type SemVer = z.infer<typeof SemVer>;

/** ANS assertion kind (AN-O an:assertionKind). Product facts are Asserted. */
export const ASSERTION_KINDS = ["Asserted", "Inferred"] as const;
export const AssertionKind = z.enum(ASSERTION_KINDS);
export type AssertionKind = z.infer<typeof AssertionKind>;

/** Governed source classes. This phase supports at least a governed DB record. */
export const SOURCE_CLASSES = ["governed-database-record", "document", "telemetry"] as const;
export const SourceClass = z.enum(SOURCE_CLASSES);
export type SourceClass = z.infer<typeof SourceClass>;

/** ANS Node ID — opaque, non-semantic, Registrar-issued (AN-O an:nodeId). */
export const AnsNodeId = z
  .string()
  .regex(ANS_NODE_ID_RE, "ANS Node ID must be opaque (an:node:<opaque>)")
  .refine((v) => !looksSemantic(v.replace(/^an:node:/, "")), {
    message: "ANS Node ID must not encode entity type, name, slug, URL, or business meaning",
  });

/** Capsule ID — opaque, one per immutable capsule version (AN-O an:capsuleId). */
export const CapsuleId = z.string().regex(CAPSULE_ID_RE, "Capsule ID must be opaque (an:capsule:<opaque>)");

/** Publisher ID — the walled-garden Publisher, Monacado (AN-O an:publishedBy). */
export const PublisherId = z.string().regex(PUBLISHER_ID_RE, "Publisher ID must be an:publisher:<id>");

/** Content hash (Monacado integrity extension; ANS §9 permits hashes). */
export const ContentHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Structural policy reference (ANS §3 — identifier/URI + version or hash). */
export const PolicyRef = z.strictObject({
  ref: z.string().min(1),
  version: z.string().min(1),
});
export type PolicyRef = z.infer<typeof PolicyRef>;

/**
 * Provenance record (ANS §3 Provenance; AN-O ProvenanceRecord) plus narrow
 * Monacado extensions for exact source-record traceability. There is NO
 * `sourceAuthority` field — factual authority is expressed via the ANS Publisher
 * (an:publishedBy), and internal authorisation is kept conceptually separate.
 */
export const ProvenanceRecord = z.strictObject({
  // ANS-required
  source: z.string().min(1),
  method: z.string().min(1),
  acquiredAt: z.iso.datetime(),
  assertionKind: AssertionKind,
  // Monacado source-record traceability extensions
  sourceClass: SourceClass,
  sourceSystem: z.string().min(1),
  sourceRecordType: z.string().min(1),
  sourceRecordId: z.string().min(1),
  sourceRecordVersion: z.string().min(1),
  generatedAt: z.iso.datetime(),
  generatorVersion: z.string().min(1),
});
export type ProvenanceRecord = z.infer<typeof ProvenanceRecord>;

/**
 * Candidate metadata — pre-publication. Carries the intended version and source
 * provenance only. It deliberately does NOT fabricate a Registrar-issued Node
 * ID, publication time, Publisher, policy linkage, capsule ID, or content hash.
 */
export const CandidateMetadata = z.strictObject({
  version: SemVer,
  provenance: ProvenanceRecord,
});
export type CandidateMetadata = z.infer<typeof CandidateMetadata>;

/**
 * Published metadata — all mandatory ANS publication metadata (ANS §3).
 * `contentHash` is derived and excluded from its own hash input.
 */
export const PublishedMetadata = z.strictObject({
  capsuleId: CapsuleId,
  bindsToNode: AnsNodeId,
  publishedBy: PublisherId,
  publishedAt: z.iso.datetime(),
  version: SemVer,
  provenance: ProvenanceRecord,
  nodePolicy: PolicyRef,
  capsulePolicy: PolicyRef,
  supersedes: CapsuleId.optional(),
  revokes: CapsuleId.optional(),
  contentHash: ContentHash,
});
export type PublishedMetadata = z.infer<typeof PublishedMetadata>;
