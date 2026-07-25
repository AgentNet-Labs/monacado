import { describe, expect, it } from "vitest";
import {
  SourceRecordRevisionError,
  candidateHash,
  canonicalJsonString,
  generateProductSourceRecordJsonSchema,
  productCapsuleCandidateToSourceProjection,
  productSourceRecordToCapsuleCandidate,
  reviseProductSourceRecord,
  validateProductSourceRecord,
  verifyProductSourceCandidateMapping,
  type ProductSourceRecord,
} from "../src/contracts/index";
import {
  SYN_CAPSULE_GENERATED_AT,
  SYN_CAPSULE_GENERATED_AT_V2,
  SYN_INTERNAL_PRODUCT_ID,
  SYN_SOURCE_RECORD_ID,
  SYN_UPDATED_AT_V2,
  syntheticProductSourceRecord,
} from "../src/contracts/fixtures/synthetic-source-record";
import {
  SYN_CAPSULE_ID_V1,
  SYN_NODE_ID,
  SYN_SEMANTIC_NODE_ID,
} from "../src/contracts/fixtures/synthetic-product";

function record(): ProductSourceRecord {
  return structuredClone(syntheticProductSourceRecord());
}

describe("source-record schema", () => {
  it("1. a valid Product source record passes", () => {
    expect(validateProductSourceRecord(record()).ok).toBe(true);
  });

  it("2. missing sourceRecordId fails", () => {
    const r = record() as Record<string, unknown>;
    delete r.sourceRecordId;
    expect(validateProductSourceRecord(r).ok).toBe(false);
  });

  it("3. missing sourceRecordVersion fails", () => {
    const r = record() as Record<string, unknown>;
    delete r.sourceRecordVersion;
    expect(validateProductSourceRecord(r).ok).toBe(false);
  });

  it("4. missing internalProductId fails", () => {
    const r = record() as Record<string, unknown>;
    delete r.internalProductId;
    expect(validateProductSourceRecord(r).ok).toBe(false);
  });

  it("5. missing creator authority reference fails", () => {
    const r = record();
    delete (r.authority as Record<string, unknown>).creatorId;
    expect(validateProductSourceRecord(r).ok).toBe(false);
  });

  it("6. unknown top-level source field fails", () => {
    const r = record() as Record<string, unknown>;
    r.unexpected = "x";
    expect(validateProductSourceRecord(r).ok).toBe(false);
  });

  it("7. unknown nested authority field fails", () => {
    const r = record();
    (r.authority as Record<string, unknown>).extra = "x";
    expect(validateProductSourceRecord(r).ok).toBe(false);
  });

  it("8-11. price / currency / commission / payment fields fail", () => {
    for (const bad of ["price", "currency", "promoterCommissionRate", "paymentMethod"]) {
      const r = record();
      (r.facts as Record<string, unknown>)[bad] = "x";
      expect(validateProductSourceRecord(r).ok).toBe(false);
    }
  });
});

describe("deterministic mapping", () => {
  it("12. a valid source record generates a valid candidate", () => {
    const cand = productSourceRecordToCapsuleCandidate(record());
    expect(cand["@type"]).toBe("Product");
  });

  it("13. same source record generates identical candidate canonical JSON", () => {
    expect(canonicalJsonString(productSourceRecordToCapsuleCandidate(record()))).toBe(
      canonicalJsonString(productSourceRecordToCapsuleCandidate(record())),
    );
  });

  it("14. same source record generates identical candidate hash", () => {
    expect(candidateHash(productSourceRecordToCapsuleCandidate(record()))).toBe(
      candidateHash(productSourceRecordToCapsuleCandidate(record())),
    );
  });

  it("15. different object key order produces the same candidate and hash", () => {
    const r = record();
    const reordered = Object.fromEntries(Object.entries(r as Record<string, unknown>).reverse());
    const a = productSourceRecordToCapsuleCandidate(r);
    const b = productSourceRecordToCapsuleCandidate(reordered);
    expect(canonicalJsonString(a)).toBe(canonicalJsonString(b));
    expect(candidateHash(a)).toBe(candidateHash(b));
  });

  it("16. candidate contains no publication metadata", () => {
    const cand = productSourceRecordToCapsuleCandidate(record()) as { metadata: Record<string, unknown> };
    for (const pubField of ["capsuleId", "bindsToNode", "publishedBy", "publishedAt", "nodePolicy", "capsulePolicy", "contentHash"]) {
      expect(pubField in cand.metadata).toBe(false);
    }
    expect(Object.keys(cand.metadata).sort()).toEqual(["provenance", "version"]);
  });

  it("17-21. candidate provenance carries exact source facts + Asserted", () => {
    const r = record();
    const p = productSourceRecordToCapsuleCandidate(r).metadata.provenance;
    expect(p.sourceRecordId).toBe(r.sourceRecordId);
    expect(p.sourceRecordVersion).toBe(r.sourceRecordVersion);
    expect(p.sourceSystem).toBe("monacado");
    expect(p.sourceRecordType).toBe("Product");
    expect(p.assertionKind).toBe("Asserted");
  });

  it("22. candidate reconstruction preserves all Product facts", () => {
    const r = record();
    const proj = productCapsuleCandidateToSourceProjection(productSourceRecordToCapsuleCandidate(r));
    expect(canonicalJsonString(proj.facts)).toBe(canonicalJsonString(r.facts));
  });

  it("23. candidate reconstruction preserves source provenance", () => {
    const r = record();
    const proj = productCapsuleCandidateToSourceProjection(productSourceRecordToCapsuleCandidate(r));
    expect(proj.sourceRecordId).toBe(r.sourceRecordId);
    expect(proj.sourceRecordVersion).toBe(r.sourceRecordVersion);
    expect(proj.mappingVersion).toBe(r.mappingVersion);
    expect(proj.acquiredAt).toBe(r.acquiredAt);
  });

  it("24. source → candidate → projection matches the defined source projection", () => {
    const r = record();
    const proj = productCapsuleCandidateToSourceProjection(productSourceRecordToCapsuleCandidate(r));
    expect(proj).toEqual({
      sourceRecordId: r.sourceRecordId,
      sourceRecordVersion: r.sourceRecordVersion,
      sourceSystem: r.sourceSystem,
      sourceRecordType: r.sourceRecordType,
      sourceClass: r.sourceClass,
      capsuleSemver: r.capsuleSemver,
      mappingVersion: r.mappingVersion,
      acquiredAt: r.acquiredAt,
      capsuleGeneratedAt: r.capsuleGeneratedAt,
      facts: r.facts,
    });
  });
});

describe("revision rules", () => {
  it("25. meaningful Product revision requires a new sourceRecordVersion", () => {
    const next = reviseProductSourceRecord({
      prior: record(),
      sourceRecordVersion: "2",
      updatedAt: SYN_UPDATED_AT_V2,
      capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2,
      facts: { ...record().facts, name: "Renamed" },
    });
    expect(next.sourceRecordVersion).toBe("2");
    expect(next.sourceRecordId).toBe(SYN_SOURCE_RECORD_ID);
    expect(next.internalProductId).toBe(SYN_INTERNAL_PRODUCT_ID);
  });

  it("26. a reused sourceRecordVersion fails", () => {
    expect(() =>
      reviseProductSourceRecord({
        prior: record(),
        sourceRecordVersion: "1",
        updatedAt: SYN_UPDATED_AT_V2,
        capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2,
      }),
    ).toThrow(SourceRecordRevisionError);
  });

  it("27. a changed sourceRecordId during revision fails", () => {
    expect(() =>
      reviseProductSourceRecord({
        prior: record(),
        sourceRecordVersion: "2",
        updatedAt: SYN_UPDATED_AT_V2,
        capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2,
        sourceRecordId: "mon:srec:0CHANGED0000000000000000AA",
      }),
    ).toThrow(SourceRecordRevisionError);
  });

  it("28. a changed internalProductId during revision fails", () => {
    expect(() =>
      reviseProductSourceRecord({
        prior: record(),
        sourceRecordVersion: "2",
        updatedAt: SYN_UPDATED_AT_V2,
        capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2,
        internalProductId: "mon:product:0CHANGED000000000000000AA",
      }),
    ).toThrow(SourceRecordRevisionError);
  });

  it("29. a source-record version change changes the candidate hash", () => {
    const base = record();
    const next = reviseProductSourceRecord({
      prior: base,
      sourceRecordVersion: "2",
      updatedAt: SYN_UPDATED_AT_V2,
      capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2,
    });
    expect(candidateHash(productSourceRecordToCapsuleCandidate(next))).not.toBe(
      candidateHash(productSourceRecordToCapsuleCandidate(base)),
    );
  });

  it("30. a mapping-version change changes the candidate hash", () => {
    const base = record();
    const changed = { ...base, mappingVersion: "0c.9.9.9" };
    expect(candidateHash(productSourceRecordToCapsuleCandidate(changed))).not.toBe(
      candidateHash(productSourceRecordToCapsuleCandidate(base)),
    );
  });
});

describe("tamper and contradiction detection", () => {
  it("31. a Product fact mutation causes verification failure", () => {
    const r = record();
    const cand = productSourceRecordToCapsuleCandidate(r);
    const tampered = structuredClone(cand);
    tampered.data.name = "Tampered";
    const result = verifyProductSourceCandidateMapping(r, tampered);
    expect(result.ok).toBe(false);
  });

  it("32. a creator relationship mutation causes verification failure", () => {
    const r = record();
    const cand = productSourceRecordToCapsuleCandidate(r);
    const tampered = structuredClone(cand);
    tampered.data.relationships.creator = "an:node:0TAMPERED00000000000000AAA";
    expect(verifyProductSourceCandidateMapping(r, tampered).ok).toBe(false);
  });

  it("33. a provenance mutation causes verification failure", () => {
    const r = record();
    const cand = productSourceRecordToCapsuleCandidate(r);
    const tampered = structuredClone(cand);
    tampered.metadata.provenance.sourceRecordVersion = "999";
    expect(verifyProductSourceCandidateMapping(r, tampered).ok).toBe(false);
  });

  it("34. a candidate hash contradiction is detected (facts changed under same ids)", () => {
    const r = record();
    const cand = productSourceRecordToCapsuleCandidate(r);
    const tampered = structuredClone(cand);
    tampered.data.promotable = false;
    const result = verifyProductSourceCandidateMapping(r, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.some((m) => m.field === "candidateHash")).toBe(true);
  });

  it("35. a source/candidate identity contradiction fails", () => {
    const r = record();
    const cand = productSourceRecordToCapsuleCandidate({ ...r, sourceRecordVersion: "7" });
    const result = verifyProductSourceCandidateMapping(r, cand);
    expect(result.ok).toBe(false);
  });

  it("36-38. ANS Node ID / capsule ID / semantic URL cannot substitute for sourceRecordId", () => {
    for (const bad of [SYN_NODE_ID, SYN_CAPSULE_ID_V1, SYN_SEMANTIC_NODE_ID]) {
      const r = record();
      (r as Record<string, unknown>).sourceRecordId = bad;
      expect(validateProductSourceRecord(r).ok).toBe(false);
    }
  });
});

describe("capsuleGeneratedAt correction (Phase 0C)", () => {
  it("C1. capsuleGeneratedAt is required", () => {
    const r = record() as Record<string, unknown>;
    delete r.capsuleGeneratedAt;
    expect(validateProductSourceRecord(r).ok).toBe(false);
  });

  it("C2. an invalid capsuleGeneratedAt fails", () => {
    const r = record();
    (r as Record<string, unknown>).capsuleGeneratedAt = "not-a-timestamp";
    expect(validateProductSourceRecord(r).ok).toBe(false);
  });

  it("C3. provenance.generatedAt exactly matches capsuleGeneratedAt", () => {
    const r = record();
    const cand = productSourceRecordToCapsuleCandidate(r);
    expect(cand.metadata.provenance.generatedAt).toBe(r.capsuleGeneratedAt);
    expect(cand.metadata.provenance.generatedAt).toBe(SYN_CAPSULE_GENERATED_AT);
  });

  it("C4. updatedAt and capsuleGeneratedAt may be distinct", () => {
    const r = record();
    expect(r.updatedAt).not.toBe(r.capsuleGeneratedAt);
    expect(validateProductSourceRecord(r).ok).toBe(true);
  });

  it("C5. changing updatedAt alone does not masquerade as a generation-time change", () => {
    const base = record();
    const updatedOnly = { ...base, updatedAt: "2027-05-05T05:05:05.000Z" };
    const a = productSourceRecordToCapsuleCandidate(base);
    const b = productSourceRecordToCapsuleCandidate(updatedOnly);
    // updatedAt is internal; it is not in the candidate, so generatedAt/hash are unchanged.
    expect(b.metadata.provenance.generatedAt).toBe(a.metadata.provenance.generatedAt);
    expect(candidateHash(b)).toBe(candidateHash(a));
  });

  it("C6. the mapper does not read the runtime clock", () => {
    const realNow = Date.now;
    Date.now = () => {
      throw new Error("runtime clock must not be read during mapping");
    };
    try {
      const cand = productSourceRecordToCapsuleCandidate(record());
      expect(cand.metadata.provenance.generatedAt).toBe(SYN_CAPSULE_GENERATED_AT);
    } finally {
      Date.now = realNow;
    }
  });

  it("C7. equivalent source records produce identical candidates and hashes", () => {
    const a = productSourceRecordToCapsuleCandidate(record());
    const b = productSourceRecordToCapsuleCandidate(record());
    expect(canonicalJsonString(a)).toBe(canonicalJsonString(b));
    expect(candidateHash(a)).toBe(candidateHash(b));
  });

  it("C8. a meaningful revision must explicitly supply capsuleGeneratedAt", () => {
    const next = reviseProductSourceRecord({
      prior: record(),
      sourceRecordVersion: "2",
      updatedAt: SYN_UPDATED_AT_V2,
      capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2,
      facts: { ...record().facts, name: "Renamed" },
    });
    expect(next.capsuleGeneratedAt).toBe(SYN_CAPSULE_GENERATED_AT_V2);
    expect(productSourceRecordToCapsuleCandidate(next).metadata.provenance.generatedAt).toBe(
      SYN_CAPSULE_GENERATED_AT_V2,
    );
  });

  it("C9. an explicitly supplied capsuleGeneratedAt equal to the prior value is permitted", () => {
    // Timestamp equality is not treated as generation identity: same-precision
    // events and deterministic/imported workflows may legitimately supply an
    // equal value, as long as it is supplied explicitly (not silently inherited).
    const next = reviseProductSourceRecord({
      prior: record(),
      sourceRecordVersion: "2",
      updatedAt: SYN_UPDATED_AT_V2,
      capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT, // equal to prior, explicitly supplied
      facts: { ...record().facts, name: "Renamed" },
    });
    expect(next.capsuleGeneratedAt).toBe(SYN_CAPSULE_GENERATED_AT);
    expect(productSourceRecordToCapsuleCandidate(next).metadata.provenance.generatedAt).toBe(
      SYN_CAPSULE_GENERATED_AT,
    );
  });

  it("C12. an omitted capsuleGeneratedAt on revision is rejected", () => {
    const input = {
      prior: record(),
      sourceRecordVersion: "2",
      updatedAt: SYN_UPDATED_AT_V2,
      facts: { ...record().facts, name: "Renamed" },
    } as unknown as Parameters<typeof reviseProductSourceRecord>[0];
    expect(() => reviseProductSourceRecord(input)).toThrow(SourceRecordRevisionError);
  });

  it("C13. an explicitly supplied different capsuleGeneratedAt is permitted", () => {
    const next = reviseProductSourceRecord({
      prior: record(),
      sourceRecordVersion: "2",
      updatedAt: SYN_UPDATED_AT_V2,
      capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2,
      facts: { ...record().facts, name: "Renamed" },
    });
    expect(next.capsuleGeneratedAt).toBe(SYN_CAPSULE_GENERATED_AT_V2);
  });

  it("C10. projection preserves capsuleGeneratedAt through provenance", () => {
    const r = record();
    const proj = productCapsuleCandidateToSourceProjection(productSourceRecordToCapsuleCandidate(r));
    expect(proj.capsuleGeneratedAt).toBe(r.capsuleGeneratedAt);
  });

  it("C11. verification reports a capsuleGeneratedAt/provenance.generatedAt contradiction", () => {
    const r = record();
    const cand = productSourceRecordToCapsuleCandidate(r);
    const tampered = structuredClone(cand);
    tampered.metadata.provenance.generatedAt = "2029-09-09T09:09:09.000Z";
    const result = verifyProductSourceCandidateMapping(r, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.some((m) => m.field === "capsuleGeneratedAt")).toBe(true);
    }
  });
});

describe("schema export", () => {
  it("39. JSON Schema export succeeds", () => {
    const schema = generateProductSourceRecordJsonSchema();
    expect(schema).toBeTypeOf("object");
    expect("properties" in schema || "$ref" in schema || "allOf" in schema).toBe(true);
  });
});
