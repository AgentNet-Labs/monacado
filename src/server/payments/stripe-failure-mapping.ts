/**
 * Stripe failure translation (Phase 1.0) — SERVER ONLY.
 *
 * Maps Stripe's decline and error vocabulary onto `0M.9`'s closed
 * `PaymentFailureCode` set, and **loses everything else on purpose**.
 *
 * Two rules govern this file:
 *
 *   1. **Nothing provider-shaped escapes it.** The return value is a Monacado
 *      enum member. No Stripe code, no decline message, no issuer reason, and no
 *      network code is returned, logged, or persisted — `0M.9` refuses free-text
 *      failures because a free-text failure is where a card detail, an address,
 *      or a customer's name eventually lands.
 *
 *   2. **The default is `UNSPECIFIED_FAILURE`, not a guess.** Stripe's code list
 *      grows; an unrecognised member must degrade to "a failure Monacado does not
 *      classify further" rather than be forced into the nearest-looking bucket,
 *      because a wrong classification is worse than an honest absence of one.
 *
 * Pure. No SDK import, no I/O, no clock.
 */

import "../server-only";
import type { PaymentFailureCode } from "../../contracts/marketplace/order";

/**
 * The instrument itself was unusable — not a decision by an issuer, but a card
 * that cannot be charged as presented.
 */
const INSTRUMENT_REJECTED_CODES: ReadonlySet<string> = new Set([
  "expired_card",
  "incorrect_cvc",
  "incorrect_number",
  "incorrect_zip",
  "invalid_card_type",
  "invalid_cvc",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "invalid_number",
  "card_decline_rate_limit_exceeded",
  "payment_method_unactivated",
  "payment_method_unsupported_type",
  "payment_intent_payment_attempt_failed",
]);

/** An authentication step the buyer did not complete. */
const AUTHENTICATION_FAILED_CODES: ReadonlySet<string> = new Set([
  "authentication_required",
  "payment_intent_authentication_failure",
  "setup_intent_authentication_failure",
]);

/** Stripe, not the issuer, could not answer. */
const PROVIDER_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "api_connection_error",
  "api_error",
  "lock_timeout",
  "rate_limit",
  "processing_error",
]);

/** An issuer decision. */
const DECLINED_CODES: ReadonlySet<string> = new Set([
  "card_declined",
  "card_not_supported",
  "charge_exceeds_source_limit",
  "insufficient_funds",
  "do_not_honor",
  "transaction_not_allowed",
  "debit_not_authorized",
]);

/**
 * Translate one Stripe code into Monacado's classification.
 *
 * Accepts `undefined` — a failure with no code at all is an ordinary Stripe
 * outcome and must not throw on the path that is already recording a failure.
 */
export function toPaymentFailureCode(stripeCode: string | undefined | null): PaymentFailureCode {
  if (stripeCode === undefined || stripeCode === null) return "UNSPECIFIED_FAILURE";
  const code = stripeCode.trim().toLowerCase();
  if (code === "") return "UNSPECIFIED_FAILURE";
  if (DECLINED_CODES.has(code)) return "DECLINED";
  if (INSTRUMENT_REJECTED_CODES.has(code)) return "INSTRUMENT_REJECTED";
  if (AUTHENTICATION_FAILED_CODES.has(code)) return "AUTHENTICATION_FAILED";
  if (PROVIDER_UNAVAILABLE_CODES.has(code)) return "PROVIDER_UNAVAILABLE";
  return "UNSPECIFIED_FAILURE";
}

/**
 * Translate the decline *reason* Stripe attaches beneath a `card_declined`.
 *
 * Read only when the outer code was `card_declined`, where Stripe's
 * `decline_code` is the more specific answer. Anything unrecognised stays
 * `DECLINED`, which is already true and already the outer code's answer.
 */
export function toPaymentFailureCodeFromDecline(
  stripeCode: string | undefined | null,
  declineCode: string | undefined | null,
): PaymentFailureCode {
  const outer = toPaymentFailureCode(stripeCode);
  if (outer !== "DECLINED" || declineCode === undefined || declineCode === null) return outer;
  const decline = declineCode.trim().toLowerCase();
  if (INSTRUMENT_REJECTED_CODES.has(decline)) return "INSTRUMENT_REJECTED";
  if (AUTHENTICATION_FAILED_CODES.has(decline)) return "AUTHENTICATION_FAILED";
  if (PROVIDER_UNAVAILABLE_CODES.has(decline)) return "PROVIDER_UNAVAILABLE";
  return "DECLINED";
}
