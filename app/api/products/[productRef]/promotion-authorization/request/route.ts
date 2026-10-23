/**
 * POST /api/products/{productRef}/promotion-authorization/request — a Promoter
 * requests Promotion Authorization for one Product (Phase 1.41).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `promotion-authorization-route-handler.ts`.
 */

import { handleRequestPromotionAuthorizationRequest } from "../../../../../../src/server/marketplace/promotion-authorization-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ productRef: string }> },
): Promise<Response> {
  const { productRef } = await context.params;
  const result = await handleRequestPromotionAuthorizationRequest({
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
