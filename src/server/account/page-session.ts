/**
 * Page session resolution (Phase 1.25) — SERVER ONLY.
 *
 * **What a rendered page is allowed to know about the visitor**, and the only
 * thing it needs to know in this phase: whether a live session was presented,
 * and which account it belongs to.
 *
 * ## Why this exists rather than a call inside each page
 *
 * Two surfaces ask the same question in opposite directions — `/sign-in` sends a
 * signed-in visitor away, `/account` sends a signed-out one away — and a question
 * asked twice is a question that can be answered twice differently. The failure
 * that matters is not a redirect loop but a page that decides "signed in" on
 * looser terms than the one guarding the protected content.
 *
 * This is **not** middleware and not an auth context. It resolves nothing on its
 * own initiative, holds no state between calls, and is invoked explicitly by the
 * two pages that need it. `middleware.ts` still does not exist, deliberately: a
 * matcher is a second place to state which paths are protected, and the page that
 * renders the content is the only place that cannot be forgotten.
 *
 * ## It takes a cookie header, not a request and not a cookie store
 *
 * The same shape `handleSignOutRequest` takes, and for the same reason
 * `session-cookie.ts` gives: a plain header string has no framework in it, so the
 * rule is exercised directly by a test rather than through a mocked request
 * context. The page reads the header from `next/headers` and passes it in; every
 * decision below is a pure function of that string and the database.
 *
 * ## It reuses the resolution the routes use
 *
 * `resolveAccountSession` returns `undefined` for a token that never existed, an
 * expired session, a revoked one, and an account no longer `ACTIVE` — one answer
 * for every way of not being signed in. Re-deriving any part of that here would
 * be a second authority on what a live session is, and the looser of the two
 * would become the one guarding the page.
 *
 * `resolveAuthenticatedPrincipal` is deliberately **not** used. It exists to
 * answer "and may they act", which costs a second query for capabilities that
 * nothing on these pages consults. This phase renders no capability-dependent
 * content and grants no authority, so reading entitlements to display the word
 * "Signed in" would be work done to be discarded.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { resolveAccountSession } from "./account-session-service";
import { readSessionCookie } from "./session-cookie";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

/**
 * The whole of what a page learns about the visitor.
 *
 * One field. Not the email, not the name, not the session id, not the status,
 * not the capabilities — a page that displayed any of them would be asserting
 * something about the account, and this phase asserts only that a session is
 * live. Widening this type is how "signed in" turns into an account profile.
 */
export interface PageSession {
  accountId: string;
}

export interface PageSessionDeps {
  db?: Db | Prisma.TransactionClient;
  /** Injected so a test can pin the instant; production reads the clock. */
  now?: () => string;
}

/**
 * Resolve the session a page was shown, or `undefined` for every way of not
 * having one.
 *
 * **No cookie is written and no session is touched.** `touch` is left at its
 * default, so rendering a page does not extend a session's life or record a
 * visit — a page load is not an act, and a `lastSeenAt` write on every render
 * would make session state depend on how often a browser happened to prefetch.
 *
 * The failure modes are collapsed exactly as the routes collapse them: a missing
 * cookie, an unparseable one, a token that was never real, an expired session, a
 * revoked one, and a disabled account are all simply "not signed in". A page has
 * no use for the distinction and no safe way to display it.
 */
export async function resolvePageSession(
  cookieHeader: string | null,
  deps: PageSessionDeps = {},
): Promise<PageSession | undefined> {
  const token = readSessionCookie(cookieHeader);
  if (token === undefined) return undefined;

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const db = deps.db as Db | undefined;

  const resolved = await resolveAccountSession(token, {
    now,
    ...(db !== undefined ? { db } : {}),
  });
  if (resolved === undefined) return undefined;

  return { accountId: resolved.accountId };
}
