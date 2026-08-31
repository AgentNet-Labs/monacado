/**
 * Begin-checkout route handler (Phase 1.0) — SERVER ONLY.
 *
 * The whole route expressed **without Next.js**, following
 * `worker-status-route-handler.ts` deliberately: it takes headers and a body and
 * returns a status, headers, and either a redirect target or a JSON body, so
 * every rule is testable without constructing a framework request.
 *
 * ## What a client may say
 *
 * **One field: which Listing.** That is the entire request surface, enforced by a
 * `strictObject`, and it is the most important design decision in this file.
 * Everything else that could change what Monacado charges, keeps, or pays out is
 * resolved server-side from authoritative state:
 *
 * | Fact | Where it comes from | Why not the client |
 * | --- | --- | --- |
 * | retail price | the bound Listing source version | a client-named price is a client-named sale |
 * | commercial policy | deployment configuration | naming the policy names Monacado's retention |
 * | tax / shipping / pass-through | zero, here | `0M.T2` owns tax; a client-supplied figure is an unaudited one |
 * | buyer identity | the session cookie, or absent | a body field naming an account is a body field impersonating one |
 * | go-live approval | the governed `ParticipantCommerceApproval` | a client passing `APPROVED` makes a Listing purchasable |
 * | payment outcome | **nowhere** — no such field exists | this is the whole point |
 * | `placedAt` | the injected clock | a client-chosen instant prices a sale window that has closed |
 * | buyer name, email, billing address | **the client — required** (1.2) | a merchant of record cannot source tax, send a receipt, or answer support without them. An address is not a price, and none of the refusals below is weakened |
 * | ship-to address | the client, **required for every purchase** | tax is sourced to it, digital included; `shipToSameAsBilling` copies billing in so nobody types it twice |
 *
 * ## Guest by default
 *
 * No session means a guest Order, exactly as `0M.9` designed. **No account is
 * created, no participant is fabricated, and nothing about the buyer is
 * collected** — the route asks for no email, no name, and no address, and there
 * is no field in which one could arrive. The one-time guest claim code is handed
 * back in a short-lived `HttpOnly` cookie so the return page can show it once;
 * Monacado kept only its digest and cannot re-issue it.
 *
 * ## What it does not do
 *
 * It runs no pricing, computes no split, contacts no provider directly, and marks
 * nothing paid. It calls `beginCheckout`, which calls `0M.9`'s `placeOrder` and
 * the injected initiation port. There is no path from this file to a `PAID` Order.
 */

import "../server-only";
import { z } from "zod";
import { INTERNAL_LISTING_ID_RE } from "../../contracts/marketplace/identity";
import { AccountEmail } from "../../contracts/account/account";
import {
  CountryCode,
  RegionCode,
} from "../../contracts/marketplace/order-buyer-snapshot";
import {
  BuyerSnapshotError,
  type BuyerSnapshotIdProvider,
} from "../marketplace/order-buyer-snapshot-service";
import type { BuyerPaymentInitiationPort } from "../../contracts/marketplace/buyer-payment";
import { readSessionCookie } from "../account/session-cookie";
import { resolveAuthenticatedPrincipal } from "../account/account-principal";
import { getPrisma } from "../db/client";
import type { OrderIdProvider } from "../marketplace/order-ids";
import type { ParticipantIdProvider } from "../marketplace/participant-ids";
import type { GuestClaimCodeProvider } from "../marketplace/guest-claim-code";
import type { TaxCalculationPort } from "../../contracts/marketplace/tax-calculation";
import { resolveTaxPort } from "../tax/tax-adapters";
import type { TaxEvidenceIdProvider } from "../tax/tax-calculation-ids";
import { TaxError } from "../tax/tax-errors";
import { TransactionDeniedByRiskError, RiskError } from "../risk/risk-errors";
import { buyerSafeRiskDenialReasons } from "../../contracts/marketplace/transaction-risk";
import { ParticipantActionNotPermittedError } from "../marketplace/participant-standing-errors";
import { BasketFulfillmentError } from "../../contracts/marketplace/basket-fulfillment";
import { beginCheckout } from "./executable-checkout-service";
import { createStripeBuyerPaymentAdapter } from "./stripe-buyer-payment-adapter";
import { StripePaymentInitiationError } from "./stripe-buyer-payment-adapter";
import {
  isAcceptableOrigin,
  readCheckoutRuntimeConfig,
  type CheckoutRuntimeConfig,
} from "./checkout-runtime-config";
import {
  StripeConfigurationError,
  StripeCredentialError,
  StripeDisabledError,
  type Env,
} from "./stripe-runtime-config";
import {
  InvalidOrderInputError,
  ListingNotFoundError,
  ListingNotPurchasableError,
  MarketplacePolicyUnavailableError,
  NoEffectiveCommercialPolicyError,
  OrderCurrencyMismatchError,
  SellerSupportContactUnavailableError,
} from "../marketplace/order-errors";

type Db = ReturnType<typeof getPrisma>;

/**
 * The tokens a checkbox may post, ticked and unticked.
 *
 * A browser sends `on` for a bare `<input type="checkbox">` and **nothing at all**
 * when it is unticked, so absence must read as false. Some clients serialize the
 * unticked case explicitly, which is why `off`/`false`/`0`/`no` are accepted and
 * read as false rather than refused with a 400.
 *
 * A **bounded vocabulary**, not "any string": an unrecognised token is a
 * refusal, so a client cannot half-say something and have it guessed at.
 */
export const CHECKED_TOKENS = ["on", "true", "1", "yes"] as const;
export const UNCHECKED_TOKENS = ["off", "false", "0", "no"] as const;
const CHECKBOX_TOKENS = [...CHECKED_TOKENS, ...UNCHECKED_TOKENS] as const;

function isChecked(value: boolean | string | undefined): boolean {
  if (typeof value === "boolean") return value;
  return value !== undefined && (CHECKED_TOKENS as readonly string[]).includes(value);
}

/**
 * The entire client request.
 *
 * A `strictObject`, so a body carrying `amountMinorUnits`, `policyId`,
 * `buyerAccountId`, `paymentStatus`, or `providerTransactionRef` is **refused**
 * rather than ignored. Refusal beats ignoring: an ignored field looks accepted to
 * whoever sent it, and the next reader has to prove it went nowhere.
 */
export const BeginCheckoutRequest = z.strictObject({
  internalListingId: z
    .string()
    .regex(INTERNAL_LISTING_ID_RE, "internalListingId must be mon:listing:<opaque>"),

  /* — Buyer details (Phase 1.2 correction) —
   *
   * Completing a purchase is not anonymous. These are the fields a merchant of
   * record genuinely requires: without them Monacado cannot source tax, evaluate
   * compliance, send a receipt, or answer a support question.
   *
   * Widening the request by exactly this much does NOT weaken what it refuses.
   * Every entry in `NEVER_ON_BEGIN_CHECKOUT_REQUEST` is still rejected: an
   * address is not a price, a policy, a party, or a payment outcome. */
  buyerName: z.string().min(1).max(200),
  buyerEmail: AccountEmail,

  billingLine1: z.string().min(1).max(200),
  billingLine2: z.string().min(1).max(200).optional(),
  billingCity: z.string().min(1).max(120),
  billingRegion: RegionCode.optional(),
  billingPostalCode: z.string().min(1).max(32).optional(),
  billingCountryCode: CountryCode,

  /* The ordinary retail convenience: ship to the billing address. Set it and the
     ship-to fields below may be omitted — billing is copied in by
     `resolveShipToAddress`, so nobody types one address twice.
     
     A checkbox, so a form posts a token when ticked and NOTHING when not — which
     is why absence must read as false rather than as a missing required field. A
     boolean here would reject every form post; the JSON door accepts a real
     boolean too. */
  shipToSameAsBilling: z.union([z.boolean(), z.enum(CHECKBOX_TOKENS)]).optional(),

  /* The SHIP-TO address, required for every purchase — digital included, where it
     serves as the tax destination and implies no physical fulfillment. Optional
     in the request SHAPE only because `shipToSameAsBilling` is the other way to
     supply it; the service refuses a checkout with neither. */
  shippingLine1: z.string().min(1).max(200).optional(),
  shippingLine2: z.string().min(1).max(200).optional(),
  shippingCity: z.string().min(1).max(120).optional(),
  shippingRegion: RegionCode.optional(),
  shippingPostalCode: z.string().min(1).max(32).optional(),
  shippingCountryCode: CountryCode.optional(),
});

/** Assemble the flat form fields into the structured details the service takes. */
export function toBuyerDetails(request: BeginCheckoutRequest) {
  return {
    name: request.buyerName,
    email: request.buyerEmail,
    billingAddress: {
      line1: request.billingLine1,
      line2: request.billingLine2 ?? null,
      city: request.billingCity,
      region: request.billingRegion ?? null,
      postalCode: request.billingPostalCode ?? null,
      countryCode: request.billingCountryCode,
    },
    shipToSameAsBilling: isChecked(request.shipToSameAsBilling),
    shippingAddress:
      request.shippingLine1 === undefined ||
      request.shippingCity === undefined ||
      request.shippingCountryCode === undefined
        ? null
        : {
            line1: request.shippingLine1,
            line2: request.shippingLine2 ?? null,
            city: request.shippingCity,
            region: request.shippingRegion ?? null,
            postalCode: request.shippingPostalCode ?? null,
            countryCode: request.shippingCountryCode,
          },
  };
}
export type BeginCheckoutRequest = z.infer<typeof BeginCheckoutRequest>;

/**
 * Named as never admissible on a begin-checkout request, and refused by the
 * `strictObject` above. Asserted by a test rather than merely documented.
 */
export const NEVER_ON_BEGIN_CHECKOUT_REQUEST = [
  // a payment outcome — the browser never gets to state one
  "outcome",
  "paymentStatus",
  "paid",
  "providerTransactionRef",
  "paymentIntentId",
  "checkoutSessionId",
  // commercial figures — derived from authoritative state, never supplied
  "amountMinorUnits",
  "buyerTotalMinorUnits",
  "retailPriceMinorUnits",
  "taxAmountMinorUnits",
  "shippingAmountMinorUnits",
  "policyId",
  "policyVersion",
  // identity — the session decides, not the body
  "buyerAccountId",
  "buyerParticipantId",
  "sellerParticipantId",
  // bindings a caller must not pin
  "listingSourceRecordVersion",
  "placedAt",
  "productAvailability",
  "goLiveApproval",
] as const;

/** Bounded response codes. Every non-2xx body is exactly `{ "error": <one> }`. */
export const CHECKOUT_ERROR_CODES = {
  invalidRequest: "INVALID_CHECKOUT_REQUEST",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  listingNotFound: "LISTING_NOT_FOUND",
  notPurchasable: "LISTING_NOT_PURCHASABLE",
  notConfigured: "CHECKOUT_NOT_CONFIGURED",
  riskDenied: "TRANSACTION_DENIED_BY_RISK",
  taxUnavailable: "TAX_CALCULATION_UNAVAILABLE",
  deliveryModeUnknown: "PRODUCT_DELIVERY_MODE_UNKNOWN",
  policyUnavailable: "MARKETPLACE_POLICY_UNAVAILABLE",
  sellerSupportUnavailable: "SELLER_SUPPORT_CONTACT_UNAVAILABLE",
  providerUnavailable: "PAYMENT_PROVIDER_UNAVAILABLE",
  unavailable: "CHECKOUT_UNAVAILABLE",
} as const;

export const CHECKOUT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

/**
 * How long the guest's one-time claim code stays in the browser.
 *
 * Long enough to survive a Stripe payment and the return trip, short enough that
 * a shared machine does not keep it. It is `HttpOnly`, so no script reads it, and
 * `SameSite=Lax`, so it survives the top-level navigation back from Stripe while
 * not riding along on a cross-site subrequest.
 */
export const GUEST_CLAIM_COOKIE_NAME = "monacado_guest_claim";
export const GUEST_CLAIM_COOKIE_MAX_AGE_SECONDS = 3_600;

export function buildGuestClaimCookie(code: string, options: { secure: boolean }): string {
  const parts = [
    `${GUEST_CLAIM_COOKIE_NAME}=${encodeURIComponent(code)}`,
    "Path=/checkout",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${GUEST_CLAIM_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearedGuestClaimCookie(options: { secure: boolean }): string {
  const parts = [
    `${GUEST_CLAIM_COOKIE_NAME}=`,
    "Path=/checkout",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export interface CheckoutRouteResult {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  /** Set on success: where the buyer must be sent to pay. */
  redirectTo: string | null;
}

export interface CheckoutRouteDeps {
  db?: Db;
  env?: Env;
  config?: CheckoutRuntimeConfig;
  /** Injected so a test drives the whole route without a Stripe account. */
  port?: BuyerPaymentInitiationPort;
  /**
   * Identity and claim-code sources, forwarded to `0M.9`'s services.
   *
   * Injectable for the same reason every other identity provider in this
   * repository is: a test needs deterministic ids to clean up only what it
   * created, and a route that minted them unconditionally would leave rows
   * nothing could safely delete.
   */
  ids?: OrderIdProvider;
  notificationIds?: ParticipantIdProvider;
  claimCodes?: GuestClaimCodeProvider;
  /** Phase 1.2 — injected so a test drives checkout without a tax engine. */
  taxPort?: TaxCalculationPort;
  taxIds?: TaxEvidenceIdProvider;
  buyerSnapshotIds?: BuyerSnapshotIdProvider;
  now?: () => string;
}

function refuse(status: number, code: string): CheckoutRouteResult {
  return { status, headers: { ...CHECKOUT_HEADERS }, body: { error: code }, redirectTo: null };
}

/**
 * Parse either an HTML form post or a JSON body into the one accepted field.
 *
 * The buyer UI posts a plain form, which needs no client JavaScript and therefore
 * no client payment SDK; JSON is accepted so the route is exercisable without a
 * browser. Both funnel into the same `strictObject`, so neither is a looser door.
 */
export function parseCheckoutBody(
  contentType: string | null,
  rawBody: string,
): BeginCheckoutRequest | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  let candidate: unknown;
  if (type === "application/x-www-form-urlencoded") {
    candidate = Object.fromEntries(new URLSearchParams(rawBody));
  } else if (type === "application/json") {
    try {
      candidate = JSON.parse(rawBody);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const parsed = BeginCheckoutRequest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Begin one checkout.
 *
 * On success returns **303 See Other** to the provider's hosted page. 303 rather
 * than 302 so the browser follows with `GET` — a redirect after a form post that
 * preserved the method would re-post to Stripe.
 */
export async function handleBeginCheckoutRequest(
  request: {
    contentType: string | null;
    originHeader: string | null;
    cookieHeader: string | null;
    rawBody: string;
  },
  deps: CheckoutRouteDeps = {},
): Promise<CheckoutRouteResult> {
  const db = deps.db ?? getPrisma();
  const now = (deps.now ?? (() => new Date().toISOString()))();

  let config: CheckoutRuntimeConfig;
  let port: BuyerPaymentInitiationPort;
  try {
    config = deps.config ?? readCheckoutRuntimeConfig(deps.env);
    port =
      deps.port ??
      createStripeBuyerPaymentAdapter(deps.env === undefined ? {} : { env: deps.env });
  } catch (error) {
    if (
      error instanceof StripeDisabledError ||
      error instanceof StripeConfigurationError ||
      error instanceof StripeCredentialError
    ) {
      return refuse(503, CHECKOUT_ERROR_CODES.notConfigured);
    }
    throw error;
  }

  if (!isAcceptableOrigin(request.originHeader, config)) {
    return refuse(403, CHECKOUT_ERROR_CODES.crossOrigin);
  }

  const parsed = parseCheckoutBody(request.contentType, request.rawBody);
  if (parsed === null) return refuse(400, CHECKOUT_ERROR_CODES.invalidRequest);

  /* The buyer's identity comes from the session and nowhere else. No session is
     not an error — it is a guest, which 0M.9 treats as first-class. */
  let buyerAccountId: string | null = null;
  const token = readSessionCookie(request.cookieHeader);
  if (token !== undefined) {
    const principal = await resolveAuthenticatedPrincipal(token, { now, db });
    buyerAccountId = principal?.accountId ?? null;
  }

  try {
    const begun = await beginCheckout(
      {
        internalListingId: parsed.internalListingId,
        buyerAccountId,
        /* Recorded, calculated by nothing. 0M.T2 owns tax execution, nexus,
           sourcing, and remittance; until it exists these are honestly zero
           rather than dishonestly estimated. */
        taxAmountMinorUnits: 0,
        shippingAmountMinorUnits: 0,
        otherPassThroughAmountMinorUnits: 0,
        currency: "USD",
        /* The one upstream fact 0M.9 left supplied. It is the Product model's
           question, it is supplied by the SERVER, and no request field can
           reach it. */
        productAvailability: "available",
        placedAt: now,
      },
      config.policyId,
      {
        provider: "STRIPE",
        port,
        /* Phase 1.2 — both required. An unconfigured deployment's tax adapter
           THROWS and its risk gate DENIES, so neither is a path to selling
           untaxed or ungated. */
        taxPort: deps.taxPort ?? resolveTaxPort(deps.env),
        riskPolicyId: config.riskPolicyId,
        buyerDetails: toBuyerDetails(parsed),
      },
      {
        db,
        ...(deps.ids === undefined ? {} : { ids: deps.ids }),
        ...(deps.notificationIds === undefined ? {} : { notificationIds: deps.notificationIds }),
        ...(deps.claimCodes === undefined ? {} : { claimCodes: deps.claimCodes }),
        ...(deps.taxIds === undefined ? {} : { taxIds: deps.taxIds }),
        ...(deps.buyerSnapshotIds === undefined
          ? {}
          : { buyerSnapshotIds: deps.buyerSnapshotIds }),
      },
    );

    const secure = config.appOrigin.startsWith("https:");
    const headers: Record<string, string> = {
      ...CHECKOUT_HEADERS,
      location: begun.initiation.buyerActionUrl,
    };
    headers["set-cookie"] =
      begun.guestClaimCode === null
        ? buildClearedGuestClaimCookie({ secure })
        : buildGuestClaimCookie(begun.guestClaimCode, { secure });

    return {
      status: 303,
      headers,
      /* A JSON client gets the same answer the browser gets in the Location
         header. Neither is a payment result; both say only "go here". */
      body: {
        orderId: begun.order.orderId,
        buyerTotalMinorUnits: begun.buyerTotalMinorUnits,
        currency: begun.order.quote.currency,
        buyerActionUrl: begun.initiation.buyerActionUrl,
      },
      redirectTo: begun.initiation.buyerActionUrl,
    };
  } catch (error) {
    if (error instanceof ListingNotFoundError) {
      return refuse(404, CHECKOUT_ERROR_CODES.listingNotFound);
    }
    if (error instanceof ListingNotPurchasableError) {
      return refuse(409, CHECKOUT_ERROR_CODES.notPurchasable);
    }
    /* Phase 1.2 — a governed refusal, not an outage.
     *
     * Phase 1.15 correction: the claim that these "name a control, never an
     * amount or a party" was not true of four of the seven. `SELLER_RESTRICTED`,
     * `PROMOTER_RESTRICTED`, `SELLER_NOT_COMMERCE_APPROVED`, and
     * `SELLER_PAYMENT_NOT_READY` each name a counterparty and something withheld
     * from them — and because a checkout request names one Listing, returning one
     * of them to an unauthenticated poster disclosed that specific participant's
     * standing. The vocabulary is documented as safe to surface TO AN OPERATOR;
     * this is a buyer.
     *
     * The transaction-shaped reasons still travel, so a buyer who hit the amount
     * ceiling still learns why. */
    if (error instanceof TransactionDeniedByRiskError) {
      return {
        status: 409,
        headers: { ...CHECKOUT_HEADERS },
        body: {
          error: CHECKOUT_ERROR_CODES.riskDenied,
          reasonCodes: buyerSafeRiskDenialReasons(error.reasonCodes),
        },
        redirectTo: null,
      };
    }
    /* Phase 1.15 — the participant-standing gate refused this sale.
     *
     * Answered as an availability outcome and nothing more. The denial code
     * distinguishing suspension from restriction, and the capability withheld,
     * are both deliberately dropped here: they are an operator's facts, read from
     * the governed records by someone entitled to them, never something a buyer
     * learns by attempting a purchase. */
    if (error instanceof ParticipantActionNotPermittedError) {
      return refuse(409, CHECKOUT_ERROR_CODES.notPurchasable);
    }
    /* Tax could not be established. Monacado refuses to sell rather than sell
       untaxed — the difference is a liability nobody recorded. */
    if (error instanceof TaxError) {
      return refuse(503, CHECKOUT_ERROR_CODES.taxUnavailable);
    }
    if (error instanceof RiskError) {
      return refuse(503, CHECKOUT_ERROR_CODES.notConfigured);
    }
    if (
      error instanceof InvalidOrderInputError ||
      error instanceof OrderCurrencyMismatchError ||
      error instanceof BuyerSnapshotError
    ) {
      return refuse(400, CHECKOUT_ERROR_CODES.invalidRequest);
    }
    /* A Product that does not declare how it is delivered. Fails closed: 409
       rather than 400, because nothing the client sent is wrong — the catalogue
       is incomplete. */
    if (error instanceof BasketFulfillmentError) {
      return refuse(409, CHECKOUT_ERROR_CODES.deliveryModeUnknown);
    }
    if (error instanceof NoEffectiveCommercialPolicyError) {
      return refuse(503, CHECKOUT_ERROR_CODES.notConfigured);
    }
    /* Phase 1.3 — no ACTIVE marketplace policy. An OPERATOR failure: 503,
       because nothing the buyer sent is wrong and the condition is repaired by
       activating a version, not by the buyer doing anything differently. Its own
       code rather than `notConfigured`, so an operator is sent to the policy
       they have not activated instead of to their Stripe keys. */
    if (error instanceof MarketplacePolicyUnavailableError) {
      return refuse(503, CHECKOUT_ERROR_CODES.policyUnavailable);
    }
    /* Phase 1.3 — this seller cannot currently be reached. 409 rather than 503:
       the marketplace is working, this one listing is not sellable right now,
       which is the same shape of answer as LISTING_NOT_PURCHASABLE. The code
       names the condition and never the address. */
    if (error instanceof SellerSupportContactUnavailableError) {
      return refuse(409, CHECKOUT_ERROR_CODES.sellerSupportUnavailable);
    }
    /* A missing or non-test credential is discovered here rather than above,
       because the adapter resolves its runtime lazily — nothing reads a secret
       until a payment is actually being started. It is a MISCONFIGURATION, and
       reporting it as a provider outage would send an operator to Stripe's
       status page instead of to their own environment. */
    if (
      error instanceof StripeCredentialError ||
      error instanceof StripeConfigurationError ||
      error instanceof StripeDisabledError
    ) {
      return refuse(503, CHECKOUT_ERROR_CODES.notConfigured);
    }
    if (error instanceof StripePaymentInitiationError) {
      return refuse(502, CHECKOUT_ERROR_CODES.providerUnavailable);
    }
    return refuse(500, CHECKOUT_ERROR_CODES.unavailable);
  }
}
