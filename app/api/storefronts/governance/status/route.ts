/**
 * POST /api/storefronts/governance/status — suspend, revoke, or restore a
 * Storefront governance assignment (Phase 1.21).
 *
 * A separate endpoint from appointment, and separate on purpose. The two are
 * different authorities pointing in opposite directions: appointing grants, this
 * withdraws, and the governed service permits an actor whose own authoring
 * standing is withheld to withdraw authority while refusing them the power to
 * grant it. One endpoint choosing between them on a caller-supplied field would
 * put a permitted act and a forbidden one behind the same gate.
 *
 * **`POST` only**, for the reason its sibling gives.
 *
 * The direction rule itself is not restated here. It lives in
 * `storefront-service`, decided against the database inside the transaction that
 * writes, which is the only place it can be decided honestly.
 */

import { handleSetGovernanceStatusRequest } from "../../../../../src/server/marketplace/storefront-governance-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const result = await handleSetGovernanceStatusRequest({
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
