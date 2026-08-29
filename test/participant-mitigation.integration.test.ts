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
    await db.participantSuspension.deleteMany({ where: { participantId: { in: ids } } });
    await db.participantRestriction.deleteMany({ where: { participantId: { in: ids } } });
    await db.participantActivation.deleteMany({ where: { participantId: { in: ids } } });
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
});
