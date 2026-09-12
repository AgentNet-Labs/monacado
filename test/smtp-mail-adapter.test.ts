/**
 * Google Workspace SMTP adapter tests (Phase 1.27 correction).
 *
 * No database and no route to Google. Most cases inject a fake Nodemailer
 * transport; the last block drives the REAL Nodemailer client against a
 * disposable SMTP server bound to 127.0.0.1, which relays nothing.
 *
 * Not re-proved: retry scheduling, backoff, claim leases, and the delivery state
 * machine — the Phase 1.5 suites own those. This adapter only has to land on the
 * right `DeliveryFailureCode` for the existing `classifyFailure` to do the rest,
 * so that is what these assert.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFailure } from "../src/contracts/marketplace/outbound-email";
import type { DeliveryFailureCode } from "../src/contracts/marketplace/notification-delivery";
import { MailConfigurationError } from "../src/server/notifications/outbound-email-errors";
import {
  readSmtpRuntimeConfig,
  resolveSmtpPassword,
  type Env,
} from "../src/server/notifications/mail-runtime-config";
import {
  createSmtpMailAdapter,
  smtpTransportOptions,
  type SmtpOutgoingMail,
  type SmtpSentInfo,
  type SmtpTransportFactory,
  type SmtpTransportOptions,
} from "../src/server/notifications/smtp-mail-adapter";
import { resolveMailPort, resolvedMailProvider } from "../src/server/notifications/mail-port";
import { smtpHeader, smtpTextBody, startFakeSmtpServer } from "./support/fake-smtp-server";

const PASSWORD = "smtp-app-password-not-real";
const USERNAME = "notifications@monacado.test";
const TO = "person@example.com";
const SUBJECT = "Confirm your Monacado email address";
const TOKEN = "secret-token-value";
const BODY = `https://monacado.test/verify-account-email?token=${TOKEN}`;
const MESSAGE = { to: TO, subject: SUBJECT, text: BODY };

const SMTP_ENV: Env = {
  MONACADO_MAIL_ENABLED: "true",
  MONACADO_MAIL_TRANSPORT: "SMTP",
  MONACADO_SMTP_HOST: "smtp.gmail.com",
  MONACADO_SMTP_USERNAME: USERNAME,
  MONACADO_SMTP_PASSWORD: PASSWORD,
  MONACADO_MAIL_FROM_ADDRESS: USERNAME,
  MONACADO_MAIL_REPLY_TO: "support@monacado.test",
};

const without = (env: Env, name: string): Env => {
  const copy = { ...env };
  delete copy[name];
  return copy;
};

function adapter(answer: (mail: SmtpOutgoingMail) => Promise<SmtpSentInfo>, env: Env = SMTP_ENV) {
  const created: SmtpTransportOptions[] = [];
  const sent: SmtpOutgoingMail[] = [];
  const lines: string[] = [];
  const createTransport: SmtpTransportFactory = (options) => {
    created.push(options);
    return {
      async sendMail(mail) {
        sent.push(mail);
        return answer(mail);
      },
    };
  };
  const port = createSmtpMailAdapter({ env, createTransport, log: (line) => lines.push(line) });
  return { port, created, sent, lines };
}

const accepted = async (mail: SmtpOutgoingMail): Promise<SmtpSentInfo> => ({
  accepted: [mail.to],
  rejected: [],
  messageId: "<fake-1@monacado.test>",
});

/** A Nodemailer-shaped failure whose message and reply carry what must never leak. */
const failing =
  (fields: Record<string, unknown>) =>
  async (): Promise<SmtpSentInfo> => {
    throw Object.assign(new Error(`refused ${TO} for ${USERNAME}/${PASSWORD}: ${SUBJECT}`), {
      response: `quoted ${TO} ${BODY}`,
      ...fields,
    });
  };

/** Nothing a log line may carry: credential, mailbox, recipient, content, token. */
function expectNoLeak(lines: string[]) {
  const all = lines.join("\n");
  for (const forbidden of [PASSWORD, TO, SUBJECT, BODY, TOKEN, "quoted"]) {
    expect(all).not.toContain(forbidden);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SMTP configuration", () => {
  it("reads STARTTLS on 587 by default, holding the password's variable NAME only", () => {
    const config = readSmtpRuntimeConfig(SMTP_ENV);
    expect(config).toEqual({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      requireTls: true,
      username: USERNAME,
      passwordEnvVar: "MONACADO_SMTP_PASSWORD",
      fromAddress: USERNAME,
      fromName: "Monacado",
      replyTo: "support@monacado.test",
      connectionTimeoutMs: 10_000,
      socketTimeoutMs: 15_000,
      sendTimeoutMs: 20_000,
    });
    expect(JSON.stringify(config)).not.toContain(PASSWORD);
    expect(resolveSmtpPassword(config, SMTP_ENV)).toBe(PASSWORD);
  });

  it("defaults to implicit TLS on 465, and follows a renamed password variable", () => {
    expect(readSmtpRuntimeConfig({ ...SMTP_ENV, MONACADO_SMTP_PORT: "465" }).secure).toBe(true);
    expect(
      readSmtpRuntimeConfig({ ...SMTP_ENV, MONACADO_SMTP_PORT: "465", MONACADO_SMTP_SECURE: "false" })
        .secure,
    ).toBe(false);

    const renamed = {
      ...without(SMTP_ENV, "MONACADO_SMTP_PASSWORD"),
      MONACADO_SMTP_PASSWORD_ENV: "WORKSPACE_APP_PASSWORD",
      WORKSPACE_APP_PASSWORD: "another-not-real-password",
    };
    expect(resolveSmtpPassword(readSmtpRuntimeConfig(renamed), renamed)).toBe(
      "another-not-real-password",
    );
  });

  it("refuses with every variable at fault named, and never a value", () => {
    try {
      readSmtpRuntimeConfig({
        MONACADO_SMTP_PORT: "five-eight-seven",
        MONACADO_SMTP_SECURE: "sometimes",
        MONACADO_SMTP_SEND_TIMEOUT_MS: "999999",
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(MailConfigurationError);
      const refusal = error as MailConfigurationError;
      expect(refusal.issues).toEqual(
        expect.arrayContaining([
          "MONACADO_SMTP_HOST",
          "MONACADO_SMTP_PORT",
          "MONACADO_SMTP_SECURE",
          "MONACADO_SMTP_USERNAME",
          "MONACADO_MAIL_FROM_ADDRESS",
          "MONACADO_SMTP_SEND_TIMEOUT_MS",
        ]),
      );
      expect(refusal.message).not.toContain("five-eight-seven");
      expect(refusal.message).not.toContain("sometimes");
    }
  });

  it("refuses plaintext SMTP to anything but a loopback host", () => {
    try {
      readSmtpRuntimeConfig({ ...SMTP_ENV, MONACADO_SMTP_REQUIRE_TLS: "false" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as MailConfigurationError).issues).toEqual(["MONACADO_SMTP_REQUIRE_TLS"]);
    }
    expect(
      readSmtpRuntimeConfig({
        ...SMTP_ENV,
        MONACADO_SMTP_HOST: "127.0.0.1",
        MONACADO_SMTP_REQUIRE_TLS: "false",
      }).requireTls,
    ).toBe(false);
  });

  it("fails closed on a missing or placeholder password, naming only the variable", () => {
    for (const value of [undefined, "", "   ", "changeme"]) {
      const env = { ...SMTP_ENV, MONACADO_SMTP_PASSWORD: value };
      expect(() => resolveSmtpPassword(readSmtpRuntimeConfig(env), env)).toThrow(
        MailConfigurationError,
      );
    }
    try {
      resolveSmtpPassword(readSmtpRuntimeConfig(SMTP_ENV), {});
    } catch (error) {
      expect((error as Error).message).toContain("MONACADO_SMTP_PASSWORD");
      expect((error as Error).message).not.toContain(PASSWORD);
    }
  });
});

describe("TLS posture", () => {
  it("587 is STARTTLS: plaintext greeting, mandatory upgrade, TLS 1.2 floor, certificates validated", () => {
    const options = smtpTransportOptions(readSmtpRuntimeConfig(SMTP_ENV), PASSWORD);
    expect(options).toEqual({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: USERNAME, pass: PASSWORD },
      name: "monacado",
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      tls: { minVersion: "TLSv1.2" },
    });
    /* Nothing switches certificate validation off. */
    expect("rejectUnauthorized" in options.tls).toBe(false);
  });

  it("465 is implicit TLS", () => {
    const config = readSmtpRuntimeConfig({ ...SMTP_ENV, MONACADO_SMTP_PORT: "465" });
    expect(smtpTransportOptions(config, PASSWORD)).toMatchObject({ port: 465, secure: true });
  });
});

describe("sending through an injected transport", () => {
  it("accepted by the SMTP server is ACCEPTED, with the message id and a plain-text message", async () => {
    const { port, created, sent } = adapter(accepted);
    expect(await port.send(MESSAGE)).toEqual({
      outcome: "ACCEPTED",
      providerMessageRef: "<fake-1@monacado.test>",
    });
    expect(created).toHaveLength(1);
    expect(sent).toEqual([
      {
        from: { name: "Monacado", address: USERNAME },
        to: TO,
        replyTo: "support@monacado.test",
        subject: SUBJECT,
        text: BODY,
        disableFileAccess: true,
        disableUrlAccess: true,
      },
    ]);
  });

  const expectCode = async (
    fields: Record<string, unknown>,
    code: DeliveryFailureCode,
    outcomeClass: "TRANSIENT" | "PERMANENT",
  ) => {
    const { port, lines } = adapter(failing(fields));
    expect(await port.send(MESSAGE), JSON.stringify(fields)).toEqual({
      outcome: "REFUSED",
      failureCode: code,
    });
    expect(classifyFailure(code)).toBe(outcomeClass);
    expectNoLeak(lines);
  };

  it("maps transient SMTP failures into the existing retry semantics", async () => {
    await expectCode(
      { responseCode: 421, command: "MAIL FROM", response: "421 4.7.0 Try again later" },
      "PROVIDER_UNAVAILABLE",
      "TRANSIENT",
    );
    await expectCode(
      { responseCode: 450, command: "RCPT TO", response: "450 4.2.1 Mailbox busy" },
      "PROVIDER_UNAVAILABLE",
      "TRANSIENT",
    );
    await expectCode({ code: "ETIMEDOUT" }, "PROVIDER_UNAVAILABLE", "TRANSIENT");
    await expectCode({ code: "ECONNECTION" }, "PROVIDER_UNAVAILABLE", "TRANSIENT");
    /* Google's sending limit says "not today", not "never". */
    await expectCode(
      { responseCode: 550, command: "DATA", response: "550 5.4.5 Daily user sending limit exceeded" },
      "PROVIDER_UNAVAILABLE",
      "TRANSIENT",
    );
    await expectCode({ code: "EWHATEVER" }, "UNSPECIFIED_FAILURE", "TRANSIENT");
  });

  it("treats a refused credential, sender, or relay as configuration — retried until exhausted", async () => {
    await expectCode(
      { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN", response: "535 5.7.8 Bad credentials" },
      "CHANNEL_NOT_CONFIGURED",
      "TRANSIENT",
    );
    await expectCode(
      { responseCode: 553, command: "MAIL FROM", response: "553 5.7.1 Sender address rejected" },
      "CHANNEL_NOT_CONFIGURED",
      "TRANSIENT",
    );
    await expectCode(
      { responseCode: 550, command: "RCPT TO", response: "550 5.7.0 Mail relay denied" },
      "CHANNEL_NOT_CONFIGURED",
      "TRANSIENT",
    );
  });

  it("is permanent only when the server rejects the address or the message", async () => {
    await expectCode(
      { responseCode: 550, command: "RCPT TO", response: "550 5.1.1 No such user" },
      "DESTINATION_REJECTED",
      "PERMANENT",
    );
    await expectCode(
      { responseCode: 554, command: "DATA", response: "554 5.6.0 Message malformed" },
      "MESSAGE_REJECTED",
      "PERMANENT",
    );
  });

  it("an answer that does not accept this recipient is not an acceptance", async () => {
    expect(
      await adapter(async () => ({ accepted: [], rejected: [TO], messageId: "<x@y>" })).port.send(
        MESSAGE,
      ),
    ).toEqual({ outcome: "REFUSED", failureCode: "DESTINATION_REJECTED" });
    expect(await adapter(async () => ({ accepted: [TO] })).port.send(MESSAGE)).toEqual({
      outcome: "REFUSED",
      failureCode: "PROVIDER_UNAVAILABLE",
    });
  });

  it("bounds the whole send with a deadline", async () => {
    vi.useFakeTimers();
    const { port } = adapter(() => new Promise<SmtpSentInfo>(() => undefined), {
      ...SMTP_ENV,
      MONACADO_SMTP_SEND_TIMEOUT_MS: "1000",
    });
    const pending = port.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" });
  });

  it("fails closed without credentials or a sender, and never opens a transport", async () => {
    for (const [env, named] of [
      [{ ...SMTP_ENV, MONACADO_SMTP_PASSWORD: "" }, "MONACADO_SMTP_PASSWORD"],
      [without(SMTP_ENV, "MONACADO_SMTP_USERNAME"), "MONACADO_SMTP_USERNAME"],
      [without(SMTP_ENV, "MONACADO_SMTP_HOST"), "MONACADO_SMTP_HOST"],
      [without(SMTP_ENV, "MONACADO_MAIL_FROM_ADDRESS"), "MONACADO_MAIL_FROM_ADDRESS"],
    ] as const) {
      const { port, created, lines } = adapter(accepted, env);
      expect(await port.send(MESSAGE)).toEqual({
        outcome: "REFUSED",
        failureCode: "CHANNEL_NOT_CONFIGURED",
      });
      expect(classifyFailure("CHANNEL_NOT_CONFIGURED")).toBe("TRANSIENT");
      expect(created).toHaveLength(0);
      expect(lines.join("\n")).toContain(named);
      expectNoLeak(lines);
    }
  });

  it("refuses a recipient or subject that could smuggle a header, before connecting", async () => {
    const list = adapter(accepted);
    expect(await list.port.send({ ...MESSAGE, to: "a@example.com, b@example.com" })).toEqual({
      outcome: "REFUSED",
      failureCode: "DESTINATION_REJECTED",
    });
    expect(list.created).toHaveLength(0);

    const header = adapter(accepted);
    expect(await header.port.send({ ...MESSAGE, subject: "Hi\r\nBcc: x@example.com" })).toEqual({
      outcome: "REFUSED",
      failureCode: "MESSAGE_REJECTED",
    });
    expect(header.created).toHaveLength(0);
  });
});

describe("transport selection", () => {
  it("selects SMTP only when mail is enabled and SMTP is named", () => {
    expect(resolvedMailProvider(SMTP_ENV)).toBe("SMTP");
    expect(resolvedMailProvider({ ...SMTP_ENV, MONACADO_MAIL_ENABLED: "false" })).toBe("DISABLED");
  });

  it("an unconfigured SMTP deployment refuses every message rather than throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = resolveMailPort({ MONACADO_MAIL_ENABLED: "true", MONACADO_MAIL_TRANSPORT: "SMTP" });
    expect(await port.send(MESSAGE)).toEqual({
      outcome: "REFUSED",
      failureCode: "CHANNEL_NOT_CONFIGURED",
    });
  });
});

describe("the real Nodemailer client against a loopback SMTP server", () => {
  const loopback = (port: number, overrides: Env = {}): Env => ({
    ...SMTP_ENV,
    MONACADO_SMTP_HOST: "127.0.0.1",
    MONACADO_SMTP_PORT: String(port),
    MONACADO_SMTP_REQUIRE_TLS: "false",
    MONACADO_SMTP_CONNECTION_TIMEOUT_MS: "5000",
    MONACADO_SMTP_SOCKET_TIMEOUT_MS: "5000",
    MONACADO_SMTP_SEND_TIMEOUT_MS: "5000",
    ...overrides,
  });

  it("authenticates, submits a plain-text message, and is accepted", async () => {
    const server = await startFakeSmtpServer({ username: USERNAME, password: PASSWORD });
    try {
      const lines: string[] = [];
      const port = createSmtpMailAdapter({ env: loopback(server.port), log: (l) => lines.push(l) });
      const result = await port.send(MESSAGE);

      expect(result.outcome).toBe("ACCEPTED");
      expect(server.authentications).toEqual({ accepted: 1, refused: 0 });
      expect(server.messages).toHaveLength(1);
      const [message] = server.messages;
      expect(message!.rcptTo).toEqual([`<${TO}>`]);
      expect(smtpHeader(message!.data, "From")).toBe(`Monacado <${USERNAME}>`);
      expect(smtpHeader(message!.data, "Reply-To")).toBe("support@monacado.test");
      expect(smtpHeader(message!.data, "Subject")).toBe(SUBJECT);
      expect(smtpHeader(message!.data, "Content-Type")).toMatch(/^text\/plain/);
      expect(smtpTextBody(message!.data)).toContain(BODY);
      expect(lines).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("a 421 through the real client is a transient refusal, and nothing is submitted", async () => {
    const server = await startFakeSmtpServer({ username: USERNAME, password: PASSWORD });
    try {
      server.failNext("MAIL", "421 4.7.0 Temporary System Problem. Try again later.");
      const lines: string[] = [];
      const port = createSmtpMailAdapter({ env: loopback(server.port), log: (l) => lines.push(l) });
      expect(await port.send(MESSAGE)).toEqual({
        outcome: "REFUSED",
        failureCode: "PROVIDER_UNAVAILABLE",
      });
      expect(server.messages).toHaveLength(0);
      expect(lines.join("\n")).toContain("smtpStatus=421");
      expectNoLeak(lines);
    } finally {
      await server.close();
    }
  });

  it("a wrong password through the real client is configuration, and nothing is submitted", async () => {
    const server = await startFakeSmtpServer({ username: USERNAME, password: PASSWORD });
    try {
      const lines: string[] = [];
      const port = createSmtpMailAdapter({
        env: loopback(server.port, { MONACADO_SMTP_PASSWORD: "a-wrong-password" }),
        log: (l) => lines.push(l),
      });
      expect(await port.send(MESSAGE)).toEqual({
        outcome: "REFUSED",
        failureCode: "CHANNEL_NOT_CONFIGURED",
      });
      expect(server.authentications).toEqual({ accepted: 0, refused: 1 });
      expect(server.messages).toHaveLength(0);
      expect(lines.join("\n")).not.toContain("a-wrong-password");
      expectNoLeak(lines);
    } finally {
      await server.close();
    }
  });
});
