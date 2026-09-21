/**
 * POST /api/listings — place a Product in a Storefront as a private draft
 * Listing (Phase 1.34).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `listing-placement-route-handler.ts`.
 */

import { handleCreateListingPlacementRequest } from "../../../src/server/marketplace/listing-placement-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleCreateListingPlacementRequest({
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
