/**
 * Durable outbound email contract tests (Phase 1.5).
 *
 * Offline: no database, and **no network**. The Postmark adapter is exercised
 * with an injected `fetch`, so no request leaves this process and no production
 * send can occur — the only honest way to test a provider translation.
 *
 * The recurring assertions are **classification** (transient versus permanent,
 * which is what makes retrying bounded) and **absence** (no credential, no
 * address, no body anywhere they could leak).
 */

import { describe, expect, it, vi } from "vitest";
import {
  classifyFailure,
  EMAIL_RETRY_POLICY,
  isTerminalDeliveryStatus,
  nextAttemptAt,
  nextAttemptDelaySeconds,
  OBLIGATION_FREE_PURPOSES,
  outboundEmailDeliveryKey,
  OutboundEmailError,
  suppressionReasonFor,
} from "../src/contracts/marketplace/outbound-email";
import {
  createPostmarkMailAdapter,
  normalizePostmarkResponse,
} from "../src/server/notifications/postmark-mail-adapter";
import {
  isAuthenticPostmarkRequest,
  normalizePostmarkEvent,
} from "../src/server/notifications/postmark-webhook";
import {
  readPostmarkRuntimeConfig,
  resolvePostmarkServerToken,
} from "../src/server/notifications/mail-runtime-config";
import { MailConfigurationError } from "../src/server/notifications/outbound-email-errors";
import { resolveMailPort, resolvedMailProvider } from "../src/server/notifications/mail-port";
import { isAuthorizedDispatchRequest } from "../src/server/notifications/email-dispatcher-route-handler";
import { formatDispatchReport } from "../scripts/run-email-dispatcher";
import { STRIPE_MODES } from "../src/server/payments/stripe-runtime-config";

const TOKEN = "postmark-server-token-not-real";
const FROM = "notifications@monacado.test";

const POSTMARK_ENV = {
  MONACADO_MAIL_ENABLED: "true",
  MONACADO_MAIL_TRANSPORT: "POSTMARK",
  MONACADO_MAIL_FROM_ADDRESS: FROM,
  MONACADO_POSTMARK_SERVER_TOKEN: TOKEN,
  MONACADO_POSTMARK_WEBHOOK_SECRET: "webhook-shared-secret",
};

describe("the retry policy", () => {
  it("is stated once, as constants rather than scattered numbers", () => {
    expect(EMAIL_RETRY_POLICY.maxAttempts).toBe(5);
    expect(EMAIL_RETRY_POLICY.backoffSeconds).toHaveLength(5);
    expect(EMAIL_RETRY_POLICY.claimLeaseSeconds).toBeGreaterThan(0);
  });

  it("backs off increasingly, then stops at the bound", () => {
    const delays = [1, 2, 3, 4].map((n) => nextAttemptDelaySeconds(n));
    expect(delays).toEqual([60, 300, 900, 3_600]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
    /* The fifth attempt is the last: there is no sixth. */
    expect(nextAttemptDelaySeconds(EMAIL_RETRY_POLICY.maxAttempts)).toBeNull();
  });

  it("schedules the next attempt from the instant the last one failed", () => {
    expect(nextAttemptAt({ attemptCount: 1, failedAt: "2028-06-01T09:00:00.000Z" })).toBe(
      "2028-06-01T09:01:00.000Z",
    );
    expect(nextAttemptAt({ attemptCount: 5, failedAt: "2028-06-01T09:00:00.000Z" })).toBeNull();
  });

  it("names exactly two terminal states", () => {
    expect(isTerminalDeliveryStatus("DELIVERED")).toBe(true);
    expect(isTerminalDeliveryStatus("PERMANENTLY_FAILED")).toBe(true);
    for (const status of ["PENDING", "IN_PROGRESS", "RETRY_PENDING"] as const) {
      expect(isTerminalDeliveryStatus(status)).toBe(false);
    }
  });
});

describe("failure classification", () => {
  it("retries an outage and never retries a rejection", () => {
    /* The distinction the whole policy turns on: retrying a rejected address is
       how a sender's reputation dies, and giving up on a five-minute outage is
       how a receipt is lost. */
    expect(classifyFailure("PROVIDER_UNAVAILABLE")).toBe("TRANSIENT");
    expect(classifyFailure("UNSPECIFIED_FAILURE")).toBe("TRANSIENT");
    expect(classifyFailure("DESTINATION_REJECTED")).toBe("PERMANENT");
    expect(classifyFailure("MESSAGE_REJECTED")).toBe("PERMANENT");
    expect(classifyFailure("DESTINATION_SUPPRESSED")).toBe("PERMANENT");
    expect(classifyFailure("RECIPIENT_UNRESOLVABLE")).toBe("PERMANENT");
  });

  it("treats an unconfigured channel as a condition an operator fixes", () => {
    /* Transient, so the commitment survives until the operator configures mail —
       and still exhausts the bounded policy, so an unconfigured deployment
       reports exactly how many notices it did not send. */
    expect(classifyFailure("CHANNEL_NOT_CONFIGURED")).toBe("TRANSIENT");
  });
});

describe("the logical message key", () => {
  const base = {
    purpose: "ORDER_CONFIRMATION" as const,
    recipientParticipantId: null,
    subjectKind: "ORDER" as const,
    subjectRef: "mon:order:ABC",
    discriminator: null,
  };

  it("is the same for one message however many callers commit to it", () => {
    expect(outboundEmailDeliveryKey(base)).toBe(outboundEmailDeliveryKey({ ...base }));
  });

  it("separates a buyer receipt from a seller notice about the same Order", () => {
    expect(outboundEmailDeliveryKey(base)).not.toBe(
      outboundEmailDeliveryKey({
        ...base,
        purpose: "SALE_RECORDED",
        recipientParticipantId: "mon:mpart:X",
      }),
    );
  });

  it("makes a repeatable message distinct through its discriminator", () => {
    /* Asking to verify again IS a new message; asking for a receipt twice is not. */
    expect(outboundEmailDeliveryKey({ ...base, discriminator: "one" })).not.toBe(
      outboundEmailDeliveryKey({ ...base, discriminator: "two" }),
    );
  });

  it("refuses a component that would forge a key", () => {
    expect(() => outboundEmailDeliveryKey({ ...base, subjectRef: "a|b" })).toThrow(
      OutboundEmailError,
    );
  });

  it("names verification as owed to nobody", () => {
    expect(OBLIGATION_FREE_PURPOSES).toContain("EMAIL_VERIFICATION");
  });
});

describe("the Postmark send translation", () => {
  it("accepts a success with a message id", () => {
    expect(
      normalizePostmarkResponse({ httpStatus: 200, body: { ErrorCode: 0, MessageID: "pm-1" } }),
    ).toEqual({ outcome: "ACCEPTED", providerMessageRef: "pm-1" });
  });

  it("classifies an inactive recipient as permanent", () => {
    /* Postmark's own suppression, from a prior bounce or complaint. The strongest
       possible signal not to try again. */
    expect(normalizePostmarkResponse({ httpStatus: 422, body: { ErrorCode: 406 } })).toEqual({
      outcome: "REFUSED",
      failureCode: "DESTINATION_REJECTED",
    });
  });

  it("classifies a bad token as configuration, not as an outage", () => {
    expect(normalizePostmarkResponse({ httpStatus: 401, body: { ErrorCode: 10 } })).toEqual({
      outcome: "REFUSED",
      failureCode: "CHANNEL_NOT_CONFIGURED",
    });
  });

  it("classifies rate limits and 5xx as transient", () => {
    for (const status of [429, 500, 502, 503, 408]) {
      expect(normalizePostmarkResponse({ httpStatus: status, body: null })).toEqual({
        outcome: "REFUSED",
        failureCode: "PROVIDER_UNAVAILABLE",
      });
    }
  });

  it("does not accept a send it cannot correlate a bounce back to", () => {
    expect(normalizePostmarkResponse({ httpStatus: 200, body: { ErrorCode: 0 } })).toEqual({
      outcome: "REFUSED",
      failureCode: "PROVIDER_UNAVAILABLE",
    });
  });

  it("sends the token as a header and never in the body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ErrorCode: 0, MessageID: "pm-2" }), { status: 200 });
    }) as unknown as typeof fetch;

    const port = createPostmarkMailAdapter({ env: POSTMARK_ENV, fetchImpl });
    const result = await port.send({
      to: "buyer@example.invalid",
      subject: "Subject",
      text: "Body",
    });

    expect(result).toEqual({ outcome: "ACCEPTED", providerMessageRef: "pm-2" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Postmark-Server-Token"]).toBe(TOKEN);
    expect(String(calls[0]!.init.body)).not.toContain(TOKEN);

    /* No tracking. A pixel in a receipt reports when somebody read it; a
       rewritten link in a verification message routes a credential through a
       third party. */
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.TrackOpens).toBe(false);
    expect(body.TrackLinks).toBe("None");
    expect(body.From).toBe(FROM);
  });

  it("reports a network failure as transient without inspecting the error", async () => {
    const fetchImpl = (async () => {
      throw new Error(`boom carrying ${TOKEN} and buyer@example.invalid`);
    }) as unknown as typeof fetch;
    const port = createPostmarkMailAdapter({ env: POSTMARK_ENV, fetchImpl });
    expect(await port.send({ to: "b@example.invalid", subject: "s", text: "t" })).toEqual({
      outcome: "REFUSED",
      failureCode: "PROVIDER_UNAVAILABLE",
    });
  });

  it("refuses rather than sending when the token is absent", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const port = createPostmarkMailAdapter({
      env: { ...POSTMARK_ENV, MONACADO_POSTMARK_SERVER_TOKEN: "" },
      fetchImpl,
    });
    expect(await port.send({ to: "b@example.invalid", subject: "s", text: "t" })).toEqual({
      outcome: "REFUSED",
      failureCode: "CHANNEL_NOT_CONFIGURED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("mail configuration", () => {
  it("holds the variable NAME and never the token", () => {
    const config = readPostmarkRuntimeConfig(POSTMARK_ENV);
    expect(config.serverTokenEnvVar).toBe("MONACADO_POSTMARK_SERVER_TOKEN");
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(JSON.stringify(config)).not.toContain("webhook-shared-secret");
    expect(resolvePostmarkServerToken(config, POSTMARK_ENV)).toBe(TOKEN);
  });

  it("fails closed on a missing or unusable From address", () => {
    for (const from of [undefined, "", "not-an-address"]) {
      expect(() =>
        readPostmarkRuntimeConfig({ ...POSTMARK_ENV, MONACADO_MAIL_FROM_ADDRESS: from }),
      ).toThrow(MailConfigurationError);
    }
  });

  it("names the field at fault and never its value", () => {
    try {
      resolvePostmarkServerToken(readPostmarkRuntimeConfig(POSTMARK_ENV), {});
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(MailConfigurationError);
      expect((error as MailConfigurationError).message).toContain(
        "MONACADO_POSTMARK_SERVER_TOKEN",
      );
      expect((error as MailConfigurationError).message).not.toContain(TOKEN);
    }
  });

  it("selects Postmark only when it is both enabled and named", () => {
    expect(resolvedMailProvider(POSTMARK_ENV)).toBe("POSTMARK");
    /* Disabled wins over any transport: a deployment that has not turned mail on
       does not send, whatever it names. */
    expect(resolvedMailProvider({ ...POSTMARK_ENV, MONACADO_MAIL_ENABLED: "false" })).toBe(
      "DISABLED",
    );
    expect(resolvedMailProvider({})).toBe("DISABLED");
    /* An unrecognised transport refuses rather than falling back to something
       that silently accepts. */
    expect(resolvedMailProvider({ MONACADO_MAIL_ENABLED: "true", MONACADO_MAIL_TRANSPORT: "SES" }))
      .toBe("DISABLED");
  });

  it("an unconfigured deployment refuses every message", async () => {
    const result = await resolveMailPort({}).send({
      to: "b@example.invalid",
      subject: "s",
      text: "t",
    });
    expect(result).toEqual({ outcome: "REFUSED", failureCode: "CHANNEL_NOT_CONFIGURED" });
  });
});

describe("webhook authentication", () => {
  const SECRET = "webhook-shared-secret";

  it("accepts the custom header", () => {
    expect(
      isAuthenticPostmarkRequest({ authorization: null, webhookSecret: SECRET }, SECRET),
    ).toBe(true);
  });

  it("accepts Basic credentials, taking the password half", () => {
    const basic = `Basic ${Buffer.from(`postmark:${SECRET}`).toString("base64")}`;
    expect(isAuthenticPostmarkRequest({ authorization: basic, webhookSecret: null }, SECRET)).toBe(
      true,
    );
  });

  it("refuses a wrong secret, an absent one, and an unconfigured endpoint", () => {
    expect(isAuthenticPostmarkRequest({ authorization: null, webhookSecret: "no" }, SECRET)).toBe(
      false,
    );
    expect(isAuthenticPostmarkRequest({ authorization: null, webhookSecret: null }, SECRET)).toBe(
      false,
    );
    /* No secret configured is never "anything goes". */
    expect(isAuthenticPostmarkRequest({ authorization: null, webhookSecret: "x" }, "")).toBe(false);
  });
});

describe("the provider event translation", () => {
  const AT = "2028-06-01T09:00:00.000Z";

  it("normalises a hard bounce", () => {
    const event = normalizePostmarkEvent(
      {
        RecordType: "Bounce",
        Type: "HardBounce",
        ID: 4242,
        Email: "gone@example.invalid",
        MessageID: "pm-9",
        BouncedAt: "2028-06-01T08:00:00.000Z",
      },
      AT,
    );
    expect(event).toMatchObject({
      eventType: "HARD_BOUNCE",
      providerEventId: "Bounce:4242",
      address: "gone@example.invalid",
      providerMessageRef: "pm-9",
      occurredAt: "2028-06-01T08:00:00.000Z",
    });
  });

  it("normalises a spam complaint", () => {
    expect(
      normalizePostmarkEvent(
        { RecordType: "SpamComplaint", ID: 7, Email: "cross@example.invalid" },
        AT,
      ),
    ).toMatchObject({ eventType: "SPAM_COMPLAINT", providerEventId: "SpamComplaint:7" });
  });

  it("never suppresses on a soft or unrecognised bounce", () => {
    /* The retry policy owns transient conditions. Suppressing on a type Monacado
       does not understand would silence a real customer on the strength of a
       vendor string nobody read. */
    for (const type of ["SoftBounce", "Transient", "DnsError", "SomethingNewPostmarkAdded"]) {
      const event = normalizePostmarkEvent(
        { RecordType: "Bounce", Type: type, ID: 1, Email: "x@example.invalid" },
        AT,
      );
      expect(event?.eventType).toBe("TRANSIENT_BOUNCE");
      expect(suppressionReasonFor(event!.eventType)).toBeNull();
    }
  });

  it("maps only hard bounce and complaint to a suppression reason", () => {
    expect(suppressionReasonFor("HARD_BOUNCE")).toBe("HARD_BOUNCE");
    expect(suppressionReasonFor("SPAM_COMPLAINT")).toBe("SPAM_COMPLAINT");
    expect(suppressionReasonFor("DELIVERED")).toBeNull();
  });

  it("ignores a record type Monacado does not act on", () => {
    for (const payload of [
      { RecordType: "Open" },
      { RecordType: "Click" },
      { RecordType: "SubscriptionChange" },
      {},
      null,
      "nonsense",
    ]) {
      expect(normalizePostmarkEvent(payload, AT)).toBeNull();
    }
  });
});

describe("the dispatcher endpoint gate", () => {
  const env = { MONACADO_EMAIL_DISPATCHER_SECRET: "dispatch-secret" };

  it("permits only the exact bearer secret", () => {
    expect(isAuthorizedDispatchRequest("Bearer dispatch-secret", env)).toBe(true);
    expect(isAuthorizedDispatchRequest("Bearer wrong", env)).toBe(false);
    expect(isAuthorizedDispatchRequest(null, env)).toBe(false);
    expect(isAuthorizedDispatchRequest("dispatch-secret", env)).toBe(false);
  });

  it("refuses when no secret is configured", () => {
    /* An unauthenticated dispatcher endpoint lets anyone make Monacado send its
       whole queue on demand. */
    expect(isAuthorizedDispatchRequest("Bearer anything", {})).toBe(false);
  });
});

describe("the dispatcher report", () => {
  it("carries counts, and no address, credential, or connection string", () => {
    const report = formatDispatchReport(
      {
        recovered: 1,
        claimed: 3,
        delivered: 2,
        retryScheduled: 1,
        permanentlyFailed: 0,
        suppressed: 0,
        claimConflicts: 0,
      },
      "POSTMARK",
      25,
    );
    expect(report).toContain("delivered:           2");
    expect(report).toContain("provider:            POSTMARK");
    for (const forbidden of ["mysql://", "DATABASE_URL", TOKEN, "@", "Subject"]) {
      expect(report).not.toContain(forbidden);
    }
  });
});

describe("standing constraints", () => {
  it("leaves Stripe test-mode only", () => {
    expect(STRIPE_MODES).toEqual(["TEST"]);
  });
});
