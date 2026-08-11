/**
 * Storefront Capsule Projection Shape tests (Phase 0M.3B).
 *
 * Offline: no database, no network, no clock. Every identifier is synthetic.
 *
 * The privacy assertions are **allow-list first**: the capsule's `data` keys are
 * compared against one declared list, so a new field is a test failure the moment
 * it appears, whether or not anyone thought to add it to a denylist. The value
 * scan for internal identifiers is a second, weaker net — it catches a
 * copy-pasted id in a field that legitimately accepts strings, and it is never
 * the thing relied on to keep private data out.
 */

import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "../src/contracts/integrity/canonical-json";
import { FORBIDDEN_INTERNAL_ID_PREFIXES } from "../src/contracts/capsule/internal-identifiers";
import {
  PUBLIC_STOREFRONT_CAPSULE_FIELDS,
  STOREFRONT_TYPE,
  StorefrontCapsuleDataBase,
  StorefrontCapsuleProjection,
  validateStorefrontCapsuleProjection,
} from "../src/contracts/marketplace/storefront.capsule";
import {
  STOREFRONT_PROJECTION_MAPPING_VERSION,
  SUPPORTED_STOREFRONT_CAPSULE_VERSION,
  StorefrontProjectionError,
  evaluateStorefrontProjectionEligibility,
  storefrontSourceRecordToCapsuleProjection,
  verifyStorefrontCapsuleProjection,
  type StorefrontProjectionContext,
} from "../src/contracts/marketplace/storefront.projection";
import {
  NEVER_PROJECTION_ELIGIBLE_STOREFRONT_DATA,
  PROJECTION_ELIGIBLE_STOREFRONT_FIELDS,
  type StorefrontSourceVersion,
} from "../src/contracts/marketplace/storefront-source";
import {
  syntheticStorefrontProjectionContext,
  syntheticStorefrontSourceVersion,
} from "../src/contracts/fixtures/synthetic-storefront";

const source = (overrides: Partial<StorefrontSourceVersion> = {}): StorefrontSourceVersion => ({
  ...syntheticStorefrontSourceVersion(),
  ...overrides,
});

const context = (
  overrides: Partial<StorefrontProjectionContext> = {},
): StorefrontProjectionContext => ({
  ...syntheticStorefrontProjectionContext(),
  ...overrides,
});

const project = (
  sourceVersion: StorefrontSourceVersion = source(),
  ctx: StorefrontProjectionContext = context(),
) => storefrontSourceRecordToCapsuleProjection({ sourceVersion, context: ctx });

/**
 * A valid 26-character Crockford opaque body. I, L, O, and U are excluded from
 * the alphabet, so they are folded to `0` — otherwise a readable seed silently
 * produces an invalid identifier and the context fails schema validation, which
 * would report a *binding* test as a *context* failure.
 */
const body = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ansNode = (seed: string): string => `an:node:${body(seed)}`;

/** Every string value reachable in a value, for leak assertions. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((v) => allStrings(v, out));
  }
  return out;
}

// — 1. Valid source maps to a valid projection —

describe("1. a valid Storefront source version maps to a valid projection", () => {
  it("produces a capsule that validates", () => {
    const capsule = project();
    expect(validateStorefrontCapsuleProjection(capsule).ok).toBe(true);
  });

  it("carries exactly the four ANS top-level members", () => {
    expect(Object.keys(project()).sort()).toEqual(["@context", "@type", "data", "metadata"]);
  });

  it("declares the Storefront type", () => {
    expect(project()["@type"]).toBe(STOREFRONT_TYPE);
  });

  it("binds to the Registrar-issued Storefront Node, not the internal id", () => {
    const ctx = context();
    expect(project(source(), ctx).metadata.bindsToNode).toBe(
      ctx.storefrontBinding.storefrontNode,
    );
  });

  it("carries a content hash over the published shape", () => {
    expect(project().metadata.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// — 2/3. Determinism —

describe("2/3. mapping is deterministic and order-independent", () => {
  it("is byte-identical across repeated projections", () => {
    expect(JSON.stringify(project())).toBe(JSON.stringify(project()));
  });

  it("produces the same content hash for a reordered but equal source version", () => {
    const original = source();
    /* Same facts, different key insertion order. Canonicalisation must make the
       hash indifferent to how the object was built. */
    const reordered = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as unknown as StorefrontSourceVersion;

    expect(canonicalJsonString(original)).toBe(canonicalJsonString(reordered));
    expect(project(reordered).metadata.contentHash).toBe(project(original).metadata.contentHash);
  });

  it("produces the same hash for a reordered projection context", () => {
    const ctx = context();
    const reordered = Object.fromEntries(
      Object.entries(ctx).reverse(),
    ) as unknown as StorefrontProjectionContext;
    expect(project(source(), reordered).metadata.contentHash).toBe(
      project(source(), ctx).metadata.contentHash,
    );
  });

  it("verifies against its own re-derivation", () => {
    const result = verifyStorefrontCapsuleProjection({
      sourceVersion: source(),
      context: context(),
      capsule: project(),
    });
    expect(result.matches).toBe(true);
    expect(result.expectedContentHash).toBe(result.actualContentHash);
  });

  it("reports a mismatch when the body was edited but the stored hash left stale", () => {
    /* The exact tampering a stored-hash comparison would miss: the body changed,
       the hash did not. Verification recomputes, so it catches both. */
    const tampered = { ...project(), data: { ...project().data, name: "Different Shop" } };
    const result = verifyStorefrontCapsuleProjection({
      sourceVersion: source(),
      context: context(),
      capsule: tampered as ReturnType<typeof project>,
    });
    expect(result.matches).toBe(false);
    expect(result.storedContentHashConsistent).toBe(false);
  });

  it("reports a mismatch for a capsule built from a different source version", () => {
    const other = project(source({ publicHandle: "a-different-handle" }));
    const result = verifyStorefrontCapsuleProjection({
      sourceVersion: source(),
      context: context(),
      capsule: other,
    });
    expect(result.matches).toBe(false);
    /* That capsule is internally consistent — it is simply not this one. */
    expect(result.storedContentHashConsistent).toBe(true);
  });

  it("reads no clock — the generation instant comes from the context", () => {
    const a = project(source(), context({ generatedAt: "2026-05-05T00:00:00.000Z" }));
    const b = project(source(), context({ generatedAt: "2027-07-07T00:00:00.000Z" }));
    expect(a.metadata.provenance.generatedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(b.metadata.provenance.generatedAt).toBe("2027-07-07T00:00:00.000Z");
    expect(a.metadata.contentHash).not.toBe(b.metadata.contentHash);
  });
});

// — 4. Public fields map exactly —

describe("4. public storefront fields map exactly", () => {
  it("maps handle, display name, tagline, and summary onto the public terms", () => {
    const src = source();
    const data = project(src).data;
    expect(data.publicHandle).toBe(src.publicHandle);
    expect(data.name).toBe(src.presentation.displayName);
    expect(data.slogan).toBe(src.presentation.tagline);
    expect(data.description).toBe(src.presentation.summary);
  });

  it("omits an absent tagline and summary rather than publishing null", () => {
    const data = project(
      source({
        presentation: { displayName: "Bare Shop", tagline: null, summary: null },
      }),
    ).data;
    expect("slogan" in data).toBe(false);
    expect("description" in data).toBe(false);
    expect(JSON.stringify(data)).not.toContain("null");
  });

  it("refuses an explicit null, so absence has one spelling", () => {
    const parsed = StorefrontCapsuleDataBase.safeParse({
      ...project().data,
      slogan: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("publishes discoverable true for PUBLIC and false for UNLISTED", () => {
    expect(project(source({ visibility: "PUBLIC" })).data.discoverable).toBe(true);
    expect(project(source({ visibility: "UNLISTED" })).data.discoverable).toBe(false);
  });

  it("does not republish the raw lifecycle or visibility vocabulary", () => {
    const capsule = project();
    expect("lifecycle" in capsule.data).toBe(false);
    expect("visibility" in capsule.data).toBe(false);
    for (const value of allStrings(capsule.data)) {
      expect(value).not.toBe("ACTIVE");
      expect(value).not.toBe("PUBLIC");
      expect(value).not.toBe("SUSPENDED");
      expect(value).not.toBe("PRIVATE");
    }
  });
});

// — 5. Owner relationship —

describe("5. the owner relation maps to the approved authority Node", () => {
  it("publishes operatedBy from the context binding", () => {
    const ctx = context();
    expect(project(source(), ctx).data.relationships.operatedBy).toBe(
      ctx.ownerBinding.ownerAuthorityNode,
    );
  });

  it("refuses a context whose owner binding names a different participant", () => {
    const ctx = context({
      ownerBinding: {
        ownerAuthorityNode: ansNode("0M3BOTHERNODE"),
        ownerParticipantId: `mon:mpart:${body("0M3BOTHERPART")}`,
      },
    });
    expect(() => project(source(), ctx)).toThrow(StorefrontProjectionError);
    try {
      project(source(), ctx);
    } catch (error) {
      expect((error as StorefrontProjectionError).code).toBe("OWNER_BINDING_MISMATCH");
    }
  });

  it("refuses a storefront binding for a different internal storefront", () => {
    const ctx = context({
      storefrontBinding: {
        storefrontNode: ansNode("0M3BNODEX"),
        internalStorefrontId: `mon:storefront:${body("0M3BOTHERSTFRNT")}`,
      },
    });
    try {
      project(source(), ctx);
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as StorefrontProjectionError).code).toBe("STOREFRONT_BINDING_MISMATCH");
    }
  });

  it("refuses a context naming a different source version", () => {
    const ctx = context({
      sourceVersionBinding: {
        storefrontSourceRecordId: syntheticStorefrontSourceVersion().storefrontSourceRecordId,
        sourceRecordVersion: "99",
      },
    });
    try {
      project(source(), ctx);
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as StorefrontProjectionError).code).toBe("SOURCE_VERSION_BINDING_MISMATCH");
    }
  });

  it("publishes no governance role, admin, or authorizing actor", () => {
    const capsule = project();
    const serialized = JSON.stringify(capsule);
    for (const forbidden of ["SUPER_OWNER", "ADMIN", "authorizedBy", "governance"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// — 6. Provenance —

describe("6. provenance maps exactly from the source version", () => {
  it("preserves source class, system, type, record id, and version", () => {
    const src = source();
    const p = project(src).metadata.provenance;
    expect(p.sourceClass).toBe(src.sourceClass);
    expect(p.sourceSystem).toBe(src.sourceSystem);
    expect(p.sourceRecordType).toBe(src.sourceRecordType);
    expect(p.sourceRecordId).toBe(src.storefrontSourceRecordId);
    expect(p.sourceRecordVersion).toBe(src.sourceRecordVersion);
  });

  it("represents the recorded instant rather than creating one", () => {
    expect(project().metadata.provenance.acquiredAt).toBe(source().recordedAt);
  });

  it("asserts rather than infers", () => {
    expect(project().metadata.provenance.assertionKind).toBe("Asserted");
  });

  it("stamps the mapping version as the generator version", () => {
    expect(project().metadata.provenance.generatorVersion).toBe(
      STOREFRONT_PROJECTION_MAPPING_VERSION,
    );
  });

  it("keeps owner authority and Monacado Publisher identity distinct", () => {
    const capsule = project();
    /* The capsule states who OPERATES the storefront. It states nothing about who
       published it — publishedBy is a publication fact this phase does not have. */
    expect(capsule.data.relationships.operatedBy).toBeDefined();
    expect("publishedBy" in capsule.metadata).toBe(false);
    expect("publishedAt" in capsule.metadata).toBe(false);
  });

  it("omits supersedes and revokes, which are publication facts", () => {
    expect("supersedes" in project().metadata).toBe(false);
    expect("revokes" in project().metadata).toBe(false);
  });
});

// — 7–12. Leakage —

describe("7-12. private and internal data cannot reach the capsule", () => {
  const capsule = project();
  const serialized = JSON.stringify(capsule);
  const dataSerialized = JSON.stringify(capsule.data);

  it("7. does not leak the internal storefront id into data", () => {
    expect(dataSerialized).not.toContain("mon:storefront:");
    expect(dataSerialized).not.toContain(source().internalStorefrontId);
  });

  it("7b. permits mon:srec: only in provenance, the approved traceability pattern", () => {
    expect(capsule.metadata.provenance.sourceRecordId).toContain("mon:srec:");
    expect(dataSerialized).not.toContain("mon:srec:");
  });

  it("8. does not leak an account identifier", () => {
    expect(serialized).not.toContain("mon:acct:");
    expect(serialized).not.toContain("mon:asess:");
    expect(serialized).not.toContain("mon:aent:");
  });

  it("9. does not leak participant or private profile identifiers", () => {
    for (const prefix of ["mon:mpart:", "mon:mprof:", "mon:mrole:", "mon:mact:"]) {
      expect(serialized).not.toContain(prefix);
    }
  });

  it("10. does not leak an email address", () => {
    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(dataSerialized.toLowerCase()).not.toContain("email");
  });

  it("10b. does not leak terms acceptance or verification timestamps", () => {
    for (const field of ["termsAcceptedAt", "termsVersion", "emailVerifiedAt"]) {
      expect(serialized).not.toContain(field);
    }
  });

  it("11. does not leak payment, payout, or provider data", () => {
    for (const field of [
      "paymentReadiness",
      "paymentProviderId",
      "payout",
      "stripe",
      "acct_",
      "mon:mpay:",
      "billingPlan",
      "subscriptionPlan",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(field.toLowerCase());
    }
  });

  it("12. does not leak moderation, activation, or workflow internals", () => {
    for (const field of [
      "internalModerationNotes",
      "moderation",
      "underwriting",
      "activation",
      "analytics",
      "auditInternals",
      "sourceRetentionState",
      "legalHoldState",
      "goLiveApproval",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(field.toLowerCase());
    }
  });

  it("refuses every 0M.3A never-eligible datum as a data key", () => {
    for (const forbidden of NEVER_PROJECTION_ELIGIBLE_STOREFRONT_DATA) {
      const parsed = StorefrontCapsuleDataBase.safeParse({
        ...capsule.data,
        [forbidden]: "x",
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("refuses an internal identifier smuggled into a public string field", () => {
    const leaky = {
      ...capsule,
      data: { ...capsule.data, name: `Shop ${source().ownerParticipantId}` },
    };
    const result = StorefrontCapsuleProjection.safeParse(leaky);
    expect(result.success).toBe(false);
  });

  it("guards mon:storefront: at the shared prefix list", () => {
    expect(FORBIDDEN_INTERNAL_ID_PREFIXES).toContain("mon:storefront:");
    /* Still absent, and deliberately: provenance depends on it. */
    expect(FORBIDDEN_INTERNAL_ID_PREFIXES).not.toContain("mon:srec:");
  });
});

// — 13/14. No Listing, Offer, or pricing claims —

describe("13/14. no Listing, Offer, or commercial claim appears", () => {
  it("publishes no listing container of any kind", () => {
    const capsule = project();
    for (const field of ["listings", "listingContents", "listingOrdering", "containsListing"]) {
      expect(JSON.stringify(capsule)).not.toContain(field);
    }
  });

  it("publishes no price, currency, or commission term", () => {
    const serialized = JSON.stringify(project());
    for (const field of [
      "price",
      "priceType",
      "wholesalePriceMinorUnits",
      "priceCurrency",
      "commission",
      "commissionMethod",
      "commissionBasisPoints",
      "itemOffered",
      "offeredBy",
    ]) {
      expect(serialized).not.toContain(field);
    }
  });

  it("refuses a commercial field added to data", () => {
    for (const field of ["price", "commission", "listings", "itemOffered"]) {
      const parsed = StorefrontCapsuleDataBase.safeParse({
        ...project().data,
        [field]: "x",
      });
      expect(parsed.success).toBe(false);
    }
  });
});

// — 15/16. Strictness —

describe("15/16. unknown fields and malformed sources fail", () => {
  it("15. refuses an unknown data field", () => {
    expect(
      StorefrontCapsuleDataBase.safeParse({ ...project().data, extra: "x" }).success,
    ).toBe(false);
  });

  it("15b. refuses an unknown top-level or metadata member", () => {
    const capsule = project();
    expect(StorefrontCapsuleProjection.safeParse({ ...capsule, extra: 1 }).success).toBe(false);
    expect(
      StorefrontCapsuleProjection.safeParse({
        ...capsule,
        metadata: { ...capsule.metadata, publishedBy: "an:publisher:monacado" },
      }).success,
    ).toBe(false);
  });

  it("15c. refuses an unknown projection-context field", () => {
    expect(() =>
      project(source(), { ...context(), surprise: true } as unknown as StorefrontProjectionContext),
    ).toThrow(StorefrontProjectionError);
  });

  it("16. refuses a malformed source version", () => {
    const bad = { ...source(), publicHandle: "Not A Handle" } as StorefrontSourceVersion;
    try {
      project(bad);
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as StorefrontProjectionError).code).toBe("INVALID_SOURCE_VERSION");
    }
  });

  it("16b. refuses a source version missing its lineage", () => {
    const bad = { ...source() } as Record<string, unknown>;
    delete bad.sourceRecordVersion;
    try {
      project(bad as unknown as StorefrontSourceVersion);
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as StorefrontProjectionError).code).toBe("INVALID_SOURCE_VERSION");
    }
  });

  it("pins the capsule and mapping versions", () => {
    try {
      project(source(), context({ capsuleVersion: "2.0.0" }));
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as StorefrontProjectionError).code).toBe("UNSUPPORTED_CAPSULE_VERSION");
    }
    try {
      project(source(), context({ mappingVersion: "storefront-projection/9.9.9" }));
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as StorefrontProjectionError).code).toBe("UNSUPPORTED_MAPPING_VERSION");
    }
    expect(SUPPORTED_STOREFRONT_CAPSULE_VERSION).toBe("1.0.0");
  });
});

// — 17. One-way —

describe("17. projection is one-way", () => {
  it("exports no inverse mapper", async () => {
    const projection = await import("../src/contracts/marketplace/storefront.projection");
    const capsule = await import("../src/contracts/marketplace/storefront.capsule");
    const names = [...Object.keys(projection), ...Object.keys(capsule)];
    for (const name of names) {
      expect(name).not.toMatch(/CapsuleToSource|capsuleTo|ToSourceRecord|applyCapsule|writeBack/i);
    }
  });

  it("never mutates the source version it is given", () => {
    const src = source();
    const before = JSON.stringify(src);
    project(src);
    expect(JSON.stringify(src)).toBe(before);
  });

  it("never mutates the context it is given", () => {
    const ctx = context();
    const before = JSON.stringify(ctx);
    project(source(), ctx);
    expect(JSON.stringify(ctx)).toBe(before);
  });
});

// — Eligibility —

describe("eligibility fails closed", () => {
  it("refuses DRAFT", () => {
    expect(
      evaluateStorefrontProjectionEligibility({
        lifecycle: "DRAFT",
        visibility: "PUBLIC",
        goLiveApproval: "APPROVED",
      }),
    ).toEqual({ eligible: false, reason: "DRAFT_NOT_PUBLIC" });
  });

  it("defers SUSPENDED and CLOSED to a publication-lifecycle decision", () => {
    expect(
      evaluateStorefrontProjectionEligibility({
        lifecycle: "SUSPENDED",
        visibility: "PUBLIC",
        goLiveApproval: "APPROVED",
      }),
    ).toEqual({ eligible: false, reason: "SUSPENDED_PUBLICATION_DEFERRED" });
    expect(
      evaluateStorefrontProjectionEligibility({
        lifecycle: "CLOSED",
        visibility: "PUBLIC",
        goLiveApproval: "APPROVED",
      }),
    ).toEqual({ eligible: false, reason: "CLOSED_PUBLICATION_DEFERRED" });
  });

  it("refuses a PRIVATE storefront", () => {
    expect(
      evaluateStorefrontProjectionEligibility({
        lifecycle: "ACTIVE",
        visibility: "PRIVATE",
        goLiveApproval: "APPROVED",
      }),
    ).toEqual({ eligible: false, reason: "VISIBILITY_NOT_PUBLIC" });
  });

  it("refuses a storefront Monacado has not approved to go live", () => {
    expect(
      evaluateStorefrontProjectionEligibility({
        lifecycle: "ACTIVE",
        visibility: "PUBLIC",
        goLiveApproval: "NOT_APPROVED",
      }),
    ).toEqual({ eligible: false, reason: "GO_LIVE_NOT_APPROVED" });
  });

  it("stops the mapper, not just the evaluator", () => {
    for (const lifecycle of ["DRAFT", "SUSPENDED", "CLOSED"] as const) {
      try {
        project(source({ lifecycle }));
        throw new Error("expected a projection error");
      } catch (error) {
        expect((error as StorefrontProjectionError).code).toBe("NOT_PROJECTION_ELIGIBLE");
      }
    }
    try {
      project(source(), context({ goLiveApproval: "NOT_APPROVED" }));
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as StorefrontProjectionError).reason).toBe("GO_LIVE_NOT_APPROVED");
    }
  });

  it("carries no source value or internal id on the error", () => {
    try {
      project(source({ lifecycle: "DRAFT" }));
    } catch (error) {
      const serialized = JSON.stringify({
        message: (error as Error).message,
        code: (error as StorefrontProjectionError).code,
      });
      expect(serialized).not.toContain("mon:");
      expect(serialized).not.toContain("synthetic-example-shop");
    }
  });
});

// — Allow-list is the boundary —

describe("the public allow-list is the privacy boundary", () => {
  it("matches the schema's own data keys exactly", () => {
    expect(Object.keys(StorefrontCapsuleDataBase.shape).sort()).toEqual(
      [...PUBLIC_STOREFRONT_CAPSULE_FIELDS].sort(),
    );
  });

  it("emits only allow-listed keys for a fully populated storefront", () => {
    expect(Object.keys(project().data).sort()).toEqual(
      [...PUBLIC_STOREFRONT_CAPSULE_FIELDS].sort(),
    );
  });

  it("accounts for every 0M.3A projection-eligible source fact", () => {
    /* Each eligible fact is either published under a public term or deliberately
       consumed as a Node binding. Nothing is eligible-but-forgotten. */
    const disposition: Record<(typeof PROJECTION_ELIGIBLE_STOREFRONT_FIELDS)[number], string> = {
      internalStorefrontId: "consumed as the Storefront Node binding (metadata.bindsToNode)",
      ownerParticipantId: "consumed as the owner authority Node binding (data.relationships.operatedBy)",
      publicHandle: "published as data.publicHandle",
      displayName: "published as data.name",
      tagline: "published as data.slogan",
      summary: "published as data.description",
      lifecycle: "consumed by eligibility; never republished",
      visibility: "consumed by eligibility and data.discoverable; never republished",
    };
    for (const field of PROJECTION_ELIGIBLE_STOREFRONT_FIELDS) {
      expect(disposition[field]).toBeTruthy();
    }
    expect(Object.keys(disposition).sort()).toEqual([...PROJECTION_ELIGIBLE_STOREFRONT_FIELDS].sort());
  });
});
