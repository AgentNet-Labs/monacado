/**
 * Account creation and authentication (Phase 0E.7.4.2A) — SERVER ONLY.
 *
 * Two operations, and the interesting one is `authenticateAccount`, which is
 * built so that **every failure looks the same**:
 *
 *   - an unknown address, a wrong password, and a disabled account all raise the
 *     same `InvalidCredentialsError` with no fields;
 *   - an unknown address still performs one real Argon2id verification against a
 *     decoy hash, so the *timing* of "no such account" resembles "wrong
 *     password". A generic message with a fast-path miss is not actually generic —
 *     the clock answers the question the message refused to.
 *
 * **No transaction spans password hashing.** Argon2id is deliberately slow and
 * memory-hard; holding a database transaction open across it would pin a
 * connection for the whole cost and let a burst of logins exhaust the pool. The
 * hash is computed outside, and only the write is transactional.
 *
 * Nothing here reads a clock, generates randomness directly, or touches
 * `process.env`; instants, identities, and the database are injected.
 */

import "../server-only";
import type { Account as AccountRow } from "@prisma/client";
import {
  AccountRecord,
  AuthenticateAccountInput,
  CreateAccountInput,
  normalizeEmail,
  type AccountRecord as SafeAccount,
} from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { cryptoAccountIdProvider, type AccountIdProvider } from "./account-ids";
import { hashPassword, timingDecoyHash, verifyPassword } from "./password";
import {
  AccountPersistenceFailureError,
  DuplicateAccountEmailError,
  InvalidAccountInputError,
  InvalidCredentialsError,
} from "./account-errors";

type Db = ReturnType<typeof getPrisma>;

export interface AccountServiceDeps {
  db?: Db;
  ids?: AccountIdProvider;
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "P2002";

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidAccountInputError {
  return new InvalidAccountInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

/**
 * Project a row onto the safe record.
 *
 * `passwordHash` has no field to land in — the contract does not define one — so
 * a hash cannot escape this function even by mistake.
 */
export function accountRowToRecord(row: AccountRow): SafeAccount {
  return AccountRecord.parse({
    accountId: row.id,
    name: row.name,
    email: row.email,
    normalizedEmail: row.normalizedEmail,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    emailVerifiedAt: row.emailVerifiedAt === null ? null : row.emailVerifiedAt.toISOString(),
    emailVerifiedVia: row.emailVerifiedVia,
  });
}

/**
 * Create an account.
 *
 * Uniqueness is enforced by the database's unique index on `normalizedEmail`,
 * not by a read-then-write check, so two concurrent creations cannot both
 * succeed.
 *
 * ## Verification disposition is explicit, and defaults closed (Phase 1.27)
 *
 * `emailVerification` decides whether the new account may authenticate straight
 * away. It defaults to `UNVERIFIED` — the direction where forgetting to think
 * about it produces a locked door rather than an open one. Public sign-up passes
 * it explicitly anyway, and a test asserts the account it creates is unverified,
 * so the default is a safety net rather than the mechanism.
 *
 * `ADMINISTRATIVE` is for an operator, a fixture, or `scripts/db-check.ts`
 * creating an account it intends to use immediately. It records that somebody
 * vouched for the address, **not** that the address was ever proved — which is
 * why the provenance is stored rather than collapsed into a boolean.
 */
export async function createAccount(
  input: unknown,
  deps: AccountServiceDeps = {},
): Promise<SafeAccount> {
  const parsed = CreateAccountInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const req = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoAccountIdProvider;

  // Hashing happens BEFORE any database work, so no transaction spans it.
  const passwordHash = await hashPassword(req.password);

  /* Unproved by default. An account created without an opinion about its
     address is not treated as having proved it — the conservative direction,
     which now costs public reachability rather than the login itself. */
  const verified = (req.emailVerification ?? "UNVERIFIED") === "ADMINISTRATIVE";

  try {
    const row = await db.account.create({
      data: {
        id: ids.nextAccountId(),
        name: req.name,
        email: req.email.trim(),
        normalizedEmail: normalizeEmail(req.email),
        passwordHash,
        status: req.status ?? "ACTIVE",
        createdAt: new Date(req.createdAt),
        emailVerifiedAt: verified ? new Date(req.createdAt) : null,
        emailVerifiedVia: verified ? "ADMINISTRATIVE" : null,
      },
    });
    return accountRowToRecord(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateAccountEmailError(error);
    throw new AccountPersistenceFailureError("create-account", error);
  }
}

/**
 * Authenticate an email and password.
 *
 * Returns the safe account record on success and raises the single generic
 * `InvalidCredentialsError` on every failure.
 *
 * Note the order: the account is looked up, then a verification always runs —
 * against the real hash when a row was found, against the decoy when it was not.
 * The status check comes *after* verification for the same reason, so a disabled
 * account costs the same time as an active one with a wrong password.
 */
export async function authenticateAccount(
  input: unknown,
  deps: AccountServiceDeps = {},
): Promise<SafeAccount> {
  const parsed = AuthenticateAccountInput.safeParse(input);
  // Even a malformed submission is a credential failure, not a validation report:
  // telling a caller which field was wrong tells them the other one was right.
  if (!parsed.success) throw new InvalidCredentialsError();
  const req = parsed.data;

  const db = deps.db ?? getPrisma();

  let row: AccountRow | null;
  try {
    row = await db.account.findUnique({
      where: { normalizedEmail: normalizeEmail(req.email) },
    });
  } catch (error) {
    throw new AccountPersistenceFailureError("authenticate-account", error);
  }

  const storedHash = row?.passwordHash ?? (await timingDecoyHash());
  const passwordMatches = await verifyPassword(req.password, storedHash);

  /* Three ways of failing, one answer.

     **Email verification is deliberately NOT among them.** Phase 1.27 originally
     added a fourth clause here — `emailVerifiedAt === null` — and the correction
     removes it. The reasoning it was added under was sound about *disclosure* and
     wrong about *where the requirement belongs*: proving an address is a
     prerequisite for being PUBLICLY TRADEABLE, not for holding a session. A
     Seller or Promoter who has just registered needs to sign in to do the
     onboarding work — profile, business structure, payout configuration — none of
     which exposes anything to a buyer, and all of which was unreachable while an
     unconsumed link stood between them and their own account.

     The requirement now sits at the boundary it actually protects:
     `assertStorefrontMayBecomeOperational` refuses to take a shop live, or widen
     its exposure, while the owning account's address is unproved. Buyer
     payment/delivery carries its own separate rule at its own boundary.

     What is unchanged: an account must still EXIST, match its password, and be
     `ACTIVE`. The uniform answer across all three, and the timing decoy above,
     stay exactly as they were — those defend against enumeration, which is a
     different concern from verification and was never the thing being relaxed. */
  if (row === null || !passwordMatches || row.status !== "ACTIVE") {
    throw new InvalidCredentialsError();
  }
  return accountRowToRecord(row);
}

/** Read one account by id. Administrative use; never part of authentication. */
export async function getAccountById(
  accountId: string,
  deps: AccountServiceDeps = {},
): Promise<SafeAccount | undefined> {
  const db = deps.db ?? getPrisma();
  const row = await db.account.findUnique({ where: { id: accountId } });
  return row === null ? undefined : accountRowToRecord(row);
}

/**
 * Enable or disable an account.
 *
 * Disabling takes effect on the very next request: `resolveAccountSession` reads
 * the account's status, so existing sessions stop resolving immediately rather
 * than surviving until they expire.
 */
export async function setAccountStatus(
  accountId: string,
  status: "ACTIVE" | "DISABLED",
  deps: AccountServiceDeps = {},
): Promise<SafeAccount> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.account.update({ where: { id: accountId }, data: { status } });
    return accountRowToRecord(row);
  } catch (error) {
    throw new AccountPersistenceFailureError("set-account-status", error);
  }
}
