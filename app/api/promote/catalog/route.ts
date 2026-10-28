/**
 * GET /api/promote/catalog — the next page of the Promotable Catalog
 * (Phase 1.43). `GET` only; Next answers 405 for every method not exported.
 * Everything else is argued in `promotable-catalog-route-handler.ts`.
 */

import { handlePromotableCatalogRequest } from "../../../../src/server/marketplace/promotable-catalog-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  const result = await handlePromotableCatalogRequest({
    search: new URL(request.url).search,
    cookieHeader: request.headers.get("cookie"),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
