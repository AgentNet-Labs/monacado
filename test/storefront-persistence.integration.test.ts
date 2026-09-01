/**
 * Storefront persistence and governance integration tests (Phase 0M.3C).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0d
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Instants and identities are injected, so nothing depends on a real
 * clock. Every value is synthetic; no real personal data appears.
 *
 * The test that matters most is the round-trip one: a persisted source version
 * must reconstruct into the exact contract shape the existing Storefront capsule
 * projection already consumes, and must produce a byte-identical capsule to the
 * equivalent in-memory source. That is the whole reason this phase exists.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  registerParticipantPaymentAccount,
  recordObservedProviderState,
} from "../src/server/marketplace/payment-account-service";
import { recordCommerceApproval } from "../src/server/marketplace/participant-commerce-approval-service";
import { imposeParticipantRestriction } from "../src/server/marketplace/participant-restriction-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import {
  assignStorefrontGovernance,
  createDraftStorefront,
  createStorefrontSourceVersion,
  evaluateStorefrontReadiness,
  getCurrentSourceVersion,
  getSourceVersion,
  getStorefront,
  listGovernanceAssignments,
  listSourceVersions,
  setGovernanceAssignmentStatus,
} from "../src/server/marketplace/storefront-service";
import {
  DuplicatePublicHandleError,
  DuplicateSourceVersionError,
  GovernanceAssignmentNotFoundError,
  InvalidStorefrontInputError,
  NoMaterialChangeError,
  OwnerParticipantNotFoundError,
  StorefrontNotAuthorizedError,
  StorefrontNotFoundError,
  StorefrontVersionNotFoundError,
  SuperOwnerAlreadyActiveError,
} from "../src/server/marketplace/storefront-errors";
import { STOREFRONT_ID_PATTERNS } from "../src/server/marketplace/storefront-ids";
import { versionRowToSourceVersion } from "../src/server/marketplace/storefront-mapper";
import { StorefrontSourceVersion } from "../src/contracts/marketplace/storefront-source";
import { NEVER_ON_STOREFRONT_RECORD } from "../src/contracts/marketplace/storefront-record";
import { storefrontSourceRecordToCapsuleProjection } from "../src/contracts/marketplace/storefront.projection";
import { syntheticStorefrontProjectionContext } from "../src/contracts/fixtures/synthetic-storefront";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2027-09-01T09:00:00.000Z";
const LATER = "2027-09-02T09:00:00.000Z";
const PASSWORD = "correct-horse-battery-staple-9271";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

let seq = 0;
const nextHandle = (): string => {
  seq += 1;
  return `synthetic-shop-${seq}`;
};

async function cleanup(): Promise<void> {
  // Every marketplace FK is RESTRICT, so children go before parents. The order
  // documents the delete rules.
  await db.storefrontGovernanceAssignment.deleteMany({});
  await db.storefrontSourceRecordVersionRow.deleteMany({});
  await db.storefront.deleteMany({});
  await db.participantActivation.deleteMany({});
  await db.participantProfile.deleteMany({});
  await db.marketplaceRoleAssignment.deleteMany({});
  /* Phase 1.14 — a governed decision about a participant now raises a notice
     obligation, whose recipient FK is RESTRICT. A suite that wipes participants
     globally must wipe this too, or it is blocked by any decision another suite
     legitimately recorded. */
  await db.notificationObligation.deleteMany({});
  /* Phase 1.15, Ruling 2 — going live now requires the owner to be payable and
     approved, so this suite creates payment-account and commerce-approval rows.
     Both RESTRICT to the participant and must come off first. */
  await db.participantCommerceApproval.deleteMany({});
  await db.participantPaymentAccount.deleteMany({});
  await db.participantReconsideration.deleteMany({});
  await db.participantSuspension.deleteMany({});
  await db.participantRestriction.deleteMany({});
  await db.marketplaceParticipant.deleteMany({});
  await db.accountEntitlement.deleteMany({});
  await db.accountSession.deleteMany({});
  await db.account.deleteMany({});
}

/** A participant holding an active SELLER role, able to draft a Storefront. */
async function seedSeller(): Promise<string> {
  seq += 1;
  const account = await createAccount(
    {
      name: "Synthetic Seller",
      email: `seller${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const snapshot = await createDraftParticipant(
    { accountId: account.accountId, initialRoles: ["SELLER"], now: NOW },
    { db },
  );
  return snapshot.participant.participantId;
}

/**
 * The account that owns a participant — the authoritative account→participant
 * relation, read back rather than remembered.
 *
 * Phase 1.18 removed `authorizedByParticipantId` and
 * `actorAuthorizedForOwnerParticipant` from every Storefront input: a caller no
 * longer names which participant it is, nor asserts that the participant was
 * authorized. A fixture that wants to act AS a participant must therefore sign
 * in as the account that owns it, which is what this resolves. Supplying a
 * stranger's account is how a test now expresses "unauthorized".
 */
async function accountFor(participantId: string): Promise<string> {
  const row = await db.marketplaceParticipant.findUnique({ where: { id: participantId } });
  if (row === null) throw new Error(`no participant ${participantId}`);
  return row.accountId;
}

const presentation = (overrides: Record<string, unknown> = {}) => ({
  displayName: "Synthetic Example Shop",
  tagline: "A synthetic storefront used only for tests.",
  summary: "This storefront exists solely as a Phase 0M.3C fixture.",
  ...overrides,
});

/** `JSON.stringify` refuses BigInt, and version rows carry a BigInt `seq`. */
const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

async function seedStorefront(overrides: Record<string, unknown> = {}) {
  const ownerParticipantId = (overrides.ownerParticipantId as string) ?? (await seedSeller());
  const snapshot = await createDraftStorefront(
    {
      ownerParticipantId,
      publicHandle: nextHandle(),
      presentation: presentation(),
      actingAccountId: await accountFor(ownerParticipantId),
      now: NOW,
      ...overrides,
    },
    { db },
  );
  return { ownerParticipantId, snapshot };
}

/**
 * Create a Storefront AND appoint its owner as the first active SUPER_OWNER.
 *
 * Creating a Storefront deliberately confers **no** governance authority: 0M.3A
 * keeps ownership and governance on separate axes, and
 * `canEditStorefrontPresentation` requires a governance assignment. An owner who
 * wants to edit must first appoint a SUPER_OWNER — which they may do for
 * themselves, and which the service permits only while none exists.
 */
async function seedGovernedStorefront(overrides: Record<string, unknown> = {}) {
  const seeded = await seedStorefront(overrides);
  await assignStorefrontGovernance(
    {
      internalStorefrontId: seeded.snapshot.record.internalStorefrontId,
      participantId: seeded.ownerParticipantId,
      role: "SUPER_OWNER",
      actingAccountId: await accountFor(seeded.ownerParticipantId),
      now: NOW,
    },
    { db },
  );
  return seeded;
}

/**
 * Make a Storefront owner eligible to GO LIVE (Phase 1.15, Ruling 2).
 *
 * Taking a Storefront live is reserved to the active `SUPER_OWNER` and gated on
 * the owner being admitted, payable, and approved — the authority the source
 * model always specified (§7) and that production code only began honouring in
 * Phase 1.15. Before then every lifecycle move ran through the presentation-edit
 * decision, which asks for none of this, so these fixtures never had to supply
 * it.
 *
 * Governance authority is arranged by the callers that need it; this supplies
 * the commercial half.
 */
async function makeOwnerGoLiveEligible(ownerParticipantId: string): Promise<void> {
  await db.marketplaceParticipant.update({
    where: { id: ownerParticipantId },
    data: { status: "ACTIVE" },
  });
  await db.marketplaceRoleAssignment.updateMany({
    where: { participantId: ownerParticipantId },
    data: { status: "ACTIVE" },
  });

  const ref = `acct_${pad26(`M3CPAY${(seq += 1)}`)}`;
  await registerParticipantPaymentAccount(
    { participantId: ownerParticipantId, provider: "STRIPE", providerAccountRef: ref, now: NOW },
    { db },
  );
  const base = { participantId: ownerParticipantId, provider: "STRIPE" as const, providerAccountRef: ref };
  for (const readiness of ["DETAILS_REQUIRED", "PENDING_PROVIDER", "ENABLED"] as const) {
    await recordObservedProviderState(
      { ...base, readiness, outstandingRequirements: [], observedAt: NOW },
      { db },
    );
  }

  const approverAccount = await createAccount(
    {
      name: "Synthetic Approver",
      email: `approver${(seq += 1)}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const approver = approverAccount.accountId;
  await grantAccountEntitlement(
    { accountId: approver, capability: "participant:commerce-approve", grantedAt: NOW },
    { db },
  );
  await recordCommerceApproval(
    {
      participantId: ownerParticipantId,
      decision: "APPROVED",
      reasonCode: "REQUIREMENTS_MET",
      actingAccountId: approver,
      decidedAt: NOW,
    },
    { db },
  );
}

describe.skipIf(!RUN)("Storefront persistence and governance (disposable MySQL)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — 1-4. Creation and the stable/version split —

  it("1/2. creates a draft Storefront with an opaque stable identity", async () => {
    const { snapshot } = await seedStorefront();
    const { record } = snapshot;

    expect(STOREFRONT_ID_PATTERNS.storefront.test(record.internalStorefrontId)).toBe(true);
    expect(STOREFRONT_ID_PATTERNS.sourceRecord.test(record.storefrontSourceRecordId)).toBe(true);
    expect(record.internalStorefrontId).not.toBe(record.storefrontSourceRecordId);
    expect(record.lifecycle).toBe("DRAFT");
    expect(record.visibility).toBe("PRIVATE");
  });

  it("3. persists the first immutable source version", async () => {
    const { snapshot } = await seedStorefront();
    const versions = await listSourceVersions(snapshot.record.internalStorefrontId, { db });

    expect(versions).toHaveLength(1);
    expect(versions[0]!.sourceRecordVersion).toBe("1");
    expect(versions[0]!.supersedesSourceRecordVersion).toBeNull();
  });

  it("4. points the stable row at the current source version", async () => {
    const { snapshot } = await seedStorefront();
    expect(snapshot.record.currentSourceRecordVersion).toBe(
      snapshot.currentVersion.sourceRecordVersion,
    );

    const row = await db.storefront.findUnique({
      where: { internalStorefrontId: snapshot.record.internalStorefrontId },
    });
    expect(row!.currentSourceRecordVersion).toBe("1");
  });

  it("refuses malformed input by field path, echoing no value", async () => {
    const error = await createDraftStorefront(
      {
        ownerParticipantId: "not-a-participant",
        publicHandle: "Not A Handle",
        presentation: presentation(),
        actingAccountId: "acct_never_resolved_parse_fails_first",
        now: NOW,
      },
      { db },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(InvalidStorefrontInputError);
    expect(error.fields).toContain("ownerParticipantId");
    expect(JSON.stringify(error)).not.toContain("not-a-participant");
  });

  // — 5. Exact source reconstruction —

  it("5. round-trips a persisted version exactly into the source contract", async () => {
    const { ownerParticipantId, snapshot } = await seedStorefront();

    const row = await db.storefrontSourceRecordVersionRow.findFirst({
      where: { internalStorefrontId: snapshot.record.internalStorefrontId },
    });
    const reconstructed = versionRowToSourceVersion(row!);

    // It validates as the canonical contract, with nothing added or dropped.
    expect(StorefrontSourceVersion.safeParse(reconstructed).success).toBe(true);
    expect(reconstructed).toEqual({
      storefrontSourceRecordId: snapshot.record.storefrontSourceRecordId,
      sourceRecordVersion: "1",
      supersedesSourceRecordVersion: null,
      internalStorefrontId: snapshot.record.internalStorefrontId,
      sourceSystem: "monacado",
      sourceRecordType: "Storefront",
      sourceClass: "governed-database-record",
      ownerParticipantId,
      lifecycle: "DRAFT",
      visibility: "PRIVATE",
      publicHandle: snapshot.record.publicHandle,
      presentation: presentation(),
      /* The RESOLVED actor participant, not a claimed one: Phase 1.18 writes
         the authorization trace from the acting account's own participant. */
      authorizedByParticipantId: ownerParticipantId,
      /* The resolved acting account (Phase 1.18). */
      authorizedByActorId: await accountFor(ownerParticipantId),
      recordedAt: NOW,
    });
  });

  it("22/23/24. round-trips presentation, authorization trace, and recordedAt exactly", async () => {
    const custom = presentation({ tagline: null, summary: null });
    const owner = await seedSeller();
    const { snapshot } = await seedStorefront({
      ownerParticipantId: owner,
      presentation: custom,
    });

    const version = await getCurrentSourceVersion(snapshot.record.internalStorefrontId, { db });
    expect(version.presentation).toEqual(custom);
    expect(version.presentation.tagline).toBeNull();
    expect(version.authorizedByParticipantId).toBe(owner);
    /* The resolved acting account (Phase 1.18). */
    expect(version.authorizedByActorId).toBe(await accountFor(owner));
    expect(version.recordedAt).toBe(NOW);
  });

  // — 6-10. Immutable history —

  it("7/9/25. a material update mints a new version and advances the pointer", async () => {
    const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
    const id = snapshot.record.internalStorefrontId;

    const after = await createStorefrontSourceVersion(
      {
        internalStorefrontId: id,
        sourceRecordVersion: "2",
        presentation: presentation({ displayName: "Renamed Shop" }),
        actingAccountId: await accountFor(ownerParticipantId),
        now: LATER,
      },
      { db },
    );

    expect(after.record.currentSourceRecordVersion).toBe("2");
    expect(after.currentVersion.presentation.displayName).toBe("Renamed Shop");
    // 25. lineage preserved
    expect(after.currentVersion.supersedesSourceRecordVersion).toBe("1");

    const versions = await listSourceVersions(id, { db });
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
  });

  it("6/8. the prior version is unchanged and remains readable", async () => {
    const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
    const id = snapshot.record.internalStorefrontId;
    const before = await getSourceVersion(id, "1", { db });

    await createStorefrontSourceVersion(
      {
        internalStorefrontId: id,
        sourceRecordVersion: "2",
        presentation: presentation({ displayName: "Renamed Shop" }),
        actingAccountId: await accountFor(ownerParticipantId),
        now: LATER,
      },
      { db },
    );

    const afterUpdate = await getSourceVersion(id, "1", { db });
    expect(afterUpdate).toEqual(before);
    expect(afterUpdate.presentation.displayName).toBe("Synthetic Example Shop");
    expect(afterUpdate.recordedAt).toBe(NOW);
  });

  it("10. an update changing nothing material mints no version", async () => {
    const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
    const id = snapshot.record.internalStorefrontId;

    await expect(
      createStorefrontSourceVersion(
        {
          internalStorefrontId: id,
          sourceRecordVersion: "2",
          presentation: presentation(),
          actingAccountId: await accountFor(ownerParticipantId),
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(NoMaterialChangeError);

    expect(await listSourceVersions(id, { db })).toHaveLength(1);
  });

  it("refuses a version label that already exists", async () => {
    const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
    await expect(
      createStorefrontSourceVersion(
        {
          internalStorefrontId: snapshot.record.internalStorefrontId,
          sourceRecordVersion: "1",
          presentation: presentation({ displayName: "Renamed" }),
          actingAccountId: await accountFor(ownerParticipantId),
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(DuplicateSourceVersionError);
  });

  it("refuses an unknown Storefront or version", async () => {
    await expect(
      getStorefront(`mon:storefront:${pad26("NOSUCH")}`, { db }),
    ).rejects.toBeInstanceOf(StorefrontNotFoundError);

    const { snapshot } = await seedStorefront();
    await expect(
      getSourceVersion(snapshot.record.internalStorefrontId, "99", { db }),
    ).rejects.toBeInstanceOf(StorefrontVersionNotFoundError);
  });

  // — 11/12. Owner FK —

  it("11/12. refuses a Storefront whose owner participant does not exist", async () => {
    /* A real acting account: the owner is what must be missing, and resolving
       the actor from a participant that does not exist would test the fixture
       rather than the foreign key. */
    const actor = await seedSeller();
    await expect(
      createDraftStorefront(
        {
          ownerParticipantId: `mon:mpart:${pad26("NOSUCHPART")}`,
          publicHandle: nextHandle(),
          presentation: presentation(),
          actingAccountId: await accountFor(actor),
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(OwnerParticipantNotFoundError);
  });

  // — 18/19. Public handle —

  it("18. enforces handle shape at the contract boundary", async () => {
    const owner = await seedSeller();
    for (const bad of ["Bad Handle", "-leading", "trailing-", "double--hyphen", "ab"]) {
      await expect(
        createDraftStorefront(
          {
            ownerParticipantId: owner,
            publicHandle: bad,
            presentation: presentation(),
            actingAccountId: await accountFor(owner),
            now: NOW,
          },
          { db },
        ),
      ).rejects.toBeInstanceOf(InvalidStorefrontInputError);
    }
  });

  it("19. enforces handle uniqueness across current Storefronts", async () => {
    const handle = nextHandle();
    await seedStorefront({ publicHandle: handle });

    const other = await seedSeller();
    await expect(
      createDraftStorefront(
        {
          ownerParticipantId: other,
          publicHandle: handle,
          presentation: presentation(),
          actingAccountId: await accountFor(other),
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(DuplicatePublicHandleError);
  });

  it("preserves the handle each version actually authorized", async () => {
    const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
    const id = snapshot.record.internalStorefrontId;
    const originalHandle = snapshot.record.publicHandle;
    const newHandle = nextHandle();

    await createStorefrontSourceVersion(
      {
        internalStorefrontId: id,
        sourceRecordVersion: "2",
        publicHandle: newHandle,
        actingAccountId: await accountFor(ownerParticipantId),
        now: LATER,
      },
      { db },
    );

    // History keeps what was authorized then; the stable record moves on.
    expect((await getSourceVersion(id, "1", { db })).publicHandle).toBe(originalHandle);
    expect((await getSourceVersion(id, "2", { db })).publicHandle).toBe(newHandle);
    expect((await getStorefront(id, { db })).record.publicHandle).toBe(newHandle);
  });

  // — 13-15. Governance —

  it("13. persists a governance assignment", async () => {
    const { ownerParticipantId, snapshot } = await seedStorefront();
    const id = snapshot.record.internalStorefrontId;

    const assignment = await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: ownerParticipantId,
        role: "SUPER_OWNER",
        actingAccountId: await accountFor(ownerParticipantId),
        now: NOW,
      },
      { db },
    );

    expect(STOREFRONT_ID_PATTERNS.governanceAssignment.test(assignment.governanceAssignmentId)).toBe(
      true,
    );
    expect(assignment.role).toBe("SUPER_OWNER");
    expect(assignment.status).toBe("ACTIVE");
    expect(await listGovernanceAssignments(id, { db })).toHaveLength(1);
  });

  it("14. refuses a second active SUPER_OWNER", async () => {
    const { ownerParticipantId, snapshot } = await seedStorefront();
    const id = snapshot.record.internalStorefrontId;
    const second = await seedSeller();

    await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: ownerParticipantId,
        role: "SUPER_OWNER",
        actingAccountId: await accountFor(ownerParticipantId),
        now: NOW,
      },
      { db },
    );

    await expect(
      assignStorefrontGovernance(
        {
          internalStorefrontId: id,
          participantId: second,
          role: "SUPER_OWNER",
          actingAccountId: await accountFor(ownerParticipantId),
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(SuperOwnerAlreadyActiveError);
  });

  it("14b. frees the SUPER_OWNER seat when the incumbent is revoked", async () => {
    const { ownerParticipantId, snapshot } = await seedStorefront();
    const id = snapshot.record.internalStorefrontId;
    const successor = await seedSeller();

    await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: ownerParticipantId,
        role: "SUPER_OWNER",
        actingAccountId: await accountFor(ownerParticipantId),
        now: NOW,
      },
      { db },
    );

    const revoked = await setGovernanceAssignmentStatus(
      {
        internalStorefrontId: id,
        participantId: ownerParticipantId,
        status: "REVOKED",
        actingAccountId: await accountFor(ownerParticipantId),
        now: LATER,
      },
      { db },
    );
    // Revocation is a state change, not a delete — history survives.
    expect(revoked.status).toBe("REVOKED");
    expect(revoked.revokedAt).toBe(LATER);
    expect(await listGovernanceAssignments(id, { db })).toHaveLength(1);

    const replacement = await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: successor,
        role: "SUPER_OWNER",
        actingAccountId: await accountFor(ownerParticipantId),
        now: LATER,
      },
      { db },
    );
    expect(replacement.status).toBe("ACTIVE");
  });

  it("15. permits many ADMINs alongside one SUPER_OWNER", async () => {
    const { ownerParticipantId, snapshot } = await seedStorefront();
    const id = snapshot.record.internalStorefrontId;

    await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: ownerParticipantId,
        role: "SUPER_OWNER",
        actingAccountId: await accountFor(ownerParticipantId),
        now: NOW,
      },
      { db },
    );

    for (let i = 0; i < 2; i += 1) {
      await assignStorefrontGovernance(
        {
          internalStorefrontId: id,
          participantId: await seedSeller(),
          role: "ADMIN",
          actingAccountId: await accountFor(ownerParticipantId),
          now: LATER,
        },
        { db },
      );
    }

    const assignments = await listGovernanceAssignments(id, { db });
    expect(assignments.filter((a) => a.role === "ADMIN")).toHaveLength(2);
    expect(assignments.filter((a) => a.role === "SUPER_OWNER")).toHaveLength(1);
  });

  it("refuses a status change for an assignment that does not exist", async () => {
    const { ownerParticipantId, snapshot } = await seedStorefront();
    await expect(
      setGovernanceAssignmentStatus(
        {
          internalStorefrontId: snapshot.record.internalStorefrontId,
          participantId: ownerParticipantId,
          status: "SUSPENDED",
          actingAccountId: await accountFor(ownerParticipantId),
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(GovernanceAssignmentNotFoundError);
  });

  it("creating a Storefront confers no governance authority", () => {
    /* Ownership and governance are separate axes (0M.3A). A freshly created
       Storefront has no assignment at all, so its owner cannot edit it until a
       SUPER_OWNER is appointed — which the owner may do for themselves. */
    return (async () => {
      const { ownerParticipantId, snapshot } = await seedStorefront();
      const id = snapshot.record.internalStorefrontId;

      expect(await listGovernanceAssignments(id, { db })).toEqual([]);

      const denied = await createStorefrontSourceVersion(
        {
          internalStorefrontId: id,
          sourceRecordVersion: "2",
          presentation: presentation({ displayName: "Too Soon" }),
          actingAccountId: await accountFor(ownerParticipantId),
          now: LATER,
        },
        { db },
      ).catch((e) => e);
      expect(denied).toBeInstanceOf(StorefrontNotAuthorizedError);
      expect(denied.reasonCodes).toContain("GOVERNANCE_ASSIGNMENT_REQUIRED");

      // After self-appointment the same edit is permitted.
      await assignStorefrontGovernance(
        {
          internalStorefrontId: id,
          participantId: ownerParticipantId,
          role: "SUPER_OWNER",
          actingAccountId: await accountFor(ownerParticipantId),
          now: NOW,
        },
        { db },
      );
      const after = await createStorefrontSourceVersion(
        {
          internalStorefrontId: id,
          sourceRecordVersion: "2",
          presentation: presentation({ displayName: "Now Permitted" }),
          actingAccountId: await accountFor(ownerParticipantId),
          now: LATER,
        },
        { db },
      );
      expect(after.currentVersion.presentation.displayName).toBe("Now Permitted");
    })();
  });

  it("refuses a non-owner appointing the first SUPER_OWNER", async () => {
    const { snapshot } = await seedStorefront();
    const stranger = await seedSeller();
    await expect(
      assignStorefrontGovernance(
        {
          internalStorefrontId: snapshot.record.internalStorefrontId,
          participantId: stranger,
          role: "SUPER_OWNER",
          actingAccountId: await accountFor(stranger),
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(StorefrontNotAuthorizedError);
  });

  it("refuses the revoke-then-appoint seizure a claimed participant id used to allow", async () => {
    /* Phase 1.18. Through 1.17, `assignStorefrontGovernance` and
       `setGovernanceAssignmentStatus` compared the caller's OWN
       `authorizedByParticipantId` against the stored owner id and treated
       equality as authority — a string comparison against a value the caller
       supplied. Knowing one opaque id was therefore a two-step takeover of any
       Storefront: revoke the incumbent SUPER_OWNER while "acting as owner", which
       drops the active count to zero, then appoint yourself through the
       first-SUPER_OWNER bootstrap branch.

       Both halves are refused now, because the acting participant is resolved
       from the authenticated account and never claimed. */
    const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
    const id = snapshot.record.internalStorefrontId;
    const attacker = await seedSeller();

    // Step one: revoke the incumbent while claiming to be the owner.
    await expect(
      setGovernanceAssignmentStatus(
        {
          internalStorefrontId: id,
          participantId: ownerParticipantId,
          status: "REVOKED",
          actingAccountId: await accountFor(attacker),
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(StorefrontNotAuthorizedError);

    // Step two: appoint yourself. Refused on its own terms as well.
    await expect(
      assignStorefrontGovernance(
        {
          internalStorefrontId: id,
          participantId: attacker,
          role: "SUPER_OWNER",
          actingAccountId: await accountFor(attacker),
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(StorefrontNotAuthorizedError);

    // The incumbent still stands, and the attacker holds nothing.
    const assignments = await listGovernanceAssignments(id, { db });
    const incumbent = assignments.find((a) => a.participantId === ownerParticipantId);
    expect(incumbent?.status).toBe("ACTIVE");
    expect(incumbent?.role).toBe("SUPER_OWNER");
    expect(assignments.some((a) => a.participantId === attacker)).toBe(false);
  });

  it("refuses a DISABLED account administering governance, owner or not", async () => {
    /* The two governance commands hand-roll their authority test instead of
       reaching `actorProblem`, which is where every other Storefront path asks
       whether the account is enabled at all. The status was resolved and never
       read, so a disabled account was refused presentation edits, activation and
       stand-down — and could still appoint and revoke governance, which is the
       authority that hands all the others back. */
    const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
    const id = snapshot.record.internalStorefrontId;
    const ownerAccount = await accountFor(ownerParticipantId);
    const candidate = await seedSeller();

    await db.account.update({ where: { id: ownerAccount }, data: { status: "DISABLED" } });

    const appoint = await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: candidate,
        role: "ADMIN",
        actingAccountId: ownerAccount,
        now: LATER,
      },
      { db },
    ).catch((e) => e);
    expect(appoint).toBeInstanceOf(StorefrontNotAuthorizedError);
    expect(appoint.reasonCodes).toContain("ACCOUNT_DISABLED");

    const revoke = await setGovernanceAssignmentStatus(
      {
        internalStorefrontId: id,
        participantId: ownerParticipantId,
        status: "REVOKED",
        actingAccountId: ownerAccount,
        now: LATER,
      },
      { db },
    ).catch((e) => e);
    expect(revoke).toBeInstanceOf(StorefrontNotAuthorizedError);
    expect(revoke.reasonCodes).toContain("ACCOUNT_DISABLED");

    // Nothing was appointed, and the incumbent still stands.
    const assignments = await listGovernanceAssignments(id, { db });
    expect(assignments.some((a) => a.participantId === candidate)).toBe(false);
    expect(assignments.find((a) => a.participantId === ownerParticipantId)?.status).toBe("ACTIVE");

    // Re-enabled, the same owner may administer governance again.
    await db.account.update({ where: { id: ownerAccount }, data: { status: "ACTIVE" } });
    const allowed = await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: candidate,
        role: "ADMIN",
        actingAccountId: ownerAccount,
        now: LATER,
      },
      { db },
    );
    expect(allowed.role).toBe("ADMIN");
  });

  // — 16/17. Authorization —

  it("16. refuses a stranger naming another participant as owner (Phase 1.18)", async () => {
    /* What this test asserted through Phase 1.17 is no longer expressible: the
       denial came from a supplied `actorAuthorizedForOwnerParticipant: false`,
       and an owner acting as themselves is now correctly authorized because
       self-ownership is the authoritative basis. The forgery it stood in for is
       asserted directly instead — a stranger cannot create a Storefront owned by
       someone else, and knowing the owner's participant id does not help. */
    const owner = await seedSeller();
    const stranger = await seedSeller();

    const error = await createDraftStorefront(
      {
        ownerParticipantId: owner,
        publicHandle: nextHandle(),
        presentation: presentation(),
        actingAccountId: await accountFor(stranger),
        now: NOW,
      },
      { db },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(StorefrontNotAuthorizedError);
    expect(error.reasonCodes).toContain("ACTOR_NOT_AUTHORIZED_FOR_OWNER");

    // And the owner acting as themselves still succeeds.
    const allowed = await createDraftStorefront(
      {
        ownerParticipantId: owner,
        publicHandle: nextHandle(),
        presentation: presentation(),
        actingAccountId: await accountFor(owner),
        now: NOW,
      },
      { db },
    );
    expect(allowed.record.ownerParticipantId).toBe(owner);
  });

  it("16b. refuses a stranger with no governance assignment", async () => {
    const { snapshot } = await seedStorefront();
    const stranger = await seedSeller();

    const error = await createStorefrontSourceVersion(
      {
        internalStorefrontId: snapshot.record.internalStorefrontId,
        sourceRecordVersion: "2",
        presentation: presentation({ displayName: "Hijacked" }),
        actingAccountId: await accountFor(stranger),
        now: LATER,
      },
      { db },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(StorefrontNotAuthorizedError);
    expect(error.reasonCodes.length).toBeGreaterThan(0);
    // The version was not minted.
    expect(
      await listSourceVersions(snapshot.record.internalStorefrontId, { db }),
    ).toHaveLength(1);
  });

  it("17. permits an ADMIN governance holder to edit presentation", async () => {
    const { ownerParticipantId, snapshot } = await seedStorefront();
    const id = snapshot.record.internalStorefrontId;
    const admin = await seedSeller();

    await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: ownerParticipantId,
        role: "SUPER_OWNER",
        actingAccountId: await accountFor(ownerParticipantId),
        now: NOW,
      },
      { db },
    );
    await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: admin,
        role: "ADMIN",
        actingAccountId: await accountFor(ownerParticipantId),
        now: NOW,
      },
      { db },
    );

    const after = await createStorefrontSourceVersion(
      {
        internalStorefrontId: id,
        sourceRecordVersion: "2",
        presentation: presentation({ displayName: "Edited By Admin" }),
        actingAccountId: await accountFor(admin),
        now: LATER,
      },
      { db },
    );
    expect(after.currentVersion.presentation.displayName).toBe("Edited By Admin");
    expect(after.currentVersion.authorizedByParticipantId).toBe(admin);
  });

  // — 20/21. Lifecycle and visibility —

  it("20. refuses a lifecycle move the 0M.3A table forbids", async () => {
    const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
    const error = await createStorefrontSourceVersion(
      {
        internalStorefrontId: snapshot.record.internalStorefrontId,
        sourceRecordVersion: "2",
        // DRAFT -> SUSPENDED is not a permitted transition.
        lifecycle: "SUSPENDED",
        actingAccountId: await accountFor(ownerParticipantId),
        now: LATER,
      },
      { db },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(StorefrontNotAuthorizedError);
    expect(error.reasonCodes).toContain("STOREFRONT_LIFECYCLE_TRANSITION_NOT_PERMITTED");
  });

  it("20b/21. records a permitted lifecycle and visibility change", async () => {
    const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
    const id = snapshot.record.internalStorefrontId;
    /* Phase 1.15, Ruling 2 — going live is the SUPER_OWNER's act, and it is
       gated on the owner being admitted, payable, and approved. */
    await makeOwnerGoLiveEligible(ownerParticipantId);

    const after = await createStorefrontSourceVersion(
      {
        internalStorefrontId: id,
        sourceRecordVersion: "2",
        lifecycle: "ACTIVE",
        visibility: "PUBLIC",
        actingAccountId: await accountFor(ownerParticipantId),
        now: LATER,
      },
      { db },
    );
    expect(after.currentVersion.lifecycle).toBe("ACTIVE");
    expect(after.currentVersion.visibility).toBe("PUBLIC");
  });

  // — Phase 1.15, Ruling 2 · going live is the SUPER_OWNER's act —

  describe("storefront activation authority", () => {
    /** Appoint a separate participant as ADMIN on an already-governed shop. */
    async function seedAdminOn(internalStorefrontId: string, ownerParticipantId: string) {
      const admin = await seedSeller();
      await assignStorefrontGovernance(
        {
          internalStorefrontId,
          participantId: admin,
          role: "ADMIN",
          actingAccountId: await accountFor(ownerParticipantId),
          now: NOW,
        },
        { db },
      );
      return admin;
    }

    const goLive = async (id: string, actor: string, version = "2") =>
      await createStorefrontSourceVersion(
        {
          internalStorefrontId: id,
          sourceRecordVersion: version,
          lifecycle: "ACTIVE",
          actingAccountId: await accountFor(actor),
          now: LATER,
        },
        { db },
      );

    it("permits the active SUPER_OWNER when otherwise eligible", async () => {
      const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
      await makeOwnerGoLiveEligible(ownerParticipantId);

      const after = await goLive(snapshot.record.internalStorefrontId, ownerParticipantId);
      expect(after.currentVersion.lifecycle).toBe("ACTIVE");
    });

    it("refuses an ADMIN acting alone", async () => {
      /* The authoritative source model §7: an ADMIN may not "activate the
         Storefront". The boundary is recorded as data in
         SUPER_OWNER_EXCLUSIVE_AUTHORITIES, and until Phase 1.15 production code
         authorised every lifecycle move with the PRESENTATION decision, which
         admits an ADMIN. */
      const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
      const id = snapshot.record.internalStorefrontId;
      await makeOwnerGoLiveEligible(ownerParticipantId);
      const admin = await seedAdminOn(id, ownerParticipantId);

      const error = await goLive(id, admin).catch((e) => e);
      expect(error).toBeInstanceOf(StorefrontNotAuthorizedError);
      expect(error.reasonCodes).toContain("SUPER_OWNER_REQUIRED");

      /* And the Storefront did not move. */
      const row = await db.storefront.findUniqueOrThrow({ where: { internalStorefrontId: id } });
      expect(row.lifecycle).toBe("DRAFT");
    });

    it("still lets an ADMIN edit presentation", async () => {
      /* The correction must not narrow authority an ADMIN legitimately holds. */
      const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
      const id = snapshot.record.internalStorefrontId;
      const admin = await seedAdminOn(id, ownerParticipantId);

      const after = await createStorefrontSourceVersion(
        {
          internalStorefrontId: id,
          sourceRecordVersion: "2",
          presentation: presentation({ displayName: "Admin Still Edits" }),
          actingAccountId: await accountFor(admin),
          now: LATER,
        },
        { db },
      );
      expect(after.currentVersion.presentation.displayName).toBe("Admin Still Edits");
    });

    it("refuses an ADMIN standing a Storefront down — SUPER_OWNER-exclusive", async () => {
      /* Phase 1.18. 0M.3A names `storefront:suspend`, `storefront:close` and
         `storefront:visibility:deactivate` SUPER_OWNER-exclusive, and 0M.3C wrote
         `canSuspendStorefrontRecord`, `canCloseStorefrontRecord` and
         `canReduceStorefrontExposure` to enforce it — but none of the three had a
         call site. Every non-go-live, non-widening version fell through to the
         presentation gate, which admits an ADMIN, so an ADMIN could suspend or
         close a shop outright. Each branch is asserted separately, because each
         was reached by a different route through the same missing wiring. */
      const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
      const id = snapshot.record.internalStorefrontId;
      await makeOwnerGoLiveEligible(ownerParticipantId);
      await goLive(id, ownerParticipantId);
      /* Widened by the SUPER_OWNER first, so that reducing exposure is a
         material change rather than a no-op the service refuses for a
         different reason. */
      await createStorefrontSourceVersion(
        {
          internalStorefrontId: id,
          sourceRecordVersion: "3",
          visibility: "PUBLIC",
          actingAccountId: await accountFor(ownerParticipantId),
          now: LATER,
        },
        { db },
      );
      const admin = await seedAdminOn(id, ownerParticipantId);

      for (const [version, change] of [
        ["4", { lifecycle: "SUSPENDED" as const }],
        ["5", { lifecycle: "CLOSED" as const }],
        ["6", { visibility: "PRIVATE" as const }],
      ] as const) {
        await expect(
          createStorefrontSourceVersion(
            {
              internalStorefrontId: id,
              sourceRecordVersion: version,
              ...change,
              actingAccountId: await accountFor(admin),
              now: LATER,
            },
            { db },
          ),
        ).rejects.toBeInstanceOf(StorefrontNotAuthorizedError);
      }

      // The shop is untouched: no version was minted by any of the three.
      expect(await listSourceVersions(id, { db })).toHaveLength(3);

      // And the SUPER_OWNER may still do it, so the rule narrowed nobody else.
      const suspended = await createStorefrontSourceVersion(
        {
          internalStorefrontId: id,
          sourceRecordVersion: "4",
          lifecycle: "SUSPENDED",
          actingAccountId: await accountFor(ownerParticipantId),
          now: LATER,
        },
        { db },
      );
      expect(suspended.currentVersion.lifecycle).toBe("SUSPENDED");
    });

    it("refuses a SUPER_OWNER whose owner is restricted from taking a shop live", async () => {
      /* Governance authority and participant standing are independent gates, and
         Phase 1.15's standing check runs AFTER governance authorization rather
         than instead of it. */
      const { ownerParticipantId, snapshot } = await seedGovernedStorefront();
      await makeOwnerGoLiveEligible(ownerParticipantId);

      const restrictor = await createAccount(
        {
          name: "Synthetic Restrictor",
          email: `restrictor${(seq += 1)}@example.com`,
          password: PASSWORD,
          createdAt: NOW,
        },
        { db },
      );
      await grantAccountEntitlement(
        { accountId: restrictor.accountId, capability: "participant:restrict", grantedAt: NOW },
        { db },
      );
      await imposeParticipantRestriction(
        {
          participantId: ownerParticipantId,
          scope: "storefront:activate",
          reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
          actingAccountId: restrictor.accountId,
          imposedAt: NOW,
        },
        { db },
      );

      /* Imposing reconciles the participant to RESTRICTED, so the commerce gate
         inside `canActivateStorefrontRecord` refuses first. That is correct, and
         it is the ordinary path. */
      const byStatus = await goLive(
        snapshot.record.internalStorefrontId,
        ownerParticipantId,
      ).catch((e) => e);
      expect(byStatus).toBeInstanceOf(StorefrontNotAuthorizedError);
      expect(byStatus.reasonCodes).toContain("PARTICIPANT_NOT_ACTIVATED");

      /* Now the case that makes Phase 1.15's seam load-bearing rather than
         redundant: status ACTIVE while a restriction still stands.
         
         This divergence is reachable today — an activation review approves to
         ACTIVE without reckoning with standing restrictions, which is the
         inconsistency Phase 1.15 deferred rather than reinterpreting 0M.8's
         refusal to write RESTRICTED. It is SAFE precisely because the enforcement
         seams read the authoritative restriction ROWS rather than the derived
         status, and this asserts that. */
      await db.marketplaceParticipant.update({
        where: { id: ownerParticipantId },
        data: { status: "ACTIVE" },
      });

      const byScope = await goLive(
        snapshot.record.internalStorefrontId,
        ownerParticipantId,
      ).catch((e) => e);
      expect(byScope.denialCode).toBe("ACTION_RESTRICTED");
      expect(byScope.deniedCapability).toBe("storefront:activate");

      /* And the Storefront did not go live by either route. */
      const row = await db.storefront.findUniqueOrThrow({
        where: { internalStorefrontId: snapshot.record.internalStorefrontId },
      });
      expect(row.lifecycle).toBe("DRAFT");
    });
  });

  // — Readiness and the go-live boundary —

  it("derives readiness from a SUPPLIED approval, storing none", async () => {
    const { ownerParticipantId, snapshot } = await seedStorefront();
    const id = snapshot.record.internalStorefrontId;
    await makeOwnerGoLiveEligible(ownerParticipantId);

    await assignStorefrontGovernance(
      {
        internalStorefrontId: id,
        participantId: ownerParticipantId,
        role: "SUPER_OWNER",
        actingAccountId: await accountFor(ownerParticipantId),
        now: NOW,
      },
      { db },
    );
    await createStorefrontSourceVersion(
      {
        internalStorefrontId: id,
        sourceRecordVersion: "2",
        lifecycle: "ACTIVE",
        visibility: "PUBLIC",
        actingAccountId: await accountFor(ownerParticipantId),
        now: LATER,
      },
      { db },
    );

    const approved = await evaluateStorefrontReadiness(id, "APPROVED", { db });
    const notApproved = await evaluateStorefrontReadiness(id, "NOT_APPROVED", { db });

    expect(approved.activeSuperOwnerCardinality).toBe("EXACTLY_ONE");
    expect(approved.live).toBe(true);
    expect(notApproved.live).toBe(false);

    // No approval column exists to have stored it.
    const row = await db.storefront.findUnique({ where: { internalStorefrontId: id } });
    expect(safeStringify(row)).not.toContain("pprov");
    expect(Object.keys(row!)).not.toContain("goLiveApproved");
  });

  // — 26/27. Delete behaviour —

  it("26. refuses to delete a participant that owns a Storefront", async () => {
    const { ownerParticipantId } = await seedStorefront();
    await expect(
      db.marketplaceParticipant.delete({ where: { id: ownerParticipantId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("27. refuses to delete a Storefront that has immutable history", async () => {
    const { snapshot } = await seedStorefront();
    await expect(
      db.storefront.delete({
        where: { internalStorefrontId: snapshot.record.internalStorefrontId },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    // History intact.
    expect(
      await listSourceVersions(snapshot.record.internalStorefrontId, { db }),
    ).toHaveLength(1);
  });

  it("27b. refuses to delete a participant holding a governance assignment", async () => {
    const { ownerParticipantId, snapshot } = await seedStorefront();
    const admin = await seedSeller();
    await assignStorefrontGovernance(
      {
        internalStorefrontId: snapshot.record.internalStorefrontId,
        participantId: ownerParticipantId,
        role: "SUPER_OWNER",
        actingAccountId: await accountFor(ownerParticipantId),
        now: NOW,
      },
      { db },
    );
    await assignStorefrontGovernance(
      {
        internalStorefrontId: snapshot.record.internalStorefrontId,
        participantId: admin,
        role: "ADMIN",
        actingAccountId: await accountFor(ownerParticipantId),
        now: NOW,
      },
      { db },
    );

    await expect(
      db.marketplaceParticipant.delete({ where: { id: admin } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  // — 28. Privacy —

  it("28. persists no private, payment, risk, or approval field", async () => {
    const { snapshot } = await seedStorefront();
    const stable = await db.storefront.findUnique({
      where: { internalStorefrontId: snapshot.record.internalStorefrontId },
    });
    const version = await db.storefrontSourceRecordVersionRow.findFirst({
      where: { internalStorefrontId: snapshot.record.internalStorefrontId },
    });

    const columns = [...Object.keys(stable!), ...Object.keys(version!)];
    for (const forbidden of NEVER_ON_STOREFRONT_RECORD) {
      expect(columns).not.toContain(forbidden);
    }

    const serialized = safeStringify({ stable, version }).toLowerCase();
    for (const leaked of ["@example.com", PASSWORD.toLowerCase(), "stripe", "underwriting", "risk"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  // — 29/30. Projection compatibility — the reason for the phase —

  it("29/30. a persisted source version feeds the existing projection mapper", async () => {
    const { snapshot } = await seedGovernedStorefront();
    const id = snapshot.record.internalStorefrontId;
    const owner = snapshot.record.ownerParticipantId;
    await makeOwnerGoLiveEligible(owner);

    // Make it projectable: ACTIVE + PUBLIC.
    await createStorefrontSourceVersion(
      {
        internalStorefrontId: id,
        sourceRecordVersion: "2",
        lifecycle: "ACTIVE",
        visibility: "PUBLIC",
        actingAccountId: await accountFor(owner),
        now: LATER,
      },
      { db },
    );

    const persisted = await getCurrentSourceVersion(id, { db });

    /* Synthetic Registrar-issued bindings — TEST ONLY. No Node is issued or
       stored by this phase; the projection takes them as supplied inputs. */
    const base = syntheticStorefrontProjectionContext();
    const context = {
      ...base,
      storefrontBinding: {
        storefrontNode: base.storefrontBinding.storefrontNode,
        internalStorefrontId: persisted.internalStorefrontId,
      },
      ownerBinding: {
        ownerAuthorityNode: base.ownerBinding.ownerAuthorityNode,
        ownerParticipantId: persisted.ownerParticipantId,
      },
      sourceVersionBinding: {
        storefrontSourceRecordId: persisted.storefrontSourceRecordId,
        sourceRecordVersion: persisted.sourceRecordVersion,
      },
    };

    const fromPersisted = storefrontSourceRecordToCapsuleProjection({
      sourceVersion: persisted,
      context,
    });
    expect(fromPersisted.data.publicHandle).toBe(persisted.publicHandle);
    expect(fromPersisted.data.name).toBe(persisted.presentation.displayName);
    expect(fromPersisted.data.discoverable).toBe(true);

    // 30. An equivalent in-memory source produces a byte-identical capsule.
    const inMemory = StorefrontSourceVersion.parse({ ...persisted });
    const fromMemory = storefrontSourceRecordToCapsuleProjection({
      sourceVersion: inMemory,
      context,
    });
    expect(fromMemory).toEqual(fromPersisted);
    expect(fromMemory.metadata.contentHash).toBe(fromPersisted.metadata.contentHash);

    // No internal identifier reached the capsule.
    const serialized = JSON.stringify(fromPersisted.data);
    expect(serialized).not.toContain("mon:storefront:");
    expect(serialized).not.toContain("mon:mpart:");
  });

  // — 31/32. Scope —

  it("31/32. issues no Node and writes no publication row", async () => {
    await seedStorefront();
    expect(await db.productPublication.count()).toBe(0);
    expect(await db.publicationOutbox.count()).toBe(0);
    expect(await db.registrarReceipt.count()).toBe(0);
    // There is no Storefront Node table at all.
    expect(Object.keys(db)).not.toContain("storefrontNode");
  });
});
