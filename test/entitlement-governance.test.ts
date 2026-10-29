/**
 * First-operator governance — pure contracts, CLI parsing, and source guards.
 *
 * No database. Proves the closed vocabularies are exactly what the owner ruled,
 * that the operator commands isolate their targets and demand the exact typed
 * confirmation, and that no production-capable path can write an entitlement
 * without an audit act.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_CAPABILITIES } from "../src/contracts/account/account";
import {
  ENTITLEMENT_ACT_ACTIONS,
  ENTITLEMENT_ACT_BASES,
  ENTITLEMENT_GOVERNED_CAPABILITIES,
  FIRST_GRANT_BOOTSTRAP_CAPABILITIES,
  FIRST_GRANT_REQUIRED_VERIFICATION,
  isEntitlementGovernedCapability,
  isFirstGrantBootstrapCapability,
} from "../src/contracts/account/entitlement-governance";
import {
  ENTITLEMENT_GOVERN_CAPABILITY,
  canGovernCommercialPolicy,
  canGovernEntitlements,
  canGovernMarketplacePolicy,
} from "../src/contracts/account/internal-authorization";
import {
  OperatorUsageError,
  evaluateExecution,
  parseOperatorArgs,
  parseOperatorTarget,
  resolveOperatorDatabaseUrl,
} from "../scripts/operator-target";
import {
  operatorEntitlementConfirmPhrase,
  parseOperatorEntitlementOptions,
} from "../scripts/operator-entitlement";
import {
  commercialPolicyBootstrapConfirmPhrase,
  parseCommercialPolicyBootstrapOptions,
} from "../scripts/commercial-policy-bootstrap";
import { assertLoopbackDatabase } from "./support/entitlement-fixture";

const ROOT = new URL("..", import.meta.url).pathname;
const ACCOUNT = "mon:acct:0000000000000000000000000A";
const ACTOR = "mon:acct:0000000000000000000000000B";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
  }
  return out;
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("entitlement governance vocabulary", () => {
  it("adds entitlement:govern to the closed capability vocabulary", () => {
    expect(ACCOUNT_CAPABILITIES).toContain("entitlement:govern");
    expect(ENTITLEMENT_GOVERN_CAPABILITY).toBe("entitlement:govern");
  });

  it("allows exactly entitlement:govern to be first-bootstrapped", () => {
    expect([...FIRST_GRANT_BOOTSTRAP_CAPABILITIES]).toEqual(["entitlement:govern"]);
    for (const capability of ACCOUNT_CAPABILITIES) {
      expect(isFirstGrantBootstrapCapability(capability)).toBe(capability === "entitlement:govern");
    }
    expect(isFirstGrantBootstrapCapability("entitlement:*")).toBe(false);
  });

  it("limits the governed surface to the two policy-governance grants", () => {
    expect([...ENTITLEMENT_GOVERNED_CAPABILITIES]).toEqual([
      "commercial-policy:govern",
      "marketplace-policy:govern",
    ]);
    for (const capability of ACCOUNT_CAPABILITIES) {
      expect(isEntitlementGovernedCapability(capability)).toBe(
        capability === "commercial-policy:govern" || capability === "marketplace-policy:govern",
      );
    }
    // In particular, never itself.
    expect(isEntitlementGovernedCapability("entitlement:govern")).toBe(false);
  });

  it("names its act vocabulary and verification requirement exactly", () => {
    expect([...ENTITLEMENT_ACT_ACTIONS]).toEqual(["GRANT", "REVOKE"]);
    expect([...ENTITLEMENT_ACT_BASES]).toEqual(["GOVERNED", "BOOTSTRAP_FIRST_GRANT"]);
    expect(FIRST_GRANT_REQUIRED_VERIFICATION).toBe("SELF_SERVICE_TOKEN");
  });

  it("authorizes governance only from an active entitlement:govern, and confers no policy authority", () => {
    const subject = (capabilities: string[], accountStatus = "ACTIVE") =>
      ({ accountId: ACCOUNT, accountStatus, capabilities }) as never;
    expect(canGovernEntitlements(subject(["entitlement:govern"])).decision).toBe("ALLOW");
    expect(canGovernEntitlements(subject(["entitlement:govern"], "DISABLED")).reasonCodes).toEqual([
      "INTERNAL_ACCOUNT_DISABLED",
    ]);
    expect(canGovernEntitlements(subject(["commercial-policy:govern"])).reasonCodes).toEqual([
      "INTERNAL_CAPABILITY_NOT_GRANTED",
    ]);
    expect(canGovernEntitlements(null).reasonCodes).toEqual(["INTERNAL_ACCOUNT_REQUIRED"]);
    // Holding the meta-capability is not holding what it governs.
    expect(canGovernCommercialPolicy(subject(["entitlement:govern"])).decision).toBe("DENY");
    expect(canGovernMarketplacePolicy(subject(["entitlement:govern"])).decision).toBe("DENY");
  });
});

describe("operator command target isolation", () => {
  const REMOTE = "mysql://u:secret@db.example.net:3306/prod";
  const LOCAL = "mysql://u:secret@127.0.0.1:3308/dev";

  it("requires an explicit target", () => {
    expect(() => parseOperatorTarget(undefined)).toThrow(OperatorUsageError);
    expect(() => parseOperatorTarget("staging")).toThrow(OperatorUsageError);
    expect(parseOperatorTarget("production")).toBe("production");
  });

  it("reads production ONLY from MONACADO_PROD_RUNTIME_DATABASE_URL — never DATABASE_URL", () => {
    expect(() => resolveOperatorDatabaseUrl("production", { DATABASE_URL: REMOTE })).toThrow(
      /MONACADO_PROD_RUNTIME_DATABASE_URL is not set/,
    );
    expect(
      resolveOperatorDatabaseUrl("production", {
        DATABASE_URL: LOCAL,
        MONACADO_PROD_RUNTIME_DATABASE_URL: REMOTE,
      }),
    ).toBe(REMOTE);
  });

  it("refuses a production target on a loopback host and a local target on a remote host", () => {
    expect(() =>
      resolveOperatorDatabaseUrl("production", { MONACADO_PROD_RUNTIME_DATABASE_URL: LOCAL }),
    ).toThrow(/loopback/);
    expect(() => resolveOperatorDatabaseUrl("local", { DATABASE_URL: REMOTE })).toThrow(/remote/);
    expect(() =>
      resolveOperatorDatabaseUrl("local", { MONACADO_PROD_RUNTIME_DATABASE_URL: LOCAL }),
    ).toThrow(/DATABASE_URL is not set/);
    expect(resolveOperatorDatabaseUrl("local", { DATABASE_URL: LOCAL })).toBe(LOCAL);
  });

  it("never puts a URL, host, or credential in a usage error", () => {
    const attempts = [
      () => resolveOperatorDatabaseUrl("local", { DATABASE_URL: REMOTE }),
      () => resolveOperatorDatabaseUrl("production", { MONACADO_PROD_RUNTIME_DATABASE_URL: LOCAL }),
      () => resolveOperatorDatabaseUrl("production", { MONACADO_PROD_RUNTIME_DATABASE_URL: "postgres://x:secret@h/d" }),
      () => parseOperatorArgs(["mysql://u:secret@h/d"], { values: [], flags: [] }),
    ];
    for (const attempt of attempts) {
      let message = "";
      try {
        attempt();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      for (const leak of ["secret", "db.example.net", "127.0.0.1", "u:", "postgres://"]) {
        expect(message).not.toContain(leak);
      }
    }
  });

  it("keeps the test fixture off any non-loopback database", () => {
    expect(() => assertLoopbackDatabase({ DATABASE_URL: REMOTE })).toThrow(/not a loopback/);
    expect(() => assertLoopbackDatabase({})).toThrow(/not a loopback/);
    expect(() => assertLoopbackDatabase({ DATABASE_URL: LOCAL })).not.toThrow();
  });
});

describe("operator command confirmation", () => {
  it("is a dry run without --execute, whatever --confirm says", () => {
    expect(evaluateExecution({ execute: false, confirm: undefined, expectedPhrase: "X" })).toBe("DRY_RUN");
    expect(evaluateExecution({ execute: false, confirm: "X", expectedPhrase: "X" })).toBe("DRY_RUN");
  });

  it("requires the exact phrase with --execute", () => {
    expect(() => evaluateExecution({ execute: true, confirm: undefined, expectedPhrase: "X Y" })).toThrow();
    expect(() => evaluateExecution({ execute: true, confirm: "x y", expectedPhrase: "X Y" })).toThrow();
    expect(() => evaluateExecution({ execute: true, confirm: "X Y ", expectedPhrase: "X Y" })).toThrow();
    expect(evaluateExecution({ execute: true, confirm: "X Y", expectedPhrase: "X Y" })).toBe("EXECUTE");
  });

  it("binds the phrase to the act, the accounts, and the target", () => {
    const bootstrap = parseOperatorEntitlementOptions([
      "bootstrap", "--target=production", `--account=${ACCOUNT}`, "--capability=entitlement:govern",
    ]);
    expect(operatorEntitlementConfirmPhrase(bootstrap)).toBe(
      `BOOTSTRAP entitlement:govern FOR ${ACCOUNT} ON production`,
    );
    const grant = parseOperatorEntitlementOptions([
      "grant", "--target=local", `--actor=${ACTOR}`, `--account=${ACCOUNT}`, "--capability=commercial-policy:govern",
    ]);
    expect(operatorEntitlementConfirmPhrase(grant)).toBe(
      `GRANT commercial-policy:govern TO ${ACCOUNT} BY ${ACTOR} ON local`,
    );
    const revoke = { ...grant, command: "revoke" as const };
    expect(operatorEntitlementConfirmPhrase(revoke)).toBe(
      `REVOKE commercial-policy:govern FROM ${ACCOUNT} BY ${ACTOR} ON local`,
    );
    const policy = parseCommercialPolicyBootstrapOptions(["--target=production", `--actor=${ACTOR}`]);
    expect(commercialPolicyBootstrapConfirmPhrase(policy)).toBe(
      `BOOTSTRAP commercial-policy STANDARD_V1 BY ${ACTOR} ON production`,
    );
    // A phrase confirmed for local does not execute against production.
    expect(() =>
      evaluateExecution({
        execute: true,
        confirm: operatorEntitlementConfirmPhrase(grant),
        expectedPhrase: operatorEntitlementConfirmPhrase({ ...grant, target: "production" }),
      }),
    ).toThrow();
  });

  it("refuses missing, unknown, and repeated arguments", () => {
    expect(() => parseOperatorEntitlementOptions(["promote", "--target=local"])).toThrow(OperatorUsageError);
    expect(() =>
      parseOperatorEntitlementOptions(["bootstrap", "--target=local", "--capability=entitlement:govern"]),
    ).toThrow(/--account/);
    expect(() =>
      parseOperatorEntitlementOptions([
        "grant", "--target=local", `--account=${ACCOUNT}`, "--capability=commercial-policy:govern",
      ]),
    ).toThrow(/--actor/);
    // `bootstrap` has no actor: there is nobody yet who could be one.
    expect(() =>
      parseOperatorEntitlementOptions([
        "bootstrap", "--target=local", `--actor=${ACTOR}`, `--account=${ACCOUNT}`, "--capability=entitlement:govern",
      ]),
    ).toThrow(/unrecognised/);
    expect(() =>
      parseOperatorEntitlementOptions([
        "bootstrap", "--target=local", "--target=production", `--account=${ACCOUNT}`, "--capability=entitlement:govern",
      ]),
    ).toThrow(/repeated/);
    expect(() =>
      parseOperatorEntitlementOptions([
        "bootstrap", "--target=local", `--account=${ACCOUNT}`, "--capability=entitlement:govern", "--force",
      ]),
    ).toThrow(OperatorUsageError);
  });
});

describe("no production-capable unaudited entitlement writer remains", () => {
  const productionCapable = [...sourceFiles("src"), ...sourceFiles("scripts")];

  it("writes AccountEntitlement only in the governance service (and db-check's local cleanup)", () => {
    const writers = productionCapable.filter((file) =>
      /accountEntitlement\.(create|createMany|upsert|update|updateMany|delete|deleteMany)\(/.test(read(file)),
    );
    expect(writers.sort()).toEqual([
      "scripts/db-check.ts",
      "src/server/account/entitlement-governance-service.ts",
    ]);
    // db-check's only entitlement write is its wholesale cleanup of a disposable database.
    expect(
      read("scripts/db-check.ts").match(/accountEntitlement\.(create|createMany|upsert|update|updateMany|delete)\(/),
    ).toBeNull();
  });

  it("writes AccountEntitlementAct only in the governance service", () => {
    const writers = productionCapable.filter((file) =>
      /accountEntitlementAct\.(create|createMany|upsert|update|updateMany|delete)\(/.test(read(file)),
    );
    expect(writers).toEqual(["src/server/account/entitlement-governance-service.ts"]);
  });

  it("exports no unrestricted grant or revoke from src", () => {
    for (const file of sourceFiles("src")) {
      expect(read(file)).not.toMatch(/export\s+(async\s+)?function\s+(grant|revoke)AccountEntitlement\b/);
    }
  });

  it("keeps the fixture out of src, and out of every script but db-check", () => {
    const importsFixture = (file: string) => /from\s+["'][^"']*entitlement-fixture["']/.test(read(file));
    for (const file of sourceFiles("src")) {
      expect(importsFixture(file)).toBe(false);
    }
    const scripts = sourceFiles("scripts").filter(importsFixture);
    expect(scripts).toEqual(["scripts/db-check.ts"]);
  });

  it("keeps the operator commands free of hard-coded identity and account creation", () => {
    for (const file of [
      "scripts/operator-target.ts",
      "scripts/operator-entitlement.ts",
      "scripts/commercial-policy-bootstrap.ts",
      "src/server/account/entitlement-governance-service.ts",
      "src/server/marketplace/commercial-policy-bootstrap.ts",
    ]) {
      const code = read(file);
      expect(code).not.toMatch(/mon:acct:[0-9A-HJKMNP-TV-Z]{26}/);
      expect(code).not.toMatch(/@[a-z0-9-]+\.(com|io|dev|net|org)/i);
      expect(code).not.toMatch(/createAccount\(|account\.create\(/);
      expect(code).not.toContain("console.");
    }
    // The services never read the environment; only the commands do, by name.
    for (const file of [
      "src/server/account/entitlement-governance-service.ts",
      "src/server/marketplace/commercial-policy-bootstrap.ts",
    ]) {
      expect(read(file)).not.toContain("process.env");
    }
  });
});
