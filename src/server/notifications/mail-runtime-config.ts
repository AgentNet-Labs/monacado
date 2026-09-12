/**
 * Mail transport configuration (Phase 1.5) — SERVER ONLY.
 *
 * `1.1` declared the seam and shipped two local adapters, recording that
 * choosing a vendor was "a third party, a data-processing relationship, and a
 * deliverability story" and not a notification phase's decision to make. This
 * phase makes it: **Postmark**, as the initial production transactional-email
 * provider, behind the same unchanged `MailPort`.
 *
 * ## The secret is a variable NAME here, never a value
 *
 * `serverTokenEnvVar` holds the *name* of the variable that holds the token —
 * exactly the construction `stripe-runtime-config.ts` uses for `apiKeyEnvVar`,
 * and for the same reason: this object is constructed, passed around, logged in
 * a debugger, and serialised into an error. A credential that is never in it
 * cannot leak from it. Resolving the token happens in one function, at the moment
 * a request is about to be made.
 *
 * ## Fail closed
 *
 * Selecting `POSTMARK` with no token, no From address, or an unparseable From
 * address raises `MailConfigurationError` naming the **fields** at fault and
 * never their values. It does not fall back to the log adapter: a deployment that
 * believes it is sending production mail and is quietly writing to stdout is
 * worse than one that refuses to start sending.
 *
 * An unrecognised transport is a misconfiguration and resolves to the disabled
 * adapter — `1.1`'s rule, unchanged.
 */

import "../server-only";
import { z } from "zod";
import { AccountEmail } from "../../contracts/account/account";
import { MailConfigurationError } from "./outbound-email-errors";

export type Env = Record<string, string | undefined>;

const TRUTHY = new Set(["true", "1", "yes"]);

/** A shell-safe environment variable name. Never the value it names. */
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Every transport this deployment can select.
 *
 * `POSTMARK` is added to `1.1`'s two as the additive change the seam was built
 * to take, and no caller above the port changed to accommodate it.
 *
 * `SMTP` (Phase 1.27 correction) is Google Workspace over authenticated SMTP,
 * the transport Monacado's staging and production deployments use. It is added
 * the same way, and for the same reason nothing above the port moved.
 */
export const MAIL_TRANSPORTS = ["LOG", "CAPTURE", "POSTMARK", "SMTP"] as const;
export type MailTransport = (typeof MAIL_TRANSPORTS)[number];

/** What a delivery row records as having answered. */
export const MAIL_PROVIDERS = ["DISABLED", "LOG", "CAPTURE", "POSTMARK", "SMTP"] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

/** The master switch. Anything other than true/1/yes means disabled. */
export function isMailEnabled(env: Env = process.env): boolean {
  const raw = env.MONACADO_MAIL_ENABLED;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

export function selectedMailTransport(env: Env = process.env): string {
  return (env.MONACADO_MAIL_TRANSPORT ?? "LOG").trim().toUpperCase();
}

/**
 * The validated, **secret-free** configuration of the Postmark transport.
 *
 * There is no field here a credential could occupy.
 */
export const PostmarkRuntimeConfig = z.strictObject({
  /** The NAME of the variable holding the server token. Never the token. */
  serverTokenEnvVar: z.string().regex(ENV_VAR_NAME_RE, "must be an environment variable name"),
  /**
   * The verified sender. Postmark refuses anything else, which makes this a
   * deployment fact rather than a preference — and never a request parameter: a
   * caller that could name the From address could send as Monacado.
   */
  fromAddress: AccountEmail,
  /**
   * Which Postmark message stream to use. Transactional mail belongs on a
   * transactional stream: putting a receipt on a broadcast stream attaches an
   * unsubscribe footer to it and pools its reputation with marketing.
   */
  messageStream: z.string().min(1).max(64),
  /** The NAME of the variable holding the webhook shared secret. */
  webhookSecretEnvVar: z.string().regex(ENV_VAR_NAME_RE, "must be an environment variable name"),
  /** Where to POST. Configurable only so a test can point at a loopback double. */
  apiBaseUrl: z.string().url(),
});
export type PostmarkRuntimeConfig = z.infer<typeof PostmarkRuntimeConfig>;

export const POSTMARK_API_BASE_URL = "https://api.postmarkapp.com";
export const DEFAULT_POSTMARK_MESSAGE_STREAM = "outbound";

/**
 * Read the Postmark block, or refuse with every issue at once.
 *
 * Called only when `POSTMARK` is the selected transport, so a deployment using
 * the log adapter is never asked for a token it does not have.
 */
export function readPostmarkRuntimeConfig(env: Env = process.env): PostmarkRuntimeConfig {
  const parsed = PostmarkRuntimeConfig.safeParse({
    serverTokenEnvVar: env.MONACADO_POSTMARK_TOKEN_ENV ?? "MONACADO_POSTMARK_SERVER_TOKEN",
    fromAddress: (env.MONACADO_MAIL_FROM_ADDRESS ?? "").trim(),
    messageStream:
      (env.MONACADO_POSTMARK_MESSAGE_STREAM ?? "").trim() || DEFAULT_POSTMARK_MESSAGE_STREAM,
    webhookSecretEnvVar:
      env.MONACADO_POSTMARK_WEBHOOK_SECRET_ENV ?? "MONACADO_POSTMARK_WEBHOOK_SECRET",
    apiBaseUrl: (env.MONACADO_POSTMARK_API_BASE_URL ?? "").trim() || POSTMARK_API_BASE_URL,
  });
  if (!parsed.success) {
    throw new MailConfigurationError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  return parsed.data;
}

/**
 * Resolve the Postmark server token.
 *
 * **The one place the token is read.** It is handed to the immediate caller — the
 * request builder — and stored in no object anything else can reach or serialise.
 * The error names the variable and never any part of the value: a configuration
 * error about a secret is exactly the log line a secret ends up in.
 */
export function resolvePostmarkServerToken(
  config: PostmarkRuntimeConfig,
  env: Env = process.env,
): string {
  const token = (env[config.serverTokenEnvVar] ?? "").trim();
  if (token === "") {
    throw new MailConfigurationError([`${config.serverTokenEnvVar} is not set`]);
  }
  return token;
}

/**
 * Resolve the webhook shared secret.
 *
 * Postmark **does not sign its webhooks**. Its documented mechanisms for securing
 * a webhook endpoint are HTTP Basic credentials embedded in the webhook URL and a
 * custom header; a shared secret compared in constant time is the strongest thing
 * the provider actually supports. That is recorded here rather than left for
 * somebody to discover while looking for a signature that does not exist.
 */
export function resolvePostmarkWebhookSecret(
  config: PostmarkRuntimeConfig,
  env: Env = process.env,
): string {
  const secret = (env[config.webhookSecretEnvVar] ?? "").trim();
  if (secret === "") {
    throw new MailConfigurationError([`${config.webhookSecretEnvVar} is not set`]);
  }
  return secret;
}

// — SMTP: Google Workspace (Phase 1.27 correction) —

/*
 * Monacado sends through Google Workspace over authenticated SMTP, mirroring the
 * AgentNet Portal transactional-email architecture: Nodemailer, configured
 * entirely by server-side environment variables, with capture transports for
 * tests. The variable names follow this repository's `MONACADO_` convention
 * rather than the Portal's `EMAIL_*`, and the password follows this file's own
 * rule — the config holds the NAME of the variable, never the value.
 *
 * ## Authentication is required, on every host
 *
 * The Portal also permits Workspace SMTP relay with no credentials, trusting an
 * IP allow-list. Monacado does not: a Vercel function has no stable egress
 * address to allow-list, so an unauthenticated relay configuration could only
 * ever work by accident. A missing username or password refuses.
 *
 * ## Transport security
 *
 * `secure: true` is implicit TLS (465). `secure: false` with `requireTls: true`
 * is STARTTLS (587), and the upgrade is mandatory — a server that does not offer
 * it is refused rather than spoken to in plaintext. Both false is plaintext, and
 * is accepted **only for a loopback host**, so a test can drive a disposable local
 * SMTP server; anywhere else it is a configuration error, because it would put
 * the password on the wire in the clear.
 */

const FALSY = new Set(["false", "0", "no"]);
const LOOPBACK_SMTP_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Values an operator leaves behind from an example file. Never a real password. */
const PLACEHOLDER_SMTP_PASSWORDS = new Set([
  "changeme",
  "change-me",
  "password",
  "placeholder",
  "todo",
  "xxx",
  "your-password",
]);

export const DEFAULT_SMTP_PORT = 587;
export const IMPLICIT_TLS_SMTP_PORT = 465;
export const DEFAULT_SMTP_PASSWORD_ENV = "MONACADO_SMTP_PASSWORD";
export const DEFAULT_MAIL_FROM_NAME = "Monacado";

/** Bounded by default, and bounded when configured: 1s..60s. */
export const SMTP_TIMEOUT_DEFAULTS_MS = { connection: 10_000, socket: 15_000, send: 20_000 } as const;
const SmtpTimeoutMs = z.number().int().min(1_000).max(60_000);

/** Which variable each field is read from, so a refusal names what to fix. */
const SMTP_FIELD_ENV: Record<string, string> = {
  host: "MONACADO_SMTP_HOST",
  port: "MONACADO_SMTP_PORT",
  secure: "MONACADO_SMTP_SECURE",
  requireTls: "MONACADO_SMTP_REQUIRE_TLS",
  username: "MONACADO_SMTP_USERNAME",
  passwordEnvVar: "MONACADO_SMTP_PASSWORD_ENV",
  fromAddress: "MONACADO_MAIL_FROM_ADDRESS",
  fromName: "MONACADO_MAIL_FROM_NAME",
  replyTo: "MONACADO_MAIL_REPLY_TO",
  connectionTimeoutMs: "MONACADO_SMTP_CONNECTION_TIMEOUT_MS",
  socketTimeoutMs: "MONACADO_SMTP_SOCKET_TIMEOUT_MS",
  sendTimeoutMs: "MONACADO_SMTP_SEND_TIMEOUT_MS",
};

export function isLoopbackSmtpHost(host: string): boolean {
  return LOOPBACK_SMTP_HOSTS.has(host.trim().toLowerCase());
}

/**
 * The validated, **secret-free** configuration of the SMTP transport.
 *
 * There is no field here a password could occupy.
 */
export const SmtpRuntimeConfig = z
  .strictObject({
    host: z.string().min(1).max(253).regex(/^[A-Za-z0-9.:-]+$/, "must be a hostname"),
    port: z.number().int().min(1).max(65_535),
    secure: z.boolean(),
    requireTls: z.boolean(),
    /** The Workspace mailbox that authenticates. Not a secret, but required. */
    username: z.string().min(1).max(320).regex(/^[^\s]+$/, "must be one token"),
    /** The NAME of the variable holding the password. Never the password. */
    passwordEnvVar: z.string().regex(ENV_VAR_NAME_RE, "must be an environment variable name"),
    /**
     * The sender. A deployment fact and never a request parameter — a caller that
     * could name the From address could send as Monacado.
     */
    fromAddress: AccountEmail,
    /** A display name bound into the From header, so no line breaks or quoting. */
    fromName: z.string().min(1).max(64).regex(/^[^\r\n"<>]+$/, "must be a plain display name"),
    replyTo: AccountEmail.nullable(),
    connectionTimeoutMs: SmtpTimeoutMs,
    socketTimeoutMs: SmtpTimeoutMs,
    sendTimeoutMs: SmtpTimeoutMs,
  })
  .refine((c) => c.secure || c.requireTls || isLoopbackSmtpHost(c.host), {
    path: ["requireTls"],
    message: "plaintext SMTP is permitted only to a loopback host",
  });
export type SmtpRuntimeConfig = z.infer<typeof SmtpRuntimeConfig>;

const envText = (raw: string | undefined): string => (raw ?? "").trim();

/** Unset takes the default. Anything unrecognised is passed on for the schema to refuse. */
function envBoolean(raw: string | undefined, fallback: boolean): boolean | string {
  const value = envText(raw).toLowerCase();
  if (value === "") return fallback;
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return value;
}

function envInteger(raw: string | undefined, fallback: number): number {
  const value = envText(raw);
  if (value === "") return fallback;
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

/**
 * Read the SMTP block, or refuse with every variable at fault at once.
 *
 * Called only when `SMTP` is the selected transport, and at send time rather
 * than at import, so a deployment using another adapter is never asked for a
 * mailbox it does not have. The error names variables and never their values.
 */
export function readSmtpRuntimeConfig(env: Env = process.env): SmtpRuntimeConfig {
  const port = envInteger(env.MONACADO_SMTP_PORT, DEFAULT_SMTP_PORT);
  const replyTo = envText(env.MONACADO_MAIL_REPLY_TO);
  const parsed = SmtpRuntimeConfig.safeParse({
    host: envText(env.MONACADO_SMTP_HOST),
    port,
    /* Port 465 speaks TLS from the first byte; defaulting `secure` from it spares
       the one misconfiguration that otherwise just hangs until the timeout. */
    secure: envBoolean(env.MONACADO_SMTP_SECURE, port === IMPLICIT_TLS_SMTP_PORT),
    requireTls: envBoolean(env.MONACADO_SMTP_REQUIRE_TLS, true),
    username: envText(env.MONACADO_SMTP_USERNAME),
    passwordEnvVar: envText(env.MONACADO_SMTP_PASSWORD_ENV) || DEFAULT_SMTP_PASSWORD_ENV,
    fromAddress: envText(env.MONACADO_MAIL_FROM_ADDRESS),
    fromName: envText(env.MONACADO_MAIL_FROM_NAME) || DEFAULT_MAIL_FROM_NAME,
    replyTo: replyTo === "" ? null : replyTo,
    connectionTimeoutMs: envInteger(
      env.MONACADO_SMTP_CONNECTION_TIMEOUT_MS,
      SMTP_TIMEOUT_DEFAULTS_MS.connection,
    ),
    socketTimeoutMs: envInteger(env.MONACADO_SMTP_SOCKET_TIMEOUT_MS, SMTP_TIMEOUT_DEFAULTS_MS.socket),
    sendTimeoutMs: envInteger(env.MONACADO_SMTP_SEND_TIMEOUT_MS, SMTP_TIMEOUT_DEFAULTS_MS.send),
  });
  if (!parsed.success) {
    throw new MailConfigurationError(
      Array.from(
        new Set(parsed.error.issues.map((i) => SMTP_FIELD_ENV[String(i.path[0])] ?? "(root)")),
      ),
    );
  }
  return parsed.data;
}

/**
 * Resolve the SMTP password.
 *
 * **The one place it is read**, handed straight to the transport options and
 * stored in nothing else. The error names the variable and never any part of the
 * value, and a placeholder copied from an example file is refused as unset.
 */
export function resolveSmtpPassword(config: SmtpRuntimeConfig, env: Env = process.env): string {
  const password = (env[config.passwordEnvVar] ?? "").trim();
  if (password === "" || PLACEHOLDER_SMTP_PASSWORDS.has(password.toLowerCase())) {
    throw new MailConfigurationError([`${config.passwordEnvVar} is not set`]);
  }
  return password;
}
