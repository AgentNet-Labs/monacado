/**
 * contracts:demo — offline, deterministic end-to-end demonstration.
 *
 * No database and no network. Fixed synthetic data → identical output each run.
 * Shows: source record → candidate → provenance trace → finalisation →
 * validation → content hash → revised source version → new semver/capsule ID →
 * supersession → and the required rejections.
 */

import {
  CAPSULE_GENERATOR_ID,
  ProductPublisherError,
  ProductRevisionError,
  SourceRecordRevisionError,
  canonicalJsonString,
  candidateHash,
  finalizeProductCapsule,
  generateProductCandidate,
  productCapsuleCandidateToSourceProjection,
  productSourceRecordToCapsuleCandidate,
  publishedContentHash,
  reviseProductSource,
  reviseProductSourceRecord,
  validateProductSourceRecord,
  validatePublishedProductCapsule,
  verifyProductSourceCandidateMapping,
} from "../src/contracts/index";
import {
  SYN_CAPSULE_ID_V2,
  SYN_GENERATED_AT_V2,
  SYN_PUBLISHED_AT_V2,
  SYN_SEMANTIC_NODE_ID,
  syntheticFinalizeInputs,
  syntheticSourceRecord,
  syntheticSourceRecordV2,
} from "../src/contracts/fixtures/synthetic-product";
import {
  SYN_CAPSULE_GENERATED_AT_V2,
  SYN_UPDATED_AT_V2,
  syntheticProductSourceRecord,
} from "../src/contracts/fixtures/synthetic-source-record";

const line = (label: string, value: string) => console.log(`  ${label.padEnd(30)} ${value}`);

console.log("Monacado Phase 0B.1 — ANS-conformant Product capsule demo (offline)\n");

// 1. Synthetic authoritative Monacado Product source record.
const source = syntheticSourceRecord();
console.log("1. Authoritative source record");
line("sourceRecordId", source.sourceRecordId);
line("sourceRecordVersion", source.sourceRecordVersion);
line("sourceClass", source.sourceClass);

// 2. Candidate generation.
const candidate = generateProductCandidate({
  source,
  version: "1.0.0",
  generatedAt: source.acquiredAt,
});
console.log("\n2. Product capsule candidate");
line("@type", String(candidate["@type"]));
line("version", candidate.metadata.version);
line("candidateHash", candidateHash(candidate));

// 3. Source provenance trace.
console.log("\n3. Source provenance trace");
line("source", candidate.metadata.provenance.source);
line("method", candidate.metadata.provenance.method);
line("assertionKind", candidate.metadata.provenance.assertionKind);

// 4. Finalisation with synthetic publication metadata.
const v1 = finalizeProductCapsule({ candidate, ...syntheticFinalizeInputs() });
console.log("\n4. Finalised published capsule");
line("capsuleId", v1.metadata.capsuleId);
line("bindsToNode (opaque)", v1.metadata.bindsToNode);
line("publishedBy", v1.metadata.publishedBy);
line("publishedAt", v1.metadata.publishedAt);
line("nodePolicy.ref", v1.metadata.nodePolicy.ref);
line("capsulePolicy.ref", v1.metadata.capsulePolicy.ref);

// 5. Validation.
console.log("\n5. Validation");
line("published valid", String(validatePublishedProductCapsule(v1).ok));
line("top-level members", Object.keys(v1).sort().join(", "));

// 6. Deterministic final content hash.
console.log("\n6. Content hash");
line("v1 contentHash", v1.metadata.contentHash);
line("recompute matches", String(publishedContentHash(v1) === v1.metadata.contentHash));

// 7-9. Revised source version → new candidate → new semver/capsule ID → supersession.
const candidateV2 = reviseProductSource({
  current: v1,
  source: syntheticSourceRecordV2(),
  version: "1.1.0",
  generatedAt: SYN_GENERATED_AT_V2,
});
const v2 = finalizeProductCapsule({
  candidate: candidateV2,
  ...syntheticFinalizeInputs(),
  capsuleId: SYN_CAPSULE_ID_V2,
  publishedAt: SYN_PUBLISHED_AT_V2,
  supersedes: v1.metadata.capsuleId,
});
console.log("\n7-9. Revision, new version, supersession");
line("new sourceRecordVersion", v2.metadata.provenance.sourceRecordVersion);
line("new version", v2.metadata.version);
line("new capsuleId", v2.metadata.capsuleId);
line("supersedes (prior capsuleId)", String(v2.metadata.supersedes));
line("hash changed", String(v2.metadata.contentHash !== v1.metadata.contentHash));

// 10. Rejections.
console.log("\n10. Rejections");

try {
  reviseProductSource({ current: v1, source: syntheticSourceRecord(), version: "1.2.0", generatedAt: SYN_GENERATED_AT_V2 });
  line("reused source version", "ERROR — not rejected");
} catch (e) {
  line("reused source version", e instanceof ProductRevisionError ? "rejected" : "rejected(other)");
}

const intVersion = structuredClone(v1) as unknown as { metadata: { version: unknown } };
intVersion.metadata.version = 1;
line("integer version", String(!validatePublishedProductCapsule(intVersion).ok));

const withLifecycle = structuredClone(v1) as unknown as { metadata: Record<string, unknown> };
withLifecycle.metadata.lifecycle = "active";
line("capsule lifecycle field", String(!validatePublishedProductCapsule(withLifecycle).ok));

const semanticNode = structuredClone(v1) as unknown as { metadata: { bindsToNode: string } };
semanticNode.metadata.bindsToNode = SYN_SEMANTIC_NODE_ID;
line("semantic Node ID", String(!validatePublishedProductCapsule(semanticNode).ok));

try {
  finalizeProductCapsule({ candidate, ...syntheticFinalizeInputs(), publishedBy: CAPSULE_GENERATOR_ID });
  line("generator as Publisher", "ERROR — not rejected");
} catch (e) {
  line("generator as Publisher", e instanceof ProductPublisherError ? "rejected" : "rejected(other)");
}

// ── Phase 0C — source-record → candidate mapping (offline) ──
console.log("\nPhase 0C — Product source-record mapping\n");

const srcRecord = syntheticProductSourceRecord();
console.log("A. Authoritative Product source record");
line("sourceRecordId", srcRecord.sourceRecordId);
line("internalProductId (distinct)", srcRecord.internalProductId);
line("sourceRecordVersion", srcRecord.sourceRecordVersion);
line("recordStatus (internal)", srcRecord.recordStatus);

console.log("\nB. Strict validation");
line("source record valid", String(validateProductSourceRecord(srcRecord).ok));

const c0c = productSourceRecordToCapsuleCandidate(srcRecord);
console.log("\nC. Deterministic mapping → candidate");
line("candidate version", c0c.metadata.version);
line("candidate hash", candidateHash(c0c));
line("no publication metadata", String(Object.keys(c0c.metadata).sort().join(",") === "provenance,version"));

const proj = productCapsuleCandidateToSourceProjection(c0c);
console.log("\nD. Candidate → source projection");
line("projection sourceRecordId", proj.sourceRecordId);
line("facts preserved", String(canonicalJsonString(proj.facts) === canonicalJsonString(srcRecord.facts)));

console.log("\nE. Mapping verification");
line("verify ok", String(verifyProductSourceCandidateMapping(srcRecord, c0c).ok));

const revised = reviseProductSourceRecord({
  prior: srcRecord,
  sourceRecordVersion: "2",
  updatedAt: SYN_UPDATED_AT_V2,
  capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2,
  facts: { ...srcRecord.facts, name: "Synthetic CLI Toolkit (Pro)", productVersion: 2 },
});
const cRev = productSourceRecordToCapsuleCandidate(revised);
console.log("\nF. Meaningful revision");
line("same sourceRecordId", String(revised.sourceRecordId === srcRecord.sourceRecordId));
line("same internalProductId", String(revised.internalProductId === srcRecord.internalProductId));
line("new sourceRecordVersion", revised.sourceRecordVersion);
line("new candidate hash", String(candidateHash(cRev) !== candidateHash(c0c)));

const equalTsRevision = reviseProductSourceRecord({
  prior: srcRecord,
  sourceRecordVersion: "2",
  updatedAt: SYN_UPDATED_AT_V2,
  capsuleGeneratedAt: srcRecord.capsuleGeneratedAt, // explicitly supplied, equal to prior
  facts: { ...srcRecord.facts, name: "Synthetic CLI Toolkit (Pro)" },
});
line("equal explicit capsuleGeneratedAt", `accepted (${equalTsRevision.capsuleGeneratedAt})`);

console.log("\nG. Rejections");
try {
  reviseProductSourceRecord({ prior: srcRecord, sourceRecordVersion: "1", updatedAt: SYN_UPDATED_AT_V2, capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2 });
  line("reused sourceRecordVersion", "ERROR — not rejected");
} catch (e) {
  line("reused sourceRecordVersion", e instanceof SourceRecordRevisionError ? "rejected" : "rejected(other)");
}
try {
  const omitted = { prior: srcRecord, sourceRecordVersion: "2", updatedAt: SYN_UPDATED_AT_V2 } as unknown as Parameters<typeof reviseProductSourceRecord>[0];
  reviseProductSourceRecord(omitted);
  line("omitted capsuleGeneratedAt", "ERROR — not rejected");
} catch (e) {
  line("omitted capsuleGeneratedAt", e instanceof SourceRecordRevisionError ? "rejected" : "rejected(other)");
}
try {
  reviseProductSourceRecord({ prior: srcRecord, sourceRecordVersion: "2", updatedAt: SYN_UPDATED_AT_V2, capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2, sourceRecordId: "mon:srec:0CHANGED0000000000000000AA" });
  line("changed immutable id", "ERROR — not rejected");
} catch (e) {
  line("changed immutable id", e instanceof SourceRecordRevisionError ? "rejected" : "rejected(other)");
}
const tampered = structuredClone(c0c);
tampered.data.name = "Tampered";
line("Product fact tampering", String(!verifyProductSourceCandidateMapping(srcRecord, tampered).ok));
const provTamper = structuredClone(c0c);
provTamper.metadata.provenance.sourceRecordVersion = "999";
line("provenance tampering", String(!verifyProductSourceCandidateMapping(srcRecord, provTamper).ok));
const priceRec = structuredClone(srcRecord) as unknown as { facts: Record<string, unknown> };
priceRec.facts.price = 19.95;
line("price/payment field", String(!validateProductSourceRecord(priceRec).ok));

console.log("\ncontracts:demo — complete.");
