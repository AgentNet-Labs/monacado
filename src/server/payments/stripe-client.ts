/**
 * The Stripe SDK client (Phase 1.0) — SERVER ONLY.
 *
 * The **only** module in the repository that imports the Stripe SDK and reads a
 * Stripe credential. Everything else speaks through the provider-neutral ports in
 * `src/contracts/marketplace/buyer-payment.ts` and
 * `src/contracts/marketplace/payment-account.ts`, so the blast radius of changing
 * provider is this file plus the two adapters beside it.
 *
 * **Nothing runs on import.** The client is constructed on first use and memoised
 * per resolved API key, so importing a route module never reads a secret, never
 * opens a socket, and never fails because a deployment has not configured Stripe.
 *
 * The API version is **pinned**. Letting the SDK follow the account's dashboard
 * version would mean a Stripe-side setting could silently change the shape of a
 * webhook Monacado parses, which is a production incident nobody deployed.
 */

import "../server-only";
import Stripe from "stripe";
import {
  readStripeRuntimeConfig,
  resolveStripeApiKey,
  type Env,
  type StripeRuntimeConfig,
} from "./stripe-runtime-config";

/**
 * The Stripe API version this repository's code was written against.
 *
 * Pinned deliberately, and bumped only alongside a review of the webhook and
 * Checkout Session shapes this phase depends on.
 */
export const STRIPE_API_VERSION = "2026-07-29.dahlia" satisfies Stripe.LatestApiVersion;

/** Identifies Monacado in Stripe's request logs. Carries no secret. */
const APP_INFO: Stripe.AppInfo = { name: "Monacado", version: "1.0" };

const clients = new Map<string, Stripe>();

/**
 * A Stripe client for the resolved test-mode key.
 *
 * Memoised by key rather than globally, so a test that supplies a different
 * environment gets a different client instead of whichever one happened to be
 * constructed first.
 */
export function getStripeClient(config: StripeRuntimeConfig, env: Env = process.env): Stripe {
  const apiKey = resolveStripeApiKey(config, env);
  const existing = clients.get(apiKey);
  if (existing !== undefined) return existing;

  const client = new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: APP_INFO,
    /* Bounded and finite. An unbounded retry against a payment API is how one
       buyer intent becomes several; the idempotency key on every mutating call
       is what makes even these retries safe. */
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  clients.set(apiKey, client);
  return client;
}

/** Configuration and client together, resolved from the environment. */
export interface StripeRuntime {
  config: StripeRuntimeConfig;
  client: Stripe;
}

export function getStripeRuntime(env: Env = process.env): StripeRuntime {
  const config = readStripeRuntimeConfig(env);
  return { config, client: getStripeClient(config, env) };
}
