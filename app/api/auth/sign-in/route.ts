/**
 * POST /api/auth/sign-in — exchange credentials for a session cookie
 * (Phase 1.22).
 *
 * The entry point for every authenticated route in the application. Phase 1.21
 * wired the first participant-facing mutation to `resolveActingAccount`, which
 * reads a session cookie — but no endpoint issued one, so that route could only
 * be reached by a test that minted a session directly. This closes the loop: a
 * real Account signs in here, receives `monacado_session`, and calls the
 * governance routes with it.
 *
 * **`POST` only**, and for a sharper reason than its siblings. A `GET` that
 * accepted credentials would put an email and password into the query string,
 * and from there into the access log, the referrer header, and browser history.
 * Next answers 405 for a method a route does not export, so the absence of the
 * other handlers is the enforcement.
 *
 * Credentials, session lifetime, cookie attributes, and the deliberately uniform
 * refusal are all argued in `sign-in-route-handler.ts`.
 */

import { handleSignInRequest } from "../../../../src/server/account/sign-in-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleSignInRequest({
    contentType: request.headers.get("content-type"),
    originHeader: request.headers.get("origin"),
    rawBody: await request.text(),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
