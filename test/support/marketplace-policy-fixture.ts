/**
 * Shared Phase 1.3 activation-prerequisite fixture — TEST SUPPORT, not a test.
 *
 * Phase 1.3 gave activation two new prerequisites: the participant must have
 * accepted the **current** marketplace policy as each activatable role, and must
 * have a verified support contact. Both are real requirements, so every suite
 * that activates a participant has to satisfy them rather than route around them.
 *
 * This exists so that satisfying them is one call. It also means the *reason*
 * those suites now seed a policy lives in one place instead of being re-explained
 * in a comment in each of them.
 *
 * **The shipped policy identity, deliberately.** `assertActivationService` reads
 * `MONACADO_MARKETPLACE_POLICY_ID` — a fixture policy under some other id would
 * not satisfy it. Seeding is idempotent and additive: the identity is upserted,
 * the version recorded only if absent, and activated only if nothing is active.
 * Nothing here retires or replaces a version, so suites cannot fight over it.
 */

import type { getPrisma } from "../../src/server/db/client";
import {
  activateMarketplacePolicyVersion,
  ensureMarketplacePolicy,
  getActiveMarketplacePolicyVersion,
  getMarketplacePolicyVersion,
  recordMarketplacePolicyVersion,
} from "../../src/server/policy/marketplace-policy-service";
import { recordPolicyAcceptance } from "../../src/server/policy/policy-acceptance-service";
import {
  consumeVerificationChallenge,
  issueVerificationChallenge,
  upsertEmailContact,
} from "../../src/server/policy/email-verification-service";
import {
  MARKETPLACE_POLICY_CONTENT_REF_1,
  MARKETPLACE_POLICY_VERSION_1,
  MONACADO_MARKETPLACE_POLICY_ID,
} from "../../src/contracts/marketplace/marketplace-policy-content";
import { ACCEPTANCE_REQUIRED_AUDIENCES } from "../../src/contracts/marketplace/marketplace-policy";

type Db = ReturnType<typeof getPrisma>;

/**
 * Make the shipped policy's version 1 ACTIVE, if it is not already.
 *
 * Idempotent and safe to call from every `beforeEach` in every suite.
 */
export async function ensureShippedMarketplacePolicyActive(
  db: Db,
  input: { recordedByAccountId: string; now: string },
): Promise<{ policyId: string; policyVersion: string }> {
  await ensureMarketplacePolicy(
    { policyId: MONACADO_MARKETPLACE_POLICY_ID, label: "Monacado Marketplace Policy", now: input.now },
    { db },
  );

  const existing = await getMarketplacePolicyVersion(
    MONACADO_MARKETPLACE_POLICY_ID,
    MARKETPLACE_POLICY_VERSION_1,
    { db },
  );
  if (existing === null) {
    await recordMarketplacePolicyVersion(
      {
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1,
        contentRef: MARKETPLACE_POLICY_CONTENT_REF_1,
        requiresReacceptance: true,
        effectiveFrom: input.now,
        recordedByAccountId: input.recordedByAccountId,
        recordedAt: input.now,
      },
      { db },
    );
  }

  const active = await getActiveMarketplacePolicyVersion(MONACADO_MARKETPLACE_POLICY_ID, { db });
  if (active === null) {
    /* Self-heal a version a test retired.
     *
     * Retirement is one-way in the service, and rightly so — reactivating a
     * retired version would make "which terms applied when" unanswerable. A test
     * that exercises the no-ACTIVE-policy refusal therefore leaves the shared
     * row RETIRED, and without this every later test in that file would fail on
     * fixture state rather than on its own subject. Repaired at the row, which
     * is a thing only test support may do. */
    await db.marketplacePolicyVersionRow.updateMany({
      where: {
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1,
        status: "RETIRED",
      },
      data: { status: "DRAFT", retiredAt: null, activatedAt: null },
    });
    await activateMarketplacePolicyVersion(
      {
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1,
        activatedByAccountId: input.recordedByAccountId,
        activatedAt: input.now,
      },
      { db },
    );
  }

  return {
    policyId: MONACADO_MARKETPLACE_POLICY_ID,
    policyVersion: MARKETPLACE_POLICY_VERSION_1,
  };
}

/**
 * Accept the active policy for every activatable role held, and verify the
 * participant's primary address as their support contact.
 *
 * The verification goes through the real challenge flow — issue, then consume
 * the returned token — because a fixture that wrote `state: "VERIFIED"` directly
 * would be asserting the very thing verification exists to establish.
 */
export async function satisfyActivationPolicyPrerequisites(
  db: Db,
  input: {
    participantId: string;
    accountId: string;
    /**
     * The account's email. Optional — the primary support address lives on
     * `Account`, so it is read from there when a caller does not have it to hand.
     */
    address?: string;
    roles: readonly string[];
    now: string;
  },
): Promise<void> {
  const active = await getActiveMarketplacePolicyVersion(MONACADO_MARKETPLACE_POLICY_ID, { db });
  if (active !== null) {
    for (const audience of ACCEPTANCE_REQUIRED_AUDIENCES) {
      if (!input.roles.includes(audience)) continue;
      await recordPolicyAcceptance(
        {
          participantId: input.participantId,
          policyId: active.policyId,
          policyVersion: active.policyVersion,
          audience,
          mechanism: "ONBOARDING_AFFIRMATION",
          acceptedByAccountId: input.accountId,
          acceptedAt: input.now,
          recordedAt: input.now,
        },
        { db },
      );
    }
  }

  const account = await db.account.findUnique({
    where: { id: input.accountId },
    select: { email: true },
  });
  const address = input.address ?? account?.email;
  if (address === undefined || address === null) {
    throw new Error("satisfyActivationPolicyPrerequisites: no address for the account");
  }

  await upsertEmailContact(
    { participantId: input.participantId, purpose: "PRIMARY_PROFILE", now: input.now },
    { db },
  );
  const { token } = await issueVerificationChallenge(
    {
      participantId: input.participantId,
      purpose: "PRIMARY_PROFILE",
      address,
      issuedAt: input.now,
    },
    { db },
  );
  await consumeVerificationChallenge({ token, at: input.now }, { db });
}

/**
 * Verify a participant's primary profile address as their support contact.
 *
 * The narrower half of the fixture, for suites that transact but never activate:
 * Phase 1.3's checkout refuses a sale for a seller nobody can reach, and these
 * suites' sellers are made `ACTIVE` by direct update rather than through review.
 *
 * Records **no acceptance** — that is an activation prerequisite, and writing one
 * here would leave a `RESTRICT` row those suites' cleanups do not remove.
 */
export async function verifyPrimarySupportContact(
  db: Db,
  input: { participantId: string; accountId: string; now: string },
): Promise<void> {
  const account = await db.account.findUnique({
    where: { id: input.accountId },
    select: { email: true },
  });
  if (account === null) {
    throw new Error("verifyPrimarySupportContact: no such account");
  }

  await upsertEmailContact(
    { participantId: input.participantId, purpose: "PRIMARY_PROFILE", now: input.now },
    { db },
  );
  const { token } = await issueVerificationChallenge(
    {
      participantId: input.participantId,
      purpose: "PRIMARY_PROFILE",
      address: account.email,
      issuedAt: input.now,
    },
    { db },
  );
  await consumeVerificationChallenge({ token, at: input.now }, { db });
}

/**
 * Delete the Phase 1.3 rows hanging off a suite's participants.
 *
 * Called from a suite's own `cleanup()` **before** it deletes participants.
 * `ParticipantPolicyAcceptance` holds a `RESTRICT` key — it is evidence, and
 * evidence does not vanish because a row above it did — so a participant holding
 * one cannot be removed until it goes first. Contacts and challenges cascade, but
 * are deleted explicitly here so cleanup states what it removes rather than
 * relying on a constraint to remove it silently.
 */
export async function deleteParticipantPolicyRows(
  db: Db,
  participantIdPrefix: string,
): Promise<void> {
  const owned = { participantId: { startsWith: participantIdPrefix } };
  await db.emailVerificationChallenge.deleteMany({ where: owned });
  await db.participantEmailContact.deleteMany({ where: owned });
  await db.participantPolicyAcceptance.deleteMany({ where: owned });
}
