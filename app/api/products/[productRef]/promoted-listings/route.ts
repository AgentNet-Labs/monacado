/**
 * POST /api/products/{productRef}/promoted-listings — an APPROVED Promoter
 * places the Product in a Storefront it controls, as a DRAFT, with or without
 * a price (Phase 1.45).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `promoted-listing-route-handler.ts`.
 */

import { handleCreatePromotedListingRequest } from "../../../../../src/server/marketplace/promoted-listing-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ productRef: string }> },
): Promise<Response> {
  const { productRef } = await context.params;
  const result = await handleCreatePromotedListingRequest({
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
