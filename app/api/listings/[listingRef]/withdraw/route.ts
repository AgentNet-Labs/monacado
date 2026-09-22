/**
 * POST /api/listings/{listingRef}/withdraw — withdraw a private draft placement
 * (Phase 1.35).
 *
 * `POST` only; Next answers 405 for every method not exported. The request body
 * is deliberately not read: the reference in the path is the whole request.
 * Everything else is argued in `listing-withdrawal-route-handler.ts`.
 */

import { handleWithdrawListingRequest } from "../../../../../src/server/marketplace/listing-withdrawal-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ listingRef: string }> },
): Promise<Response> {
  const { listingRef } = await context.params;
  const result = await handleWithdrawListingRequest({
    listingRef,
    originHeader: request.headers.get("origin"),
    cookieHeader: request.headers.get("cookie"),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
