/**
 * First-operator governance — against a real database.
 *
 * Proves the once-ever first grant, governed grants and revocations, the
 * append-only act written atomically with every change, the operator commands
 * end to end on a local target, and the governed CommercialPolicy bootstrap.
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import {
  bootstrapFirstEntitlement,
  grantEntitlementAsGovernor,
  listEntitlementActs,
  revokeEntitlementAsGovernor,
} from "../src/server/account/entitlement-governance-service";
import { EntitlementGovernanceRefusedError } from "../src/server/account/entitlement-governance-errors";
import { cryptoEntitlementGovernanceIdProvider } from "../src/server/account/account-ids";
import {
  CommercialPolicyBootstrapRefusedError,
  bootstrapStandardCommercialPolicy,
} from "../src/server/marketplace/commercial-policy-bootstrap";
import {
  activateCommercialPolicyVersion,
  createCommercialPolicy,
  getEffectiveCommercialPolicyVersion,
  recordCommercialPolicyVersion,
} from "../src/server/marketplace/commercial-policy-service";
import { MONACADO_STANDARD_POLICY_V1 } from "../src/contracts/marketplace/commercial-policy";
import { main as operatorCommand } from "../scripts/operator-entitlement";
import { main as commercialPolicyCommand } from "../scripts/commercial-policy-bootstrap";
import { grantAccountEntitlement } from "./support/entitlement-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = getPrisma();

const NOW = "2027-04-01T09:00:00.000Z";
const shift = (seconds: number): string =>
  new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
const PASSWORD = "correct-horse-battery-staple-5521";
const META = "entitlement:govern";
const CPOL = "commercial-policy:govern";
const MPOL = "marketplace-policy:govern";
const LOCAL_ENV = { DATABASE_URL: process.env.DATABASE_URL };

let seq = 0;

async function cleanup(): Promise<void> {
  await db.commercialPolicyVersionRow.deleteMany({});
  await db.commercialPolicy.deleteMany({});
  // Acts are RESTRICT on both accounts they name, so they go first.
  await db.accountEntitlementAct.deleteMany({});
  await db.accountEntitlement.deleteMany({});
  await db.accountSession.deleteMany({});
  await db.account.deleteMany({});
}

/**
 * An account in the state a real operator reaches by signing up and consuming
 * the verification link — or, with `via`, a weaker provenance.
 */
async function seedAccount(
  options: {
    via?: "SELF_SERVICE_TOKEN" | "ADMINISTRATIVE" | "PRE_VERIFICATION_BACKFILL" | null;
    status?: "ACTIVE" | "DISABLED";
  } = {},
): Promise<string> {
  seq += 1;
  const account = await createAccount(
    {
      name: "Operator",
      email: `operator${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
      emailVerification: "UNVERIFIED",
      ...(options.status !== undefined ? { status: options.status } : {}),
    },
    { db },
  );
  const via = options.via === undefined ? "SELF_SERVICE_TOKEN" : options.via;
  if (via !== null) {
    await db.account.update({
      where: { id: account.accountId },
      data: { emailVerifiedAt: new Date(NOW), emailVerifiedVia: via },
    });
  }
  return account.accountId;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EntitlementGovernanceRefusedError) return error.refusal;
    if (error instanceof CommercialPolicyBootstrapRefusedError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

const bootstrap = (accountId: string, capability = META, actedAt = NOW) =>
  bootstrapFirstEntitlement({ accountId, capability, actedAt }, { db });

const grant = (actorAccountId: string, accountId: string, capability: string, at = shift(60)) =>
  grantEntitlementAsGovernor({ actorAccountId, accountId, capability, actedAt: at }, { db });

const revoke = (actorAccountId: string, accountId: string, capability: string, at = shift(120)) =>
  revokeEntitlementAsGovernor({ actorAccountId, accountId, capability, actedAt: at }, { db });

async function activeHolders(capability: string): Promise<string[]> {
  const rows = await db.accountEntitlement.findMany({
    where: { capability, status: "ACTIVE" },
    select: { accountId: true },
  });
  return rows.map((r) => r.accountId);
}

describe.skipIf(!RUN)("first-operator governance (disposable MySQL)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  describe("first bootstrap", () => {
    it("grants entitlement:govern once, writing the act and the entitlement together", async () => {
      const operator = await seedAccount();
      const outcome = await bootstrap(operator);
      expect(outcome.outcome).toBe("GRANTED");
      expect(outcome.act).toMatchObject({
        accountId: operator,
        capability: META,
        action: "GRANT",
        basis: "BOOTSTRAP_FIRST_GRANT",
        actorAccountId: null,
        actedAt: NOW,
      });
      expect(await activeHolders(META)).toEqual([operator]);
      const row = await db.accountEntitlementAct.findUniqueOrThrow({ where: { id: outcome.act.actId } });
      expect(row.firstGrantForCapability).toBe(META);
      expect(await listEntitlementActs(operator, { db })).toEqual([outcome.act]);
    });

    it("is idempotent for the same account and writes nothing on a rerun", async () => {
      const operator = await seedAccount();
      const first = await bootstrap(operator);
      const again = await bootstrap(operator, META, shift(600));
      expect(again).toEqual({ outcome: "ALREADY_BOOTSTRAPPED", act: first.act });
      expect(await db.accountEntitlementAct.count()).toBe(1);
    });

    it("refuses every capability but entitlement:govern, before reading anything", async () => {
      const operator = await seedAccount();
      for (const capability of [CPOL, MPOL, "participant:restrict", "refund:initiate", "not-a-capability"]) {
        expect(await refusal(bootstrap(operator, capability))).toBe("CAPABILITY_NOT_BOOTSTRAPPABLE");
      }
      expect(await db.accountEntitlementAct.count()).toBe(0);
      expect(await db.accountEntitlement.count()).toBe(0);
    });

    it("requires an existing, ACTIVE account that proved its address through a self-service token", async () => {
      expect(await refusal(bootstrap("mon:acct:0000000000000000000000000Z"))).toBe("ACCOUNT_NOT_FOUND");
      expect(await refusal(bootstrap(await seedAccount({ status: "DISABLED" })))).toBe("ACCOUNT_DISABLED");
      for (const via of ["ADMINISTRATIVE", "PRE_VERIFICATION_BACKFILL", null] as const) {
        expect(await refusal(bootstrap(await seedAccount({ via })))).toBe("EMAIL_NOT_SELF_VERIFIED");
      }
      expect(await db.accountEntitlementAct.count()).toBe(0);
      expect(await db.accountEntitlement.count()).toBe(0);
    });

    it("refuses while any account already actively holds the capability", async () => {
      const fixtureHolder = await seedAccount();
      await grantAccountEntitlement({ accountId: fixtureHolder, capability: META, grantedAt: NOW }, { db });
      expect(await refusal(bootstrap(await seedAccount()))).toBe("CAPABILITY_ALREADY_HELD");
      expect(await db.accountEntitlementAct.count()).toBe(0);
    });

    it("is once-ever: another account, or the same one after losing it, is refused", async () => {
      const first = await seedAccount();
      await bootstrap(first);
      expect(await refusal(bootstrap(await seedAccount()))).toBe("FIRST_GRANT_ALREADY_CLAIMED");

      // Even with no holder left (here forced directly — no governed path can do
      // it), the bootstrap does not re-open.
      await db.accountEntitlement.updateMany({ where: { capability: META }, data: { status: "REVOKED" } });
      expect(await activeHolders(META)).toEqual([]);
      expect(await refusal(bootstrap(await seedAccount()))).toBe("FIRST_GRANT_ALREADY_CLAIMED");
      expect(await refusal(bootstrap(first))).toBe("FIRST_GRANT_ALREADY_CLAIMED");
      expect(await db.accountEntitlementAct.count()).toBe(1);
    });

    it("has exactly one winner when different accounts bootstrap concurrently", async () => {
      const candidates = await Promise.all([seedAccount(), seedAccount(), seedAccount(), seedAccount()]);
      const results = await Promise.allSettled(candidates.map((id) => bootstrap(id)));
      const granted = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      expect(granted).toHaveLength(1);
      for (const r of refused) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(EntitlementGovernanceRefusedError);
        expect(((r as PromiseRejectedResult).reason as EntitlementGovernanceRefusedError).refusal).toBe(
          "FIRST_GRANT_ALREADY_CLAIMED",
        );
      }
      expect(await db.accountEntitlementAct.count()).toBe(1);
      expect(await activeHolders(META)).toHaveLength(1);
    });

    it("serializes concurrent reruns for the same account into one grant", async () => {
      const operator = await seedAccount();
      const results = await Promise.all([bootstrap(operator), bootstrap(operator), bootstrap(operator)]);
      expect(results.map((r) => r.outcome).sort()).toEqual([
        "ALREADY_BOOTSTRAPPED",
        "ALREADY_BOOTSTRAPPED",
        "GRANTED",
      ]);
      expect(await db.accountEntitlementAct.count()).toBe(1);
    });

    it("rolls back the act when the entitlement write fails", async () => {
      const other = await seedAccount();
      const taken = await grantAccountEntitlement({ accountId: other, capability: CPOL, grantedAt: NOW }, { db });
      const operator = await seedAccount();
      await expect(
        bootstrapFirstEntitlement(
          { accountId: operator, capability: META, actedAt: NOW },
          {
            db,
            ids: {
              nextEntitlementActId: cryptoEntitlementGovernanceIdProvider.nextEntitlementActId,
              // Collides with an existing row, after the act has been inserted.
              nextEntitlementId: () => taken.entitlementId,
            },
          },
        ),
      ).rejects.toThrow(/persistence failure/);
      expect(await db.accountEntitlementAct.count()).toBe(0);
      expect(await activeHolders(META)).toEqual([]);
      // The marker was rolled back with it, so a clean retry succeeds.
      expect((await bootstrap(operator)).outcome).toBe("GRANTED");
    });
  });

  describe("governed grants and revocations", () => {
    async function governor(): Promise<string> {
      const id = await seedAccount();
      await bootstrap(id);
      return id;
    }

    it("lets the operator self-grant both policy-governance capabilities, each with a named act", async () => {
      const operator = await governor();
      const c = await grant(operator, operator, CPOL);
      const m = await grant(operator, operator, MPOL, shift(61));
      for (const [outcome, capability] of [[c, CPOL], [m, MPOL]] as const) {
        expect(outcome.act).toMatchObject({
          accountId: operator,
          capability,
          action: "GRANT",
          basis: "GOVERNED",
          actorAccountId: operator,
        });
      }
      expect((await listEntitlementActs(operator, { db })).map((a) => a.capability)).toEqual([META, CPOL, MPOL]);
      expect(await activeHolders(CPOL)).toEqual([operator]);
    });

    it("grants nothing outside the two policy-governance capabilities — not even entitlement:govern", async () => {
      const operator = await governor();
      const other = await seedAccount();
      for (const capability of [META, "participant:restrict", "refund:initiate", "risk-policy:govern", "nope"]) {
        expect(await refusal(grant(operator, other, capability))).toBe("CAPABILITY_NOT_GOVERNABLE");
      }
      for (const capability of ["participant:restrict", "refund:initiate", "nope"]) {
        expect(await refusal(revoke(operator, other, capability))).toBe("CAPABILITY_NOT_GOVERNABLE");
      }
      expect(await db.accountEntitlementAct.count()).toBe(1);
    });

    it("refuses an actor without an active entitlement:govern", async () => {
      const operator = await governor();
      const target = await seedAccount();
      // Holding the governed capability itself confers no authority to grant it.
      const policyHolder = await seedAccount();
      await grant(operator, policyHolder, CPOL);

      for (const actor of [target, policyHolder, "mon:acct:0000000000000000000000000Z"]) {
        expect(await refusal(grant(actor, target, CPOL))).toBe("ACTOR_NOT_AUTHORIZED");
        expect(await refusal(revoke(actor, policyHolder, CPOL))).toBe("ACTOR_NOT_AUTHORIZED");
      }
      // A disabled governor is refused on the next act.
      await db.account.update({ where: { id: operator }, data: { status: "DISABLED" } });
      expect(await refusal(grant(operator, target, MPOL))).toBe("ACTOR_NOT_AUTHORIZED");
      // A revoked governor likewise (forced directly; no governed path revokes it).
      await db.account.update({ where: { id: operator }, data: { status: "ACTIVE" } });
      await db.accountEntitlement.updateMany({ where: { accountId: operator, capability: META }, data: { status: "REVOKED" } });
      expect(await refusal(grant(operator, target, MPOL))).toBe("ACTOR_NOT_AUTHORIZED");
      expect(await activeHolders(MPOL)).toEqual([]);
    });

    it("refuses an unknown or disabled target", async () => {
      const operator = await governor();
      expect(await refusal(grant(operator, "mon:acct:0000000000000000000000000Z", CPOL))).toBe("ACCOUNT_NOT_FOUND");
      expect(await refusal(grant(operator, await seedAccount({ status: "DISABLED" }), CPOL))).toBe("ACCOUNT_DISABLED");
    });

    it("refuses a duplicate grant and a revoke of something not held, writing no act", async () => {
      const operator = await governor();
      const target = await seedAccount();
      expect(await refusal(revoke(operator, target, CPOL))).toBe("ENTITLEMENT_NOT_ACTIVE");
      await grant(operator, target, CPOL);
      expect(await refusal(grant(operator, target, CPOL, shift(90)))).toBe("ENTITLEMENT_ALREADY_ACTIVE");
      await revoke(operator, target, CPOL);
      expect(await refusal(revoke(operator, target, CPOL, shift(180)))).toBe("ENTITLEMENT_NOT_ACTIVE");
      expect(await activeHolders(CPOL)).toEqual([]);

      // Re-granting after a revocation reactivates the one row and appends.
      await grant(operator, target, CPOL, shift(240));
      expect(await activeHolders(CPOL)).toEqual([target]);
      const history = (await listEntitlementActs(target, { db })).map((a) => `${a.action}@${a.actedAt}`);
      expect(history).toEqual([`GRANT@${shift(60)}`, `REVOKE@${shift(120)}`, `GRANT@${shift(240)}`]);
      expect(await db.accountEntitlement.count({ where: { accountId: target } })).toBe(1);
    });

    it("never revokes the last active entitlement:govern holder", async () => {
      const operator = await governor();
      expect(await refusal(revoke(operator, operator, META))).toBe("LAST_ENTITLEMENT_GOVERNOR");
      expect(await activeHolders(META)).toEqual([operator]);

      // With a second holder (only a fixture can make one in this phase), the
      // meta-capability is still not on the governed surface.
      const second = await seedAccount();
      await grantAccountEntitlement({ accountId: second, capability: META, grantedAt: NOW }, { db });
      expect(await refusal(revoke(operator, second, META))).toBe("CAPABILITY_NOT_GOVERNABLE");
      expect((await activeHolders(META)).sort()).toEqual([operator, second].sort());
    });

    it("serializes concurrent identical grants into one act", async () => {
      const operator = await governor();
      const target = await seedAccount();
      const results = await Promise.allSettled([1, 2, 3].map(() => grant(operator, target, CPOL)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected")) {
        expect(((r as PromiseRejectedResult).reason as EntitlementGovernanceRefusedError).refusal).toBe(
          "ENTITLEMENT_ALREADY_ACTIVE",
        );
      }
      expect(await db.accountEntitlementAct.count({ where: { accountId: target } })).toBe(1);
    });

    it("rolls back the act when the entitlement write fails", async () => {
      const operator = await governor();
      const other = await seedAccount();
      const taken = await grantAccountEntitlement({ accountId: other, capability: "refund:initiate", grantedAt: NOW }, { db });
      const target = await seedAccount();
      await expect(
        grantEntitlementAsGovernor(
          { actorAccountId: operator, accountId: target, capability: CPOL, actedAt: NOW },
          {
            db,
            ids: {
              nextEntitlementActId: cryptoEntitlementGovernanceIdProvider.nextEntitlementActId,
              nextEntitlementId: () => taken.entitlementId,
            },
          },
        ),
      ).rejects.toThrow(/persistence failure/);
      expect(await db.accountEntitlementAct.count({ where: { accountId: target } })).toBe(0);
      expect(await activeHolders(CPOL)).toEqual([]);
    });
  });

  describe("operator commands on a local target", () => {
    async function run(
      command: typeof operatorCommand | typeof commercialPolicyCommand,
      argv: string[],
    ): Promise<{ code: number; json: Record<string, unknown>; raw: string }> {
      const lines: string[] = [];
      const code = await command(argv, LOCAL_ENV, (line) => lines.push(line), { db, now: () => NOW });
      expect(lines).toHaveLength(1);
      return { code, json: JSON.parse(lines[0]!) as Record<string, unknown>, raw: lines[0]! };
    }

    it("dry-runs by default, then bootstraps, grants, and revokes only with the exact phrase", async () => {
      const operator = await seedAccount();
      const base = ["--target=local", `--account=${operator}`, `--capability=${META}`];

      const dry = await run(operatorCommand, ["bootstrap", ...base]);
      expect(dry.code).toBe(0);
      expect(dry.json).toMatchObject({
        result: "DRY_RUN",
        preflight: { accountExists: true, accountStatus: "ACTIVE", emailVerifiedVia: "SELF_SERVICE_TOKEN", activeHolderCount: 0, firstGrantAccountId: null },
      });
      expect(await db.accountEntitlementAct.count()).toBe(0);

      const wrong = await run(operatorCommand, ["bootstrap", ...base, "--execute", "--confirm=yes"]);
      expect(wrong.code).toBe(2);
      expect(await db.accountEntitlementAct.count()).toBe(0);

      const exec = ["bootstrap", ...base, "--execute", `--confirm=${dry.json.confirmPhrase as string}`];
      const done = await run(operatorCommand, exec);
      expect(done.code).toBe(0);
      expect(done.json).toMatchObject({ result: "GRANTED", mode: "EXECUTE", accountId: operator });
      const rerun = await run(operatorCommand, exec);
      expect(rerun.code).toBe(0);
      expect(rerun.json.result).toBe("ALREADY_BOOTSTRAPPED");

      const grantArgs = ["grant", "--target=local", `--actor=${operator}`, `--account=${operator}`, `--capability=${CPOL}`];
      const grantPhrase = (await run(operatorCommand, grantArgs)).json.confirmPhrase as string;
      expect((await run(operatorCommand, [...grantArgs, "--execute", `--confirm=${grantPhrase}`])).json.result).toBe("GRANTED");

      const revokeArgs = ["revoke", "--target=local", `--actor=${operator}`, `--account=${operator}`, `--capability=${META}`];
      const revokePhrase = (await run(operatorCommand, revokeArgs)).json.confirmPhrase as string;
      const last = await run(operatorCommand, [...revokeArgs, "--execute", `--confirm=${revokePhrase}`]);
      expect(last.code).toBe(1);
      expect(last.json).toMatchObject({ result: "REFUSED", refusal: "LAST_ENTITLEMENT_GOVERNOR" });
    });

    it("prints no URL, credential, email, or name", async () => {
      const operator = await seedAccount();
      const outputs = [
        await run(operatorCommand, ["bootstrap", "--target=local", `--account=${operator}`, `--capability=${META}`]),
        await run(commercialPolicyCommand, ["--target=local", `--actor=${operator}`]),
        await run(operatorCommand, ["bootstrap", "--target=production", `--account=${operator}`, `--capability=${META}`]),
      ];
      const url = new URL(process.env.DATABASE_URL!);
      for (const { raw } of outputs) {
        expect(raw.length).toBeLessThan(1_000);
        for (const leak of [process.env.DATABASE_URL!, url.password, url.username, url.host, "@example.com", "Operator", PASSWORD]) {
          if (leak !== "") expect(raw).not.toContain(leak);
        }
      }
      // A production target with no production URL is a usage error, never a local write.
      expect(outputs[2]!.code).toBe(2);
    });
  });

  describe("CommercialPolicy bootstrap", () => {
    async function policyGovernor(): Promise<string> {
      const operator = await seedAccount();
      await bootstrap(operator);
      await grant(operator, operator, CPOL);
      return operator;
    }

    it("requires commercial-policy:govern — entitlement:govern alone is not enough", async () => {
      const operator = await seedAccount();
      await bootstrap(operator);
      expect(await refusal(bootstrapStandardCommercialPolicy({ actorAccountId: operator, now: NOW }, { db }))).toBe(
        "ACTOR_NOT_AUTHORIZED",
      );
      expect(await db.commercialPolicy.count()).toBe(0);
    });

    it("records and activates STANDARD_V1 once, then returns the same policy without writing", async () => {
      const operator = await policyGovernor();
      const first = await bootstrapStandardCommercialPolicy({ actorAccountId: operator, now: NOW }, { db });
      expect(first.outcome).toBe("ACTIVATED");
      const effective = await getEffectiveCommercialPolicyVersion(first.policyId, { db });
      expect(effective).toMatchObject({
        policyVersion: "1",
        status: "ACTIVE",
        currency: "USD",
        retainedPercentageBasisPoints: 750,
        retainedFixedAmountMinorUnits: 100,
        roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
        recordedByAccountId: operator,
      });
      const row = await db.commercialPolicyVersionRow.findFirstOrThrow({ where: { policyId: first.policyId } });
      expect(row.activatedByAccountId).toBe(operator);
      const policy = await db.commercialPolicy.findUniqueOrThrow({ where: { id: first.policyId } });
      expect(policy.bootstrapKey).toBe("STANDARD_V1");

      const again = await bootstrapStandardCommercialPolicy({ actorAccountId: operator, now: shift(60) }, { db });
      expect(again).toEqual({ outcome: "ALREADY_ACTIVE", policyId: first.policyId, policyVersion: "1" });
      expect(await db.commercialPolicy.count()).toBe(1);
      expect(await db.commercialPolicyVersionRow.count()).toBe(1);
    });

    it("adopts an equivalent ACTIVE policy created otherwise", async () => {
      const operator = await policyGovernor();
      const manual = await createCommercialPolicy({ label: "manual", now: NOW }, { db });
      await recordCommercialPolicyVersion(
        { ...MONACADO_STANDARD_POLICY_V1, policyId: manual.policyId, effectiveFrom: NOW, recordedByAccountId: operator, recordedAt: NOW },
        { db },
      );
      await activateCommercialPolicyVersion(
        { policyId: manual.policyId, policyVersion: "1", activatedByAccountId: operator, activatedAt: NOW },
        { db },
      );
      const outcome = await bootstrapStandardCommercialPolicy({ actorAccountId: operator, now: NOW }, { db });
      expect(outcome).toEqual({ outcome: "ALREADY_ACTIVE", policyId: manual.policyId, policyVersion: "1" });
      expect(await db.commercialPolicy.count()).toBe(1);
    });

    it("refuses when an ACTIVE policy with different economics exists", async () => {
      const operator = await policyGovernor();
      const other = await createCommercialPolicy({ label: "other", now: NOW }, { db });
      await recordCommercialPolicyVersion(
        { ...MONACADO_STANDARD_POLICY_V1, retainedPercentageBasisPoints: 800, policyId: other.policyId, effectiveFrom: NOW, recordedByAccountId: operator, recordedAt: NOW },
        { db },
      );
      await activateCommercialPolicyVersion(
        { policyId: other.policyId, policyVersion: "1", activatedByAccountId: operator, activatedAt: NOW },
        { db },
      );
      expect(await refusal(bootstrapStandardCommercialPolicy({ actorAccountId: operator, now: NOW }, { db }))).toBe(
        "CONFLICTING_ACTIVE_POLICY",
      );
      expect(await db.commercialPolicy.count({ where: { bootstrapKey: { not: null } } })).toBe(0);
    });

    it("resumes an interrupted run instead of creating a second policy", async () => {
      const operator = await policyGovernor();
      // Interrupted after create: a keyed policy with no version.
      const keyed = await db.commercialPolicy.create({
        data: { id: "mon:cpol:0000000000000000000000GVBT", label: "interrupted", bootstrapKey: "STANDARD_V1" },
      });
      const outcome = await bootstrapStandardCommercialPolicy({ actorAccountId: operator, now: NOW }, { db });
      expect(outcome).toEqual({ outcome: "ACTIVATED", policyId: keyed.id, policyVersion: "1" });
      expect(await db.commercialPolicy.count()).toBe(1);
    });

    it("creates exactly one policy under concurrent bootstraps", async () => {
      const operator = await policyGovernor();
      const results = await Promise.allSettled(
        [0, 1, 2, 3].map((i) => bootstrapStandardCommercialPolicy({ actorAccountId: operator, now: shift(i) }, { db })),
      );
      const ids = new Set(
        results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ policyId: string }>).value.policyId),
      );
      expect(ids.size).toBe(1);
      expect(await db.commercialPolicy.count()).toBe(1);
      expect(await db.commercialPolicyVersionRow.count({ where: { status: "ACTIVE" } })).toBe(1);
    });

    it("prints the policy id through the command, after a dry run and the exact phrase", async () => {
      const operator = await policyGovernor();
      const lines: string[] = [];
      const out = (line: string) => lines.push(line);
      const args = ["--target=local", `--actor=${operator}`];
      expect(await commercialPolicyCommand(args, LOCAL_ENV, out, { db, now: () => NOW })).toBe(0);
      const dry = JSON.parse(lines[0]!) as { confirmPhrase: string; preflight: { actorAuthorized: boolean } };
      expect(dry.preflight.actorAuthorized).toBe(true);
      expect(await db.commercialPolicy.count()).toBe(0);
      expect(
        await commercialPolicyCommand([...args, "--execute", `--confirm=${dry.confirmPhrase}`], LOCAL_ENV, out, { db, now: () => NOW }),
      ).toBe(0);
      const done = JSON.parse(lines[1]!) as { result: string; policyId: string };
      expect(done.result).toBe("ACTIVATED");
      expect(done.policyId).toBe((await db.commercialPolicy.findFirstOrThrow()).id);
    });
  });
});
