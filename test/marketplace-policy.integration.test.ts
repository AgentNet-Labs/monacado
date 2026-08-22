/**
 * Marketplace policy, acceptance, support contacts, and email verification
 * integration tests (Phase 1.3).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK and NO MAIL.** Nothing here sends a message: verification issues a
 * token and the test carries it directly to `consumeVerificationChallenge`, which
 * is exactly what a mail transport would do minus the transport. Instants and
 * identities are injected, so nothing depends on a real clock. Every address is
 * `@example.invalid`; no real personal data appears.
 *
 * **Test isolation.** This suite owns its fixtures by prefix and deletes only
 * those: every identifier carries the `P13T` opaque prefix, every account address
 * the `p13t-` local part, and the policy identity is its own — never
 * `MONACADO_MARKETPLACE_POLICY_ID`, so the real policy's rows are untouched.
 * Cleanup runs child-to-parent, which is also the documentation of the delete
 * rules.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import {
  advanceParticipantStatus,
  createDraftParticipant,
  updateParticipantProfile,
} from "../src/server/marketplace/participant-service";
import {
  registerParticipantPaymentAccount,
  recordObservedProviderState,
} from "../src/server/marketplace/payment-account-service";
import {
  decideParticipantActivation,
  submitParticipantForActivation,
} from "../src/server/marketplace/activation-service";
import { ActivationPrerequisitesNotMetError } from "../src/server/marketplace/participant-errors";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import {
  activateMarketplacePolicyVersion,
  ensureMarketplacePolicy,
  getActiveMarketplacePolicyVersion,
  readActiveMarketplacePolicy,
  readMarketplacePolicy,
  recordMarketplacePolicyVersion,
} from "../src/server/policy/marketplace-policy-service";
import {
  listPolicyAcceptances,
  outstandingAcceptanceAudiences,
  recordPolicyAcceptance,
} from "../src/server/policy/policy-acceptance-service";
import {
  consumeVerificationChallenge,
  degradeEmailContact,
  getEmailContact,
  hashVerificationToken,
  issueVerificationChallenge,
  upsertEmailContact,
} from "../src/server/policy/email-verification-service";
import { resolveSellerSupportContact } from "../src/server/policy/support-contact-service";
import {
  NoActivePolicyError,
  PolicyError,
  PolicyVersionNotFoundError,
  VerificationRefusedError,
} from "../src/server/policy/policy-errors";
import type { PolicyIdProvider } from "../src/server/policy/policy-ids";
import {
  MONACADO_MARKETPLACE_POLICY_V1,
  marketplacePolicyContentHash,
} from "../src/contracts/marketplace/marketplace-policy-content";
import { MarketplacePolicyDocument } from "../src/contracts/marketplace/marketplace-policy";
import { VERIFICATION_TOKEN_TTL_SECONDS } from "../src/contracts/marketplace/participant-email-contact";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

/** Suite-owned prefixes. Cleanup targets these and nothing else. */
const TAG = "P13T";
const EMAIL_PREFIX = "p13t-";

const NOW = "2028-03-01T09:00:00.000Z";
/** Inside the token TTL. `LATER` is exactly one TTL away, i.e. already expired. */
const SOON = "2028-03-01T10:00:00.000Z";
const LATER = "2028-03-02T09:00:00.000Z";
const LATEST = "2028-03-03T09:00:00.000Z";
const PASSWORD = "correct-horse-battery-staple-p13";

let seq = 0;

function pad26(seed: string): string {
  const body = seed.toUpperCase().replace(/[ILOU]/g, "0");
  return (body + "0".repeat(26)).slice(0, 26);
}
function nextSuffix(): string {
  seq += 1;
  return pad26(`${TAG}${seq}`);
}

/**
 * The suite's own policy identity.
 *
 * Deliberately **not** the shipped `MONACADO_MARKETPLACE_POLICY_ID`: a suite that
 * activated and retired versions of the real policy would be rewriting the terms
 * every other suite's participants activated under.
 */
const POLICY_ID = `mon:mpol:${pad26(`${TAG}POLICY`)}`;
const V1 = "1.0.0";
const V2 = "2.0.0";

/**
 * A second version's source, so version succession is exercisable before a second
 * real policy is written. Same shape, different prose — which is what makes the
 * content hashes differ.
 */
const V2_DOCUMENT = MarketplacePolicyDocument.parse({
  ...MONACADO_MARKETPLACE_POLICY_V1,
  policyId: POLICY_ID,
  policyVersion: V2,
  title: "Monacado Marketplace Policy (test succession)",
});
const V1_DOCUMENT = MarketplacePolicyDocument.parse({
  ...MONACADO_MARKETPLACE_POLICY_V1,
  policyId: POLICY_ID,
  policyVersion: V1,
});
const DOCUMENTS: ReadonlyMap<string, MarketplacePolicyDocument> = new Map([
  [V1, V1_DOCUMENT],
  [V2, V2_DOCUMENT],
]);

function suiteParticipantIds(): ParticipantIdProvider {
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
const policyIds: PolicyIdProvider = {
  nextAcceptanceId: () => `mon:pacc:${nextSuffix()}`,
  nextEmailContactId: () => `mon:pemc:${nextSuffix()}`,
  nextVerificationChallengeId: () => `mon:evch:${nextSuffix()}`,
};

const participantIds = suiteParticipantIds();
const deps = () => ({ db, ids: participantIds });
const pdeps = () => ({ db, ids: policyIds, documents: DOCUMENTS });

let REVIEWER = "";

/**
 * Delete only what this suite created, child-to-parent.
 *
 * Every filter is scoped by the suite's own prefix. No `deleteMany({})` appears
 * anywhere.
 */
async function cleanup(): Promise<void> {
  const owned = { participantId: { startsWith: `mon:mpart:${TAG}` } };

  await db.emailVerificationChallenge.deleteMany({ where: owned });
  await db.participantEmailContact.deleteMany({ where: owned });
  await db.participantPolicyAcceptance.deleteMany({ where: owned });
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
  await db.marketplacePolicyVersionRow.deleteMany({ where: { policyId: POLICY_ID } });
  await db.marketplacePolicy.deleteMany({ where: { id: POLICY_ID } });
  await db.accountSession.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.accountEntitlement.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.account.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function seedAccount(): Promise<{ accountId: string; email: string }> {
  seq += 1;
  const email = `${EMAIL_PREFIX}${seq}@example.invalid`;
  const account = await createAccount(
    { name: "Synthetic Person", email, password: PASSWORD, createdAt: NOW },
    { db },
  );
  return { accountId: account.accountId, email };
}

async function seedReviewerAccount(): Promise<string> {
  const { accountId } = await seedAccount();
  await grantAccountEntitlement(
    { accountId, capability: "activation:review", grantedAt: NOW },
    { db },
  );
  return accountId;
}

async function seedParticipant(roles: ("SELLER" | "PROMOTER" | "BUYER")[] = ["SELLER"]) {
  const { accountId, email } = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: roles, now: NOW },
    deps(),
  );
  return { accountId, email, participantId: snapshot.participant.participantId };
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
      gates: { emailVerifiedAt: NOW, termsAcceptedAt: NOW, termsVersion: "terms-2028-01" },
      now: NOW,
    },
    deps(),
  );
  await advanceParticipantStatus(participantId, "PROFILE_INCOMPLETE", deps());
  await advanceParticipantStatus(participantId, "PROFILE_COMPLETE", deps());
}

async function enableProvider(participantId: string): Promise<void> {
  seq += 1;
  const ref = `acct_p13t_${seq}`;
  await registerParticipantPaymentAccount(
    { participantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
    deps(),
  );
  const base = { participantId, provider: "STRIPE" as const, providerAccountRef: ref };
  await recordObservedProviderState(
    {
      ...base,
      readiness: "DETAILS_REQUIRED",
      outstandingRequirements: ["IDENTITY_DETAILS_REQUIRED"],
      observedAt: NOW,
    },
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

/** Register a primary contact and carry its token through to VERIFIED. */
async function verifyPrimary(participantId: string, address: string): Promise<void> {
  await upsertEmailContact({ participantId, purpose: "PRIMARY_PROFILE", now: NOW }, pdeps());
  const { token } = await issueVerificationChallenge(
    { participantId, purpose: "PRIMARY_PROFILE", address, issuedAt: NOW },
    pdeps(),
  );
  await consumeVerificationChallenge({ token, at: SOON }, pdeps());
}

/** The whole active-policy fixture: identity, version, activation. */
async function seedActivePolicy(version: string = V1): Promise<void> {
  await ensureMarketplacePolicy(
    { policyId: POLICY_ID, label: "Suite marketplace policy", now: NOW },
    pdeps(),
  );
  await recordMarketplacePolicyVersion(
    {
      policyId: POLICY_ID,
      policyVersion: version,
      contentRef: `marketplace-policy-test/${version}`,
      requiresReacceptance: true,
      effectiveFrom: NOW,
      recordedByAccountId: REVIEWER,
      recordedAt: NOW,
    },
    pdeps(),
  );
  await activateMarketplacePolicyVersion(
    {
      policyId: POLICY_ID,
      policyVersion: version,
      activatedByAccountId: REVIEWER,
      activatedAt: NOW,
    },
    pdeps(),
  );
}

const acceptAs = (
  participantId: string,
  accountId: string,
  audience: "SELLER" | "PROMOTER",
  policyVersion = V1,
) =>
  recordPolicyAcceptance(
    {
      participantId,
      policyId: POLICY_ID,
      policyVersion,
      audience,
      mechanism: "ONBOARDING_AFFIRMATION",
      acceptedByAccountId: accountId,
      acceptedAt: NOW,
      recordedAt: NOW,
    },
    pdeps(),
  );

const describeDb = RUN ? describe : describe.skip;

describeDb("Phase 1.3 — marketplace policy, acceptance, and support contacts", () => {
  beforeEach(async () => {
    await cleanup();
    REVIEWER = await seedReviewerAccount();
  });
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — 1. Version lifecycle —

  describe("1. policy version lifecycle", () => {
    it("records a version as DRAFT and nothing else", async () => {
      await ensureMarketplacePolicy(
        { policyId: POLICY_ID, label: "Suite marketplace policy", now: NOW },
        pdeps(),
      );
      const draft = await recordMarketplacePolicyVersion(
        {
          policyId: POLICY_ID,
          policyVersion: V1,
          contentRef: `marketplace-policy-test/${V1}`,
          requiresReacceptance: true,
          effectiveFrom: NOW,
          recordedByAccountId: REVIEWER,
          recordedAt: NOW,
        },
        pdeps(),
      );

      /* There is no `status` parameter, so a caller cannot record a version as
         already governing anybody. */
      expect(draft.status).toBe("DRAFT");
      expect(draft.activatedAt).toBeNull();
      /* The hash is derived from the source, never supplied. */
      expect(draft.contentHash).toBe(marketplacePolicyContentHash(V1_DOCUMENT));
      expect(await getActiveMarketplacePolicyVersion(POLICY_ID, pdeps())).toBeNull();
    });

    it("refuses a version with no source document", async () => {
      await ensureMarketplacePolicy(
        { policyId: POLICY_ID, label: "Suite marketplace policy", now: NOW },
        pdeps(),
      );
      await expect(
        recordMarketplacePolicyVersion(
          {
            policyId: POLICY_ID,
            policyVersion: "9.9.9",
            contentRef: "marketplace-policy-test/9.9.9",
            requiresReacceptance: true,
            effectiveFrom: NOW,
            recordedByAccountId: REVIEWER,
            recordedAt: NOW,
          },
          pdeps(),
        ),
      ).rejects.toBeInstanceOf(PolicyVersionNotFoundError);
    });

    it("activates one version and retires the one it replaces", async () => {
      await seedActivePolicy(V1);
      await recordMarketplacePolicyVersion(
        {
          policyId: POLICY_ID,
          policyVersion: V2,
          contentRef: `marketplace-policy-test/${V2}`,
          requiresReacceptance: true,
          effectiveFrom: LATER,
          recordedByAccountId: REVIEWER,
          recordedAt: LATER,
        },
        pdeps(),
      );
      await activateMarketplacePolicyVersion(
        {
          policyId: POLICY_ID,
          policyVersion: V2,
          activatedByAccountId: REVIEWER,
          activatedAt: LATER,
        },
        pdeps(),
      );

      const rows = await db.marketplacePolicyVersionRow.findMany({
        where: { policyId: POLICY_ID },
        orderBy: { policyVersion: "asc" },
      });
      expect(rows.map((r) => [r.policyVersion, r.status])).toEqual([
        [V1, "RETIRED"],
        [V2, "ACTIVE"],
      ]);
      /* At most one ACTIVE, enforced by the index rather than by hoping. */
      expect(rows.filter((r) => r.activeMarker !== null)).toHaveLength(1);
      expect((await getActiveMarketplacePolicyVersion(POLICY_ID, pdeps()))?.policyVersion).toBe(V2);
      expect(rows.find((r) => r.policyVersion === V1)?.retiredAt).not.toBeNull();
    });

    it("will not bring a retired version back", async () => {
      await seedActivePolicy(V1);
      await recordMarketplacePolicyVersion(
        {
          policyId: POLICY_ID,
          policyVersion: V2,
          contentRef: `marketplace-policy-test/${V2}`,
          requiresReacceptance: true,
          effectiveFrom: LATER,
          recordedByAccountId: REVIEWER,
          recordedAt: LATER,
        },
        pdeps(),
      );
      await activateMarketplacePolicyVersion(
        { policyId: POLICY_ID, policyVersion: V2, activatedByAccountId: REVIEWER, activatedAt: LATER },
        pdeps(),
      );

      /* Reactivating a retired version would make "which terms applied when"
         unanswerable. */
      await expect(
        activateMarketplacePolicyVersion(
          {
            policyId: POLICY_ID,
            policyVersion: V1,
            activatedByAccountId: REVIEWER,
            activatedAt: LATEST,
          },
          pdeps(),
        ),
      ).rejects.toBeInstanceOf(PolicyError);
    });

    it("reads the active version with its content verified against the source", async () => {
      await seedActivePolicy(V1);
      const { version, document } = await readActiveMarketplacePolicy(POLICY_ID, pdeps());
      expect(version.policyVersion).toBe(V1);
      expect(document.sections.length).toBeGreaterThan(0);
    });

    it("refuses to serve a version whose stored prose has drifted", async () => {
      await seedActivePolicy(V1);
      /* Simulates the failure the hash exists to catch: the governance row now
         names content that no longer matches the source. */
      await db.marketplacePolicyVersionRow.updateMany({
        where: { policyId: POLICY_ID, policyVersion: V1 },
        data: { contentHash: `sha256:${"0".repeat(64)}` },
      });
      await expect(readMarketplacePolicy(POLICY_ID, V1, pdeps())).rejects.toMatchObject({
        code: "POLICY_CONTENT_MISMATCH",
      });
    });

    it("refuses when no version is active", async () => {
      await ensureMarketplacePolicy(
        { policyId: POLICY_ID, label: "Suite marketplace policy", now: NOW },
        pdeps(),
      );
      await expect(readActiveMarketplacePolicy(POLICY_ID, pdeps())).rejects.toBeInstanceOf(
        NoActivePolicyError,
      );
    });
  });

  // — 2. Acceptance —

  describe("2. participant policy acceptance", () => {
    it("records the exact version and content accepted", async () => {
      await seedActivePolicy(V1);
      const { accountId, participantId } = await seedParticipant(["SELLER"]);

      const { acceptance, alreadyAccepted } = await acceptAs(participantId, accountId, "SELLER");

      expect(alreadyAccepted).toBe(false);
      expect(acceptance.policyVersion).toBe(V1);
      expect(acceptance.audience).toBe("SELLER");
      /* "They accepted the terms" is worthless without "which terms". */
      expect(acceptance.contentHash).toBe(marketplacePolicyContentHash(V1_DOCUMENT));
      expect(acceptance.acceptedByAccountId).toBe(accountId);
    });

    it("is idempotent — accepting twice is one undertaking", async () => {
      await seedActivePolicy(V1);
      const { accountId, participantId } = await seedParticipant(["SELLER"]);
      const first = await acceptAs(participantId, accountId, "SELLER");
      const second = await acceptAs(participantId, accountId, "SELLER");

      expect(second.alreadyAccepted).toBe(true);
      expect(second.acceptance.acceptanceId).toBe(first.acceptance.acceptanceId);
      expect(
        await db.participantPolicyAcceptance.count({ where: { participantId } }),
      ).toBe(1);
    });

    it("treats seller and promoter as separate undertakings", async () => {
      await seedActivePolicy(V1);
      const { accountId, participantId } = await seedParticipant(["SELLER", "PROMOTER"]);
      await acceptAs(participantId, accountId, "SELLER");

      /* One acceptance standing in for the other would record an agreement
         nobody made. */
      expect(
        await outstandingAcceptanceAudiences(db, {
          participantId,
          policyId: POLICY_ID,
          policyVersion: V1,
          roles: ["SELLER", "PROMOTER"],
        }),
      ).toEqual(["PROMOTER"]);
    });

    it("keeps the historical acceptance when a new version activates", async () => {
      await seedActivePolicy(V1);
      const { accountId, participantId } = await seedParticipant(["SELLER"]);
      await acceptAs(participantId, accountId, "SELLER");

      await recordMarketplacePolicyVersion(
        {
          policyId: POLICY_ID,
          policyVersion: V2,
          contentRef: `marketplace-policy-test/${V2}`,
          requiresReacceptance: true,
          effectiveFrom: LATER,
          recordedByAccountId: REVIEWER,
          recordedAt: LATER,
        },
        pdeps(),
      );
      await activateMarketplacePolicyVersion(
        { policyId: POLICY_ID, policyVersion: V2, activatedByAccountId: REVIEWER, activatedAt: LATER },
        pdeps(),
      );

      /* The old acceptance is untouched — it is the only evidence of what was
         agreed, and rewriting it would destroy the thing acceptance is for. */
      const history = await listPolicyAcceptances(participantId, pdeps());
      expect(history).toHaveLength(1);
      expect(history[0].policyVersion).toBe(V1);
      expect(history[0].contentHash).toBe(marketplacePolicyContentHash(V1_DOCUMENT));

      /* And it does not satisfy the new version. */
      expect(
        await outstandingAcceptanceAudiences(db, {
          participantId,
          policyId: POLICY_ID,
          policyVersion: V2,
          roles: ["SELLER"],
        }),
      ).toEqual(["SELLER"]);

      /* Re-acceptance is a NEW row; both remain queryable. */
      await acceptAs(participantId, accountId, "SELLER", V2);
      const after = await listPolicyAcceptances(participantId, pdeps());
      expect(after.map((a) => a.policyVersion).sort()).toEqual([V1, V2]);
    });
  });

  // — 3. Email contacts and verification —

  describe("3. email verification", () => {
    it("registers a contact UNVERIFIED, whatever the caller wants", async () => {
      const { participantId } = await seedParticipant();
      const contact = await upsertEmailContact(
        { participantId, purpose: "PRIMARY_PROFILE", now: NOW },
        pdeps(),
      );
      expect(contact.state).toBe("UNVERIFIED");
      expect(contact.verifiedAt).toBeNull();
      /* 0M.5: the primary address lives on Account. Nothing copies it here. */
      expect(contact.address).toBeNull();
    });

    it("refuses to store a copy of the primary address", async () => {
      const { participantId, email } = await seedParticipant();
      await expect(
        upsertEmailContact(
          { participantId, purpose: "PRIMARY_PROFILE", address: email, now: NOW },
          pdeps(),
        ),
      ).rejects.toMatchObject({ code: "PRIMARY_ADDRESS_NOT_STORED" });
    });

    it("stores only the token digest, never the token", async () => {
      const { participantId, email } = await seedParticipant();
      await upsertEmailContact({ participantId, purpose: "PRIMARY_PROFILE", now: NOW }, pdeps());
      const { challenge, token } = await issueVerificationChallenge(
        { participantId, purpose: "PRIMARY_PROFILE", address: email, issuedAt: NOW },
        pdeps(),
      );

      expect(challenge.tokenDigest).toBe(hashVerificationToken(token));
      const row = await db.emailVerificationChallenge.findUnique({
        where: { id: challenge.challengeId },
      });
      /* A plaintext token column is a table of working account takeovers. */
      expect(JSON.stringify(row)).not.toContain(token);
      /* And the address is a digest too, so a challenge cannot be redirected. */
      expect(JSON.stringify(row)).not.toContain(email);

      /* It expires, and by the declared TTL. */
      const ttl = challenge.expiresAt
        ? (new Date(challenge.expiresAt).getTime() - new Date(challenge.issuedAt).getTime()) / 1000
        : 0;
      expect(ttl).toBe(VERIFICATION_TOKEN_TTL_SECONDS);
    });

    it("verifies the contact on consumption, and refuses a replay", async () => {
      const { participantId, email } = await seedParticipant();
      await upsertEmailContact({ participantId, purpose: "PRIMARY_PROFILE", now: NOW }, pdeps());
      const { token } = await issueVerificationChallenge(
        { participantId, purpose: "PRIMARY_PROFILE", address: email, issuedAt: NOW },
        pdeps(),
      );

      const verified = await consumeVerificationChallenge({ token, at: SOON }, pdeps());
      expect(verified.state).toBe("VERIFIED");
      expect(verified.verifiedAt).toBe(new Date(SOON).toISOString());

      /* Single-use. A link that works twice is a link that works for whoever
         finds it in a forwarded email. */
      await expect(
        consumeVerificationChallenge({ token, at: SOON }, pdeps()),
      ).rejects.toMatchObject({ reason: "ALREADY_CONSUMED" });
    });

    it("refuses an expired token and an unknown one identically", async () => {
      const { participantId, email } = await seedParticipant();
      await upsertEmailContact({ participantId, purpose: "PRIMARY_PROFILE", now: NOW }, pdeps());
      const { token } = await issueVerificationChallenge(
        { participantId, purpose: "PRIMARY_PROFILE", address: email, issuedAt: NOW },
        pdeps(),
      );
      const past = new Date(
        new Date(NOW).getTime() + (VERIFICATION_TOKEN_TTL_SECONDS + 60) * 1_000,
      ).toISOString();

      /* Distinguishing "expired" from "never existed" would make this an oracle
         for probing which tokens exist. */
      await expect(
        consumeVerificationChallenge({ token, at: past }, pdeps()),
      ).rejects.toMatchObject({ reason: "INVALID_OR_EXPIRED" });
      await expect(
        consumeVerificationChallenge({ token: "not-a-real-token", at: SOON }, pdeps()),
      ).rejects.toBeInstanceOf(VerificationRefusedError);

      const contact = await getEmailContact(participantId, "PRIMARY_PROFILE", pdeps());
      expect(contact?.state).toBe("UNVERIFIED");
    });

    it("supersedes an outstanding challenge when a new one is issued", async () => {
      const { participantId, email } = await seedParticipant();
      await upsertEmailContact({ participantId, purpose: "PRIMARY_PROFILE", now: NOW }, pdeps());
      const first = await issueVerificationChallenge(
        { participantId, purpose: "PRIMARY_PROFILE", address: email, issuedAt: NOW },
        pdeps(),
      );
      const second = await issueVerificationChallenge(
        { participantId, purpose: "PRIMARY_PROFILE", address: email, issuedAt: LATER },
        pdeps(),
      );

      /* Exactly one token is live at a time: an abandoned attempt cannot be
         completed later by someone else. */
      await expect(
        consumeVerificationChallenge({ token: first.token, at: SOON }, pdeps()),
      ).rejects.toMatchObject({ reason: "INVALID_OR_EXPIRED" });
      const verified = await consumeVerificationChallenge(
        { token: second.token, at: SOON },
        pdeps(),
      );
      expect(verified.state).toBe("VERIFIED");
    });

    it("un-verifies a dedicated address when it is replaced", async () => {
      const { participantId } = await seedParticipant();
      await upsertEmailContact(
        { participantId, purpose: "DEDICATED_SUPPORT", address: "help@example.invalid", now: NOW },
        pdeps(),
      );
      const { token } = await issueVerificationChallenge(
        {
          participantId,
          purpose: "DEDICATED_SUPPORT",
          address: "help@example.invalid",
          issuedAt: NOW,
        },
        pdeps(),
      );
      await consumeVerificationChallenge({ token, at: SOON }, pdeps());

      /* Typing a new address must not inherit the old one's verification. */
      const replaced = await upsertEmailContact(
        {
          participantId,
          purpose: "DEDICATED_SUPPORT",
          address: "helpdesk@example.invalid",
          now: LATEST,
        },
        pdeps(),
      );
      expect(replaced.state).toBe("UNVERIFIED");
      expect(replaced.verifiedAt).toBeNull();
    });
  });

  // — 4. Effective support contact —

  describe("4. seller support contact", () => {
    it("uses the verified primary address by default", async () => {
      const { participantId, email } = await seedParticipant();
      await verifyPrimary(participantId, email);

      /* A single-operator seller is never forced to run a second mailbox. */
      expect(await resolveSellerSupportContact(participantId, { db })).toEqual({
        available: true,
        address: email,
        source: "PRIMARY_PROFILE",
      });
    });

    it("prefers a verified dedicated address over the primary", async () => {
      const { participantId, email } = await seedParticipant();
      await verifyPrimary(participantId, email);
      await upsertEmailContact(
        { participantId, purpose: "DEDICATED_SUPPORT", address: "help@example.invalid", now: NOW },
        pdeps(),
      );
      const { token } = await issueVerificationChallenge(
        {
          participantId,
          purpose: "DEDICATED_SUPPORT",
          address: "help@example.invalid",
          issuedAt: NOW,
        },
        pdeps(),
      );
      await consumeVerificationChallenge({ token, at: SOON }, pdeps());

      expect(await resolveSellerSupportContact(participantId, { db })).toEqual({
        available: true,
        address: "help@example.invalid",
        source: "DEDICATED_SUPPORT",
      });
    });

    it("does not let an unverified dedicated address displace the primary", async () => {
      const { participantId, email } = await seedParticipant();
      await verifyPrimary(participantId, email);
      await upsertEmailContact(
        { participantId, purpose: "DEDICATED_SUPPORT", address: "typo@example.invalid", now: NOW },
        pdeps(),
      );

      /* Switching optimistically would make every typo an outage on the one
         channel a buyer uses to complain about it. */
      expect(await resolveSellerSupportContact(participantId, { db })).toMatchObject({
        available: true,
        address: email,
        source: "PRIMARY_PROFILE",
      });
    });

    it("reports no contact when nothing is verified", async () => {
      const { participantId } = await seedParticipant();
      await upsertEmailContact({ participantId, purpose: "PRIMARY_PROFILE", now: NOW }, pdeps());

      expect(await resolveSellerSupportContact(participantId, { db })).toEqual({
        available: false,
        reason: "NO_VERIFIED_ADDRESS",
      });
    });

    it("falls back to the primary when a dedicated address degrades", async () => {
      const { participantId, email } = await seedParticipant();
      await verifyPrimary(participantId, email);
      await upsertEmailContact(
        { participantId, purpose: "DEDICATED_SUPPORT", address: "help@example.invalid", now: NOW },
        pdeps(),
      );
      const { token } = await issueVerificationChallenge(
        {
          participantId,
          purpose: "DEDICATED_SUPPORT",
          address: "help@example.invalid",
          issuedAt: NOW,
        },
        pdeps(),
      );
      await consumeVerificationChallenge({ token, at: SOON }, pdeps());
      const degraded = await degradeEmailContact(
        { participantId, purpose: "DEDICATED_SUPPORT", to: "DELIVERY_FAILED", at: LATEST },
        pdeps(),
      );

      /* History is not rewritten: the instant it WAS verified is kept alongside
         the instant it stopped being trustworthy. */
      expect(degraded.verifiedAt).not.toBeNull();
      expect(degraded.degradedAt).toBe(new Date(LATEST).toISOString());
      expect(await resolveSellerSupportContact(participantId, { db })).toMatchObject({
        source: "PRIMARY_PROFILE",
      });
    });
  });

  // — 5. Activation —

  describe("5. activation prerequisites", () => {
    /** Everything a 0M.8 approval needs, minus the Phase 1.3 prerequisites. */
    async function seedSubmitted(roles: ("SELLER" | "PROMOTER")[]) {
      const { accountId, email, participantId } = await seedParticipant(roles);
      await completeProfile(participantId);
      await enableProvider(participantId);
      await submitParticipantForActivation({ participantId, submittedAt: NOW }, deps());
      return { accountId, email, participantId };
    }

    const approve = (participantId: string) =>
      decideParticipantActivation(
        {
          participantId,
          decision: "APPROVED",
          decisionReasonCode: "PREREQUISITES_SATISFIED",
          reviewerAccountId: REVIEWER,
          decidedAt: LATEST,
        },
        deps(),
      );

    /**
     * The activation path reads the SHIPPED policy identity, not this suite's.
     * These tests therefore assert the refusal side — which holds regardless of
     * whether a real policy has been activated in the disposable database — and
     * the support-contact side, which is participant-scoped and fully controlled.
     */
    it("refuses a seller who has not accepted the current policy", async () => {
      const { participantId, email } = await seedSubmitted(["SELLER"]);
      await verifyPrimary(participantId, email);

      const error = await approve(participantId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ActivationPrerequisitesNotMetError);
      expect((error as ActivationPrerequisitesNotMetError).refusalCodes).toContain(
        "MARKETPLACE_POLICY_NOT_ACCEPTED",
      );
    });

    it("refuses a promoter who has not accepted the current policy", async () => {
      const { participantId, email } = await seedSubmitted(["PROMOTER"]);
      await verifyPrimary(participantId, email);

      const error = await approve(participantId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ActivationPrerequisitesNotMetError);
      expect((error as ActivationPrerequisitesNotMetError).refusalCodes).toContain(
        "MARKETPLACE_POLICY_NOT_ACCEPTED",
      );
    });

    it("refuses a seller with no verified support contact", async () => {
      const { participantId } = await seedSubmitted(["SELLER"]);
      await upsertEmailContact({ participantId, purpose: "PRIMARY_PROFILE", now: NOW }, pdeps());

      /* An activated seller with nowhere for buyers to go. Fails closed. */
      const error = await approve(participantId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ActivationPrerequisitesNotMetError);
      expect((error as ActivationPrerequisitesNotMetError).refusalCodes).toContain(
        "NO_VERIFIED_SUPPORT_CONTACT",
      );
    });

    it("refuses both prerequisites at once, distinctly", async () => {
      const { participantId } = await seedSubmitted(["SELLER"]);

      /* Two different remedies — agreeing to something, and fixing a mailbox —
         so a reviewer is told both rather than one at a time. */
      const error = await approve(participantId).catch((e: unknown) => e);
      const codes = (error as ActivationPrerequisitesNotMetError).refusalCodes;
      expect(codes).toContain("MARKETPLACE_POLICY_NOT_ACCEPTED");
      expect(codes).toContain("NO_VERIFIED_SUPPORT_CONTACT");
      expect(codes).not.toContain("PROFILE_NOT_COMPLETE");
    });
  });
});
