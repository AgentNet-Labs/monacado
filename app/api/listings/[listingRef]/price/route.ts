/**
 * POST /api/listings/{listingRef}/price — set or change the retail price of a
 * private draft placement (Phase 1.36).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `listing-price-route-handler.ts`.
 */

import { handleSetListingPriceRequest } from "../../../../../src/server/marketplace/listing-price-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ listingRef: string }> },
): Promise<Response> {
  const { listingRef } = await context.params;
  const result = await handleSetListingPriceRequest({
    listingRef,
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
