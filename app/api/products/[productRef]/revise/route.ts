/**
 * POST /api/products/{productRef}/revise — revise one of your own Products
 * (Phase 1.38).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `product-revision-route-handler.ts`.
 */

import { handleReviseProductRequest } from "../../../../../src/server/product/product-revision-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ productRef: string }> },
): Promise<Response> {
  const { productRef } = await context.params;
  const result = await handleReviseProductRequest({
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
