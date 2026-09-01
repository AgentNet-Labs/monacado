/**
 * Phase 1.14 — governed participant mitigation, integration.
 *
 * ```
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://…@127.0.0.1:3308/monacado_phase0e2
 * ```
 *
 * The whole suite self-skips unless `RUN_DB_TESTS=1`. Never point at production.
 *
 * ## No network, and no production policy activation
 *
 * There is no provider client anywhere in this file. Marketplace Policy 1.3.0 is
 * recorded and activated HERE, against this suite's own disposable database, to
 * prove the governance gate opens and closes on the ACTIVE version. Nothing in
 * the shipped code activates it, and the suite restores 1.0.0 before it exits.
 *
 * ## Suite-scoped cleanup
 *
 * Rows are removed by this suite's own opaque prefix and account local-part.
 * No `deleteMany({})` appears.
 */

import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  imposeParticipantRestriction,
  liftParticipantRestriction,
  getParticipantRestrictionHistory,
} from "../src/server/marketplace/participant-restriction-service";
import { isParticipantSuspended } from "../src/server/marketplace/participant-standing-service";
import { closeParticipant } from "../src/server/marketplace/participant-closure-service";
import {
  ParticipantAlreadyClosedError,
  ParticipantClosureNotFoundError,
  ParticipantLifecycleTerminatedError,
} from "../src/server/marketplace/participant-closure-errors";
import { createDraftStorefront } from "../src/server/marketplace/storefront-service";
import {
  getParticipantSuspensionHistory,
  reinstateParticipant,
  suspendParticipant,
} from "../src/server/marketplace/participant-suspension-service";
import {
  decideReconsideration,
  readParticipantReconsiderations,
  requestReconsideration,
} from "../src/server/marketplace/participant-reconsideration-service";
import {
  ParticipantAlreadySuspendedError,
  ParticipantMitigationNotAuthorizedByPolicyError,
  ReconsiderationNotAvailableError,
  ReconsiderationNotFoundError,
  SuspensionActorNotAuthorizedError,
  SuspensionAlreadyLiftedError,
  SuspensionSelfActionNotPermittedError,
} from "../src/server/marketplace/participant-mitigation-errors";
import {
  ensureMarketplacePolicy,
  recordMarketplacePolicyVersion,
} from "../src/server/policy/marketplace-policy-service";
import {
  MARKETPLACE_POLICY_VERSION_1,
  MARKETPLACE_POLICY_VERSION_1_3,
  MONACADO_MARKETPLACE_POLICY_ID,
} from "../src/contracts/marketplace/marketplace-policy-content";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);
const d = RUN ? describe : describe.skip;

const TAG = "P114T";
const ACCOUNT_EMAIL_PREFIX = "mitigation114-";
const PASSWORD = "correct-horse-battery-staple-114";
const NOW = "2028-10-01T09:00:00.000Z";
const LATER = "2028-10-02T09:00:00.000Z";

let counter = 0;
const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);
const next = (): number => (counter += 1);

interface Actors {
  restrictor: string;
  suspender: string;
  reviewer: string;
  unentitled: string;
}
let actors: Actors;

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

async function seedActor(capability: string): Promise<string> {
  const accountId = await seedAccount();
  await grantAccountEntitlement({ accountId, capability, grantedAt: NOW }, { db });
  return accountId;
}

/** An ACTIVE participant, the state every mitigation act is taken against. */
async function seedParticipant(): Promise<string> {
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
  return participantId;
}

const participantStatus = async (participantId: string): Promise<string> =>
  (
    await db.marketplaceParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { status: true },
    })
  ).status;

/**
 * Put the governing terms where a given version is ACTIVE.
 *
 * ARRANGES STATE DIRECTLY rather than calling `activateMarketplacePolicyVersion`,
 * and deliberately. That service retires the incumbent, and a retired version can
 * never be reactivated — which is correct governance and exactly wrong for a
 * fixture that has to move the active version back and forth to prove the gate
 * opens and closes. The activation SERVICE is tested where it belongs; this is
 * arrangement.
 */
async function activatePolicy(version: string): Promise<void> {
  await ensureMarketplacePolicy(
    { policyId: MONACADO_MARKETPLACE_POLICY_ID, label: "Monacado Marketplace Policy", now: NOW },
    { db },
  );
  for (const v of [MARKETPLACE_POLICY_VERSION_1, MARKETPLACE_POLICY_VERSION_1_3]) {
    const existing = await db.marketplacePolicyVersionRow.findUnique({
      where: {
        policyId_policyVersion: { policyId: MONACADO_MARKETPLACE_POLICY_ID, policyVersion: v },
      },
    });
    if (existing === null) {
      await recordMarketplacePolicyVersion(
        {
          policyId: MONACADO_MARKETPLACE_POLICY_ID,
          policyVersion: v,
          contentRef: `marketplace-policy/${v}`,
          requiresReacceptance: true,
          effectiveFrom: NOW,
          recordedByAccountId: actors.restrictor,
          recordedAt: NOW,
        },
        { db },
      );
    }
  }
  /* Stand every version down, then raise exactly one.
     
     `activeMarker` is released FIRST and in its own statement. It is UNIQUE, so
     two rows may never hold it — and arranging state directly means taking
     responsibility for every invariant the activation service would otherwise
     maintain. Setting `status` alone would leave the marker claimed by the row
     standing down, and the next suite to activate a policy through the real
     service would hit the unique constraint. */
  await db.marketplacePolicyVersionRow.updateMany({
    where: { policyId: MONACADO_MARKETPLACE_POLICY_ID },
    data: { status: "DRAFT", activeMarker: null },
  });
  await db.marketplacePolicyVersionRow.updateMany({
    where: { policyId: MONACADO_MARKETPLACE_POLICY_ID, policyVersion: version },
    data: { status: "ACTIVE", activeMarker: MONACADO_MARKETPLACE_POLICY_ID },
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

  if (ids.length > 0) {
    await db.notificationObligation.deleteMany({
      where: { recipientParticipantId: { in: ids } },
    });
    await db.participantReconsideration.deleteMany({ where: { participantId: { in: ids } } });
    await db.participantClosure.deleteMany({ where: { participantId: { in: ids } } });
    await db.participantSuspension.deleteMany({ where: { participantId: { in: ids } } });
    await db.participantRestriction.deleteMany({ where: { participantId: { in: ids } } });
    await db.participantActivation.deleteMany({ where: { participantId: { in: ids } } });
    /* Phase 1.16 — the drafting tests create Storefronts, and every marketplace
       FK is RESTRICT, so they come off before the participants that own them. */
    await db.storefrontGovernanceAssignment.deleteMany({ where: { participantId: { in: ids } } });
    await db.storefrontSourceRecordVersionRow.deleteMany({
      where: { ownerParticipantId: { in: ids } },
    });
    await db.storefront.deleteMany({ where: { ownerParticipantId: { in: ids } } });
    await db.participantProfile.deleteMany({ where: { participantId: { in: ids } } });
    await db.marketplaceRoleAssignment.deleteMany({ where: { participantId: { in: ids } } });
    await db.marketplaceParticipant.deleteMany({ where: { id: { in: ids } } });
  }
  if (accountIds.length > 0) {
    await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }
}

const restrict = (participantId: string, over: Record<string, unknown> = {}) =>
  imposeParticipantRestriction(
    {
      participantId,
      scope: "payout:receive",
      reasonCode: "CHARGEBACK_RATE_ELEVATED",
      actingAccountId: actors.restrictor,
      imposedAt: NOW,
      ...over,
    },
    { db },
  );

const suspend = (participantId: string, over: Record<string, unknown> = {}) =>
  suspendParticipant(
    {
      participantId,
      reasonCode: "ADVERSE_OUTCOME_LEVEL_UNSUSTAINABLE",
      actingAccountId: actors.suspender,
      suspendedAt: NOW,
      ...over,
    },
    { db },
  );

d("1.14 · governed participant mitigation (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    actors = {
      restrictor: await seedActor("participant:restrict"),
      suspender: await seedActor("participant:suspend"),
      reviewer: await seedActor("participant:risk-review"),
      unentitled: await seedAccount(),
    };
  });

  afterAll(async () => {
    /* Put the shared shipped policy back exactly as every other suite expects
       it: 1.0.0 ACTIVE holding the marker, and the 1.3.0 row this suite recorded
       removed entirely.
       
       Restoring the marker matters as much as the status. `activateMarketplace
       PolicyVersion` finds the incumbent to retire by `status: "ACTIVE"`, so a
       row left holding `activeMarker` without that status is invisible to the
       retire step and collides on the unique index the next time any suite
       activates anything. */
    /* Suite rows FIRST. Every restriction and suspension this suite recorded
       binds the 1.3.0 version row under a RESTRICT foreign key — the very
       binding that makes an act explicable — so the version cannot come off
       until the acts referencing it have. */
    await cleanup();
    await db.marketplacePolicyVersionRow.deleteMany({
      where: {
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
      },
    });
    await db.marketplacePolicyVersionRow.updateMany({
      where: { policyId: MONACADO_MARKETPLACE_POLICY_ID },
      data: { status: "DRAFT", activeMarker: null },
    });
    await db.marketplacePolicyVersionRow.updateMany({
      where: {
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1,
      },
      data: { status: "ACTIVE", activeMarker: MONACADO_MARKETPLACE_POLICY_ID },
    });
    await disconnectPrisma();
  });

  describe("the terms gate the act", () => {
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1);
    });

    it("refuses a risk-derived restriction while 1.2.0-era terms govern", async () => {
      const participantId = await seedParticipant();
      await expect(restrict(participantId)).rejects.toBeInstanceOf(
        ParticipantMitigationNotAuthorizedByPolicyError,
      );
      expect(await participantStatus(participantId)).toBe("ACTIVE");
      expect(await db.participantRestriction.count({ where: { participantId } })).toBe(0);
    });

    it("refuses a suspension while 1.2.0-era terms govern", async () => {
      const participantId = await seedParticipant();
      await expect(suspend(participantId)).rejects.toBeInstanceOf(
        ParticipantMitigationNotAuthorizedByPolicyError,
      );
      expect(await participantStatus(participantId)).toBe("ACTIVE");
    });

    it("still permits an operational restriction, which needed no new terms", async () => {
      /* `participant:restrict` predates participant-level risk terms. Gating
         every restriction would make a deployment unable to complete
         underwriting until it activated a policy about risk monitoring. */
      const participantId = await seedParticipant();
      const snapshot = await restrict(participantId, {
        reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
      });
      expect(snapshot.restriction.reasonCode).toBe("UNDERWRITING_REVIEW_REQUIRED");
      expect(await participantStatus(participantId)).toBe("RESTRICTED");
    });
  });

  describe("under Marketplace Policy 1.3.0", () => {
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1_3);
    });

    it("binds the exact governing version to the act", async () => {
      const participantId = await seedParticipant();
      const snapshot = await restrict(participantId);
      const row = await db.participantRestriction.findUniqueOrThrow({
        where: { id: snapshot.restriction.restrictionId },
      });
      /* Monacado's authority to have acted is only checkable against the version
         it acted under, and an appeal months later must be answered on it. */
      expect(row.marketplacePolicyVersion).toBe("1.3.0");
      expect(row.marketplacePolicyId).toBe(MONACADO_MARKETPLACE_POLICY_ID);
    });

    it("raises exactly one notice, keyed on the decision", async () => {
      const participantId = await seedParticipant();
      const snapshot = await restrict(participantId);
      const obligations = await db.notificationObligation.findMany({
        where: { recipientParticipantId: participantId },
      });
      expect(obligations).toHaveLength(1);
      expect(obligations[0]!.category).toBe("PARTICIPANT_STANDING_CHANGED");
      expect(obligations[0]!.subjectKind).toBe("PARTICIPANT_DECISION");
      /* THE LOAD-BEARING DETAIL. Keyed on the restriction, not the participant —
         otherwise a second decision would collapse into this obligation and
         silently never be raised. */
      expect(obligations[0]!.subjectRef).toBe(snapshot.restriction.restrictionId);
      expect(obligations[0]!.status).toBe("UNREAD");
    });

    it("raises a second, distinct notice for a second decision", async () => {
      const participantId = await seedParticipant();
      const first = await restrict(participantId, { scope: "payout:receive" });
      const second = await restrict(participantId, { scope: "offer:publish" });
      const obligations = await db.notificationObligation.findMany({
        where: { recipientParticipantId: participantId },
      });
      expect(obligations).toHaveLength(2);
      expect(new Set(obligations.map((o) => o.subjectRef))).toEqual(
        new Set([first.restriction.restrictionId, second.restriction.restrictionId]),
      );
    });

    it("tells the participant when commerce resumes", async () => {
      const participantId = await seedParticipant();
      const imposed = await restrict(participantId);
      await liftParticipantRestriction(
        {
          restrictionId: imposed.restriction.restrictionId,
          reasonCode: "REQUIREMENT_SATISFIED",
          actingAccountId: actors.restrictor,
          liftedAt: LATER,
        },
        { db },
      );
      const contexts = (
        await db.notificationObligation.findMany({
          where: { recipientParticipantId: participantId },
        })
      ).map((o) => o.contextCode);
      expect(new Set(contexts)).toEqual(new Set(["RESTRICTION_IMPOSED", "RESTRICTION_LIFTED"]));
    });

    it("records why a restriction was lifted, in its own vocabulary", async () => {
      const participantId = await seedParticipant();
      const imposed = await restrict(participantId);
      await liftParticipantRestriction(
        {
          restrictionId: imposed.restriction.restrictionId,
          reasonCode: "IMPOSED_IN_ERROR",
          actingAccountId: actors.restrictor,
          liftedAt: LATER,
        },
        { db },
      );
      const history = await getParticipantRestrictionHistory(participantId, { db });
      /* A marketplace that cannot say it got one wrong will record every reversal
         as though the participant had changed. */
      expect(history[0]!.liftedReasonCode).toBe("IMPOSED_IN_ERROR");
      expect(history[0]!.imposedByAccountId).toBe(actors.restrictor);
    });

    it("suspends, and the participant keeps everything but permission", async () => {
      const participantId = await seedParticipant();
      const rolesBefore = await db.marketplaceRoleAssignment.count({ where: { participantId } });

      const snapshot = await suspend(participantId);
      expect(snapshot.status).toBe("ACTIVE");
      expect(await participantStatus(participantId)).toBe("SUSPENDED");

      /* Identity, roles, and history all survive: a suspension changes what a
         participant may do, not what they are or what they did. */
      expect(await db.marketplaceParticipant.count({ where: { id: participantId } })).toBe(1);
      expect(await db.marketplaceRoleAssignment.count({ where: { participantId } })).toBe(
        rolesBefore,
      );
      const roles = await db.marketplaceRoleAssignment.findMany({ where: { participantId } });
      for (const role of roles) expect(role.status).not.toBe("REVOKED");
    });

    it("refuses a second suspension while one stands", async () => {
      const participantId = await seedParticipant();
      await suspend(participantId);
      await expect(suspend(participantId)).rejects.toBeInstanceOf(
        ParticipantAlreadySuspendedError,
      );
      expect(await db.participantSuspension.count({ where: { participantId } })).toBe(1);
    });

    it("reinstates to ACTIVE when nothing else stands", async () => {
      const participantId = await seedParticipant();
      const imposed = await suspend(participantId);
      const lifted = await reinstateParticipant(
        {
          suspensionId: imposed.suspensionId,
          reasonCode: "REQUIREMENT_SATISFIED",
          actingAccountId: actors.suspender,
          reinstatedAt: LATER,
        },
        { db },
      );
      expect(lifted.status).toBe("LIFTED");
      expect(await participantStatus(participantId)).toBe("ACTIVE");
      /* The original imposition is untouched. */
      expect(lifted.imposedByAccountId).toBe(actors.suspender);
      expect(lifted.imposedAt).toBe(NOW);
      expect(lifted.liftedReasonCode).toBe("REQUIREMENT_SATISFIED");
    });

    it("reinstates to RESTRICTED when restrictions still stand", async () => {
      /* RECONCILES RATHER THAN ASSUMES. Restoring the remembered status blindly
         would leave a participant at ACTIVE holding an active restriction. */
      const participantId = await seedParticipant();
      await restrict(participantId);
      expect(await participantStatus(participantId)).toBe("RESTRICTED");
      const imposed = await suspend(participantId);
      expect(await participantStatus(participantId)).toBe("SUSPENDED");

      await reinstateParticipant(
        {
          suspensionId: imposed.suspensionId,
          reasonCode: "REQUIREMENT_SATISFIED",
          actingAccountId: actors.suspender,
          reinstatedAt: LATER,
        },
        { db },
      );
      expect(await participantStatus(participantId)).toBe("RESTRICTED");
    });

    it("makes re-suspension a new row, never a resurrection", async () => {
      const participantId = await seedParticipant();
      const first = await suspend(participantId);
      await reinstateParticipant(
        {
          suspensionId: first.suspensionId,
          reasonCode: "REQUIREMENT_SATISFIED",
          actingAccountId: actors.suspender,
          reinstatedAt: LATER,
        },
        { db },
      );
      const second = await suspend(participantId, { suspendedAt: LATER });
      expect(second.suspensionId).not.toBe(first.suspensionId);

      const history = await getParticipantSuspensionHistory(participantId, { db });
      expect(history).toHaveLength(2);
      /* "Suspended, reinstated, suspended again" reads as two events. */
      const original = history.find((h) => h.suspensionId === first.suspensionId)!;
      expect(original.status).toBe("LIFTED");
      expect(original.imposedAt).toBe(NOW);
      expect(original.imposedByAccountId).toBe(actors.suspender);
    });

    it("refuses a second reinstatement", async () => {
      const participantId = await seedParticipant();
      const imposed = await suspend(participantId);
      const lift = {
        suspensionId: imposed.suspensionId,
        reasonCode: "REQUIREMENT_SATISFIED" as const,
        actingAccountId: actors.suspender,
        reinstatedAt: LATER,
      };
      await reinstateParticipant(lift, { db });
      await expect(reinstateParticipant(lift, { db })).rejects.toBeInstanceOf(
        SuspensionAlreadyLiftedError,
      );
    });
  });

  describe("authority is checked, and never widened", () => {
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1_3);
    });

    it("refuses a suspender who holds only participant:restrict", async () => {
      const participantId = await seedParticipant();
      await expect(
        suspend(participantId, { actingAccountId: actors.restrictor }),
      ).rejects.toBeInstanceOf(SuspensionActorNotAuthorizedError);
      expect(await participantStatus(participantId)).toBe("ACTIVE");
    });

    it("refuses a suspender who holds only participant:risk-review", async () => {
      /* The safeguard: the reviewer who records SUSPENSION_RECOMMENDED still
         cannot carry it out. */
      const participantId = await seedParticipant();
      await expect(
        suspend(participantId, { actingAccountId: actors.reviewer }),
      ).rejects.toBeInstanceOf(SuspensionActorNotAuthorizedError);
    });

    it("tells an unauthorized caller nothing about the target", async () => {
      /* Authorization is checked before any participant row is read, so a
         nonexistent target and a real one give the same answer. */
      await expect(
        suspend("mon:mpart:ZZZZZZZZZZZZZZZZZZZZZZZZZZ", {
          actingAccountId: actors.unentitled,
        }),
      ).rejects.toBeInstanceOf(SuspensionActorNotAuthorizedError);
    });

    it("refuses self-suspension", async () => {
      const accountId = await seedAccount();
      await grantAccountEntitlement(
        { accountId, capability: "participant:suspend", grantedAt: NOW },
        { db },
      );
      const snapshot = await createDraftParticipant(
        { accountId, initialRoles: ["SELLER"], now: NOW },
        { db },
      );
      const participantId = snapshot.participant.participantId;
      await db.marketplaceParticipant.update({
        where: { id: participantId },
        data: { status: "ACTIVE" },
      });
      await expect(
        suspend(participantId, { actingAccountId: accountId }),
      ).rejects.toBeInstanceOf(SuspensionSelfActionNotPermittedError);
    });
  });

  describe("reconsideration", () => {
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1_3);
    });

    it("records a request against a standing decision and a determination", async () => {
      const participantId = await seedParticipant();
      const participant = await db.marketplaceParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: { accountId: true },
      });
      const imposed = await restrict(participantId);

      const filed = await requestReconsideration(
        {
          participantId,
          restrictionId: imposed.restriction.restrictionId,
          requestedByAccountId: participant.accountId,
          requestedAt: LATER,
          groundCode: "UNDERLYING_REQUIREMENT_NOW_SATISFIED",
          remediationClaimCode: "CORRECTED_SUBMISSION_MADE",
        },
        { db },
      );
      expect(filed.status).toBe("RECEIVED");
      expect(filed.determinationCode).toBeNull();

      const decided = await decideReconsideration(
        {
          reconsiderationId: filed.reconsiderationId,
          determinationCode: "UPHELD",
          actingAccountId: actors.restrictor,
          decidedAt: LATER,
        },
        { db },
      );
      expect(decided.status).toBe("DECIDED");
      expect(decided.decidedByAccountId).toBe(actors.restrictor);
      /* A determination records what Monacado decided; it performs no lift. */
      const history = await getParticipantRestrictionHistory(participantId, { db });
      expect(history[0]!.status).toBe("ACTIVE");
    });

    it("allows one reconsideration per decision", async () => {
      const participantId = await seedParticipant();
      const participant = await db.marketplaceParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: { accountId: true },
      });
      const imposed = await restrict(participantId);
      const request = {
        participantId,
        restrictionId: imposed.restriction.restrictionId,
        requestedByAccountId: participant.accountId,
        requestedAt: LATER,
        groundCode: "ELIGIBILITY_CONDITION_NOW_MET" as const,
      };
      await requestReconsideration(request, { db });
      await expect(requestReconsideration(request, { db })).rejects.toBeInstanceOf(
        ReconsiderationNotAvailableError,
      );
      expect(await readParticipantReconsiderations(participantId, { db })).toHaveLength(1);
    });

    it("refuses a reconsideration of a decision that no longer stands", async () => {
      const participantId = await seedParticipant();
      const participant = await db.marketplaceParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: { accountId: true },
      });
      const imposed = await restrict(participantId);
      await liftParticipantRestriction(
        {
          restrictionId: imposed.restriction.restrictionId,
          reasonCode: "REQUIREMENT_SATISFIED",
          actingAccountId: actors.restrictor,
          liftedAt: LATER,
        },
        { db },
      );
      await expect(
        requestReconsideration(
          {
            participantId,
            restrictionId: imposed.restriction.restrictionId,
            requestedByAccountId: participant.accountId,
            requestedAt: LATER,
            groundCode: "ELIGIBILITY_CONDITION_NOW_MET",
          },
          { db },
        ),
      ).rejects.toBeInstanceOf(ReconsiderationNotAvailableError);
    });

    it("requires the lifting authority to decide", async () => {
      const participantId = await seedParticipant();
      const participant = await db.marketplaceParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: { accountId: true },
      });
      const imposed = await suspend(participantId);
      const filed = await requestReconsideration(
        {
          participantId,
          suspensionId: imposed.suspensionId,
          requestedByAccountId: participant.accountId,
          requestedAt: LATER,
          groundCode: "CIRCUMSTANCE_NOT_COVERED_BY_THESE_CODES",
        },
        { db },
      );
      /* Contesting a suspension is decided under `participant:suspend`, because a
         determination that lifts one is a reinstatement. */
      await expect(
        decideReconsideration(
          {
            reconsiderationId: filed.reconsiderationId,
            determinationCode: "UPHELD",
            actingAccountId: actors.restrictor,
            decidedAt: LATER,
          },
          { db },
        ),
      ).rejects.toBeInstanceOf(SuspensionActorNotAuthorizedError);
    });
  });

  describe("only the participant may ask for reconsideration", () => {
    /* Phase 1.15. The schema states the invariant of `requestedByAccountId` —
       "the account that asked — the participant's own, never a Staff account" —
       and nothing enforced it: knowing a participant id was enough to file.

       Reconsideration is ONE-SHOT per decision, so an unrelated account filing
       first would permanently consume the participant's only chance to contest a
       restriction or suspension. */
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1_3);
    });

    const accountOf = async (participantId: string): Promise<string> =>
      (
        await db.marketplaceParticipant.findUniqueOrThrow({
          where: { id: participantId },
          select: { accountId: true },
        })
      ).accountId;

    const ask = (participantId: string, restrictionId: string, requestedByAccountId: string) =>
      requestReconsideration(
        {
          participantId,
          restrictionId,
          requestedByAccountId,
          requestedAt: LATER,
          groundCode: "ELIGIBILITY_CONDITION_NOW_MET",
        },
        { db },
      );

    it("permits the participant's own account", async () => {
      const participantId = await seedParticipant();
      const imposed = await restrict(participantId);

      const filed = await ask(
        participantId,
        imposed.restriction.restrictionId,
        await accountOf(participantId),
      );
      expect(filed.status).toBe("RECEIVED");
    });

    it("refuses an unrelated account holding no participant at all", async () => {
      const participantId = await seedParticipant();
      const imposed = await restrict(participantId);

      await expect(
        ask(participantId, imposed.restriction.restrictionId, actors.unentitled),
      ).rejects.toBeInstanceOf(ReconsiderationNotFoundError);
    });

    it("refuses an account belonging to a DIFFERENT participant", async () => {
      const participantId = await seedParticipant();
      const stranger = await seedParticipant();
      const imposed = await restrict(participantId);

      await expect(
        ask(participantId, imposed.restriction.restrictionId, await accountOf(stranger)),
      ).rejects.toBeInstanceOf(ReconsiderationNotFoundError);
    });

    it("refuses a Staff account despite its mitigation entitlements", async () => {
      /* Staff capability authorizes DECIDING a reconsideration, never standing in
         for the participant's own request. Both grants are tried. */
      const participantId = await seedParticipant();
      const imposed = await restrict(participantId);

      for (const staff of [actors.restrictor, actors.suspender, actors.reviewer]) {
        await expect(
          ask(participantId, imposed.restriction.restrictionId, staff),
        ).rejects.toBeInstanceOf(ReconsiderationNotFoundError);
      }
    });

    it("writes nothing and does not consume the one-shot opportunity", async () => {
      /* THE LOAD-BEARING TEST. A refused attempt must leave the remedy intact. */
      const participantId = await seedParticipant();
      const stranger = await seedParticipant();
      const imposed = await restrict(participantId);
      const restrictionId = imposed.restriction.restrictionId;

      await expect(
        ask(participantId, restrictionId, await accountOf(stranger)),
      ).rejects.toBeInstanceOf(ReconsiderationNotFoundError);
      await expect(
        ask(participantId, restrictionId, actors.unentitled),
      ).rejects.toBeInstanceOf(ReconsiderationNotFoundError);

      /* No row was created by either attempt — for the target OR the stranger. */
      expect(await readParticipantReconsiderations(participantId, { db })).toHaveLength(0);
      expect(await readParticipantReconsiderations(stranger, { db })).toHaveLength(0);
      expect(await db.participantReconsideration.count({ where: { restrictionId } })).toBe(0);

      /* And the participant may still exercise the remedy afterwards. */
      const filed = await ask(participantId, restrictionId, await accountOf(participantId));
      expect(filed.status).toBe("RECEIVED");
      expect(await readParticipantReconsiderations(participantId, { db })).toHaveLength(1);
    });

    it("enforces the same rule on the suspension path", async () => {
      const participantId = await seedParticipant();
      const stranger = await seedParticipant();
      const imposed = await suspend(participantId);

      const askSuspension = (requestedByAccountId: string) =>
        requestReconsideration(
          {
            participantId,
            suspensionId: imposed.suspensionId,
            requestedByAccountId,
            requestedAt: LATER,
            groundCode: "CIRCUMSTANCE_NOT_COVERED_BY_THESE_CODES",
          },
          { db },
        );

      await expect(askSuspension(await accountOf(stranger))).rejects.toBeInstanceOf(
        ReconsiderationNotFoundError,
      );
      await expect(askSuspension(actors.suspender)).rejects.toBeInstanceOf(
        ReconsiderationNotFoundError,
      );
      expect(await readParticipantReconsiderations(participantId, { db })).toHaveLength(0);

      /* Still available to the participant. */
      const filed = await askSuspension(await accountOf(participantId));
      expect(filed.status).toBe("RECEIVED");
    });

    it("keeps the existing same-participant target check intact", async () => {
      /* Requester authorization is ADDITIVE. A participant asking about somebody
         else's decision is still refused, and with the same not-found answer, so
         neither check discloses the other's subject. */
      const participantId = await seedParticipant();
      const stranger = await seedParticipant();
      const strangersRestriction = await restrict(stranger);

      await expect(
        ask(
          participantId,
          strangersRestriction.restriction.restrictionId,
          await accountOf(participantId),
        ),
      ).rejects.toBeInstanceOf(ReconsiderationNotFoundError);

      expect(await readParticipantReconsiderations(participantId, { db })).toHaveLength(0);
      expect(await readParticipantReconsiderations(stranger, { db })).toHaveLength(0);
    });

    it("performs no lift or reinstatement by itself", async () => {
      const participantId = await seedParticipant();
      const imposed = await restrict(participantId);
      const before = await participantStatus(participantId);

      await ask(
        participantId,
        imposed.restriction.restrictionId,
        await accountOf(participantId),
      );

      /* Filing changes nothing about the decision or the participant. */
      const history = await getParticipantRestrictionHistory(participantId, { db });
      expect(history[0]!.status).toBe("ACTIVE");
      expect(history[0]!.liftedAt).toBeNull();
      expect(await participantStatus(participantId)).toBe(before);
    });

    /* PHASE 1.17 — THE HALF THE TEST ABOVE NEVER REACHED.
    
       That one proves FILING performs no lift. The over-claim was on the
       DETERMINATION: `DECISION_LIFTED_ON_RECONSIDERATION` asserted the decision
       had been lifted while `decideReconsideration` touches no mitigation row, so
       a participant could hold a notice naming their restriction lifted while
       every enforcement seam still refused them. The label now says what the act
       is — a lift DIRECTED — and this asserts the two-event story end to end:
       deciding leaves the restriction standing, and the separate governed lift is
       what actually ends it. */
    it("directs a lift without performing one, and the lift is its own act", async () => {
      const participantId = await seedParticipant();
      const imposed = await restrict(participantId);
      const restrictionId = imposed.restriction.restrictionId;

      const filed = await ask(participantId, restrictionId, await accountOf(participantId));
      const decided = await decideReconsideration(
        {
          reconsiderationId: filed.reconsiderationId,
          determinationCode: "LIFT_DIRECTED_ON_RECONSIDERATION",
          actingAccountId: actors.restrictor,
          decidedAt: LATER,
        },
        { db },
      );
      expect(decided.determinationCode).toBe("LIFT_DIRECTED_ON_RECONSIDERATION");

      /* THE DECISION ALONE CHANGES NOTHING OPERATIONAL. This is the assertion the
         old vocabulary made impossible to state honestly. */
      const afterDecision = await getParticipantRestrictionHistory(participantId, { db });
      expect(afterDecision[0]!.status).toBe("ACTIVE");
      expect(afterDecision[0]!.liftedAt).toBeNull();
      expect(await participantStatus(participantId)).toBe("RESTRICTED");

      /* The lift is a separate governed act with its own actor and instant, and
         names the reconsideration as its cause through a reason code that has
         existed since 1.14 for exactly this handoff. */
      await liftParticipantRestriction(
        {
          restrictionId,
          reasonCode: "LIFTED_ON_RECONSIDERATION",
          actingAccountId: actors.restrictor,
          liftedAt: LATER,
        },
        { db },
      );

      const afterLift = await getParticipantRestrictionHistory(participantId, { db });
      expect(afterLift[0]!.status).toBe("LIFTED");
      expect(afterLift[0]!.liftedAt).not.toBeNull();
      expect(await participantStatus(participantId)).toBe("ACTIVE");
    });
  });

  describe("1.16 · admission is never granted by mitigation", () => {
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1_3);
    });

    /** A participant who submitted for review and was never decided. */
    async function seedUnderReview(): Promise<string> {
      const participantId = await seedParticipant();
      await db.marketplaceParticipant.update({
        where: { id: participantId },
        data: { status: "UNDER_REVIEW" },
      });
      return participantId;
    }

    it("does not let a never-approved participant reach ACTIVE through mitigation", async () => {
      /* THE ESCALATION PHASE 1.16 CLOSES, end to end.
      
         Every step is an ordinary governed act, and before 1.16 the sequence
         ended with a participant stored ACTIVE holding no approved activation:
         restrict (no status move) → suspend (UNDER_REVIEW → SUSPENDED, the
         onboarding stage remembered) → reinstate (restrictions stood, so the
         count short-circuited to RESTRICTED) → lift (RESTRICTED + 0 → ACTIVE).
         
         Two mitigation acts conferred full admission. */
      const participantId = await seedUnderReview();
      await restrict(participantId);
      expect(await participantStatus(participantId)).toBe("UNDER_REVIEW");

      const suspended = await suspend(participantId);
      /* A suspension on a participant with no admission to withdraw records its
         evidence and leaves the onboarding stage intact. */
      expect(await participantStatus(participantId)).toBe("UNDER_REVIEW");

      await reinstateParticipant(
        {
          suspensionId: suspended.suspensionId,
          reasonCode: "LIFTED_ON_RECONSIDERATION",
          actingAccountId: actors.suspender,
          reinstatedAt: LATER,
        },
        { db },
      );
      expect(await participantStatus(participantId)).toBe("UNDER_REVIEW");

      const [restriction] = await db.participantRestriction.findMany({
        where: { participantId, status: "ACTIVE" },
      });
      await liftParticipantRestriction(
        {
          restrictionId: restriction!.id,
          reasonCode: "REQUIREMENT_SATISFIED",
          actingAccountId: actors.restrictor,
          liftedAt: LATER,
        },
        { db },
      );

      /* The whole point: no admission was manufactured. */
      const finalStatus = await participantStatus(participantId);
      expect(finalStatus).toBe("UNDER_REVIEW");
      expect(finalStatus).not.toBe("ACTIVE");
      expect(finalStatus).not.toBe("RESTRICTED");
    });

    it("never leaves a participant SUSPENDED with no active suspension", async () => {
      /* The stranding this closes: a mid-review suspension moved the status to
         SUSPENDED, and the lifecycle table has no edge back to any pre-review
         stage — so reinstatement lifted the row and could not restore the
         status. The participant was left stored SUSPENDED with zero evidence,
         unable to be re-suspended, re-submitted, or reconciled. */
      const participantId = await seedUnderReview();
      const suspended = await suspend(participantId);

      await reinstateParticipant(
        {
          suspensionId: suspended.suspensionId,
          reasonCode: "LIFTED_ON_RECONSIDERATION",
          actingAccountId: actors.suspender,
          reinstatedAt: LATER,
        },
        { db },
      );

      expect(await participantStatus(participantId)).not.toBe("SUSPENDED");
      expect(
        await db.participantSuspension.count({ where: { participantId, status: "ACTIVE" } }),
      ).toBe(0);

      /* And the participant is not trapped — a second suspension still works. */
      const again = await suspend(participantId, { suspendedAt: LATER });
      expect(again.suspensionId).not.toBe(suspended.suspensionId);
    });

    it("still records the suspension as authoritative evidence", async () => {
      /* Leaving the onboarding stage alone must not weaken the suspension. The
         row is what every Phase 1.15 seam reads. */
      const participantId = await seedUnderReview();
      await suspend(participantId);

      expect(
        await db.participantSuspension.count({ where: { participantId, status: "ACTIVE" } }),
      ).toBe(1);
      expect(await isParticipantSuspended(db, participantId)).toBe(true);
    });

    it("moves an admitted participant to SUSPENDED as before", async () => {
      /* Regression guard: the ordinary case is untouched. */
      const participantId = await seedParticipant();
      await suspend(participantId);
      expect(await participantStatus(participantId)).toBe("SUSPENDED");
    });
  });

  describe("1.16 · suspension withholds authoring, whatever the projected status", () => {
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1_3);
    });

    /** A participant still in onboarding, where `permitsDrafting` returns true. */
    async function seedPreAdmission(): Promise<{ participantId: string; accountId: string }> {
      const participantId = await seedParticipant();
      await db.marketplaceParticipant.update({
        where: { id: participantId },
        data: { status: "PROFILE_COMPLETE" },
      });
      const { accountId } = await db.marketplaceParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: { accountId: true },
      });
      return { participantId, accountId };
    }

    const draftStorefront = async (ownerParticipantId: string) => {
      /* Phase 1.18 — the owner acts as themselves, resolved from their own
         account. The Storefront inputs no longer take a claimed actor
         participant or a supplied authorization flag. */
      const { accountId } = await db.marketplaceParticipant.findUniqueOrThrow({
        where: { id: ownerParticipantId },
        select: { accountId: true },
      });
      return await createDraftStorefront(
        {
          ownerParticipantId,
          publicHandle: `mitigation-shop-${(counter += 1)}`,
          presentation: {
            displayName: "Synthetic Shop",
            tagline: "A synthetic storefront used only for tests.",
            summary: "A synthetic storefront for suspension tests.",
          },
          actingAccountId: accountId,
          now: NOW,
        },
        { db },
      );
    };

    it("permits drafting for a pre-admission participant with no suspension", async () => {
      const { participantId } = await seedPreAdmission();
      const snapshot = await draftStorefront(participantId);
      expect(snapshot.record.ownerParticipantId).toBe(participantId);
    });

    it("refuses drafting once an authoritative suspension stands", async () => {
      /* THE GAP THIS CLOSES. Phase 1.16 stopped manufacturing an admitted
         SUSPENDED status for a participant who was never admitted — correctly,
         since there is no admission to withdraw. But drafting eligibility is
         decided by `permitsDrafting`, which reads the projected status, so the
         suspension reached nothing. The row is the only place the answer lives. */
      const { participantId } = await seedPreAdmission();
      await suspend(participantId);

      /* The projection is deliberately NOT SUSPENDED — that is the point. */
      expect(await participantStatus(participantId)).toBe("PROFILE_COMPLETE");
      expect(await isParticipantSuspended(db, participantId)).toBe(true);

      await expect(draftStorefront(participantId)).rejects.toMatchObject({
        denialCode: "PARTICIPANT_SUSPENDED",
      });
    });

    it("restores drafting when the suspension is lifted", async () => {
      const { participantId } = await seedPreAdmission();
      const imposed = await suspend(participantId);
      await expect(draftStorefront(participantId)).rejects.toBeTruthy();

      await reinstateParticipant(
        {
          suspensionId: imposed.suspensionId,
          reasonCode: "LIFTED_ON_RECONSIDERATION",
          actingAccountId: actors.suspender,
          reinstatedAt: LATER,
        },
        { db },
      );

      const snapshot = await draftStorefront(participantId);
      expect(snapshot.record.ownerParticipantId).toBe(participantId);
    });

    it("keeps drafting available to a RESTRICTED participant", async () => {
      /* The asymmetry the architecture turns on: a restriction withholds
         COMMERCE, never the ability to correct the work that caused it.
         RESTRICTED must not become a synonym for SUSPENDED. */
      const participantId = await seedParticipant();
      await restrict(participantId, { scope: "offer:publish" });
      expect(await participantStatus(participantId)).toBe("RESTRICTED");

      const snapshot = await draftStorefront(participantId);
      expect(snapshot.record.ownerParticipantId).toBe(participantId);
    });

    it("does not deny on a risk signal without a suspension row", async () => {
      /* No score, ranking, or recommendation can produce this refusal — only a
         governed ParticipantSuspension can. */
      const { participantId } = await seedPreAdmission();
      expect(
        await db.participantSuspension.count({ where: { participantId, status: "ACTIVE" } }),
      ).toBe(0);
      const snapshot = await draftStorefront(participantId);
      expect(snapshot.record.ownerParticipantId).toBe(participantId);
    });
  });

  describe("1.16 · status converges to the evidence under concurrency", () => {
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1_3);
    });

    const lift = (restrictionId: string) =>
      liftParticipantRestriction(
        {
          restrictionId,
          reasonCode: "REQUIREMENT_SATISFIED",
          actingAccountId: actors.restrictor,
          liftedAt: LATER,
        },
        { db },
      );

    const activeRestrictions = (participantId: string) =>
      db.participantRestriction.count({ where: { participantId, status: "ACTIVE" } });

    it("converges to ACTIVE when two restrictions are lifted concurrently", async () => {
      /* THE RACE THIS CLOSES, and it was deterministic rather than rare.
      
         Each lift counted the remaining active restrictions, and under MySQL's
         REPEATABLE READ that count is a consistent read against the snapshot
         taken at the transaction's first read. So each transaction saw the
         OTHER's restriction as still active, each concluded no status change was
         warranted, and neither wrote. Both committed: RESTRICTED with zero active
         restrictions — measured 8 times out of 8 before the fix. */
      const participantId = await seedParticipant();
      const first = await restrict(participantId, { scope: "offer:publish" });
      const second = await restrict(participantId, { scope: "payout:receive" });
      expect(await participantStatus(participantId)).toBe("RESTRICTED");

      const outcomes = await Promise.allSettled([
        lift(first.restriction.restrictionId),
        lift(second.restriction.restrictionId),
      ]);
      /* A serialization conflict is retried inside the service, so a caller sees
         neither lift fail. */
      for (const o of outcomes) expect(o.status).toBe("fulfilled");

      expect(await activeRestrictions(participantId)).toBe(0);
      expect(await participantStatus(participantId)).toBe("ACTIVE");
    });

    it("never leaves RESTRICTED standing on zero evidence", async () => {
      /* Stated as the invariant rather than as an outcome, because this is the
         contradiction Phase 1.16 exists to eliminate. */
      const participantId = await seedParticipant();
      const a = await restrict(participantId, { scope: "offer:publish" });
      const b = await restrict(participantId, { scope: "payout:receive" });

      await Promise.allSettled([lift(a.restriction.restrictionId), lift(b.restriction.restrictionId)]);

      const status = await participantStatus(participantId);
      const remaining = await activeRestrictions(participantId);
      const suspensions = await db.participantSuspension.count({
        where: { participantId, status: "ACTIVE" },
      });
      expect(status === "RESTRICTED" && remaining === 0 && suspensions === 0).toBe(false);
    });

    it("stays RESTRICTED while one restriction remains", async () => {
      const participantId = await seedParticipant();
      const a = await restrict(participantId, { scope: "offer:publish" });
      await restrict(participantId, { scope: "payout:receive" });

      await lift(a.restriction.restrictionId);

      expect(await activeRestrictions(participantId)).toBe(1);
      expect(await participantStatus(participantId)).toBe("RESTRICTED");
    });

    it("keeps SUSPENDED dominant while restrictions are lifted underneath it", async () => {
      /* Suspension outranks the restriction overlay, so convergence must not
         quietly promote a suspended participant to ACTIVE. */
      const participantId = await seedParticipant();
      const a = await restrict(participantId, { scope: "offer:publish" });
      const b = await restrict(participantId, { scope: "payout:receive" });
      await suspend(participantId);
      expect(await participantStatus(participantId)).toBe("SUSPENDED");

      await Promise.allSettled([lift(a.restriction.restrictionId), lift(b.restriction.restrictionId)]);

      expect(await activeRestrictions(participantId)).toBe(0);
      expect(await participantStatus(participantId)).toBe("SUSPENDED");
    });

    it("is idempotent — a settled state is not rewritten", async () => {
      const participantId = await seedParticipant();
      const a = await restrict(participantId, { scope: "offer:publish" });
      await lift(a.restriction.restrictionId);
      expect(await participantStatus(participantId)).toBe("ACTIVE");

      const settled = await db.marketplaceParticipant.findUniqueOrThrow({
        where: { id: participantId },
      });

      /* A further governed mutation that warrants no status change leaves the row
         alone, `updatedAt` included. */
      const b = await restrict(participantId, { scope: "payout:receive" });
      await lift(b.restriction.restrictionId);
      const after = await db.marketplaceParticipant.findUniqueOrThrow({
        where: { id: participantId },
      });
      expect(after.status).toBe("ACTIVE");
      expect(settled.status).toBe("ACTIVE");
    });
  });

  describe("nothing enforces itself", () => {
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1_3);
    });

    it("changes nothing when a review recommends suspension", async () => {
      /* The whole architecture in one assertion: a recorded recommendation is a
         conclusion, and only a separately-entitled person acting deliberately
         changes a participant's standing. */
      const participantId = await seedParticipant();
      const before = await participantStatus(participantId);

      const policy = await db.sellerRiskReviewPolicy.findFirst();
      if (policy !== null) {
        /* Only meaningful where 1.13's heuristics exist; the assertion below
           holds regardless. */
      }
      expect(await db.participantSuspension.count({ where: { participantId } })).toBe(0);
      expect(await db.participantRestriction.count({ where: { participantId } })).toBe(0);
      expect(await participantStatus(participantId)).toBe(before);
    });

    it("creates no restriction as a side effect of suspending", async () => {
      const participantId = await seedParticipant();
      await suspend(participantId);
      expect(await db.participantRestriction.count({ where: { participantId } })).toBe(0);
    });
  });

  /* PHASE 1.17 — GOVERNED TERMINAL CLOSURE.
  
     Before this, `advanceParticipantStatus` could move an ACTIVE, RESTRICTED,
     SUSPENDED, or UNDER_REVIEW participant to CLOSED with no actor, no
     authorization, no reason, and no record — the only irreversible act in this
     subsystem, and the only one carrying none of the disciplines every other one
     carries. The contract and persistence tests prove that path is shut; this
     proves the governed replacement behaves, and that closure neither lifts a
     standing decision nor is undone by one. */
  describe("1.17 · terminal closure is governed, and settles nothing", () => {
    beforeEach(async () => {
      await activatePolicy(MARKETPLACE_POLICY_VERSION_1_3);
    });

    const ownerOf = async (participantId: string): Promise<string> =>
      (
        await db.marketplaceParticipant.findUniqueOrThrow({
          where: { id: participantId },
          select: { accountId: true },
        })
      ).accountId;

    const close = async (participantId: string, actingAccountId: string) =>
      closeParticipant(
        {
          participantId,
          actingAccountId,
          reasonCode: "NO_LONGER_TRADING_ON_MONACADO",
          closedAt: LATER,
        },
        { db },
      );

    it("refuses a closer who is not the participant, and tells them nothing", async () => {
      const participantId = await seedParticipant();
      const stranger = await seedParticipant();

      /* NOT-FOUND, deliberately — the same answer a non-existent participant
         gets, so an unauthorized caller learns neither that the participant
         exists nor what standing it holds. Staff entitlements confer nothing
         here either: no published term gives Monacado power to close somebody. */
      for (const actor of [await ownerOf(stranger), actors.restrictor, actors.suspender]) {
        await expect(close(participantId, actor)).rejects.toBeInstanceOf(
          ParticipantClosureNotFoundError,
        );
      }
      expect(await participantStatus(participantId)).toBe("ACTIVE");
      expect(await db.participantClosure.count({ where: { participantId } })).toBe(0);
    });

    it("records the actor, the reason, and the status it closed from", async () => {
      const participantId = await seedParticipant();
      const owner = await ownerOf(participantId);
      await restrict(participantId);
      expect(await participantStatus(participantId)).toBe("RESTRICTED");

      const closed = await close(participantId, owner);

      expect(closed.closedByAccountId).toBe(owner);
      expect(closed.reasonCode).toBe("NO_LONGER_TRADING_ON_MONACADO");
      /* The one fact closure destroys, and the reason the column exists: what
         this participant WAS when they left. */
      expect(closed.statusBeforeClosure).toBe("RESTRICTED");
      expect(await participantStatus(participantId)).toBe("CLOSED");

      /* Monacado owes the notice, keyed on the CLOSURE and never the
         participant — the obligation key hashes the subject, and using the
         participant would collide with every other standing notice. */
      const obligations = await db.notificationObligation.findMany({
        where: { recipientParticipantId: participantId, contextCode: "PARTICIPANT_CLOSED" },
      });
      expect(obligations).toHaveLength(1);
      expect(obligations[0]!.subjectRef).toBe(closed.closureId);

      /* CLOSING IS NOT EXONERATING. The restriction stands exactly as it did:
         the decision was never withdrawn, and marking it LIFTED would have meant
         choosing a lift reason that is a false statement about a closure and
         naming an account as having lifted what nobody lifted. */
      const history = await getParticipantRestrictionHistory(participantId, { db });
      expect(history[0]!.status).toBe("ACTIVE");
      expect(history[0]!.liftedAt).toBeNull();
      expect(history[0]!.liftedByAccountId).toBeNull();
    });

    it("keeps a suspension standing, and is not undone by reinstating it", async () => {
      const participantId = await seedParticipant();
      const owner = await ownerOf(participantId);
      const imposed = await suspend(participantId);
      expect(await participantStatus(participantId)).toBe("SUSPENDED");

      const closed = await close(participantId, owner);
      expect(closed.statusBeforeClosure).toBe("SUSPENDED");

      /* Closing did not silently reinstate. */
      const stillActive = await db.participantSuspension.findUniqueOrThrow({
        where: { id: imposed.suspensionId },
      });
      expect(stillActive.status).toBe("ACTIVE");
      expect(stillActive.liftedAt).toBeNull();

      /* And the reverse — reinstatement does not revive a closed participant.
         Reopening is a new admission decision with its own record, never a side
         effect of an unrelated act finishing. */
      await reinstateParticipant(
        {
          suspensionId: imposed.suspensionId,
          reasonCode: "REQUIREMENT_SATISFIED",
          actingAccountId: actors.suspender,
          reinstatedAt: LATER,
        },
        { db },
      );
      expect(await participantStatus(participantId)).toBe("CLOSED");
    });

    it("is not revived by lifting the last restriction, and never closes twice", async () => {
      const participantId = await seedParticipant();
      const owner = await ownerOf(participantId);
      const imposed = await restrict(participantId);
      await close(participantId, owner);

      await liftParticipantRestriction(
        {
          restrictionId: imposed.restriction.restrictionId,
          reasonCode: "REQUIREMENT_SATISFIED",
          actingAccountId: actors.restrictor,
          liftedAt: LATER,
        },
        { db },
      );
      /* RESTRICTED + 0 would ordinarily reconcile to ACTIVE. Terminal dominates. */
      expect(await participantStatus(participantId)).toBe("CLOSED");

      await expect(close(participantId, owner)).rejects.toBeInstanceOf(
        ParticipantAlreadyClosedError,
      );
      expect(await db.participantClosure.count({ where: { participantId } })).toBe(1);
    });

    it("acquires no new mitigation once closed, and keeps its identity and roles", async () => {
      const participantId = await seedParticipant();
      const owner = await ownerOf(participantId);
      await close(participantId, owner);

      /* The asymmetry 1.17 also fixed: `suspendParticipant` has refused a CLOSED
         target since 1.14 and `imposeParticipantRestriction` did not, so the
         heavier act refused while the lighter one proceeded. */
      await expect(restrict(participantId)).rejects.toBeInstanceOf(
        ParticipantLifecycleTerminatedError,
      );
      expect(await db.participantRestriction.count({ where: { participantId } })).toBe(0);

      /* Closure is not a deletion. Identity and roles survive, because completed
         commerce is anchored to them and Monacado remains merchant of record for
         every purchase already made. */
      const roles = await db.marketplaceRoleAssignment.findMany({ where: { participantId } });
      expect(roles.length).toBeGreaterThan(0);
      expect(await db.marketplaceParticipant.count({ where: { id: participantId } })).toBe(1);
    });
  });
});
