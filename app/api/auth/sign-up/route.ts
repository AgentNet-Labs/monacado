/**
 * POST /api/auth/sign-up — create an Account (Phase 1.27).
 *
 * The counterpart to `/api/auth/sign-in`, and the first endpoint in the
 * repository that brings an Account into existence over HTTP. Until now
 * `createAccount` was reachable only from tests and `scripts/db-check.ts`.
 *
 * **`POST` only**, for the reason sign-in gives and one of its own. A `GET` that
 * accepted a password would put it in the query string, the access log, the
 * referrer header, and browser history. A `GET` that *created* something would
 * additionally be fired by every prefetcher and link-scanner that saw it. Next
 * answers 405 for a method a route does not export, so the absence of the other
 * handlers is the enforcement.
 *
 * Uniform answers, the deliberate absence of a session cookie, and the reason
 * there is no attempt budget here are all argued in `sign-up-route-handler.ts`.
 */

import { handleSignUpRequest } from "../../../../src/server/account/sign-up-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleSignUpRequest({
    contentType: request.headers.get("content-type"),
    originHeader: request.headers.get("origin"),
    rawBody: await request.text(),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
