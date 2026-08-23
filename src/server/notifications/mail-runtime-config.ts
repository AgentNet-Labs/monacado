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
 */
export const MAIL_TRANSPORTS = ["LOG", "CAPTURE", "POSTMARK"] as const;
export type MailTransport = (typeof MAIL_TRANSPORTS)[number];

/** What a delivery row records as having answered. */
export const MAIL_PROVIDERS = ["DISABLED", "LOG", "CAPTURE", "POSTMARK"] as const;
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
