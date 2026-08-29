/**
 * Order-expiry and notification-delivery contract tests (Phase 1.1).
 *
 * **NO NETWORK, NO MAIL PROVIDER, NO STRIPE ACCOUNT.** The one real `Stripe`
 * instance signs and verifies locally; every other boundary is a double.
 *
 * These are **shape and refusal** tests. The end-to-end behaviour — that an
 * expiry cancels an Order once, that a guest receives a receipt without becoming
 * a participant — lives in `order-expiry-and-notification.integration.test.ts`.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  BuyerContact,
  BuyerPaymentConfirmation,
  BUYER_PAYMENT_DISPOSITIONS,
  NEVER_PERSISTED_FROM_CONFIRMATION,
} from "../src/contracts/marketplace/buyer-payment";
import {
  DELIVERY_AUDIENCES,
  DELIVERY_CHANNELS,
  DELIVERY_FAILURE_CODES,
  DELIVERY_STATUSES,
  MailMessage,
  NEVER_ON_NOTIFICATION_DELIVERY,
  NotificationDeliveryRecord,
  notificationDeliveryKey,
} from "../src/contracts/marketplace/notification-delivery";
import {
  NOTIFICATION_CATEGORIES,
  IMPLEMENTED_NOTIFICATION_CATEGORIES,
} from "../src/contracts/marketplace/notification-obligation";
import { ORDER_LIFECYCLE_TRANSITIONS } from "../src/contracts/marketplace/order";
import {
  createCapturingMailAdapter,
  createDisabledMailAdapter,
  createLogMailAdapter,
  isMailEnabled,
  redactAddress,
  resolveMailPort,
} from "../src/server/notifications/mail-port";
import { destinationDigest } from "../src/server/notifications/notification-delivery-service";
import {
  HANDLED_EVENT_TYPES,
  ORDER_METADATA_KEY,
  createStripeBuyerPaymentConfirmationPort,
} from "../src/server/payments/stripe-buyer-payment-adapter";
import { CONFIRMATION_DISPOSITIONS } from "../src/server/payments/executable-checkout-service";
import {
  renderBuyerConfirmation,
  renderBuyerOrderExpired,
  renderBuyerPaymentFailed,
  renderParticipantSaleRecorded,
} from "../src/server/notifications/transactional-notice-service";
import type { StripeRuntimeConfig } from "../src/server/payments/stripe-runtime-config";
import type { OrderRecord } from "../src/contracts/marketplace/order";

// — Fixtures —

const opaque = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ORDER_ID = `mon:order:${opaque("P11RDER1")}`;
const PARTICIPANT_ID = `mon:mpart:${opaque("P11PART1")}`;
const OBLIGATION_ID = `mon:nobl:${opaque("P11N0BL1")}`;
const DELIVERY_ID = `mon:ndlv:${opaque("P11NDLV1")}`;
const SESSION_ID = "cs_test_a1B2c3D4e5F6g7H8i9J0";
const INTENT_ID = "pi_3QxYzAbCdEf12345";
const WEBHOOK_SECRET = "whsec_p11testsigningsecretvalue00000";
const TEST_KEY = "sk_test_p11notarealkeyatall000000";

const CONFIG: StripeRuntimeConfig = {
  mode: "TEST",
  apiKeyEnvVar: "MONACADO_STRIPE_SECRET_KEY",
  webhookSecretEnvVar: "MONACADO_STRIPE_WEBHOOK_SECRET",
  successUrl: "https://monacado.test/checkout/result",
  cancelUrl: "https://monacado.test/checkout/result",
  shippingCountries: ["US"],
  allowLoopbackHttp: false,
};

const ENV = {
  MONACADO_STRIPE_ENABLED: "true",
  MONACADO_STRIPE_SECRET_KEY: TEST_KEY,
  MONACADO_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  MONACADO_STRIPE_SUCCESS_URL: CONFIG.successUrl,
  MONACADO_STRIPE_CANCEL_URL: CONFIG.cancelUrl,
};

const signer = new Stripe(TEST_KEY, { apiVersion: "2026-07-29.dahlia" });

function signedDelivery(event: Record<string, unknown>) {
  const rawBody = JSON.stringify(event);
  return {
    rawBody,
    signatureHeader: signer.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: WEBHOOK_SECRET,
    }),
  };
}

function sessionEvent(type: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_p11test00000000001",
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

/** Source with block and line comments removed, so prose cannot match a scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const stripeDouble = () =>
  ({
    paymentIntents: { retrieve: async (id: string) => ({ id, last_payment_error: null }) },
    webhooks: signer.webhooks,
  }) as unknown as Stripe;

const confirmationPort = () =>
  createStripeBuyerPaymentConfirmationPort(
    { observedAt: "2028-03-01T10:00:00.000Z" },
    { runtime: { config: CONFIG, client: stripeDouble() }, env: ENV },
  );

const ORDER: OrderRecord = {
  orderId: ORDER_ID,
  buyer: { buyerKind: "GUEST_BUYER", guestClaimCodeDigest: "a".repeat(64) },
  internalListingId: `mon:listing:${opaque("P11LSTNG")}`,
  listingSourceRecordId: `mon:srec:${opaque("P11SREC")}`,
  listingSourceRecordVersion: "1",
  policyId: `mon:cpol:${opaque("P11P0LCY")}`,
  policyVersion: "1",
  storefrontId: `mon:storefront:${opaque("P11ST0RE")}`,
  internalProductId: `mon:product:${opaque("P11PR0D")}`,
  transactionType: "SELLER_DIRECT",
  sellerParticipantId: PARTICIPANT_ID,
  promoterParticipantId: null,
  quote: {
    currency: "USD",
    quotedCommercialRetailAmountMinorUnits: 10_000,
    quotedTaxAmountMinorUnits: 0,
    quotedShippingAmountMinorUnits: 0,
    quotedOtherPassThroughAmountMinorUnits: 0,
  },
  lifecycle: "PAID",
  paymentFailureCode: null,
  guestClaim: { claimedByAccountId: null, claimedAt: null },
  placedAt: "2028-03-01T09:00:00.000Z",
  paidAt: "2028-03-01T10:00:00.000Z",
  failedAt: null,
  cancelledAt: null,
  createdAt: "2028-03-01T09:00:00.000Z",
  updatedAt: "2028-03-01T10:00:00.000Z",
};

// — 1 —

describe("1.1 · expiry is Stripe's fact, not a Monacado timer", () => {
  it("acts on checkout.session.expired and builds no clock of its own", () => {
    expect(HANDLED_EVENT_TYPES).toContain("checkout.session.expired");

    /* Only Stripe knows whether a hosted session is still payable. A sweeper of
       Monacado's own would eventually cancel an Order a buyer was midway
       through paying. */
    for (const file of [
      "../src/server/payments/stripe-buyer-payment-adapter.ts",
      "../src/server/payments/executable-checkout-service.ts",
      "../src/server/payments/stripe-webhook-route-handler.ts",
    ]) {
      /* Comments are stripped first: these modules DOCUMENT the absence of a
         timer, and a naive scan would match the sentence saying so. */
      const source = stripComments(readFileSync(new URL(file, import.meta.url), "utf8"));
      for (const timer of ["setTimeout(", "setInterval(", "expiresAt", "cron"]) {
        expect(source.includes(timer), `${file} ${timer}`).toBe(false);
      }
    }
  });

  it("reports abandonment as its own disposition, carrying no result", () => {
    expect(BUYER_PAYMENT_DISPOSITIONS).toEqual(["PAYMENT_RESULT", "ABANDONED"]);
    const abandoned = BuyerPaymentConfirmation.parse({
      disposition: "ABANDONED",
      orderId: ORDER_ID,
      provider: "STRIPE",
      buyerContact: null,
      providerEventRef: "evt_x",
      observedAt: "2028-03-01T10:00:00.000Z",
    });
    expect("result" in abandoned).toBe(false);

    /* "Abandoned but succeeded" is not a shape that exists. */
    for (const forbidden of ["result", "failureCode", "providerTransactionRef"]) {
      expect(
        BuyerPaymentConfirmation.safeParse({
          disposition: "ABANDONED",
          orderId: ORDER_ID,
          provider: "STRIPE",
          buyerContact: null,
          providerEventRef: "evt_x",
          observedAt: "2028-03-01T10:00:00.000Z",
          [forbidden]: { outcome: "SUCCEEDED" },
        }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("translates a signed expiry event into ABANDONED", async () => {
    const confirmation = await confirmationPort().confirmPayment(
      signedDelivery(sessionEvent("checkout.session.expired", { payment_status: "unpaid" })),
    );
    expect(confirmation).not.toBeNull();
    expect(confirmation!.disposition).toBe("ABANDONED");
    expect(confirmation!.orderId).toBe(ORDER_ID);
  });

  it("cancels rather than fails — the lifecycle keeps them apart", () => {
    /* CANCELLED is 0M.9's "abandoned before payment succeeded". Routing an
       expiry through PAYMENT_FAILED would assert a decline nobody issued. */
    expect(ORDER_LIFECYCLE_TRANSITIONS.PENDING_PAYMENT).toContain("CANCELLED");
    /* And PAID is terminal, so no expiry can ever downgrade a completed sale. */
    expect(ORDER_LIFECYCLE_TRANSITIONS.PAID).toEqual([]);
    expect(CONFIRMATION_DISPOSITIONS).toContain("ORDER_EXPIRED");
  });
});

// — 2 —

describe("1.1 · the buyer's address is transient", () => {
  it("accepts a plausible address and refuses a malformed one", () => {
    expect(BuyerContact.safeParse({ email: "buyer@example.com" }).success).toBe(true);
    for (const bad of ["", "no-at-sign", "a@b", "two@@example.com", "sp ace@example.com"]) {
      expect(BuyerContact.safeParse({ email: bad }).success, bad).toBe(false);
    }
    /* Nothing beyond an address — a name is the next thing a template asks for. */
    expect(
      BuyerContact.safeParse({ email: "buyer@example.com", name: "Buyer" }).success,
    ).toBe(false);
  });

  it("has no column anywhere in the schema", () => {
    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    for (const forbidden of NEVER_PERSISTED_FROM_CONFIRMATION) {
      /* `0M.9`'s NEVER_ON_ORDER promised no buyer address column. Carrying one
         transiently on a confirmation must not have quietly created one. */
      expect(new RegExp(`^\\s+${forbidden}\\s`, "m").test(schema), forbidden).toBe(false);
    }
    expect(/^\s+destinationDigest\s/m.test(schema)).toBe(true);
  });

  it("is digested with the account normaliser, so casing cannot fork a recipient", () => {
    const expected = createHash("sha256").update("buyer@example.com", "utf8").digest("hex");
    expect(destinationDigest("Buyer@Example.COM")).toBe(expected);
    expect(destinationDigest("  buyer@example.com  ")).toBe(expected);
    expect(destinationDigest("buyer@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// — 3 —

describe("1.1 · delivery is evidence, never the obligation", () => {
  it("writes nothing to the obligation model", () => {
    for (const file of [
      "../src/server/notifications/notification-delivery-service.ts",
      "../src/server/notifications/transactional-notice-service.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      /* §3a: a supplemental channel "can never replace" the canonical notice, so
         a delivery may not satisfy, close, or advance an obligation. */
      for (const write of [
        "notificationObligation.update",
        "notificationObligation.create",
        "notificationObligation.upsert",
        "notificationObligation.delete",
        "advanceNotificationObligation",
        "createNotificationObligation",
        "upsertObligationInTx",
      ]) {
        expect(source.includes(write), `${file} ${write}`).toBe(false);
      }
    }
  });

  it("permits a delivery with no obligation and no participant behind it", () => {
    const guest = NotificationDeliveryRecord.parse({
      deliveryId: DELIVERY_ID,
      /* A guest buyer: 0M.N1 keys obligations on participants BY DESIGN, so
         there is no obligation to point at and none is invented. */
      obligationId: null,
      audience: "BUYER",
      recipientParticipantId: null,
      category: "ORDER_CONFIRMATION",
      subject: { kind: "ORDER", ref: ORDER_ID, versionRef: null },
      channel: "EMAIL",
      destinationDigest: "b".repeat(64),
      status: "ACCEPTED",
      failureCode: null,
      providerMessageRef: "local-1",
      attemptedAt: "2028-03-01T10:00:00.000Z",
      acceptedAt: "2028-03-01T10:00:00.000Z",
      updatedAt: "2028-03-01T10:00:00.000Z",
    });
    expect(guest.obligationId).toBeNull();
    expect(guest.recipientParticipantId).toBeNull();
  });

  it("names the message, the address, and credentials as things it never holds", () => {
    const base = {
      deliveryId: DELIVERY_ID,
      obligationId: OBLIGATION_ID,
      audience: "SELLER",
      recipientParticipantId: PARTICIPANT_ID,
      category: "SALE_RECORDED",
      subject: { kind: "ORDER", ref: ORDER_ID, versionRef: null },
      channel: "EMAIL",
      destinationDigest: "c".repeat(64),
      status: "ATTEMPTED",
      failureCode: null,
      providerMessageRef: null,
      attemptedAt: "2028-03-01T10:00:00.000Z",
      acceptedAt: null,
      updatedAt: "2028-03-01T10:00:00.000Z",
    };
    expect(NotificationDeliveryRecord.safeParse(base).success).toBe(true);
    for (const forbidden of NEVER_ON_NOTIFICATION_DELIVERY) {
      expect(
        NotificationDeliveryRecord.safeParse({ ...base, [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("keeps the vocabulary closed and small", () => {
    expect(DELIVERY_CHANNELS).toEqual(["EMAIL"]);
    expect(DELIVERY_AUDIENCES).toEqual(["BUYER", "SELLER", "PROMOTER"]);
    expect(DELIVERY_STATUSES).toEqual(["ATTEMPTED", "ACCEPTED", "FAILED"]);
    /* No RETRYING: this phase sends at most once per key. */
    expect(DELIVERY_STATUSES as readonly string[]).not.toContain("RETRYING");
    for (const code of DELIVERY_FAILURE_CODES) expect(code).toMatch(/^[A-Z_]+$/);
  });

  it("adds ORDER_CANCELLED without claiming an obligation producer for it", () => {
    expect(NOTIFICATION_CATEGORIES).toContain("ORDER_CANCELLED");
    /* An additive member — the change 0M.N1 said its vocabulary was built to
       take. This phase creates DELIVERIES of it, never obligations. */
    /* Updated in Phase 1.14 alongside the constant it reads. What this test is
       really asserting is unchanged and still true: ORDER_CANCELLED is a
       category with deliveries and no obligation producer. */
    expect([...IMPLEMENTED_NOTIFICATION_CATEGORIES]).not.toContain("ORDER_CANCELLED");
  });
});

// — 4 —

describe("1.1 · the deduplication key is one message per order per audience", () => {
  const key = (over: Record<string, unknown> = {}) =>
    notificationDeliveryKey({
      audience: "BUYER",
      recipientParticipantId: null,
      category: "ORDER_CONFIRMATION",
      subject: { kind: "ORDER", ref: ORDER_ID },
      channel: "EMAIL",
      ...over,
    } as Parameters<typeof notificationDeliveryKey>[0]);

  it("is stable for the same message and distinct across audiences", () => {
    expect(key()).toBe(key());
    expect(key({ audience: "SELLER", recipientParticipantId: PARTICIPANT_ID })).not.toBe(key());
  });

  it("separates a confirmation from an expiry notice", () => {
    /* Sharing a key would make the two indistinguishable in the evidence table
       and would let one suppress the other. */
    expect(key({ category: "ORDER_CANCELLED" })).not.toBe(key());
    expect(key({ category: "PAYMENT_FAILED" })).not.toBe(key());
  });

  it("does NOT include the destination", () => {
    /* Keying on the address would send a second receipt to a buyer who
       corrected their email, and would let anyone able to influence the address
       manufacture a duplicate send. */
    expect(key()).not.toContain("@");
    expect(key()).toBe(["BUYER", "~", "ORDER_CONFIRMATION", "ORDER", ORDER_ID, "EMAIL"].join("|"));
  });
});

// — 5 —

describe("1.1 · the mail boundary names no vendor", () => {
  it("adds no email vendor to the repository", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    for (const vendor of [
      "nodemailer",
      "@sendgrid/mail",
      "resend",
      "postmark",
      "mailgun.js",
      "@aws-sdk/client-ses",
    ]) {
      expect(names, vendor).not.toContain(vendor);
    }
  });

  it("refuses everything when mail is not configured, rather than pretending", () => {
    expect(isMailEnabled({})).toBe(false);
    expect(isMailEnabled({ MONACADO_MAIL_ENABLED: "yes" })).toBe(true);
    /* Disabled must be visible: a delivery row is still written and marked
       FAILED with a bounded code, so an operator can count what did not send. */
    expect(resolveMailPort({})).toBeDefined();
    expect(resolveMailPort({ MONACADO_MAIL_ENABLED: "true", MONACADO_MAIL_TRANSPORT: "SES" }))
      .toBeDefined();
  });

  it("returns a refusal rather than throwing", async () => {
    const result = await createDisabledMailAdapter().send({
      to: "buyer@example.com",
      subject: "s",
      text: "t",
    });
    expect(result).toEqual({ outcome: "REFUSED", failureCode: "CHANNEL_NOT_CONFIGURED" });
  });

  it("logs a redacted destination and never the body", async () => {
    const lines: string[] = [];
    const port = createLogMailAdapter({ sink: (l) => lines.push(l), refs: () => "local-1" });
    const result = await port.send({
      to: "alice@example.com",
      subject: "Your Monacado order is confirmed",
      text: "SECRET BODY CONTENT",
    });
    expect(result).toEqual({ outcome: "ACCEPTED", providerMessageRef: "local-1" });
    expect(lines[0]).toContain("a***@example.com");
    expect(lines[0]).not.toContain("alice@example.com");
    expect(lines[0]).not.toContain("SECRET BODY CONTENT");
  });

  it("redacts safely even for odd input", () => {
    expect(redactAddress("a@b.com")).toBe("a***@b.com");
    expect(redactAddress("@nope")).toBe("***");
    expect(redactAddress("nope")).toBe("***");
  });

  it("carries no credential, template, or HTML through the message type", () => {
    const base = { to: "buyer@example.com", subject: "s", text: "t" };
    expect(MailMessage.safeParse(base).success).toBe(true);
    for (const forbidden of ["html", "templateId", "apiKey", "attachments", "from", "replyTo"]) {
      expect(MailMessage.safeParse({ ...base, [forbidden]: "x" }).success, forbidden).toBe(false);
    }
  });

  it("captures whole messages for a test", async () => {
    const port = createCapturingMailAdapter();
    await port.send({ to: "buyer@example.com", subject: "s", text: "t" });
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.to).toBe("buyer@example.com");
  });
});

// — 6 —

describe("1.1 · rendered notices leak no commercial position", () => {
  const rendered = [
    renderBuyerConfirmation(ORDER),
    renderBuyerPaymentFailed({ ...ORDER, lifecycle: "PAYMENT_FAILED", paymentFailureCode: "DECLINED" }),
    renderBuyerOrderExpired({ ...ORDER, lifecycle: "CANCELLED" }),
    renderParticipantSaleRecorded(ORDER),
  ];

  it("names no participant, policy, provider reference, or version", () => {
    for (const message of rendered) {
      const text = `${message.subject}\n${message.body}`;
      for (const leak of [
        ORDER.sellerParticipantId,
        ORDER.policyId,
        ORDER.listingSourceRecordId,
        ORDER.internalProductId,
        ORDER.storefrontId,
        INTENT_ID,
        "mon:mpart:",
        "mon:cpol:",
        "retained",
        "proceeds",
        "commission",
      ]) {
        expect(text, `${message.subject} :: ${leak}`).not.toContain(leak);
      }
    }
  });

  it("tells the buyer the amount and the order, and nothing else", () => {
    const confirmation = renderBuyerConfirmation(ORDER);
    expect(confirmation.body).toContain(ORDER_ID);
    expect(confirmation.body).toContain("$100.00");
  });

  it("says plainly that no money was taken when none was", () => {
    for (const message of [
      renderBuyerPaymentFailed({ ...ORDER, paymentFailureCode: "DECLINED" }),
      renderBuyerOrderExpired(ORDER),
    ]) {
      expect(message.body.toLowerCase()).toContain("no payment was taken");
    }
  });

  it("carries a bounded failure code and never provider text", () => {
    const failed = renderBuyerPaymentFailed({ ...ORDER, paymentFailureCode: "DECLINED" });
    expect(failed.body).toContain("DECLINED");
    expect(failed.body).not.toMatch(/card_declined|stripe/i);
  });

  it("points a participant at the admin panel rather than restating the record", () => {
    const sale = renderParticipantSaleRecorded(ORDER);
    /* §3a: the panel is canonical and email can never replace it. The message
       says so, and carries no proceeds figure. */
    expect(sale.body).toContain("admin panel");
    expect(sale.body).not.toContain("$");
  });
});
