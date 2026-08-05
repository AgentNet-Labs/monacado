/**
 * Authoritative Offer source-model tests (Phase 0M.2A).
 *
 * NO DATABASE, NO NETWORK, NO CLOCK. Every instant is an explicit literal, and
 * every authority decision is a pure function of its argument.
 *
 * The numbered `describe` blocks correspond one-to-one with the properties Phase
 * 0M.2A was required to prove.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MarketplaceParticipantView,
  MarketplaceRole,
  MarketplaceSubject,
  ParticipantStatus,
  PaymentReadinessStatus,
  RoleAssignmentStatus,
} from "../src/contracts/marketplace/participant";
import {
  DEFERRED_OFFER_EXTENSIONS,
  INITIAL_OFFER_LIFECYCLE_STATE,
  MATERIAL_OFFER_FIELDS,
  COMMISSION_METHODS,
  MAX_COMMISSION_BASIS_POINTS,
  NEVER_PROJECTION_ELIGIBLE_OFFER_DATA,
  OFFER_CAPABILITIES,
  OFFER_LIFECYCLE_STATES,
  OPERATIONAL_ONLY_OFFER_FIELDS,
  OfferAuthorityDecision,
  OfferAvailability,
  OfferCommercialTerms,
  OfferEffectiveInterval,
  OfferLifecycleState,
  OfferPrice,
  OfferSourceRecord,
  OfferSourceVersion,
  CURRENT_COMMISSION_CALCULATION_POLICY,
  CreatorEconomicsConfirmation,
  buildCreatorEconomicsDisclosure,
  calculateOfferEconomics,
  OFFER_BUSINESS_CHANGE_ORDER,
  classifyOfferBusinessChanges,
  PROJECTION_ELIGIBLE_OFFER_FIELDS,
  normalizeOfferEffectiveIntervalInput,
  canActivateOffer,
  canChangeOfferTerms,
  canCreateDraftOffer,
  canEndOffer,
  canResumeOffer,
  canSuspendOffer,
  canWithdrawOffer,
  classifyOfferChange,
  isCommerciallySelectable,
  isNeverProjectionEligible,
  isProjectionEligibleOfferField,
  isTerminalOfferLifecycleState,
  isValidOfferLifecycleTransition,
  materialChangesBetween,
  type OfferLifecycleActionRequest,
} from "../src/contracts/marketplace/offer-source";

// — Fixtures —

const body = (n: number): string => String(n).padStart(26, "0");

const ACCOUNT_ID = `mon:acct:${body(1)}`;
const SELLER_PARTICIPANT_ID = `mon:mpart:${body(2)}`;
const OTHER_PARTICIPANT_ID = `mon:mpart:${body(3)}`;
const OFFER_SREC_ID = `mon:srec:${body(4)}`;
const INTERNAL_OFFER_ID = `mon:offer:${body(5)}`;
const OTHER_OFFER_ID = `mon:offer:${body(6)}`;
const PRODUCT_ID = `mon:product:${body(7)}`;
const OTHER_PRODUCT_ID = `mon:product:${body(8)}`;
const ACTOR_ID = `mon:actor:${body(9)}`;

const PAID_TERMS = {
  price: { type: "PAID", wholesalePriceMinorUnits: 10_000, wholesalePriceCurrency: "USD" },
  promotion: { type: "NOT_PROMOTABLE" },
} as const;

function offerRecord(overrides: Record<string, unknown> = {}) {
  return OfferSourceRecord.parse({
    offerSourceRecordId: OFFER_SREC_ID,
    internalOfferId: INTERNAL_OFFER_ID,
    currentSourceRecordVersion: "1",
    internalProductId: PRODUCT_ID,
    sellerParticipantId: SELLER_PARTICIPANT_ID,
    sourceSystem: "monacado",
    sourceRecordType: "Offer",
    sourceClass: "governed-database-record",
    lifecycle: "DRAFT",
    availability: "AVAILABLE",
    terms: PAID_TERMS,
    effectiveInterval: null,
    economics: calculateOfferEconomics((overrides.terms ?? PAID_TERMS) as never),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
}

function offerVersion(overrides: Record<string, unknown> = {}) {
  return OfferSourceVersion.parse({
    offerSourceRecordId: OFFER_SREC_ID,
    sourceRecordVersion: "2",
    supersedesSourceRecordVersion: "1",
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

type RoleSpec = readonly [MarketplaceRole, RoleAssignmentStatus];

function subject(spec: {
  account?: "ACTIVE" | "DISABLED" | null;
  status?: ParticipantStatus;
  roles?: readonly RoleSpec[];
  paymentReadiness?: PaymentReadinessStatus;
  participantId?: string;
  internalCapabilities?: readonly string[];
  noParticipant?: boolean;
}): MarketplaceSubject {
  const participant = spec.noParticipant
    ? null
    : MarketplaceParticipantView.parse({
        participantId: spec.participantId ?? SELLER_PARTICIPANT_ID,
        accountId: ACCOUNT_ID,
        status: spec.status ?? "ACTIVE",
        roles: (spec.roles ?? [["SELLER", "ACTIVE"]]).map(([role, status]) => ({ role, status })),
        paymentReadiness: spec.paymentReadiness ?? "ENABLED",
      });
  return MarketplaceSubject.parse({
    account:
      spec.account === null ? null : { accountId: ACCOUNT_ID, status: spec.account ?? "ACTIVE" },
    participant,
    internalCapabilities: spec.internalCapabilities ?? [],
  });
}

/** A seller cleared for everything: admitted, active role, payable. */
const TRADING_SELLER = subject({});

/** A bare seller: drafting-eligible only. */
const BARE_SELLER = subject({
  status: "DRAFT",
  roles: [["SELLER", "DRAFT"]],
  paymentReadiness: "NOT_STARTED",
});

/** A confirmation that exactly matches the supplied terms and version. */
function matchingConfirmation(
  terms: OfferCommercialTerms = PAID_TERMS as never,
  sourceRecordVersion = "3",
) {
  const economics = calculateOfferEconomics(terms);
  return {
    confirmedOfferSourceRecordId: OFFER_SREC_ID,
    confirmedOfferSourceRecordVersion: sourceRecordVersion,
    calculatedCommissionMinorUnits: economics.calculatedCommissionMinorUnits,
    calculatedCreatorGrossProceedsMinorUnits:
      economics.calculatedCreatorGrossProceedsMinorUnits,
    commissionCalculationPolicyVersion: economics.commissionCalculationPolicyVersion,
  };
}

function lifecycleRequest(
  overrides: Partial<OfferLifecycleActionRequest> = {},
): OfferLifecycleActionRequest {
  return {
    subject: TRADING_SELLER,
    offerSellerParticipantId: SELLER_PARTICIPANT_ID,
    hasProductAuthority: true,
    lifecycle: "ACTIVE",
    economicsContext: {
      offerSourceRecordId: OFFER_SREC_ID,
      sourceRecordVersion: "3",
      terms: PAID_TERMS as never,
      confirmation: matchingConfirmation(),
    },
    ...overrides,
  };
}

function expectAllow(decision: OfferAuthorityDecision): void {
  OfferAuthorityDecision.parse(decision);
  expect(decision.decision).toBe("ALLOW");
  expect(decision.reasonCodes).toEqual([]);
}

function expectDeny(decision: OfferAuthorityDecision, ...codes: string[]): void {
  OfferAuthorityDecision.parse(decision);
  expect(decision.decision).toBe("DENY");
  expect(decision.reasonCodes).toEqual(codes);
}

// — 1 —

describe("1. the current Offer record has a strict shape", () => {
  it("accepts a complete authoritative record", () => {
    const record = offerRecord();
    expect(record.internalOfferId).toBe(INTERNAL_OFFER_ID);
    expect(record.sourceRecordType).toBe("Offer");
    expect(record.currentSourceRecordVersion).toBe("1");
  });

  it("refuses publication, Node, capsule, and retention fields", () => {
    for (const intruder of [
      { nodeId: "an:node:X" },
      { capsuleId: "an:capsule:X" },
      { publicationStatus: "PREPARED" },
      { registrationState: "ACCEPTED" },
      { payloadHash: "sha256:x" },
      { mappingVersion: "1.0.0" },
      { capsuleSemver: "1.0.0" },
      { retentionState: "HOT" },
      { metadata: {} },
    ]) {
      expect(OfferSourceRecord.safeParse({ ...offerRecord(), ...intruder }).success).toBe(false);
    }
  });
});

// — 2 —

describe("2. the immutable source version has a strict shape", () => {
  it("accepts a complete snapshot with its authorization trace", () => {
    const version = offerVersion();
    expect(version.sourceRecordVersion).toBe("2");
    expect(version.supersedesSourceRecordVersion).toBe("1");
    expect(version.authorizedByActorId).toBe(ACTOR_ID);
    expect(version.recordedAt).toBe("2026-08-01T12:00:00.000Z");
  });

  it("allows a first version to supersede nothing", () => {
    expect(
      offerVersion({ sourceRecordVersion: "1", supersedesSourceRecordVersion: null })
        .supersedesSourceRecordVersion,
    ).toBeNull();
  });

  it("carries the complete material snapshot, not a delta", () => {
    const version = offerVersion();
    for (const field of [
      "internalProductId",
      "sellerParticipantId",
      "lifecycle",
      "availability",
      "terms",
      "effectiveInterval",
    ]) {
      expect(Object.keys(version)).toContain(field);
    }
  });

  it("refuses database, publication, Node, capsule, Registrar, and receipt fields", () => {
    for (const intruder of [
      { nodeId: "an:node:X" },
      { capsuleId: "an:capsule:X" },
      { receiptId: "mon:rcpt:X" },
      { registrarResponse: {} },
      { publicationId: "mon:pub:X" },
      { rowId: 1 },
      { mappingVersion: "1.0.0" },
    ]) {
      expect(OfferSourceVersion.safeParse({ ...offerVersion(), ...intruder }).success).toBe(false);
    }
  });

  it("the authorizing actor must be opaque — never an email or a name", () => {
    for (const bad of ["seller@example.com", "Ada Lovelace", ACCOUNT_ID]) {
      expect(OfferSourceVersion.safeParse({ ...offerVersion(), authorizedByActorId: bad }).success)
        .toBe(false);
    }
  });
});

// — 3 —

describe("3. a Product reference is required", () => {
  it("is mandatory and must be an internal Product identity", () => {
    const { internalProductId: _omitted, ...withoutProduct } = offerRecord();
    expect(OfferSourceRecord.safeParse(withoutProduct).success).toBe(false);
    expect(
      OfferSourceRecord.safeParse({ ...offerRecord(), internalProductId: "an:node:X" }).success,
    ).toBe(false);
    expect(
      OfferSourceRecord.safeParse({ ...offerRecord(), internalProductId: SELLER_PARTICIPANT_ID })
        .success,
    ).toBe(false);
  });

  it("references exactly one Product — there is no field for a second", () => {
    expect(
      OfferSourceRecord.safeParse({ ...offerRecord(), internalProductIds: [PRODUCT_ID] }).success,
    ).toBe(false);
  });
});

// — 4 —

describe("4. a Seller participant reference is required", () => {
  it("is mandatory and must be a participant identity", () => {
    const { sellerParticipantId: _omitted, ...withoutSeller } = offerRecord();
    expect(OfferSourceRecord.safeParse(withoutSeller).success).toBe(false);
    expect(
      OfferSourceRecord.safeParse({ ...offerRecord(), sellerParticipantId: ACCOUNT_ID }).success,
    ).toBe(false);
  });

  it("is transactional — no Creator Node or public semantic identity is accepted", () => {
    for (const intruder of [
      { creatorNodeId: "an:node:X" },
      { creatorId: "mon:creator:X" },
      { publicAuthorityRef: "https://monacado.com/id/creator/x" },
    ]) {
      expect(OfferSourceRecord.safeParse({ ...offerRecord(), ...intruder }).success).toBe(false);
    }
  });
});

// — 5 —

describe("5. multiple Offers per Product are not forbidden by contract", () => {
  it("two distinct Offers may name the same Product", () => {
    const first = offerRecord();
    const second = offerRecord({
      offerSourceRecordId: `mon:srec:${body(10)}`,
      internalOfferId: OTHER_OFFER_ID,
    });
    expect(first.internalProductId).toBe(second.internalProductId);
    expect(first.internalOfferId).not.toBe(second.internalOfferId);
  });
});

// — 6 —

describe("6. lifecycle transitions are accepted and refused correctly", () => {
  it("accepts exactly the permitted transitions", () => {
    const permitted: ReadonlyArray<readonly [OfferLifecycleState, OfferLifecycleState]> = [
      ["DRAFT", "ACTIVE"],
      ["DRAFT", "WITHDRAWN"],
      ["ACTIVE", "SUSPENDED"],
      ["ACTIVE", "ENDED"],
      ["ACTIVE", "WITHDRAWN"],
      ["SUSPENDED", "ACTIVE"],
      ["SUSPENDED", "ENDED"],
      ["SUSPENDED", "WITHDRAWN"],
    ];
    for (const [from, to] of permitted) {
      expect(isValidOfferLifecycleTransition(from, to)).toBe(true);
    }
    /* The table contains these and nothing else. */
    const total = OFFER_LIFECYCLE_STATES.reduce(
      (n, from) =>
        n + OFFER_LIFECYCLE_STATES.filter((to) => isValidOfferLifecycleTransition(from, to)).length,
      0,
    );
    expect(total).toBe(permitted.length);
  });

  it("refuses reverse and skipping transitions", () => {
    for (const [from, to] of [
      ["ACTIVE", "DRAFT"],
      ["SUSPENDED", "DRAFT"],
      ["DRAFT", "SUSPENDED"],
      ["DRAFT", "ENDED"],
    ] as const) {
      expect(isValidOfferLifecycleTransition(from, to)).toBe(false);
    }
  });

  it("refuses self-transitions", () => {
    for (const state of OFFER_LIFECYCLE_STATES) {
      expect(isValidOfferLifecycleTransition(state, state)).toBe(false);
    }
  });

  it("an Offer is created in DRAFT", () => {
    expect(INITIAL_OFFER_LIFECYCLE_STATE).toBe("DRAFT");
  });
});

// — 7 —

describe("7. terminal states cannot transition outward", () => {
  it("ENDED and WITHDRAWN are terminal", () => {
    for (const terminal of ["ENDED", "WITHDRAWN"] as const) {
      expect(isTerminalOfferLifecycleState(terminal)).toBe(true);
      for (const to of OFFER_LIFECYCLE_STATES) {
        expect(isValidOfferLifecycleTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("no authority can act on a terminal Offer", () => {
    for (const lifecycle of ["ENDED", "WITHDRAWN"] as const) {
      for (const decide of [
        canActivateOffer,
        canResumeOffer,
        canSuspendOffer,
        canEndOffer,
        canWithdrawOffer,
        canChangeOfferTerms,
      ]) {
        expectDeny(decide(lifecycleRequest({ lifecycle })), "OFFER_LIFECYCLE_TERMINAL");
      }
    }
  });
});

// — 8 —

describe("8. availability is separate from lifecycle", () => {
  it("the vocabularies share no member", () => {
    for (const availability of ["AVAILABLE", "TEMPORARILY_UNAVAILABLE"] as const) {
      expect(OfferLifecycleState.safeParse(availability).success).toBe(false);
    }
    for (const lifecycle of OFFER_LIFECYCLE_STATES) {
      expect(OfferAvailability.safeParse(lifecycle).success).toBe(false);
    }
  });

  it("either axis may move without the other", () => {
    const paused = offerRecord({ lifecycle: "ACTIVE", availability: "TEMPORARILY_UNAVAILABLE" });
    expect(paused.lifecycle).toBe("ACTIVE");
    const draftAvailable = offerRecord({ lifecycle: "DRAFT", availability: "AVAILABLE" });
    expect(draftAvailable.availability).toBe("AVAILABLE");
  });

  it("availability is not inventory, variants, publication, or workflow", () => {
    expect(OfferAvailability.safeParse("OUT_OF_STOCK").success).toBe(false);
    expect(OfferAvailability.safeParse("PUBLISHED").success).toBe(false);
    expect(OfferAvailability.safeParse(0).success).toBe(false);
  });
});

// — 9 —

describe("9. only ACTIVE and AVAILABLE is commercially selectable", () => {
  it("selects only on both axes", () => {
    expect(isCommerciallySelectable({ lifecycle: "ACTIVE", availability: "AVAILABLE" })).toBe(true);
  });

  it("an available non-ACTIVE Offer is never selectable", () => {
    for (const lifecycle of ["DRAFT", "SUSPENDED", "ENDED", "WITHDRAWN"] as const) {
      expect(isCommerciallySelectable({ lifecycle, availability: "AVAILABLE" })).toBe(false);
    }
  });

  it("an ACTIVE but temporarily unavailable Offer is not selectable", () => {
    expect(
      isCommerciallySelectable({ lifecycle: "ACTIVE", availability: "TEMPORARILY_UNAVAILABLE" }),
    ).toBe(false);
  });
});

// — 10 —

describe("10. a FREE Offer carries no amount or currency", () => {
  it("accepts a bare FREE price", () => {
    expect(OfferPrice.parse({ type: "FREE" })).toEqual({ type: "FREE" });
  });

  it("has no field for an amount or a currency", () => {
    expect(OfferPrice.safeParse({ type: "FREE", amountMinorUnits: 100 }).success).toBe(false);
    expect(OfferPrice.safeParse({ type: "FREE", currency: "USD" }).success).toBe(false);
  });
});

// — 11 —

describe("11. a PAID Offer requires a positive integer in minor units", () => {
  it("accepts a positive integer", () => {
    expect(
      OfferPrice.parse({ type: "PAID", wholesalePriceMinorUnits: 1, wholesalePriceCurrency: "USD" }).type,
    ).toBe("PAID");
  });

  it("refuses zero and negative amounts", () => {
    for (const amountMinorUnits of [0, -1, -10_000]) {
      expect(OfferPrice.safeParse({ type: "PAID", wholesalePriceMinorUnits: amountMinorUnits, wholesalePriceCurrency: "USD" }).success)
        .toBe(false);
    }
  });

  it("requires both an amount and a currency", () => {
    expect(OfferPrice.safeParse({ type: "PAID", wholesalePriceCurrency: "USD" }).success).toBe(false);
    expect(OfferPrice.safeParse({ type: "PAID", wholesalePriceMinorUnits: 100 }).success).toBe(false);
  });
});

// — 12 —

describe("12. a floating-point amount fails", () => {
  it("refuses fractional minor units", () => {
    for (const amountMinorUnits of [9.99, 0.5, 1.0000001]) {
      expect(OfferPrice.safeParse({ type: "PAID", wholesalePriceMinorUnits: amountMinorUnits, wholesalePriceCurrency: "USD" }).success)
        .toBe(false);
    }
  });

  it("refuses a numeric string", () => {
    expect(
      OfferPrice.safeParse({ type: "PAID", wholesalePriceMinorUnits: "999", wholesalePriceCurrency: "USD" }).success,
    ).toBe(false);
  });
});

// — 13 —

describe("13. currency is structurally validated", () => {
  it("accepts three uppercase letters", () => {
    for (const currency of ["USD", "EUR", "GBP", "JPY"]) {
      expect(OfferPrice.safeParse({ type: "PAID", wholesalePriceMinorUnits: 100, wholesalePriceCurrency: currency }).success)
        .toBe(true);
    }
  });

  it("refuses lowercase, wrong length, digits, and symbols", () => {
    for (const currency of ["usd", "US", "USDD", "US1", "$", "", "U S"]) {
      expect(OfferPrice.safeParse({ type: "PAID", wholesalePriceMinorUnits: 100, wholesalePriceCurrency: currency }).success)
        .toBe(false);
    }
  });

  it("is structural only — an unassigned code still parses", () => {
    /* Deliberate: the repository holds no maintained ISO 4217 registry, and this
       contract does not pretend to be one. Registry validation is a future
       service concern, documented rather than faked here. */
    expect(OfferPrice.safeParse({ type: "PAID", wholesalePriceMinorUnits: 100, wholesalePriceCurrency: "ZZZ" }).success)
      .toBe(true);
  });
});

// — 14 —

describe("14. the effective interval is ordered and explicit", () => {
  it("accepts either bound alone, or both", () => {
    expect(
      OfferEffectiveInterval.safeParse({ startsAt: "2026-08-01T00:00:00.000Z", endsAt: null })
        .success,
    ).toBe(true);
    expect(
      OfferEffectiveInterval.safeParse({ startsAt: null, endsAt: "2026-09-01T00:00:00.000Z" })
        .success,
    ).toBe(true);
    expect(
      OfferEffectiveInterval.safeParse({
        startsAt: "2026-08-01T00:00:00.000Z",
        endsAt: "2026-09-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("no interval at all is expressed as null on the record, not as an empty object", () => {
    expect(offerRecord({ effectiveInterval: null }).effectiveInterval).toBeNull();
  });

  it("requires endsAt to be later than startsAt", () => {
    expect(
      OfferEffectiveInterval.safeParse({
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-08-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      OfferEffectiveInterval.safeParse({
        startsAt: "2026-08-01T00:00:00.000Z",
        endsAt: "2026-08-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("requires normalized UTC instants", () => {
    for (const startsAt of ["2026-08-01T00:00:00+02:00", "2026-08-01", "01/08/2026", "now"]) {
      expect(OfferEffectiveInterval.safeParse({ startsAt, endsAt: null }).success).toBe(false);
    }
  });

  it("an elapsed interval does not move the lifecycle by itself", () => {
    const past = offerRecord({
      lifecycle: "ACTIVE",
      effectiveInterval: {
        startsAt: "2020-01-01T00:00:00.000Z",
        endsAt: "2020-02-01T00:00:00.000Z",
      },
    });
    expect(past.lifecycle).toBe("ACTIVE");
  });
});

// — 14b —

describe("14b. an absent interval has exactly one canonical representation", () => {
  it("a bounds-less interval object is refused", () => {
    /* `null` already means "no effective interval". Allowing an object with both
       bounds null would give one fact two authoritative snapshots — and therefore
       a spurious material change and a spurious source version. */
    expect(OfferEffectiveInterval.safeParse({ startsAt: null, endsAt: null }).success).toBe(false);
    expect(
      OfferSourceRecord.safeParse({
        ...offerRecord(),
        effectiveInterval: { startsAt: null, endsAt: null },
      }).success,
    ).toBe(false);
    expect(
      OfferSourceVersion.safeParse({
        ...offerVersion(),
        effectiveInterval: { startsAt: null, endsAt: null },
      }).success,
    ).toBe(false);
  });

  it("every spelling of absence normalizes to the same canonical value", () => {
    for (const input of [
      undefined,
      null,
      {},
      { startsAt: null },
      { endsAt: null },
      { startsAt: null, endsAt: null },
      { startsAt: undefined, endsAt: undefined },
    ] as const) {
      expect(normalizeOfferEffectiveIntervalInput(input)).toBeNull();
    }
  });

  it("omitted and explicitly null inputs cannot produce two distinct snapshots", () => {
    const fromOmitted = offerRecord({
      effectiveInterval: normalizeOfferEffectiveIntervalInput(undefined),
    });
    const fromEmptyObject = offerRecord({
      effectiveInterval: normalizeOfferEffectiveIntervalInput({}),
    });
    const fromExplicitNulls = offerRecord({
      effectiveInterval: normalizeOfferEffectiveIntervalInput({ startsAt: null, endsAt: null }),
    });
    expect(fromOmitted).toEqual(fromEmptyObject);
    expect(fromEmptyObject).toEqual(fromExplicitNulls);
    expect(materialChangesBetween(fromOmitted, fromExplicitNulls)).toEqual([]);
  });

  it("a single bound normalizes to an interval with an explicit null partner", () => {
    expect(normalizeOfferEffectiveIntervalInput({ startsAt: "2026-08-01T00:00:00.000Z" })).toEqual({
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: null,
    });
    expect(normalizeOfferEffectiveIntervalInput({ endsAt: "2026-09-01T00:00:00.000Z" })).toEqual({
      startsAt: null,
      endsAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("normalization still enforces ordering and UTC", () => {
    expect(() =>
      normalizeOfferEffectiveIntervalInput({
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-08-01T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      normalizeOfferEffectiveIntervalInput({ startsAt: "2026-08-01T00:00:00+02:00" }),
    ).toThrow();
  });
});

// — 15 —

describe("15. a FREE Offer cannot carry paid promotion terms", () => {
  it("refuses PROMOTABLE on a FREE price", () => {
    expect(
      OfferCommercialTerms.safeParse({
        price: { type: "FREE" },
        promotion: { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 500 } },
      }).success,
    ).toBe(false);
  });

  it("accepts a FREE, NOT_PROMOTABLE Offer", () => {
    expect(
      OfferCommercialTerms.safeParse({
        price: { type: "FREE" },
        promotion: { type: "NOT_PROMOTABLE" },
      }).success,
    ).toBe(true);
  });

  it("NOT_PROMOTABLE has no field for a commission", () => {
    expect(
      OfferCommercialTerms.safeParse({
        price: PAID_TERMS.price,
        promotion: {
          type: "NOT_PROMOTABLE",
          commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 500 },
        },
      }).success,
    ).toBe(false);
  });
});

// — 16 —

describe("16. percentage commission bounds are enforced", () => {
  const withPercentage = (basisPoints: unknown) =>
    OfferCommercialTerms.safeParse({
      price: PAID_TERMS.price,
      promotion: { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: basisPoints } },
    }).success;

  it("accepts 1 through 10,000 basis points", () => {
    expect(withPercentage(1)).toBe(true);
    expect(withPercentage(2_000)).toBe(true);
    expect(withPercentage(MAX_COMMISSION_BASIS_POINTS)).toBe(true);
  });

  it("refuses zero, negative, fractional, and over-100% values", () => {
    for (const basisPoints of [0, -1, 12.5, 10_001, 100_000]) {
      expect(withPercentage(basisPoints)).toBe(false);
    }
  });
});

// — 17 —

describe("17. a fixed commission must match the Offer currency", () => {
  it("accepts a matching currency", () => {
    expect(
      OfferCommercialTerms.safeParse({
        price: PAID_TERMS.price,
        promotion: {
          type: "PROMOTABLE",
          commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 1_000, fixedCommissionCurrency: "USD" },
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a different currency", () => {
    expect(
      OfferCommercialTerms.safeParse({
        price: PAID_TERMS.price,
        promotion: {
          type: "PROMOTABLE",
          commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 1_000, fixedCommissionCurrency: "EUR" },
        },
      }).success,
    ).toBe(false);
  });
});

// — 18 —

describe("18. a fixed commission cannot exceed the price", () => {
  const withFixed = (amountMinorUnits: number) =>
    OfferCommercialTerms.safeParse({
      price: PAID_TERMS.price, // 10 000 USD minor units
      promotion: {
        type: "PROMOTABLE",
        commission: {
          method: "FIXED_AMOUNT",
          fixedCommissionMinorUnits: amountMinorUnits,
          fixedCommissionCurrency: "USD",
        },
      },
    }).success;

  it("accepts a commission at or below the price", () => {
    expect(withFixed(1)).toBe(true);
    expect(withFixed(10_000)).toBe(true);
  });

  it("refuses a commission above the price", () => {
    expect(withFixed(10_001)).toBe(false);
    expect(withFixed(1_000_000)).toBe(false);
  });

  it("refuses a zero or negative commission", () => {
    expect(withFixed(0)).toBe(false);
    expect(withFixed(-100)).toBe(false);
  });
});

// — 19 —

describe("19. a matching Seller may draft and activate when all gates pass", () => {
  it("drafts with the drafting gates only", () => {
    expectAllow(
      canCreateDraftOffer({
        subject: BARE_SELLER,
        offerSellerParticipantId: SELLER_PARTICIPANT_ID,
        hasProductAuthority: true,
      }),
    );
  });

  it("activates when admitted, active, and payable", () => {
    expectAllow(canActivateOffer(lifecycleRequest({ lifecycle: "DRAFT" })));
    expectAllow(canResumeOffer(lifecycleRequest({ lifecycle: "SUSPENDED" })));
  });

  it("a bare seller may draft but not activate", () => {
    expectDeny(
      canActivateOffer(lifecycleRequest({ subject: BARE_SELLER, lifecycle: "DRAFT" })),
      "PARTICIPANT_NOT_ACTIVATED",
    );
  });

  it("activation requires payment readiness", () => {
    for (const [readiness, code] of [
      ["NOT_STARTED", "PAYMENT_NOT_ENABLED"],
      ["PENDING_PROVIDER", "PAYMENT_NOT_ENABLED"],
      ["RESTRICTED", "PAYMENT_RESTRICTED"],
    ] as const) {
      expectDeny(
        canActivateOffer(
          lifecycleRequest({ subject: subject({ paymentReadiness: readiness }), lifecycle: "DRAFT" }),
        ),
        code,
      );
    }
  });

  it("standing an Offer down never requires payment readiness", () => {
    /* A seller whose payment capability was just restricted must still be able to
       take their Offer down. */
    const restricted = subject({ paymentReadiness: "RESTRICTED" });
    expectAllow(canSuspendOffer(lifecycleRequest({ subject: restricted, lifecycle: "ACTIVE" })));
    expectAllow(canEndOffer(lifecycleRequest({ subject: restricted, lifecycle: "ACTIVE" })));
    expectAllow(canWithdrawOffer(lifecycleRequest({ subject: restricted, lifecycle: "ACTIVE" })));
  });

  it("changing live terms faces the full commerce gates", () => {
    expectAllow(canChangeOfferTerms(lifecycleRequest({ lifecycle: "ACTIVE" })));
    expectDeny(
      canChangeOfferTerms(
        lifecycleRequest({
          subject: subject({ paymentReadiness: "NOT_STARTED" }),
          lifecycle: "ACTIVE",
        }),
      ),
      "PAYMENT_NOT_ENABLED",
    );
    /* …but a draft's terms may be edited under drafting gates alone. */
    expectAllow(
      canChangeOfferTerms(lifecycleRequest({ subject: BARE_SELLER, lifecycle: "DRAFT" })),
    );
  });

  it("editing a DRAFT requires neither participant ACTIVE nor payment ENABLED", () => {
    /* Exactly the gates that created the draft, and nothing more. */
    for (const status of ["DRAFT", "PROFILE_INCOMPLETE", "PROFILE_COMPLETE", "UNDER_REVIEW"] as const) {
      for (const readiness of ["NOT_STARTED", "DETAILS_REQUIRED", "PENDING_PROVIDER"] as const) {
        expectAllow(
          canChangeOfferTerms(
            lifecycleRequest({
              subject: subject({
                status,
                roles: [["SELLER", "DRAFT"]],
                paymentReadiness: readiness,
              }),
              lifecycle: "DRAFT",
            }),
          ),
        );
      }
    }
  });

  it("no unauthorized subject may edit a DRAFT either", () => {
    const promoterDraft = subject({ status: "DRAFT", roles: [["PROMOTER", "DRAFT"]] });
    expectDeny(
      canChangeOfferTerms(lifecycleRequest({ subject: promoterDraft, lifecycle: "DRAFT" })),
      "ROLE_NOT_HELD",
    );
    expectDeny(
      canChangeOfferTerms(
        lifecycleRequest({
          subject: subject({ participantId: OTHER_PARTICIPANT_ID, status: "DRAFT", roles: [["SELLER", "DRAFT"]] }),
          lifecycle: "DRAFT",
        }),
      ),
      "SELLER_PARTICIPANT_MISMATCH",
    );
  });

  it("a SUSPENDED Offer's terms face the full commerce gates (remediation policy deferred)", () => {
    /* Pinned, not designed: suspension is a stand-down, and this phase grants no
       new editing permission during it. Whether a suspended seller should be able
       to edit terms *in order to* cure a suspension is a remediation-policy
       question, recorded as deferred rather than answered here. */
    expectAllow(canChangeOfferTerms(lifecycleRequest({ lifecycle: "SUSPENDED" })));
    expectDeny(
      canChangeOfferTerms(
        lifecycleRequest({
          subject: subject({ paymentReadiness: "RESTRICTED" }),
          lifecycle: "SUSPENDED",
        }),
      ),
      "PAYMENT_RESTRICTED",
    );
  });

  it("every capability is covered by a named decision", () => {
    expect(OFFER_CAPABILITIES).toHaveLength(7);
  });
});

// — 20 —

describe("20. Promoter, Buyer, internal entitlement, and a mismatched Seller are denied", () => {
  it("a promoter holds no Offer authority", () => {
    const promoter = subject({ roles: [["PROMOTER", "ACTIVE"]] });
    expectDeny(
      canCreateDraftOffer({
        subject: promoter,
        offerSellerParticipantId: SELLER_PARTICIPANT_ID,
        hasProductAuthority: true,
      }),
      "ROLE_NOT_HELD",
    );
    expectDeny(canActivateOffer(lifecycleRequest({ subject: promoter })), "ROLE_NOT_HELD");
    expectDeny(
      canChangeOfferTerms(lifecycleRequest({ subject: promoter })),
      "ROLE_NOT_HELD",
    );
  });

  it("a buyer holds no Offer authority", () => {
    const buyer = subject({ roles: [["BUYER", "ACTIVE"]] });
    expectDeny(
      canCreateDraftOffer({
        subject: buyer,
        offerSellerParticipantId: SELLER_PARTICIPANT_ID,
        hasProductAuthority: true,
      }),
      "ROLE_NOT_HELD",
    );
    expectDeny(canActivateOffer(lifecycleRequest({ subject: buyer })), "ROLE_NOT_HELD");
  });

  it("an internal entitlement alone grants nothing", () => {
    const operator = subject({
      noParticipant: true,
      internalCapabilities: ["publication-worker:status:read"],
    });
    expectDeny(
      canCreateDraftOffer({
        subject: operator,
        offerSellerParticipantId: SELLER_PARTICIPANT_ID,
        hasProductAuthority: true,
      }),
      "PARTICIPANT_REQUIRED",
    );
    expectDeny(canActivateOffer(lifecycleRequest({ subject: operator })), "PARTICIPANT_REQUIRED");
  });

  it("holding the internal capability changes no Offer decision", () => {
    const withCapability = subject({ internalCapabilities: ["publication-worker:status:read"] });
    expect(canActivateOffer(lifecycleRequest({ subject: withCapability, lifecycle: "DRAFT" })))
      .toEqual(canActivateOffer(lifecycleRequest({ lifecycle: "DRAFT" })));
  });

  it("a different Seller is denied on every capability", () => {
    const otherSeller = subject({ participantId: OTHER_PARTICIPANT_ID });
    expectDeny(
      canCreateDraftOffer({
        subject: otherSeller,
        offerSellerParticipantId: SELLER_PARTICIPANT_ID,
        hasProductAuthority: true,
      }),
      "SELLER_PARTICIPANT_MISMATCH",
    );
    for (const [decide, lifecycle] of [
      [canActivateOffer, "DRAFT"],
      [canResumeOffer, "SUSPENDED"],
      [canSuspendOffer, "ACTIVE"],
      [canEndOffer, "ACTIVE"],
      [canWithdrawOffer, "ACTIVE"],
      [canChangeOfferTerms, "ACTIVE"],
    ] as const) {
      expectDeny(
        decide(lifecycleRequest({ subject: otherSeller, lifecycle })),
        "SELLER_PARTICIPANT_MISMATCH",
      );
    }
  });

  it("a disabled account and a missing account are denied", () => {
    expectDeny(
      canActivateOffer(lifecycleRequest({ subject: subject({ account: "DISABLED" }) })),
      "ACCOUNT_DISABLED",
    );
    expectDeny(
      canActivateOffer(
        lifecycleRequest({ subject: subject({ account: null, noParticipant: true }) }),
      ),
      "ACCOUNT_REQUIRED",
    );
  });

  it("no reason code carries personal data", () => {
    const decision = canActivateOffer(
      lifecycleRequest({ subject: subject({ participantId: OTHER_PARTICIPANT_ID }) }),
    );
    const serialized = JSON.stringify(decision);
    for (const secret of [ACCOUNT_ID, OTHER_PARTICIPANT_ID, "@", "example.com"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

// — 21 —

describe("21. Product authority is required", () => {
  it("drafting an Offer against a Product you do not control is denied", () => {
    expectDeny(
      canCreateDraftOffer({
        subject: BARE_SELLER,
        offerSellerParticipantId: SELLER_PARTICIPANT_ID,
        hasProductAuthority: false,
      }),
      "PRODUCT_AUTHORITY_REQUIRED",
    );
  });

  it("activation and term changes require it too", () => {
    expectDeny(
      canActivateOffer(lifecycleRequest({ hasProductAuthority: false, lifecycle: "DRAFT" })),
      "PRODUCT_AUTHORITY_REQUIRED",
    );
    expectDeny(
      canChangeOfferTerms(lifecycleRequest({ hasProductAuthority: false })),
      "PRODUCT_AUTHORITY_REQUIRED",
    );
  });

  it("standing an Offer down does not require Product authority", () => {
    /* Withdrawing a commitment you made is not an assertion about the Product. */
    expectAllow(canWithdrawOffer(lifecycleRequest({ hasProductAuthority: false })));
    expectAllow(canSuspendOffer(lifecycleRequest({ hasProductAuthority: false })));
  });
});

// — 22 —

describe("22. material changes require a new source version", () => {
  it("every material field triggers a new version", () => {
    for (const field of MATERIAL_OFFER_FIELDS) {
      expect(classifyOfferChange([field]).requiresNewSourceVersion).toBe(true);
    }
    expect(MATERIAL_OFFER_FIELDS).toHaveLength(8);
  });

  it("a real diff reports exactly the fields that moved", () => {
    const prior = offerRecord();
    expect(materialChangesBetween(prior, prior)).toEqual([]);

    expect(materialChangesBetween(prior, offerRecord({ internalProductId: OTHER_PRODUCT_ID })))
      .toEqual(["internalProductId"]);
    expect(
      materialChangesBetween(prior, offerRecord({ sellerParticipantId: OTHER_PARTICIPANT_ID })),
    ).toEqual(["sellerParticipantId"]);
    expect(materialChangesBetween(prior, offerRecord({ lifecycle: "ACTIVE" }))).toEqual([
      "lifecycle",
    ]);
    expect(
      materialChangesBetween(prior, offerRecord({ availability: "TEMPORARILY_UNAVAILABLE" })),
    ).toEqual(["availability"]);
    expect(
      materialChangesBetween(
        prior,
        offerRecord({
          terms: { price: { type: "PAID", wholesalePriceMinorUnits: 12_000, wholesalePriceCurrency: "USD" }, promotion: { type: "NOT_PROMOTABLE" } },
        }),
      ),
    ).toEqual(["price"]);
    expect(
      materialChangesBetween(
        prior,
        offerRecord({
          effectiveInterval: { startsAt: "2026-09-01T00:00:00.000Z", endsAt: null },
        }),
      ),
    ).toEqual(["effectiveInterval"]);
  });

  it("promotability and commission value are distinguished", () => {
    const notPromotable = offerRecord();
    const promotable = offerRecord({
      terms: {
        price: PAID_TERMS.price,
        promotion: { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 500 } },
      },
    });
    expect(materialChangesBetween(notPromotable, promotable)).toEqual(["promotion"]);

    const higherCommission = offerRecord({
      terms: {
        price: PAID_TERMS.price,
        promotion: { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 1_500 } },
      },
    });
    expect(materialChangesBetween(promotable, higherCommission)).toEqual(["commission"]);
  });

  it("key order is not a change", () => {
    const a = offerRecord();
    const b = offerRecord({
      terms: { promotion: { type: "NOT_PROMOTABLE" }, price: PAID_TERMS.price },
    });
    expect(materialChangesBetween(a, b)).toEqual([]);
  });
});

// — 23 —

describe("23. publication and monitoring changes create no semantic version", () => {
  it("operational-only changes require no new version", () => {
    for (const field of OPERATIONAL_ONLY_OFFER_FIELDS) {
      const classified = classifyOfferChange([field]);
      expect(classified.requiresNewSourceVersion).toBe(false);
      expect(classified.operationalFields).toEqual([field]);
    }
    expect(OPERATIONAL_ONLY_OFFER_FIELDS).toHaveLength(7);
  });

  it("a mixed change still requires a version, and reports both sets", () => {
    const classified = classifyOfferChange(["publicationRetryState", "price", "monitoringCounters"]);
    expect(classified.requiresNewSourceVersion).toBe(true);
    expect(classified.materialFields).toEqual(["price"]);
    expect(classified.operationalFields).toEqual(["publicationRetryState", "monitoringCounters"]);
  });

  it("an empty change set requires nothing", () => {
    expect(classifyOfferChange([]).requiresNewSourceVersion).toBe(false);
  });

  it("an unclassified field name is a validation failure, never a guess", () => {
    /* A new field must be classified deliberately; defaulting is wrong in both
       directions — assume material and history fills with noise, assume
       operational and a real change goes unrecorded. */
    expect(() => classifyOfferChange(["someNewField"])).toThrow();
    expect(() => classifyOfferChange(["nodeId"])).toThrow();
  });
});

// — 24 —

describe("24. private and transactional data is excluded from projection eligibility", () => {
  it("the two classifications are disjoint", () => {
    for (const field of PROJECTION_ELIGIBLE_OFFER_FIELDS) {
      expect(isNeverProjectionEligible(field)).toBe(false);
    }
    for (const field of NEVER_PROJECTION_ELIGIBLE_OFFER_DATA) {
      expect(isProjectionEligibleOfferField(field)).toBe(false);
    }
  });

  it("account, identity, payment, and financial data are never eligible", () => {
    for (const field of [
      "accountId",
      "email",
      "legalIdentity",
      "privateProfile",
      "paymentProviderId",
      "bankingData",
      "taxData",
      "internalReviewNotes",
      "internalCost",
      "internalMargin",
      "platformFee",
      "processingFee",
      "earnedCommission",
      "orderData",
      "checkoutData",
      "paymentData",
      "refundData",
      "settlementData",
      "payoutData",
      "auditInternals",
      "sourceRetentionState",
    ]) {
      expect(isNeverProjectionEligible(field)).toBe(true);
      expect(isProjectionEligibleOfferField(field)).toBe(false);
    }
  });

  it("a raw participant identifier is not a public identifier", () => {
    expect(isNeverProjectionEligible("rawParticipantId")).toBe(true);
  });

  it("no such data exists on the Offer record to begin with", () => {
    for (const intruder of [
      { accountId: ACCOUNT_ID },
      { internalCost: 500 },
      { platformFee: 850 },
      { earnedCommission: 2_000 },
      { payoutData: {} },
    ]) {
      expect(OfferSourceRecord.safeParse({ ...offerRecord(), ...intruder }).success).toBe(false);
    }
  });
});

// — 25 —

describe("25. deferred extensions cannot enter as arbitrary metadata", () => {
  it("each deferred extension is refused on the record and the version", () => {
    for (const extension of DEFERRED_OFFER_EXTENSIONS) {
      expect(OfferSourceRecord.safeParse({ ...offerRecord(), [extension]: {} }).success).toBe(false);
      expect(OfferSourceVersion.safeParse({ ...offerVersion(), [extension]: {} }).success)
        .toBe(false);
    }
    expect(DEFERRED_OFFER_EXTENSIONS.length).toBeGreaterThanOrEqual(18);
  });

  it("there is no metadata, extensions, or custom bag to smuggle them through", () => {
    for (const bag of ["metadata", "extensions", "custom", "attributes", "extra", "data"]) {
      expect(
        OfferSourceRecord.safeParse({ ...offerRecord(), [bag]: { inventoryQuantity: 5 } }).success,
      ).toBe(false);
    }
  });

  it("nested terms are closed too", () => {
    expect(
      OfferCommercialTerms.safeParse({
        price: { ...PAID_TERMS.price, taxTreatment: "VAT" },
        promotion: PAID_TERMS.promotion,
      }).success,
    ).toBe(false);
  });
});

// — 26 —

describe("26. unknown keys and enum values fail", () => {
  it("unknown enum members are refused", () => {
    expect(OfferLifecycleState.safeParse("PAUSED").success).toBe(false);
    expect(OfferLifecycleState.safeParse("PUBLISHED").success).toBe(false);
    expect(OfferAvailability.safeParse("UNAVAILABLE").success).toBe(false);
    expect(OfferPrice.safeParse({ type: "SUBSCRIPTION" }).success).toBe(false);
  });

  it("unknown keys are refused everywhere", () => {
    expect(OfferSourceRecord.safeParse({ ...offerRecord(), extra: 1 }).success).toBe(false);
    expect(OfferSourceVersion.safeParse({ ...offerVersion(), extra: 1 }).success).toBe(false);
    expect(
      OfferEffectiveInterval.safeParse({ startsAt: null, endsAt: null, timezone: "UTC" }).success,
    ).toBe(false);
  });

  it("the source-system triple is fixed", () => {
    for (const intruder of [
      { sourceSystem: "external" },
      { sourceRecordType: "Product" },
      { sourceClass: "imported" },
    ]) {
      expect(OfferSourceRecord.safeParse({ ...offerRecord(), ...intruder }).success).toBe(false);
    }
  });

  it("a malformed decision is refused", () => {
    expect(
      OfferAuthorityDecision.safeParse({
        capability: "offer:activate",
        decision: "ALLOW",
        reasonCodes: ["ROLE_NOT_HELD"],
      }).success,
    ).toBe(false);
    expect(
      OfferAuthorityDecision.safeParse({
        capability: "offer:activate",
        decision: "DENY",
        reasonCodes: [],
      }).success,
    ).toBe(false);
    expect(
      OfferAuthorityDecision.safeParse({
        capability: "offer:delete",
        decision: "DENY",
        reasonCodes: ["ROLE_NOT_HELD"],
      }).success,
    ).toBe(false);
  });

  it("the source contracts hold no Node, capsule, Registrar, publication, or projection identity", () => {
    /* `mon:offer:` is an internal enduring transactional identity. It is not an
       AgentNet Node IRI, not a capsule-version identity, not a Registrar
       identifier, and its presence is not evidence that projection work began. */
    const identityIntruders = [
      { nodeId: `an:node:${body(20)}` },
      { ansNodeId: `an:node:${body(20)}` },
      { offerNodeId: `an:node:${body(20)}` },
      { capsuleId: `an:capsule:${body(21)}` },
      { capsuleVersion: "1.0.0" },
      { capsuleSemver: "1.0.0" },
      { mappingVersion: "1.0.0" },
      { projectionHash: "sha256:abc" },
      { contentHash: "sha256:abc" },
      { registrarId: "reg-1" },
      { registrationState: "ACCEPTED" },
      { receiptId: `mon:rcpt:${body(22)}` },
      { publicationId: `mon:pub:${body(23)}` },
      { publicationStatus: "PREPARED" },
      { publishedAt: "2026-08-01T00:00:00.000Z" },
      { publishedBy: "an:publisher:monacado-platform" },
      { "@context": "https://schema.org" },
      { "@type": "Offer" },
      { "@id": "https://monacado.com/id/offer/x" },
    ];
    for (const intruder of identityIntruders) {
      expect(OfferSourceRecord.safeParse({ ...offerRecord(), ...intruder }).success).toBe(false);
      expect(OfferSourceVersion.safeParse({ ...offerVersion(), ...intruder }).success).toBe(false);
    }
  });

  it("an internal Offer id is never accepted where an ANS identity would go", () => {
    /* And the converse: an ANS-shaped value is refused as the internal id. */
    for (const bad of [`an:node:${body(24)}`, `an:capsule:${body(25)}`, "https://monacado.com/id/offer/x"]) {
      expect(OfferSourceRecord.safeParse({ ...offerRecord(), internalOfferId: bad }).success)
        .toBe(false);
    }
    expect(
      OfferSourceRecord.safeParse({ ...offerRecord(), internalOfferId: OFFER_SREC_ID }).success,
    ).toBe(false);
  });

  it("no decision reads ambient state", () => {
    const source = readFileSync(
      new URL("../src/contracts/marketplace/offer-source.ts", import.meta.url),
      "utf8",
    );
    for (const token of [
      "process.env",
      "Date.now",
      "new Date",
      "Math.random",
      "fetch(",
      "prisma",
      "@prisma/client",
      "node:crypto",
    ]) {
      expect(source, `offer-source.ts must not reference ${token}`).not.toContain(token);
    }
  });
});

// — 28 (Phase 0M.2C) —

describe("28. wholesale-price terminology replaces the generic price", () => {
  it("a PAID Offer carries wholesale price fields", () => {
    const price = offerRecord().terms.price;
    expect(price).toEqual({
      type: "PAID",
      wholesalePriceMinorUnits: 10_000,
      wholesalePriceCurrency: "USD",
    });
  });

  it("the old generic price fields are rejected", () => {
    for (const legacy of [
      { type: "PAID", amountMinorUnits: 10_000, currency: "USD" },
      { type: "PAID", priceMinorUnits: 10_000, priceCurrency: "USD" },
    ]) {
      expect(OfferPrice.safeParse(legacy).success).toBe(false);
    }
  });

  it("promoter retail price, MSRP, and price floors are rejected", () => {
    for (const foreign of [
      "promoterRetailPrice",
      "retailPrice",
      "suggestedRetailPrice",
      "minimumRetailPrice",
      "creatorPriceFloor",
      "msrp",
    ]) {
      expect(
        OfferPrice.safeParse({ ...offerRecord().terms.price, [foreign]: 1 }).success,
        foreign,
      ).toBe(false);
      expect(
        OfferSourceRecord.safeParse({ ...offerRecord(), [foreign]: 1 }).success,
        foreign,
      ).toBe(false);
      expect(
        OfferSourceVersion.safeParse({ ...offerVersion(), [foreign]: 1 }).success,
        foreign,
      ).toBe(false);
    }
  });

  it("a FREE Offer carries no wholesale amount, currency, or commission", () => {
    const free = { price: { type: "FREE" }, promotion: { type: "NOT_PROMOTABLE" } } as const;
    expect(OfferCommercialTerms.safeParse(free).success).toBe(true);
    expect(calculateOfferEconomics(free as never)).toEqual({
      calculatedCommissionMinorUnits: 0,
      calculatedCreatorGrossProceedsMinorUnits: 0,
      commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
    });
  });
});

// — 29 —

describe("29. commission methods are wholesale-based and strictly discriminated", () => {
  const withCommission = (commission: unknown) =>
    OfferCommercialTerms.safeParse({
      price: PAID_TERMS.price,
      promotion: { type: "PROMOTABLE", commission },
    }).success;

  it("PERCENT_OF_WHOLESALE and FIXED_AMOUNT validate", () => {
    expect(
      withCommission({ method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 1_500 }),
    ).toBe(true);
    expect(
      withCommission({
        method: "FIXED_AMOUNT",
        fixedCommissionMinorUnits: 2_500,
        fixedCommissionCurrency: "USD",
      }),
    ).toBe(true);
    expect(COMMISSION_METHODS).toEqual(["PERCENT_OF_WHOLESALE", "FIXED_AMOUNT"]);
  });

  it("a retail or checkout basis is refused", () => {
    /* A commission computed from a number the Promoter controls would let the
       Promoter change what the creator owes them. */
    for (const method of [
      "PERCENT_OF_RETAIL",
      "PERCENT_OF_LISTING_PRICE",
      "PERCENT_OF_CHECKOUT_TOTAL",
      "PERCENTAGE",
    ]) {
      expect(withCommission({ method, commissionBasisPoints: 1_500 }), method).toBe(false);
    }
  });

  it("each method refuses the other's fields", () => {
    expect(
      withCommission({
        method: "PERCENT_OF_WHOLESALE",
        commissionBasisPoints: 1_500,
        fixedCommissionMinorUnits: 100,
      }),
    ).toBe(false);
    expect(
      withCommission({
        method: "FIXED_AMOUNT",
        fixedCommissionMinorUnits: 100,
        fixedCommissionCurrency: "USD",
        commissionBasisPoints: 1_500,
      }),
    ).toBe(false);
  });

  it("fixed currency must match wholesale, and cannot exceed it", () => {
    expect(
      withCommission({
        method: "FIXED_AMOUNT",
        fixedCommissionMinorUnits: 100,
        fixedCommissionCurrency: "EUR",
      }),
    ).toBe(false);
    expect(
      withCommission({
        method: "FIXED_AMOUNT",
        fixedCommissionMinorUnits: 10_001,
        fixedCommissionCurrency: "USD",
      }),
    ).toBe(false);
  });

  it("percentage bounds hold", () => {
    expect(withCommission({ method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 0 })).toBe(false);
    expect(
      withCommission({ method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 10_001 }),
    ).toBe(false);
    expect(
      withCommission({
        method: "PERCENT_OF_WHOLESALE",
        commissionBasisPoints: MAX_COMMISSION_BASIS_POINTS,
      }),
    ).toBe(true);
  });
});

// — 30 —

describe("30. commission calculation is deterministic and integer-safe", () => {
  const paid = (wholesale: number, commission?: unknown) =>
    ({
      price: {
        type: "PAID",
        wholesalePriceMinorUnits: wholesale,
        wholesalePriceCurrency: "USD",
      },
      promotion:
        commission === undefined
          ? { type: "NOT_PROMOTABLE" }
          : { type: "PROMOTABLE", commission },
    }) as never;

  it("percentage uses the wholesale price as the basis", () => {
    const economics = calculateOfferEconomics(
      paid(10_000, { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 }),
    );
    expect(economics.calculatedCommissionMinorUnits).toBe(2_000);
    expect(economics.calculatedCreatorGrossProceedsMinorUnits).toBe(8_000);
  });

  it("rounds half-up to the minor unit, deterministically", () => {
    /* 333 × 5% = 16.65 → 17; 333 × 1.5% = 4.995 → 5. */
    expect(
      calculateOfferEconomics(
        paid(333, { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 500 }),
      ).calculatedCommissionMinorUnits,
    ).toBe(17);
    expect(
      calculateOfferEconomics(
        paid(333, { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 150 }),
      ).calculatedCommissionMinorUnits,
    ).toBe(5);
    /* Exactly .5 rounds up, not to even. */
    expect(
      calculateOfferEconomics(
        paid(1, { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 5_000 }),
      ).calculatedCommissionMinorUnits,
    ).toBe(1);
  });

  it("a fixed commission is exact and needs no rounding", () => {
    expect(
      calculateOfferEconomics(
        paid(10_000, {
          method: "FIXED_AMOUNT",
          fixedCommissionMinorUnits: 2_499,
          fixedCommissionCurrency: "USD",
        }),
      ),
    ).toEqual({
      calculatedCommissionMinorUnits: 2_499,
      calculatedCreatorGrossProceedsMinorUnits: 7_501,
      commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
    });
  });

  it("BigInt arithmetic prevents silent precision loss at large amounts", () => {
    /* wholesale × basisPoints exceeds Number.MAX_SAFE_INTEGER here; a float
       multiply would round before the division ever happened. */
    const large = 2_000_000_000_000;
    const economics = calculateOfferEconomics(
      paid(large, { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 9_999 }),
    );
    expect(large * 9_999 > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(economics.calculatedCommissionMinorUnits).toBe(
      Number((BigInt(large) * 9_999n + 5_000n) / 10_000n),
    );
    expect(
      economics.calculatedCommissionMinorUnits +
        economics.calculatedCreatorGrossProceedsMinorUnits,
    ).toBe(large);
  });

  it("commission plus creator proceeds always equals the wholesale price", () => {
    for (const bp of [1, 137, 2_500, 9_999, 10_000]) {
      const economics = calculateOfferEconomics(
        paid(7_777, { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: bp }),
      );
      expect(
        economics.calculatedCommissionMinorUnits +
          economics.calculatedCreatorGrossProceedsMinorUnits,
      ).toBe(7_777);
      expect(economics.calculatedCommissionMinorUnits).toBeGreaterThanOrEqual(0);
      expect(economics.calculatedCreatorGrossProceedsMinorUnits).toBeGreaterThanOrEqual(0);
    }
  });

  it("NOT_PROMOTABLE yields zero commission and full proceeds", () => {
    expect(calculateOfferEconomics(paid(10_000))).toEqual({
      calculatedCommissionMinorUnits: 0,
      calculatedCreatorGrossProceedsMinorUnits: 10_000,
      commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
    });
  });

  it("the same inputs always produce the same outputs", () => {
    const terms = paid(4_321, { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 777 });
    expect(calculateOfferEconomics(terms)).toEqual(calculateOfferEconomics(terms));
  });

  it("stored economics that disagree with the calculator are refused", () => {
    expect(
      OfferSourceRecord.safeParse({
        ...offerRecord(),
        economics: {
          calculatedCommissionMinorUnits: 1,
          calculatedCreatorGrossProceedsMinorUnits: 9_999,
          commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
        },
      }).success,
    ).toBe(false);
    expect(
      OfferSourceVersion.safeParse({
        ...offerVersion(),
        economics: {
          calculatedCommissionMinorUnits: 0,
          calculatedCreatorGrossProceedsMinorUnits: 1,
          commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
        },
      }).success,
    ).toBe(false);
  });
});

// — 31 —

describe("31. creator disclosure and exact-version confirmation", () => {
  const version = "3";
  const disclosure = () =>
    buildCreatorEconomicsDisclosure({
      offerSourceRecordId: OFFER_SREC_ID,
      sourceRecordVersion: version,
      terms: PAID_TERMS as never,
    });

  it("the disclosure carries the exact commission, proceeds, and policy version", () => {
    const shown = disclosure();
    expect(shown.economics.calculatedCommissionMinorUnits).toBe(0);
    expect(shown.economics.calculatedCreatorGrossProceedsMinorUnits).toBe(10_000);
    expect(shown.economics.commissionCalculationPolicyVersion).toBe("WHOLESALE_COMMISSION_V1");
    expect(shown.sourceRecordVersion).toBe(version);
  });

  it("a promotable disclosure shows what the creator actually nets", () => {
    const terms = {
      price: PAID_TERMS.price,
      promotion: {
        type: "PROMOTABLE",
        commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
      },
    } as const;
    const shown = buildCreatorEconomicsDisclosure({
      offerSourceRecordId: OFFER_SREC_ID,
      sourceRecordVersion: version,
      terms: terms as never,
    });
    expect(shown.economics.calculatedCommissionMinorUnits).toBe(2_000);
    expect(shown.economics.calculatedCreatorGrossProceedsMinorUnits).toBe(8_000);
  });

  it("activation is refused without a confirmation", () => {
    expectDeny(
      canActivateOffer(lifecycleRequest({ lifecycle: "DRAFT", economicsContext: undefined })),
      "CREATOR_ECONOMICS_NOT_CONFIRMED",
    );
    expectDeny(
      canActivateOffer(
        lifecycleRequest({
          lifecycle: "DRAFT",
          economicsContext: {
            offerSourceRecordId: OFFER_SREC_ID,
            sourceRecordVersion: version,
            terms: PAID_TERMS as never,
            confirmation: null,
          },
        }),
      ),
      "CREATOR_ECONOMICS_NOT_CONFIRMED",
    );
  });

  it("a confirmation for another source version is refused", () => {
    expectDeny(
      canActivateOffer(
        lifecycleRequest({
          lifecycle: "DRAFT",
          economicsContext: {
            offerSourceRecordId: OFFER_SREC_ID,
            sourceRecordVersion: "4",
            terms: PAID_TERMS as never,
            confirmation: matchingConfirmation(PAID_TERMS as never, "3"),
          },
        }),
      ),
      "CREATOR_CONFIRMATION_VERSION_MISMATCH",
    );
  });

  it("stale confirmed amounts are refused", () => {
    const stale = { ...matchingConfirmation(), calculatedCommissionMinorUnits: 1 };
    expectDeny(
      canActivateOffer(
        lifecycleRequest({
          lifecycle: "DRAFT",
          economicsContext: {
            offerSourceRecordId: OFFER_SREC_ID,
            sourceRecordVersion: version,
            terms: PAID_TERMS as never,
            confirmation: stale,
          },
        }),
      ),
      "CREATOR_CONFIRMATION_STALE",
    );
  });

  it("a confirmation under another calculation policy is refused", () => {
    expect(
      CreatorEconomicsConfirmation.safeParse({
        ...matchingConfirmation(),
        commissionCalculationPolicyVersion: "SOME_OTHER_POLICY",
      }).success,
    ).toBe(false);
    /* The bounded enum makes an unknown policy unrepresentable, which is the
       stronger guarantee than a runtime comparison. */
    expect(CURRENT_COMMISSION_CALCULATION_POLICY).toBe("WHOLESALE_COMMISSION_V1");
  });

  it("an exactly matching confirmation permits activation when all other gates pass", () => {
    expectAllow(canActivateOffer(lifecycleRequest({ lifecycle: "DRAFT" })));
  });

  it("a material economic change invalidates the prior confirmation", () => {
    /* The creator confirmed version 3's economics; version 4 raised the wholesale
       price, so the confirmation no longer matches by construction. */
    const repriced = {
      price: { type: "PAID", wholesalePriceMinorUnits: 12_000, wholesalePriceCurrency: "USD" },
      promotion: { type: "NOT_PROMOTABLE" },
    } as const;
    expectDeny(
      canActivateOffer(
        lifecycleRequest({
          lifecycle: "DRAFT",
          economicsContext: {
            offerSourceRecordId: OFFER_SREC_ID,
            sourceRecordVersion: "4",
            terms: repriced as never,
            confirmation: matchingConfirmation(PAID_TERMS as never, "4"),
          },
        }),
      ),
      "CREATOR_CONFIRMATION_STALE",
    );
  });

  it("confirmation is not an unbound boolean", () => {
    /* A bare `true` says nothing about which economics were confirmed, so it
       would survive a repricing untouched. */
    expect(CreatorEconomicsConfirmation.safeParse(true).success).toBe(false);
    expect(CreatorEconomicsConfirmation.safeParse({}).success).toBe(false);
    for (const key of [
      "confirmedOfferSourceRecordId",
      "confirmedOfferSourceRecordVersion",
      "calculatedCommissionMinorUnits",
      "calculatedCreatorGrossProceedsMinorUnits",
      "commissionCalculationPolicyVersion",
    ]) {
      const partial = { ...matchingConfirmation() } as Record<string, unknown>;
      delete partial[key];
      expect(CreatorEconomicsConfirmation.safeParse(partial).success, key).toBe(false);
    }
  });

  it("standing an Offer down needs no economics confirmation", () => {
    /* Withdrawing a commitment asserts nothing about its economics. */
    for (const decide of [canSuspendOffer, canEndOffer, canWithdrawOffer]) {
      expectAllow(decide(lifecycleRequest({ lifecycle: "ACTIVE", economicsContext: undefined })));
    }
  });
});

// — 32 —

describe("32. business change classification", () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    internalProductId: PRODUCT_ID,
    sellerParticipantId: SELLER_PARTICIPANT_ID,
    lifecycle: "ACTIVE" as const,
    availability: "AVAILABLE" as const,
    terms: PAID_TERMS as never,
    effectiveInterval: null,
    ...overrides,
  });

  it("an availability change is classified", () => {
    expect(
      classifyOfferBusinessChanges(state(), state({ availability: "TEMPORARILY_UNAVAILABLE" })),
    ).toEqual(["COMMERCIAL_AVAILABILITY_CHANGED"]);
  });

  it("a wholesale increase and decrease are both classified", () => {
    const at = (amount: number) =>
      state({
        terms: {
          price: {
            type: "PAID",
            wholesalePriceMinorUnits: amount,
            wholesalePriceCurrency: "USD",
          },
          promotion: { type: "NOT_PROMOTABLE" },
        },
      });
    expect(classifyOfferBusinessChanges(at(10_000), at(12_000))).toEqual([
      "WHOLESALE_PRICE_CHANGED",
    ]);
    expect(classifyOfferBusinessChanges(at(10_000), at(8_000))).toEqual([
      "WHOLESALE_PRICE_CHANGED",
    ]);
  });

  it("rate, fixed-amount, and method changes are commission-terms changes", () => {
    const withCommission = (commission: unknown) =>
      state({ terms: { price: PAID_TERMS.price, promotion: { type: "PROMOTABLE", commission } } });
    const percent = (bp: number) => ({
      method: "PERCENT_OF_WHOLESALE",
      commissionBasisPoints: bp,
    });
    const fixed = (amount: number) => ({
      method: "FIXED_AMOUNT",
      fixedCommissionMinorUnits: amount,
      fixedCommissionCurrency: "USD",
    });

    expect(
      classifyOfferBusinessChanges(withCommission(percent(1_000)), withCommission(percent(2_000))),
    ).toEqual(["COMMISSION_TERMS_CHANGED"]);
    expect(
      classifyOfferBusinessChanges(withCommission(fixed(1_000)), withCommission(fixed(2_000))),
    ).toEqual(["COMMISSION_TERMS_CHANGED"]);
    expect(
      classifyOfferBusinessChanges(withCommission(percent(1_000)), withCommission(fixed(1_000))),
    ).toEqual(["COMMISSION_TERMS_CHANGED"]);
  });

  it("a wholesale change under a percentage does not double-report a commission change", () => {
    /* The derived commission amount moved, but the creator changed one thing —
       reporting two would tell a promoter their terms were altered when they
       were not. */
    const withPercent = (wholesale: number) =>
      state({
        terms: {
          price: {
            type: "PAID",
            wholesalePriceMinorUnits: wholesale,
            wholesalePriceCurrency: "USD",
          },
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
          },
        },
      });
    expect(classifyOfferBusinessChanges(withPercent(10_000), withPercent(20_000))).toEqual([
      "WHOLESALE_PRICE_CHANGED",
    ]);
  });

  it("no change produces no category", () => {
    expect(classifyOfferBusinessChanges(state(), state())).toEqual([]);
  });

  it("other material changes are classified separately", () => {
    expect(classifyOfferBusinessChanges(state(), state({ lifecycle: "SUSPENDED" }))).toEqual([
      "OTHER_MATERIAL_OFFER_CHANGE",
    ]);
  });

  it("the classifier only classifies — it creates and mutates nothing", () => {
    const source = readFileSync(
      new URL("../src/contracts/marketplace/offer-source.ts", import.meta.url),
      "utf8",
    );
    /* Code tokens only — the prose above deliberately says it enqueues no job. */
    for (const token of [
      "sendNotice(",
      "notifyPromoter(",
      "enqueue(",
      "persistEvent(",
      "prisma",
      "fetch(",
    ]) {
      expect(source, `offer-source.ts must not call ${token}`).not.toContain(token);
    }
    const before = JSON.stringify(state());
    classifyOfferBusinessChanges(state(), state({ availability: "TEMPORARILY_UNAVAILABLE" }));
    expect(JSON.stringify(state())).toBe(before);
  });

  it("operational-only changes produce no economic category", () => {
    for (const field of OPERATIONAL_ONLY_OFFER_FIELDS) {
      expect(classifyOfferChange([field]).requiresNewSourceVersion).toBe(false);
    }
    expect(classifyOfferBusinessChanges(state(), state())).toEqual([]);
  });
});

// — 33 —

describe("33. confirmation binds to the exact Offer record and version", () => {
  const OTHER_OFFER_SREC_ID = `mon:srec:${body(20)}`;

  const activationWith = (
    confirmation: unknown,
    context: { offerSourceRecordId?: string; sourceRecordVersion?: string } = {},
  ) =>
    canActivateOffer(
      lifecycleRequest({
        lifecycle: "DRAFT",
        economicsContext: {
          offerSourceRecordId: context.offerSourceRecordId ?? OFFER_SREC_ID,
          sourceRecordVersion: context.sourceRecordVersion ?? "3",
          terms: PAID_TERMS as never,
          confirmation: confirmation as never,
        },
      }),
    );

  it("carries exactly the five required fields", () => {
    expect(Object.keys(matchingConfirmation()).sort()).toEqual([
      "calculatedCommissionMinorUnits",
      "calculatedCreatorGrossProceedsMinorUnits",
      "commissionCalculationPolicyVersion",
      "confirmedOfferSourceRecordId",
      "confirmedOfferSourceRecordVersion",
    ]);
    expect(
      CreatorEconomicsConfirmation.safeParse({ ...matchingConfirmation(), extra: 1 }).success,
    ).toBe(false);
  });

  it("Offer A's v3 confirmation cannot activate Offer B's v3", () => {
    /* A version label alone is not unique across Offers — two Offers each have a
       "v3", and the amounts may coincidentally match. */
    const offerAConfirmation = {
      ...matchingConfirmation(PAID_TERMS as never, "3"),
      confirmedOfferSourceRecordId: OTHER_OFFER_SREC_ID,
    };
    expectDeny(
      activationWith(offerAConfirmation, { offerSourceRecordId: OFFER_SREC_ID }),
      "CREATOR_CONFIRMATION_SOURCE_RECORD_MISMATCH",
    );
  });

  it("the correct record with the wrong version is denied", () => {
    expectDeny(
      activationWith(matchingConfirmation(PAID_TERMS as never, "2"), {
        sourceRecordVersion: "3",
      }),
      "CREATOR_CONFIRMATION_VERSION_MISMATCH",
    );
  });

  it("the correct version label on the wrong record is denied", () => {
    expectDeny(
      activationWith(
        {
          ...matchingConfirmation(PAID_TERMS as never, "3"),
          confirmedOfferSourceRecordId: OTHER_OFFER_SREC_ID,
        },
        { sourceRecordVersion: "3" },
      ),
      "CREATOR_CONFIRMATION_SOURCE_RECORD_MISMATCH",
    );
  });

  it("the exact record and version pairing activates when all other gates pass", () => {
    expectAllow(activationWith(matchingConfirmation(PAID_TERMS as never, "3")));
  });

  it("an economic source-version change invalidates the prior confirmation", () => {
    const repriced = {
      price: { type: "PAID", wholesalePriceMinorUnits: 15_000, wholesalePriceCurrency: "USD" },
      promotion: { type: "NOT_PROMOTABLE" },
    } as const;
    expectDeny(
      canActivateOffer(
        lifecycleRequest({
          lifecycle: "DRAFT",
          economicsContext: {
            offerSourceRecordId: OFFER_SREC_ID,
            sourceRecordVersion: "4",
            terms: repriced as never,
            confirmation: matchingConfirmation(PAID_TERMS as never, "4"),
          },
        }),
      ),
      "CREATOR_CONFIRMATION_STALE",
    );
  });

  it("a bare boolean and every incomplete object fail", () => {
    for (const bad of [true, false, {}, null, "CONFIRMED", 1]) {
      expect(CreatorEconomicsConfirmation.safeParse(bad).success, String(bad)).toBe(false);
    }
    for (const key of Object.keys(matchingConfirmation())) {
      const partial = { ...matchingConfirmation() } as Record<string, unknown>;
      delete partial[key];
      expect(CreatorEconomicsConfirmation.safeParse(partial).success, key).toBe(false);
    }
  });
});

// — 34 —

describe("34. business changes are multi-category and deterministically ordered", () => {
  const percent = (bp: number) => ({
    method: "PERCENT_OF_WHOLESALE" as const,
    commissionBasisPoints: bp,
  });

  const state = (spec: {
    availability?: "AVAILABLE" | "TEMPORARILY_UNAVAILABLE";
    wholesale?: number;
    basisPoints?: number;
    lifecycle?: "ACTIVE" | "SUSPENDED";
  } = {}) => ({
    internalProductId: PRODUCT_ID,
    sellerParticipantId: SELLER_PARTICIPANT_ID,
    lifecycle: spec.lifecycle ?? ("ACTIVE" as const),
    availability: spec.availability ?? ("AVAILABLE" as const),
    terms: {
      price: {
        type: "PAID",
        wholesalePriceMinorUnits: spec.wholesale ?? 10_000,
        wholesalePriceCurrency: "USD",
      },
      promotion: { type: "PROMOTABLE", commission: percent(spec.basisPoints ?? 2_000) },
    } as never,
    effectiveInterval: null,
  });

  it("returns a readonly array in the fixed order", () => {
    expect(OFFER_BUSINESS_CHANGE_ORDER).toEqual([
      "COMMERCIAL_AVAILABILITY_CHANGED",
      "WHOLESALE_PRICE_CHANGED",
      "COMMISSION_TERMS_CHANGED",
      "OTHER_MATERIAL_OFFER_CHANGE",
    ]);
    expect(Object.isFrozen(classifyOfferBusinessChanges(state(), state()))).toBe(true);
  });

  it("no change returns an empty array", () => {
    expect(classifyOfferBusinessChanges(state(), state())).toEqual([]);
  });

  it("each single change returns exactly one category", () => {
    expect(
      classifyOfferBusinessChanges(state(), state({ availability: "TEMPORARILY_UNAVAILABLE" })),
    ).toEqual(["COMMERCIAL_AVAILABILITY_CHANGED"]);
    expect(classifyOfferBusinessChanges(state(), state({ wholesale: 12_000 }))).toEqual([
      "WHOLESALE_PRICE_CHANGED",
    ]);
    expect(classifyOfferBusinessChanges(state(), state({ basisPoints: 3_000 }))).toEqual([
      "COMMISSION_TERMS_CHANGED",
    ]);
  });

  it("availability plus wholesale returns both, in order", () => {
    expect(
      classifyOfferBusinessChanges(
        state(),
        state({ availability: "TEMPORARILY_UNAVAILABLE", wholesale: 12_000 }),
      ),
    ).toEqual(["COMMERCIAL_AVAILABILITY_CHANGED", "WHOLESALE_PRICE_CHANGED"]);
  });

  it("wholesale plus commission inputs returns both, in order", () => {
    expect(
      classifyOfferBusinessChanges(state(), state({ wholesale: 12_000, basisPoints: 3_000 })),
    ).toEqual(["WHOLESALE_PRICE_CHANGED", "COMMISSION_TERMS_CHANGED"]);
  });

  it("all three at once returns all three, in order", () => {
    expect(
      classifyOfferBusinessChanges(
        state(),
        state({
          availability: "TEMPORARILY_UNAVAILABLE",
          wholesale: 12_000,
          basisPoints: 3_000,
        }),
      ),
    ).toEqual([
      "COMMERCIAL_AVAILABILITY_CHANGED",
      "WHOLESALE_PRICE_CHANGED",
      "COMMISSION_TERMS_CHANGED",
    ]);
  });

  it("an unrelated material change appends the other category last", () => {
    expect(
      classifyOfferBusinessChanges(state(), state({ wholesale: 12_000, lifecycle: "SUSPENDED" })),
    ).toEqual(["WHOLESALE_PRICE_CHANGED", "OTHER_MATERIAL_OFFER_CHANGE"]);
  });

  it("a derived commission move from a wholesale change is not a terms change", () => {
    /* 20% of 10 000 = 2 000; 20% of 20 000 = 4 000. The amount moved; the terms
       did not. */
    const before = state({ wholesale: 10_000 });
    const after = state({ wholesale: 20_000 });
    expect(calculateOfferEconomics(before.terms).calculatedCommissionMinorUnits).toBe(2_000);
    expect(calculateOfferEconomics(after.terms).calculatedCommissionMinorUnits).toBe(4_000);
    expect(classifyOfferBusinessChanges(before, after)).toEqual(["WHOLESALE_PRICE_CHANGED"]);
  });

  it("operational-only data cannot produce a category", () => {
    for (const field of OPERATIONAL_ONLY_OFFER_FIELDS) {
      expect(classifyOfferChange([field]).requiresNewSourceVersion).toBe(false);
    }
    expect(classifyOfferBusinessChanges(state(), state())).toEqual([]);
  });
});
