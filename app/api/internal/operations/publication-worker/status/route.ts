/**
 * GET /api/internal/operations/publication-worker/status — Phase 0E.7.4.2B.
 *
 * The repository's first HTTP route, and deliberately its thinnest possible one.
 * Everything that decides anything — authentication, authorization, query bounds,
 * response shape — lives in `handleWorkerStatusRequest`, which takes a cookie
 * header and a query string and returns a status, a body, and headers. This file
 * only translates Next.js `Request`/`Response` at the edges, so no rule can hide
 * inside a framework object where a test cannot reach it.
 *
 * **`GET` only.** No `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `HEAD` is
 * exported. Next returns 405 for a method a route does not export, so the absence
 * of those handlers *is* the enforcement — and this route is read-only, so there is
 * nothing for them to do. `OPTIONS` is likewise absent: emitting one would begin a
 * CORS story this route deliberately does not have.
 *
 * **Not cached, not prerendered.** `force-dynamic` and `revalidate = 0` keep it out
 * of static generation, and the handler sets `Cache-Control: no-store` on every
 * response. It is not linked from any page, appears in no sitemap, and no client
 * component imports it.
 *
 * Nothing runs on import: the module defines a function and two constants, and the
 * database client is constructed lazily on first use.
 */

import { handleWorkerStatusRequest } from "../../../../../../src/server/operations/worker-status-route-handler";

/** Never prerendered; evaluated per request. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  const result = await handleWorkerStatusRequest({
    // The raw cookie header is handed straight to the handler, which extracts the
    // opaque token and discards it. No identity is ever read from a header.
    cookieHeader: request.headers.get("cookie"),
    searchParams: new URL(request.url).searchParams,
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...result.headers },
  });
}
