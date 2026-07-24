import { describe, expect, it } from "vitest";
import {
  canonicalJsonString,
  canWriteProductFacts,
  contentHash,
  createProductCapsule,
  generateProductJsonSchema,
  makeCapsuleVersionIri,
  makeNodeIri,
  ProductAuthorityError,
  reviseProductCapsule,
  validateProductCapsule,
  type ProductCapsule,
} from "../src/contracts/index";
import {
  SYN_PROMOTER_ACTOR,
  SYN_REVISED_AT,
  syntheticCreateInput,
} from "../src/contracts/fixtures/synthetic-product";

/** A fresh valid Product capsule (deep-cloned per test to allow mutation). */
function validCapsule(): ProductCapsule {
  return structuredClone(createProductCapsule(syntheticCreateInput()));
}

describe("Product capsule — structure", () => {
  it("1. a valid Product capsule passes", () => {
    const result = validateProductCapsule(validCapsule());
    expect(result.ok).toBe(true);
  });

  it("2. missing @context fails", () => {
    const c = validCapsule() as Record<string, unknown>;
    delete c["@context"];
    expect(validateProductCapsule(c).ok).toBe(false);
  });

  it("3. missing @type fails", () => {
    const c = validCapsule() as Record<string, unknown>;
    delete c["@type"];
    expect(validateProductCapsule(c).ok).toBe(false);
  });

  it("4. missing @id fails", () => {
    const c = validCapsule() as Record<string, unknown>;
    delete c["@id"];
    expect(validateProductCapsule(c).ok).toBe(false);
  });

  it("5. an invalid Product node IRI fails", () => {
    const c = validCapsule();
    c.subject = "https://monacado.com/id/product/not-a-ulid";
    expect(validateProductCapsule(c).ok).toBe(false);
  });

  it("6. an invalid capsule-version IRI fails", () => {
    const c = validCapsule();
    c["@id"] = "https://monacado.com/id/product/01J9Z3K7Q0V2M5N8P4R6T1W3XY/v/1";
    expect(validateProductCapsule(c).ok).toBe(false);
  });

  it("7. missing provenance fails", () => {
    const c = validCapsule() as Record<string, unknown>;
    delete c["provenance"];
    expect(validateProductCapsule(c).ok).toBe(false);
  });
});

describe("Product capsule — authority", () => {
  it("8. a creator Product modification is allowed", () => {
    const v1 = validCapsule();
    const { next } = reviseProductCapsule({
      current: v1,
      changes: { name: "Renamed by creator" },
      updatedAt: SYN_REVISED_AT,
      actor: syntheticCreateInput().actor,
    });
    expect(next.name).toBe("Renamed by creator");
    expect(next.capsuleVersion).toBe(2);
    expect(canWriteProductFacts(syntheticCreateInput().actor).allowed).toBe(true);
  });

  it("9. a promoter altering creator Product facts is rejected", () => {
    const v1 = validCapsule();
    expect(canWriteProductFacts(SYN_PROMOTER_ACTOR).allowed).toBe(false);
    expect(() =>
      reviseProductCapsule({
        current: v1,
        changes: { name: "Promoter override" },
        updatedAt: SYN_REVISED_AT,
        actor: SYN_PROMOTER_ACTOR,
      }),
    ).toThrow(ProductAuthorityError);
  });
});

describe("Product capsule — Product/Offer & privacy boundary", () => {
  it("10. a price inside the Product capsule is rejected", () => {
    const c = validCapsule();
    (c.data as Record<string, unknown>).price = 19.95;
    expect(validateProductCapsule(c).ok).toBe(false);
  });

  it("11. promoter commission terms inside the Product capsule are rejected", () => {
    const c = validCapsule();
    (c.data as Record<string, unknown>).promoterCommissionRate = 0.2;
    expect(validateProductCapsule(c).ok).toBe(false);
  });

  it("12. private identity or payment fields are rejected anywhere in the capsule", () => {
    const nested = validCapsule();
    (nested.metadata as Record<string, unknown>).stripeAccountId = "acct_synthetic";
    expect(validateProductCapsule(nested).ok).toBe(false);

    const specLevel = validCapsule();
    (specLevel.data.specifications as Record<string, unknown>).ssn = "000-00-0000";
    expect(validateProductCapsule(specLevel).ok).toBe(false);
  });
});

describe("Product capsule — deterministic hashing", () => {
  it("13. equivalent capsules with different key order produce the same hash", () => {
    const a = validCapsule();
    // Rebuild the object with reversed key order but identical content.
    const reversed = Object.fromEntries(
      Object.entries(a as Record<string, unknown>).reverse(),
    );
    expect(canonicalJsonString(reversed)).toBe(canonicalJsonString(a));
    expect(contentHash(reversed)).toBe(contentHash(a));
  });

  it("14. a meaningful Product change produces a different hash", () => {
    const a = validCapsule();
    const b = validCapsule();
    b.name = "A different product name";
    expect(contentHash(b)).not.toBe(contentHash(a));
  });

  it("hash ignores only the derived contentHash field", () => {
    const a = validCapsule();
    const withoutHash = structuredClone(a) as Record<string, unknown>;
    delete (withoutHash.provenance as Record<string, unknown>).contentHash;
    expect(contentHash(withoutHash)).toBe(contentHash(a));
  });
});

describe("Product capsule — supersession", () => {
  it("15. supersession requires a prior capsule-version reference", () => {
    const v1 = validCapsule();

    // A v2 with no supersedes is invalid.
    const bad = validCapsule();
    bad.capsuleVersion = 2;
    bad["@id"] = makeCapsuleVersionIri(bad.subject, 2);
    expect(validateProductCapsule(bad).ok).toBe(false);

    // The factory produces a v2 that correctly references v1.
    const { next, superseded } = reviseProductCapsule({
      current: v1,
      changes: { data: { ...v1.data, productVersion: 2 } },
      updatedAt: SYN_REVISED_AT,
      actor: syntheticCreateInput().actor,
    });
    expect(next.supersedes).toBe(v1["@id"]);
    expect(next.supersedes).toBe(makeCapsuleVersionIri(v1.subject, 1));
    expect(superseded.lifecycle).toBe("superseded");
    expect(validateProductCapsule(next).ok).toBe(true);
  });

  it("a v1 capsule must not declare supersedes", () => {
    const c = validCapsule();
    c.supersedes = makeCapsuleVersionIri(c.subject, 0);
    expect(validateProductCapsule(c).ok).toBe(false);
  });
});

describe("Product capsule — derived JSON Schema", () => {
  it("16. JSON Schema export succeeds", () => {
    const schema = generateProductJsonSchema();
    expect(schema).toBeTypeOf("object");
    expect(schema).not.toBeNull();
    expect("properties" in schema || "allOf" in schema || "$ref" in schema).toBe(true);
  });
});

describe("identity helpers", () => {
  it("node and capsule-version IRIs stay distinct", () => {
    const node = makeNodeIri("product", "01J9Z3K7Q0V2M5N8P4R6T1W3XY");
    const version = makeCapsuleVersionIri(node, 1);
    expect(version.startsWith(node)).toBe(true);
    expect(version).not.toBe(node);
  });
});
