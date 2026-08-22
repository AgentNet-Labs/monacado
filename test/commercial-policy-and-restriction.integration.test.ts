/**
 * Versioned commercial policy and participant restriction integration tests
 * (Phase 0M.R1).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Instants and identities are injected, so nothing here depends on a
 * real clock. Every value is synthetic; no real personal data appears.
 *
 * **Test isolation.** Every identifier this suite creates carries the `R1T`
 * opaque prefix and every account address the `0r1t-` local part, and every
 * delete is filtered by one of those. No `deleteMany({})` appears anywhere: a
 * broad delete would take another suite's participants and every Product,
 * Storefront, Offer, and Listing hanging off them.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  deleteParticipantPolicyRows,
  ensureShippedMarketplacePolicyActive,
  satisfyActivationPolicyPrerequisites,
} from "./support/marketplace-policy-fixture";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import {
  grantAccountEntitlement,
  revokeAccountEntitlement,
} from "../src/server/account/account-entitlement-service";
import {
  createDraftParticipant,
  advanceParticipantStatus,
  updateParticipantProfile,
  materializeMarketplaceSubject,
} from "../src/server/marketplace/participant-service";
import {
  registerParticipantPaymentAccount,
  recordObservedProviderState,
  getParticipantPaymentAccount,
} from "../src/server/marketplace/payment-account-service";
import {
  decideParticipantActivation,
  submitParticipantForActivation,
} from "../src/server/marketplace/activation-service";
import {
  activateCommercialPolicyVersion,
  createCommercialPolicy,
  getCommercialPolicyVersion,
  getEffectiveCommercialPolicyVersion,
  getEffectiveWholesaleAcquisitionPolicy,
  listCommercialPolicyVersions,
  recordCommercialPolicyVersion,
} from "../src/server/marketplace/commercial-policy-service";
import {
  getParticipantRestrictionHistory,
  hasActiveRestrictions,
  imposeParticipantRestriction,
  liftParticipantRestriction,
  listActiveParticipantRestrictions,
} from "../src/server/marketplace/participant-restriction-service";
import {
  AmbiguousActiveCommercialPolicyError,
  CommercialPolicyNotFoundError,
  CommercialPolicyVersionNotFoundError,
  DuplicateCommercialPolicyVersionError,
  InvalidCommercialPolicyVersionTransitionError,
  NoActiveCommercialPolicyError,
} from "../src/server/marketplace/commercial-policy-errors";
import {
  DuplicateActiveRestrictionError,
  InvalidRestrictionInputError,
  RestrictionActorNotAuthorizedError,
  RestrictionAlreadyLiftedError,
  RestrictionSelfActionNotPermittedError,
} from "../src/server/marketplace/participant-restriction-errors";
import { ParticipantNotFoundError, ActivationNotPermittedInPhaseError } from "../src/server/marketplace/participant-errors";
import { COMMERCIAL_POLICY_ID_PATTERN } from "../src/server/marketplace/commercial-policy-ids";
import { PARTICIPANT_ID_PATTERNS } from "../src/server/marketplace/participant-ids";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type { CommercialPolicyIdProvider } from "../src/server/marketplace/commercial-policy-ids";
import {
  MONACADO_STANDARD_POLICY_V1,
  toWholesaleAcquisitionPolicy,
} from "../src/contracts/marketplace/commercial-policy";
import {
  calculateMorWholesaleAcquisition,
  calculateSellerDirectEconomics,
} from "../src/contracts/marketplace/listing-source";
import { canReceivePayout } from "../src/contracts/marketplace/capability";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "R1T";
const EMAIL_PREFIX = "0r1t-";

const NOW = "2027-10-01T09:00:00.000Z";
const LATER = "2027-10-02T09:00:00.000Z";
const LATEST = "2027-10-03T09:00:00.000Z";
const PASSWORD = "correct-horse-battery-staple-0r1";

/** The internal operators, seeded per test with explicit entitlements. */
let RESTRICTOR = "";
let REVIEWER = "";
let POLICY_ACTOR = "";

let seq = 0;

function pad26(seed: string): string {
  const body = seed.toUpperCase().replace(/[ILOU]/g, "0");
  return (body + "0".repeat(26)).slice(0, 26);
}

function nextSuffix(): string {
  seq += 1;
  return pad26(`${TAG}${seq}`);
}

const participantIds: ParticipantIdProvider = {
  nextParticipantId: () => `mon:mpart:${nextSuffix()}`,
  nextRoleAssignmentId: () => `mon:mrole:${nextSuffix()}`,
  nextProfileId: () => `mon:mprof:${nextSuffix()}`,
  nextActivationId: () => `mon:mact:${nextSuffix()}`,
  nextPaymentAccountId: () => `mon:mpay:${nextSuffix()}`,
  nextRestrictionId: () => `mon:prst:${nextSuffix()}`,
  nextObligationId: () => `mon:nobl:${nextSuffix()}`,
};
const policyIds: CommercialPolicyIdProvider = {
  nextPolicyId: () => `mon:cpol:${nextSuffix()}`,
};

const deps = () => ({ db, ids: participantIds });
const policyDeps = () => ({ db, ids: policyIds });

/** Delete only what this suite created, child-to-parent. */
async function cleanup(): Promise<void> {
  const owned = { participantId: { startsWith: `mon:mpart:${TAG}` } };

  /* Phase 1.3 rows first. The acceptance key is RESTRICT — evidence does not
     vanish because a row above it did — so an acceptance left behind would block
     the participant delete below. */
  await deleteParticipantPolicyRows(db, `mon:mpart:${TAG}`);
  await db.participantRestriction.deleteMany({ where: owned });
  await db.participantPaymentRequirementRow.deleteMany({
    where: { paymentAccount: { is: owned } },
  });
  await db.participantPaymentAccount.deleteMany({ where: owned });
  await db.participantActivation.deleteMany({ where: owned });
  await db.participantProfile.deleteMany({ where: owned });
  await db.marketplaceRoleAssignment.deleteMany({ where: owned });
  await db.marketplaceParticipant.deleteMany({
    where: { id: { startsWith: `mon:mpart:${TAG}` } },
  });

  await db.commercialPolicyVersionRow.deleteMany({
    where: { policyId: { startsWith: `mon:cpol:${TAG}` } },
  });
  await db.commercialPolicy.deleteMany({ where: { id: { startsWith: `mon:cpol:${TAG}` } } });

  await db.accountSession.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.accountEntitlement.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.account.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function seedAccount(): Promise<string> {
  seq += 1;
  const account = await createAccount(
    {
      name: "Synthetic Person",
      email: `${EMAIL_PREFIX}${seq}@example.invalid`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  return account.accountId;
}

async function seedOperator(capability: string): Promise<string> {
  const accountId = await seedAccount();
  await grantAccountEntitlement({ accountId, capability, grantedAt: NOW }, { db });
  return accountId;
}

async function seedParticipant(roles: ("SELLER" | "PROMOTER" | "BUYER")[] = ["SELLER"]) {
  const accountId = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: roles, now: NOW },
    deps(),
  );
  return { accountId, participantId: snapshot.participant.participantId };
}

async function completeProfile(participantId: string): Promise<void> {
  await updateParticipantProfile(
    {
      participantId,
      markers: {
        identityComplete: true,
        businessStructureComplete: true,
        representativesComplete: true,
        commercialProfileComplete: true,
        riskComplete: true,
        payoutConfigurationComplete: true,
        documentsComplete: true,
      },
      gates: { emailVerifiedAt: NOW, termsAcceptedAt: NOW, termsVersion: "terms-2027-01" },
      now: NOW,
    },
    deps(),
  );
  await advanceParticipantStatus(participantId, "PROFILE_INCOMPLETE", deps());
  await advanceParticipantStatus(participantId, "PROFILE_COMPLETE", deps());
}

/** A fully admitted (ACTIVE) participant with an ENABLED provider account. */
async function seedActivatedParticipant() {
  const { accountId, participantId } = await seedParticipant(["SELLER"]);
  await completeProfile(participantId);

  const ref = `acct_${TAG.toLowerCase()}_${(seq += 1)}`;
  await registerParticipantPaymentAccount(
    { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
    deps(),
  );
  const base = { participantId, provider: "STRIPE" as const, providerAccountRef: ref };
  await recordObservedProviderState(
    { ...base, readiness: "DETAILS_REQUIRED", outstandingRequirements: [], observedAt: NOW },
    deps(),
  );
  await recordObservedProviderState(
    { ...base, readiness: "PENDING_PROVIDER", outstandingRequirements: [], observedAt: NOW },
    deps(),
  );
  await recordObservedProviderState(
    { ...base, readiness: "ENABLED", outstandingRequirements: [], observedAt: NOW },
    deps(),
  );

  /* Phase 1.3 added two activation prerequisites — accepted policy and a verified
     support contact. Satisfied here so the 0M.R1 assertions keep testing
     restriction and policy governance rather than incidentally failing on a
     requirement that arrived later. Phase 1.3's own suite covers the refusals. */
  await satisfyActivationPolicyPrerequisites(
    db,
    { participantId, accountId, roles: ["SELLER"], now: NOW },
  );
  await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());
  await decideParticipantActivation(
    {
      participantId,
      decision: "APPROVED",
      decisionReasonCode: "PREREQUISITES_SATISFIED",
      reviewerAccountId: REVIEWER,
      decidedAt: NOW,
    },
    deps(),
  );
  return { accountId, participantId, ref };
}

/** A policy with one ACTIVE version carrying today's standard economics. */
async function seedStandardPolicy() {
  const policy = await createCommercialPolicy({ label: "Monacado standard", now: NOW }, policyDeps());
  await recordCommercialPolicyVersion(
    {
      policyId: policy.policyId,
      ...MONACADO_STANDARD_POLICY_V1,
      effectiveFrom: NOW,
      recordedByAccountId: POLICY_ACTOR,
      recordedAt: NOW,
    },
    policyDeps(),
  );
  await activateCommercialPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: MONACADO_STANDARD_POLICY_V1.policyVersion,
      activatedByAccountId: POLICY_ACTOR,
      activatedAt: NOW,
    },
    policyDeps(),
  );
  return policy.policyId;
}

const restrict = (participantId: string, overrides: Record<string, unknown> = {}) =>
  imposeParticipantRestriction(
    {
      participantId,
      scope: "payout:receive",
      reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
      actingAccountId: RESTRICTOR,
      imposedAt: LATER,
      ...overrides,
    },
    deps(),
  );

const describeDb = RUN ? describe : describe.skip;

describeDb("Phase 0M.R1 — versioned commercial policy and activation risk records", () => {
  beforeEach(async () => {
    await cleanup();
    RESTRICTOR = await seedOperator("participant:restrict");
    REVIEWER = await seedOperator("activation:review");
    POLICY_ACTOR = await seedOperator("participant:restrict");
    await ensureShippedMarketplacePolicyActive(db, {
      recordedByAccountId: REVIEWER,
      now: NOW,
    });
  });
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — 1. Policy identity and versioning —

  describe("1. commercial policy identity and immutable versions", () => {
    it("creates a stable policy identity with no economics of its own", async () => {
      const policy = await createCommercialPolicy(
        { label: "Monacado standard", now: NOW },
        policyDeps(),
      );
      expect(policy.policyId).toMatch(COMMERCIAL_POLICY_ID_PATTERN);
      expect(policy.label).toBe("Monacado standard");
      expect(policy).not.toHaveProperty("retainedPercentageBasisPoints");
    });

    it("records a version as DRAFT, and an exact lookup returns it", async () => {
      const policyId = await seedStandardPolicy();
      const v = await getCommercialPolicyVersion(policyId, "1", policyDeps());
      expect(v.policyVersion).toBe("1");
      expect(v.retainedPercentageBasisPoints).toBe(750);
      expect(v.retainedFixedAmountMinorUnits).toBe(100);
      expect(v.currency).toBe("USD");
      expect(v.roundingPolicy).toBe("HALF_UP_TO_MINOR_UNIT");
    });

    it("refuses a duplicate version label on the same policy", async () => {
      const policyId = await seedStandardPolicy();
      await expect(
        recordCommercialPolicyVersion(
          {
            policyId,
            ...MONACADO_STANDARD_POLICY_V1,
            effectiveFrom: LATER,
            recordedByAccountId: POLICY_ACTOR,
            recordedAt: LATER,
          },
          policyDeps(),
        ),
      ).rejects.toBeInstanceOf(DuplicateCommercialPolicyVersionError);
    });

    it("refuses a version for a policy that does not exist", async () => {
      await expect(
        recordCommercialPolicyVersion(
          {
            policyId: `mon:cpol:${pad26(`${TAG}GHOST`)}`,
            ...MONACADO_STANDARD_POLICY_V1,
            effectiveFrom: NOW,
            recordedByAccountId: POLICY_ACTOR,
            recordedAt: NOW,
          },
          policyDeps(),
        ),
      ).rejects.toBeInstanceOf(CommercialPolicyNotFoundError);
    });

    it("refuses an exact lookup for an unknown version", async () => {
      const policyId = await seedStandardPolicy();
      await expect(
        getCommercialPolicyVersion(policyId, "99", policyDeps()),
      ).rejects.toBeInstanceOf(CommercialPolicyVersionNotFoundError);
    });
  });

  // — 2. Effective policy —

  describe("2. effective policy lookup is unambiguous", () => {
    it("returns the single active version", async () => {
      const policyId = await seedStandardPolicy();
      const effective = await getEffectiveCommercialPolicyVersion(policyId, policyDeps());
      expect(effective.policyVersion).toBe("1");
      expect(effective.status).toBe("ACTIVE");
    });

    /** No fallback rate. A policy with only a draft has no effective economics. */
    it("refuses when no version is active, rather than defaulting", async () => {
      const policy = await createCommercialPolicy({ label: "Draft only", now: NOW }, policyDeps());
      await recordCommercialPolicyVersion(
        {
          policyId: policy.policyId,
          ...MONACADO_STANDARD_POLICY_V1,
          effectiveFrom: NOW,
          recordedByAccountId: POLICY_ACTOR,
          recordedAt: NOW,
        },
        policyDeps(),
      );
      await expect(
        getEffectiveCommercialPolicyVersion(policy.policyId, policyDeps()),
      ).rejects.toBeInstanceOf(NoActiveCommercialPolicyError);
    });

    it("refuses an effective lookup for an unknown policy", async () => {
      await expect(
        getEffectiveCommercialPolicyVersion(`mon:cpol:${pad26(`${TAG}NONE`)}`, policyDeps()),
      ).rejects.toBeInstanceOf(CommercialPolicyNotFoundError);
    });

    /**
     * The overlap the unique marker exists to prevent. Written directly, because
     * the service cannot produce it.
     */
    it("two active versions are refused rather than arbitrarily resolved", async () => {
      const policyId = await seedStandardPolicy();
      await expect(
        db.commercialPolicyVersionRow.create({
          data: {
            policyId,
            policyVersion: "2",
            status: "ACTIVE",
            currency: "USD",
            retainedPercentageBasisPoints: 500,
            retainedFixedAmountMinorUnits: 0n,
            roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
            effectiveFrom: new Date(LATER),
            recordedByAccountId: POLICY_ACTOR,
            recordedAt: new Date(LATER),
            activeForPolicyId: policyId,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      // Force the ambiguity past the index to prove the read fails closed.
      await db.commercialPolicyVersionRow.create({
        data: {
          policyId,
          policyVersion: "2",
          status: "ACTIVE",
          currency: "USD",
          retainedPercentageBasisPoints: 500,
          retainedFixedAmountMinorUnits: 0n,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: new Date(LATER),
          recordedByAccountId: POLICY_ACTOR,
          recordedAt: new Date(LATER),
          activeForPolicyId: null,
        },
      });
      await expect(
        getEffectiveCommercialPolicyVersion(policyId, policyDeps()),
      ).rejects.toBeInstanceOf(AmbiguousActiveCommercialPolicyError);
    });

    it("refuses activating a retired version", async () => {
      const policyId = await seedStandardPolicy();
      await recordCommercialPolicyVersion(
        {
          policyId,
          policyVersion: "2",
          currency: "USD",
          retainedPercentageBasisPoints: 500,
          retainedFixedAmountMinorUnits: 0,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: LATER,
          recordedByAccountId: POLICY_ACTOR,
          recordedAt: LATER,
        },
        policyDeps(),
      );
      await activateCommercialPolicyVersion(
        { policyId, policyVersion: "2", activatedByAccountId: POLICY_ACTOR, activatedAt: LATER },
        policyDeps(),
      );
      // "1" is now RETIRED and may not come back.
      await expect(
        activateCommercialPolicyVersion(
          { policyId, policyVersion: "1", activatedByAccountId: POLICY_ACTOR, activatedAt: LATEST },
          policyDeps(),
        ),
      ).rejects.toBeInstanceOf(InvalidCommercialPolicyVersionTransitionError);
    });
  });

  // — 3. Supersession preserves history —

  describe("3. superseding a version never rewrites history", () => {
    it("retires the incumbent and leaves its economics untouched", async () => {
      const policyId = await seedStandardPolicy();
      const before = await getCommercialPolicyVersion(policyId, "1", policyDeps());

      await recordCommercialPolicyVersion(
        {
          policyId,
          policyVersion: "2",
          currency: "USD",
          retainedPercentageBasisPoints: 1_000,
          retainedFixedAmountMinorUnits: 0,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: LATER,
          recordedByAccountId: POLICY_ACTOR,
          recordedAt: LATER,
        },
        policyDeps(),
      );
      await activateCommercialPolicyVersion(
        { policyId, policyVersion: "2", activatedByAccountId: POLICY_ACTOR, activatedAt: LATER },
        policyDeps(),
      );

      const after = await getCommercialPolicyVersion(policyId, "1", policyDeps());
      expect(after.status).toBe("RETIRED");
      expect(after.retiredAt).toBe(LATER);
      expect(after.retiredByAccountId).toBe(POLICY_ACTOR);
      // The numbers a past transaction ran under are byte-identical.
      expect(after.retainedPercentageBasisPoints).toBe(before.retainedPercentageBasisPoints);
      expect(after.retainedFixedAmountMinorUnits).toBe(before.retainedFixedAmountMinorUnits);
      expect(after.currency).toBe(before.currency);
      expect(after.effectiveFrom).toBe(before.effectiveFrom);

      const effective = await getEffectiveCommercialPolicyVersion(policyId, policyDeps());
      expect(effective.policyVersion).toBe("2");
    });

    /** The exact-version lookup a historical transaction uses is unaffected. */
    it("a retired version still reconstructs and still calculates", async () => {
      const policyId = await seedStandardPolicy();
      await recordCommercialPolicyVersion(
        {
          policyId,
          policyVersion: "2",
          currency: "USD",
          retainedPercentageBasisPoints: 1_000,
          retainedFixedAmountMinorUnits: 0,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: LATER,
          recordedByAccountId: POLICY_ACTOR,
          recordedAt: LATER,
        },
        policyDeps(),
      );
      await activateCommercialPolicyVersion(
        { policyId, policyVersion: "2", activatedByAccountId: POLICY_ACTOR, activatedAt: LATER },
        policyDeps(),
      );

      const historical = toWholesaleAcquisitionPolicy(
        await getCommercialPolicyVersion(policyId, "1", policyDeps()),
      );
      const result = calculateMorWholesaleAcquisition({
        commercialRetailPriceMinorUnits: 10_000,
        currency: "USD",
        policy: historical,
      });
      expect(result.monacadoRetainedAmountMinorUnits).toBe(850);
      expect(result.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
      expect(result.policyVersion).toBe("1");

      // Meanwhile the current version prices differently, from the same code.
      const current = await getEffectiveWholesaleAcquisitionPolicy(policyId, policyDeps());
      const now = calculateMorWholesaleAcquisition({
        commercialRetailPriceMinorUnits: 10_000,
        currency: "USD",
        policy: current,
      });
      expect(now.monacadoRetainedAmountMinorUnits).toBe(1_000);
      expect(now.policyVersion).toBe("2");
    });

    it("lists every version, and history survives", async () => {
      const policyId = await seedStandardPolicy();
      await recordCommercialPolicyVersion(
        {
          policyId,
          policyVersion: "2",
          currency: "USD",
          retainedPercentageBasisPoints: 500,
          retainedFixedAmountMinorUnits: 0,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: LATER,
          recordedByAccountId: POLICY_ACTOR,
          recordedAt: LATER,
        },
        policyDeps(),
      );
      const versions = await listCommercialPolicyVersions(policyId, policyDeps());
      expect(versions.map((v) => v.policyVersion).sort()).toEqual(["1", "2"]);
    });

    /** There is no update path for economics — the service exposes none. */
    it("no service operation can edit a recorded version's economics", async () => {
      const serviceModule = await import("../src/server/marketplace/commercial-policy-service");
      const exported = Object.keys(serviceModule);
      for (const forbidden of ["updateCommercialPolicyVersion", "editPolicyEconomics", "setRate"]) {
        expect(exported).not.toContain(forbidden);
      }
      expect(exported.sort()).toEqual([
        "activateCommercialPolicyVersion",
        "createCommercialPolicy",
        "getCommercialPolicyVersion",
        "getEffectiveCommercialPolicyVersion",
        "getEffectiveWholesaleAcquisitionPolicy",
        "listCommercialPolicyVersions",
        "recordCommercialPolicyVersion",
      ]);
    });
  });

  // — 4. Cross-system invariants —

  describe("4. policy persistence changes nothing that already exists", () => {
    /* Narrowed at Phase 0M.N1 (`NotificationObligation`), again at 0M.T1
       (`TransactionSettlement`), and again at 0M.9 (`Order`) — each a table a
       later phase legitimately owns and this one deliberately deferred to it
       (§13). The claim this makes is that *0M.R1* created none of these, and
       every remaining member still holds: there is still no charge, payout,
       refund, chargeback, ledger, tax, reserve, velocity, or risk-score table
       anywhere. */
    it("creates no transaction, payout, or tax table", async () => {
      await seedStandardPolicy();
      const tables = await db.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
      );
      const names = tables.map((t) => t.TABLE_NAME.toLowerCase());
      for (const forbidden of [
        "charge",
        "paymentintent",
        "payout",
        "refund",
        "chargeback",
        "ledger",
        "taxclass",
        "taxtransaction",
        "reserve",
        "velocity",
        "riskscore",
      ]) {
        expect(names.some((n) => n.includes(forbidden)), `${forbidden}`).toBe(false);
      }
    });

    it("stores no derived economics column on a policy version", async () => {
      const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'CommercialPolicyVersionRow'`,
      );
      const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());
      for (const derived of [
        "acquisitionpercentage",
        "acquisitionamount",
        "retainedamount",
        "commercialretail",
        "sellerproceeds",
        "promoter",
        "tax",
        "shipping",
        "participantid",
        "riskscore",
      ]) {
        expect(names.some((n) => n.includes(derived)), `${derived}`).toBe(false);
      }
      expect(names).toContain("retainedpercentagebasispoints");
      expect(names).toContain("retainedfixedamountminorunits");
    });

    /** Listing and Offer source records are untouched by policy persistence. */
    it("changing the active policy rewrites no Listing or Offer source row", async () => {
      const policyId = await seedStandardPolicy();
      const listingsBefore = await db.listingSourceRecordVersionRow.count();
      const offersBefore = await db.offerSourceRecordVersionRow.count();

      await recordCommercialPolicyVersion(
        {
          policyId,
          policyVersion: "2",
          currency: "USD",
          retainedPercentageBasisPoints: 2_000,
          retainedFixedAmountMinorUnits: 0,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: LATER,
          recordedByAccountId: POLICY_ACTOR,
          recordedAt: LATER,
        },
        policyDeps(),
      );
      await activateCommercialPolicyVersion(
        { policyId, policyVersion: "2", activatedByAccountId: POLICY_ACTOR, activatedAt: LATER },
        policyDeps(),
      );

      expect(await db.listingSourceRecordVersionRow.count()).toBe(listingsBefore);
      expect(await db.offerSourceRecordVersionRow.count()).toBe(offersBefore);
    });

    it("the policy FK to its versions is RESTRICT", async () => {
      const rules = await db.$queryRawUnsafe<Array<{ DELETE_RULE: string }>>(
        `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'CommercialPolicyVersionRow'`,
      );
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) expect(r.DELETE_RULE).toBe("RESTRICT");
    });

    it("deleting a policy that holds versions is refused", async () => {
      const policyId = await seedStandardPolicy();
      await expect(db.commercialPolicy.delete({ where: { id: policyId } })).rejects.toMatchObject({
        code: "P2003",
      });
    });

    /** A seller-direct calculation runs identically from a persisted policy. */
    it("seller-direct economics reconstruct from storage identically", async () => {
      const policyId = await seedStandardPolicy();
      const policy = await getEffectiveWholesaleAcquisitionPolicy(policyId, policyDeps());
      const e = calculateSellerDirectEconomics({
        placement: {
          listingType: "SELLER_DIRECT",
          retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
          sale: null,
        },
        now: NOW,
        policy,
      });
      expect(e.monacadoRetainedAmountMinorUnits).toBe(850);
      expect(e.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
      expect(e.sellerProceedsMinorUnits).toBe(9_150);
      expect(e.policyId).toBe(policyId);
      expect(e.policyVersion).toBe("1");
    });
  });

  // — 5. Restriction basics —

  describe("5. imposing a governed restriction", () => {
    it("imposes on a persisted participant and records the evidence", async () => {
      const { participantId } = await seedActivatedParticipant();
      const snapshot = await restrict(participantId);

      expect(snapshot.restriction.restrictionId).toMatch(PARTICIPANT_ID_PATTERNS.restriction);
      expect(snapshot.restriction.participantId).toBe(participantId);
      expect(snapshot.restriction.scope).toBe("payout:receive");
      expect(snapshot.restriction.reasonCode).toBe("UNDERWRITING_REVIEW_REQUIRED");
      expect(snapshot.restriction.status).toBe("ACTIVE");
      expect(snapshot.restriction.imposedAt).toBe(LATER);
      expect(snapshot.restriction.imposedByAccountId).toBe(RESTRICTOR);
      expect(snapshot.activeRestrictionCount).toBe(1);
    });

    it("refuses a missing participant", async () => {
      await expect(
        restrict(`mon:mpart:${pad26(`${TAG}GHOSTPART`)}`),
      ).rejects.toBeInstanceOf(ParticipantNotFoundError);
    });

    it("refuses an unknown scope and an unknown reason code", async () => {
      const { participantId } = await seedActivatedParticipant();
      await expect(restrict(participantId, { scope: "TRANSACTION_CAP" })).rejects.toBeInstanceOf(
        InvalidRestrictionInputError,
      );
      await expect(
        restrict(participantId, { reasonCode: "they seemed shifty" }),
      ).rejects.toBeInstanceOf(InvalidRestrictionInputError);
    });

    it("refuses restricting a drafting capability", async () => {
      const { participantId } = await seedActivatedParticipant();
      for (const scope of ["product:draft:create", "activation:submit"]) {
        await expect(restrict(participantId, { scope })).rejects.toBeInstanceOf(
          InvalidRestrictionInputError,
        );
      }
    });

    it("refuses a second active restriction on the same scope", async () => {
      const { participantId } = await seedActivatedParticipant();
      await restrict(participantId);
      await expect(restrict(participantId)).rejects.toBeInstanceOf(DuplicateActiveRestrictionError);
    });

    it("permits distinct scopes to be restricted independently", async () => {
      const { participantId } = await seedActivatedParticipant();
      await restrict(participantId, { scope: "payout:receive" });
      const second = await restrict(participantId, { scope: "offer:publish" });
      expect(second.activeRestrictionCount).toBe(2);

      const active = await listActiveParticipantRestrictions(participantId, deps());
      expect(active.map((r) => r.scope).sort()).toEqual(["offer:publish", "payout:receive"]);
    });

    it("refuses private provider or underwriting data on the input", async () => {
      const { participantId } = await seedActivatedParticipant();
      await expect(
        restrict(participantId, { kycPayload: { legalName: "Synthetic Person" } }),
      ).rejects.toBeInstanceOf(InvalidRestrictionInputError);
    });
  });

  // — 6. RESTRICTED status semantics —

  describe("6. RESTRICTED has evidence, always", () => {
    it("the first restriction moves an ACTIVE participant to RESTRICTED", async () => {
      const { participantId } = await seedActivatedParticipant();
      const before = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(before?.status).toBe("ACTIVE");

      const snapshot = await restrict(participantId);
      expect(snapshot.participantStatus).toBe("RESTRICTED");
    });

    /** The 0M.8 gate is untouched: nothing else may write the status. */
    it("the draft path still refuses RESTRICTED outright", async () => {
      const { participantId } = await seedActivatedParticipant();
      await expect(
        advanceParticipantStatus(participantId, "RESTRICTED", deps()),
      ).rejects.toBeInstanceOf(ActivationNotPermittedInPhaseError);
    });

    it("no participant is RESTRICTED without an active restriction", async () => {
      const { participantId } = await seedActivatedParticipant();
      await restrict(participantId);

      const restricted = await db.marketplaceParticipant.findMany({
        where: { id: { startsWith: `mon:mpart:${TAG}` }, status: "RESTRICTED" },
      });
      for (const p of restricted) {
        expect(await hasActiveRestrictions(p.id, deps())).toBe(true);
      }
      expect(restricted.length).toBeGreaterThan(0);
    });

    it("a non-activated participant receives evidence but no status change", async () => {
      const { participantId } = await seedParticipant();
      const snapshot = await restrict(participantId);

      expect(snapshot.restriction.status).toBe("ACTIVE");
      expect(snapshot.participantStatus).toBe("DRAFT");
      expect(snapshot.participantStatus).not.toBe("RESTRICTED");
    });

    it("restriction denies payout capability through the existing decision", async () => {
      const { accountId, participantId } = await seedActivatedParticipant();
      expect(canReceivePayout(await materializeMarketplaceSubject(accountId, deps())).decision).toBe(
        "ALLOW",
      );

      await restrict(participantId);
      const after = await materializeMarketplaceSubject(accountId, deps());
      expect(after.participant?.status).toBe("RESTRICTED");
      expect(canReceivePayout(after).decision).toBe("DENY");
    });
  });

  // — 7. Lifting and history —

  describe("7. lifting preserves history and reconciles deterministically", () => {
    it("lifting one of two leaves the participant RESTRICTED", async () => {
      const { participantId } = await seedActivatedParticipant();
      const first = await restrict(participantId, { scope: "payout:receive" });
      await restrict(participantId, { scope: "offer:publish" });

      const snapshot = await liftParticipantRestriction(
        {
          restrictionId: first.restriction.restrictionId,
          reasonCode: "POLICY_ELIGIBILITY_RESTRICTION",
          actingAccountId: RESTRICTOR,
          liftedAt: LATEST,
        },
        deps(),
      );

      expect(snapshot.activeRestrictionCount).toBe(1);
      expect(snapshot.participantStatus).toBe("RESTRICTED");
    });

    it("lifting the last one restores ACTIVE", async () => {
      const { participantId } = await seedActivatedParticipant();
      const only = await restrict(participantId);

      const snapshot = await liftParticipantRestriction(
        {
          restrictionId: only.restriction.restrictionId,
          reasonCode: "POLICY_ELIGIBILITY_RESTRICTION",
          actingAccountId: RESTRICTOR,
          liftedAt: LATEST,
        },
        deps(),
      );

      expect(snapshot.activeRestrictionCount).toBe(0);
      expect(snapshot.participantStatus).toBe("ACTIVE");
    });

    /**
     * The restoration is only reachable from RESTRICTED, which is only reachable
     * from ACTIVE — so no activation prerequisite is bypassed.
     */
    it("lifting the last restriction on a never-activated participant grants nothing", async () => {
      const { participantId } = await seedParticipant();
      const only = await restrict(participantId);

      const snapshot = await liftParticipantRestriction(
        {
          restrictionId: only.restriction.restrictionId,
          reasonCode: "POLICY_ELIGIBILITY_RESTRICTION",
          actingAccountId: RESTRICTOR,
          liftedAt: LATEST,
        },
        deps(),
      );

      expect(snapshot.participantStatus).toBe("DRAFT");
      expect(snapshot.participantStatus).not.toBe("ACTIVE");
    });

    it("a lifted restriction remains in history with its actor and reason", async () => {
      const { participantId } = await seedActivatedParticipant();
      const only = await restrict(participantId);
      await liftParticipantRestriction(
        {
          restrictionId: only.restriction.restrictionId,
          reasonCode: "COMMERCIAL_ELIGIBILITY_RESTRICTION",
          actingAccountId: RESTRICTOR,
          liftedAt: LATEST,
        },
        deps(),
      );

      const history = await getParticipantRestrictionHistory(participantId, deps());
      expect(history).toHaveLength(1);
      expect(history[0]!.status).toBe("LIFTED");
      expect(history[0]!.liftedAt).toBe(LATEST);
      expect(history[0]!.liftedByAccountId).toBe(RESTRICTOR);
      expect(history[0]!.liftedReasonCode).toBe("COMMERCIAL_ELIGIBILITY_RESTRICTION");
      // The imposition survives intact.
      expect(history[0]!.imposedAt).toBe(LATER);
      expect(history[0]!.imposedByAccountId).toBe(RESTRICTOR);
    });

    it("re-imposing after a lift is a second row, and the first survives", async () => {
      const { participantId } = await seedActivatedParticipant();
      const first = await restrict(participantId);
      await liftParticipantRestriction(
        {
          restrictionId: first.restriction.restrictionId,
          reasonCode: "POLICY_ELIGIBILITY_RESTRICTION",
          actingAccountId: RESTRICTOR,
          liftedAt: LATEST,
        },
        deps(),
      );
      await restrict(participantId, { imposedAt: LATEST });

      const history = await getParticipantRestrictionHistory(participantId, deps());
      expect(history).toHaveLength(2);
      expect(history.filter((r) => r.status === "LIFTED")).toHaveLength(1);
      expect(history.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    });

    it("a lifted restriction cannot be lifted twice", async () => {
      const { participantId } = await seedActivatedParticipant();
      const only = await restrict(participantId);
      const lift = {
        restrictionId: only.restriction.restrictionId,
        reasonCode: "POLICY_ELIGIBILITY_RESTRICTION" as const,
        actingAccountId: RESTRICTOR,
        liftedAt: LATEST,
      };
      await liftParticipantRestriction(lift, deps());
      await expect(liftParticipantRestriction(lift, deps())).rejects.toBeInstanceOf(
        RestrictionAlreadyLiftedError,
      );
    });

    it("nothing deletes a restriction", async () => {
      const { participantId } = await seedActivatedParticipant();
      await restrict(participantId);
      const serviceModule = await import(
        "../src/server/marketplace/participant-restriction-service"
      );
      for (const forbidden of ["deleteRestriction", "removeRestriction", "purgeRestrictions"]) {
        expect(Object.keys(serviceModule)).not.toContain(forbidden);
      }
      expect(await db.participantRestriction.count({ where: { participantId } })).toBe(1);
    });
  });

  // — 8. Authority —

  describe("8. restriction authority is the persisted internal capability", () => {
    it("refuses an account holding no participant:restrict", async () => {
      const { participantId } = await seedActivatedParticipant();
      const unentitled = await seedAccount();
      await expect(
        restrict(participantId, { actingAccountId: unentitled }),
      ).rejects.toMatchObject({
        name: "RestrictionActorNotAuthorizedError",
        requiredCapability: "participant:restrict",
        reasonCodes: ["INTERNAL_CAPABILITY_NOT_GRANTED"],
      });
    });

    /** The two internal grants are independent. */
    it("activation:review alone does not authorize restriction", async () => {
      const { participantId } = await seedActivatedParticipant();
      await expect(
        restrict(participantId, { actingAccountId: REVIEWER }),
      ).rejects.toBeInstanceOf(RestrictionActorNotAuthorizedError);
    });

    it("a revoked entitlement stops the very next restriction", async () => {
      const { participantId } = await seedActivatedParticipant();
      await revokeAccountEntitlement(
        { accountId: RESTRICTOR, capability: "participant:restrict", revokedAt: LATER },
        { db },
      );
      await expect(restrict(participantId)).rejects.toBeInstanceOf(
        RestrictionActorNotAuthorizedError,
      );
    });

    it("no marketplace role confers restriction authority", async () => {
      const { participantId } = await seedActivatedParticipant();
      for (const roles of [["SELLER"], ["PROMOTER"], ["SELLER", "PROMOTER", "BUYER"]] as const) {
        const holder = await seedParticipant([...roles]);
        await expect(
          restrict(participantId, { actingAccountId: holder.accountId }),
        ).rejects.toBeInstanceOf(RestrictionActorNotAuthorizedError);
      }
    });

    /** Authorization precedes any target read — existence stays undisclosed. */
    it("an unauthorized caller learns nothing about the target", async () => {
      const unentitled = await seedAccount();
      await expect(
        restrict(`mon:mpart:${pad26(`${TAG}NOSUCH`)}`, { actingAccountId: unentitled }),
      ).rejects.toBeInstanceOf(RestrictionActorNotAuthorizedError);
    });

    it("authorization is required to lift as well as to impose", async () => {
      const { participantId } = await seedActivatedParticipant();
      const only = await restrict(participantId);
      const unentitled = await seedAccount();
      await expect(
        liftParticipantRestriction(
          {
            restrictionId: only.restriction.restrictionId,
            reasonCode: "POLICY_ELIGIBILITY_RESTRICTION",
            actingAccountId: unentitled,
            liftedAt: LATEST,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(RestrictionActorNotAuthorizedError);
    });
  });

  // — 9. Separation of duties —

  describe("9. no self-restriction", () => {
    it("an entitled actor may not restrict their own participant", async () => {
      const { accountId, participantId } = await seedActivatedParticipant();
      await grantAccountEntitlement(
        { accountId, capability: "participant:restrict", grantedAt: NOW },
        { db },
      );

      await expect(
        restrict(participantId, { actingAccountId: accountId }),
      ).rejects.toBeInstanceOf(RestrictionSelfActionNotPermittedError);

      expect(await db.participantRestriction.count({ where: { participantId } })).toBe(0);
      const row = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(row?.status).toBe("ACTIVE");
    });

    /** The sharper half: an operator must not restore their own commerce. */
    it("an entitled actor may not lift their own participant's restriction", async () => {
      const { accountId, participantId } = await seedActivatedParticipant();
      const only = await restrict(participantId);
      await grantAccountEntitlement(
        { accountId, capability: "participant:restrict", grantedAt: NOW },
        { db },
      );

      await expect(
        liftParticipantRestriction(
          {
            restrictionId: only.restriction.restrictionId,
            reasonCode: "POLICY_ELIGIBILITY_RESTRICTION",
            actingAccountId: accountId,
            liftedAt: LATEST,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(RestrictionSelfActionNotPermittedError);

      const history = await getParticipantRestrictionHistory(participantId, deps());
      expect(history[0]!.status).toBe("ACTIVE");
      expect(history[0]!.liftedAt).toBeNull();
    });

    it("ownership alone still confers nothing", async () => {
      const { accountId, participantId } = await seedActivatedParticipant();
      // No entitlement at all: the authorization refusal comes first.
      await expect(
        restrict(participantId, { actingAccountId: accountId }),
      ).rejects.toBeInstanceOf(RestrictionActorNotAuthorizedError);
    });
  });

  // — 10. Provider separation —

  describe("10. provider state and restriction are separate authorities", () => {
    it("provider DISABLED creates no restriction", async () => {
      const { participantId, ref } = await seedActivatedParticipant();
      await recordObservedProviderState(
        {
          participantId,
          provider: "STRIPE",
          providerAccountRef: ref,
          readiness: "DISABLED",
          outstandingRequirements: [],
          observedAt: LATER,
        },
        deps(),
      );

      expect(await db.participantRestriction.count({ where: { participantId } })).toBe(0);
      expect(await hasActiveRestrictions(participantId, deps())).toBe(false);
      const row = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(row?.status).toBe("ACTIVE");
    });

    it("provider DETAILS_REQUIRED creates no restriction", async () => {
      const { participantId, ref } = await seedActivatedParticipant();
      await recordObservedProviderState(
        {
          participantId,
          provider: "STRIPE",
          providerAccountRef: ref,
          readiness: "DETAILS_REQUIRED",
          outstandingRequirements: ["IDENTITY_DETAILS_REQUIRED"],
          observedAt: LATER,
        },
        deps(),
      );
      expect(await db.participantRestriction.count({ where: { participantId } })).toBe(0);
    });

    /** ...and the converse: a restriction never touches provider state. */
    it("imposing and lifting a restriction mutates no provider readiness", async () => {
      const { participantId, ref } = await seedActivatedParticipant();
      const before = await getParticipantPaymentAccount(participantId, "STRIPE", deps());

      const only = await restrict(participantId);
      const during = await getParticipantPaymentAccount(participantId, "STRIPE", deps());
      expect(during.readiness).toBe(before.readiness);
      expect(during.readinessObservedAt).toBe(before.readinessObservedAt);
      expect(during.updatedAt).toBe(before.updatedAt);

      await liftParticipantRestriction(
        {
          restrictionId: only.restriction.restrictionId,
          reasonCode: "POLICY_ELIGIBILITY_RESTRICTION",
          actingAccountId: RESTRICTOR,
          liftedAt: LATEST,
        },
        deps(),
      );
      const after = await getParticipantPaymentAccount(participantId, "STRIPE", deps());
      expect(after.readiness).toBe(before.readiness);
      expect(after.providerAccountRef).toBe(ref);
      expect(after.updatedAt).toBe(before.updatedAt);
    });
  });

  // — 11. Phase boundaries —

  describe("11. phase boundaries hold", () => {
    it("SUSPENDED remains refused", async () => {
      const { participantId } = await seedActivatedParticipant();
      await expect(
        advanceParticipantStatus(participantId, "SUSPENDED", deps()),
      ).rejects.toBeInstanceOf(ActivationNotPermittedInPhaseError);

      const restricted = await restrict(participantId);
      expect(restricted.participantStatus).not.toBe("SUSPENDED");
    });

    it("no transaction-risk column exists anywhere", async () => {
      const columns = await db.$queryRawUnsafe<Array<{ TABLE_NAME: string; COLUMN_NAME: string }>>(
        `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()`,
      );
      const names = columns.map((c) => `${c.TABLE_NAME}.${c.COLUMN_NAME}`.toLowerCase());
      for (const forbidden of [
        "riskscore",
        "riskclassification",
        "reserveamount",
        "payouthold",
        "transactioncap",
        "velocity",
        "fraud",
        "chargebackcount",
        "manualreview",
      ]) {
        expect(names.some((n) => n.includes(forbidden)), forbidden).toBe(false);
      }
    });

    it("restriction rows carry no private provider or underwriting column", async () => {
      const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ParticipantRestriction'`,
      );
      const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());
      for (const forbidden of [
        "kyc",
        "kyb",
        "underwriting",
        "document",
        "legalname",
        "address",
        "taxid",
        "ssn",
        "note",
        "message",
        "payload",
        "freetext",
        "expiresat",
      ]) {
        expect(names.some((n) => n.includes(forbidden)), forbidden).toBe(false);
      }
    });

    it("the restriction FK to the participant is RESTRICT, and history blocks deletion", async () => {
      const rules = await db.$queryRawUnsafe<Array<{ DELETE_RULE: string }>>(
        `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ParticipantRestriction'`,
      );
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) expect(r.DELETE_RULE).toBe("RESTRICT");

      const { participantId } = await seedActivatedParticipant();
      await restrict(participantId);
      await expect(
        db.marketplaceParticipant.delete({ where: { id: participantId } }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("no capsule, node, or publication row is introduced", async () => {
      await seedStandardPolicy();
      const { participantId } = await seedActivatedParticipant();
      await restrict(participantId);
      expect(await db.productPublication.count()).toBe(0);
      expect(await db.publicationOutbox.count()).toBe(0);
    });
  });

  // — 12. Transactionality —

  describe("12. transactionality", () => {
    it("a refused self-restriction writes neither evidence nor status", async () => {
      const { accountId, participantId } = await seedActivatedParticipant();
      await grantAccountEntitlement(
        { accountId, capability: "participant:restrict", grantedAt: NOW },
        { db },
      );
      await expect(
        restrict(participantId, { actingAccountId: accountId }),
      ).rejects.toBeInstanceOf(RestrictionSelfActionNotPermittedError);

      expect(await db.participantRestriction.count({ where: { participantId } })).toBe(0);
      const row = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(row?.status).toBe("ACTIVE");
    });

    it("a concurrent second lift loses rather than overwriting the first", async () => {
      const { participantId } = await seedActivatedParticipant();
      const only = await restrict(participantId);
      const lift = {
        restrictionId: only.restriction.restrictionId,
        reasonCode: "POLICY_ELIGIBILITY_RESTRICTION" as const,
        actingAccountId: RESTRICTOR,
        liftedAt: LATEST,
      };
      const results = await Promise.allSettled([
        liftParticipantRestriction(lift, deps()),
        liftParticipantRestriction(lift, deps()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

      const history = await getParticipantRestrictionHistory(participantId, deps());
      expect(history).toHaveLength(1);
      expect(history[0]!.liftedByAccountId).toBe(RESTRICTOR);
    });

    it("activating a superseding version is atomic — never two active at once", async () => {
      const policyId = await seedStandardPolicy();
      await recordCommercialPolicyVersion(
        {
          policyId,
          policyVersion: "2",
          currency: "USD",
          retainedPercentageBasisPoints: 500,
          retainedFixedAmountMinorUnits: 0,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: LATER,
          recordedByAccountId: POLICY_ACTOR,
          recordedAt: LATER,
        },
        policyDeps(),
      );
      await activateCommercialPolicyVersion(
        { policyId, policyVersion: "2", activatedByAccountId: POLICY_ACTOR, activatedAt: LATER },
        policyDeps(),
      );

      const active = await db.commercialPolicyVersionRow.findMany({
        where: { policyId, status: "ACTIVE" },
      });
      expect(active).toHaveLength(1);
      expect(active[0]!.policyVersion).toBe("2");
    });
  });
});
