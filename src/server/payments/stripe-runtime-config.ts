/**
 * Stripe runtime configuration (Phase 1.0) — SERVER ONLY.
 *
 * The boundary between deployment configuration and the Stripe adapters. It
 * answers four questions and nothing else: is Stripe enabled, which **mode** are
 * we in, where do the secrets live, and where does a buyer come back to.
 *
 * Three properties, following `registrar-runtime-config.ts` deliberately rather
 * than inventing a second convention:
 *
 *   1. **No secret value ever enters the parsed configuration object.** The
 *      configuration stores the *names* of the variables holding the API key and
 *      the webhook signing secret, never the values. Anything that logs or
 *      serialises this object is therefore safe by construction rather than by
 *      discipline.
 *
 *   2. **Disabled by default, and TEST MODE ONLY.** There are no production
 *      defaults, and `resolveStripeApiKey` refuses any key that is not
 *      `sk_test_`-prefixed. Live mode is not a configuration value this phase can
 *      express: `STRIPE_MODE` has exactly one permitted member. Reaching live
 *      payments requires editing this file in the open, which is the point.
 *
 *   3. **Nothing is read at import time.** Configuration is resolved when a
 *      request needs it, so importing a module never touches `process.env`, and a
 *      test can drive every branch by passing an environment in.
 *
 * No network call and no Stripe SDK import happens here.
 */

import "../server-only";
import { z } from "zod";
import { CountryCode } from "../../contracts/marketplace/order-buyer-snapshot";

/**
 * The starter shipping allow-list.
 *
 * Narrow on purpose. A deployment that ships further sets
 * `MONACADO_STRIPE_SHIPPING_COUNTRIES`; one that has not thought about it should
 * not be silently offering worldwide delivery.
 */
export const DEFAULT_SHIPPING_COUNTRIES = ["US", "CA", "GB", "IE", "AU", "NZ"] as const;

/** Environment variable names: conventional, and never a value. */
export const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * The one mode this phase supports.
 *
 * A single-member enum rather than a boolean, so that adding `LIVE` later is a
 * deliberate, reviewable, greppable edit rather than flipping a flag someone set
 * in a dashboard. An unrecognised value is a refusal, never a fallback.
 */
export const STRIPE_MODES = ["TEST"] as const;
export const StripeMode = z.enum(STRIPE_MODES);
export type StripeMode = z.infer<typeof StripeMode>;

/** The API key prefix a test-mode secret key must have. */
export const TEST_SECRET_KEY_PREFIX = "sk_test_";
/** Prefixes that identify a LIVE credential, which this phase refuses outright. */
export const LIVE_CREDENTIAL_PREFIXES: readonly string[] = ["sk_live_", "rk_live_", "pk_live_"];

/**
 * A return URL Monacado sends the buyer back to.
 *
 * Absolute, and `https:` except against a loopback host — the same carve-out
 * `registrar-runtime-config.ts` makes, for the same reason and with the same
 * explicit flag, so "we used http" is a decision somebody wrote down rather than
 * an accident of which host was configured.
 */
function isAcceptableReturnUrl(value: string, allowLoopbackHttp: boolean): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.hash !== "") return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return (
    allowLoopbackHttp &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]")
  );
}

/**
 * The validated, **secret-free** configuration of an ENABLED Stripe integration.
 *
 * `apiKeyEnvVar` and `webhookSecretEnvVar` are variable NAMES. Resolving either
 * to a value happens only in `resolveStripeApiKey` / `resolveStripeWebhookSecret`,
 * only at the moment a request is about to be made or verified.
 */
export const StripeRuntimeConfig = z.strictObject({
  mode: StripeMode,
  /** The NAME of the variable holding the secret API key. Never the key. */
  apiKeyEnvVar: z.string().regex(ENV_VAR_NAME_RE, "must be an environment variable name"),
  /** The NAME of the variable holding the webhook signing secret. Never it. */
  webhookSecretEnvVar: z.string().regex(ENV_VAR_NAME_RE, "must be an environment variable name"),
  /** Where Stripe returns a buyer after a completed attempt. */
  successUrl: z.string().min(1).max(2_048),
  /** Where Stripe returns a buyer who abandoned the attempt. */
  cancelUrl: z.string().min(1).max(2_048),
  /**
   * Countries Stripe may collect a shipping address for.
   *
   * Stripe requires an explicit allow-list — there is no "anywhere" value — so
   * this is **configuration, and a deployment decision**, exactly like the
   * commercial and risk policies. It is not derived from the buyer's own input:
   * a list that widened itself to whatever a client typed would be no list.
   *
   * The default is a small starter set, deliberately narrow rather than
   * speculatively broad. Widening it is one environment variable.
   */
  shippingCountries: z.array(CountryCode).min(1).max(250),
  /**
   * Permits plain `http:` return URLs to a loopback host. LOCAL ONLY — a
   * deployment reachable by a real buyer must use HTTPS.
   */
  allowLoopbackHttp: z.boolean(),
});
export type StripeRuntimeConfig = z.infer<typeof StripeRuntimeConfig>;

// — Errors —

export class StripeConfigurationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Stripe configuration is invalid: ${issues.join(", ")}`);
    this.name = "StripeConfigurationError";
    this.issues = issues;
  }
}

export class StripeDisabledError extends Error {
  constructor() {
    super("Stripe is not enabled in this environment");
    this.name = "StripeDisabledError";
  }
}

/**
 * A credential was missing, or was not a test-mode credential.
 *
 * The message never echoes the value, and never echoes enough of it to narrow a
 * search — a configuration error about a secret is exactly the log line a secret
 * ends up in.
 */
export class StripeCredentialError extends Error {
  readonly reason: "MISSING" | "NOT_TEST_MODE";
  constructor(reason: "MISSING" | "NOT_TEST_MODE", envVar: string) {
    super(
      reason === "MISSING"
        ? `Stripe credential is not set: ${envVar}`
        : `Stripe credential in ${envVar} is not a test-mode credential; this phase supports Stripe test mode only`,
    );
    this.name = "StripeCredentialError";
    this.reason = reason;
  }
}

// — Reading the environment —

export type Env = Record<string, string | undefined>;

const TRUTHY = new Set(["true", "1", "yes"]);

/** The master switch. Anything other than true/1/yes means disabled. */
export function isStripeEnabled(env: Env = process.env): boolean {
  const raw = env.MONACADO_STRIPE_ENABLED;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Parse the Stripe block, or refuse with every issue at once.
 *
 * Throws `StripeDisabledError` when the master switch is off — a caller must
 * decide what an unconfigured deployment does rather than receiving a
 * half-populated object that looks usable.
 */
export function readStripeRuntimeConfig(env: Env = process.env): StripeRuntimeConfig {
  if (!isStripeEnabled(env)) throw new StripeDisabledError();

  const allowLoopbackHttp =
    env.MONACADO_STRIPE_ALLOW_LOOPBACK_HTTP !== undefined &&
    TRUTHY.has(env.MONACADO_STRIPE_ALLOW_LOOPBACK_HTTP.trim().toLowerCase());

  const shippingCountries = (env.MONACADO_STRIPE_SHIPPING_COUNTRIES ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c !== "");

  const candidate = {
    mode: env.MONACADO_STRIPE_MODE ?? "TEST",
    shippingCountries:
      shippingCountries.length === 0 ? [...DEFAULT_SHIPPING_COUNTRIES] : shippingCountries,
    apiKeyEnvVar: env.MONACADO_STRIPE_API_KEY_ENV ?? "MONACADO_STRIPE_SECRET_KEY",
    webhookSecretEnvVar:
      env.MONACADO_STRIPE_WEBHOOK_SECRET_ENV ?? "MONACADO_STRIPE_WEBHOOK_SECRET",
    successUrl: env.MONACADO_STRIPE_SUCCESS_URL ?? "",
    cancelUrl: env.MONACADO_STRIPE_CANCEL_URL ?? "",
    allowLoopbackHttp,
  };

  const parsed = StripeRuntimeConfig.safeParse(candidate);
  if (!parsed.success) {
    throw new StripeConfigurationError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }

  const issues: string[] = [];
  if (!isAcceptableReturnUrl(parsed.data.successUrl, allowLoopbackHttp)) issues.push("successUrl");
  if (!isAcceptableReturnUrl(parsed.data.cancelUrl, allowLoopbackHttp)) issues.push("cancelUrl");
  if (issues.length > 0) throw new StripeConfigurationError(issues);

  return parsed.data;
}

/**
 * Resolve the secret API key, and **refuse anything that is not test mode**.
 *
 * The one place a Stripe secret is read. It is returned to the immediate caller
 * (the SDK constructor) and stored in no object that anything else can reach or
 * serialise.
 *
 * The live-prefix check is not decoration: pointing a `MONACADO_STRIPE_MODE=TEST`
 * deployment at `sk_live_…` is precisely how a "test" environment charges a real
 * card, and the mode label alone would not have caught it.
 */
export function resolveStripeApiKey(config: StripeRuntimeConfig, env: Env = process.env): string {
  return resolveTestModeSecretKey(config.apiKeyEnvVar, env);
}

/**
 * Resolve a Stripe secret key by variable name, refusing anything not test mode.
 *
 * The **one** implementation of that refusal, extracted in Phase 1.6 so Stripe
 * Tax reaches the same account through the same door. A tax integration with its
 * own credential reader would be a second place the live-prefix check could be
 * forgotten, and forgetting it there charges real cards just as surely.
 */
export function resolveTestModeSecretKey(apiKeyEnvVar: string, env: Env = process.env): string {
  const raw = env[apiKeyEnvVar];
  if (raw === undefined || raw.trim() === "") {
    throw new StripeCredentialError("MISSING", apiKeyEnvVar);
  }
  const key = raw.trim();
  if (LIVE_CREDENTIAL_PREFIXES.some((p) => key.startsWith(p))) {
    throw new StripeCredentialError("NOT_TEST_MODE", apiKeyEnvVar);
  }
  if (!key.startsWith(TEST_SECRET_KEY_PREFIX)) {
    throw new StripeCredentialError("NOT_TEST_MODE", apiKeyEnvVar);
  }
  return key;
}

/**
 * Resolve the webhook signing secret.
 *
 * Read only inside signature verification. There is no mode check here because
 * Stripe's signing secrets carry no mode marker — the API key is where test mode
 * is enforced, and a webhook from a live account cannot verify against a test
 * endpoint's secret anyway.
 */
export function resolveStripeWebhookSecret(
  config: StripeRuntimeConfig,
  env: Env = process.env,
): string {
  const raw = env[config.webhookSecretEnvVar];
  if (raw === undefined || raw.trim() === "") {
    throw new StripeCredentialError("MISSING", config.webhookSecretEnvVar);
  }
  return raw.trim();
}
