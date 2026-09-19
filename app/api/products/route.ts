/**
 * POST /api/products — open a private draft Product (Phase 1.32).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `product-draft-route-handler.ts`.
 */

import { handleCreateDraftProductRequest } from "../../../src/server/product/product-draft-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleCreateDraftProductRequest({
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
