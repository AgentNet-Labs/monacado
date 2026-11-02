/**
 * POST /api/storefronts/{publicHandle}/go-live — take a Storefront live, ACTIVE
 * and PUBLIC (Phase 1.46).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `storefront-go-live-route-handler.ts`.
 */

import { handleGoLiveStorefrontRequest } from "../../../../../src/server/marketplace/storefront-go-live-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ publicHandle: string }> },
): Promise<Response> {
  const { publicHandle } = await context.params;
  const result = await handleGoLiveStorefrontRequest({
    publicHandle,
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
