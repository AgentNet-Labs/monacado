/**
 * POST /api/products/{productRef}/resale-availability — set the Seller-controlled
 * resale availability of one of your own Products (Phase 1.40).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `product-resale-availability-route-handler.ts`.
 */

import { handleSetProductResaleAvailabilityRequest } from "../../../../../src/server/product/product-resale-availability-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ productRef: string }> },
): Promise<Response> {
  const { productRef } = await context.params;
  const result = await handleSetProductResaleAvailabilityRequest({
    productRef,
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
