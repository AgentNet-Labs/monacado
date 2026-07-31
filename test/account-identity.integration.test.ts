/**
 * Identity, session, and internal entitlement tests (Phase 0E.7.4.2A).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 *
 * NO NETWORK. Every password below is synthetic and obviously fake; no real
 * credential appears in this repository. Instants and identities are injected, so
 * nothing here depends on a real clock.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import {
  authenticateAccount,
  createAccount,
  getAccountById,
  setAccountStatus,
} from "../src/server/account/account-service";
import {
  createAccountSession,
  resolveAccountSession,
  revokeAccountSession,
  revokeAllAccountSessions,
} from "../src/server/account/account-session-service";
import {
  accountHasCapability,
  grantAccountEntitlement,
  listAccountCapabilities,
  revokeAccountEntitlement,
} from "../src/server/account/account-entitlement-service";
import { resolveAuthenticatedPrincipal } from "../src/server/account/account-principal";
import {
  AccountNotFoundError,
  DuplicateAccountEmailError,
  InvalidAccountInputError,
  InvalidCredentialsError,
  UnsupportedCapabilityError,
} from "../src/server/account/account-errors";
import {
  ARGON2ID_PREFIX,
  hashPassword,
  verifyPassword,
} from "../src/server/account/password";
import {
  SESSION_TOKEN_HASH_RE,
  SESSION_TOKEN_RE,
  cryptoSessionTokenProvider,
  hashSessionToken,
} from "../src/server/account/session-token";
import {
  SESSION_COOKIE_NAME,
  buildClearedSessionCookie,
  buildSessionCookie,
  readSessionCookie,
} from "../src/server/account/session-cookie";
import { ACCOUNT_ID_PATTERNS, cryptoAccountIdProvider } from "../src/server/account/account-ids";
import {
  ACCOUNT_CAPABILITIES,
  AuthenticatedPrincipal,
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
} from "../src/contracts/account/account";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = getPrisma();

const NOW = "2027-03-01T09:00:00.000Z";
const shift = (seconds: number): string =>
  new Date(Date.parse(NOW) + seconds * 1_000).toISOString();

/** Synthetic. Long enough for the 12-character floor; not a real credential. */
const PASSWORD = "correct-horse-battery-staple-9271";
const OTHER_PASSWORD = "entirely-different-passphrase-4410";
const CAPABILITY = "publication-worker:status:read";

let seq = 0;
const nextEmail = (): string => {
  seq += 1;
  return `ops.person${seq}@example.com`;
};

async function cleanup(): Promise<void> {
  // Entitlements are RESTRICT, so they must go before their accounts. Sessions
  // would cascade, but are removed explicitly so the order documents itself.
  await db.accountEntitlement.deleteMany({});
  await db.accountSession.deleteMany({});
  await db.account.deleteMany({});
}

async function seedAccount(
  overrides: { email?: string; password?: string; status?: "ACTIVE" | "DISABLED" } = {},
) {
  return createAccount(
    {
      name: "Ops Person",
      email: overrides.email ?? nextEmail(),
      password: overrides.password ?? PASSWORD,
      createdAt: NOW,
      ...(overrides.status !== undefined ? { status: overrides.status } : {}),
    },
    { db },
  );
}

const sessionFor = (accountId: string, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS) =>
  createAccountSession({ accountId, createdAt: NOW, ttlSeconds }, { db });

describe.skipIf(!RUN)("account identity foundation (disposable MySQL)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — Account —

  it("creates an account with an opaque id and a hashed password", async () => {
    const email = nextEmail();
    const account = await seedAccount({ email });

    expect(ACCOUNT_ID_PATTERNS.account.test(account.accountId)).toBe(true);
    expect(account.status).toBe("ACTIVE");
    expect(account.normalizedEmail).toBe(email.toLowerCase());
    // The safe record has no field for a hash at all.
    expect(Object.keys(account)).not.toContain("passwordHash");

    const row = await db.account.findUnique({ where: { id: account.accountId } });
    expect(row!.passwordHash.startsWith(ARGON2ID_PREFIX)).toBe(true);
    // The plaintext never reaches storage, in any column.
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
  });

  it("refuses malformed account input and unknown fields", async () => {
    const bad: Array<Record<string, unknown>> = [
      { name: "A", email: nextEmail(), password: PASSWORD, createdAt: NOW, extra: true },
      { name: "", email: nextEmail(), password: PASSWORD, createdAt: NOW },
      { name: "A", email: "not-an-email", password: PASSWORD, createdAt: NOW },
      { name: "A", email: nextEmail(), password: "x".repeat(MIN_PASSWORD_LENGTH - 1), createdAt: NOW },
      { name: "A", email: nextEmail(), password: "x".repeat(MAX_PASSWORD_LENGTH + 1), createdAt: NOW },
      { name: "A", email: nextEmail(), password: PASSWORD, createdAt: "yesterday" },
      { name: "A", email: nextEmail(), password: PASSWORD },
    ];
    for (const input of bad) {
      await expect(createAccount(input, { db })).rejects.toThrow(InvalidAccountInputError);
    }
    expect(await db.account.count()).toBe(0);
  });

  it("normalizes email deterministically and enforces case-insensitive uniqueness", async () => {
    expect(normalizeEmail("  Ada.Lovelace@Example.COM ")).toBe("ada.lovelace@example.com");
    // Provider-specific canonicalisation is deliberately NOT applied: these are
    // different mailboxes at most providers and must stay different accounts.
    expect(normalizeEmail("a.b@example.com")).not.toBe(normalizeEmail("ab@example.com"));
    expect(normalizeEmail("user+tag@example.com")).not.toBe(normalizeEmail("user@example.com"));

    await seedAccount({ email: "Ada@example.com" });
    await expect(seedAccount({ email: "ADA@EXAMPLE.COM" })).rejects.toThrow(
      DuplicateAccountEmailError,
    );
    expect(await db.account.count()).toBe(1);
  });

  it("authenticates valid credentials and rejects everything else identically", async () => {
    const email = nextEmail();
    const account = await seedAccount({ email });

    const ok = await authenticateAccount({ email: email.toUpperCase(), password: PASSWORD }, { db });
    expect(ok.accountId).toBe(account.accountId);

    // Unknown address, wrong password, and malformed input must be one answer.
    const failures = await Promise.all(
      [
        { email: "nobody@example.com", password: PASSWORD },
        { email, password: OTHER_PASSWORD },
        { email, password: "" },
        { email: "", password: PASSWORD },
      ].map((input) => authenticateAccount(input, { db }).catch((e: unknown) => e)),
    );
    const messages = new Set<string>();
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(InvalidCredentialsError);
      const e = failure as InvalidCredentialsError;
      expect(e.code).toBe("INVALID_CREDENTIALS");
      // No field distinguishes the causes, and no input is echoed.
      expect(Object.keys(e)).not.toContain("fields");
      expect(`${e.message}${JSON.stringify(e)}`).not.toContain(email);
      messages.add(e.message);
    }
    expect(messages.size).toBe(1);
  });

  it("refuses a disabled account without revealing that it exists", async () => {
    const email = nextEmail();
    const account = await seedAccount({ email });
    await setAccountStatus(account.accountId, "DISABLED", { db });

    const disabled = await authenticateAccount({ email, password: PASSWORD }).catch(
      (e: unknown) => e,
    );
    const unknown = await authenticateAccount(
      { email: "ghost@example.com", password: PASSWORD },
      { db },
    ).catch((e: unknown) => e);

    expect(disabled).toBeInstanceOf(InvalidCredentialsError);
    expect((disabled as Error).message).toBe((unknown as Error).message);
  });

  // — Password primitives —

  it("produces argon2id hashes that verify only the right password", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith(ARGON2ID_PREFIX)).toBe(true);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(OTHER_PASSWORD, hash)).toBe(false);

    // A fresh random salt per hash: same password, different digest.
    expect(await hashPassword(PASSWORD)).not.toBe(hash);

    // Every failure mode returns false rather than throwing, so a corrupt stored
    // hash is indistinguishable from a wrong password.
    expect(await verifyPassword(PASSWORD, "not-a-phc-string")).toBe(false);
    expect(await verifyPassword(PASSWORD, "")).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);

    await expect(hashPassword("short")).rejects.toThrow(RangeError);
    await expect(hashPassword("x".repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow(RangeError);
  });

  // — Session —

  it("issues an opaque token and stores only its digest", async () => {
    const account = await seedAccount();
    const { session, token } = await sessionFor(account.accountId);

    expect(SESSION_TOKEN_RE.test(token)).toBe(true);
    expect(ACCOUNT_ID_PATTERNS.session.test(session.sessionId)).toBe(true);
    expect(session.expiresAt).toBe(shift(DEFAULT_SESSION_TTL_SECONDS));

    const row = await db.accountSession.findUnique({ where: { id: session.sessionId } });
    expect(SESSION_TOKEN_HASH_RE.test(row!.tokenHash)).toBe(true);
    expect(row!.tokenHash).toBe(hashSessionToken(token));
    // The raw token is unrecoverable from the database.
    const everyRow = JSON.stringify(await db.accountSession.findMany({}));
    expect(everyRow).not.toContain(token);
    // The safe record carries neither the token nor its digest.
    expect(Object.keys(session)).not.toContain("tokenHash");
    expect(JSON.stringify(session)).not.toContain(token);
  });

  it("generates unpredictable tokens", () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => cryptoSessionTokenProvider.nextSessionToken()),
    );
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(SESSION_TOKEN_RE.test(token)).toBe(true);
  });

  it("resolves a live session and refuses expired, revoked, and disabled ones", async () => {
    const account = await seedAccount();
    const { session, token } = await sessionFor(account.accountId, 3_600);

    const live = await resolveAccountSession(token, { now: shift(60), db });
    expect(live!.accountId).toBe(account.accountId);
    expect(live!.session.sessionId).toBe(session.sessionId);

    // Expiry is enforced against the supplied instant, not a real clock.
    expect(await resolveAccountSession(token, { now: shift(3_600), db })).toBeUndefined();
    expect(await resolveAccountSession(token, { now: shift(7_200), db })).toBeUndefined();
    // Unknown tokens, and empty input.
    expect(await resolveAccountSession("not-a-real-token", { now: NOW, db })).toBeUndefined();
    expect(await resolveAccountSession("", { now: NOW, db })).toBeUndefined();

    // Revocation fails closed immediately.
    await revokeAccountSession(token, { revokedAt: shift(120), db });
    expect(await resolveAccountSession(token, { now: shift(180), db })).toBeUndefined();

    // Disabling an account invalidates its live sessions on the next request.
    const other = await seedAccount();
    const second = await sessionFor(other.accountId, 3_600);
    expect(await resolveAccountSession(second.token, { now: shift(60), db })).toBeDefined();
    await setAccountStatus(other.accountId, "DISABLED", { db });
    expect(await resolveAccountSession(second.token, { now: shift(60), db })).toBeUndefined();
  });

  it("records activity only when explicitly asked", async () => {
    const account = await seedAccount();
    const { token } = await sessionFor(account.accountId, 3_600);

    const untouched = await resolveAccountSession(token, { now: shift(60), db });
    expect(untouched!.session.lastSeenAt).toBeNull();

    const touched = await resolveAccountSession(token, { now: shift(120), touch: true, db });
    expect(touched!.session.lastSeenAt).toBe(shift(120));
  });

  it("revokes sessions idempotently and can sign out everywhere", async () => {
    const account = await seedAccount();
    const { token } = await sessionFor(account.accountId, 3_600);

    expect(await revokeAccountSession(token, { revokedAt: shift(60), db })).toEqual({
      revoked: true,
    });
    // Signing out twice must not fail, and must not rewrite when it ended.
    expect(await revokeAccountSession(token, { revokedAt: shift(600), db })).toEqual({
      revoked: false,
    });
    const row = await db.accountSession.findUnique({ where: { tokenHash: hashSessionToken(token) } });
    expect(row!.revokedAt!.toISOString()).toBe(shift(60));
    // An unknown token is not an error either — it would reveal whether it was real.
    expect(await revokeAccountSession("bogus", { revokedAt: NOW, db })).toEqual({ revoked: false });

    await sessionFor(account.accountId, 3_600);
    await sessionFor(account.accountId, 3_600);
    expect(await revokeAllAccountSessions(account.accountId, { revokedAt: shift(700), db })).toEqual(
      { revokedCount: 2 },
    );
  });

  it("bounds session lifetime and refuses a session for a missing or disabled account", async () => {
    const account = await seedAccount();
    for (const ttlSeconds of [0, 59, 2_592_001, 1.5]) {
      await expect(
        createAccountSession({ accountId: account.accountId, createdAt: NOW, ttlSeconds }, { db }),
      ).rejects.toThrow(InvalidAccountInputError);
    }
    await expect(
      createAccountSession(
        { accountId: `mon:acct:${"0".repeat(26)}`, createdAt: NOW, ttlSeconds: 600 },
        { db },
      ),
    ).rejects.toThrow(AccountNotFoundError);

    await setAccountStatus(account.accountId, "DISABLED", { db });
    await expect(sessionFor(account.accountId)).rejects.toThrow(AccountNotFoundError);
  });

  // — Entitlement —

  it("grants nothing by default and grants exactly the named capability", async () => {
    const account = await seedAccount();
    expect(await accountHasCapability(account.accountId, CAPABILITY, { db })).toBe(false);
    expect(await listAccountCapabilities(account.accountId, { db })).toEqual([]);

    const grant = await grantAccountEntitlement(
      { accountId: account.accountId, capability: CAPABILITY, grantedAt: NOW },
      { db },
    );
    expect(grant.status).toBe("ACTIVE");
    expect(ACCOUNT_ID_PATTERNS.entitlement.test(grant.entitlementId)).toBe(true);
    expect(await accountHasCapability(account.accountId, CAPABILITY, { db })).toBe(true);
    expect(await listAccountCapabilities(account.accountId, { db })).toEqual([CAPABILITY]);
  });

  it("is idempotent on re-grant and fails closed on revoke", async () => {
    const account = await seedAccount();
    const first = await grantAccountEntitlement(
      { accountId: account.accountId, capability: CAPABILITY, grantedAt: NOW },
      { db },
    );
    const again = await grantAccountEntitlement(
      { accountId: account.accountId, capability: CAPABILITY, grantedAt: shift(600) },
      { db },
    );
    // The original grant instant is the fact worth keeping.
    expect(again).toEqual(first);
    expect(await db.accountEntitlement.count()).toBe(1);

    expect(
      await revokeAccountEntitlement(
        { accountId: account.accountId, capability: CAPABILITY, revokedAt: shift(700) },
        { db },
      ),
    ).toEqual({ revoked: true });
    expect(await accountHasCapability(account.accountId, CAPABILITY, { db })).toBe(false);
    expect(await listAccountCapabilities(account.accountId, { db })).toEqual([]);

    // Revoking twice is not an error.
    expect(
      await revokeAccountEntitlement(
        { accountId: account.accountId, capability: CAPABILITY, revokedAt: shift(800) },
        { db },
      ),
    ).toEqual({ revoked: false });

    // Re-granting reactivates the same row.
    const regranted = await grantAccountEntitlement(
      { accountId: account.accountId, capability: CAPABILITY, grantedAt: shift(900) },
      { db },
    );
    expect(regranted.status).toBe("ACTIVE");
    expect(regranted.revokedAt).toBeNull();
    expect(await db.accountEntitlement.count()).toBe(1);
  });

  it("refuses a capability outside the closed vocabulary", async () => {
    const account = await seedAccount();
    for (const capability of [
      "admin",
      "*",
      "publication-worker:status:write",
      "publication-worker:*",
      "",
    ]) {
      await expect(
        grantAccountEntitlement(
          { accountId: account.accountId, capability, grantedAt: NOW },
          { db },
        ),
      ).rejects.toThrow(UnsupportedCapabilityError);
      expect(await accountHasCapability(account.accountId, capability, { db })).toBe(false);
    }
    expect(await db.accountEntitlement.count()).toBe(0);
    expect([...ACCOUNT_CAPABILITIES]).toEqual([CAPABILITY]);
  });

  it("refuses to grant to a non-existent account", async () => {
    await expect(
      grantAccountEntitlement(
        { accountId: `mon:acct:${"0".repeat(26)}`, capability: CAPABILITY, grantedAt: NOW },
        { db },
      ),
    ).rejects.toThrow(AccountNotFoundError);
  });

  it("keys authorization on the account id, never on the email or its domain", async () => {
    // Two accounts at the SAME domain: one entitled, one not. If a domain could
    // authorize, both would pass.
    const entitled = await seedAccount({ email: "ops.a@monacado.com" });
    const ordinary = await seedAccount({ email: "ops.b@monacado.com" });
    await grantAccountEntitlement(
      { accountId: entitled.accountId, capability: CAPABILITY, grantedAt: NOW },
      { db },
    );
    expect(await accountHasCapability(entitled.accountId, CAPABILITY, { db })).toBe(true);
    expect(await accountHasCapability(ordinary.accountId, CAPABILITY, { db })).toBe(false);

    // An unknown account id grants nothing; absence is an answer, not an error.
    expect(await accountHasCapability(`mon:acct:${"0".repeat(26)}`, CAPABILITY, { db })).toBe(false);
    expect(await accountHasCapability("", CAPABILITY, { db })).toBe(false);
  });

  // — Principal projection —

  it("projects an ordinary account as ACCOUNT and an entitled one as INTERNAL_OPERATOR", async () => {
    const account = await seedAccount();
    const { token, session } = await sessionFor(account.accountId, 3_600);

    const ordinary = await resolveAuthenticatedPrincipal(token, { now: shift(60), db });
    expect(ordinary).toEqual({
      actorId: account.accountId,
      actorType: "ACCOUNT",
      accountId: account.accountId,
      sessionId: session.sessionId,
      capabilities: [],
    });

    await grantAccountEntitlement(
      { accountId: account.accountId, capability: CAPABILITY, grantedAt: NOW },
      { db },
    );
    const operator = await resolveAuthenticatedPrincipal(token, { now: shift(60), db });
    expect(operator!.actorType).toBe("INTERNAL_OPERATOR");
    expect(operator!.capabilities).toEqual([CAPABILITY]);
    expect(AuthenticatedPrincipal.safeParse(operator).success).toBe(true);

    // Revocation demotes on the very next resolution — no token to wait out.
    await revokeAccountEntitlement(
      { accountId: account.accountId, capability: CAPABILITY, revokedAt: shift(120) },
      { db },
    );
    const demoted = await resolveAuthenticatedPrincipal(token, { now: shift(180), db });
    expect(demoted!.actorType).toBe("ACCOUNT");
    expect(demoted!.capabilities).toEqual([]);
  });

  it("returns no principal for an unresolvable session", async () => {
    const account = await seedAccount();
    const { token } = await sessionFor(account.accountId, 3_600);
    expect(await resolveAuthenticatedPrincipal("bogus", { now: NOW, db })).toBeUndefined();
    expect(await resolveAuthenticatedPrincipal(token, { now: shift(7_200), db })).toBeUndefined();
    await setAccountStatus(account.accountId, "DISABLED", { db });
    expect(await resolveAuthenticatedPrincipal(token, { now: shift(60), db })).toBeUndefined();
  });

  it("omits every secret and profile detail from the principal", async () => {
    const email = nextEmail();
    const account = await seedAccount({ email });
    const { token } = await sessionFor(account.accountId, 3_600);
    await grantAccountEntitlement(
      { accountId: account.accountId, capability: CAPABILITY, grantedAt: NOW },
      { db },
    );
    const principal = await resolveAuthenticatedPrincipal(token, { now: shift(60), db });

    expect(Object.keys(principal!).sort()).toEqual([
      "accountId",
      "actorId",
      "actorType",
      "capabilities",
      "sessionId",
    ]);
    const text = JSON.stringify(principal);
    for (const forbidden of [
      email,
      email.toLowerCase(),
      PASSWORD,
      token,
      hashSessionToken(token),
      ARGON2ID_PREFIX,
      "Ops Person",
      "passwordHash",
      "cookie",
      "mysql://",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("reads an account back without exposing its hash", async () => {
    const account = await seedAccount();
    const fetched = await getAccountById(account.accountId, { db });
    expect(fetched!.accountId).toBe(account.accountId);
    expect(JSON.stringify(fetched)).not.toContain(ARGON2ID_PREFIX);
    expect(await getAccountById(`mon:acct:${"0".repeat(26)}`, { db })).toBeUndefined();
  });

  it("generates distinct opaque identities", () => {
    const ids = new Set([
      ...Array.from({ length: 20 }, () => cryptoAccountIdProvider.nextAccountId()),
      ...Array.from({ length: 20 }, () => cryptoAccountIdProvider.nextSessionId()),
      ...Array.from({ length: 20 }, () => cryptoAccountIdProvider.nextEntitlementId()),
    ]);
    expect(ids.size).toBe(60);
  });
});

// — Cookie primitives and structural guarantees (no database) —

describe("session cookie and isolation", () => {
  it("builds an HttpOnly, SameSite=Strict, host-only cookie carrying only the token", () => {
    const cookie = buildSessionCookie("opaque-token-value", {
      secure: true,
      maxAgeSeconds: DEFAULT_SESSION_TTL_SECONDS,
    });
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=opaque-token-value`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${DEFAULT_SESSION_TTL_SECONDS}`);
    expect(cookie).toContain("Secure");
    // Host-only: no Domain attribute is ever emitted.
    expect(cookie).not.toContain("Domain");
    // Nothing about the account is encoded into the cookie.
    for (const forbidden of ["mon:acct:", "@", "ACTIVE", "publication-worker"]) {
      expect(cookie).not.toContain(forbidden);
    }

    // `secure` is a required argument, never inferred from an environment read.
    expect(buildSessionCookie("t", { secure: false, maxAgeSeconds: 60 })).not.toContain("Secure");
  });

  it("clears the cookie with matching attributes", () => {
    const cleared = buildClearedSessionCookie({ secure: true });
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    // Attributes must match the cookie being replaced or the browser keeps it.
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Strict");
  });

  it("reads the token from a Cookie header and ignores everything else", () => {
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=abc123`)).toBe("abc123");
    expect(readSessionCookie(`other=1; ${SESSION_COOKIE_NAME}=abc123; another=2`)).toBe("abc123");
    expect(readSessionCookie(`  ${SESSION_COOKIE_NAME}=abc123  `)).toBe("abc123");
    for (const header of [undefined, null, "", "other=1", `${SESSION_COOKIE_NAME}=`, "novalue"]) {
      expect(readSessionCookie(header)).toBeUndefined();
    }
    // A lookalike name must not match.
    expect(readSessionCookie(`x_${SESSION_COOKIE_NAME}=abc`)).toBeUndefined();
  });

  it("adds no login UI, account route, or worker-status route", () => {
    const source = (path: string): string =>
      readFileSync(new URL(path, import.meta.url).pathname, "utf8");
    // No route handlers exist anywhere in the app or src trees.
    const files = [
      "../app/layout.tsx",
      "../app/page.tsx",
    ];
    for (const file of files) {
      const code = source(file);
      for (const forbidden of ["signin", "sign-in", "login", "logout", "useState", "fetch("]) {
        expect(code.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it("keeps the account services free of environment reads and network calls", () => {
    const modules = [
      "../src/server/account/account-service.ts",
      "../src/server/account/account-session-service.ts",
      "../src/server/account/account-entitlement-service.ts",
      "../src/server/account/account-principal.ts",
      "../src/server/account/session-cookie.ts",
      "../src/server/account/password.ts",
      "../src/server/account/session-token.ts",
    ];
    for (const module of modules) {
      const code = readFileSync(new URL(module, import.meta.url).pathname, "utf8");
      expect(code).not.toContain("process.env[");
      expect(code).not.toContain("process.env.");
      for (const forbidden of ["fetch(", "createServer", "NextResponse", "setTimeout(", "console."]) {
        expect(code).not.toContain(forbidden);
      }
      // Real imports only — the prose above these modules names the frameworks it
      // deliberately does not use, and a substring match would trip on that.
      expect(code).not.toMatch(/^\s*import\s.*from\s+["'](next\/|react)/m);
      expect(code).not.toMatch(/require\(["']next\//);
    }
  });

  it("grants nothing automatically: no bootstrap, allow-list, or hard-coded identity", () => {
    const modules = [
      "../src/server/account/account-entitlement-service.ts",
      "../src/server/account/account-principal.ts",
      "../src/server/account/account-service.ts",
    ];
    for (const module of modules) {
      const code = readFileSync(new URL(module, import.meta.url).pathname, "utf8");
      // No hard-coded account identity, address, or domain grants anything.
      expect(code).not.toMatch(/mon:acct:[0-9A-HJKMNP-TV-Z]{26}/);
      expect(code).not.toMatch(/@[a-z0-9-]+\.(com|io|dev|net|org)/i);
      expect(code).not.toContain("endsWith(");
      // No startup grant.
      expect(code).not.toMatch(/^\s*(await\s+)?grantAccountEntitlement\(/m);
    }
  });

  it("is not exported through the browser-facing contracts barrel", () => {
    const barrel = readFileSync(
      new URL("../src/contracts/index.ts", import.meta.url).pathname,
      "utf8",
    );
    for (const forbidden of ["account/account", "account-service", "session", "password"]) {
      expect(barrel).not.toContain(forbidden);
    }
  });
});
