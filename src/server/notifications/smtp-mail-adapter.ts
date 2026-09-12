/**
 * The SMTP transport: Google Workspace through Nodemailer (Phase 1.27
 * correction) — SERVER ONLY.
 *
 * **The only file in this repository that imports `nodemailer`.** It implements
 * `1.1`'s unchanged `MailPort`, so the outbox, the dispatcher, the retry policy,
 * the scheduled trigger and the account-verification path are all written
 * against Monacado's own vocabulary and did not change to accommodate it.
 *
 * ## The reference architecture
 *
 * AgentNet Portal's `src/lib/email/transport-smtp.ts` is the proven pattern this
 * mirrors: Google Workspace reached over SMTP through Nodemailer, STARTTLS on 587
 * or implicit TLS on 465, TLS 1.2 as the floor with certificate validation left
 * on, a fixed EHLO name, bounded connection/greeting/socket timeouts, header-bound
 * values screened before anything connects, and every provider error collapsed
 * into a small bounded classification that never carries the provider's text.
 * What differs is deliberate and small:
 *
 *   - the classification lands on Monacado's existing `DeliveryFailureCode`, so
 *     transient versus permanent is decided by `classifyFailure` and retried by
 *     the Phase 1.5 dispatcher exactly as every other refusal is — this file owns
 *     no retry logic;
 *   - credentials are always required (see `mail-runtime-config.ts`);
 *   - a whole-send deadline bounds the attempt even when a server trickles.
 *
 * ## Accepted means accepted by the SMTP server
 *
 * `ACCEPTED` records that Google's submission server took the message — a `250`
 * after `DATA`. It is not inbox delivery, and nothing here claims it is.
 *
 * ## What is never recorded or logged
 *
 * The password, the username, the recipient, the subject, the body, and the
 * server's reply text. A refusal logs one line carrying the bounded failure code
 * and at most a numeric SMTP status and a Nodemailer error code. A thrown error is
 * read for those fields and nothing else: its message can quote the server, and
 * the server can quote the envelope.
 */

import "../server-only";
import nodemailer from "nodemailer";
import { AccountEmail } from "../../contracts/account/account";
import {
  MailMessage,
  type DeliveryFailureCode,
  type MailPort,
  type MailResult,
} from "../../contracts/marketplace/notification-delivery";
import { MailConfigurationError } from "./outbound-email-errors";
import {
  readSmtpRuntimeConfig,
  resolveSmtpPassword,
  type Env,
  type SmtpRuntimeConfig,
} from "./mail-runtime-config";

/** The EHLO name. Fixed — never derived from a request or the machine's hostname. */
export const SMTP_CLIENT_NAME = "monacado";

/** What this adapter hands Nodemailer's `createTransport`, and nothing more. */
export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  name: string;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  tls: { minVersion: "TLSv1.2" };
}

/** The one message shape this adapter sends. Plain text; no HTML, no attachment. */
export interface SmtpOutgoingMail {
  from: { name: string; address: string };
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  disableFileAccess: true;
  disableUrlAccess: true;
}

/** The parts of Nodemailer's answer this adapter reads. Read, never stored. */
export interface SmtpSentInfo {
  accepted?: unknown;
  rejected?: unknown;
  messageId?: unknown;
}

export interface SmtpTransporter {
  sendMail(mail: SmtpOutgoingMail): Promise<SmtpSentInfo>;
  close?(): void;
}

/** Injected so a test drives the adapter with no socket at all. */
export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransporter;

const nodemailerTransportFactory: SmtpTransportFactory = (options) =>
  nodemailer.createTransport(options);

/**
 * The Nodemailer options for one configuration.
 *
 * Exported so the TLS posture can be asserted without opening a connection.
 */
export function smtpTransportOptions(
  config: SmtpRuntimeConfig,
  password: string,
): SmtpTransportOptions {
  return {
    host: config.host,
    port: config.port,
    /* true → implicit TLS from the first byte (465). false → a plaintext greeting
       and then STARTTLS, which `requireTLS` makes mandatory rather than
       opportunistic: a server that does not offer the upgrade is refused. */
    secure: config.secure,
    requireTLS: config.requireTls,
    auth: { user: config.username, pass: password },
    name: SMTP_CLIENT_NAME,
    connectionTimeout: config.connectionTimeoutMs,
    greetingTimeout: config.connectionTimeoutMs,
    socketTimeout: config.socketTimeoutMs,
    /* A floor, not a pin. Certificate validation is Node's default and is
       deliberately left alone: there is no `rejectUnauthorized: false` here. */
    tls: { minVersion: "TLSv1.2" },
  };
}

// — Normalisation —

/** Failures below SMTP: the connection, DNS, TLS, or the socket went away. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "EDNS",
  "ESOCKET",
  "ETIMEDOUT",
  "ETLS",
  "EPROTOCOL",
]);

/** Authentication required, mechanism refused, credentials invalid. */
const AUTH_STATUSES = new Set([530, 534, 535]);

/** `550 5.1.1 ...` → class, subject, detail. Read from the reply, never kept. */
const ENHANCED_STATUS_RE = /^\d{3}[ -](\d)\.(\d{1,3})\.(\d{1,3})/;

/**
 * Translate one Nodemailer/SMTP failure into Monacado's vocabulary.
 *
 * The list is short on purpose, as the Postmark table is. Everything unlisted is
 * `UNSPECIFIED_FAILURE`, which is transient: an unrecognised answer is a reason to
 * try again cautiously, not a reason to throw a verification email away.
 */
export function normalizeSmtpError(error: unknown): DeliveryFailureCode {
  const e = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof e.code === "string" ? e.code : undefined;
  const status = typeof e.responseCode === "number" ? e.responseCode : undefined;
  const command = typeof e.command === "string" ? e.command.trim().toUpperCase() : "";
  const enhanced = typeof e.response === "string" ? ENHANCED_STATUS_RE.exec(e.response) : null;

  /* A credential Google refused. Retrying cannot fix a password, but neither is
     it a property of the message: it is configuration, which Monacado already
     classifies as transient-until-exhausted, so correcting the password rescues
     the queue. The answer the Postmark adapter gives a bad server token. */
  if (code === "EAUTH" || code === "ENOAUTH" || (status !== undefined && AUTH_STATUSES.has(status))) {
    return "CHANNEL_NOT_CONFIGURED";
  }

  /* 4xx is SMTP's own word for "not now": greylisting, rate limiting, a busy
     server. Emphatically transient. */
  if (status !== undefined && status >= 400 && status < 500) return "PROVIDER_UNAVAILABLE";

  if (status !== undefined && status >= 500 && status < 600) {
    /* 5.4.5 is Google's sending-limit refusal. It means "not today", not "never",
       and treating it as permanent would discard every message sent after a busy
       hour. */
    if (enhanced?.[1] === "5" && enhanced[2] === "4" && enhanced[3] === "5") {
      return "PROVIDER_UNAVAILABLE";
    }
    /* Refused at MAIL FROM: this account may not send as this sender. */
    if (command.startsWith("MAIL")) return "CHANNEL_NOT_CONFIGURED";
    if (command.startsWith("RCPT")) {
      /* x.7.x at RCPT is a relay or policy refusal of Monacado's submission —
         configuration — rather than a verdict on the address. */
      return enhanced?.[2] === "7" ? "CHANNEL_NOT_CONFIGURED" : "DESTINATION_REJECTED";
    }
    return "MESSAGE_REJECTED";
  }

  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) return "PROVIDER_UNAVAILABLE";
  return "UNSPECIFIED_FAILURE";
}

function addressOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null) {
    const address = (entry as { address?: unknown }).address;
    if (typeof address === "string") return address;
  }
  return undefined;
}

/**
 * Translate one successful Nodemailer answer.
 *
 * Accepted only when the server accepted this recipient and Nodemailer holds a
 * message id to correlate by — the same rule the Postmark adapter applies: an
 * acceptance Monacado cannot tie anything back to is treated as not accepted.
 */
export function normalizeSmtpSentInfo(info: SmtpSentInfo, to: string): MailResult {
  const target = to.toLowerCase();
  const lists = (list: unknown) =>
    Array.isArray(list) && list.some((entry) => addressOf(entry)?.toLowerCase() === target);

  if (!lists(info.accepted)) {
    return {
      outcome: "REFUSED",
      failureCode: lists(info.rejected) ? "DESTINATION_REJECTED" : "UNSPECIFIED_FAILURE",
    };
  }
  const ref = typeof info.messageId === "string" ? info.messageId.trim() : "";
  if (ref.length === 0 || ref.length > 191) {
    return { outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" };
  }
  return { outcome: "ACCEPTED", providerMessageRef: ref };
}

// — The adapter —

export interface SmtpAdapterDeps {
  /** Pinned configuration. Production reads it from the env on every send. */
  config?: SmtpRuntimeConfig;
  env?: Env;
  createTransport?: SmtpTransportFactory;
  /** Where the one secret-free refusal line goes. */
  log?: (line: string) => void;
}

const HEADER_BREAK_RE = /[\r\n]/;
const ERROR_CODE_RE = /^E[A-Z]{2,15}$/;

const refused = (failureCode: DeliveryFailureCode): MailResult => ({
  outcome: "REFUSED",
  failureCode,
});

/** Only a numeric status and a Nodemailer code. Never `message` or `response`. */
function describeSmtpError(error: unknown): string {
  const e = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const parts: string[] = [];
  if (typeof e.responseCode === "number" && e.responseCode >= 100 && e.responseCode < 600) {
    parts.push(`smtpStatus=${e.responseCode}`);
  }
  if (typeof e.code === "string" && ERROR_CODE_RE.test(e.code)) parts.push(`errorCode=${e.code}`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/**
 * A `MailPort` backed by Google Workspace SMTP.
 *
 * Nothing is read at construction and nothing is held between sends: the
 * configuration and password are resolved per message, so rotating the password
 * takes effect on the next send rather than the next deploy, and a fresh
 * transport per message leaves no pooled connection for a serverless instance to
 * strand. It never throws for a refusal — `MailPort` says a refusal is a result.
 */
export function createSmtpMailAdapter(deps: SmtpAdapterDeps = {}): MailPort {
  const env = deps.env ?? process.env;
  const createTransport = deps.createTransport ?? nodemailerTransportFactory;
  const log = deps.log ?? ((line: string) => console.error(line));

  return {
    async send(rawMessage): Promise<MailResult> {
      const message = MailMessage.parse(rawMessage);

      let config: SmtpRuntimeConfig;
      let password: string;
      try {
        config = deps.config ?? readSmtpRuntimeConfig(env);
        password = resolveSmtpPassword(config, env);
      } catch (error) {
        /* Fail closed, before any connection: no host, no mailbox, no password.
           The issues are variable names by construction, never values. */
        const issues =
          error instanceof MailConfigurationError ? error.issues.join(", ") : "unreadable";
        log(`[mail:smtp] refused before connect: failureCode=CHANNEL_NOT_CONFIGURED (${issues})`);
        return refused("CHANNEL_NOT_CONFIGURED");
      }

      /* One plain address and a single-line subject, checked before anything
         connects. `AccountEmail` admits no whitespace, comma or angle bracket, so
         the value cannot become a second recipient or a header. */
      if (!AccountEmail.safeParse(message.to).success) {
        log("[mail:smtp] refused before connect: failureCode=DESTINATION_REJECTED (recipient)");
        return refused("DESTINATION_REJECTED");
      }
      if (HEADER_BREAK_RE.test(message.subject)) {
        log("[mail:smtp] refused before connect: failureCode=MESSAGE_REJECTED (subject)");
        return refused("MESSAGE_REJECTED");
      }

      let transporter: SmtpTransporter;
      try {
        transporter = createTransport(smtpTransportOptions(config, password));
      } catch {
        log("[mail:smtp] refused before connect: failureCode=CHANNEL_NOT_CONFIGURED (transport)");
        return refused("CHANNEL_NOT_CONFIGURED");
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"DEADLINE">((resolve) => {
        timer = setTimeout(() => resolve("DEADLINE"), config.sendTimeoutMs);
      });

      try {
        const sending = transporter.sendMail({
          from: { name: config.fromName, address: config.fromAddress },
          to: message.to,
          ...(config.replyTo !== null ? { replyTo: config.replyTo } : {}),
          subject: message.subject,
          text: message.text,
          /* The body is plain text Monacado rendered, but nothing in it should
             ever make Nodemailer read a file or fetch a URL. */
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        /* A send abandoned at the deadline must not surface later as an
           unhandled rejection. */
        sending.catch(() => undefined);

        const outcome = await Promise.race([sending, deadline]);
        if (outcome === "DEADLINE") {
          /* Unavailable, and therefore retried. The abandoned attempt may still
             have been accepted, so a retry can duplicate the message — the same
             trade the Postmark adapter's request timeout makes, and the right one
             for a verification email: a second link is harmless, a lost one is
             somebody who cannot sign in. */
          log("[mail:smtp] refused: failureCode=PROVIDER_UNAVAILABLE (send deadline)");
          return refused("PROVIDER_UNAVAILABLE");
        }

        const result = normalizeSmtpSentInfo(outcome, message.to);
        if (result.outcome === "REFUSED") {
          log(`[mail:smtp] refused: failureCode=${result.failureCode} (recipient not accepted)`);
        }
        return result;
      } catch (error) {
        const failureCode = normalizeSmtpError(error);
        log(`[mail:smtp] refused: failureCode=${failureCode}${describeSmtpError(error)}`);
        return refused(failureCode);
      } finally {
        clearTimeout(timer);
        try {
          transporter.close?.();
        } catch {
          /* Nothing is held that a failed close could leak. */
        }
      }
    },
  };
}
