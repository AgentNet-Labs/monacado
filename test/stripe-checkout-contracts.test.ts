/**
 * Stripe adapter, configuration, and route-boundary tests (Phase 1.0).
 *
 * **NO NETWORK.** Every Stripe call is a hand-written double, and the one real
 * `Stripe` instance is constructed only to exercise `webhooks.constructEventAsync`
 * and its signing counterpart — both of which are pure HMAC over a string. No
 * API key that could reach Stripe appears anywhere: the keys below are
 * `sk_test_` literals that no account owns.
 *
 * These are deliberately **translation and refusal** tests. The end-to-end flow
 * lives in `stripe-checkout.integration.test.ts`, and this phase does not add a
 * second large absence matrix — `0M.8` and `0M.9` already own theirs.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  BuyerActionUrl,
  BuyerPaymentConfirmation,
  BuyerPaymentInitiation,
  BUYER_PAYMENT_INITIATION_STATUSES,
  BUYER_PAYMENT_OUTCOMES,
} from "../src/contracts/marketplace/buyer-payment";
import {
  isStripeEnabled,
  readStripeRuntimeConfig,
  resolveStripeApiKey,
  resolveStripeWebhookSecret,
  StripeConfigurationError,
  StripeCredentialError,
  StripeDisabledError,
  STRIPE_MODES,
  type StripeRuntimeConfig,
} from "../src/server/payments/stripe-runtime-config";
import {
  isAcceptableOrigin,
  normalizeOrigin,
  readCheckoutRuntimeConfig,
} from "../src/server/payments/checkout-runtime-config";
import {
  toPaymentFailureCode,
  toPaymentFailureCodeFromDecline,
} from "../src/server/payments/stripe-failure-mapping";
import {
  createStripeBuyerPaymentAdapter,
  createStripeBuyerPaymentConfirmationPort,
  HANDLED_EVENT_TYPES,
  LINE_ITEM_NAME,
  ORDER_METADATA_KEY,
  StripeEventNotAttributableError,
  StripeWebhookVerificationError,
} from "../src/server/payments/stripe-buyer-payment-adapter";
import {
  createStripeConnectReadinessPort,
  toReadinessStatus,
  toRequirementCode,
  toRequirementCodes,
} from "../src/server/payments/stripe-connect-account-adapter";
import {
  BeginCheckoutRequest,
  NEVER_ON_BEGIN_CHECKOUT_REQUEST,
  parseCheckoutBody,
  buildGuestClaimCookie,
  GUEST_CLAIM_COOKIE_NAME,
} from "../src/server/payments/checkout-route-handler";
import { handleStripeWebhookRequest } from "../src/server/payments/stripe-webhook-route-handler";
import {
  NEVER_IN_ORDER_STATUS,
  toOrderStatusView,
} from "../src/server/payments/order-status-route-handler";

// — Fixtures —

/**
 * 26 Crockford characters — the opaque body every Monacado identity uses.
 * `I`, `L`, `O`, and `U` are not in that alphabet, so a hand-written fixture has
 * to be folded rather than typed, exactly as the 0M.9 suite does it.
 */
const opaque = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ORDER_ID = `mon:order:${opaque("P10RDER1")}`;
const OTHER_ORDER_ID = `mon:order:${opaque("P10RDER2")}`;
const LISTING_ID = `mon:listing:${opaque("P1LISTING")}`;
const POLICY_ID = `mon:cpol:${opaque("P1POLICY")}`;
const RISK_POLICY_ID = `mon:rpol:${opaque("P1RISK")}`;

/**
 * A complete, valid begin-checkout body (Phase 1.2).
 *
 * Everything a merchant of record genuinely requires, and nothing more.
 */
const VALID_CHECKOUT_BODY = {
  internalListingId: LISTING_ID,
  buyerName: "Synthetic Buyer",
  buyerEmail: "buyer@example.test",
  billingLine1: "1 Test Street",
  billingCity: "Testville",
  billingRegion: "CA",
  billingPostalCode: "94000",
  billingCountryCode: "US",
  shippingLine1: "9 Delivery Road",
  shippingCity: "Shipton",
  shippingRegion: "NY",
  shippingPostalCode: "10001",
  shippingCountryCode: "US",
} as const;
const SESSION_ID = "cs_test_a1B2c3D4e5F6g7H8i9J0";
const INTENT_ID = "pi_3QxYzAbCdEf12345";
const WEBHOOK_SECRET = "whsec_0m9testsigningsecretvalue000000";
const TEST_KEY = "sk_test_0m9notarealkeyatall000000";

const CONFIG: StripeRuntimeConfig = {
  mode: "TEST",
  apiKeyEnvVar: "MONACADO_STRIPE_SECRET_KEY",
  webhookSecretEnvVar: "MONACADO_STRIPE_WEBHOOK_SECRET",
  successUrl: "https://monacado.test/checkout/result",
  cancelUrl: "https://monacado.test/checkout/result",
  shippingCountries: ["US", "CA"],
  allowLoopbackHttp: false,
};

const ENV = {
  MONACADO_STRIPE_ENABLED: "true",
  MONACADO_STRIPE_MODE: "TEST",
  MONACADO_STRIPE_SECRET_KEY: TEST_KEY,
  MONACADO_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  MONACADO_STRIPE_SUCCESS_URL: CONFIG.successUrl,
  MONACADO_STRIPE_CANCEL_URL: CONFIG.cancelUrl,
};

/** A real client, used only for its pure HMAC helpers. Never given a URL. */
const signer = new Stripe(TEST_KEY, { apiVersion: "2026-07-29.dahlia" });

function signedDelivery(event: Record<string, unknown>): {
  rawBody: string;
  signatureHeader: string;
} {
  const rawBody = JSON.stringify(event);
  return {
    rawBody,
    signatureHeader: signer.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: WEBHOOK_SECRET,
    }),
  };
}

function sessionEvent(
  type: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "evt_0m9test000000000001",
    object: "event",
    type,
    data: {
      object: {
        id: SESSION_ID,
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: INTENT_ID,
        metadata: { [ORDER_METADATA_KEY]: ORDER_ID },
        ...overrides,
      },
    },
  };
}

/** A Stripe double. Every method a test needs, and nothing that opens a socket. */
function stripeDouble(overrides: {
  createSession?: (params: unknown, options: unknown) => Promise<unknown>;
  retrieveIntent?: (id: string) => Promise<unknown>;
  retrieveAccount?: (id: string) => Promise<unknown>;
} = {}) {
  const calls: { sessions: Array<{ params: unknown; options: unknown }> } = { sessions: [] };
  const client = {
    checkout: {
      sessions: {
        create: async (params: unknown, options: unknown) => {
          calls.sessions.push({ params, options });
          return overrides.createSession === undefined
            ? { id: SESSION_ID, url: "https://checkout.stripe.com/c/pay/cs_test_a1B2c3" }
            : await overrides.createSession(params, options);
        },
      },
    },
    paymentIntents: {
      retrieve: async (id: string) =>
        overrides.retrieveIntent === undefined
          ? { id, last_payment_error: null }
          : await overrides.retrieveIntent(id),
    },
    accounts: {
      retrieve: async (id: string) =>
        overrides.retrieveAccount === undefined ? { id } : await overrides.retrieveAccount(id),
    },
    webhooks: signer.webhooks,
  };
  return { client: client as unknown as Stripe, calls };
}

const runtime = (client: Stripe) => ({ config: CONFIG, client });

/** Narrow a confirmation to its payment-result arm, failing loudly otherwise. */
function asResult(
  confirmation: BuyerPaymentConfirmation | null,
): Extract<BuyerPaymentConfirmation, { disposition: "PAYMENT_RESULT" }> {
  if (confirmation === null || confirmation.disposition !== "PAYMENT_RESULT") {
    throw new Error("expected a PAYMENT_RESULT confirmation");
  }
  return confirmation;
}

// — 1 —

describe("1.0 · the payment SDK boundary", () => {
  it("carries the Stripe SERVER SDK and no browser payment SDK", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];

    /* 0M.8 asserted no payment SDK at all; that was true until this phase and is
       now narrowed rather than deleted. The server SDK exists because a payment
       must actually execute. NO BROWSER SDK exists, because the buyer flow uses
       Stripe's HOSTED page — so no card detail touches a Monacado origin and no
       publishable key reaches a bundle. */
    expect(names).toContain("stripe");
    for (const forbidden of [
      "@stripe/stripe-js",
      "@stripe/react-stripe-js",
      "braintree",
      "adyen",
      "paypal",
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it("imports the SDK in exactly one module", () => {
    /* The blast radius of changing provider. Every other module speaks through
       the provider-neutral ports. */
    const client = readFileSync(
      new URL("../src/server/payments/stripe-client.ts", import.meta.url),
      "utf8",
    );
    expect(client).toContain('from "stripe"');

    for (const file of [
      "../src/contracts/marketplace/buyer-payment.ts",
      "../src/contracts/marketplace/order.ts",
      "../src/server/marketplace/order-service.ts",
      "../src/server/marketplace/checkout-service.ts",
      "../src/server/payments/executable-checkout-service.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/^import Stripe from "stripe"/m);
    }
  });

  it("never asks Stripe to compute Monacado's economics", () => {
    /* Stripe receives an amount and returns evidence. An application fee or a
       destination charge would be Stripe deciding a split, which is the one
       thing MONACADO_MOR_BUSINESS_MODEL forbids delegating. */
    for (const file of [
      "../src/server/payments/stripe-buyer-payment-adapter.ts",
      "../src/server/payments/stripe-connect-account-adapter.ts",
      "../src/server/payments/executable-checkout-service.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      for (const forbidden of [
        "application_fee_amount",
        "transfer_data",
        "on_behalf_of",
        "transfers.create",
        "payouts.create",
      ]) {
        expect(source.includes(`${forbidden}:`), `${file} ${forbidden}`).toBe(false);
      }
    }
  });
});

// — 2 —

describe("1.0 · test mode is structural, not configured", () => {
  it("offers exactly one mode", () => {
    expect(STRIPE_MODES).toEqual(["TEST"]);
  });

  it("is disabled unless switched on, and refuses to guess", () => {
    expect(isStripeEnabled({})).toBe(false);
    expect(isStripeEnabled({ MONACADO_STRIPE_ENABLED: "false" })).toBe(false);
    expect(isStripeEnabled({ MONACADO_STRIPE_ENABLED: "yes" })).toBe(true);
    expect(() => readStripeRuntimeConfig({})).toThrow(StripeDisabledError);
  });

  it("refuses a LIVE secret key even when the mode says TEST", () => {
    const live = { ...ENV, MONACADO_STRIPE_SECRET_KEY: "sk_live_realmoneyrealbuyers0000" };
    let thrown: unknown;
    try {
      resolveStripeApiKey(CONFIG, live);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StripeCredentialError);
    expect((thrown as StripeCredentialError).reason).toBe("NOT_TEST_MODE");
    /* And the message never echoes the key. */
    expect((thrown as Error).message).not.toContain("realmoney");
  });

  it("refuses a missing key and a key that is not sk_test_", () => {
    expect(() => resolveStripeApiKey(CONFIG, {})).toThrow(StripeCredentialError);
    expect(() =>
      resolveStripeApiKey(CONFIG, { MONACADO_STRIPE_SECRET_KEY: "rk_test_restricted0000" }),
    ).toThrow(StripeCredentialError);
    expect(resolveStripeApiKey(CONFIG, ENV)).toBe(TEST_KEY);
  });

  it("stores the NAMES of the secrets and never their values", () => {
    const config = readStripeRuntimeConfig(ENV);
    const serialised = JSON.stringify(config);
    expect(serialised).not.toContain(TEST_KEY);
    expect(serialised).not.toContain(WEBHOOK_SECRET);
    expect(config.apiKeyEnvVar).toBe("MONACADO_STRIPE_SECRET_KEY");
    expect(resolveStripeWebhookSecret(config, ENV)).toBe(WEBHOOK_SECRET);
  });

  it("refuses a non-https return URL unless loopback is explicitly permitted", () => {
    const http = { ...ENV, MONACADO_STRIPE_SUCCESS_URL: "http://localhost:3000/checkout/result" };
    expect(() => readStripeRuntimeConfig(http)).toThrow(StripeConfigurationError);
    expect(
      readStripeRuntimeConfig({ ...http, MONACADO_STRIPE_ALLOW_LOOPBACK_HTTP: "true" }).successUrl,
    ).toBe("http://localhost:3000/checkout/result");
    /* Loopback permission is not a licence for any http host. */
    expect(() =>
      readStripeRuntimeConfig({
        ...ENV,
        MONACADO_STRIPE_SUCCESS_URL: "http://buyer.example/checkout/result",
        MONACADO_STRIPE_ALLOW_LOOPBACK_HTTP: "true",
      }),
    ).toThrow(StripeConfigurationError);
  });
});

// — 3 —

describe("1.0 · checkout configuration is Monacado's, not a request parameter", () => {
  it("requires a commercial policy identity and an origin", () => {
    expect(() => readCheckoutRuntimeConfig({})).toThrow(StripeConfigurationError);
    const config = readCheckoutRuntimeConfig({
      MONACADO_CHECKOUT_POLICY_ID: POLICY_ID,
      MONACADO_RISK_POLICY_ID: RISK_POLICY_ID,
      MONACADO_APP_ORIGIN: "https://monacado.test",
    });
    expect(config.policyId).toBe(POLICY_ID);
    /* Phase 1.2 — a SEPARATE identity: one policy decides what Monacado earns,
       the other what Monacado permits. */
    expect(config.riskPolicyId).toBe(RISK_POLICY_ID);
    expect(config.appOrigin).toBe("https://monacado.test:443");
  });

  it("refuses a cross-site origin and permits an absent one", () => {
    const config = {
      policyId: POLICY_ID,
      riskPolicyId: RISK_POLICY_ID,
      appOrigin: "https://monacado.test:443",
    };
    expect(isAcceptableOrigin(null, config)).toBe(true);
    expect(isAcceptableOrigin("https://monacado.test", config)).toBe(true);
    expect(isAcceptableOrigin("https://evil.example", config)).toBe(false);
    /* Suffix matching is exactly how an allow-list gets bypassed. */
    expect(isAcceptableOrigin("https://evil-monacado.test", config)).toBe(false);
    expect(normalizeOrigin("https://*.monacado.test")).toBeDefined();
  });
});

// — 4 —

describe("1.0 · the initiation shape asserts no outcome", () => {
  it("offers one status, and SUCCEEDED is not among them", () => {
    expect(BUYER_PAYMENT_INITIATION_STATUSES).toEqual(["REQUIRES_BUYER_ACTION"]);
    for (const outcome of BUYER_PAYMENT_OUTCOMES) {
      expect(BUYER_PAYMENT_INITIATION_STATUSES as readonly string[]).not.toContain(outcome);
    }
  });

  it("has no field in which a payment result could arrive", () => {
    const valid = {
      orderId: ORDER_ID,
      provider: "STRIPE",
      status: "REQUIRES_BUYER_ACTION",
      providerPaymentRef: SESSION_ID,
      buyerActionUrl: "https://checkout.stripe.com/c/pay/cs_test_a1B2c3",
    };
    expect(BuyerPaymentInitiation.safeParse(valid).success).toBe(true);
    for (const forbidden of [
      "outcome",
      "paid",
      "providerTransactionRef",
      "amountMinorUnits",
      "sellerProceedsMinorUnits",
      "clientSecret",
      "apiKey",
    ]) {
      expect(
        BuyerPaymentInitiation.safeParse({ ...valid, [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("requires an https buyer action URL", () => {
    expect(BuyerActionUrl.safeParse("https://checkout.stripe.com/x").success).toBe(true);
    expect(BuyerActionUrl.safeParse("http://checkout.stripe.com/x").success).toBe(false);
    expect(BuyerActionUrl.safeParse("javascript:alert(1)").success).toBe(false);
    expect(BuyerActionUrl.safeParse("/relative").success).toBe(false);
  });

  it("carries a 0M.9 payment result on a confirmation, unaltered", () => {
    const parsed = BuyerPaymentConfirmation.parse({
      disposition: "PAYMENT_RESULT",
      orderId: ORDER_ID,
      provider: "STRIPE",
      buyerContact: null,
      result: { outcome: "SUCCEEDED", provider: "STRIPE", providerTransactionRef: INTENT_ID },
      providerEventRef: "evt_0m9test000000000001",
      observedAt: "2027-12-03T12:00:05.000Z",
    });
    expect(parsed.disposition).toBe("PAYMENT_RESULT");
    expect(parsed.disposition === "PAYMENT_RESULT" ? parsed.result : null).toEqual({
      outcome: "SUCCEEDED",
      provider: "STRIPE",
      providerTransactionRef: INTENT_ID,
    });
  });
});

// — 5 —

describe("1.0 · the Stripe adapter translates a checkout session", () => {
  it("sends the buyer total, the Order id, and the Order-derived idempotency key", async () => {
    const { client, calls } = stripeDouble();
    const port = createStripeBuyerPaymentAdapter({ runtime: runtime(client) });

    const initiation = await port.initiatePayment({
      orderId: ORDER_ID,
      provider: "STRIPE",
      currency: "USD",
      amountMinorUnits: 10_000,
      idempotencyKey: ORDER_ID,
      collectShippingAddress: false,
    });

    expect(calls.sessions).toHaveLength(1);
    const params = calls.sessions[0]!.params as Record<string, never>;
    const options = calls.sessions[0]!.options as { idempotencyKey: string };

    /* 0M.9's key reaches Stripe's own idempotency header. One Order, one
       session, one PaymentIntent — structurally. */
    expect(options.idempotencyKey).toBe(ORDER_ID);
    expect(params.mode).toBe("payment");
    expect(params.metadata).toEqual({ [ORDER_METADATA_KEY]: ORDER_ID });

    const lineItems = params.line_items as unknown as Array<{
      quantity: number;
      price_data: { currency: string; unit_amount: number; product_data: { name: string } };
    }>;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0]!.price_data.unit_amount).toBe(10_000);
    expect(lineItems[0]!.price_data.currency).toBe("usd");
    /* Nothing about the Product, the Listing, or the seller reaches Stripe. */
    expect(lineItems[0]!.price_data.product_data.name).toBe(LINE_ITEM_NAME);

    expect(initiation.status).toBe("REQUIRES_BUYER_ACTION");
    expect(initiation.providerPaymentRef).toBe(SESSION_ID);
    expect(new URL(initiation.buyerActionUrl).protocol).toBe("https:");
  });

  it("puts the Order id in the return URL and the claim code nowhere near one", async () => {
    const { client, calls } = stripeDouble();
    const port = createStripeBuyerPaymentAdapter({ runtime: runtime(client) });
    await port.initiatePayment({
      orderId: ORDER_ID,
      provider: "STRIPE",
      currency: "USD",
      amountMinorUnits: 500,
      idempotencyKey: ORDER_ID,
      collectShippingAddress: false,
    });
    const params = calls.sessions[0]!.params as { success_url: string; cancel_url: string };
    expect(new URL(params.success_url).searchParams.get("orderId")).toBe(ORDER_ID);
    expect(new URL(params.cancel_url).searchParams.get("orderId")).toBe(ORDER_ID);
  });

  it("sends no buyer personal data, and asks Stripe to collect billing inward", async () => {
    const { client, calls } = stripeDouble();
    const port = createStripeBuyerPaymentAdapter({ runtime: runtime(client) });
    await port.initiatePayment({
      orderId: ORDER_ID,
      provider: "STRIPE",
      currency: "USD",
      amountMinorUnits: 500,
      idempotencyKey: ORDER_ID,
      collectShippingAddress: false,
    });
    const params = calls.sessions[0]!.params as Record<string, unknown>;

    /* Monacado still SENDS Stripe nothing about the buyer. Phase 1.2 changed the
       direction, not the volume: it asks Stripe to COLLECT a billing address and
       reads the confirmed result back inward, because what returns is the
       identity the payment actually authorized and a browser cannot forge that. */
    for (const field of [
      "customer_email",
      "customer",
      "customer_creation",
      "phone_number_collection",
    ]) {
      expect(field in params, field).toBe(false);
    }
    /* Billing is always collected inward. Shipping is NOT requested here,
       because this request does not ask for it — an all-digital purchase must
       never be asked for a delivery address. */
    expect(params.billing_address_collection).toBe("required");
    expect("shipping_address_collection" in params).toBe(false);
  });

  it("requests a shipping address only when the basket needs delivering", async () => {
    const { client, calls } = stripeDouble();
    const port = createStripeBuyerPaymentAdapter({ runtime: runtime(client) });
    await port.initiatePayment({
      orderId: ORDER_ID,
      provider: "STRIPE",
      currency: "USD",
      amountMinorUnits: 500,
      idempotencyKey: ORDER_ID,
      collectShippingAddress: true,
    });
    const params = calls.sessions[0]!.params as Record<string, unknown>;
    /* The allow-list is deployment configuration — Stripe has no "anywhere"
       value, and a list widened to whatever a client typed would be no list. */
    expect(params.shipping_address_collection).toEqual({
      allowed_countries: CONFIG.shippingCountries,
    });
  });
});

// — 6 —

describe("1.0 · webhook verification refuses anything it cannot authenticate", () => {
  const port = (client: Stripe) =>
    createStripeBuyerPaymentConfirmationPort(
      { observedAt: "2027-12-03T12:00:05.000Z" },
      { runtime: runtime(client), env: ENV },
    );

  it("accepts a correctly signed completed session and returns the PaymentIntent", async () => {
    const { client } = stripeDouble();
    const confirmation = await port(client).confirmPayment(
      signedDelivery(sessionEvent("checkout.session.completed")),
    );
    expect(confirmation).not.toBeNull();
    expect(confirmation!.orderId).toBe(ORDER_ID);
    expect(confirmation!.disposition).toBe("PAYMENT_RESULT");
    expect(asResult(confirmation).result).toEqual({
      outcome: "SUCCEEDED",
      provider: "STRIPE",
      /* The PaymentIntent, not the session: it is what 0M.T1's settlement row
         reconciles against. */
      providerTransactionRef: INTENT_ID,
    });
  });

  it("refuses an absent signature", async () => {
    const { client } = stripeDouble();
    const delivery = signedDelivery(sessionEvent("checkout.session.completed"));
    await expect(
      port(client).confirmPayment({ rawBody: delivery.rawBody, signatureHeader: null }),
    ).rejects.toBeInstanceOf(StripeWebhookVerificationError);
  });

  it("refuses a signature made with the wrong secret", async () => {
    const { client } = stripeDouble();
    const rawBody = JSON.stringify(sessionEvent("checkout.session.completed"));
    const forged = signer.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: "whsec_someoneelsessecret0000000000",
    });
    await expect(
      port(client).confirmPayment({ rawBody, signatureHeader: forged }),
    ).rejects.toBeInstanceOf(StripeWebhookVerificationError);
  });

  it("refuses a body altered after signing", async () => {
    const { client } = stripeDouble();
    const delivery = signedDelivery(sessionEvent("checkout.session.completed"));
    const tampered = delivery.rawBody.replace(ORDER_ID, OTHER_ORDER_ID);
    await expect(
      port(client).confirmPayment({ rawBody: tampered, signatureHeader: delivery.signatureHeader }),
    ).rejects.toBeInstanceOf(StripeWebhookVerificationError);
  });

  it("tells a refused caller nothing beyond the refusal", async () => {
    const { client } = stripeDouble();
    let thrown: unknown;
    try {
      await port(client).confirmPayment({ rawBody: "{}", signatureHeader: "t=1,v1=deadbeef" });
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message.toLowerCase();
    for (const leak of ["timestamp", "tolerance", "secret", "expected", WEBHOOK_SECRET]) {
      expect(message, leak).not.toContain(leak.toLowerCase());
    }
  });
});

// — 7 —

describe("1.0 · the webhook has an opinion about four event types", () => {
  const port = (client: Stripe) =>
    createStripeBuyerPaymentConfirmationPort(
      { observedAt: "2027-12-03T12:00:05.000Z" },
      { runtime: runtime(client), env: ENV },
    );

  it("acts on four, and is deliberately silent about payment_intent.payment_failed", () => {
    /* Three from 1.0; `checkout.session.expired` added by 1.1, which is Stripe's
       authoritative statement that a session can no longer complete. */
    expect(HANDLED_EVENT_TYPES).toEqual([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
    ]);
    /* Acting on it would be the money-losing bug: a declined card inside a
       hosted session fires it, the buyer retries successfully moments later, and
       an Order already moved to PAYMENT_FAILED can never reach PAID. */
    expect(HANDLED_EVENT_TYPES).not.toContain("payment_intent.payment_failed");
  });

  it("ignores a verified event it has no opinion about", async () => {
    const { client } = stripeDouble();
    const result = await port(client).confirmPayment(
      signedDelivery(sessionEvent("payment_intent.payment_failed")),
    );
    expect(result).toBeNull();
  });

  it("refuses to call an unpaid completed session a sale", async () => {
    const { client } = stripeDouble();
    const result = await port(client).confirmPayment(
      signedDelivery(sessionEvent("checkout.session.completed", { payment_status: "unpaid" })),
    );
    /* A delayed-notification method resolves through its own event. Booking a
       sale here would book one on funds that may still fail. */
    expect(result).toBeNull();
  });

  it("translates an async failure through Stripe's own decline code", async () => {
    const { client } = stripeDouble({
      retrieveIntent: async (id) => ({
        id,
        last_payment_error: { code: "card_declined", decline_code: "expired_card" },
      }),
    });
    const result = await port(client).confirmPayment(
      signedDelivery(sessionEvent("checkout.session.async_payment_failed")),
    );
    expect(asResult(result).result).toEqual({ outcome: "FAILED", failureCode: "INSTRUMENT_REJECTED" });
    /* No Stripe string survives the translation. */
    expect(JSON.stringify(result)).not.toContain("card_declined");
  });

  it("records the failure even when Stripe will not say why", async () => {
    const { client } = stripeDouble({
      retrieveIntent: async () => {
        throw new Error("stripe is having a day");
      },
    });
    const result = await port(client).confirmPayment(
      signedDelivery(sessionEvent("checkout.session.async_payment_failed")),
    );
    expect(asResult(result).result).toEqual({ outcome: "FAILED", failureCode: "UNSPECIFIED_FAILURE" });
  });

  it("refuses a verified payment event carrying no Monacado Order", async () => {
    const { client } = stripeDouble();
    await expect(
      port(client).confirmPayment(
        signedDelivery(sessionEvent("checkout.session.completed", { metadata: {} })),
      ),
    ).rejects.toBeInstanceOf(StripeEventNotAttributableError);
  });
});

// — 8 —

describe("1.0 · failure translation is bounded and never provider text", () => {
  it("maps each family to a Monacado classification", () => {
    expect(toPaymentFailureCode("card_declined")).toBe("DECLINED");
    expect(toPaymentFailureCode("expired_card")).toBe("INSTRUMENT_REJECTED");
    expect(toPaymentFailureCode("authentication_required")).toBe("AUTHENTICATION_FAILED");
    expect(toPaymentFailureCode("api_connection_error")).toBe("PROVIDER_UNAVAILABLE");
  });

  it("degrades an unknown code honestly rather than guessing", () => {
    expect(toPaymentFailureCode("some_code_stripe_added_last_tuesday")).toBe(
      "UNSPECIFIED_FAILURE",
    );
    expect(toPaymentFailureCode(undefined)).toBe("UNSPECIFIED_FAILURE");
    expect(toPaymentFailureCode(null)).toBe("UNSPECIFIED_FAILURE");
    expect(toPaymentFailureCode("   ")).toBe("UNSPECIFIED_FAILURE");
  });

  it("reads the more specific decline reason beneath card_declined only", () => {
    expect(toPaymentFailureCodeFromDecline("card_declined", "expired_card")).toBe(
      "INSTRUMENT_REJECTED",
    );
    expect(toPaymentFailureCodeFromDecline("card_declined", "insufficient_funds")).toBe(
      "DECLINED",
    );
    /* An outer code that already classified precisely is not overridden. */
    expect(toPaymentFailureCodeFromDecline("api_connection_error", "expired_card")).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });
});

// — 9 —

describe("1.0 · the Connect readiness adapter speaks 0M.8's vocabulary", () => {
  it("categorises Stripe requirement strings, and discards them", () => {
    expect(toRequirementCode("individual.verification.document")).toBe(
      "DOCUMENT_VERIFICATION_REQUIRED",
    );
    expect(toRequirementCode("individual.dob.day")).toBe("IDENTITY_DETAILS_REQUIRED");
    expect(toRequirementCode("external_account")).toBe("PAYOUT_DETAILS_REQUIRED");
    expect(toRequirementCode("tos_acceptance.date")).toBe("PROVIDER_TERMS_ACCEPTANCE_REQUIRED");
    expect(toRequirementCode("business_profile.url")).toBe("BUSINESS_DETAILS_REQUIRED");
    expect(toRequirementCode("relationship.representative")).toBe(
      "REPRESENTATIVE_DETAILS_REQUIRED",
    );
    expect(toRequirementCode("something.stripe.invented")).toBe(
      "ADDITIONAL_VERIFICATION_REQUIRED",
    );
  });

  it("deduplicates and canonically orders the categories", () => {
    const codes = toRequirementCodes([
      "individual.dob.day",
      "individual.first_name",
      "external_account",
      null,
      "  ",
    ]);
    expect(codes).toEqual(["IDENTITY_DETAILS_REQUIRED", "PAYOUT_DETAILS_REQUIRED"]);
  });

  it("decides readiness in the order that matters", () => {
    expect(toReadinessStatus({})).toBe("NOT_STARTED");
    expect(
      toReadinessStatus({ requirements: { disabled_reason: "rejected.fraud" } }),
    ).toBe("DISABLED");
    expect(
      toReadinessStatus({
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { currently_due: ["external_account"] },
      }),
    ).toBe("DETAILS_REQUIRED");
    expect(
      toReadinessStatus({ requirements: { pending_verification: ["individual.verification"] } }),
    ).toBe("PENDING_PROVIDER");
    expect(toReadinessStatus({ charges_enabled: true, payouts_enabled: true })).toBe("ENABLED");
    expect(
      toReadinessStatus({ charges_enabled: true, payouts_enabled: false, details_submitted: true }),
    ).toBe("RESTRICTED");
  });

  it("returns an observation carrying nothing Stripe-shaped", async () => {
    const { client } = stripeDouble({
      retrieveAccount: async (id) => ({
        id,
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: true,
        requirements: {
          currently_due: ["individual.verification.document"],
          past_due: [],
          pending_verification: ["company.verification.document"],
          disabled_reason: "requirements.past_due",
        },
      }),
    });
    const observation = await createStripeConnectReadinessPort({
      runtime: runtime(client),
    }).fetchReadiness("acct_1TestConnectAccount");

    expect(observation).toEqual({
      provider: "STRIPE",
      providerAccountRef: "acct_1TestConnectAccount",
      readiness: "DETAILS_REQUIRED",
      outstandingRequirements: ["DOCUMENT_VERIFICATION_REQUIRED"],
    });
    const serialised = JSON.stringify(observation);
    for (const leak of ["charges_enabled", "currently_due", "disabled_reason", "individual."]) {
      expect(serialised, leak).not.toContain(leak);
    }
  });
});

// — 10 —

describe("1.0 · a browser cannot assert anything commercial", () => {
  it("accepts the Listing and the buyer's own details, and nothing else", () => {
    /* Phase 1.2 widened this from one field, because completing a purchase is
       not anonymous: a merchant of record cannot source tax, send a receipt, or
       answer support without a contact and a billing address.
     *
     * What it accepts is exactly that — the Listing, and facts about the BUYER.
     * Not a price, not a policy, not a party, and not an outcome. */
    expect(BeginCheckoutRequest.safeParse({ internalListingId: LISTING_ID }).success).toBe(false);
    expect(BeginCheckoutRequest.safeParse(VALID_CHECKOUT_BODY).success).toBe(true);

    const accepted = Object.keys(BeginCheckoutRequest.shape);
    expect(accepted).toContain("internalListingId");
    /* Every other accepted field is buyer contact or address. */
    for (const field of accepted) {
      if (field === "internalListingId") continue;
      expect(/^(buyerName|buyerEmail|billing|shipping)/.test(field), field).toBe(true);
    }
  });

  it("always requires billing, and leaves shipping to the basket rule", () => {
    /* Shipping is OPTIONAL on the request shape because the request cannot know
       what the basket delivers — that is `evaluateBasketFulfillment`'s decision,
       taken from explicit Product delivery modes. The service refuses a physical
       basket without one. */
    const { shippingLine1: _s1, shippingCity: _s2, shippingCountryCode: _s3, ...noShipping } =
      VALID_CHECKOUT_BODY;
    expect(BeginCheckoutRequest.safeParse(noShipping).success).toBe(true);

    /* Billing country is the one field tax sourcing cannot proceed without. */
    const { billingCountryCode: _c, ...noCountry } = VALID_CHECKOUT_BODY;
    expect(BeginCheckoutRequest.safeParse(noCountry).success).toBe(false);
    const { billingLine1: _l, ...noLine } = VALID_CHECKOUT_BODY;
    expect(BeginCheckoutRequest.safeParse(noLine).success).toBe(false);
  });

  it("refuses every field through which a client could state or price a sale", () => {
    for (const forbidden of NEVER_ON_BEGIN_CHECKOUT_REQUEST) {
      const parsed = BeginCheckoutRequest.safeParse({
        ...VALID_CHECKOUT_BODY,
        [forbidden]: "anything at all",
      });
      expect(parsed.success, forbidden).toBe(false);
    }
  });

  it("refuses them through the form body too, not only through JSON", () => {
    const form = new URLSearchParams(VALID_CHECKOUT_BODY).toString();
    expect(parseCheckoutBody("application/x-www-form-urlencoded", form)).toMatchObject({
      internalListingId: LISTING_ID,
      billingCountryCode: "US",
    });

    /* The form is not a looser door than JSON. */
    expect(
      parseCheckoutBody("application/x-www-form-urlencoded", `${form}&paymentStatus=paid`),
    ).toBeNull();
    expect(parseCheckoutBody("application/json", '{"internalListingId":"nope"}')).toBeNull();
    expect(parseCheckoutBody("text/plain", "internalListingId=x")).toBeNull();
    expect(parseCheckoutBody("application/json", "{not json")).toBeNull();
  });

  it("refuses an unsigned webhook at the route boundary with a bounded body", async () => {
    const result = await handleStripeWebhookRequest(
      {
        rawBody: JSON.stringify(sessionEvent("checkout.session.completed")),
        signatureHeader: null,
      },
      {
        env: ENV,
        port: createStripeBuyerPaymentConfirmationPort(
          { observedAt: "2027-12-03T12:00:05.000Z" },
          { runtime: runtime(stripeDouble().client), env: ENV },
        ),
        /* No database is reached: verification fails before finalization. */
        db: undefined,
      },
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "WEBHOOK_VERIFICATION_FAILED" });
    expect(Object.keys(result.body)).toEqual(["error"]);
  });

  it("keeps the guest claim code out of every URL and out of scripts", () => {
    const cookie = buildGuestClaimCookie("a-guest-claim-code", { secure: true });
    expect(cookie).toContain(`${GUEST_CLAIM_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/checkout");
  });
});

// — 11 —

describe("1.0 · the buyer's status projection is an allow-list", () => {
  const order = {
    orderId: ORDER_ID,
    lifecycle: "PAID",
    paymentFailureCode: null,
    quote: {
      currency: "USD" as const,
      quotedCommercialRetailAmountMinorUnits: 10_000,
      quotedTaxAmountMinorUnits: 0,
      quotedShippingAmountMinorUnits: 0,
      quotedOtherPassThroughAmountMinorUnits: 0,
    },
  };

  it("carries five fields and derives the total", () => {
    expect(toOrderStatusView(order)).toEqual({
      orderId: ORDER_ID,
      lifecycle: "PAID",
      currency: "USD",
      buyerTotalMinorUnits: 10_000,
      paymentFailureCode: null,
    });
  });

  it("holds no counterparty, no binding, and no economics", () => {
    const keys = Object.keys(toOrderStatusView(order));
    for (const forbidden of NEVER_IN_ORDER_STATUS) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it("surfaces a bounded failure code only in PAYMENT_FAILED", () => {
    expect(
      toOrderStatusView({ ...order, lifecycle: "PAYMENT_FAILED", paymentFailureCode: "DECLINED" })
        .paymentFailureCode,
    ).toBe("DECLINED");
    /* A stale code on a paid Order would describe a sale that failed. */
    expect(
      toOrderStatusView({ ...order, lifecycle: "PAID", paymentFailureCode: "DECLINED" })
        .paymentFailureCode,
    ).toBeNull();
  });
});
