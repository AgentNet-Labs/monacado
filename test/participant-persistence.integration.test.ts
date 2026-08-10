/**
 * Marketplace participant persistence integration tests (Phase 0M.5).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0d
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Instants and identities are injected, so nothing here depends on a
 * real clock. Every value is synthetic; no real personal data appears.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import { ProductRepository } from "../src/server/product/product-repository";
import type { ProductSourceRecord } from "../src/contracts/index";
import {
  advanceParticipantStatus,
  assignParticipantRole,
  createDraftParticipant,
  getParticipant,
  getParticipantProfile,
  materializeMarketplaceSubject,
  updateParticipantProfile,
} from "../src/server/marketplace/participant-service";
import {
  ActivationNotPermittedInPhaseError,
  DuplicateParticipantError,
  InvalidParticipantInputError,
  InvalidParticipantTransitionError,
  ParticipantNotFoundError,
  CorruptParticipantRecordError,
} from "../src/server/marketplace/participant-errors";
import { PARTICIPANT_ID_PATTERNS } from "../src/server/marketplace/participant-ids";
import { participantRowToRecord } from "../src/server/marketplace/participant-mapper";
import {
  canAccrueCommission,
  canActivateStorefront,
  canCreateDraftProduct,
  canCreateDraftStorefront,
  canCreatePromotedListing,
  canPublishOffer,
  canPublishProductReviewCapsule,
  canPublishSellerReviewCapsule,
  canReceivePayout,
  canSubmitActivation,
  canSubmitProductReview,
  canSubmitSellerReview,
} from "../src/contracts/marketplace/capability";
import { GUEST_SUBJECT } from "../src/contracts/marketplace/participant";
import { findParticipantPrivacyViolations } from "../src/contracts/marketplace/participant-record";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);
const repo = RUN ? new ProductRepository(db) : (undefined as unknown as ProductRepository);

const NOW = "2027-06-01T09:00:00.000Z";
const LATER = "2027-06-02T09:00:00.000Z";
const PASSWORD = "correct-horse-battery-staple-9271";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

let seq = 0;
const nextTag = (): string => {
  seq += 1;
  return pad26(`M5${seq}PART`);
};

async function cleanup(): Promise<void> {
  // Order matters and documents the delete rules: every marketplace FK into
  // Product history and Account is RESTRICT, so children go before parents.
  await db.productPublication.deleteMany({});
  await db.productSourceRecordVersionRow.deleteMany({});
  await db.productNode.deleteMany({});
  await db.product.deleteMany({});
  await db.participantActivation.deleteMany({});
  await db.participantProfile.deleteMany({});
  await db.marketplaceRoleAssignment.deleteMany({});
  await db.marketplaceParticipant.deleteMany({});
  await db.accountEntitlement.deleteMany({});
  await db.accountSession.deleteMany({});
  await db.account.deleteMany({});
}

async function seedAccount(): Promise<string> {
  seq += 1;
  const account = await createAccount(
    {
      name: "Synthetic Person",
      email: `participant${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  return account.accountId;
}

async function seedDraft(roles: ("SELLER" | "PROMOTER" | "BUYER")[] = ["SELLER"]) {
  const accountId = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: roles, now: NOW },
    { db },
  );
  return { accountId, snapshot };
}

/** A synthetic Product source record carrying a legacy `mon:creator:` authority. */
function syntheticProduct(overrides: Partial<ProductSourceRecord> = {}): ProductSourceRecord {
  const tag = nextTag();
  return {
    sourceRecordId: `mon:srec:${tag}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${tag}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${tag}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
      authorizationRef: "mon:authz:synthetic-0m5",
    },
    facts: {
      name: "Synthetic Participant-Phase Product",
      description: "Synthetic Phase 0M.5 integration fixture.",
      image: "https://monacado.com/media/synthetic/participant.png",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      specifications: { os: "cross-platform" },
      capabilities: ["scaffold"],
      relationships: { creator: `an:node:${tag}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0d.1.0.0",
    recordStatus: "authoring-complete",
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
    acquiredAt: "2027-01-01T00:00:00.000Z",
    capsuleGeneratedAt: "2027-01-01T06:30:00.000Z",
    ...overrides,
  };
}

describe.skipIf(!RUN)("marketplace participant persistence (disposable MySQL)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — Creation —

  it("creates a draft participant with an opaque id, DRAFT status, and no activation", async () => {
    const { snapshot } = await seedDraft([]);

    expect(PARTICIPANT_ID_PATTERNS.participant.test(snapshot.participant.participantId)).toBe(true);
    expect(snapshot.participant.status).toBe("DRAFT");
    expect(snapshot.roles).toEqual([]);
    expect(snapshot.latestActivation).toBeNull();

    // The participant id is not the account id, and does not contain it.
    expect(snapshot.participant.participantId).not.toBe(snapshot.participant.accountId);
    expect(snapshot.participant.participantId).not.toContain(
      snapshot.participant.accountId.replace("mon:acct:", ""),
    );
  });

  it("refuses a second participant for the same account", async () => {
    const accountId = await seedAccount();
    await createDraftParticipant({ accountId, initialRoles: ["BUYER"], now: NOW }, { db });

    await expect(
      createDraftParticipant({ accountId, initialRoles: ["SELLER"], now: NOW }, { db }),
    ).rejects.toBeInstanceOf(DuplicateParticipantError);

    expect(await db.marketplaceParticipant.count({ where: { accountId } })).toBe(1);
  });

  it("refuses a participant for an account that does not exist", async () => {
    await expect(
      createDraftParticipant(
        { accountId: `mon:acct:${pad26("NOSUCHACCT")}`, initialRoles: [], now: NOW },
        { db },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND_FOR_PARTICIPANT" });
  });

  it("rejects malformed creation input by field path, echoing no value", async () => {
    const error = await createDraftParticipant(
      { accountId: "not-an-account-id", initialRoles: [], now: NOW },
      { db },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(InvalidParticipantInputError);
    expect(error.fields).toContain("accountId");
    expect(JSON.stringify(error)).not.toContain("not-an-account-id");
  });

  // — Roles —

  it("grants SELLER, PROMOTER, and BUYER additively to one participant", async () => {
    const { snapshot } = await seedDraft(["SELLER", "PROMOTER", "BUYER"]);

    expect(snapshot.roles.map((r) => r.role).sort()).toEqual(["BUYER", "PROMOTER", "SELLER"]);
    // One participant, three roles — never three participants.
    expect(await db.marketplaceParticipant.count()).toBe(1);
  });

  it("starts SELLER and PROMOTER as DRAFT and BUYER as ACTIVE", async () => {
    const { snapshot } = await seedDraft(["SELLER", "PROMOTER", "BUYER"]);
    const byRole = Object.fromEntries(snapshot.roles.map((r) => [r.role, r]));

    expect(byRole.SELLER!.status).toBe("DRAFT");
    expect(byRole.PROMOTER!.status).toBe("DRAFT");
    expect(byRole.BUYER!.status).toBe("ACTIVE");

    // A role created ACTIVE was activated when it was granted; a DRAFT one was not.
    expect(byRole.BUYER!.activatedAt).toBe(new Date(NOW).toISOString());
    expect(byRole.SELLER!.activatedAt).toBeNull();
  });

  it("treats a duplicate role grant as idempotent, not as a conflict", async () => {
    const { snapshot } = await seedDraft(["SELLER"]);
    const id = snapshot.participant.participantId;

    const after = await assignParticipantRole(
      { participantId: id, role: "SELLER", now: LATER },
      { db },
    );

    expect(after.roles).toHaveLength(1);
    // The original grant instant is preserved — a re-grant is not a re-grant.
    expect(after.roles[0]!.grantedAt).toBe(new Date(NOW).toISOString());
    expect(await db.marketplaceRoleAssignment.count({ where: { participantId: id } })).toBe(1);
  });

  it("deduplicates repeated roles supplied at creation", async () => {
    const accountId = await seedAccount();
    const snapshot = await createDraftParticipant(
      { accountId, initialRoles: ["SELLER", "SELLER", "BUYER"], now: NOW },
      { db },
    );
    expect(snapshot.roles).toHaveLength(2);
  });

  it("adds a role to an existing participant later", async () => {
    const { snapshot } = await seedDraft(["SELLER"]);
    const after = await assignParticipantRole(
      { participantId: snapshot.participant.participantId, role: "PROMOTER", now: LATER },
      { db },
    );
    expect(after.roles.map((r) => r.role).sort()).toEqual(["PROMOTER", "SELLER"]);
  });

  it("refuses a role grant for an unknown participant", async () => {
    await expect(
      assignParticipantRole(
        { participantId: `mon:mpart:${pad26("NOSUCHPART")}`, role: "BUYER", now: NOW },
        { db },
      ),
    ).rejects.toBeInstanceOf(ParticipantNotFoundError);
  });

  // — Lifecycles stay separate —

  it("keeps participant status, role status, and payment readiness on separate axes", async () => {
    const { accountId, snapshot } = await seedDraft(["BUYER"]);

    // A BUYER role is ACTIVE while the participant is still DRAFT.
    expect(snapshot.participant.status).toBe("DRAFT");
    expect(snapshot.roles[0]!.status).toBe("ACTIVE");

    // Payment readiness is NOT_STARTED and has no storage that could say otherwise.
    const subject = await materializeMarketplaceSubject(accountId, { db });
    expect(subject.participant!.paymentReadiness).toBe("NOT_STARTED");
  });

  it("advances DRAFT → PROFILE_INCOMPLETE → PROFILE_COMPLETE", async () => {
    const { snapshot } = await seedDraft([]);
    const id = snapshot.participant.participantId;

    const a = await advanceParticipantStatus(id, "PROFILE_INCOMPLETE", { db });
    expect(a.participant.status).toBe("PROFILE_INCOMPLETE");

    const b = await advanceParticipantStatus(id, "PROFILE_COMPLETE", { db });
    expect(b.participant.status).toBe("PROFILE_COMPLETE");
  });

  it("refuses a transition the 0M.1 table forbids", async () => {
    const { snapshot } = await seedDraft([]);
    // DRAFT → PROFILE_COMPLETE skips PROFILE_INCOMPLETE and is not a transition.
    await expect(
      advanceParticipantStatus(snapshot.participant.participantId, "PROFILE_COMPLETE", { db }),
    ).rejects.toBeInstanceOf(InvalidParticipantTransitionError);
  });

  it("refuses every status that would require a governed activation decision", async () => {
    const { snapshot } = await seedDraft([]);
    const id = snapshot.participant.participantId;

    for (const status of ["UNDER_REVIEW", "ACTIVE", "RESTRICTED", "SUSPENDED"] as const) {
      const error = await advanceParticipantStatus(id, status, { db }).catch((e) => e);
      expect(error).toBeInstanceOf(ActivationNotPermittedInPhaseError);
      expect(error.attempted).toBe(status);
    }

    // Nothing moved.
    const row = await db.marketplaceParticipant.findUnique({ where: { id } });
    expect(row!.status).toBe("DRAFT");
  });

  it("writes no activation row in this phase", async () => {
    await seedDraft(["SELLER", "PROMOTER", "BUYER"]);
    expect(await db.participantActivation.count()).toBe(0);
  });

  // — Private profile —

  it("persists section markers and onboarding gates, deriving completeness", async () => {
    const { snapshot } = await seedDraft(["SELLER"]);
    const id = snapshot.participant.participantId;

    const partial = await updateParticipantProfile(
      { participantId: id, markers: { identityComplete: true }, now: NOW },
      { db },
    );
    expect(partial.markers.identityComplete).toBe(true);
    expect(partial.markers.documentsComplete).toBe(false);
    expect(partial.completeness).toBe("INCOMPLETE");

    const full = await updateParticipantProfile(
      {
        participantId: id,
        markers: {
          identityComplete: true,
          businessStructureComplete: true,
          representativesComplete: true,
          commercialProfileComplete: true,
          riskComplete: true,
          payoutConfigurationComplete: true,
          documentsComplete: true,
        },
        gates: {
          emailVerifiedAt: NOW,
          termsAcceptedAt: NOW,
          termsVersion: "terms/2027-01",
        },
        now: LATER,
      },
      { db },
    );
    expect(full.completeness).toBe("COMPLETE");
  });

  it("merges a partial profile update without clearing other sections", async () => {
    const { snapshot } = await seedDraft(["SELLER"]);
    const id = snapshot.participant.participantId;

    await updateParticipantProfile(
      { participantId: id, markers: { identityComplete: true }, now: NOW },
      { db },
    );
    const after = await updateParticipantProfile(
      { participantId: id, markers: { riskComplete: true }, now: LATER },
      { db },
    );

    expect(after.markers.identityComplete).toBe(true);
    expect(after.markers.riskComplete).toBe(true);
  });

  it("returns null for a participant that has started no profile", async () => {
    const { snapshot } = await seedDraft([]);
    expect(await getParticipantProfile(snapshot.participant.participantId, { db })).toBeNull();
  });

  it("refuses a profile for an unknown participant", async () => {
    await expect(
      updateParticipantProfile(
        { participantId: `mon:mpart:${pad26("NOSUCHPART")}`, markers: { riskComplete: true }, now: NOW },
        { db },
      ),
    ).rejects.toBeInstanceOf(ParticipantNotFoundError);
  });

  it("stores no email address, credential, payment identifier, or moderation note", async () => {
    const { snapshot } = await seedDraft(["SELLER"]);
    const id = snapshot.participant.participantId;
    await updateParticipantProfile(
      { participantId: id, gates: { emailVerifiedAt: NOW }, now: NOW },
      { db },
    );

    const row = await db.participantProfile.findUnique({ where: { participantId: id } });
    const serialized = JSON.stringify(row);
    for (const forbidden of ["@example.com", PASSWORD, "stripe", "acct_", "moderation"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // The verification INSTANT is recorded; the address is not.
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  // — MarketplaceSubject materialization —

  it("materializes a subject the twelve capability decisions accept", async () => {
    const { accountId, snapshot } = await seedDraft(["SELLER", "PROMOTER", "BUYER"]);
    const subject = await materializeMarketplaceSubject(accountId, { db });

    expect(subject.account!.accountId).toBe(accountId);
    expect(subject.participant!.participantId).toBe(snapshot.participant.participantId);
    expect(subject.participant!.roles).toHaveLength(3);

    const decisions = [
      canCreateDraftStorefront(subject),
      canCreateDraftProduct(subject),
      canCreatePromotedListing(subject),
      canSubmitActivation(subject),
      canActivateStorefront(subject),
      canPublishOffer(subject),
      canReceivePayout(subject),
      canAccrueCommission(subject),
    ];
    for (const decision of decisions) {
      expect(["ALLOW", "DENY"]).toContain(decision.decision);
    }

    // Review decisions take their own eligibility input, and are callable too.
    const eligibility = {
      subject,
      purchaseProvenance: "UNVERIFIED" as const,
    };
    expect(["ALLOW", "DENY"]).toContain(canSubmitProductReview(eligibility).decision);
    expect(["ALLOW", "DENY"]).toContain(canSubmitSellerReview(eligibility).decision);
    expect(typeof canPublishProductReviewCapsule).toBe("function");
    expect(typeof canPublishSellerReviewCapsule).toBe("function");
  });

  it("permits drafting from a DRAFT participant but refuses commerce", async () => {
    const { accountId } = await seedDraft(["SELLER"]);
    const subject = await materializeMarketplaceSubject(accountId, { db });

    // The thesis's "low-friction creation, governed activation": draft yes, sell no.
    expect(canCreateDraftProduct(subject).decision).toBe("ALLOW");
    expect(canCreateDraftStorefront(subject).decision).toBe("ALLOW");
    expect(canPublishOffer(subject).decision).toBe("DENY");
    expect(canReceivePayout(subject).decision).toBe("DENY");
  });

  it("returns the guest subject for an unknown account", async () => {
    const subject = await materializeMarketplaceSubject(`mon:acct:${pad26("NOSUCHACCT")}`, { db });
    expect(subject).toEqual(GUEST_SUBJECT);
  });

  it("returns an authenticated non-participant for an account with no participant", async () => {
    const accountId = await seedAccount();
    const subject = await materializeMarketplaceSubject(accountId, { db });
    expect(subject.account!.accountId).toBe(accountId);
    expect(subject.participant).toBeNull();
  });

  it("never exposes the private profile through the subject", async () => {
    const { accountId, snapshot } = await seedDraft(["SELLER"]);
    await updateParticipantProfile(
      {
        participantId: snapshot.participant.participantId,
        markers: { identityComplete: true, riskComplete: true },
        gates: { emailVerifiedAt: NOW, termsAcceptedAt: NOW, termsVersion: "terms/2027-01" },
        now: NOW,
      },
      { db },
    );

    const subject = await materializeMarketplaceSubject(accountId, { db });
    const serialized = JSON.stringify(subject);

    for (const leaked of ["identityComplete", "riskComplete", "emailVerifiedAt", "termsVersion", "completeness"]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(findParticipantPrivacyViolations(subject)).toEqual([]);
  });

  it("keeps internal entitlements separate from marketplace roles", async () => {
    const { accountId } = await seedDraft(["SELLER"]);
    await grantAccountEntitlement(
      { accountId, capability: "publication-worker:status:read", grantedAt: NOW },
      { db },
    );

    const subject = await materializeMarketplaceSubject(accountId, { db });
    expect(subject.internalCapabilities).toEqual(["publication-worker:status:read"]);
    // The entitlement is carried, and grants no marketplace capability.
    expect(subject.participant!.roles.map((r) => r.role)).toEqual(["SELLER"]);
    expect(canPublishOffer(subject).decision).toBe("DENY");
  });

  // — Corrupt stored data —

  it("raises a structured error for a persisted participant that violates its contract", async () => {
    const { snapshot } = await seedDraft([]);
    const id = snapshot.participant.participantId;

    // Write a status outside the closed vocabulary, bypassing the service.
    await db.$executeRawUnsafe(
      "UPDATE MarketplaceParticipant SET status = ? WHERE id = ?",
      "NOT_A_STATUS",
      id,
    );

    const error = await getParticipant(id, { db }).catch((e) => e);
    expect(error).toBeInstanceOf(CorruptParticipantRecordError);
    expect(error.fields).toContain("status");
    // The offending stored value is never echoed.
    expect(JSON.stringify(error)).not.toContain("NOT_A_STATUS");
  });

  it("raises a structured error for a persisted role outside the closed vocabulary", async () => {
    const { accountId, snapshot } = await seedDraft(["SELLER"]);
    await db.$executeRawUnsafe(
      "UPDATE MarketplaceRoleAssignment SET role = ? WHERE participantId = ?",
      "SUPER_SELLER",
      snapshot.participant.participantId,
    );

    await expect(materializeMarketplaceSubject(accountId, { db })).rejects.toBeInstanceOf(
      CorruptParticipantRecordError,
    );
  });

  it("maps a valid row without complaint", async () => {
    const { snapshot } = await seedDraft([]);
    const row = await db.marketplaceParticipant.findUnique({
      where: { id: snapshot.participant.participantId },
    });
    expect(participantRowToRecord(row!).status).toBe("DRAFT");
  });

  // — Product creator-authority linkage —

  it("leaves historical Product source versions readable with a NULL participant link", async () => {
    const record = syntheticProduct();
    await repo.createInitialProductSourceRecord({ record });

    const row = await db.productSourceRecordVersionRow.findFirst({
      where: { sourceRecordId: record.sourceRecordId },
    });

    // The legacy mon:creator: authority is untouched, and the new link is NULL.
    expect(row!.authorityCreatorId).toBe(record.authority.creatorId);
    expect(row!.authorityCreatorParticipantId).toBeNull();
  });

  it("links a Product source version to a participant when one is supplied", async () => {
    const { snapshot } = await seedDraft(["SELLER"]);
    const record = syntheticProduct();
    await repo.createInitialProductSourceRecord({ record });

    await db.productSourceRecordVersionRow.updateMany({
      where: { sourceRecordId: record.sourceRecordId },
      data: { authorityCreatorParticipantId: snapshot.participant.participantId },
    });

    const row = await db.productSourceRecordVersionRow.findFirst({
      where: { sourceRecordId: record.sourceRecordId },
    });
    expect(row!.authorityCreatorParticipantId).toBe(snapshot.participant.participantId);
    // The original creator reference is still there, unchanged.
    expect(row!.authorityCreatorId).toBe(record.authority.creatorId);
  });

  it("refuses a participant link that names no participant", async () => {
    const record = syntheticProduct();
    await repo.createInitialProductSourceRecord({ record });

    await expect(
      db.productSourceRecordVersionRow.updateMany({
        where: { sourceRecordId: record.sourceRecordId },
        data: { authorityCreatorParticipantId: `mon:mpart:${pad26("NOSUCHPART")}` },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("refuses to delete a participant that authored Product history", async () => {
    const { snapshot } = await seedDraft(["SELLER"]);
    const participantId = snapshot.participant.participantId;
    const record = syntheticProduct();
    await repo.createInitialProductSourceRecord({ record });
    await db.productSourceRecordVersionRow.updateMany({
      where: { sourceRecordId: record.sourceRecordId },
      data: { authorityCreatorParticipantId: participantId },
    });

    // RESTRICT: marketplace-side deletion must never cascade into Product history.
    await expect(
      db.marketplaceParticipant.delete({ where: { id: participantId } }),
    ).rejects.toMatchObject({ code: "P2003" });

    // The Product source version is still there, intact.
    const row = await db.productSourceRecordVersionRow.findFirst({
      where: { sourceRecordId: record.sourceRecordId },
    });
    expect(row).not.toBeNull();
    expect(row!.authorityCreatorId).toBe(record.authority.creatorId);
  });

  it("refuses to delete an account that holds a participant", async () => {
    const { accountId } = await seedDraft([]);
    await expect(db.account.delete({ where: { id: accountId } })).rejects.toMatchObject({
      code: "P2003",
    });
  });

  it("refuses to delete a participant that still holds a role", async () => {
    const { snapshot } = await seedDraft(["SELLER"]);
    await expect(
      db.marketplaceParticipant.delete({ where: { id: snapshot.participant.participantId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("cascades the private profile with its participant, and nothing else", async () => {
    const { snapshot } = await seedDraft([]);
    const id = snapshot.participant.participantId;
    await updateParticipantProfile(
      { participantId: id, markers: { identityComplete: true }, now: NOW },
      { db },
    );

    expect(await db.participantProfile.count({ where: { participantId: id } })).toBe(1);
    await db.marketplaceParticipant.delete({ where: { id } });
    // The profile went with it; it is subordinate state, not history.
    expect(await db.participantProfile.count({ where: { participantId: id } })).toBe(0);
  });
});
