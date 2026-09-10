/**
 * POST /api/auth/sign-out — end the current session (Phase 1.24).
 *
 * The exit Phase 1.22 did not build. Sign-in has issued `monacado_session` since
 * that phase and `revokeAccountSession` has been able to end one since 0E.7.4.2A,
 * but no endpoint connected them — so the only way out of a session was to wait
 * for its twelve hours to run out.
 *
 * **`POST` only**, and for the reason a logout endpoint in particular needs it: a
 * `GET` that ended a session could be fired by any `<img>` tag on any page in the
 * world, and every prefetcher and link-scanner that followed it would sign the
 * user out. Next answers 405 for a method a route does not export, so the absence
 * of the other handlers is the enforcement.
 *
 * **No body is read.** `request.text()` is not called, because there is no input:
 * which session ends is decided by the cookie the caller presented and by nothing
 * they could type. The route passes an origin and a cookie, and that is the whole
 * of the caller's influence over it.
 *
 * Revocation, the uniform success, and the clearing cookie are all argued in
 * `sign-out-route-handler.ts`.
 */

import { handleSignOutRequest } from "../../../../src/server/account/sign-out-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleSignOutRequest({
    originHeader: request.headers.get("origin"),
    cookieHeader: request.headers.get("cookie"),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
