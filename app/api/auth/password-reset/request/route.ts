/**
 * `POST /api/auth/password-reset/request` (Phase 1.28).
 *
 * A thin adapter over `handlePasswordResetRequest`. The one Next-specific thing
 * it contributes is `after`: the lookup and the mail run once the uniform answer
 * has been sent, so response time says nothing about whether the address has an
 * account.
 */

import { after } from "next/server";
import { handlePasswordResetRequest } from "../../../../../src/server/account/password-reset-route-handlers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handlePasswordResetRequest(
    {
      contentType: request.headers.get("content-type"),
      originHeader: request.headers.get("origin"),
      rawBody: await request.text(),
    },
    { defer: (task) => after(task) },
  );

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
