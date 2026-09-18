/**
 * POST /api/storefronts/{publicHandle}/presentation — edit a Storefront's
 * presentation (Phase 1.31).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `storefront-presentation-route-handler.ts`.
 */

import { handleEditStorefrontPresentationRequest } from "../../../../../src/server/marketplace/storefront-presentation-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ publicHandle: string }> },
): Promise<Response> {
  const { publicHandle } = await context.params;
  const result = await handleEditStorefrontPresentationRequest({
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
