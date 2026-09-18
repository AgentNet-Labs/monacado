/**
 * `POST /api/auth/password-reset/complete` (Phase 1.28).
 *
 * A thin adapter over `handlePasswordResetComplete`. It sets no cookie: a reset
 * does not sign anybody in.
 */

import { handlePasswordResetComplete } from "../../../../../src/server/account/password-reset-route-handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handlePasswordResetComplete({
    contentType: request.headers.get("content-type"),
    originHeader: request.headers.get("origin"),
    rawBody: await request.text(),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
