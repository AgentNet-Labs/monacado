/**
 * POST /api/internal/products/{productRef}/tax-classification — a Monacado
 * operator assigns or changes one Product's tax classification (Phase 1.39).
 *
 * Staff only: session plus an explicit `product:tax-classify` grant. `POST`
 * only; Next answers 405 for every method not exported. Everything else is
 * argued in `product-tax-classification-route-handler.ts`.
 */

import { handleClassifyProductTaxRequest } from "../../../../../../src/server/product/product-tax-classification-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ productRef: string }> },
): Promise<Response> {
  const { productRef } = await context.params;
  const result = await handleClassifyProductTaxRequest({
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
