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
import {
  activateSellerRefundPolicyVersion,
  ensureSellerRefundPolicy as ensureSellerRefundPolicyIdentity,
  getActiveSellerRefundPolicyVersion,
  readSellerRefundPolicyVersion,
  recordSellerRefundPolicyVersion,
} from "../../src/server/marketplace/seller-refund-policy-service";

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.9 correction — seller refund policy
//
// Checkout now binds the seller's ACTIVE refund-policy version, and REFUSES a
// sale it cannot bind. That is a real prerequisite on the same footing as `1.3`'s
// verified support contact, so it lives here for the same reason: satisfying it
// should be one call, and the *reason* a suite seeds one should be explained in
// one place rather than re-explained in every `seedSellerDirect`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Give one seller an ACTIVE refund policy, so their Listings can be sold.
 *
 * Idempotent and additive: the identity is upserted, version `1` recorded only if
 * absent, and activated only if nothing is active. Nothing here retires or
 * replaces a version, so suites cannot fight over one another's sellers.
 *
 * **The default terms are deliberately permissive and shipping-refundable**, so
 * that a suite which only wants a sale to complete gets the least surprising
 * economics: a full refund of such an Order returns the whole buyer charge, which
 * is what every pre-correction test already assumed. A suite testing the shipping
 * rule states its own `shippingRefundability` instead.
 */
export async function ensureSellerRefundPolicy(
  db: Db,
  input: {
    sellerParticipantId: string;
    recordedByAccountId: string;
    now: string;
    /** A deterministic `mon:srpol:` id, so a suite's rows stay identifiable. */
    policyId: string;
    shippingRefundability?: "ALWAYS_REFUNDED" | "NEVER_REFUNDED" | "REFUNDED_WHEN_SELLER_AT_FAULT";
    refundsAllowed?: boolean;
    refundWindowDays?: number | null;
  },
): Promise<{ policyId: string; policyVersion: string }> {
  const refundsAllowed = input.refundsAllowed ?? true;
  /* A window on a policy that refunds nothing is a term that can never apply, and
     `sellerRefundPolicyIssues` refuses one. */
  const refundWindowDays = refundsAllowed ? (input.refundWindowDays ?? null) : null;
  const shippingRefundability = input.shippingRefundability ?? "ALWAYS_REFUNDED";

  const policyId = await ensureSellerRefundPolicyIdentity(
    {
      sellerParticipantId: input.sellerParticipantId,
      label: "Returns policy",
      now: input.now,
    },
    { db, ids: { nextSellerRefundPolicyId: () => input.policyId } },
  );

  if ((await readSellerRefundPolicyVersion(policyId, "1", { db })) === null) {
    await recordSellerRefundPolicyVersion(
      {
        policyId,
        policyVersion: "1",
        sellerParticipantId: input.sellerParticipantId,
        terms: {
          refundsAllowed,
          eligibilityConditions: refundsAllowed ? ["ANY_REASON"] : [],
          refundWindowDays,
          shippingRefundability,
          procedureKind: "CONTACT_SELLER_SUPPORT",
        },
        document: {
          title: "Returns and refunds",
          sections: [
            {
              key: "SUMMARY",
              heading: "Summary",
              body: refundsAllowed
                ? "We accept returns for any reason."
                : "This seller does not offer refunds.",
            },
            ...(refundWindowDays === null
              ? []
              : [
                  {
                    key: "WINDOW" as const,
                    heading: "Time limit",
                    body: `Refunds may be requested within ${refundWindowDays} days of purchase.`,
                  },
                ]),
            {
              key: "SHIPPING" as const,
              heading: "Shipping charges",
              body:
                shippingRefundability === "NEVER_REFUNDED"
                  ? "Shipping charges are not refunded."
                  : "Shipping charges are refunded with the item.",
            },
            {
              key: "PROCEDURE" as const,
              heading: "How to request a refund",
              body: "Contact us at the support address on your receipt, quoting your order reference.",
            },
          ],
        },
        effectiveFrom: input.now,
        recordedByAccountId: input.recordedByAccountId,
        recordedAt: input.now,
      },
      { db },
    );
  }

  if ((await getActiveSellerRefundPolicyVersion(input.sellerParticipantId, { db })) === null) {
    await activateSellerRefundPolicyVersion(
      { policyId, policyVersion: "1", activatedAt: input.now },
      { db },
    );
  }

  return { policyId, policyVersion: "1" };
}
