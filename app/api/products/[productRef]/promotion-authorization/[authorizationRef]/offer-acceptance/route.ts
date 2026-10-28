/**
 * POST /api/products/{productRef}/promotion-authorization/{authorizationRef}/offer-acceptance —
 * the cycle's own APPROVED Promoter accepts the exact Offer package it was
 * shown: the standing terms, or the standing terms with a scheduled or running
 * promotion (Phase 1.44).
 *
 * `POST` only; Next answers 405 for every method not exported. Everything else
 * is argued in `promotion-authorization-route-handler.ts`.
 */

import { handleAcceptOfferPackageRequest } from "../../../../../../../src/server/marketplace/promotion-authorization-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ productRef: string; authorizationRef: string }> },
): Promise<Response> {
  const { productRef, authorizationRef } = await context.params;
  const result = await handleAcceptOfferPackageRequest({
    productRef,
    authorizationRef,
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
