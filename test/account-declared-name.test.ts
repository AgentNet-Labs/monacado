/**
 * Phase 1.37 — the declared first / last name, contract tests.
 *
 * Pure. NO DATABASE, NO NETWORK. Persistence and the registration route are
 * proved in `auth-sign-up-route.integration.test.ts`; this pins the rules the
 * contract itself owns, which every caller of `createAccount` inherits.
 *
 * A declared name is what the account holder says their name is (Contract §4).
 * It is not KYC, not a legal-name check, and not proof of identity, so the only
 * rules here are: trim, refuse empty, bound the length, declare both or neither.
 */

import { describe, expect, it } from "vitest";
import {
  AccountDeclaredName,
  AccountRecord,
  CreateAccountInput,
} from "../src/contracts/account/account";
import { SignUpRequest } from "../src/server/account/sign-up-route-handler";

const BASE = {
  name: "Display Name",
  email: "declared@example.com",
  password: "a-correct-horse-battery",
  createdAt: "2028-09-01T09:00:00.000Z",
};

describe("1.37 — declared first / last name", () => {
  it("trims surrounding whitespace and refuses a value that is empty after trimming", () => {
    expect(AccountDeclaredName.parse("  Grace ")).toBe("Grace");
    for (const empty of ["", " ", "\t \n"]) {
      expect(AccountDeclaredName.safeParse(empty).success).toBe(false);
    }
  });

  it("imposes no invented format rule on real names", () => {
    for (const name of ["O'Brien", "Jean-Luc", "José", "李", "de la Cruz", "X"]) {
      expect(AccountDeclaredName.parse(name)).toBe(name);
    }
  });

  it("accepts both names or neither on administrative creation — never one alone", () => {
    expect(CreateAccountInput.safeParse(BASE).success).toBe(true);

    const both = CreateAccountInput.parse({ ...BASE, firstName: " Grace", lastName: "Hopper " });
    expect([both.firstName, both.lastName]).toEqual(["Grace", "Hopper"]);

    expect(CreateAccountInput.safeParse({ ...BASE, firstName: "Grace" }).success).toBe(false);
    expect(CreateAccountInput.safeParse({ ...BASE, lastName: "Hopper" }).success).toBe(false);
    expect(
      CreateAccountInput.safeParse({ ...BASE, firstName: "  ", lastName: "Hopper" }).success,
    ).toBe(false);
  });

  it("requires both names on public sign-up", () => {
    const valid = { firstName: "Grace", lastName: "Hopper", email: "x@example.com", password: "p" };
    expect(SignUpRequest.safeParse(valid).success).toBe(true);
    expect(SignUpRequest.safeParse({ ...valid, firstName: undefined }).success).toBe(false);
    expect(SignUpRequest.safeParse({ ...valid, lastName: undefined }).success).toBe(false);
    /* The pre-1.37 single `name` is not an accepted alternative. */
    const { firstName: _f, lastName: _l, ...rest } = valid;
    expect(SignUpRequest.safeParse({ ...rest, name: "Grace Hopper" }).success).toBe(false);
  });

  it("carries the declared names on the safe record as nullable, with no verification field for them", () => {
    const record = {
      accountId: "mon:acct:01HZZZZZZZZZZZZZZZZZZZZZZZ",
      name: "Grace Hopper",
      firstName: null,
      lastName: null,
      email: "declared@example.com",
      normalizedEmail: "declared@example.com",
      status: "ACTIVE",
      createdAt: "2028-09-01T09:00:00.000Z",
      emailVerifiedAt: null,
      emailVerifiedVia: null,
    };
    /* NULL is the honest "not declared" state of an account created without one. */
    expect(AccountRecord.safeParse(record).success).toBe(true);
    expect(
      AccountRecord.safeParse({ ...record, firstName: "Grace", lastName: "Hopper" }).success,
    ).toBe(true);

    /* The only verification-shaped fields remain the email marker and its
       provenance; a declared name adds none. */
    const verificationShaped = Object.keys(AccountRecord.shape).filter((key) =>
      /verif|kyc/i.test(key),
    );
    expect(verificationShaped.sort()).toEqual(["emailVerifiedAt", "emailVerifiedVia"]);
  });
});
