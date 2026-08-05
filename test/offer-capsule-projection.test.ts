/**
 * Offer Capsule Projection tests (Phase 0M.2B).
 *
 * NO DATABASE, NO NETWORK, NO CLOCK. The mapper is a pure function of one
 * identified source version plus one validated context; every instant in this
 * file is an explicit literal.
 *
 * The numbered `describe` blocks correspond one-to-one with the properties Phase
 * 0M.2B was required to prove.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publishedContentHash } from "../src/contracts/integrity/hash";
import { COMMERCE_CONTEXT } from "../src/contracts/ontology/commerce.context";
import { ALL_TERMS } from "../src/contracts/ontology/commerce.ontology";
import {
  OfferSourceVersion,
  calculateOfferEconomics,
} from "../src/contracts/marketplace/offer-source";
import {
  FORBIDDEN_INTERNAL_ID_PREFIXES,
  OFFER_TYPE,
  OfferCapsuleData,
  OfferCapsuleProjection,
  PUBLIC_COMMERCIAL_STATES,
  PublicCommercialState,
  findInternalIdentifiers,
  validateOfferCapsuleProjection,
} from "../src/contracts/marketplace/offer.capsule";
import {
  CORRECTED_OFFER_CAPSULE_MAJOR,
  SUPPORTED_OFFER_CAPSULE_VERSION,
  OFFER_PROJECTION_MAPPING_VERSION,
  OfferProjectionContext,
  OfferProjectionError,
  evaluateOfferProjectionEligibility,
  projectOfferCapsule,
} from "../src/contracts/marketplace/offer.projection";

// — Fixtures —

const body = (n: number): string => String(n).padStart(26, "0");
const opaque = (n: number): string => `${"0".repeat(25)}${n.toString(36).toUpperCase()}`;

const OFFER_SREC_ID = `mon:srec:${body(1)}`;
const INTERNAL_OFFER_ID = `mon:offer:${body(2)}`;
const PRODUCT_ID = `mon:product:${body(3)}`;
const OTHER_PRODUCT_ID = `mon:product:${body(4)}`;
const SELLER_PARTICIPANT_ID = `mon:mpart:${body(5)}`;
const OTHER_PARTICIPANT_ID = `mon:mpart:${body(6)}`;
const ACTOR_ID = `mon:actor:${body(7)}`;

const OFFER_NODE = `an:node:${opaque(1)}`;
const PRODUCT_NODE = `an:node:${opaque(2)}`;
const AUTHORITY_NODE = `an:node:${opaque(3)}`;
const CAPSULE_ID = `an:capsule:${opaque(4)}`;

const PAID_TERMS = {
  price: { type: "PAID", wholesalePriceMinorUnits: 10_000, wholesalePriceCurrency: "USD" },
  promotion: { type: "NOT_PROMOTABLE" },
} as const;

function sourceVersion(overrides: Record<string, unknown> = {}): OfferSourceVersion {
  return OfferSourceVersion.parse({
    offerSourceRecordId: OFFER_SREC_ID,
    sourceRecordVersion: "3",
    supersedesSourceRecordVersion: "2",
    internalOfferId: INTERNAL_OFFER_ID,
    sourceSystem: "monacado",
    sourceRecordType: "Offer",
    sourceClass: "governed-database-record",
    internalProductId: PRODUCT_ID,
    sellerParticipantId: SELLER_PARTICIPANT_ID,
    lifecycle: "ACTIVE",
    availability: "AVAILABLE",
    terms: PAID_TERMS,
    effectiveInterval: null,
    economics: calculateOfferEconomics((overrides.terms ?? PAID_TERMS) as never),
    authorizedBySellerParticipantId: SELLER_PARTICIPANT_ID,
    authorizedByActorId: ACTOR_ID,
    recordedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  });
}

function projectionContext(overrides: Record<string, unknown> = {}): OfferProjectionContext {
  return OfferProjectionContext.parse({
    offerBinding: { offerNode: OFFER_NODE, internalOfferId: INTERNAL_OFFER_ID },
    productBinding: { productNode: PRODUCT_NODE, internalProductId: PRODUCT_ID },
    authorityBinding: {
      authorityNode: AUTHORITY_NODE,
      sellerParticipantId: SELLER_PARTICIPANT_ID,
    },
    sourceVersionBinding: { offerSourceRecordId: OFFER_SREC_ID, sourceRecordVersion: "3" },
    capsuleId: CAPSULE_ID,
    capsuleVersion: "2.0.0",
    mappingVersion: OFFER_PROJECTION_MAPPING_VERSION,
    generatedAt: "2026-08-02T09:00:00.000Z",
    nodePolicy: { ref: "mon:policy:node/offer", version: "1" },
    capsulePolicy: { ref: "mon:policy:capsule/offer", version: "1" },
    ...overrides,
  });
}

function project(
  sourceOverrides: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
) {
  return projectOfferCapsule({
    sourceVersion: sourceVersion(sourceOverrides),
    context: projectionContext(contextOverrides),
  });
}

function expectProjectionError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected OfferProjectionError(${code}), but no error was thrown`);
  } catch (error) {
    expect(error).toBeInstanceOf(OfferProjectionError);
    expect((error as OfferProjectionError).code).toBe(code);
  }
}

// — 1 —

describe("1. an exact OfferSourceVersion is required", () => {
  it("projects from a complete identified source version", () => {
    const capsule = project();
    expect(capsule.metadata.provenance.sourceRecordId).toBe(OFFER_SREC_ID);
    expect(capsule.metadata.provenance.sourceRecordVersion).toBe("3");
  });

  it("refuses a source version that does not validate", () => {
    expectProjectionError(
      () =>
        projectOfferCapsule({
          sourceVersion: { ...sourceVersion(), sourceRecordVersion: "" } as never,
          context: projectionContext(),
        }),
      "INVALID_SOURCE_VERSION",
    );
  });

  it("refuses a source version missing its identity", () => {
    const { offerSourceRecordId: _omitted, ...withoutId } = sourceVersion();
    expectProjectionError(
      () =>
        projectOfferCapsule({
          sourceVersion: withoutId as never,
          context: projectionContext(),
        }),
      "INVALID_SOURCE_VERSION",
    );
  });

  it("the context must name the exact version being projected", () => {
    expectProjectionError(
      () =>
        project(
          {},
          { sourceVersionBinding: { offerSourceRecordId: OFFER_SREC_ID, sourceRecordVersion: "2" } },
        ),
      "SOURCE_VERSION_BINDING_MISMATCH",
    );
    expectProjectionError(
      () =>
        project(
          {},
          {
            sourceVersionBinding: {
              offerSourceRecordId: `mon:srec:${body(99)}`,
              sourceRecordVersion: "3",
            },
          },
        ),
      "SOURCE_VERSION_BINDING_MISMATCH",
    );
  });
});

// — 2 —

describe("2. a current record or 'latest' input is impossible", () => {
  it("the mapper takes only a source version and a context", () => {
    /* There is no repository, no loader, and no 'latest' parameter to pass. */
    expect(projectOfferCapsule.length).toBe(1);
  });

  it("an OfferSourceRecord is not an OfferSourceVersion and is refused", () => {
    /* The current record carries `currentSourceRecordVersion`, `createdAt`, and
       `updatedAt`, and lacks the authorization trace — so handing one to the
       mapper fails at the schema rather than projecting today's facts under an
       old obligation. */
    const currentRecord = {
      offerSourceRecordId: OFFER_SREC_ID,
      internalOfferId: INTERNAL_OFFER_ID,
      currentSourceRecordVersion: "3",
      internalProductId: PRODUCT_ID,
      sellerParticipantId: SELLER_PARTICIPANT_ID,
      sourceSystem: "monacado",
      sourceRecordType: "Offer",
      sourceClass: "governed-database-record",
      lifecycle: "ACTIVE",
      availability: "AVAILABLE",
      terms: PAID_TERMS,
      effectiveInterval: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    expectProjectionError(
      () =>
        projectOfferCapsule({
          sourceVersion: currentRecord as never,
          context: projectionContext(),
        }),
      "INVALID_SOURCE_VERSION",
    );
  });

  it("the source module is never imported for a query helper", () => {
    const source = readFileSync(
      new URL("../src/contracts/marketplace/offer.projection.ts", import.meta.url),
      "utf8",
    );
    /* Code tokens only — the prose above deliberately uses the word "latest" to
       say the mapper must never read it. */
    for (const token of [
      "findFirst",
      "findMany",
      "findLatest",
      "getLatest",
      "prisma",
      "Repository",
      "OfferSourceRecord.parse",
    ]) {
      expect(source).not.toContain(token);
    }
  });
});

// — 3 —

describe("3. the projection context is strict", () => {
  it("rejects unknown keys", () => {
    expect(
      OfferProjectionContext.safeParse({ ...projectionContext(), publishedAt: "x" }).success,
    ).toBe(false);
    expect(
      OfferProjectionContext.safeParse({ ...projectionContext(), extra: 1 }).success,
    ).toBe(false);
  });

  it("requires every binding, the capsule identity, mapping version, and instant", () => {
    for (const key of [
      "offerBinding",
      "productBinding",
      "authorityBinding",
      "sourceVersionBinding",
      "capsuleId",
      "capsuleVersion",
      "mappingVersion",
      "generatedAt",
      "nodePolicy",
      "capsulePolicy",
    ]) {
      const partial = { ...projectionContext() } as Record<string, unknown>;
      delete partial[key];
      expect(OfferProjectionContext.safeParse(partial).success, `${key} must be required`).toBe(
        false,
      );
    }
  });

  it("requires a UTC generation instant and a semver capsule version", () => {
    expect(
      OfferProjectionContext.safeParse({
        ...projectionContext(),
        generatedAt: "2026-08-02T09:00:00+02:00",
      }).success,
    ).toBe(false);
    expect(
      OfferProjectionContext.safeParse({ ...projectionContext(), capsuleVersion: "1" }).success,
    ).toBe(false);
  });

  it("an invalid context fails closed", () => {
    expectProjectionError(
      () =>
        projectOfferCapsule({
          sourceVersion: sourceVersion(),
          context: { ...projectionContext(), capsuleVersion: "not-semver" } as never,
        }),
      "INVALID_PROJECTION_CONTEXT",
    );
  });
});

// — 4 —

describe("4. the Offer Node differs from the internal Offer identity", () => {
  it("the capsule binds to the Node, never to mon:offer:", () => {
    const capsule = project();
    expect(capsule.metadata.bindsToNode).toBe(OFFER_NODE);
    expect(capsule.metadata.bindsToNode).not.toBe(INTERNAL_OFFER_ID);
    expect(JSON.stringify(capsule)).not.toContain(INTERNAL_OFFER_ID);
  });

  it("an internal identifier cannot be used as a Node", () => {
    for (const bad of [INTERNAL_OFFER_ID, OFFER_SREC_ID, PRODUCT_ID, SELLER_PARTICIPANT_ID]) {
      expect(
        OfferProjectionContext.safeParse({
          ...projectionContext(),
          offerBinding: { offerNode: bad, internalOfferId: INTERNAL_OFFER_ID },
        }).success,
      ).toBe(false);
    }
  });

  it("a mismatched Offer binding is refused", () => {
    expectProjectionError(
      () =>
        project(
          {},
          {
            offerBinding: {
              offerNode: OFFER_NODE,
              internalOfferId: `mon:offer:${body(98)}`,
            },
          },
        ),
      "OFFER_BINDING_MISMATCH",
    );
  });
});

// — 5 —

describe("5. a Product binding mismatch fails", () => {
  it("refuses a Product binding for a different Product", () => {
    expectProjectionError(
      () =>
        project(
          {},
          { productBinding: { productNode: PRODUCT_NODE, internalProductId: OTHER_PRODUCT_ID } },
        ),
      "PRODUCT_BINDING_MISMATCH",
    );
  });

  it("the internal Product id never reaches the capsule", () => {
    const capsule = project();
    expect(capsule.data.relationships.itemOffered).toBe(PRODUCT_NODE);
    expect(JSON.stringify(capsule)).not.toContain(PRODUCT_ID);
  });
});

// — 6 —

describe("6. a Seller/public-authority binding mismatch fails", () => {
  it("refuses an authority binding for a different participant", () => {
    expectProjectionError(
      () =>
        project(
          {},
          {
            authorityBinding: {
              authorityNode: AUTHORITY_NODE,
              sellerParticipantId: OTHER_PARTICIPANT_ID,
            },
          },
        ),
      "AUTHORITY_BINDING_MISMATCH",
    );
  });

  it("the participant id never reaches the capsule", () => {
    const capsule = project();
    expect(capsule.data.relationships.offeredBy).toBe(AUTHORITY_NODE);
    expect(JSON.stringify(capsule)).not.toContain(SELLER_PARTICIPANT_ID);
  });
});

// — 7–11 —

describe("7–11. eligibility maps lifecycle and availability correctly", () => {
  it("DRAFT is ineligible", () => {
    expect(
      evaluateOfferProjectionEligibility({ lifecycle: "DRAFT", availability: "AVAILABLE" }),
    ).toEqual({ eligible: false, reason: "DRAFT_NOT_PUBLIC" });
    expectProjectionError(() => project({ lifecycle: "DRAFT" }), "NOT_PROJECTION_ELIGIBLE");
  });

  it("ACTIVE + AVAILABLE maps to AVAILABLE", () => {
    expect(
      evaluateOfferProjectionEligibility({ lifecycle: "ACTIVE", availability: "AVAILABLE" }),
    ).toEqual({ eligible: true, commercialState: "AVAILABLE" });
    expect(project().data.commercialState).toBe("AVAILABLE");
  });

  it("ACTIVE + TEMPORARILY_UNAVAILABLE maps to TEMPORARILY_UNAVAILABLE", () => {
    expect(
      evaluateOfferProjectionEligibility({
        lifecycle: "ACTIVE",
        availability: "TEMPORARILY_UNAVAILABLE",
      }),
    ).toEqual({ eligible: true, commercialState: "TEMPORARILY_UNAVAILABLE" });
    expect(project({ availability: "TEMPORARILY_UNAVAILABLE" }).data.commercialState).toBe(
      "TEMPORARILY_UNAVAILABLE",
    );
  });

  it("ENDED maps to ENDED, whatever the availability field says", () => {
    for (const availability of ["AVAILABLE", "TEMPORARILY_UNAVAILABLE"] as const) {
      expect(evaluateOfferProjectionEligibility({ lifecycle: "ENDED", availability })).toEqual({
        eligible: true,
        commercialState: "ENDED",
      });
    }
    expect(project({ lifecycle: "ENDED" }).data.commercialState).toBe("ENDED");
  });

  it("SUSPENDED and WITHDRAWN are ineligible in this phase", () => {
    expect(
      evaluateOfferProjectionEligibility({ lifecycle: "SUSPENDED", availability: "AVAILABLE" }),
    ).toEqual({ eligible: false, reason: "SUSPENDED_PUBLICATION_DEFERRED" });
    expect(
      evaluateOfferProjectionEligibility({ lifecycle: "WITHDRAWN", availability: "AVAILABLE" }),
    ).toEqual({ eligible: false, reason: "WITHDRAWN_PUBLICATION_DEFERRED" });

    for (const lifecycle of ["SUSPENDED", "WITHDRAWN"] as const) {
      expectProjectionError(() => project({ lifecycle }), "NOT_PROJECTION_ELIGIBLE");
    }
  });

  it("the public vocabulary cannot express DRAFT, SUSPENDED, or WITHDRAWN", () => {
    expect(PUBLIC_COMMERCIAL_STATES).toEqual(["AVAILABLE", "TEMPORARILY_UNAVAILABLE", "ENDED"]);
    for (const internal of ["DRAFT", "SUSPENDED", "WITHDRAWN"]) {
      expect(PublicCommercialState.safeParse(internal).success).toBe(false);
    }
  });

  it("producing an ENDED projection publishes, supersedes, and revokes nothing", () => {
    const capsule = project({ lifecycle: "ENDED" });
    for (const key of ["publishedBy", "publishedAt", "supersedes", "revokes"]) {
      expect(Object.keys(capsule.metadata)).not.toContain(key);
    }
  });
});

// — 12 —

describe("12. a FREE projection carries no amount or currency", () => {
  const free = {
    terms: { price: { type: "FREE" }, promotion: { type: "NOT_PROMOTABLE" } },
  };

  it("emits only the price type", () => {
    expect(project(free).data.price).toEqual({ priceType: "FREE" });
  });

  it("has no field for an amount or currency", () => {
    const capsule = project(free);
    expect(Object.keys(capsule.data.price)).toEqual(["priceType"]);
    expect(
      OfferCapsuleData.safeParse({
        ...capsule.data,
        price: { priceType: "FREE", wholesalePriceMinorUnits: 100 },
      }).success,
    ).toBe(false);
  });

  it("a FREE Offer is never promotable in the projection", () => {
    expect(project(free).data.promotable).toBe(false);
    expect(project(free).data.commission).toBeUndefined();
  });
});

// — 13 —

describe("13. a PAID projection preserves minor units and currency", () => {
  it("carries the exact integer amount and currency", () => {
    expect(project().data.price).toEqual({
      priceType: "PAID",
      wholesalePriceMinorUnits: 10_000,
      wholesalePriceCurrency: "USD",
    });
  });

  it("never converts money to a decimal", () => {
    const serialized = JSON.stringify(project());
    expect(serialized).toContain('"wholesalePriceMinorUnits":10000');
    expect(serialized).not.toContain("100.00");
    expect(
      OfferCapsuleData.safeParse({
        ...project().data,
        price: { priceType: "PAID", wholesalePriceMinorUnits: 99.99, wholesalePriceCurrency: "USD" },
      }).success,
    ).toBe(false);
  });
});

// — 14 —

describe("14. an absent effective interval has one canonical output", () => {
  it("omits both bounds when the source has no interval", () => {
    const capsule = project({ effectiveInterval: null });
    expect(Object.keys(capsule.data)).not.toContain("validFrom");
    expect(Object.keys(capsule.data)).not.toContain("validThrough");
  });

  it("emits only the bounds the source holds", () => {
    const fromOnly = project({
      effectiveInterval: { startsAt: "2026-09-01T00:00:00.000Z", endsAt: null },
    });
    expect(fromOnly.data.validFrom).toBe("2026-09-01T00:00:00.000Z");
    expect(Object.keys(fromOnly.data)).not.toContain("validThrough");

    const throughOnly = project({
      effectiveInterval: { startsAt: null, endsAt: "2026-10-01T00:00:00.000Z" },
    });
    expect(throughOnly.data.validThrough).toBe("2026-10-01T00:00:00.000Z");
    expect(Object.keys(throughOnly.data)).not.toContain("validFrom");
  });

  it("an explicit null bound is not a valid public representation", () => {
    expect(
      OfferCapsuleData.safeParse({ ...project().data, validFrom: null }).success,
    ).toBe(false);
  });

  it("absence produces one hash, not two", () => {
    /* The source has exactly one representation of "no interval", so there is
       exactly one capsule and one hash for it. */
    const a = project({ effectiveInterval: null });
    const b = project({ effectiveInterval: null });
    expect(a.metadata.contentHash).toBe(b.metadata.contentHash);
  });

  it("ordering survives projection", () => {
    expect(
      OfferCapsuleData.safeParse({
        ...project().data,
        validFrom: "2026-10-01T00:00:00.000Z",
        validThrough: "2026-09-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

// — 15 —

describe("15. promotion and commission mapping preserves source truth", () => {
  const percentage = {
    terms: {
      price: PAID_TERMS.price,
      promotion: { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 1_500 } },
    },
  };
  const fixed = {
    terms: {
      price: PAID_TERMS.price,
      promotion: {
        type: "PROMOTABLE",
        commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 2_500, fixedCommissionCurrency: "USD" },
      },
    },
  };

  it("maps a percentage commission in basis points", () => {
    const capsule = project(percentage);
    expect(capsule.data.promotable).toBe(true);
    expect(capsule.data.commission).toEqual({
      commissionMethod: "PERCENT_OF_WHOLESALE",
      commissionBasisPoints: 1_500,
      calculatedCommissionMinorUnits: 1_500,
    });
  });

  it("a non-promotable Offer publishes no commission", () => {
    expect(project().data.promotable).toBe(false);
    expect(project().data.commission).toBeUndefined();
  });

  it("the published shape re-enforces the source rules", () => {
    const data = project(fixed).data;
    expect(OfferCapsuleData.safeParse({ ...data, promotable: false }).success).toBe(false);
    expect(
      OfferCapsuleData.safeParse({
        ...data,
        commission: {
          commissionMethod: "FIXED_AMOUNT",
          fixedCommissionMinorUnits: 10_001,
          fixedCommissionCurrency: "USD",
          calculatedCommissionMinorUnits: 10_001,
        },
      }).success,
    ).toBe(false);
    expect(
      OfferCapsuleData.safeParse({
        ...data,
        commission: {
          commissionMethod: "PERCENT_OF_WHOLESALE",
          commissionBasisPoints: 10_001,
          calculatedCommissionMinorUnits: 10_001,
        },
      }).success,
    ).toBe(false);
  });
});

// — 15b —

describe("15b. a fixed commission publishes its own currency", () => {
  const fixedUsd = {
    terms: {
      price: PAID_TERMS.price, // 10 000 USD
      promotion: {
        type: "PROMOTABLE",
        commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 2_500, fixedCommissionCurrency: "USD" },
      },
    },
  };
  const fixedEur = {
    terms: {
      price: { type: "PAID", wholesalePriceMinorUnits: 8_000, wholesalePriceCurrency: "EUR" },
      promotion: {
        type: "PROMOTABLE",
        commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 800, fixedCommissionCurrency: "EUR" },
      },
    },
  };

  it("1. emits the currency alongside the amount", () => {
    /* A monetary amount published without a currency is not a monetary amount. */
    expect(project(fixedUsd).data.commission).toEqual({
      commissionMethod: "FIXED_AMOUNT",
      fixedCommissionMinorUnits: 2_500,
      fixedCommissionCurrency: "USD",
      calculatedCommissionMinorUnits: 2_500,
    });
  });

  it("2. the emitted currency is the authoritative source currency", () => {
    const source = sourceVersion(fixedEur);
    const capsule = projectOfferCapsule({
      sourceVersion: source,
      context: projectionContext(),
    });
    const sourcePromotion = source.terms.promotion;
    const sourceCommission =
      sourcePromotion.type === "PROMOTABLE" ? sourcePromotion.commission : undefined;
    expect(sourceCommission?.method).toBe("FIXED_AMOUNT");
    expect(capsule.data.commission).toEqual({
      commissionMethod: "FIXED_AMOUNT",
      fixedCommissionMinorUnits: 800,
      fixedCommissionCurrency: "EUR",
      calculatedCommissionMinorUnits: 800,
    });
    /* Taken from the source commission itself — and it agrees with the wholesale price. */
    expect(capsule.data.commission).toHaveProperty("fixedCommissionCurrency", "EUR");
    expect(capsule.data.price).toHaveProperty("wholesalePriceCurrency", "EUR");
  });

  it("3. a percentage commission emits no currency", () => {
    const capsule = project({
      terms: {
        price: PAID_TERMS.price,
        promotion: { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 1_500 } },
      },
    });
    expect(Object.keys(capsule.data.commission!).sort()).toEqual([
      "calculatedCommissionMinorUnits",
      "commissionBasisPoints",
      "commissionMethod",
    ]);
    expect(
      OfferCapsuleData.safeParse({
        ...capsule.data,
        commission: {
          commissionMethod: "PERCENT_OF_WHOLESALE",
          commissionBasisPoints: 1_500,
          calculatedCommissionMinorUnits: 1_500,
          fixedCommissionCurrency: "USD",
        },
      }).success,
    ).toBe(false);
  });

  it("4. FREE and NOT_PROMOTABLE projections emit no commission currency", () => {
    const free = project({
      terms: { price: { type: "FREE" }, promotion: { type: "NOT_PROMOTABLE" } },
    });
    expect(free.data.commission).toBeUndefined();
    expect(JSON.stringify(free)).not.toContain("fixedCommissionCurrency");

    const notPromotable = project();
    expect(notPromotable.data.commission).toBeUndefined();
    expect(JSON.stringify(notPromotable)).not.toContain("fixedCommissionCurrency");
  });

  it("5. the currency cannot be changed independently of the source", () => {
    /* Hand-assembling a capsule whose commission is denominated differently from
       its price is refused by the published shape itself. */
    const data = project(fixedUsd).data;
    expect(
      OfferCapsuleData.safeParse({
        ...data,
        commission: {
          commissionMethod: "FIXED_AMOUNT",
          fixedCommissionMinorUnits: 2_500,
          fixedCommissionCurrency: "EUR",
          calculatedCommissionMinorUnits: 2_500,
        },
      }).success,
    ).toBe(false);
    /* …and the mapper cannot produce one, because the source refuses it first. */
    expect(() =>
      sourceVersion({
        terms: {
          price: PAID_TERMS.price,
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 2_500, fixedCommissionCurrency: "EUR" },
          },
        },
      }),
    ).toThrow();
  });

  it("6. the added field moves no database or authority boundary", () => {
    const capsule = project(fixedUsd);
    /* Still a projection: no internal identifier, no authority claim, no
       publication state, and the source model gained no field. */
    expect(findInternalIdentifiers(capsule)).toEqual([]);
    expect(Object.keys(capsule.metadata)).not.toContain("publishedBy");
    expect(OfferSourceVersion.safeParse({ ...sourceVersion(), fixedCommissionCurrency: "USD" }).success)
      .toBe(false);
    for (const financial of ["earnedCommission", "settlement", "payout"]) {
      expect(OfferCapsuleData.safeParse({ ...capsule.data, [financial]: 1 }).success).toBe(false);
    }
  });

  it("changing the fixed-commission currency changes the hash", () => {
    expect(project(fixedUsd).metadata.contentHash).not.toBe(
      project(fixedEur).metadata.contentHash,
    );
  });
});

// — 16 —

describe("16. Product descriptive facts are not embedded", () => {
  it("the Offer carries a Product reference, not Product claims", () => {
    const capsule = project();
    for (const productField of [
      "name",
      "description",
      "image",
      "productVersion",
      "specifications",
      "capabilities",
      "generalAvailabilityState",
      "category",
    ]) {
      expect(Object.keys(capsule.data)).not.toContain(productField);
      expect(
        OfferCapsuleData.safeParse({ ...capsule.data, [productField]: "x" }).success,
      ).toBe(false);
    }
  });

  it("the only Product linkage is a Node reference", () => {
    expect(project().data.relationships.itemOffered).toBe(PRODUCT_NODE);
  });
});

// — 17 —

describe("17. internal identifiers are excluded", () => {
  it("no internal identifier appears anywhere in the capsule", () => {
    const capsule = project();
    expect(findInternalIdentifiers(capsule)).toEqual([]);
    const serialized = JSON.stringify(capsule);
    for (const prefix of FORBIDDEN_INTERNAL_ID_PREFIXES) {
      expect(serialized).not.toContain(prefix);
    }
  });

  it("the guard finds an internal identifier smuggled into a string field", () => {
    const capsule = project();
    const tampered = {
      ...capsule,
      metadata: {
        ...capsule.metadata,
        provenance: { ...capsule.metadata.provenance, source: `monacado:Offer:${INTERNAL_OFFER_ID}` },
      },
    };
    expect(findInternalIdentifiers(tampered).length).toBeGreaterThan(0);
    expect(validateOfferCapsuleProjection(tampered).ok).toBe(false);
  });

  it("the source-record identifier is the approved provenance pattern, and is kept", () => {
    /* `mon:srec:` is deliberately NOT forbidden: it is the already-approved
       Product provenance identifier — opaque, business-meaning-free, and the
       whole point of provenance is tracing a claim to the exact governed record
       version behind it. No *new* internal identifier is introduced beyond it. */
    const provenance = project().metadata.provenance;
    expect(provenance.sourceRecordId).toBe(OFFER_SREC_ID);
    expect(FORBIDDEN_INTERNAL_ID_PREFIXES).not.toContain("mon:srec:");
    for (const prefix of ["mon:offer:", "mon:product:", "mon:mpart:", "mon:acct:", "mon:actor:"]) {
      expect(FORBIDDEN_INTERNAL_ID_PREFIXES).toContain(prefix);
    }
  });
});

// — 18 —

describe("18. private and transactional fields are excluded", () => {
  it("no account, session, entitlement, profile, provider, or financial field is accepted", () => {
    const data = project().data;
    for (const forbidden of [
      "accountId",
      "sessionId",
      "entitlement",
      "privateProfile",
      "stripeAccountId",
      "paymentProviderId",
      "bankAccount",
      "taxId",
      "orderId",
      "checkout",
      "refund",
      "settlement",
      "payout",
      "earnedCommission",
      "platformFee",
      "processingFee",
      "internalCost",
      "internalMargin",
      "retentionState",
      "legalHold",
      "auditInternals",
    ]) {
      expect(
        OfferCapsuleData.safeParse({ ...data, [forbidden]: "x" }).success,
        `${forbidden} must be refused`,
      ).toBe(false);
    }
  });

  it("the authorization trace stays private", () => {
    const serialized = JSON.stringify(project());
    expect(serialized).not.toContain(ACTOR_ID);
    expect(serialized).not.toContain("authorizedByActorId");
    expect(serialized).not.toContain("authorizedBySellerParticipantId");
  });
});

// — 19 —

describe("19. deferred extensions are excluded", () => {
  it("no deferred Offer extension may enter the capsule", () => {
    const data = project().data;
    for (const extension of [
      "discounts",
      "inventoryQuantity",
      "variants",
      "territoryEligibility",
      "taxTreatment",
      "shippingConstraints",
      "subscriptionTerms",
      "rentalTerms",
      "licenseDuration",
      "usageLimits",
      "categoryComplianceTerms",
      "nonMonetaryIncentives",
    ]) {
      expect(OfferCapsuleData.safeParse({ ...data, [extension]: {} }).success).toBe(false);
    }
  });

  it("there is no metadata or extension bag in data", () => {
    const data = project().data;
    for (const bag of ["metadata", "extensions", "custom", "attributes", "extra"]) {
      expect(OfferCapsuleData.safeParse({ ...data, [bag]: {} }).success).toBe(false);
    }
  });
});

// — 20 —

describe("20. provenance is represented but not created", () => {
  it("restates the source version, mapping, and generation facts", () => {
    const provenance = project().metadata.provenance;
    expect(provenance.sourceRecordId).toBe(OFFER_SREC_ID);
    expect(provenance.sourceRecordVersion).toBe("3");
    expect(provenance.sourceSystem).toBe("monacado");
    expect(provenance.sourceRecordType).toBe("Offer");
    expect(provenance.sourceClass).toBe("governed-database-record");
    expect(provenance.generatorVersion).toBe(OFFER_PROJECTION_MAPPING_VERSION);
    expect(provenance.generatedAt).toBe("2026-08-02T09:00:00.000Z");
    expect(provenance.assertionKind).toBe("Asserted");
  });

  it("acquiredAt is the instant the database recorded the fact, not a new one", () => {
    expect(project().metadata.provenance.acquiredAt).toBe("2026-08-01T12:00:00.000Z");
    expect(project().metadata.provenance.acquiredAt).toBe(sourceVersion().recordedAt);
  });

  it("the method says this is a projection of a governed source version", () => {
    expect(project().metadata.provenance.method).toBe("governed-source-version-projection");
  });

  it("policy references are carried, not invented", () => {
    const capsule = project();
    expect(capsule.metadata.nodePolicy).toEqual({ ref: "mon:policy:node/offer", version: "1" });
    expect(capsule.metadata.capsulePolicy).toEqual({
      ref: "mon:policy:capsule/offer",
      version: "1",
    });
  });
});

// — 21 —

describe("21. the same inputs produce an identical capsule and hash", () => {
  it("is deterministic across repeated calls", () => {
    const first = project();
    const second = project();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.metadata.contentHash).toBe(second.metadata.contentHash);
  });

  it("the hash is the shared published-capsule hash over the capsule", () => {
    const capsule = project();
    expect(capsule.metadata.contentHash).toBe(publishedContentHash(capsule));
    expect(capsule.metadata.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("key order in the context object does not change the hash", () => {
    const reordered = projectOfferCapsule({
      sourceVersion: sourceVersion(),
      context: OfferProjectionContext.parse({
        capsulePolicy: { ref: "mon:policy:capsule/offer", version: "1" },
        nodePolicy: { ref: "mon:policy:node/offer", version: "1" },
        generatedAt: "2026-08-02T09:00:00.000Z",
        mappingVersion: OFFER_PROJECTION_MAPPING_VERSION,
        capsuleVersion: "2.0.0",
        capsuleId: CAPSULE_ID,
        sourceVersionBinding: { sourceRecordVersion: "3", offerSourceRecordId: OFFER_SREC_ID },
        authorityBinding: {
          sellerParticipantId: SELLER_PARTICIPANT_ID,
          authorityNode: AUTHORITY_NODE,
        },
        productBinding: { internalProductId: PRODUCT_ID, productNode: PRODUCT_NODE },
        offerBinding: { internalOfferId: INTERNAL_OFFER_ID, offerNode: OFFER_NODE },
      }),
    });
    expect(reordered.metadata.contentHash).toBe(project().metadata.contentHash);
  });
});

// — 22 —

describe("22. a material public change changes the hash", () => {
  const baseline = () => project().metadata.contentHash;

  it("price, state, promotion, interval, and bindings each change it", () => {
    const variants = [
      project({ availability: "TEMPORARILY_UNAVAILABLE" }),
      project({ lifecycle: "ENDED" }),
      project({
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 12_000, wholesalePriceCurrency: "USD" },
          promotion: { type: "NOT_PROMOTABLE" },
        },
      }),
      project({
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 10_000, wholesalePriceCurrency: "EUR" },
          promotion: { type: "NOT_PROMOTABLE" },
        },
      }),
      project({
        terms: {
          price: PAID_TERMS.price,
          promotion: { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 500 } },
        },
      }),
      project({ effectiveInterval: { startsAt: "2026-09-01T00:00:00.000Z", endsAt: null } }),
      project({}, { generatedAt: "2026-08-02T10:00:00.000Z" }),
    ];
    const hashes = new Set(variants.map((c) => c.metadata.contentHash));
    expect(hashes.size).toBe(variants.length);
    for (const hash of hashes) expect(hash).not.toBe(baseline());
  });

  it("a different source version changes it", () => {
    const other = projectOfferCapsule({
      sourceVersion: sourceVersion({ sourceRecordVersion: "4" }),
      context: projectionContext({
        sourceVersionBinding: { offerSourceRecordId: OFFER_SREC_ID, sourceRecordVersion: "4" },
      }),
    });
    expect(other.metadata.contentHash).not.toBe(baseline());
  });
});

// — 23 —

describe("23. operational publication data cannot affect the projection", () => {
  it("no publication, worker, receipt, archive, or monitoring field is accepted anywhere", () => {
    for (const intruder of [
      { publicationRetryState: "PENDING" },
      { workerLeaseState: "LEASED" },
      { receiptProcessingState: "DONE" },
      { archiveLocation: "s3://x" },
      { monitoringCounters: { runs: 1 } },
      { lastReadAt: "2026-08-02T00:00:00.000Z" },
    ]) {
      /* Not on the source version… */
      expect(OfferSourceVersion.safeParse({ ...sourceVersion(), ...intruder }).success).toBe(false);
      /* …not on the context… */
      expect(
        OfferProjectionContext.safeParse({ ...projectionContext(), ...intruder }).success,
      ).toBe(false);
      /* …and not in the output. */
      expect(OfferCapsuleData.safeParse({ ...project().data, ...intruder }).success).toBe(false);
    }
  });

  it("the capsule metadata carries no publication state", () => {
    const capsule = project();
    expect(Object.keys(capsule.metadata).sort()).toEqual([
      "bindsToNode",
      "capsuleId",
      "capsulePolicy",
      "contentHash",
      "nodePolicy",
      "provenance",
      "version",
    ]);
  });
});

// — 24 —

describe("24. unknown keys and enum values fail", () => {
  it("the top level is exactly the four ANS members", () => {
    const capsule = project();
    expect(Object.keys(capsule).sort()).toEqual(["@context", "@type", "data", "metadata"]);
    expect(OfferCapsuleProjection.safeParse({ ...capsule, extra: 1 }).success).toBe(false);
  });

  it("@type must be Offer", () => {
    const capsule = project();
    expect(capsule["@type"]).toBe(OFFER_TYPE);
    expect(OfferCapsuleProjection.safeParse({ ...capsule, "@type": "Product" }).success).toBe(false);
  });

  it("unknown enum values are refused", () => {
    const capsule = project();
    expect(
      OfferCapsuleProjection.safeParse({
        ...capsule,
        data: { ...capsule.data, commercialState: "SUSPENDED" },
      }).success,
    ).toBe(false);
    expect(
      OfferCapsuleData.safeParse({
        ...capsule.data,
        price: { priceType: "SUBSCRIPTION", wholesalePriceMinorUnits: 1, wholesalePriceCurrency: "USD" },
      }).success,
    ).toBe(false);
  });

  it("metadata is strict", () => {
    const capsule = project();
    expect(
      OfferCapsuleProjection.safeParse({
        ...capsule,
        metadata: { ...capsule.metadata, publishedBy: "an:publisher:monacado-platform" },
      }).success,
    ).toBe(false);
  });

  it("every ontology term the capsule uses resolves through the context", () => {
    const ontologyTerms = new Set(ALL_TERMS.map((t) => t.term));
    const structural = new Set(["@context", "@type", "metadata", "data"]);
    const seen = new Set<string>();
    const collect = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(collect);
      for (const [k, v] of Object.entries(node)) {
        if (!structural.has(k)) seen.add(k);
        collect(v);
      }
    };
    collect(project());
    for (const term of seen) {
      if (ontologyTerms.has(term)) {
        expect(term in COMMERCE_CONTEXT, `${term} must be mapped in the context`).toBe(true);
      }
    }
    /* And the Offer-specific terms really are present. */
    for (const term of [
      "commercialState",
      "priceType",
      "wholesalePriceMinorUnits",
      "wholesalePriceCurrency",
      "commissionMethod",
      "calculatedCommissionMinorUnits",
      "offeredBy",
      "itemOffered",
    ]) {
      expect(term in COMMERCE_CONTEXT, term).toBe(true);
    }
  });

  it("the mapper reads no ambient state", () => {
    for (const file of ["offer.projection.ts", "offer.capsule.ts"]) {
      const source = readFileSync(
        new URL(`../src/contracts/marketplace/${file}`, import.meta.url),
        "utf8",
      );
      for (const token of ["process.env", "Date.now", "new Date", "Math.random", "fetch("]) {
        expect(source, `${file} must not reference ${token}`).not.toContain(token);
      }
    }
  });
});

// — 25 (Phase 0M.2C) —

describe("25. the corrected capsule publishes wholesale economics", () => {
  const percent = {
    terms: {
      price: PAID_TERMS.price,
      promotion: {
        type: "PROMOTABLE",
        commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
      },
    },
  };
  const fixed = {
    terms: {
      price: PAID_TERMS.price,
      promotion: {
        type: "PROMOTABLE",
        commission: {
          method: "FIXED_AMOUNT",
          fixedCommissionMinorUnits: 2_500,
          fixedCommissionCurrency: "USD",
        },
      },
    },
  };

  it("exposes the wholesale price, not a generic price", () => {
    expect(project().data.price).toEqual({
      priceType: "PAID",
      wholesalePriceMinorUnits: 10_000,
      wholesalePriceCurrency: "USD",
    });
  });

  it("exposes PERCENT_OF_WHOLESALE with its exact calculated commission", () => {
    expect(project(percent).data.commission).toEqual({
      commissionMethod: "PERCENT_OF_WHOLESALE",
      commissionBasisPoints: 2_000,
      calculatedCommissionMinorUnits: 2_000,
    });
  });

  it("exposes FIXED_AMOUNT with its currency and exact calculated commission", () => {
    expect(project(fixed).data.commission).toEqual({
      commissionMethod: "FIXED_AMOUNT",
      fixedCommissionMinorUnits: 2_500,
      fixedCommissionCurrency: "USD",
      calculatedCommissionMinorUnits: 2_500,
    });
  });

  it("the published commission always equals the authoritative calculation", () => {
    for (const variant of [percent, fixed]) {
      const capsule = project(variant);
      const expected = calculateOfferEconomics(variant.terms as never);
      expect(capsule.data.commission?.calculatedCommissionMinorUnits).toBe(
        expected.calculatedCommissionMinorUnits,
      );
    }
  });

  it("excludes promoter retail price, price floors, and MSRP", () => {
    const data = project(percent).data;
    for (const forbidden of [
      "promoterRetailPrice",
      "retailPrice",
      "suggestedRetailPrice",
      "minimumRetailPrice",
      "creatorPriceFloor",
      "msrp",
    ]) {
      expect(OfferCapsuleData.safeParse({ ...data, [forbidden]: 1 }).success, forbidden).toBe(
        false,
      );
    }
    expect(JSON.stringify(project(percent))).not.toContain("etailPrice");
  });

  it("excludes creator confirmation and a dedicated creator-proceeds claim", () => {
    const data = project(percent).data;
    for (const forbidden of [
      "creatorConfirmedEconomics",
      "creatorConfirmation",
      "calculatedCreatorGrossProceedsMinorUnits",
      "creatorGrossProceeds",
      "platformFee",
      "processingFee",
    ]) {
      expect(OfferCapsuleData.safeParse({ ...data, [forbidden]: 1 }).success, forbidden).toBe(
        false,
      );
    }
    /* What a creator nets is between the creator and Monacado. */
    expect(JSON.stringify(project(percent))).not.toContain("GrossProceeds");
  });

  it("rejects the pre-correction generic-price semantics", () => {
    const data = project().data;
    expect(
      OfferCapsuleData.safeParse({
        ...data,
        price: { priceType: "PAID", priceMinorUnits: 10_000, priceCurrency: "USD" },
      }).success,
    ).toBe(false);
    expect(
      OfferCapsuleData.safeParse({
        ...data,
        commission: { commissionType: "PERCENTAGE", commissionBasisPoints: 2_000 },
      }).success,
    ).toBe(false);
  });

  it("emits the supported capsule and mapping version pair", () => {
    expect(CORRECTED_OFFER_CAPSULE_MAJOR).toBe(2);
    expect(SUPPORTED_OFFER_CAPSULE_VERSION).toBe("2.0.0");
    expect(OFFER_PROJECTION_MAPPING_VERSION).toBe("offer-projection/2.0.0");
    expect(project().metadata.version).toBe(SUPPORTED_OFFER_CAPSULE_VERSION);
    expect(project().metadata.provenance.generatorVersion).toBe(OFFER_PROJECTION_MAPPING_VERSION);
  });

  it("a pre-correction major version is refused as stale", () => {
    /* `1.x` means "what a buyer pays"; `2.x` means "what the creator is owed".
       The same number cannot mean both. */
    for (const capsuleVersion of ["1.0.0", "1.9.9", "0.1.0"]) {
      expectProjectionError(
        () => project({}, { capsuleVersion }),
        "STALE_CAPSULE_MAJOR_VERSION",
      );
    }
  });

  it("a future major version is refused as unsupported", () => {
    for (const capsuleVersion of ["3.0.0", "4.2.1"]) {
      expectProjectionError(
        () => project({}, { capsuleVersion }),
        "UNSUPPORTED_CAPSULE_VERSION",
      );
    }
  });

  it("an unreviewed 2.x minor or patch is refused, not accepted implicitly", () => {
    /* A future 2.1.0 would carry claims this mapper cannot produce; accepting it
       would let a caller label output as a shape it is not. */
    for (const capsuleVersion of ["2.1.0", "2.0.1"]) {
      expectProjectionError(
        () => project({}, { capsuleVersion }),
        "UNSUPPORTED_CAPSULE_VERSION",
      );
    }
  });

  it("a wrong mapping version is refused", () => {
    for (const mappingVersion of ["offer-projection/1.0.0", "offer-projection/2.1.0", "custom"]) {
      expectProjectionError(
        () => project({}, { mappingVersion }),
        "UNSUPPORTED_MAPPING_VERSION",
      );
    }
  });

  it("identical corrected inputs produce an identical capsule and hash", () => {
    expect(JSON.stringify(project(percent))).toBe(JSON.stringify(project(percent)));
    expect(project(percent).metadata.contentHash).toBe(project(percent).metadata.contentHash);
  });

  it("a wholesale or commission change changes the hash", () => {
    const baseline = project(percent).metadata.contentHash;
    const repriced = project({
      terms: {
        price: { type: "PAID", wholesalePriceMinorUnits: 12_000, wholesalePriceCurrency: "USD" },
        promotion: percent.terms.promotion,
      },
    });
    const reRated = project({
      terms: {
        price: PAID_TERMS.price,
        promotion: {
          type: "PROMOTABLE",
          commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 3_000 },
        },
      },
    });
    expect(repriced.metadata.contentHash).not.toBe(baseline);
    expect(reRated.metadata.contentHash).not.toBe(baseline);
    expect(repriced.metadata.contentHash).not.toBe(reRated.metadata.contentHash);
  });
});
