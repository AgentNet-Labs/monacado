/**
 * POST /api/products/[productRef]/offers — the Product's Seller creates a DRAFT Offer (Phase 1.42).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `offer-route-handler.ts`.
 */

import { handleCreateOfferRequest } from "../../../../../src/server/marketplace/offer-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ productRef: string }> },
): Promise<Response> {
  const { productRef } = await context.params;
  const result = await handleCreateOfferRequest({
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
