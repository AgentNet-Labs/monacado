/**
 * Account sessions (Phase 0E.7.4.2A) — SERVER ONLY.
 *
 * Opaque, server-validated, revocable sessions. Deliberately **not** JWTs: this
 * foundation has to fail closed the instant an account is disabled or a session
 * is revoked, and a self-contained token cannot do that without a server-side
 * check on every request — at which point the token's only remaining advantage is
 * gone and its disadvantages (no revocation, key rotation, replay until expiry)
 * remain.
 *
 * The raw token exists in exactly two places: the response to
 * `createAccountSession`, and the caller's cookie. Only its SHA-256 digest is
 * persisted, so reading the database yields nothing that can be presented as a
 * credential.
 *
 * Resolution is **read-only by default**. `touch` is opt-in so a caller that is
 * performing a read (the deferred status route) does not silently turn it into a
 * write on every request.
 */

import "../server-only";
import {
  AccountSessionRecord,
  CreateAccountSessionInput,
  type AccountSessionRecord as SafeSession,
} from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { cryptoAccountIdProvider, type AccountIdProvider } from "./account-ids";
import {
  cryptoSessionTokenProvider,
  hashSessionToken,
  type SessionTokenProvider,
} from "./session-token";
import {
  AccountNotFoundError,
  AccountPersistenceFailureError,
  InvalidAccountInputError,
} from "./account-errors";

type Db = ReturnType<typeof getPrisma>;

export interface SessionServiceDeps {
  db?: Db;
  ids?: AccountIdProvider;
  tokens?: SessionTokenProvider;
}

/**
 * A newly created session.
 *
 * `token` is the ONLY time the raw value is ever available. It is not stored, not
 * recoverable, and not returned by any other operation — losing it means creating
 * a new session, which is the correct trade.
 */
export interface CreatedAccountSession {
  session: SafeSession;
  token: string;
}

function sessionRowToRecord(row: {
  id: string;
  accountId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
}): SafeSession {
  return AccountSessionRecord.parse({
    sessionId: row.id,
    accountId: row.accountId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.toISOString(),
  });
}

/**
 * Issue a session for an account.
 *
 * The account must exist and be ACTIVE — issuing a session to a disabled account
 * would create a credential that can never resolve, which is worse than refusing.
 */
export async function createAccountSession(
  input: unknown,
  deps: SessionServiceDeps = {},
): Promise<CreatedAccountSession> {
  const parsed = CreateAccountSessionInput.safeParse(input);
  if (!parsed.success) {
    throw new InvalidAccountInputError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const req = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoAccountIdProvider;
  const tokens = deps.tokens ?? cryptoSessionTokenProvider;

  const account = await db.account.findUnique({ where: { id: req.accountId } });
  if (account === null) throw new AccountNotFoundError();
  if (account.status !== "ACTIVE") throw new AccountNotFoundError();

  const token = tokens.nextSessionToken();
  const createdAt = new Date(req.createdAt);
  const expiresAt = new Date(createdAt.getTime() + req.ttlSeconds * 1_000);

  try {
    const row = await db.accountSession.create({
      data: {
        id: ids.nextSessionId(),
        accountId: req.accountId,
        // Only the digest. The raw token is never written.
        tokenHash: hashSessionToken(token),
        createdAt,
        expiresAt,
      },
    });
    return { session: sessionRowToRecord(row), token };
  } catch (error) {
    throw new AccountPersistenceFailureError("create-session", error);
  }
}

export interface ResolvedSession {
  session: SafeSession;
  accountId: string;
  accountStatus: string;
}

/**
 * Resolve a raw session token.
 *
 * Returns `undefined` — never throws — for every "not signed in" condition:
 * unknown token, expired, revoked, or an account that has since been disabled.
 * Those are ordinary answers a caller handles, and distinguishing them would tell
 * a holder of a stale token *why* it is stale, which is information they have no
 * need for.
 *
 * The lookup is an indexed equality match on the digest, so there is no
 * application-level string comparison to leak timing.
 */
export async function resolveAccountSession(
  token: string,
  options: { now: string; touch?: boolean; db?: Db },
): Promise<ResolvedSession | undefined> {
  if (typeof token !== "string" || token === "") return undefined;
  const db = options.db ?? getPrisma();
  const now = new Date(options.now);

  const row = await db.accountSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { account: true },
  });
  if (row === null) return undefined;
  if (row.revokedAt !== null) return undefined;
  if (row.expiresAt.getTime() <= now.getTime()) return undefined;
  // Disabling an account invalidates its live sessions on the next request.
  if (row.account.status !== "ACTIVE") return undefined;

  let lastSeenAt = row.lastSeenAt;
  if (options.touch === true) {
    try {
      const touched = await db.accountSession.update({
        where: { id: row.id },
        data: { lastSeenAt: now },
      });
      lastSeenAt = touched.lastSeenAt;
    } catch {
      // Recording activity is bookkeeping; failing to record it must not
      // invalidate an otherwise valid session.
      lastSeenAt = row.lastSeenAt;
    }
  }

  return {
    session: sessionRowToRecord({ ...row, lastSeenAt }),
    accountId: row.accountId,
    accountStatus: row.account.status,
  };
}

/**
 * Revoke a session by its raw token.
 *
 * **Idempotent.** Revoking an already-revoked or unknown session succeeds
 * quietly: sign-out must never fail, and reporting "no such session" would tell
 * the caller whether the token they hold was ever real.
 *
 * The first revocation instant is kept — a second call does not rewrite when the
 * session actually ended.
 */
export async function revokeAccountSession(
  token: string,
  options: { revokedAt: string; db?: Db },
): Promise<{ revoked: boolean }> {
  if (typeof token !== "string" || token === "") return { revoked: false };
  const db = options.db ?? getPrisma();
  try {
    const result = await db.accountSession.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: new Date(options.revokedAt) },
    });
    return { revoked: result.count === 1 };
  } catch (error) {
    throw new AccountPersistenceFailureError("revoke-session", error);
  }
}

/** Revoke every live session for an account — "sign out everywhere". */
export async function revokeAllAccountSessions(
  accountId: string,
  options: { revokedAt: string; db?: Db },
): Promise<{ revokedCount: number }> {
  const db = options.db ?? getPrisma();
  try {
    const result = await db.accountSession.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date(options.revokedAt) },
    });
    return { revokedCount: result.count };
  } catch (error) {
    throw new AccountPersistenceFailureError("revoke-all-sessions", error);
  }
}
