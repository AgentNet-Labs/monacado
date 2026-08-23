/**
 * The provider event webhook (Phase 1.5) — SERVER ONLY.
 *
 * Framework-free, like every other route in this repository: headers and a raw
 * body in, a status and a body out.
 *
 * ## The order is the security property
 *
 * ```
 *   1. authenticate            ← before the body is even parsed
 *   2. parse and normalise     ← Postmark's vocabulary stops here
 *   3. ingest idempotently     ← the provider event id is the guard
 * ```
 *
 * Authenticating first means an unauthenticated caller cannot make Monacado
 * parse, allocate for, or reason about a payload it invented.
 *
 * ## Almost everything is 200
 *
 * An unrecognised record type, a replayed event, and a successfully ingested
 * bounce all answer `200`. A provider that receives an error for an event retries
 * it — forever, for some — so answering `4xx` to "I do not act on opens" is how a
 * webhook endpoint acquires a permanent backlog it did not need.
 *
 * `401` is the exception, and `503` for a persistence failure: that one *should*
 * be retried, because the event has not been recorded and a bounce Monacado never
 * ingested is an address it keeps writing to.
 *
 * ## The response says nothing
 *
 * No address, no event id, no participant, no contact. The caller is a provider
 * and needs to know only that Monacado took it.
 */

import "../server-only";
import { readPostmarkRuntimeConfig, resolvePostmarkWebhookSecret } from "./mail-runtime-config";
import {
  isAuthenticPostmarkRequest,
  normalizePostmarkEvent,
  WEBHOOK_SECRET_HEADER,
} from "./postmark-webhook";
import {
  ingestProviderEmailEvent,
  type EventIngestionDeps,
} from "./email-event-ingestion-service";

export type Env = Record<string, string | undefined>;

export interface WebhookRouteResult {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookRequest {
  authorizationHeader: string | null;
  secretHeader: string | null;
  rawBody: string;
  receivedAt: string;
}

export { WEBHOOK_SECRET_HEADER };

export async function handleProviderEmailWebhookRequest(
  request: WebhookRequest,
  deps: EventIngestionDeps & { env?: Env } = {},
): Promise<WebhookRouteResult> {
  const env = deps.env ?? process.env;

  let expectedSecret: string;
  try {
    expectedSecret = resolvePostmarkWebhookSecret(readPostmarkRuntimeConfig(env), env);
  } catch {
    /* Unconfigured is indistinguishable from unauthorised, on purpose: telling a
       caller "no secret is set here" is telling them to keep trying. */
    return { status: 401, body: { error: "UNAUTHORIZED" } };
  }

  const authentic = isAuthenticPostmarkRequest(
    { authorization: request.authorizationHeader, webhookSecret: request.secretHeader },
    expectedSecret,
  );
  if (!authentic) return { status: 401, body: { error: "UNAUTHORIZED" } };

  let payload: unknown;
  try {
    payload = JSON.parse(request.rawBody);
  } catch {
    /* Malformed JSON from an authenticated caller. Accepted and dropped rather
       than retried forever. */
    return { status: 200, body: { received: true, handled: false } };
  }

  const event = normalizePostmarkEvent(payload, request.receivedAt);
  if (event === null) {
    /* An open, a click, a subscription change — a record type Monacado does not
       act on. Taken and ignored. */
    return { status: 200, body: { received: true, handled: false } };
  }

  try {
    const result = await ingestProviderEmailEvent(event, request.receivedAt, deps);
    return {
      status: 200,
      body: {
        received: true,
        handled: true,
        /* Bounded facts only. Never the address, the event id, or the contact. */
        eventType: result.eventType,
        duplicate: !result.ingested,
        suppressed: result.suppressed,
      },
    };
  } catch {
    /* Not recorded, so it must be retried: a bounce Monacado never ingested is an
       address it keeps writing to. */
    return { status: 503, body: { error: "INGESTION_UNAVAILABLE" } };
  }
}
