/**
 * HTTP Registrar REGISTER transport (Phase 0E.6.1).
 *
 * The single place in the codebase that opens an outbound connection. It sends
 * ONE already-built request and reports what happened. It does not:
 *
 *   - read the database;
 *   - read environment variables or files (credentials are injected);
 *   - retry, ever — one call is one attempt, and deciding to try again is a
 *     policy question for a layer that can see attempt history;
 *   - follow redirects, which would let a response steer our egress;
 *   - log request or response bodies.
 *
 * The classification it returns is the whole point: a caller must be able to
 * tell "the Registrar said no" from "we never reached the Registrar" from "we
 * genuinely do not know". Those demand different responses, and conflating them
 * is how duplicate registrations happen.
 */

import {
  DEFAULT_MAX_RESPONSE_BYTES,
  RegisterResponseEnvelope,
  RegistrarCredentials,
  RegistrarEndpoint,
  TransportResult,
  classifyHttpStatus,
  isPermittedCredentialHeader,
  type RegisterRequestEnvelope,
  type RegistrarCredentialProvider,
  type RegistrarEndpoint as Endpoint,
  type RegistrarRegisterTransport,
  type TransportResult as Result,
} from "../../contracts/product/registrar-transport";
import { findEndpointIssues } from "../../contracts/product/registrar-endpoint-safety";
import { serializeRegisterRequest } from "../../contracts/product/registrar-request-builder";
import {
  ForbiddenTransportHeaderError,
  InvalidRegistrarEndpointError,
  MissingRegistrarCredentialsError,
  RegisterRequestContractFailureError,
} from "./transport-errors";

/**
 * Node error codes that prove the request never left — the connection was never
 * established, so nothing can have been delivered. Anything NOT on this list is
 * treated as possibly-delivered, because guessing "not delivered" and being
 * wrong causes a duplicate registration.
 */
const PRE_CONNECT_ERROR_CODES: readonly string[] = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ERR_INVALID_URL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
];

/** TLS/DNS faults that will not fix themselves on a retry. */
const TERMINAL_ERROR_CODES: readonly string[] = [
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_INVALID_URL",
];

/** Walk an error chain for a Node error code without echoing any message text. */
function errorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const zodIssues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/**
 * Module-private signal that the bounded reader hit its limit. Never escapes
 * this file: the caller converts it into a structured TERMINAL result.
 */
class BodyTooLargeSignal extends Error {
  constructor() {
    super("response body exceeded the permitted size");
    this.name = "BodyTooLargeSignal";
  }
}

export interface HttpRegistrarRegisterTransportOptions {
  credentialProvider: RegistrarCredentialProvider;
  /**
   * Injected for tests. Defaults to the global `fetch`; the adapter never
   * reaches for anything else.
   */
  fetchImpl?: typeof fetch;
}

export class HttpRegistrarRegisterTransport implements RegistrarRegisterTransport {
  private readonly credentialProvider: RegistrarCredentialProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpRegistrarRegisterTransportOptions) {
    this.credentialProvider = options.credentialProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendRegisterRequest(
    request: RegisterRequestEnvelope,
    endpoint: Endpoint,
  ): Promise<Result> {
    const parsedEndpoint = RegistrarEndpoint.safeParse(endpoint);
    if (!parsedEndpoint.success) {
      throw new InvalidRegistrarEndpointError(zodIssues(parsedEndpoint.error));
    }
    const { url, timeoutMs } = parsedEndpoint.data;
    const maxResponseBytes = parsedEndpoint.data.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    // — Endpoint safety, before anything is prepared —
    const endpointIssues = findEndpointIssues(url);
    if (endpointIssues.length > 0) {
      throw new InvalidRegistrarEndpointError(endpointIssues.map((i) => `${i.rule}: ${i.reason}`));
    }

    // — Serialise exactly once —
    let body: string;
    try {
      body = serializeRegisterRequest(request);
    } catch (e) {
      throw new RegisterRequestContractFailureError([
        "request: the envelope could not be serialised canonically",
      ]);
    }

    const headers = await this.buildHeaders();

    // — One attempt, with an explicit deadline —
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        // A redirect could point us at an arbitrary host; never follow one.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return this.classifyRequestError(e, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
    }

    // A response arrived, so the request definitely reached the far side.
    const httpStatus = response.status;

    // `redirect: "manual"` surfaces a 3xx rather than following it.
    if (httpStatus >= 300 && httpStatus < 400) {
      return this.result({
        outcome: "TERMINAL_TRANSPORT_FAILURE",
        transmitted: true,
        httpStatus,
        failure: {
          code: "REGISTRAR_REDIRECTED",
          summary: "The Registrar responded with a redirect, which is never followed.",
        },
      });
    }

    if (httpStatus < 200 || httpStatus >= 300) {
      return this.result({
        outcome: classifyHttpStatus(httpStatus),
        transmitted: true,
        httpStatus,
        failure: {
          code: "REGISTRAR_HTTP_ERROR",
          summary: "The Registrar returned a non-success HTTP status.",
        },
      });
    }

    // — 2xx: read a bounded body and parse it strictly —
    let text: string;
    try {
      text = await this.readBounded(response, maxResponseBytes);
    } catch (e) {
      if (e instanceof BodyTooLargeSignal) {
        return this.result({
          outcome: "TERMINAL_TRANSPORT_FAILURE",
          transmitted: true,
          httpStatus,
          failure: {
            code: "RESPONSE_TOO_LARGE",
            summary: "The Registrar response exceeded the permitted size and was discarded.",
          },
        });
      }
      // The body could not be read to completion — it may still have been acted
      // on at the far side.
      return this.result({
        outcome: "AMBIGUOUS_DELIVERY",
        transmitted: true,
        httpStatus,
        failure: {
          code: "RESPONSE_READ_FAILED",
          summary: "The Registrar response could not be read to completion.",
        },
      });
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      return this.result({
        outcome: "TERMINAL_TRANSPORT_FAILURE",
        transmitted: true,
        httpStatus,
        failure: {
          code: "RESPONSE_NOT_JSON",
          summary: "The Registrar response was not valid JSON.",
        },
      });
    }

    const parsed = RegisterResponseEnvelope.safeParse(parsedBody);
    if (!parsed.success) {
      // An unrecognised or malformed envelope means we do not understand this
      // Registrar. Retrying will not change that.
      return this.result({
        outcome: "TERMINAL_TRANSPORT_FAILURE",
        transmitted: true,
        httpStatus,
        failure: {
          code: "INVALID_REGISTRAR_RESPONSE",
          summary: "The Registrar response did not satisfy the REGISTER response contract.",
        },
      });
    }

    // The exchange succeeded. Whether the answer was yes or no is a REGISTRAR
    // decision, not a transport failure — and reconciling it against the attempt
    // is a later step's job, not this one's.
    return this.result({
      outcome: parsed.data.status === "ACCEPTED" ? "SUCCESS" : "REMOTE_REJECTION",
      transmitted: true,
      httpStatus,
      response: parsed.data,
    });
  }

  // — Internals —

  /**
   * Assemble headers. `Content-Type` is set by us and cannot be overridden; the
   * credential provider may contribute `Authorization` plus allow-listed extras.
   */
  private async buildHeaders(): Promise<Record<string, string>> {
    const raw = await this.credentialProvider.getRegistrarCredentials();
    const parsed = RegistrarCredentials.safeParse(raw);
    if (!parsed.success) {
      throw new MissingRegistrarCredentialsError(zodIssues(parsed.error));
    }
    const credentials = parsed.data;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      authorization: credentials.authorization,
    };

    // Two barriers, deliberately. The allow-list is the rule; the explicit
    // denylist is a backstop that keeps framing, forwarding, and ambient-auth
    // headers out even if the allow-list is ever widened carelessly.
    const extras = credentials.additionalHeaders ?? {};
    const refused = Object.keys(extras).filter((name) => !isPermittedCredentialHeader(name));
    if (refused.length > 0) throw new ForbiddenTransportHeaderError(refused);

    for (const [name, value] of Object.entries(extras)) {
      headers[name.toLowerCase()] = value;
    }
    return headers;
  }

  /**
   * Read at most `maxResponseBytes`. A Registrar that streams more than that is
   * either broken or hostile; either way we stop rather than buffer it.
   */
  private async readBounded(response: Response, maxResponseBytes: number): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > maxResponseBytes) {
      throw new BodyTooLargeSignal();
    }

    const body = response.body;
    if (body === null) return "";

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxResponseBytes) {
            throw new BodyTooLargeSignal();
          }
          chunks.push(value);
        }
      }
    } finally {
      // Release the connection whether or not we finished.
      void reader.cancel().catch(() => undefined);
    }

    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  }

  /**
   * Classify a thrown request error.
   *
   * The conservative default matters: unless we can PROVE the request never
   * left, we report ambiguity. Reporting "not delivered" when it was delivered
   * invites a duplicate registration; reporting ambiguity when it was not
   * delivered merely costs a manual look.
   */
  private classifyRequestError(error: unknown, aborted: boolean): Result {
    const code = errorCodeOf(error);

    if (aborted) {
      // The deadline passed after the request was already on its way.
      return this.result({
        outcome: "AMBIGUOUS_DELIVERY",
        transmitted: true,
        failure: {
          code: "TRANSPORT_TIMEOUT",
          summary: "The Registrar request timed out; delivery could not be confirmed or ruled out.",
        },
      });
    }

    if (code !== undefined && TERMINAL_ERROR_CODES.includes(code)) {
      return this.result({
        outcome: "TERMINAL_TRANSPORT_FAILURE",
        transmitted: false,
        failure: {
          code: "TRANSPORT_CONFIGURATION_FAILURE",
          summary: "The Registrar endpoint could not be used; the request was not sent.",
        },
      });
    }

    if (code !== undefined && PRE_CONNECT_ERROR_CODES.includes(code)) {
      return this.result({
        outcome: "RETRYABLE_TRANSPORT_FAILURE",
        transmitted: false,
        failure: {
          code: "TRANSPORT_CONNECT_FAILED",
          summary: "The Registrar could not be reached; the request was not sent.",
        },
      });
    }

    return this.result({
      outcome: "AMBIGUOUS_DELIVERY",
      transmitted: true,
      failure: {
        code: "TRANSPORT_INTERRUPTED",
        summary: "The Registrar exchange was interrupted; delivery could not be determined.",
      },
    });
  }

  private result(value: unknown): Result {
    return TransportResult.parse(value);
  }
}
