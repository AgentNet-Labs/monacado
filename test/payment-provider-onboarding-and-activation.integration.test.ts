/**
 * Payment-provider onboarding and governed activation integration tests
 * (Phase 0M.8).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK and NO PROVIDER. Instants and identities are injected, so nothing
 * here depends on a real clock, and the only `PaymentProviderPort` in existence
 * is the in-memory double below. Every value is synthetic; no real personal data
 * appears.
 *
 * **Test isolation.** Unlike the 0M.5 suite, this one owns its fixtures by
 * prefix and deletes only those. Every identifier it creates carries the `M8T`
 * opaque prefix and every account address the `0m8t-` local part, so a shared
 * Product, Storefront, Offer, Listing, publication, or another suite's
 * participant is never touched. Cleanup runs child-to-parent, which is also the
 * documentation of the delete rules.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import {
  grantAccountEntitlement,
  revokeAccountEntitlement,
} from "../src/server/account/account-entitlement-service";
import { resolveInternalAuthorizationSubject } from "../src/server/account/internal-authorization-service";
import { canReviewParticipantActivation } from "../src/contracts/account/internal-authorization";
import {
  createDraftParticipant,
  materializeMarketplaceSubject,
  updateParticipantProfile,
  advanceParticipantStatus,
} from "../src/server/marketplace/participant-service";
import {
  evaluateParticipantPaymentReadiness,
  getParticipantPaymentAccount,
  recordObservedProviderState,
  registerParticipantPaymentAccount,
  syncProviderReadiness,
} from "../src/server/marketplace/payment-account-service";
import {
  decideParticipantActivation,
  getParticipantActivationHistory,
  submitParticipantForActivation,
} from "../src/server/marketplace/activation-service";
import {
  AmbiguousPaymentReadinessError,
  DuplicatePaymentAccountError,
  InvalidPaymentAccountInputError,
  InvalidPaymentReadinessTransitionError,
  MultiplePaymentProvidersNotSupportedInPhaseError,
  PaymentAccountNotFoundError,
  ProviderAccountRefAlreadyLinkedError,
  ProviderAccountRefMismatchError,
} from "../src/server/marketplace/payment-account-errors";
import {
  ActivationAlreadyDecidedError,
  ActivationNotPermittedInPhaseError,
  ActivationNotSubmittedError,
  ActivationPrerequisitesNotMetError,
  ActivationReviewerNotAuthorizedError,
  ActivationSelfReviewNotPermittedError,
  IncoherentActivationDecisionError,
  ParticipantNotFoundError,
  RestrictionScopeNotAvailableInPhaseError,
} from "../src/server/marketplace/participant-errors";
import {
  deleteParticipantPolicyRows,
  ensureShippedMarketplacePolicyActive,
  satisfyActivationPolicyPrerequisites,
} from "./support/marketplace-policy-fixture";
import { PARTICIPANT_ID_PATTERNS } from "../src/server/marketplace/participant-ids";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type {
  PaymentProviderPort,
  PaymentRequirementCode,
  ProviderReadinessObservation,
} from "../src/contracts/marketplace/payment-account";
import { canReceivePayout, canSubmitActivation } from "../src/contracts/marketplace/capability";
import type { PaymentReadinessStatus } from "../src/contracts/marketplace/participant";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

/** Suite-owned prefixes. Cleanup targets these and nothing else. */
const TAG = "M8T";
const EMAIL_PREFIX = "0m8t-";

const NOW = "2027-08-01T09:00:00.000Z";
const LATER = "2027-08-02T09:00:00.000Z";
const LATEST = "2027-08-03T09:00:00.000Z";
const PASSWORD = "correct-horse-battery-staple-0m8";

/**
 * The reviewing internal account, seeded per test with an explicit
 * `activation:review` entitlement. There is no constant reviewer identity — the
 * authority is a persisted grant, so the fixture has to actually grant it.
 */
let REVIEWER = "";

let seq = 0;

/** 26 Crockford characters, prefixed so every row this suite writes is its own. */
function pad26(seed: string): string {
  const body = seed.toUpperCase().replace(/[ILOU]/g, "0");
  return (body + "0".repeat(26)).slice(0, 26);
}

function nextSuffix(): string {
  seq += 1;
  return pad26(`${TAG}${seq}`);
}

/** Deterministic, suite-prefixed identities so cleanup can find every row. */
function suiteIds(): ParticipantIdProvider {
  return {
    nextParticipantId: () => `mon:mpart:${nextSuffix()}`,
    nextRoleAssignmentId: () => `mon:mrole:${nextSuffix()}`,
    nextProfileId: () => `mon:mprof:${nextSuffix()}`,
    nextActivationId: () => `mon:mact:${nextSuffix()}`,
    nextPaymentAccountId: () => `mon:mpay:${nextSuffix()}`,
    nextRestrictionId: () => `mon:prst:${nextSuffix()}`,
  nextObligationId: () => `mon:nobl:${nextSuffix()}`,
  };
}

const ids = suiteIds();
const deps = () => ({ db, ids });

/**
 * Delete only what this suite created, child-to-parent.
 *
 * Every filter is scoped by the suite's own prefix. No `deleteMany({})` appears
 * anywhere: a broad delete here would take another suite's participants and
 * every Product, Storefront, Offer, and Listing hanging off them.
 */
async function cleanup(): Promise<void> {
  const owned = { participantId: { startsWith: `mon:mpart:${TAG}` } };

  /* Phase 1.3 rows first. The acceptance key is RESTRICT — evidence does not
     vanish because a row above it did — so an acceptance left behind would block
     the participant delete below. */
  await deleteParticipantPolicyRows(db, `mon:mpart:${TAG}`);
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
  await db.accountSession.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.accountEntitlement.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.account.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

/** An internal account holding an explicitly granted `activation:review`. */
async function seedReviewerAccount(): Promise<string> {
  const accountId = await seedAccount();
  await grantAccountEntitlement(
    { accountId, capability: "activation:review", grantedAt: NOW },
    { db },
  );
  return accountId;
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

/** A drafting participant holding the given roles. */
async function seedParticipant(roles: ("SELLER" | "PROMOTER" | "BUYER")[] = ["SELLER"]) {
  const accountId = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: roles, now: NOW },
    deps(),
  );
  return { accountId, participantId: snapshot.participant.participantId };
}

/** Every profile marker and gate satisfied — the only way to reach PROFILE_COMPLETE. */
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

const providerRef = (): string => `acct_${TAG.toLowerCase()}_${(seq += 1)}`;

/** Walk a linked account to ENABLED along the transitions the 0M.1 table permits. */
async function enableProvider(participantId: string, ref: string): Promise<void> {
  const base = { participantId, provider: "STRIPE" as const, providerAccountRef: ref };
  await recordObservedProviderState(
    { ...base, readiness: "DETAILS_REQUIRED", outstandingRequirements: ["IDENTITY_DETAILS_REQUIRED"], observedAt: NOW },
    deps(),
  );
  await recordObservedProviderState(
    { ...base, readiness: "PENDING_PROVIDER", outstandingRequirements: [], observedAt: LATER },
    deps(),
  );
  await recordObservedProviderState(
    { ...base, readiness: "ENABLED", outstandingRequirements: [], observedAt: LATEST },
    deps(),
  );
}

/** A participant one approval away from ACTIVE. */
async function seedReadyForApproval() {
  const { accountId, participantId } = await seedParticipant(["SELLER"]);
  await completeProfile(participantId);
  const ref = providerRef();
  await registerParticipantPaymentAccount(
    { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
    deps(),
  );
  await enableProvider(participantId, ref);
  /* Phase 1.3 added two activation prerequisites — accepted policy and a verified
     support contact. They are real requirements, so the fixture satisfies them
     rather than routing around them, and these 0M.8 assertions keep testing what
     they were written to test. Phase 1.3's own suite covers the refusals. */
  await satisfyActivationPolicyPrerequisites(
    db,
    { participantId, accountId, roles: ["SELLER"], now: NOW },
  );
  await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());
  return { accountId, participantId, ref };
}

const approve = (participantId: string, overrides: Record<string, unknown> = {}) =>
  decideParticipantActivation(
    {
      participantId,
      decision: "APPROVED",
      decisionReasonCode: "PREREQUISITES_SATISFIED",
      reviewerAccountId: REVIEWER,
      decidedAt: LATEST,
      ...overrides,
    },
    deps(),
  );

/** The deferred adapter's stand-in. Returns Monacado's vocabulary, never a provider's. */
function fakePort(observation: ProviderReadinessObservation): PaymentProviderPort {
  return { fetchReadiness: async () => observation };
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Phase 0M.8 — payment-provider onboarding and governed activation", () => {
  beforeEach(async () => {
    await cleanup();
    REVIEWER = await seedReviewerAccount();
    await ensureShippedMarketplacePolicyActive(db, {
      recordedByAccountId: REVIEWER,
      now: NOW,
    });
  });
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — 1. Payment account persistence —

  describe("1. ParticipantPaymentAccount persistence", () => {
    it("creates an account for a persisted participant, at NOT_STARTED", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      const record = await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );

      expect(record.participantId).toBe(participantId);
      expect(record.readiness).toBe("NOT_STARTED");
      expect(record.readinessObservedAt).toBeNull();
      expect(record.outstandingRequirements).toEqual([]);
      expect(record.paymentAccountId).toMatch(PARTICIPANT_ID_PATTERNS.paymentAccount);
    });

    it("refuses a missing participant", async () => {
      await expect(
        registerParticipantPaymentAccount(
          {
            participantId: `mon:mpart:${pad26(`${TAG}GHOST`)}`,
            provider: "STRIPE",
            providerAccountRef: providerRef(),
            now: NOW,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(ParticipantNotFoundError);
    });

    it("round-trips the provider identifier and account reference", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );
      const read = await getParticipantPaymentAccount(participantId, "STRIPE", deps());
      expect(read.provider).toBe("STRIPE");
      expect(read.providerAccountRef).toBe(ref);
    });

    it("refuses a second account with the same provider for one participant", async () => {
      const { participantId } = await seedParticipant();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: providerRef(), now: NOW },
        deps(),
      );
      await expect(
        registerParticipantPaymentAccount(
          { participantId, provider: "STRIPE", providerAccountRef: providerRef(), now: NOW },
          deps(),
        ),
      ).rejects.toBeInstanceOf(DuplicatePaymentAccountError);
    });

    /**
     * The uniqueness that matters most: one provider account belongs to exactly
     * one participant, or every payout attribution built on it is ambiguous.
     */
    it("refuses linking one provider account to two participants", async () => {
      const ref = providerRef();
      const first = await seedParticipant();
      const second = await seedParticipant();
      await registerParticipantPaymentAccount(
        { participantId: first.participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );
      await expect(
        registerParticipantPaymentAccount(
          { participantId: second.participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
          deps(),
        ),
      ).rejects.toBeInstanceOf(ProviderAccountRefAlreadyLinkedError);
    });

    it("refuses a raw KYC payload through the authoritative input", async () => {
      const { participantId } = await seedParticipant();
      await expect(
        registerParticipantPaymentAccount(
          {
            participantId,
            provider: "STRIPE",
            providerAccountRef: providerRef(),
            now: NOW,
            kycPayload: { legalName: "Synthetic Person", taxId: "000-00-0000" },
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(InvalidPaymentAccountInputError);
    });

    it("reading an unlinked participant is a bounded not-found, not a null", async () => {
      const { participantId } = await seedParticipant();
      await expect(
        getParticipantPaymentAccount(participantId, "STRIPE", deps()),
      ).rejects.toBeInstanceOf(PaymentAccountNotFoundError);
    });
  });

  // — 2. Observed readiness —

  describe("2. the readiness lifecycle, observed and not assumed", () => {
    it("round-trips each readiness the onboarding path passes through", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );

      const seen: PaymentReadinessStatus[] = ["NOT_STARTED"];
      const base = { participantId, provider: "STRIPE" as const, providerAccountRef: ref };

      for (const [readiness, at] of [
        ["DETAILS_REQUIRED", NOW],
        ["PENDING_PROVIDER", LATER],
        ["ENABLED", LATEST],
      ] as const) {
        const record = await recordObservedProviderState(
          { ...base, readiness, outstandingRequirements: [], observedAt: at },
          deps(),
        );
        expect(record.readiness).toBe(readiness);
        seen.push(readiness);
      }

      // DISABLED closes the set the phase must be able to represent.
      const disabled = await recordObservedProviderState(
        { ...base, readiness: "DISABLED", outstandingRequirements: [], observedAt: LATEST },
        deps(),
      );
      expect(disabled.readiness).toBe("DISABLED");
      expect(seen).toEqual(["NOT_STARTED", "DETAILS_REQUIRED", "PENDING_PROVIDER", "ENABLED"]);
    });

    it("refuses NOT_STARTED to ENABLED — the provider must have decided", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );

      await expect(
        recordObservedProviderState(
          {
            participantId,
            provider: "STRIPE",
            providerAccountRef: ref,
            readiness: "ENABLED",
            outstandingRequirements: [],
            observedAt: NOW,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(InvalidPaymentReadinessTransitionError);

      const still = await getParticipantPaymentAccount(participantId, "STRIPE", deps());
      expect(still.readiness).toBe("NOT_STARTED");
    });

    it("records the observation instant", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );
      const record = await recordObservedProviderState(
        {
          participantId,
          provider: "STRIPE",
          providerAccountRef: ref,
          readiness: "DETAILS_REQUIRED",
          outstandingRequirements: [],
          observedAt: LATER,
        },
        deps(),
      );
      expect(record.readinessObservedAt).toBe(LATER);
    });

    it("refuses an observation naming a different provider account", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );
      await expect(
        recordObservedProviderState(
          {
            participantId,
            provider: "STRIPE",
            providerAccountRef: providerRef(),
            readiness: "DETAILS_REQUIRED",
            outstandingRequirements: [],
            observedAt: NOW,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(ProviderAccountRefMismatchError);
    });

    it("round-trips bounded requirement codes and replaces them wholesale", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );
      const base = { participantId, provider: "STRIPE" as const, providerAccountRef: ref };

      const first = await recordObservedProviderState(
        {
          ...base,
          readiness: "DETAILS_REQUIRED",
          outstandingRequirements: [
            "PAYOUT_DETAILS_REQUIRED",
            "IDENTITY_DETAILS_REQUIRED",
          ] satisfies PaymentRequirementCode[],
          observedAt: NOW,
        },
        deps(),
      );
      expect(first.outstandingRequirements).toEqual([
        "IDENTITY_DETAILS_REQUIRED",
        "PAYOUT_DETAILS_REQUIRED",
      ]);

      // A satisfied requirement disappears rather than accumulating forever.
      const second = await recordObservedProviderState(
        {
          ...base,
          readiness: "DETAILS_REQUIRED",
          outstandingRequirements: ["PAYOUT_DETAILS_REQUIRED"],
          observedAt: LATER,
        },
        deps(),
      );
      expect(second.outstandingRequirements).toEqual(["PAYOUT_DETAILS_REQUIRED"]);
    });

    it("refuses a raw provider error payload on an observation", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );
      await expect(
        recordObservedProviderState(
          {
            participantId,
            provider: "STRIPE",
            providerAccountRef: ref,
            readiness: "DETAILS_REQUIRED",
            outstandingRequirements: [],
            observedAt: NOW,
            providerErrorPayload: { message: "verification failed for Synthetic Person" },
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(InvalidPaymentAccountInputError);
    });

    /** The seam to the deferred adapter, exercised with a double and no network. */
    it("persists what an injected provider port reports, and nothing more", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );

      const record = await syncProviderReadiness(
        {
          participantId,
          provider: "STRIPE",
          observedAt: LATER,
          port: fakePort({
            provider: "STRIPE",
            providerAccountRef: ref,
            readiness: "DETAILS_REQUIRED",
            outstandingRequirements: ["DOCUMENT_VERIFICATION_REQUIRED"],
          }),
        },
        deps(),
      );

      expect(record.readiness).toBe("DETAILS_REQUIRED");
      expect(record.outstandingRequirements).toEqual(["DOCUMENT_VERIFICATION_REQUIRED"]);
      expect(record.readinessObservedAt).toBe(LATER);
    });

    /**
     * The 0M.1 §5 separation, at its most consequential point: the provider's
     * answer changes no admission status by itself.
     */
    it("an ENABLED observation activates nobody", async () => {
      const { accountId, participantId } = await seedParticipant();
      await completeProfile(participantId);
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );
      await enableProvider(participantId, ref);

      const row = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(row?.status).toBe("PROFILE_COMPLETE");

      const subject = await materializeMarketplaceSubject(accountId, deps());
      expect(subject.participant?.paymentReadiness).toBe("ENABLED");
      expect(subject.participant?.status).not.toBe("ACTIVE");
      expect(await db.participantActivation.count({ where: { participantId } })).toBe(0);
    });
  });

  // — 3. Readiness reaches the capability decisions —

  describe("3. persisted readiness feeds the 0M.1 capability decisions", () => {
    it("reports NOT_STARTED when no provider account is linked", async () => {
      const { participantId } = await seedParticipant();
      expect(await evaluateParticipantPaymentReadiness(participantId, deps())).toBe("NOT_STARTED");
    });

    it("materialization reports the persisted answer rather than a constant", async () => {
      const { accountId, participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );
      await enableProvider(participantId, ref);

      const subject = await materializeMarketplaceSubject(accountId, deps());
      expect(subject.participant?.paymentReadiness).toBe("ENABLED");
    });

    /**
     * `canReceivePayout` becomes *evaluable* here. It performs no payout, and
     * this phase creates nothing that could.
     *
     * Rewritten at Phase 0M.9, which legitimately added `Order`,
     * `ProceedsObligation`, and the rest of the sale path. The original assertion
     * enumerated Prisma delegates and claimed none was money-shaped — a proxy that
     * stops meaning anything the moment a later phase adds the tables on purpose.
     * What it was always trying to say is that **reaching this decision writes
     * nothing**, so it now says exactly that, by counting the money-bearing tables
     * across the call. That claim is strictly stronger and does not expire.
     */
    it("canReceivePayout becomes evaluable and stays a decision, not a payout", async () => {
      const { accountId, participantId } = await seedReadyForApproval();
      await approve(participantId);

      const before = {
        orders: await db.order.count(),
        obligations: await db.proceedsObligation.count(),
        snapshots: await db.transactionEconomicSnapshot.count(),
        settlements: await db.transactionSettlement.count(),
      };

      const subject = await materializeMarketplaceSubject(accountId, deps());
      expect(canReceivePayout(subject).decision).toBe("ALLOW");

      // Nothing that could move money was written by reaching that answer.
      expect({
        orders: await db.order.count(),
        obligations: await db.proceedsObligation.count(),
        snapshots: await db.transactionEconomicSnapshot.count(),
        settlements: await db.transactionSettlement.count(),
      }).toEqual(before);

      // And there is still no delegate for a payout, a charge, or a ledger at all.
      const tables = Object.keys(db).filter(
        (k) => typeof k === "string" && !k.startsWith("$") && !k.startsWith("_"),
      );
      for (const forbidden of ["payment", "charge", "payout", "ledger"]) {
        expect(tables.some((t) => t.toLowerCase() === forbidden), forbidden).toBe(false);
      }
    });

    it("a DISABLED provider denies payout even for an ACTIVE participant", async () => {
      const { accountId, participantId, ref } = await seedReadyForApproval();
      await approve(participantId);
      await recordObservedProviderState(
        {
          participantId,
          provider: "STRIPE",
          providerAccountRef: ref,
          readiness: "DISABLED",
          outstandingRequirements: [],
          observedAt: LATEST,
        },
        deps(),
      );

      const subject = await materializeMarketplaceSubject(accountId, deps());
      expect(subject.participant?.status).toBe("ACTIVE");
      expect(canReceivePayout(subject).decision).toBe("DENY");
    });

    /**
     * `PAYMENT_PROVIDERS` holds one member today, so a second provider cannot be
     * requested through the input at all — the enum refuses it before the
     * service is reached. The row is therefore written directly, to prove the
     * property that matters: readiness **fails closed rather than choosing**,
     * because picking one of two disagreeing providers is a commercial rule
     * nobody has decided and the value feeds `canReceivePayout`.
     */
    it("refuses to choose when two accounts would make readiness ambiguous", async () => {
      const { participantId } = await seedParticipant();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: providerRef(), now: NOW },
        deps(),
      );

      await expect(
        registerParticipantPaymentAccount(
          { participantId, provider: "SOME_FUTURE_PROVIDER", providerAccountRef: providerRef(), now: NOW },
          deps(),
        ),
      ).rejects.toBeInstanceOf(InvalidPaymentAccountInputError);

      await db.participantPaymentAccount.create({
        data: {
          id: `mon:mpay:${nextSuffix()}`,
          participantId,
          provider: "SOME_FUTURE_PROVIDER",
          providerAccountRef: providerRef(),
          readiness: "ENABLED",
        },
      });

      await expect(
        evaluateParticipantPaymentReadiness(participantId, deps()),
      ).rejects.toBeInstanceOf(AmbiguousPaymentReadinessError);
    });

    /**
     * The guard that makes adding a second provider to `PAYMENT_PROVIDERS` safe
     * later: registering into a participant that already holds a different
     * provider is refused with a phase-gate error rather than creating the
     * ambiguity above. Exercised rather than theoretical.
     */
    it("refuses registering a provider alongside a different existing one", async () => {
      const { participantId } = await seedParticipant();
      await db.participantPaymentAccount.create({
        data: {
          id: `mon:mpay:${nextSuffix()}`,
          participantId,
          provider: "SOME_FUTURE_PROVIDER",
          providerAccountRef: providerRef(),
          readiness: "NOT_STARTED",
        },
      });

      await expect(
        registerParticipantPaymentAccount(
          { participantId, provider: "STRIPE", providerAccountRef: providerRef(), now: NOW },
          deps(),
        ),
      ).rejects.toBeInstanceOf(MultiplePaymentProvidersNotSupportedInPhaseError);

      expect(await db.participantPaymentAccount.count({ where: { participantId } })).toBe(1);
    });
  });

  // — 4. Activation submission —

  describe("4. activation submission", () => {
    it("uses the committed activation:submit capability", async () => {
      const { accountId, participantId } = await seedParticipant();
      await completeProfile(participantId);

      const subject = await materializeMarketplaceSubject(accountId, deps());
      expect(canSubmitActivation(subject).decision).toBe("ALLOW");

      const snapshot = await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());
      expect(snapshot.participantStatus).toBe("UNDER_REVIEW");
    });

    it("refuses an ineligible participant with the capability's own reason code", async () => {
      const { participantId } = await seedParticipant();
      await expect(
        submitParticipantForActivation({ participantId, submittedAt: NOW }, deps()),
      ).rejects.toMatchObject({
        name: "ActivationPrerequisitesNotMetError",
        refusalCodes: ["PROFILE_NOT_COMPLETE"],
      });
    });

    it("refuses a participant holding no activatable role", async () => {
      const { participantId } = await seedParticipant(["BUYER"]);
      await completeProfile(participantId);
      await expect(
        submitParticipantForActivation({ participantId, submittedAt: NOW }, deps()),
      ).rejects.toMatchObject({ refusalCodes: ["NO_ACTIVATABLE_ROLE"] });
    });

    it("appends an undecided activation row and moves the role to PENDING_ACTIVATION", async () => {
      const { participantId } = await seedParticipant();
      await completeProfile(participantId);
      const snapshot = await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());

      expect(snapshot.activation.decision).toBeNull();
      expect(snapshot.activation.decidedAt).toBeNull();
      expect(snapshot.activation.submittedAt).toBe(NOW);

      const role = await db.marketplaceRoleAssignment.findFirst({
        where: { participantId, role: "SELLER" },
      });
      expect(role?.status).toBe("PENDING_ACTIVATION");
    });

    it("permits at most one undecided activation per participant", async () => {
      const { participantId } = await seedParticipant();
      await completeProfile(participantId);
      await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());
      await expect(
        submitParticipantForActivation({ participantId, submittedAt: LATER }, deps()),
      ).rejects.toMatchObject({ refusalCodes: ["ACTIVATION_ALREADY_SUBMITTED"] });
    });

    /** 0M.1 §5: a provider outage must not become a Monacado review outage. */
    it("does not require provider readiness to submit", async () => {
      const { participantId } = await seedParticipant();
      await completeProfile(participantId);
      expect(await evaluateParticipantPaymentReadiness(participantId, deps())).toBe("NOT_STARTED");
      const snapshot = await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());
      expect(snapshot.participantStatus).toBe("UNDER_REVIEW");
    });
  });

  // — 5. Governed review —

  describe("5. governed activation review", () => {
    it("APPROVED admits the participant and activates its roles", async () => {
      const { participantId } = await seedReadyForApproval();
      const snapshot = await approve(participantId);

      expect(snapshot.participantStatus).toBe("ACTIVE");
      const role = await db.marketplaceRoleAssignment.findFirst({
        where: { participantId, role: "SELLER" },
      });
      expect(role?.status).toBe("ACTIVE");
      expect(role?.activatedAt?.toISOString()).toBe(LATEST);
    });

    it("APPROVED creates durable evidence — decision, instant, actor, reason", async () => {
      const { participantId } = await seedReadyForApproval();
      const snapshot = await approve(participantId);

      expect(snapshot.activation.decision).toBe("APPROVED");
      expect(snapshot.activation.decidedAt).toBe(LATEST);
      expect(snapshot.activation.decidedByActorId).toBe(REVIEWER);
      expect(snapshot.activation.decisionReasonCode).toBe("PREREQUISITES_SATISFIED");
    });

    it("refuses approval while the provider has not reported ENABLED", async () => {
      const { accountId, participantId } = await seedParticipant();
      await completeProfile(participantId);
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: providerRef(), now: NOW },
        deps(),
      );
      /* The Phase 1.3 prerequisites are satisfied so that the refusal below is
         provider readiness alone — the thing this assertion is about. */
      await satisfyActivationPolicyPrerequisites(
        db,
        { participantId, accountId, roles: ["SELLER"], now: NOW },
      );
      await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());

      await expect(approve(participantId)).rejects.toMatchObject({
        name: "ActivationPrerequisitesNotMetError",
        refusalCodes: ["PAYMENT_NOT_ENABLED"],
      });

      const row = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(row?.status).toBe("UNDER_REVIEW");
    });

    /** Monacado's approval must not be able to invent the provider's answer. */
    it("approval writes no provider state", async () => {
      const { participantId, ref } = await seedReadyForApproval();
      const before = await getParticipantPaymentAccount(participantId, "STRIPE", deps());
      await approve(participantId);
      const after = await getParticipantPaymentAccount(participantId, "STRIPE", deps());

      expect(after.readiness).toBe(before.readiness);
      expect(after.readinessObservedAt).toBe(before.readinessObservedAt);
      expect(after.providerAccountRef).toBe(ref);
      expect(after.updatedAt).toBe(before.updatedAt);
    });

    it("refuses an internal account holding no activation:review entitlement", async () => {
      const { participantId } = await seedReadyForApproval();
      const unentitled = await seedAccount();

      await expect(
        approve(participantId, { reviewerAccountId: unentitled }),
      ).rejects.toMatchObject({
        name: "ActivationReviewerNotAuthorizedError",
        requiredCapability: "activation:review",
        reasonCodes: ["INTERNAL_CAPABILITY_NOT_GRANTED"],
      });

      const row = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(row?.status).toBe("UNDER_REVIEW");
      expect(await db.participantActivation.count({ where: { participantId, decision: { not: null } } })).toBe(0);
    });

    it("refuses a decision whose reason code contradicts it", async () => {
      const { participantId } = await seedReadyForApproval();
      await expect(
        approve(participantId, { decisionReasonCode: "PROVIDER_DECLINED" }),
      ).rejects.toBeInstanceOf(IncoherentActivationDecisionError);
    });

    it("refuses deciding when nothing was submitted", async () => {
      const { participantId } = await seedParticipant();
      await completeProfile(participantId);
      await expect(approve(participantId)).rejects.toBeInstanceOf(ActivationNotSubmittedError);
    });

    it("MORE_INFORMATION_REQUIRED persists and does not activate", async () => {
      const { participantId } = await seedReadyForApproval();
      const snapshot = await decideParticipantActivation(
        {
          participantId,
          decision: "MORE_INFORMATION_REQUIRED",
          decisionReasonCode: "ADDITIONAL_VERIFICATION_REQUESTED",
          reviewerAccountId: REVIEWER,
          decidedAt: LATEST,
        },
        deps(),
      );

      expect(snapshot.activation.decision).toBe("MORE_INFORMATION_REQUIRED");
      expect(snapshot.participantStatus).toBe("PROFILE_INCOMPLETE");
      expect(snapshot.participantStatus).not.toBe("ACTIVE");
    });

    it("REJECTED persists, does not activate, and does not close the participant", async () => {
      const { participantId } = await seedReadyForApproval();
      const snapshot = await decideParticipantActivation(
        {
          participantId,
          decision: "REJECTED",
          decisionReasonCode: "NOT_ELIGIBLE_UNDER_POLICY",
          reviewerAccountId: REVIEWER,
          decidedAt: LATEST,
        },
        deps(),
      );

      expect(snapshot.activation.decision).toBe("REJECTED");
      expect(snapshot.participantStatus).toBe("UNDER_REVIEW");
      expect(snapshot.participantStatus).not.toBe("ACTIVE");
      expect(snapshot.participantStatus).not.toBe("CLOSED");
    });

    it("is append-only — a decided activation is never re-decided", async () => {
      const { participantId } = await seedReadyForApproval();
      await approve(participantId);
      await expect(approve(participantId)).rejects.toBeInstanceOf(ActivationNotSubmittedError);

      const history = await getParticipantActivationHistory(participantId, deps());
      expect(history).toHaveLength(1);
      expect(history[0]!.decision).toBe("APPROVED");
    });

    it("a second review is a second row, and the first survives", async () => {
      const { participantId } = await seedReadyForApproval();
      await decideParticipantActivation(
        {
          participantId,
          decision: "MORE_INFORMATION_REQUIRED",
          decisionReasonCode: "PROFILE_SECTION_OUTSTANDING",
          reviewerAccountId: REVIEWER,
          decidedAt: LATER,
        },
        deps(),
      );
      await advanceParticipantStatus(participantId, "PROFILE_COMPLETE", deps());
      await submitParticipantForActivation({ participantId, submittedAt: LATEST }, deps());

      const history = await getParticipantActivationHistory(participantId, deps());
      expect(history).toHaveLength(2);
      expect(history.some((a) => a.decision === "MORE_INFORMATION_REQUIRED")).toBe(true);
    });
  });

  // — 5b. Reviewer authority is a persisted internal entitlement —

  describe("5b. reviewer authority comes from AccountEntitlement, never a caller", () => {
    it("an account with an active activation:review grant may decide", async () => {
      const { participantId } = await seedReadyForApproval();
      const subject = await resolveInternalAuthorizationSubject(REVIEWER, { db });
      expect(subject?.capabilities).toContain("activation:review");
      expect(canReviewParticipantActivation(subject).decision).toBe("ALLOW");

      const snapshot = await approve(participantId);
      expect(snapshot.participantStatus).toBe("ACTIVE");
    });

    /** Revocation fails closed on the very next decision — read, never cached. */
    it("a revoked entitlement stops the very next decision", async () => {
      const { participantId } = await seedReadyForApproval();
      await revokeAccountEntitlement(
        { accountId: REVIEWER, capability: "activation:review", revokedAt: LATER },
        { db },
      );

      await expect(approve(participantId)).rejects.toMatchObject({
        name: "ActivationReviewerNotAuthorizedError",
        reasonCodes: ["INTERNAL_CAPABILITY_NOT_GRANTED"],
      });
    });

    /**
     * The heart of the ruling: marketplace standing is not internal authority.
     * This account holds every marketplace role, an ACTIVE participant, and its
     * own `activation:submit` — and may still not review.
     */
    it("a fully-activated marketplace participant cannot review", async () => {
      const target = await seedReadyForApproval();
      await approve(target.participantId);

      const seller = await seedReadyForApproval();
      await approve(seller.participantId);
      const sellerSubject = await materializeMarketplaceSubject(seller.accountId, deps());
      expect(sellerSubject.participant?.status).toBe("ACTIVE");
      expect(canSubmitActivation(sellerSubject).decision).toBe("DENY"); // already complete

      const other = await seedReadyForApproval();
      await expect(
        approve(other.participantId, { reviewerAccountId: seller.accountId }),
      ).rejects.toBeInstanceOf(ActivationReviewerNotAuthorizedError);
    });

    it("no marketplace role confers review authority", async () => {
      for (const roles of [["SELLER"], ["PROMOTER"], ["BUYER"], ["SELLER", "PROMOTER", "BUYER"]] as const) {
        const holder = await seedParticipant([...roles]);
        const subject = await resolveInternalAuthorizationSubject(holder.accountId, { db });
        expect(subject?.capabilities).toEqual([]);
        expect(canReviewParticipantActivation(subject).decision).toBe("DENY");

        const target = await seedReadyForApproval();
        await expect(
          approve(target.participantId, { reviewerAccountId: holder.accountId }),
        ).rejects.toBeInstanceOf(ActivationReviewerNotAuthorizedError);
      }
    });

    /** Owning the account that owns the participant grants nothing either. */
    it("a participant cannot review its own activation", async () => {
      const { accountId, participantId } = await seedReadyForApproval();
      await expect(
        approve(participantId, { reviewerAccountId: accountId }),
      ).rejects.toBeInstanceOf(ActivationReviewerNotAuthorizedError);

      const row = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(row?.status).toBe("UNDER_REVIEW");
    });

    /**
     * **Separation of duties.** The entitlement is necessary but not sufficient:
     * granting it makes the account a reviewer generally, and it still may not
     * decide the activation of the participant it owns.
     *
     * The DENY before the grant proves owning the participant confers nothing;
     * the ALLOW after proves the grant is what authorizes; and the refusal that
     * follows proves the grant does not reach this particular review.
     */
    it("an entitled operator still may not decide their OWN participant", async () => {
      const { accountId, participantId } = await seedReadyForApproval();
      const before = await resolveInternalAuthorizationSubject(accountId, { db });
      expect(canReviewParticipantActivation(before).decision).toBe("DENY");

      await grantAccountEntitlement(
        { accountId, capability: "activation:review", grantedAt: NOW },
        { db },
      );
      const after = await resolveInternalAuthorizationSubject(accountId, { db });
      expect(canReviewParticipantActivation(after).decision).toBe("ALLOW");

      await expect(
        approve(participantId, { reviewerAccountId: accountId }),
      ).rejects.toMatchObject({
        name: "ActivationSelfReviewNotPermittedError",
        code: "ACTIVATION_SELF_REVIEW_NOT_PERMITTED",
      });
    });

    /** A dedicated code — not overloaded onto the "not a reviewer" refusal. */
    it("self-review uses its own bounded refusal, distinct from the authorization one", async () => {
      const { accountId, participantId } = await seedReadyForApproval();
      await grantAccountEntitlement(
        { accountId, capability: "activation:review", grantedAt: NOW },
        { db },
      );

      let caught: unknown;
      try {
        await approve(participantId, { reviewerAccountId: accountId });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ActivationSelfReviewNotPermittedError);
      expect(caught).not.toBeInstanceOf(ActivationReviewerNotAuthorizedError);
      expect((caught as { code: string }).code).toBe("ACTIVATION_SELF_REVIEW_NOT_PERMITTED");

      // Discloses neither account: naming either would expose the linkage the
      // refusal is about.
      const serialized = JSON.stringify(caught);
      expect(serialized).not.toContain(accountId);
      expect(serialized).not.toContain(participantId);
      expect(serialized).not.toContain(EMAIL_PREFIX);
    });

    it("a refused self-review writes nothing at all", async () => {
      const { accountId, participantId, ref } = await seedReadyForApproval();
      await grantAccountEntitlement(
        { accountId, capability: "activation:review", grantedAt: NOW },
        { db },
      );

      const beforeStatus = (await db.marketplaceParticipant.findUnique({
        where: { id: participantId },
      }))!.status;
      const beforeRoles = await db.marketplaceRoleAssignment.findMany({
        where: { participantId },
        orderBy: { role: "asc" },
      });
      const beforePayment = await getParticipantPaymentAccount(participantId, "STRIPE", deps());

      await expect(
        approve(participantId, { reviewerAccountId: accountId }),
      ).rejects.toBeInstanceOf(ActivationSelfReviewNotPermittedError);

      // No decision recorded — the activation is still undecided.
      const activation = await db.participantActivation.findFirst({ where: { participantId } });
      expect(activation?.decision).toBeNull();
      expect(activation?.decidedAt).toBeNull();
      expect(activation?.decidedByActorId).toBeNull();
      expect(activation?.undecidedForParticipantId).toBe(participantId);

      // Participant status and roles untouched.
      const afterStatus = (await db.marketplaceParticipant.findUnique({
        where: { id: participantId },
      }))!.status;
      expect(afterStatus).toBe(beforeStatus);
      expect(afterStatus).toBe("UNDER_REVIEW");
      const afterRoles = await db.marketplaceRoleAssignment.findMany({
        where: { participantId },
        orderBy: { role: "asc" },
      });
      expect(afterRoles.map((r) => r.status)).toEqual(beforeRoles.map((r) => r.status));

      // Provider readiness untouched.
      const afterPayment = await getParticipantPaymentAccount(participantId, "STRIPE", deps());
      expect(afterPayment.readiness).toBe(beforePayment.readiness);
      expect(afterPayment.readinessObservedAt).toBe(beforePayment.readinessObservedAt);
      expect(afterPayment.providerAccountRef).toBe(ref);
      expect(afterPayment.updatedAt).toBe(beforePayment.updatedAt);
    });

    /**
     * Ownership is read from the persisted FK, so it holds whatever marketplace
     * roles the participant carries — the internal rule does not consult them.
     */
    it("no marketplace role changes the self-review rule", async () => {
      for (const roles of [["SELLER"], ["PROMOTER"], ["SELLER", "PROMOTER", "BUYER"]] as const) {
        const accountId = await seedAccount();
        const snapshot = await createDraftParticipant(
          { accountId, initialRoles: [...roles], now: NOW },
          deps(),
        );
        const participantId = snapshot.participant.participantId;
        await completeProfile(participantId);
        await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());
        await grantAccountEntitlement(
          { accountId, capability: "activation:review", grantedAt: NOW },
          { db },
        );

        await expect(
          approve(participantId, { reviewerAccountId: accountId }),
        ).rejects.toBeInstanceOf(ActivationSelfReviewNotPermittedError);
      }
    });

    /**
     * The prohibition is on the internal REVIEW, never on the participant's own
     * submission — `activation:submit` is unchanged and self-submission is the
     * ordinary path.
     */
    it("a participant may still submit its own activation", async () => {
      const { accountId, participantId } = await seedParticipant();
      await completeProfile(participantId);

      const subject = await materializeMarketplaceSubject(accountId, deps());
      expect(canSubmitActivation(subject).decision).toBe("ALLOW");

      const snapshot = await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());
      expect(snapshot.participantStatus).toBe("UNDER_REVIEW");
    });

    /** Ordinary review is untouched: a different account decides normally. */
    it("an entitled reviewer still decides another account's participant", async () => {
      const { participantId } = await seedReadyForApproval();
      const snapshot = await approve(participantId);

      expect(snapshot.participantStatus).toBe("ACTIVE");
      expect(snapshot.activation.decision).toBe("APPROVED");
      expect(snapshot.activation.decidedByActorId).toBe(REVIEWER);
    });

    /**
     * Ordering: authorization is settled before ownership is even looked at, so
     * an unauthorized caller cannot use the self-review refusal to learn that a
     * participant exists or who owns it.
     */
    it("an unauthorized caller is refused before self-review is evaluated", async () => {
      const { accountId, participantId } = await seedReadyForApproval();

      // This account OWNS the participant but holds no entitlement. The answer
      // must be the authorization refusal, never the self-review one.
      await expect(
        approve(participantId, { reviewerAccountId: accountId }),
      ).rejects.toMatchObject({
        name: "ActivationReviewerNotAuthorizedError",
        reasonCodes: ["INTERNAL_CAPABILITY_NOT_GRANTED"],
      });
    });

    it("an unrelated internal capability does not stand in", async () => {
      const { participantId } = await seedReadyForApproval();
      const operator = await seedAccount();
      await grantAccountEntitlement(
        { accountId: operator, capability: "publication-worker:status:read", grantedAt: NOW },
        { db },
      );

      await expect(
        approve(participantId, { reviewerAccountId: operator }),
      ).rejects.toMatchObject({
        name: "ActivationReviewerNotAuthorizedError",
        reasonCodes: ["INTERNAL_CAPABILITY_NOT_GRANTED"],
      });
    });

    it("an unknown reviewing account is refused as absent, not merely unentitled", async () => {
      const { participantId } = await seedReadyForApproval();
      await expect(
        approve(participantId, { reviewerAccountId: `mon:acct:${pad26(`${TAG}GHOSTACCT`)}` }),
      ).rejects.toMatchObject({ reasonCodes: ["INTERNAL_ACCOUNT_REQUIRED"] });
    });

    /**
     * Authorization is checked before any participant query runs, so a refusal
     * discloses nothing about the target — including whether it exists.
     */
    it("an unauthorized caller learns nothing about the target participant", async () => {
      const unentitled = await seedAccount();
      let caught: unknown;
      try {
        await decideParticipantActivation(
          {
            participantId: `mon:mpart:${pad26(`${TAG}NOSUCHPART`)}`,
            decision: "APPROVED",
            decisionReasonCode: "PREREQUISITES_SATISFIED",
            reviewerAccountId: unentitled,
            decidedAt: LATEST,
          },
          deps(),
        );
      } catch (error) {
        caught = error;
      }

      // Not ParticipantNotFoundError: the authorization refusal came first.
      expect(caught).toBeInstanceOf(ActivationReviewerNotAuthorizedError);
      const serialized = JSON.stringify(caught);
      expect(serialized).not.toContain(EMAIL_PREFIX);
      expect(serialized).not.toContain(unentitled);
    });

    it("records the reviewing account as the opaque audit actor", async () => {
      const { participantId } = await seedReadyForApproval();
      const snapshot = await approve(participantId);

      expect(snapshot.activation.decidedByActorId).toBe(REVIEWER);
      expect(snapshot.activation.decidedByActorId).toMatch(/^mon:acct:/);
      // Never an email, a display name, or the participant identity.
      expect(snapshot.activation.decidedByActorId).not.toContain("@");
      expect(snapshot.activation.decidedByActorId).not.toBe(participantId);
    });
  });

  // — 6. The RESTRICTED / SUSPENDED phase gate —

  describe("6. RESTRICTED and SUSPENDED remain unreachable", () => {
    it("the draft path refuses both, with the phase-gate error", async () => {
      const { participantId } = await seedParticipant();
      for (const status of ["RESTRICTED", "SUSPENDED"] as const) {
        await expect(
          advanceParticipantStatus(participantId, status, deps()),
        ).rejects.toBeInstanceOf(ActivationNotPermittedInPhaseError);
      }
    });

    it("no governed decision can produce either", async () => {
      const { participantId } = await seedReadyForApproval();
      for (const decision of ["RESTRICTED", "SUSPENDED"]) {
        await expect(
          decideParticipantActivation(
            {
              participantId,
              decision,
              decisionReasonCode: "NOT_ELIGIBLE_UNDER_POLICY",
              reviewerAccountId: REVIEWER,
              decidedAt: LATEST,
            },
            deps(),
          ),
        ).rejects.toMatchObject({ name: "InvalidParticipantInputError" });
      }
    });

    /**
     * The stronger error, for the stronger reason: these statuses have no
     * machine-readable content to write, not merely no decision behind them.
     */
    it("an ACTIVE participant still cannot be restricted or suspended", async () => {
      const { participantId } = await seedReadyForApproval();
      await approve(participantId);
      for (const status of ["RESTRICTED", "SUSPENDED"] as const) {
        await expect(
          advanceParticipantStatus(participantId, status, deps()),
        ).rejects.toBeInstanceOf(ActivationNotPermittedInPhaseError);
      }
    });

    it("no restriction-scope column was fabricated anywhere", async () => {
      const columns = await db.$queryRawUnsafe<Array<{ TABLE_NAME: string; COLUMN_NAME: string }>>(
        `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()`,
      );
      const names = columns.map((c) => `${c.TABLE_NAME}.${c.COLUMN_NAME}`.toLowerCase());
      for (const fabricated of [
        "restrictionscope",
        "riskscore",
        "riskclassification",
        "reserveamount",
        "payouthold",
        "transactioncap",
        "velocitylimit",
      ]) {
        expect(names.some((n) => n.includes(fabricated))).toBe(false);
      }
    });
  });

  // — 7. Storage shape, keys, and delete rules —

  describe("7. storage shape, keys, and delete rules", () => {
    it("persists no credential, dossier, or raw payload column", async () => {
      const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME IN ('ParticipantPaymentAccount','ParticipantPaymentRequirementRow')`,
      );
      const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());

      for (const forbidden of [
        "secret",
        "apikey",
        "token",
        "credential",
        "password",
        "bankaccount",
        "routing",
        "iban",
        "card",
        "taxid",
        "ssn",
        "dateofbirth",
        "legalname",
        "address",
        "document",
        "kyc",
        "kyb",
        "underwriting",
        "rawresponse",
        "errorpayload",
        "stacktrace",
      ]) {
        expect(names.some((n) => n.includes(forbidden)), `${forbidden} must not be a column`).toBe(
          false,
        );
      }
      expect(names).toContain("provideraccountref");
      expect(names).toContain("readiness");
    });

    /* Narrowed at Phase 0M.N1 (`NotificationObligation`), again at 0M.T1
       (`TransactionSettlement`), again at 0M.9 (`Order`), and again at 1.2
       (`RiskPolicy`) — each a table a later phase legitimately owns and 0M.8
       explicitly deferred to it. What this asserts is that *0M.8* added none of
       them.
     *
     * Every remaining member still holds, and each is worth keeping:
     *   - no charge / paymentintent / payout / chargeback table — 1.2 records a
     *     REVERSAL as accounting evidence, and payout execution and dispute
     *     ingestion are still unbuilt. `refund` left this list at 1.9, which
     *     legitimately owns `OrderRefund` — the EXECUTION 1.2 deferred;
     *   - no ledger or commission table — double-entry posting is still 0M.T2's;
     *   - no taxclass table — Product tax classification became a Product SOURCE
     *     fact in 1.6, not a table of its own;
     *   - no riskdecision table — the gate reads and returns, and deliberately
     *     logs nothing, because a denial log is a manual-review workflow's
     *     foundation. */
    it("no charge, payout, tax-engine, or risk-decision table exists", async () => {
      const tables = await db.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
      );
      const names = tables.map((t) => t.TABLE_NAME.toLowerCase());

      for (const forbidden of [
        "charge",
        "paymentintent",
        "payout",
        "chargeback",
        "ledger",
        "commission",
        "taxclass",
        /* `taxtransaction` was on this list until Phase 1.7, which legitimately
           owns `OrderTaxTransaction` — the record of what was reported to the tax
           provider once a sale was paid — and `refund` until Phase 1.9, which
           legitimately owns `OrderRefund`. Narrowed for the same reason every
           other member was: what this asserts is that *0M.8* added none of them.
           `payout` stays, because nothing owns one yet. `chargeback` stays for a
           different reason now: Phase 1.11 designed dispute ingestion and owns
           `TransactionDispute`, but a chargeback is a KIND OF REVERSAL on
           `0M.T1`'s accounting entry rather than a table — so a `chargeback`
           table would still mean a second ledger had appeared. */
        "riskdecision",
      ]) {
        expect(names.some((n) => n.includes(forbidden)), `${forbidden} table must not exist`).toBe(
          false,
        );
      }
    });

    it("the payment-account foreign key to the participant is RESTRICT", async () => {
      const rules = await db.$queryRawUnsafe<Array<{ TABLE_NAME: string; DELETE_RULE: string }>>(
        `SELECT r.TABLE_NAME, r.DELETE_RULE
           FROM information_schema.REFERENTIAL_CONSTRAINTS r
          WHERE r.CONSTRAINT_SCHEMA = DATABASE()
            AND r.TABLE_NAME = 'ParticipantPaymentAccount'`,
      );
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) expect(rule.DELETE_RULE).toBe("RESTRICT");
    });

    it("both uniqueness guarantees exist as indexes", async () => {
      const indexes = await db.$queryRawUnsafe<Array<{ INDEX_NAME: string; NON_UNIQUE: number }>>(
        `SELECT DISTINCT INDEX_NAME, NON_UNIQUE FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ParticipantPaymentAccount'`,
      );
      const unique = indexes.filter((i) => Number(i.NON_UNIQUE) === 0).map((i) => i.INDEX_NAME);
      expect(unique.some((n) => n.includes("participantId_provider"))).toBe(true);
      expect(unique.some((n) => n.includes("providerAccountRef"))).toBe(true);
    });

    /**
     * Provider linkage is evidence behind an activation decision and, later,
     * behind every payout attribution. Deleting the participant under it must be
     * refused rather than cascading.
     */
    it("refuses deleting a participant that holds payment or activation history", async () => {
      const { participantId } = await seedReadyForApproval();
      await approve(participantId);

      await expect(
        db.marketplaceParticipant.delete({ where: { id: participantId } }),
      ).rejects.toMatchObject({ code: "P2003" });

      const still = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(still).not.toBeNull();
    });

    it("requirement rows are subordinate to their account, not to history", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      const account = await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );
      await recordObservedProviderState(
        {
          participantId,
          provider: "STRIPE",
          providerAccountRef: ref,
          readiness: "DETAILS_REQUIRED",
          outstandingRequirements: ["IDENTITY_DETAILS_REQUIRED"],
          observedAt: NOW,
        },
        deps(),
      );

      expect(
        await db.participantPaymentRequirementRow.count({
          where: { paymentAccountId: account.paymentAccountId },
        }),
      ).toBe(1);

      await db.participantPaymentAccount.delete({ where: { id: account.paymentAccountId } });
      expect(
        await db.participantPaymentRequirementRow.count({
          where: { paymentAccountId: account.paymentAccountId },
        }),
      ).toBe(0);
    });
  });

  // — 8. Transactionality —

  describe("8. transactionality", () => {
    /**
     * The guarantee that makes the audit table more than decorative: there is no
     * ordering of failures that leaves an ACTIVE participant with no record of
     * who decided it.
     */
    it("a refused approval leaves neither the status nor the activation moved", async () => {
      const { participantId } = await seedParticipant();
      await completeProfile(participantId);
      await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());

      await expect(approve(participantId)).rejects.toBeInstanceOf(ActivationPrerequisitesNotMetError);

      const row = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
      expect(row?.status).toBe("UNDER_REVIEW");

      const activation = await db.participantActivation.findFirst({ where: { participantId } });
      expect(activation?.decision).toBeNull();
      expect(activation?.undecidedForParticipantId).toBe(participantId);
    });

    it("a concurrent second decision loses rather than overwriting the first", async () => {
      const { participantId } = await seedReadyForApproval();
      const results = await Promise.allSettled([approve(participantId), approve(participantId)]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const history = await getParticipantActivationHistory(participantId, deps());
      expect(history).toHaveLength(1);
      expect(history[0]!.decidedByActorId).toBe(REVIEWER);
    });

    it("a concurrent second submission loses rather than creating a second undecided row", async () => {
      const { participantId } = await seedParticipant();
      await completeProfile(participantId);
      const results = await Promise.allSettled([
        submitParticipantForActivation({ participantId, submittedAt: NOW }, deps()),
        submitParticipantForActivation({ participantId, submittedAt: NOW }, deps()),
      ]);

      expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(1);
      expect(
        await db.participantActivation.count({
          where: { participantId, undecidedForParticipantId: participantId },
        }),
      ).toBe(1);
    });
  });

  // — 9. Errors disclose nothing —

  describe("9. errors carry no private data", () => {
    it("a serialized error leaks no provider reference, driver message, or address", async () => {
      const { participantId } = await seedParticipant();
      const ref = providerRef();
      await registerParticipantPaymentAccount(
        { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
        deps(),
      );

      let caught: unknown;
      try {
        await recordObservedProviderState(
          {
            participantId,
            provider: "STRIPE",
            providerAccountRef: ref,
            readiness: "ENABLED",
            outstandingRequirements: [],
            observedAt: NOW,
          },
          deps(),
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidPaymentReadinessTransitionError);
      const serialized = JSON.stringify(caught);
      expect(serialized).not.toContain(ref);
      expect(serialized).not.toContain("mysql");
      expect(serialized).not.toContain(EMAIL_PREFIX);
      expect(serialized).not.toContain("example.invalid");
      // The bounded transition is safe to name: both ends are closed-enum members.
      expect((caught as InvalidPaymentReadinessTransitionError).from).toBe("NOT_STARTED");
      expect((caught as InvalidPaymentReadinessTransitionError).to).toBe("ENABLED");
    });

    it("an already-decided error carries no decision content", () => {
      const error = new ActivationAlreadyDecidedError();
      expect(JSON.stringify(error)).not.toContain(REVIEWER);
    });

    it("the restriction-scope gate names only the closed-enum status it refused", () => {
      const error = new RestrictionScopeNotAvailableInPhaseError("RESTRICTED");
      expect(error.attempted).toBe("RESTRICTED");
      expect(error.code).toBe("RESTRICTION_SCOPE_NOT_AVAILABLE_IN_PHASE");
    });
  });
});
