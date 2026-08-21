/**
 * GET /api/orders/status?orderId=… — what the buyer's return page reads
 * (Phase 1.0).
 *
 * Read-only in the strongest sense available: it performs no write, no
 * transition, and no provider contact, and there is no query parameter through
 * which a caller could assert a payment outcome. Arriving here cannot move an
 * Order one state.
 *
 * The projection is deliberately narrow and the authorization model is deliberate
 * too — both are argued in `order-status-route-handler.ts`.
 *
 * **`GET` only**, never cached, never prerendered. Nothing runs on import.
 */

import { handleOrderStatusRequest } from "../../../../src/server/payments/order-status-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  const result = await handleOrderStatusRequest(new URL(request.url).searchParams);

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
