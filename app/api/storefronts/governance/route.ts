/**
 * POST /api/storefronts/governance — appoint a Storefront governance role
 * (Phase 1.21).
 *
 * The first participant-facing marketplace mutation with an HTTP surface. The
 * caller states which Storefront, which participant, and which role; who they
 * are comes from the session cookie and from nowhere else. There is no request
 * field through which authority can be asserted, and the instant recorded on the
 * assignment is the server's.
 *
 * **`POST` only.** No `GET`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `HEAD` is
 * exported, and Next answers 405 for a method a route does not export — so the
 * absence of those handlers *is* the enforcement. A `GET` that appointed a
 * governor would be a governance change an image tag could start, and unlike the
 * scheduler routes there is no mandatory `Authorization` header here to stop it:
 * a browser attaches a cookie cross-origin without being asked.
 *
 * Everything else — origin, session, parsing, authority, and the bounded error
 * mapping — is argued in `storefront-governance-route-handler.ts`.
 */

import { handleAppointGovernanceRequest } from "../../../../src/server/marketplace/storefront-governance-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleAppointGovernanceRequest({
    contentType: request.headers.get("content-type"),
    originHeader: request.headers.get("origin"),
    cookieHeader: request.headers.get("cookie"),
    rawBody: await request.text(),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
