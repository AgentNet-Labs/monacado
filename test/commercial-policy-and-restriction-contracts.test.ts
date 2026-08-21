/**
 * Versioned commercial policy and participant restriction contract tests
 * (Phase 0M.R1).
 *
 * Offline and pure. No database, no clock, no network. Every value is synthetic.
 *
 * One `describe` per required property, matching the 0M.1/0M.5/0M.8 convention.
 */

import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_POLICY_VERSION_TRANSITIONS,
  CommercialPolicyVersionRecord,
  INITIAL_COMMERCIAL_POLICY_VERSION_STATUS,
  MONACADO_STANDARD_POLICY_V1,
  NEVER_ON_COMMERCIAL_POLICY_VERSION,
  RecordCommercialPolicyVersionInput,
  isBindableCommercialPolicyVersion,
  isValidCommercialPolicyVersionTransition,
  toWholesaleAcquisitionPolicy,
} from "../src/contracts/marketplace/commercial-policy";
import {
  ImposeParticipantRestrictionInput,
  LiftParticipantRestrictionInput,
  NEVER_ON_PARTICIPANT_RESTRICTION,
  NEVER_RESTRICTABLE_CAPABILITIES,
  RESTRICTABLE_CAPABILITIES,
  RESTRICTION_REASON_CODES,
  RESTRICTION_STATUSES,
  ParticipantRestrictionRecord,
  RestrictionScope,
  isRestrictableCapability,
  reconcileParticipantStatusForRestrictions,
  restrictedStatusIsSupported,
} from "../src/contracts/marketplace/participant-restriction";
import {
  calculateMonacadoRetainedAmount,
  calculateMorWholesaleAcquisition,
  calculatePromotedListingEconomics,
  MonacadoWholesaleAcquisitionPolicy,
} from "../src/contracts/marketplace/listing-source";
import { MARKETPLACE_CAPABILITIES } from "../src/contracts/marketplace/capability";
import { ACCOUNT_CAPABILITIES, AccountCapability } from "../src/contracts/account/account";
import {
  PARTICIPANT_RESTRICT_CAPABILITY,
  canRestrictParticipant,
  canReviewParticipantActivation,
  isInternallyAuthorized,
} from "../src/contracts/account/internal-authorization";
import { PARTICIPANT_STATUSES } from "../src/contracts/marketplace/participant";

const POLICY = "mon:cpol:R1PCY000000000000000000000";
const ACCOUNT = "mon:acct:R1ACCT00000000000000000000";
const PARTICIPANT = "mon:mpart:R1PART00000000000000000000";
const RESTRICTION = "mon:prst:R1RESTR0000000000000000000";
const NOW = "2027-09-01T09:00:00.000Z";

const versionRecord = (overrides: Record<string, unknown> = {}) =>
  CommercialPolicyVersionRecord.parse({
    policyId: POLICY,
    policyVersion: "1",
    status: "ACTIVE",
    currency: "USD",
    retainedPercentageBasisPoints: 750,
    retainedFixedAmountMinorUnits: 100,
    roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
    effectiveFrom: NOW,
    recordedByAccountId: ACCOUNT,
    recordedAt: NOW,
    retiredAt: null,
    retiredByAccountId: null,
    ...overrides,
  });

const restrictionRecord = (overrides: Record<string, unknown> = {}) =>
  ParticipantRestrictionRecord.parse({
    restrictionId: RESTRICTION,
    participantId: PARTICIPANT,
    scope: "payout:receive",
    reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
    status: "ACTIVE",
    imposedAt: NOW,
    imposedByAccountId: ACCOUNT,
    liftedAt: null,
    liftedByAccountId: null,
    liftedReasonCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

const restrictorSubject = (
  capabilities: AccountCapability[] = [PARTICIPANT_RESTRICT_CAPABILITY],
) => ({
  accountId: ACCOUNT,
  accountStatus: "ACTIVE" as const,
  capabilities,
});

// — 1 —

describe("0M.R1 · policy identity and immutable version identity are separate", () => {
  it("a version is keyed by policy identity plus its own label", () => {
    const v = versionRecord();
    expect(v.policyId).toBe(POLICY);
    expect(v.policyVersion).toBe("1");
  });

  it("refuses a version label with surrounding whitespace", () => {
    expect(() => versionRecord({ policyVersion: " 1 " })).toThrow();
  });

  it("refuses a policy id that is not a mon:cpol: identity", () => {
    for (const bad of [PARTICIPANT, ACCOUNT, "policy-1", ""]) {
      expect(() => versionRecord({ policyId: bad })).toThrow();
    }
  });

  it("records who recorded it as a durable Account id, never an email or name", () => {
    for (const bad of ["ops@example.invalid", "Ops Person", PARTICIPANT]) {
      expect(() => versionRecord({ recordedByAccountId: bad })).toThrow();
    }
  });
});

// — 2 —

describe("0M.R1 · version lifecycle and historical bindability", () => {
  it("is created DRAFT and at no other status", () => {
    expect(INITIAL_COMMERCIAL_POLICY_VERSION_STATUS).toBe("DRAFT");
    // The record input has no `status` parameter at all.
    expect(
      RecordCommercialPolicyVersionInput.safeParse({
        policyId: POLICY,
        policyVersion: "2",
        currency: "USD",
        retainedPercentageBasisPoints: 750,
        retainedFixedAmountMinorUnits: 100,
        roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
        effectiveFrom: NOW,
        recordedByAccountId: ACCOUNT,
        recordedAt: NOW,
        status: "ACTIVE",
      }).success,
    ).toBe(false);
  });

  it("permits DRAFT to ACTIVE and ACTIVE to RETIRED, and nothing returns", () => {
    expect(isValidCommercialPolicyVersionTransition("DRAFT", "ACTIVE")).toBe(true);
    expect(isValidCommercialPolicyVersionTransition("ACTIVE", "RETIRED")).toBe(true);
    expect(isValidCommercialPolicyVersionTransition("RETIRED", "ACTIVE")).toBe(false);
    expect(isValidCommercialPolicyVersionTransition("ACTIVE", "DRAFT")).toBe(false);
    expect(COMMERCIAL_POLICY_VERSION_TRANSITIONS.RETIRED).toEqual([]);
  });

  /**
   * The property historical reproduction depends on: a retired version is still
   * the answer for a transaction that ran under it.
   */
  it("a RETIRED version stays bindable; only DRAFT does not", () => {
    expect(isBindableCommercialPolicyVersion("ACTIVE")).toBe(true);
    expect(isBindableCommercialPolicyVersion("RETIRED")).toBe(true);
    expect(isBindableCommercialPolicyVersion("DRAFT")).toBe(false);
  });

  it("refuses to produce runnable economics from a DRAFT version", () => {
    expect(() => toWholesaleAcquisitionPolicy(versionRecord({ status: "DRAFT" }))).toThrow(
      /DRAFT/,
    );
  });
});

// — 3 —

describe("0M.R1 · persisted policy reconstructs the committed contract exactly", () => {
  it("maps onto MonacadoWholesaleAcquisitionPolicy field for field", () => {
    const policy = toWholesaleAcquisitionPolicy(versionRecord());
    expect(MonacadoWholesaleAcquisitionPolicy.parse(policy)).toEqual({
      policyId: POLICY,
      policyVersion: "1",
      currency: "USD",
      retainedPercentageBasisPoints: 750,
      retainedFixedAmountMinorUnits: 100,
      roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
    });
  });

  /** No storage field may leak into a calculation — the output is strict. */
  it("emits nothing beyond the committed contract's own fields", () => {
    const policy = toWholesaleAcquisitionPolicy(versionRecord());
    expect(Object.keys(policy).sort()).toEqual([
      "currency",
      "policyId",
      "policyVersion",
      "retainedFixedAmountMinorUnits",
      "retainedPercentageBasisPoints",
      "roundingPolicy",
    ]);
    for (const storageOnly of ["status", "effectiveFrom", "recordedByAccountId", "retiredAt"]) {
      expect(policy).not.toHaveProperty(storageOnly);
    }
  });

  /** MONACADO_MOR_BUSINESS_MODEL.md §B, worked example. */
  it("the current standard policy yields $8.50 retained and $91.50 acquired on $100", () => {
    const policy = toWholesaleAcquisitionPolicy(versionRecord());
    const retained = calculateMonacadoRetainedAmount({
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      policy,
    });
    expect(retained).toBe(850);

    const acquisition = calculateMorWholesaleAcquisition({
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      policy,
    });
    expect(acquisition.monacadoRetainedAmountMinorUnits).toBe(850);
    expect(acquisition.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
    expect(acquisition.policyId).toBe(POLICY);
    expect(acquisition.policyVersion).toBe("1");
  });

  /** The full promoted reconciliation, from a reconstructed policy. */
  it("promoted economics reconcile exactly to the commercial retail price", () => {
    const policy = toWholesaleAcquisitionPolicy(versionRecord());
    const e = calculatePromotedListingEconomics({
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      offerWholesalePriceMinorUnits: 5_000,
      offerWholesalePriceCurrency: "USD",
      sellerFundedCommissionMinorUnits: 1_000,
      policy,
    });
    expect(e.monacadoRetainedAmountMinorUnits).toBe(850);
    expect(e.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
    expect(e.sellerProceedsMinorUnits).toBe(4_000);
    expect(e.promoterNetProceedsMinorUnits).toBe(5_150);
    expect(
      e.sellerProceedsMinorUnits +
        e.promoterNetProceedsMinorUnits +
        e.monacadoRetainedAmountMinorUnits,
    ).toBe(10_000);
  });

  it("a different persisted version produces different economics from the same code", () => {
    const alternative = toWholesaleAcquisitionPolicy(
      versionRecord({
        policyVersion: "2",
        retainedPercentageBasisPoints: 1_000,
        retainedFixedAmountMinorUnits: 0,
      }),
    );
    expect(
      calculateMonacadoRetainedAmount({
        commercialRetailPriceMinorUnits: 10_000,
        currency: "USD",
        policy: alternative,
      }),
    ).toBe(1_000);
  });
});

// — 4 —

describe("0M.R1 · units, currency, and rounding are explicit and stored", () => {
  it("the percentage is basis points, bounded to 0..10000", () => {
    expect(versionRecord({ retainedPercentageBasisPoints: 0 }).retainedPercentageBasisPoints).toBe(0);
    expect(versionRecord({ retainedPercentageBasisPoints: 10_000 }).retainedPercentageBasisPoints).toBe(10_000);
    expect(() => versionRecord({ retainedPercentageBasisPoints: 10_001 })).toThrow();
    expect(() => versionRecord({ retainedPercentageBasisPoints: -1 })).toThrow();
    expect(() => versionRecord({ retainedPercentageBasisPoints: 7.5 })).toThrow();
  });

  it("the fixed amount is integer minor units — no floating-point money", () => {
    expect(versionRecord({ retainedFixedAmountMinorUnits: 100 }).retainedFixedAmountMinorUnits).toBe(100);
    expect(() => versionRecord({ retainedFixedAmountMinorUnits: 1.5 })).toThrow();
    expect(() => versionRecord({ retainedFixedAmountMinorUnits: -1 })).toThrow();
  });

  it("currency is explicit and checked, never coerced", () => {
    expect(versionRecord({ currency: "EUR" }).currency).toBe("EUR");
    expect(() => versionRecord({ currency: "usd" })).toThrow();
    expect(() => versionRecord({ currency: "DOLLARS" })).toThrow();
  });

  it("the rounding policy is carried on the version", () => {
    expect(versionRecord().roundingPolicy).toBe("HALF_UP_TO_MINOR_UNIT");
    expect(() => versionRecord({ roundingPolicy: "BANKERS" })).toThrow();
  });
});

// — 5 —

describe("0M.R1 · no derived economics and no 0M.R2 selection field is storable", () => {
  it("every NEVER_ON_COMMERCIAL_POLICY_VERSION key is refused by the record input", () => {
    for (const key of NEVER_ON_COMMERCIAL_POLICY_VERSION) {
      expect(
        RecordCommercialPolicyVersionInput.safeParse({
          policyId: POLICY,
          policyVersion: "3",
          currency: "USD",
          retainedPercentageBasisPoints: 750,
          retainedFixedAmountMinorUnits: 100,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: NOW,
          recordedByAccountId: ACCOUNT,
          recordedAt: NOW,
          [key]: 1,
        }).success,
        `${key} must be refused`,
      ).toBe(false);
    }
  });

  it("names the per-transaction selection fields 0M.R2 owns", () => {
    for (const deferred of [
      "participantId",
      "productClass",
      "riskScore",
      "riskClassification",
      "applicabilityRule",
      "overrideOf",
    ]) {
      expect(NEVER_ON_COMMERCIAL_POLICY_VERSION).toContain(deferred);
    }
  });

  it("names the derived amounts that must stay derived", () => {
    for (const derived of [
      "acquisitionPercentageBasisPoints",
      "retainedAmountMinorUnits",
      "acquisitionAmountMinorUnits",
      "taxMinorUnits",
      "shippingMinorUnits",
    ]) {
      expect(NEVER_ON_COMMERCIAL_POLICY_VERSION).toContain(derived);
    }
  });
});

// — 6 —

describe("0M.R1 · the standard policy is one version, not an invariant", () => {
  it("describes today's economics as data", () => {
    expect(MONACADO_STANDARD_POLICY_V1.retainedPercentageBasisPoints).toBe(750);
    expect(MONACADO_STANDARD_POLICY_V1.retainedFixedAmountMinorUnits).toBe(100);
    expect(MONACADO_STANDARD_POLICY_V1.currency).toBe("USD");
  });

  /** It cannot become a hard-coded policy reference: it carries no identity. */
  it("carries no policyId, so nothing can bind to it", () => {
    expect(MONACADO_STANDARD_POLICY_V1).not.toHaveProperty("policyId");
  });

  /**
   * `0M.4A` already asserts no rate is embedded in the Listing source module.
   * This extends the guarantee across everything 0M.R1 added.
   */
  it("no 0M.R1 module hard-codes the rate or the fixed amount", async () => {
    const { readFileSync } = await import("node:fs");
    const modules = [
      "../src/contracts/marketplace/participant-restriction.ts",
      "../src/server/marketplace/commercial-policy-service.ts",
      "../src/server/marketplace/commercial-policy-mapper.ts",
      "../src/server/marketplace/participant-restriction-service.ts",
    ];
    for (const relative of modules) {
      const source = readFileSync(new URL(relative, import.meta.url), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, `${relative} must embed no rate`).not.toMatch(/\b750\b/);
      expect(code, `${relative} must embed no fixed amount`).not.toMatch(/\b7\.5\b/);
    }
  });
});

// — 7 —

describe("0M.R1 · restriction scope reuses the committed capability vocabulary", () => {
  it("every restrictable scope is a real marketplace capability", () => {
    for (const scope of RESTRICTABLE_CAPABILITIES) {
      expect(MARKETPLACE_CAPABILITIES as readonly string[]).toContain(scope);
    }
  });

  it("covers exactly the commerce capabilities", () => {
    expect([...RESTRICTABLE_CAPABILITIES]).toEqual([
      "storefront:activate",
      "offer:publish",
      "payout:receive",
      "commission:accrue",
      "review:product:submit",
      "review:seller:submit",
    ]);
  });

  /**
   * 0M.1 puts RESTRICTED inside DRAFTING_PARTICIPANT_STATUSES on purpose: a
   * restriction withholds commerce, never the ability to correct the work that
   * caused it — or to answer the restriction itself.
   */
  it("drafting and activation:submit are never restrictable", () => {
    for (const never of [
      "storefront:draft:create",
      "product:draft:create",
      "listing:seller_direct:create",
      "listing:promoted:create",
      "activation:submit",
    ]) {
      expect(isRestrictableCapability(never), `${never} must not be restrictable`).toBe(false);
      expect(NEVER_RESTRICTABLE_CAPABILITIES).toContain(never);
    }
  });

  it("capsule-publication capabilities are never restrictable", () => {
    expect(isRestrictableCapability("review:product:capsule:publish")).toBe(false);
    expect(isRestrictableCapability("review:seller:capsule:publish")).toBe(false);
  });

  it("refuses an unknown scope, and invents no transaction-risk scope", () => {
    for (const unknown of [
      "TRANSACTION_CAP",
      "VELOCITY",
      "PAYOUT_HOLD",
      "everything",
      "*",
      "",
    ]) {
      expect(RestrictionScope.safeParse(unknown).success, `${unknown}`).toBe(false);
    }
  });

  it("every capability is classified restrictable or not, with none unaccounted for", () => {
    expect(RESTRICTABLE_CAPABILITIES.length + NEVER_RESTRICTABLE_CAPABILITIES.length).toBe(
      MARKETPLACE_CAPABILITIES.length,
    );
  });
});

// — 8 —

describe("0M.R1 · restriction reasons are bounded classifications", () => {
  it("is the smallest vocabulary the architecture justifies", () => {
    expect([...RESTRICTION_REASON_CODES]).toEqual([
      "UNDERWRITING_REVIEW_REQUIRED",
      "POLICY_ELIGIBILITY_RESTRICTION",
      "PROVIDER_REQUIREMENT_UNRESOLVED",
      "COMMERCIAL_ELIGIBILITY_RESTRICTION",
      "MANUAL_OPERATIONAL_RESTRICTION",
    ]);
  });

  it("carries no value — every code is a classification", () => {
    for (const code of RESTRICTION_REASON_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
    }
  });

  it("refuses free text as the controlling reason", () => {
    expect(
      ImposeParticipantRestrictionInput.safeParse({
        participantId: PARTICIPANT,
        scope: "payout:receive",
        reasonCode: "the passport scan was blurry",
        actingAccountId: ACCOUNT,
        imposedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it("every NEVER_ON_PARTICIPANT_RESTRICTION key is refused by both inputs", () => {
    for (const key of NEVER_ON_PARTICIPANT_RESTRICTION) {
      expect(
        ImposeParticipantRestrictionInput.safeParse({
          participantId: PARTICIPANT,
          scope: "payout:receive",
          reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
          actingAccountId: ACCOUNT,
          imposedAt: NOW,
          [key]: "synthetic",
        }).success,
        `impose must refuse ${key}`,
      ).toBe(false);

      expect(
        LiftParticipantRestrictionInput.safeParse({
          restrictionId: RESTRICTION,
          reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
          actingAccountId: ACCOUNT,
          liftedAt: NOW,
          [key]: "synthetic",
        }).success,
        `lift must refuse ${key}`,
      ).toBe(false);
    }
  });

  it("names the 0M.R2 fields it will not carry", () => {
    for (const deferred of [
      "riskScore",
      "riskClassification",
      "reserveAmountMinorUnits",
      "payoutHold",
      "transactionCapMinorUnits",
      "velocityWindowSeconds",
      "orderId",
      "paymentId",
      "expiresAt",
    ]) {
      expect(NEVER_ON_PARTICIPANT_RESTRICTION).toContain(deferred);
    }
  });
});

// — 9 —

describe("0M.R1 · restriction lifecycle preserves history", () => {
  it("has two states and no delete", () => {
    expect([...RESTRICTION_STATUSES]).toEqual(["ACTIVE", "LIFTED"]);
    expect(RESTRICTION_STATUSES as readonly string[]).not.toContain("DELETED");
  });

  it("a lifted restriction retains its imposition and its lift", () => {
    const lifted = restrictionRecord({
      status: "LIFTED",
      liftedAt: NOW,
      liftedByAccountId: ACCOUNT,
      liftedReasonCode: "POLICY_ELIGIBILITY_RESTRICTION",
    });
    expect(lifted.imposedAt).toBe(NOW);
    expect(lifted.imposedByAccountId).toBe(ACCOUNT);
    expect(lifted.liftedAt).toBe(NOW);
    expect(lifted.liftedByAccountId).toBe(ACCOUNT);
    expect(lifted.liftedReasonCode).toBe("POLICY_ELIGIBILITY_RESTRICTION");
  });

  it("carries no expiry — a self-lapsing restriction is nobody's decision here", () => {
    expect(restrictionRecord()).not.toHaveProperty("expiresAt");
    expect(NEVER_ON_PARTICIPANT_RESTRICTION).toContain("expiresAt");
  });

  it("records actors as durable Account ids, never emails or names", () => {
    for (const bad of ["ops@example.invalid", "Ops Person", PARTICIPANT]) {
      expect(() => restrictionRecord({ imposedByAccountId: bad })).toThrow();
    }
  });
});

// — 10 —

describe("0M.R1 · status reconciliation is deterministic and narrow", () => {
  it("an ACTIVE participant with a first restriction becomes RESTRICTED", () => {
    expect(
      reconcileParticipantStatusForRestrictions({
        currentStatus: "ACTIVE",
        activeRestrictionCount: 1,
      }),
    ).toBe("RESTRICTED");
  });

  it("a RESTRICTED participant with none left becomes ACTIVE", () => {
    expect(
      reconcileParticipantStatusForRestrictions({
        currentStatus: "RESTRICTED",
        activeRestrictionCount: 0,
      }),
    ).toBe("ACTIVE");
  });

  it("further restrictions change nothing — the status is already right", () => {
    for (const count of [2, 3, 6]) {
      expect(
        reconcileParticipantStatusForRestrictions({
          currentStatus: "RESTRICTED",
          activeRestrictionCount: count,
        }),
      ).toBeNull();
    }
  });

  /** Lifting one of several must not restore commerce. */
  it("a RESTRICTED participant with restrictions remaining stays RESTRICTED", () => {
    expect(
      reconcileParticipantStatusForRestrictions({
        currentStatus: "RESTRICTED",
        activeRestrictionCount: 1,
      }),
    ).toBeNull();
  });

  /**
   * Returning to ACTIVE is reachable only *from* RESTRICTED, which is reachable
   * only *from* ACTIVE — so the participant was already admitted through a
   * governed review, and no activation prerequisite is bypassed.
   */
  it("no non-activated status is ever moved to ACTIVE or RESTRICTED", () => {
    for (const status of PARTICIPANT_STATUSES) {
      if (status === "ACTIVE" || status === "RESTRICTED") continue;
      for (const count of [0, 1, 3]) {
        expect(
          reconcileParticipantStatusForRestrictions({
            currentStatus: status,
            activeRestrictionCount: count,
          }),
          `${status} with ${count}`,
        ).toBeNull();
      }
    }
  });

  it("SUSPENDED is never produced", () => {
    for (const status of PARTICIPANT_STATUSES) {
      for (const count of [0, 1, 2]) {
        expect(
          reconcileParticipantStatusForRestrictions({
            currentStatus: status,
            activeRestrictionCount: count,
          }),
        ).not.toBe("SUSPENDED");
      }
    }
  });

  it("RESTRICTED requires active evidence", () => {
    expect(restrictedStatusIsSupported(0)).toBe(false);
    expect(restrictedStatusIsSupported(1)).toBe(true);
  });
});

// — 11 —

describe("0M.R1 · restriction authority is its own internal capability", () => {
  it("participant:restrict is in the internal vocabulary, not the marketplace one", () => {
    expect(ACCOUNT_CAPABILITIES).toContain("participant:restrict");
    expect(MARKETPLACE_CAPABILITIES as readonly string[]).not.toContain("participant:restrict");
    expect(PARTICIPANT_RESTRICT_CAPABILITY).toBe("participant:restrict");
  });

  it("the two vocabularies still share no member", () => {
    const marketplace = new Set<string>(MARKETPLACE_CAPABILITIES);
    for (const internal of ACCOUNT_CAPABILITIES) {
      expect(marketplace.has(internal)).toBe(false);
    }
  });

  it("allows an active account holding participant:restrict", () => {
    const decision = canRestrictParticipant(restrictorSubject());
    expect(isInternallyAuthorized(decision)).toBe(true);
    expect(decision.capability).toBe("participant:restrict");
  });

  /** The two grants are independent in both directions. */
  it("activation:review alone does not authorize restriction", () => {
    const decision = canRestrictParticipant(restrictorSubject(["activation:review"]));
    expect(isInternallyAuthorized(decision)).toBe(false);
    expect(decision.reasonCodes).toEqual(["INTERNAL_CAPABILITY_NOT_GRANTED"]);
  });

  it("participant:restrict alone does not authorize activation review", () => {
    const decision = canReviewParticipantActivation(restrictorSubject());
    expect(isInternallyAuthorized(decision)).toBe(false);
    expect(decision.capability).toBe("activation:review");
  });

  it("refuses a disabled account, an unentitled account, and a null subject", () => {
    expect(
      canRestrictParticipant({ ...restrictorSubject(), accountStatus: "DISABLED" }).reasonCodes,
    ).toEqual(["INTERNAL_ACCOUNT_DISABLED"]);
    expect(canRestrictParticipant(restrictorSubject([])).reasonCodes).toEqual([
      "INTERNAL_CAPABILITY_NOT_GRANTED",
    ]);
    expect(canRestrictParticipant(null).reasonCodes).toEqual(["INTERNAL_ACCOUNT_REQUIRED"]);
  });

  it("no role or ownership can reach the decision", () => {
    for (const key of ["roles", "participantId", "ownsParticipant", "marketplaceRoles"]) {
      expect(() => canRestrictParticipant({ ...restrictorSubject(), [key]: true } as never)).toThrow();
    }
  });

  it("mints no wildcard or admin capability", () => {
    for (const forbidden of ["admin", "risk:*", "*", "participant:*", "risk:manage"]) {
      expect(AccountCapability.safeParse(forbidden).success, forbidden).toBe(false);
    }

    /* The exact count was asserted here until Phase 0M.9 added
       `participant:commerce-approve` — a fourth narrow grant, minted for exactly
       the reason this test guards: it was NOT folded into `activation:review` or
       `participant:restrict` merely because those are already internal.
       A count is a proxy that breaks on every legitimate addition while catching
       nothing on its own, so what it stood for is asserted directly instead:
       every member is narrowly scoped, and none is a wildcard or an `admin`. */
    for (const capability of ACCOUNT_CAPABILITIES) {
      expect(capability, capability).not.toContain("*");
      expect(capability.toLowerCase(), capability).not.toContain("admin");
      // `<domain>:<act>` — a scoped verb, never a bare grant of everything.
      expect(capability, capability).toMatch(/^[a-z][a-z-]*(:[a-z][a-z-]*)+$/);
    }
  });

  it("the input carries who is acting, never what they may do", () => {
    for (const key of ["isAuthorized", "riskApproved", "reviewerAuthorized", "capabilities"]) {
      expect(
        ImposeParticipantRestrictionInput.safeParse({
          participantId: PARTICIPANT,
          scope: "payout:receive",
          reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
          actingAccountId: ACCOUNT,
          imposedAt: NOW,
          [key]: true,
        }).success,
        `${key} must be refused`,
      ).toBe(false);
    }
  });
});
