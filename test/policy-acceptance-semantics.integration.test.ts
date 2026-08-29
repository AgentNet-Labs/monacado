/**
 * Marketplace Policy acceptance semantics, integration (Phase 1.14 correction).
 *
 * ```
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://…@127.0.0.1:3308/monacado_phase0e2
 * ```
 *
 * Self-skips unless `RUN_DB_TESTS=1`. Never point at production. No provider
 * client appears in this file, and no policy is activated by it.
 *
 * Proves the half of Monacado's acceptance rule that was missing: an
 * already-active participant accepts an updated version by continuing to use the
 * marketplace after it takes effect, and that continued use is established from
 * records Monacado already keeps rather than from a click nobody asked for.
 */

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { recordPolicyAcceptance } from "../src/server/policy/policy-acceptance-service";
import {
  ensureMarketplacePolicy,
  recordMarketplacePolicyVersion,
} from "../src/server/policy/marketplace-policy-service";
import { evaluateContinuedUseAcceptance } from "../src/server/policy/continued-use-acceptance";
import {
  MARKETPLACE_POLICY_VERSION_1,
  MARKETPLACE_POLICY_VERSION_1_3,
  MONACADO_MARKETPLACE_POLICY_ID,
  MONACADO_MARKETPLACE_POLICY_V1_3_HASH,
} from "../src/contracts/marketplace/marketplace-policy-content";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);
const d = RUN ? describe : describe.skip;

const TAG = "P114A";
const ACCOUNT_EMAIL_PREFIX = "acceptance114-";
const PASSWORD = "correct-horse-battery-staple-114a";
const NOW = "2028-11-01T09:00:00.000Z";

/** When 1.3.0 takes effect. Acts before this prove nothing about it. */
const EFFECTIVE_FROM = "2028-12-01T00:00:00.000Z";
const BEFORE_EFFECTIVE = "2028-11-15T00:00:00.000Z";
const AFTER_EFFECTIVE = "2028-12-15T00:00:00.000Z";

let counter = 0;
const next = (): number => (counter += 1);
const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "0") + "0".repeat(26)).slice(0, 26);

let storefrontId = "";
let internalProductId = "";
let ownerId = "";

async function seedAccount(): Promise<string> {
  const account = await createAccount(
    {
      name: "Synthetic",
      email: `${ACCOUNT_EMAIL_PREFIX}${next()}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  return account.accountId;
}

async function seedParticipant(): Promise<{ participantId: string; accountId: string }> {
  const accountId = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: ["SELLER"], now: NOW },
    { db },
  );
  const participantId = snapshot.participant.participantId;
  await db.marketplaceParticipant.update({
    where: { id: participantId },
    data: { status: "ACTIVE" },
  });
  await db.marketplaceRoleAssignment.updateMany({
    where: { participantId },
    data: { status: "ACTIVE" },
  });
  return { participantId, accountId };
}

/** The minimum graph a Listing version can bind to. */
async function seedGraph(): Promise<void> {
  const owner = await seedParticipant();
  ownerId = owner.participantId;
  const n = next();
  internalProductId = `mon:product:${pad26(`${TAG}PR0D${n}`)}`;
  const sourceRecordId = `mon:srec:${pad26(`${TAG}PSREC${n}`)}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  storefrontId = `mon:storefront:${pad26(`${TAG}ST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId: storefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`${TAG}SFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId: ownerId,
      publicHandle: `p114a-shop-${n}`,
      lifecycle: "ACTIVE",
      visibility: "PUBLIC",
    },
  });
}

/**
 * One qualifying act: a Listing version this participant controlled, recorded at
 * a chosen instant. An authoritative record that already exists — no activity
 * ledger was invented for this.
 */
async function seedListingVersionFor(participantId: string, recordedAt: string): Promise<void> {
  const n = next();
  const internalListingId = `mon:listing:${pad26(`${TAG}LIST${n}`)}`;
  const listingSourceRecordId = `mon:srec:${pad26(`${TAG}LSREC${n}`)}`;
  await db.listing.create({
    data: {
      internalListingId,
      listingSourceRecordId,
      currentSourceRecordVersion: "1",
      storefrontId,
      internalProductId,
      controllingParticipantId: participantId,
      listingType: "SELLER_DIRECT",
      lifecycle: "ACTIVE",
    },
  });
  await db.listingSourceRecordVersionRow.create({
    data: {
      internalListingId,
      listingSourceRecordId,
      sourceRecordVersion: "1",
      sourceSystem: "monacado",
      sourceRecordType: "Listing",
      sourceClass: "governed-database-record",
      storefrontId,
      internalProductId,
      controllingParticipantId: participantId,
      listingType: "SELLER_DIRECT",
      retailPriceMinorUnits: BigInt(10_000),
      retailPriceCurrency: "USD",
      lifecycle: "ACTIVE",
      authorizedByParticipantId: participantId,
      authorizedByActorId: `mon:actor:${pad26(`${TAG}ACT${n}`)}`,
      recordedAt: new Date(recordedAt),
    },
  });
}

async function cleanup(): Promise<void> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: ACCOUNT_EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  const participants =
    accountIds.length === 0
      ? []
      : await db.marketplaceParticipant.findMany({
          where: { accountId: { in: accountIds } },
          select: { id: true },
        });
  const ids = participants.map((p) => p.id);

  await db.listingSourceRecordVersionRow.deleteMany({
    where: { internalListingId: { startsWith: `mon:listing:${TAG}` } },
  });
  await db.listing.deleteMany({
    where: { internalListingId: { startsWith: `mon:listing:${TAG}` } },
  });
  await db.storefront.deleteMany({
    where: { internalStorefrontId: { startsWith: `mon:storefront:${TAG}` } },
  });
  await db.product.deleteMany({
    where: { internalProductId: { startsWith: `mon:product:${TAG}` } },
  });
  if (ids.length > 0) {
    await db.participantPolicyAcceptance.deleteMany({ where: { participantId: { in: ids } } });
    await db.notificationObligation.deleteMany({
      where: { recipientParticipantId: { in: ids } },
    });
    await db.participantActivation.deleteMany({ where: { participantId: { in: ids } } });
    await db.participantProfile.deleteMany({ where: { participantId: { in: ids } } });
    await db.marketplaceRoleAssignment.deleteMany({ where: { participantId: { in: ids } } });
    await db.marketplaceParticipant.deleteMany({ where: { id: { in: ids } } });
  }
  await db.marketplacePolicyVersionRow.deleteMany({
    where: {
      policyId: MONACADO_MARKETPLACE_POLICY_ID,
      policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
    },
  });
  if (accountIds.length > 0) {
    await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }
}

d("Marketplace Policy acceptance semantics (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seedGraph();
    await ensureMarketplacePolicy(
      {
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        label: "Monacado Marketplace Policy",
        now: NOW,
      },
      { db },
    );
    const existing = await db.marketplacePolicyVersionRow.findUnique({
      where: {
        policyId_policyVersion: {
          policyId: MONACADO_MARKETPLACE_POLICY_ID,
          policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
        },
      },
    });
    if (existing === null) {
      /* RECORDED as a draft. Nothing here activates it. */
      await recordMarketplacePolicyVersion(
        {
          policyId: MONACADO_MARKETPLACE_POLICY_ID,
          policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
          contentRef: "marketplace-policy/1.3.0",
          requiresReacceptance: true,
          effectiveFrom: EFFECTIVE_FROM,
          recordedByAccountId: (await seedAccount()),
          recordedAt: NOW,
        },
        { db },
      );
    }
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("records a new participant's explicit acceptance at onboarding", async () => {
    const { participantId, accountId } = await seedParticipant();
    const recorded = await recordPolicyAcceptance(
      {
        participantId,
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1,
        audience: "SELLER",
        mechanism: "ONBOARDING_AFFIRMATION",
        acceptedByAccountId: accountId,
        acceptedAt: NOW,
        recordedAt: NOW,
      },
      { db },
    );
    expect(recorded.acceptance.mechanism).toBe("ONBOARDING_AFFIRMATION");
    expect(recorded.acceptance.policyVersion).toBe(MARKETPLACE_POLICY_VERSION_1);
    /* Attributable: the version and the exact content hash it bound. */
    expect(recorded.acceptance.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("establishes acceptance from continued use after the effective date", async () => {
    const { participantId, accountId } = await seedParticipant();
    await seedListingVersionFor(participantId, AFTER_EFFECTIVE);

    const finding = await evaluateContinuedUseAcceptance(
      {
        participantId,
        policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
        effectiveFrom: EFFECTIVE_FROM,
      },
      { db },
    );
    expect(finding.established).toBe(true);
    expect(finding.evidence).toContain("LISTING_SOURCE_VERSION_AUTHORED");
    /* Acceptance happened when they acted, not when anybody asked. */
    expect(finding.firstQualifyingAt).toBe(AFTER_EFFECTIVE);

    /* And it is recordable through the existing acceptance path, as its own
       mechanism — never disguised as a click nobody made. */
    const recorded = await recordPolicyAcceptance(
      {
        participantId,
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
        audience: "SELLER",
        mechanism: "CONTINUED_USE_AFTER_NOTICE",
        acceptedByAccountId: accountId,
        acceptedAt: finding.firstQualifyingAt!,
        recordedAt: AFTER_EFFECTIVE,
      },
      { db },
    );
    expect(recorded.acceptance.mechanism).toBe("CONTINUED_USE_AFTER_NOTICE");
    expect(recorded.acceptance.contentHash).toBe(MONACADO_MARKETPLACE_POLICY_V1_3_HASH);
  });

  it("does not establish acceptance from use before the effective date", async () => {
    /* A participant who traded busily under the old version and stopped the day
       the new one took effect has accepted nothing — which is exactly what the
       policy tells a participant who does not agree to do. */
    const { participantId } = await seedParticipant();
    await seedListingVersionFor(participantId, BEFORE_EFFECTIVE);

    const finding = await evaluateContinuedUseAcceptance(
      {
        participantId,
        policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
        effectiveFrom: EFFECTIVE_FROM,
      },
      { db },
    );
    expect(finding.established).toBe(false);
    expect(finding.evidence).toEqual([]);
    expect(finding.firstQualifyingAt).toBeNull();
  });

  it("cannot establish one participant's acceptance from another's activity", async () => {
    const active = await seedParticipant();
    const bystander = await seedParticipant();
    await seedListingVersionFor(active.participantId, AFTER_EFFECTIVE);

    const finding = await evaluateContinuedUseAcceptance(
      {
        participantId: bystander.participantId,
        policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
        effectiveFrom: EFFECTIVE_FROM,
      },
      { db },
    );
    expect(finding.established).toBe(false);
    expect(finding.evidence).toEqual([]);
  });

  it("requires no second affirmative acceptance from an already-active participant", async () => {
    /* The correction, stated as an assertion. A participant whose only explicit
       acceptance is 1.0.0 keeps their ACTIVE status and gains no restriction
       when 1.3.0 exists — nothing re-gates them, and nothing marks them
       delinquent for not clicking again. */
    const { participantId, accountId } = await seedParticipant();
    await recordPolicyAcceptance(
      {
        participantId,
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1,
        audience: "SELLER",
        mechanism: "ONBOARDING_AFFIRMATION",
        acceptedByAccountId: accountId,
        acceptedAt: NOW,
        recordedAt: NOW,
      },
      { db },
    );

    const before = await db.marketplaceParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { status: true },
    });
    await seedListingVersionFor(participantId, AFTER_EFFECTIVE);
    const after = await db.marketplaceParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { status: true },
    });

    expect(after.status).toBe(before.status);
    expect(after.status).toBe("ACTIVE");
    expect(await db.participantRestriction.count({ where: { participantId } })).toBe(0);
    expect(await db.participantSuspension.count({ where: { participantId } })).toBe(0);
    /* Their 1.0.0 acceptance stands, unaltered by a later version existing. */
    const acceptances = await db.participantPolicyAcceptance.findMany({
      where: { participantId },
    });
    expect(acceptances).toHaveLength(1);
    expect(acceptances[0]!.policyVersion).toBe(MARKETPLACE_POLICY_VERSION_1);
  });

  it("keeps every acceptance attributable to a version, a hash, and an actor", async () => {
    const { participantId, accountId } = await seedParticipant();
    await recordPolicyAcceptance(
      {
        participantId,
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
        audience: "SELLER",
        mechanism: "CONTINUED_USE_AFTER_NOTICE",
        acceptedByAccountId: accountId,
        acceptedAt: AFTER_EFFECTIVE,
        recordedAt: AFTER_EFFECTIVE,
      },
      { db },
    );
    const row = await db.participantPolicyAcceptance.findFirstOrThrow({
      where: { participantId },
    });
    expect(row.policyVersion).toBe("1.3.0");
    expect(row.contentHash).toBe(MONACADO_MARKETPLACE_POLICY_V1_3_HASH);
    expect(row.acceptedByAccountId).toBe(accountId);
    expect(row.acceptedAt.toISOString()).toBe(AFTER_EFFECTIVE);
    /* The version row carries the effective date the rule turns on. */
    const version = await db.marketplacePolicyVersionRow.findUniqueOrThrow({
      where: {
        policyId_policyVersion: {
          policyId: MONACADO_MARKETPLACE_POLICY_ID,
          policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
        },
      },
    });
    expect(version.effectiveFrom.toISOString()).toBe(EFFECTIVE_FROM);
    expect(version.status).toBe("DRAFT");
  });
});
