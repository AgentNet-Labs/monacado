/**
 * POST /api/participant/onboarding — begin Seller/Promoter setup (Phase 1.29).
 *
 * `POST` only; Next answers 405 for every method not exported. A `GET` that
 * created a participant would be a write an image tag could start. Everything
 * else is argued in `participant-onboarding-route-handler.ts`.
 */

import { handleBeginOnboardingRequest } from "../../../../src/server/marketplace/participant-onboarding-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleBeginOnboardingRequest({
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
