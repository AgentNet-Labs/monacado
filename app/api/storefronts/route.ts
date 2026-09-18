/**
 * POST /api/storefronts — open a private draft Storefront (Phase 1.30).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `storefront-draft-route-handler.ts`.
 */

import { handleOpenDraftStorefrontRequest } from "../../../src/server/marketplace/storefront-draft-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleOpenDraftStorefrontRequest({
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
