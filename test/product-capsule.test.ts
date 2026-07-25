import { describe, expect, it } from "vitest";
import {
  CAPSULE_GENERATOR_ID,
  MONACADO_PUBLISHER_ID,
  ProductPublisherError,
  ProductRevisionError,
  candidateHash,
  canonicalJsonString,
  finalizeProductCapsule,
  generatePublishedProductJsonSchema,
  generateProductCandidate,
  publishedContentHash,
  reviseProductSource,
  validateProductCandidate,
  validatePublishedProductCapsule,
  type ProductCapsuleCandidate,
  type PublishedProductCapsule,
} from "../src/contracts/index";
import {
  SYN_CAPSULE_ID_V2,
  SYN_GENERATED_AT_V2,
  SYN_INTERNAL_PRODUCT_ID,
  SYN_NODE_ID,
  SYN_PUBLISHED_AT_V2,
  SYN_SEMANTIC_NODE_ID,
  syntheticFinalizeInputs,
  syntheticSourceRecord,
  syntheticSourceRecordV2,
} from "../src/contracts/fixtures/synthetic-product";

function candidate(): ProductCapsuleCandidate {
  return generateProductCandidate({
    source: syntheticSourceRecord(),
    version: "1.0.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function published(): PublishedProductCapsule {
  return finalizeProductCapsule({ candidate: candidate(), ...syntheticFinalizeInputs() });
}

/** Mutable deep clone (published capsules are frozen). */
function clone<T>(v: T): T {
  return structuredClone(v);
}

describe("candidate and published structure", () => {
  it("1. valid candidate generation from a synthetic source record", () => {
    expect(validateProductCandidate(candidate()).ok).toBe(true);
  });

  it("2. valid final published Product capsule", () => {
    expect(validatePublishedProductCapsule(published()).ok).toBe(true);
  });

  it("3. published capsule has only @context, @type, metadata, data", () => {
    expect(Object.keys(published()).sort()).toEqual(["@context", "@type", "data", "metadata"]);
  });

  it("4. missing metadata fails", () => {
    const c = clone(published()) as Record<string, unknown>;
    delete c["metadata"];
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("5. missing data fails", () => {
    const c = clone(published()) as Record<string, unknown>;
    delete c["data"];
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("6. missing capsule ID fails", () => {
    const c = clone(published());
    delete (c.metadata as Record<string, unknown>).capsuleId;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("7. missing Node binding fails", () => {
    const c = clone(published());
    delete (c.metadata as Record<string, unknown>).bindsToNode;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("8. missing Publisher ID fails", () => {
    const c = clone(published());
    delete (c.metadata as Record<string, unknown>).publishedBy;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("9. missing publishedAt fails", () => {
    const c = clone(published());
    delete (c.metadata as Record<string, unknown>).publishedAt;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("10. missing Node Policy reference fails", () => {
    const c = clone(published());
    delete (c.metadata as Record<string, unknown>).nodePolicy;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("11. missing Capsule Policy reference fails", () => {
    const c = clone(published());
    delete (c.metadata as Record<string, unknown>).capsulePolicy;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });
});

describe("versioning", () => {
  it("12. integer capsule version fails", () => {
    const c = clone(published()) as unknown as { metadata: { version: unknown } };
    c.metadata.version = 1;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("13. invalid semver fails", () => {
    const c = clone(published());
    (c.metadata as Record<string, unknown>).version = "1.0";
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });
});

describe("lifecycle removal", () => {
  it("14. a capsule lifecycle field is rejected", () => {
    const top = clone(published()) as Record<string, unknown>;
    top.lifecycle = "active";
    expect(validatePublishedProductCapsule(top).ok).toBe(false);

    const meta = clone(published());
    (meta.metadata as Record<string, unknown>).lifecycleState = "Active";
    expect(validatePublishedProductCapsule(meta).ok).toBe(false);
  });
});

describe("provenance", () => {
  it("15. missing provenance source fails", () => {
    const c = clone(published());
    delete (c.metadata.provenance as Record<string, unknown>).source;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("16. missing provenance method fails", () => {
    const c = clone(published());
    delete (c.metadata.provenance as Record<string, unknown>).method;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("17. missing acquiredAt fails", () => {
    const c = clone(published());
    delete (c.metadata.provenance as Record<string, unknown>).acquiredAt;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("18. missing assertionKind fails", () => {
    const c = clone(published());
    delete (c.metadata.provenance as Record<string, unknown>).assertionKind;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });

  it("19. Product provenance uses Asserted", () => {
    expect(published().metadata.provenance.assertionKind).toBe("Asserted");
  });
});

describe("authority", () => {
  it("20. generator identity cannot substitute for Publisher identity", () => {
    expect(() =>
      finalizeProductCapsule({
        candidate: candidate(),
        ...syntheticFinalizeInputs(),
        publishedBy: CAPSULE_GENERATOR_ID,
      }),
    ).toThrow(ProductPublisherError);
    expect(published().metadata.publishedBy).toBe(MONACADO_PUBLISHER_ID);
  });
});

describe("identity", () => {
  it("21. internal Product ID differs from ANS Node ID", () => {
    const p = published();
    expect(p.metadata.provenance.sourceRecordId).toBe(SYN_INTERNAL_PRODUCT_ID);
    expect(p.metadata.bindsToNode).toBe(SYN_NODE_ID);
    expect(p.metadata.provenance.sourceRecordId).not.toBe(p.metadata.bindsToNode);
  });

  it("22. a semantic Product path is rejected as an ANS Node ID", () => {
    const c = clone(published());
    (c.metadata as Record<string, unknown>).bindsToNode = SYN_SEMANTIC_NODE_ID;
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });
});

describe("Product facts and Product/Offer boundary", () => {
  it("23. Product facts remain inside data", () => {
    const p = published();
    expect(p.data.name).toBe("Synthetic CLI Toolkit");
    expect(p.data.promotable).toBe(true);
    expect(p.data.relationships.creator).toMatch(/^an:node:/);
  });

  it("24. price, currency, commission, and payment data remain rejected", () => {
    for (const bad of ["price", "currency", "promoterCommissionRate", "paymentMethod"]) {
      const c = clone(published());
      (c.data as Record<string, unknown>)[bad] = "x";
      expect(validatePublishedProductCapsule(c).ok).toBe(false);
    }
  });
});

describe("source-record revision rules", () => {
  it("25. meaningful revision requires a new source-record version", () => {
    expect(() =>
      reviseProductSource({
        current: published(),
        source: syntheticSourceRecord(), // same sourceRecordVersion "1"
        version: "1.1.0",
        generatedAt: SYN_GENERATED_AT_V2,
      }),
    ).toThrow(ProductRevisionError);
  });

  it("26. meaningful revision requires a new capsule semver", () => {
    expect(() =>
      reviseProductSource({
        current: published(),
        source: syntheticSourceRecordV2(),
        version: "1.0.0", // same as current
        generatedAt: SYN_GENERATED_AT_V2,
      }),
    ).toThrow(ProductRevisionError);
  });

  it("27. meaningful revision creates a new capsule ID", () => {
    const c2 = reviseProductSource({
      current: published(),
      source: syntheticSourceRecordV2(),
      version: "1.1.0",
      generatedAt: SYN_GENERATED_AT_V2,
    });
    const v2 = finalizeProductCapsule({
      candidate: c2,
      ...syntheticFinalizeInputs(),
      capsuleId: SYN_CAPSULE_ID_V2,
      publishedAt: SYN_PUBLISHED_AT_V2,
      supersedes: published().metadata.capsuleId,
    });
    expect(v2.metadata.capsuleId).not.toBe(published().metadata.capsuleId);
  });

  it("28. supersedes references a prior capsule ID", () => {
    const v1 = published();
    const c2 = reviseProductSource({
      current: v1,
      source: syntheticSourceRecordV2(),
      version: "1.1.0",
      generatedAt: SYN_GENERATED_AT_V2,
    });
    const v2 = finalizeProductCapsule({
      candidate: c2,
      ...syntheticFinalizeInputs(),
      capsuleId: SYN_CAPSULE_ID_V2,
      publishedAt: SYN_PUBLISHED_AT_V2,
      supersedes: v1.metadata.capsuleId,
    });
    expect(v2.metadata.supersedes).toBe(v1.metadata.capsuleId);
    expect(v2.metadata.supersedes).toMatch(/^an:capsule:/);
  });

  it("29. supersedes cannot reference a Node ID", () => {
    const c = clone(published());
    (c.metadata as Record<string, unknown>).supersedes = SYN_NODE_ID; // an:node:...
    expect(validatePublishedProductCapsule(c).ok).toBe(false);
  });
});

describe("hashing", () => {
  it("30. provenance survives validation unchanged", () => {
    const p = published();
    const before = JSON.stringify(p.metadata.provenance);
    const revalidated = validatePublishedProductCapsule(clone(p));
    expect(revalidated.ok).toBe(true);
    expect(JSON.stringify(revalidated.capsule?.metadata.provenance)).toBe(before);
  });

  it("31. equivalent objects hash identically", () => {
    const p = published();
    const reversed = Object.fromEntries(Object.entries(p as Record<string, unknown>).reverse());
    expect(canonicalJsonString(reversed)).toBe(canonicalJsonString(p));
    expect(publishedContentHash(reversed)).toBe(publishedContentHash(p));
  });

  it("32. mutation of final publication metadata changes the hash", () => {
    const p = published();
    const m = clone(p);
    (m.metadata as Record<string, unknown>).publishedAt = "2030-01-01T00:00:00.000Z";
    expect(publishedContentHash(m)).not.toBe(publishedContentHash(p));
  });

  it("33. mutation of source provenance changes the hash", () => {
    const p = published();
    const m = clone(p);
    (m.metadata.provenance as Record<string, unknown>).sourceRecordId = "mon:product:CHANGED000000000000000000";
    expect(publishedContentHash(m)).not.toBe(publishedContentHash(p));
  });

  it("candidate hash is distinct from published content hash", () => {
    const c = candidate();
    const p = published();
    expect(candidateHash(c)).not.toBe(p.metadata.contentHash);
  });
});

describe("privacy and schema", () => {
  it("34. private or payment fields cannot enter through metadata or provenance", () => {
    const viaMeta = clone(published());
    (viaMeta.metadata as Record<string, unknown>).stripeAccountId = "acct_synthetic";
    expect(validatePublishedProductCapsule(viaMeta).ok).toBe(false);

    const viaProvenance = clone(published());
    (viaProvenance.metadata.provenance as Record<string, unknown>).bankAccount = "000";
    expect(validatePublishedProductCapsule(viaProvenance).ok).toBe(false);
  });

  it("35. JSON Schema export succeeds", () => {
    const schema = generatePublishedProductJsonSchema();
    expect(schema).toBeTypeOf("object");
    expect("properties" in schema || "$ref" in schema || "allOf" in schema).toBe(true);
  });
});
