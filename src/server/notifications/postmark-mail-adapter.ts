/**
 * The Postmark transport (Phase 1.5) — SERVER ONLY.
 *
 * **The only file in this repository that knows what Postmark is.** It implements
 * `1.1`'s unchanged `MailPort`, so every caller above it — the dispatcher, the
 * notice service, the verification path — is written against Monacado's own
 * vocabulary and would not change if this became SES tomorrow.
 *
 * ## No SDK
 *
 * One `fetch` to one documented endpoint. A vendor SDK is a dependency to keep
 * patched, a second HTTP client in the bundle, and a surface through which the
 * vendor's own types spread into application code — which is the exact coupling
 * this file exists to prevent. The request is four fields and an auth header.
 *
 * ## The whole point is the normalisation
 *
 * Postmark answers with an `ErrorCode` and a message. Nothing above this file
 * sees either: they are translated **once**, here, into `ACCEPTED` /
 * `TRANSIENT` / `PERMANENT` and a bounded `DeliveryFailureCode`. The distinction
 * that carries the weight is transient versus permanent — retrying a rejected
 * address forever is how a sender's reputation dies, and giving up on a
 * five-minute outage is how a receipt is lost.
 *
 * ## What is never recorded
 *
 * The token, the endpoint, the response body, and the recipient address. The
 * adapter returns a bounded result and a provider message id, and the delivery
 * layer persists a digest. There is no path from a Postmark response into a
 * Monacado column.
 */

import "../server-only";
import {
  MailMessage,
  type DeliveryFailureCode,
  type MailPort,
  type MailResult,
} from "../../contracts/marketplace/notification-delivery";
import {
  readPostmarkRuntimeConfig,
  resolvePostmarkServerToken,
  type Env,
  type PostmarkRuntimeConfig,
} from "./mail-runtime-config";

/** How long to wait on the provider before calling it unavailable. */
export const POSTMARK_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Postmark's `ErrorCode` values Monacado classifies deliberately.
 *
 * Everything unlisted falls to `UNSPECIFIED_FAILURE`, which is transient — an
 * unrecognised provider answer is a reason to try again cautiously, not a reason
 * to throw a receipt away. The list is short on purpose: a large table of vendor
 * codes is a large table to keep correct.
 *
 * @see https://postmarkapp.com/developer/api/overview#error-codes
 */
const POSTMARK_ERROR_CODES: Record<number, DeliveryFailureCode> = {
  /* Bad or missing server token, and inactive/pending accounts. Retrying cannot
     fix a credential, so this is a configuration failure rather than an outage. */
  10: "CHANNEL_NOT_CONFIGURED",
  401: "CHANNEL_NOT_CONFIGURED",
  /* Sender signature not confirmed: the From address is not verified with
     Postmark, which is configuration and not a property of the message. */
  400: "CHANNEL_NOT_CONFIGURED",
  /* Invalid email request — a malformed message Monacado built. */
  300: "MESSAGE_REJECTED",
  /* Inactive recipient: Postmark's own suppression, from a prior hard bounce or
     complaint. Permanent, and the strongest possible signal to suppress. */
  406: "DESTINATION_REJECTED",
  /* Rate limited. Emphatically transient. */
  429: "PROVIDER_UNAVAILABLE",
};

/** What Postmark sends back for a single-message send. Read, never stored. */
interface PostmarkResponse {
  ErrorCode?: number;
  MessageID?: string;
}

/**
 * Translate one Postmark answer into Monacado's vocabulary.
 *
 * Exported so a test can assert the mapping without a network, which is the only
 * way to test a provider translation honestly.
 */
export function normalizePostmarkResponse(input: {
  httpStatus: number;
  body: PostmarkResponse | null;
}): MailResult {
  const errorCode = input.body?.ErrorCode;

  if (input.httpStatus === 200 && (errorCode === undefined || errorCode === 0)) {
    const ref = input.body?.MessageID;
    if (typeof ref === "string" && ref.length > 0) {
      return { outcome: "ACCEPTED", providerMessageRef: ref };
    }
    /* Accepted with no id to correlate by. Treated as unavailable rather than
       accepted: a delivery Monacado cannot tie a bounce back to is one it cannot
       act on later, and the send is cheap to repeat. */
    return { outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" };
  }

  /* 5xx and 408 are the provider's problem and will pass. */
  if (input.httpStatus >= 500 || input.httpStatus === 408 || input.httpStatus === 429) {
    return { outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" };
  }

  const mapped = errorCode === undefined ? undefined : POSTMARK_ERROR_CODES[errorCode];
  if (mapped !== undefined) return { outcome: "REFUSED", failureCode: mapped };

  /* An unrecognised 4xx with an unrecognised code. Unclassified rather than
     guessed, and transient, so one odd answer does not discard a receipt. */
  return { outcome: "REFUSED", failureCode: "UNSPECIFIED_FAILURE" };
}

export interface PostmarkAdapterDeps {
  config?: PostmarkRuntimeConfig;
  env?: Env;
  /** Injected so a test drives the adapter with no network at all. */
  fetchImpl?: typeof fetch;
}

/**
 * A `MailPort` backed by Postmark.
 *
 * Nothing is read at construction: the token is resolved per send, so rotating it
 * takes effect on the next message rather than on the next deploy.
 */
export function createPostmarkMailAdapter(deps: PostmarkAdapterDeps = {}): MailPort {
  const env = deps.env ?? process.env;
  const config = deps.config ?? readPostmarkRuntimeConfig(env);
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    async send(rawMessage): Promise<MailResult> {
      const message = MailMessage.parse(rawMessage);

      let token: string;
      try {
        token = resolvePostmarkServerToken(config, env);
      } catch {
        /* A missing credential is a configuration failure, not an exception the
           delivery layer should catch — `MailPort` says an ordinary refusal is a
           result. The thrown value is deliberately not inspected. */
        return { outcome: "REFUSED", failureCode: "CHANNEL_NOT_CONFIGURED" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POSTMARK_REQUEST_TIMEOUT_MS);
      try {
        const response = await doFetch(`${config.apiBaseUrl}/email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Postmark-Server-Token": token,
          },
          body: JSON.stringify({
            From: config.fromAddress,
            To: message.to,
            Subject: message.subject,
            TextBody: message.text,
            MessageStream: config.messageStream,
            /* Open and click tracking are OFF. A tracking pixel in a receipt
               reports when somebody read it and from where, which is surveillance
               Monacado has no need of — and a rewritten link in a verification
               message routes a bearer credential through a third party. */
            TrackOpens: false,
            TrackLinks: "None",
          }),
          signal: controller.signal,
        });

        let body: PostmarkResponse | null = null;
        try {
          body = (await response.json()) as PostmarkResponse;
        } catch {
          body = null;
        }
        return normalizePostmarkResponse({ httpStatus: response.status, body });
      } catch {
        /* A timeout, a DNS failure, a reset connection. The thrown value is NOT
           inspected: a fetch error can carry the full request, and the request
           carries the token and the message body. */
        return { outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
