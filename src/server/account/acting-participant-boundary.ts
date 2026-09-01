/**
 * The acting-account boundary — SERVER ONLY (Phase 1.18).
 *
 * **The one place a marketplace actor identity is minted, and it is minted from
 * a session cookie.** Every Offer, Listing, and Storefront mutation resolves its
 * authority from the acting account: the participant that account owns, the
 * Product authority that participant holds, the Storefront governance it has
 * been appointed to. All of that is read from the database — which makes the
 * account id the last remaining claim, and therefore the one worth protecting.
 *
 * The hazard is specific and it is not hypothetical. Every domain service takes
 * its input as `unknown` and `safeParse`s it, and `actingAccountId` is a member
 * of those schemas. A route that forwarded a request body would let a caller
 * name any account and inherit whatever that account owns. The services are
 * right to take an account id — they sit behind this boundary — but nothing
 * expressed that they do.
 *
 * `ActingAccount` expresses it. It is a type without a constructor a caller can
 * reach:
 *
 *   - **Not parseable from JSON.** No zod schema produces a class instance, and
 *     `JSON.parse` never will. A request body cannot become one.
 *   - **Nominal at compile time.** The `#resolved` private field makes
 *     TypeScript treat the class nominally, so an object literal carrying the
 *     right fields is not assignable to it.
 *   - **Nominal at runtime.** `#resolved` is a true private field; a spoofed
 *     object fails a `#resolved in x` check rather than merely looking wrong.
 *   - **Unconstructible outside this module.** The class *value* is not
 *     exported; only the type is. There is no `new ActingAccount` to write.
 *
 * One honest limit on that last point: `deps.resolvePrincipal` below is an
 * injectable seam, so in-process code that passes its own resolver receives a
 * genuine token for whatever account that resolver names. The guarantee this
 * type carries is that **no request body can become one** — not that every
 * in-process caller is trustworthy. The seam exists for pure tests; production
 * callers pass no deps and get `resolveAuthenticatedPrincipal`.
 *
 * Deliberately **not** a capability bag and **not** an authorization decision.
 * It carries who is acting and nothing else — no role, no participant id, no
 * governance role, no capability list, and no risk field. Authorization stays
 * where Phase 1.18 put it: inside the domain services, against the database, in
 * the same transaction as the write. A decision computed out here and carried
 * in would be a forgeable conclusion again, one layer up, and would open a
 * window between the decision and the write in which a restriction, suspension,
 * or revoked governance assignment could land unseen.
 *
 * There is deliberately **no cryptography and no token signing**. The value is
 * never serialized, never leaves the process, and never crosses a trust
 * boundary — it exists to make an in-process contract unforgeable, which a type
 * does better than a signature.
 *
 * **This does not pretend authentication is finished.** No route sets a session
 * cookie yet; sign-in remains deferred. What exists is the resolution half, and
 * it is real: `resolveAuthenticatedPrincipal` reads a persisted session and
 * re-reads entitlements on every call, so a revoked session or a disabled
 * account fails closed immediately.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "../db/client";
import { resolveAuthenticatedPrincipal } from "./account-principal";
import { readSessionCookie } from "./session-cookie";

type Db = ReturnType<typeof getPrisma>;

/**
 * An account that HAS BEEN resolved from a persisted session.
 *
 * The class value is not exported, so this is the only code that can produce
 * one. Construction is not `private`, because a module-level factory could not
 * then reach it — the guarantee is the withheld export, plus `#resolved` for
 * nominality, not an access modifier.
 */
class ResolvedActingAccount {
  /** Unforgeable twice over: nominal in TypeScript, absent at runtime on any literal. */
  readonly #resolved = true;

  constructor(
    /** The account id, and the actor id — `resolveAuthenticatedPrincipal` makes them one. */
    readonly accountId: string,
    /** The session this identity came from, for bounded operator diagnostics. */
    readonly sessionId: string,
  ) {}

  /** Present so `#resolved` is read; a field TypeScript believes is unused is a field it may drop. */
  get resolved(): boolean {
    return this.#resolved;
  }
}

/**
 * The type is exported; the class is not. Nothing outside this module can build
 * one, and no `.parse()` anywhere can produce one.
 */
export type ActingAccount = ResolvedActingAccount;

/**
 * The outcome of trying to resolve an acting account.
 *
 * `UNAUTHENTICATED` is one answer for every not-signed-in condition — no
 * cookie, unknown token, expired, revoked, or an account since disabled —
 * matching `resolveAccountSession`. Distinguishing them would tell the holder
 * of a stale token why it is stale.
 */
export type ActingAccountResolution =
  | { outcome: "AUTHENTICATED"; actor: ActingAccount }
  | { outcome: "UNAUTHENTICATED" };

export interface ActingAccountDeps {
  db?: Db | Prisma.TransactionClient;
  /** Seam for pure tests; the production path is the default. */
  resolvePrincipal?: typeof resolveAuthenticatedPrincipal;
}

/**
 * Resolve the acting account from a request's cookie header.
 *
 * **There is no parameter here through which an account id can arrive.** That
 * is the entire point of the signature: the only input is the header a browser
 * sent, and the identity is whatever the persisted session says it is. A caller
 * cannot ask to be someone.
 */
export async function resolveActingAccount(
  request: { cookieHeader: string | null | undefined; now: string },
  deps: ActingAccountDeps = {},
): Promise<ActingAccountResolution> {
  const token = readSessionCookie(request.cookieHeader);
  if (token === undefined) return { outcome: "UNAUTHENTICATED" };

  const resolve = deps.resolvePrincipal ?? resolveAuthenticatedPrincipal;
  const principal = await resolve(token, {
    now: request.now,
    ...(deps.db !== undefined ? { db: deps.db as Db } : {}),
  });
  if (principal === undefined) return { outcome: "UNAUTHENTICATED" };

  /* `actorType` is deliberately not read. An INTERNAL_OPERATOR acting here is
     acting as themselves, not as staff: an internal entitlement grants no
     marketplace role, no participant ownership, and no Storefront governance,
     and carrying the classification into a marketplace act is how a Monacado
     employee ends up holding seller authority. Staff capabilities are checked
     by the internal surfaces that require them, against
     `resolveInternalAuthorizationSubject`, never here. */
  return {
    outcome: "AUTHENTICATED",
    actor: new ResolvedActingAccount(principal.accountId, principal.sessionId),
  };
}
