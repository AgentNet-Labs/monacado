/**
 * Participant payment-provider account contracts (Phase 0M.8).
 *
 * Monacado's own record of one participant's linkage to one external payment
 * provider, and the shape of an *observation* of that provider's answer. The
 * 0M.1 §9 candidate design named this record and left it unmigrated; this is it.
 *
 * Six properties shape everything below:
 *
 *   1. **The readiness lifecycle is not restated here.** `PaymentReadinessStatus`
 *      and `PAYMENT_READINESS_TRANSITIONS` are 0M.1's, imported and reused. A
 *      second copy of a state machine is a second state machine, and the two
 *      disagree the first time one is edited.
 *
 *   2. **Provider-neutral by construction.** Naming *which* provider Monacado
 *      contracted with is a Monacado fact and lives in `PAYMENT_PROVIDERS`.
 *      Nothing provider-*shaped* appears anywhere: no `charges_enabled`, no
 *      `payouts_enabled`, no `capabilities`, no `requirements.currently_due`, no
 *      `past_due`, no `disabled_reason`. The provider's model is mapped onto
 *      Monacado's, never substituted for it — a lifecycle shaped around one
 *      provider's API becomes a migration the day that changes.
 *
 *   3. **Requirements are bounded categories, never the provider's dossier.**
 *      `PAYMENT_REQUIREMENT_CODES` says *that* onboarding is incomplete and
 *      roughly in which area. It cannot say what document was rejected, whose
 *      identity failed, or what the provider's message was. Monacado needs to
 *      know onboarding is outstanding; it must not become the repository of the
 *      provider's underwriting file.
 *
 *   4. **The provider account reference is an opaque external string.** It is
 *      not a Node, not a capsule identity, not a Monacado identifier, and not a
 *      thing participant identity may be inferred from. The refinements below
 *      refuse a `mon:` form and refuse the shapes provider *secrets* take, so a
 *      key pasted into the reference field is a validation failure rather than a
 *      stored credential.
 *
 *   5. **Every input is a `strictObject`.** A raw KYC/KYB payload, a document
 *      URL, a bank detail, or a provider error body arrives as an unknown key —
 *      which is a validation failure, not a silently ignored extra. That is the
 *      privacy guarantee: not a filter someone can forget to call.
 *
 *   6. **Payment readiness is one axis.** 0M.1 models a single provider answer
 *      and `canReceivePayout` reads that one field. No payout-specific readiness
 *      is invented here; splitting the axis without a contract that asks for it
 *      would create a second answer that can disagree with the first.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { PARTICIPANT_PAYMENT_ACCOUNT_ID_RE, MARKETPLACE_PARTICIPANT_ID_RE } from "./identity";
import { PaymentReadinessStatus } from "./participant";

// — Identity —

export const ParticipantPaymentAccountId = z
  .string()
  .regex(PARTICIPANT_PAYMENT_ACCOUNT_ID_RE, "paymentAccountId must be mon:mpay:<opaque>");
export type ParticipantPaymentAccountId = z.infer<typeof ParticipantPaymentAccountId>;

const ParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "participantId must be mon:mpart:<opaque>");

// — Provider —

/**
 * Which external party Monacado contracted with for this account.
 *
 * A closed enum, and deliberately the **only** place a provider is named. Naming
 * the counterparty is a Monacado fact — the record would be meaningless without
 * it, and reconciling a reference against the wrong provider is exactly the
 * mistake it prevents. What it is not is a licence for provider-shaped state:
 * every status, requirement code, and field below is Monacado's own vocabulary,
 * and a test asserts no provider term appears in any of them.
 *
 * `STRIPE` is present because the roadmap names Stripe Connect as the intended
 * provider. **No Stripe SDK, credential, endpoint, or API call exists in this
 * phase** — the concrete adapter is deferred (see `PaymentProviderPort`).
 */
export const PAYMENT_PROVIDERS = ["STRIPE"] as const;
export const PaymentProvider = z.enum(PAYMENT_PROVIDERS);
export type PaymentProvider = z.infer<typeof PaymentProvider>;

// — Provider account reference —

/**
 * Shapes a provider account reference must never take.
 *
 * Two distinct refusals, for two distinct mistakes:
 *
 *   - **A Monacado identifier.** `mon:…` in this column would mean a Monacado
 *     identity had been stored as an external one, and the next reader would not
 *     know which layer they were holding (ADR §11.5 keeps the two apart).
 *   - **A provider secret.** Live and restricted API keys, webhook signing
 *     secrets, and bearer tokens all have recognisable prefixes. A reference
 *     field is exactly where one gets pasted, and the difference between an
 *     account id and a secret key is one autocomplete.
 *
 * A backstop, not the guarantee — the guarantee is that no column exists for a
 * credential at all. This catches the one careless caller.
 */
const FORBIDDEN_PROVIDER_REF_PREFIXES: readonly string[] = [
  "mon:",
  "sk_",
  "rk_",
  "pk_live_",
  "whsec_",
  "bearer ",
  "basic ",
];

/**
 * An opaque external identifier for the participant's account at the provider.
 *
 * Persisted for exactly one purpose: reconciling Monacado's participant with the
 * external account. It is **not** an AgentNet Node, not a capsule identity, and
 * never published. Participant identity is never inferred from it — the
 * participant FK is the only linkage, and this string is a payload.
 */
export const ProviderAccountRef = z
  .string()
  .min(1)
  .max(191)
  .refine((v) => v.trim() === v, "providerAccountRef must not carry surrounding whitespace")
  .refine(
    (v) => !FORBIDDEN_PROVIDER_REF_PREFIXES.some((p) => v.toLowerCase().startsWith(p)),
    "providerAccountRef must be an opaque external account reference, never a Monacado identifier or a provider secret",
  );
export type ProviderAccountRef = z.infer<typeof ProviderAccountRef>;

// — Outstanding requirements —

/**
 * The closed vocabulary of *categories* of outstanding provider requirement.
 *
 * Each member answers "in what area is onboarding incomplete", at the coarsest
 * granularity that still lets Monacado tell a participant where to go. None
 * carries a value: no document reference, no field name, no rejection reason, no
 * person, no provider message. A requirement code is safe to render in an
 * interface and safe to log, which is the whole reason it is an enum.
 *
 * Aligned with `PARTICIPANT_PROFILE_SECTIONS` where the areas correspond, so the
 * provider's answer and Monacado's own onboarding sections speak about the same
 * areas without one becoming a copy of the other.
 */
export const PAYMENT_REQUIREMENT_CODES = [
  /** Personal identity details are outstanding. */
  "IDENTITY_DETAILS_REQUIRED",
  /** Business structure or entity details are outstanding. */
  "BUSINESS_DETAILS_REQUIRED",
  /** Beneficial owner or representative details are outstanding. */
  "REPRESENTATIVE_DETAILS_REQUIRED",
  /** Payout configuration is outstanding. */
  "PAYOUT_DETAILS_REQUIRED",
  /** A verification document is outstanding. */
  "DOCUMENT_VERIFICATION_REQUIRED",
  /** The provider requires further verification it has not categorised. */
  "ADDITIONAL_VERIFICATION_REQUIRED",
  /** The provider's own terms have not been accepted. */
  "PROVIDER_TERMS_ACCEPTANCE_REQUIRED",
] as const;
export const PaymentRequirementCode = z.enum(PAYMENT_REQUIREMENT_CODES);
export type PaymentRequirementCode = z.infer<typeof PaymentRequirementCode>;

/**
 * The outstanding set.
 *
 * A set, not a list: order carries no meaning, and the same category twice is
 * one outstanding thing. Bounded by the vocabulary's own size, so no caller can
 * make this column grow.
 */
export const OutstandingRequirements = z
  .array(PaymentRequirementCode)
  .max(PAYMENT_REQUIREMENT_CODES.length)
  .refine((codes) => new Set(codes).size === codes.length, "requirement codes must be distinct");
export type OutstandingRequirements = z.infer<typeof OutstandingRequirements>;

/** Deterministic ordering, so a stored set round-trips byte-identically. */
export function canonicalizeRequirements(
  codes: readonly PaymentRequirementCode[],
): PaymentRequirementCode[] {
  return Array.from(new Set(codes)).sort((a, b) =>
    PAYMENT_REQUIREMENT_CODES.indexOf(a) - PAYMENT_REQUIREMENT_CODES.indexOf(b),
  );
}

// — Record —

/**
 * Monacado's authoritative record of one participant's provider linkage.
 *
 * Note what has no field, and could not be given one without changing this
 * `strictObject`: an API key, a bearer token, a webhook secret, a bank account
 * or routing number, a card number, a tax identifier, an SSN, an identity
 * document or its URL, a raw KYC/KYB payload, a provider error body, or a legal
 * name. The record carries bounded status, one opaque reference, categories,
 * timestamps, and nothing else.
 */
export const ParticipantPaymentAccountRecord = z.strictObject({
  paymentAccountId: ParticipantPaymentAccountId,
  participantId: ParticipantId,
  provider: PaymentProvider,
  providerAccountRef: ProviderAccountRef,
  /** The provider's answer as Monacado last observed it. Never Monacado's guess. */
  readiness: PaymentReadinessStatus,
  /**
   * When that answer was observed. `null` until the first observation — a
   * `NOT_STARTED` account has been linked, not yet asked.
   */
  readinessObservedAt: z.iso.datetime().nullable(),
  outstandingRequirements: OutstandingRequirements,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ParticipantPaymentAccountRecord = z.infer<typeof ParticipantPaymentAccountRecord>;

// — Inputs —

/**
 * Link one participant to one provider account.
 *
 * Created at `INITIAL_PAYMENT_READINESS` (`NOT_STARTED`) and at no other status:
 * readiness is the provider's answer, and a caller asserting one at creation
 * would be Monacado marking an unasked provider ready. There is deliberately no
 * `readiness` parameter here.
 */
export const RegisterPaymentAccountInput = z.strictObject({
  participantId: ParticipantId,
  provider: PaymentProvider,
  providerAccountRef: ProviderAccountRef,
  now: z.iso.datetime(),
});
export type RegisterPaymentAccountInput = z.infer<typeof RegisterPaymentAccountInput>;

/**
 * One observation of the provider's current answer.
 *
 * **This is an external fact, not a Monacado decision.** It is persisted with the
 * provider, the observed value, the instant it was observed, and the account
 * reference it was observed for — the four things that make it reconcilable
 * later. A transient API response is not Monacado state until this lands.
 *
 * `observedAt` is supplied rather than read from a clock, matching every other
 * service in this repository: an injected instant is what makes a fixture
 * assertable.
 */
export const RecordObservedProviderStateInput = z.strictObject({
  participantId: ParticipantId,
  provider: PaymentProvider,
  /**
   * Checked against the stored reference rather than overwriting it. An
   * observation arriving for a different account is a reconciliation failure,
   * not an update — silently re-pointing the row would rewrite which external
   * account a participant is linked to on the strength of one API response.
   */
  providerAccountRef: ProviderAccountRef,
  readiness: PaymentReadinessStatus,
  outstandingRequirements: OutstandingRequirements,
  observedAt: z.iso.datetime(),
});
export type RecordObservedProviderStateInput = z.infer<typeof RecordObservedProviderStateInput>;

// — Provider port —

/**
 * The narrow boundary between Monacado's domain and any concrete provider.
 *
 * An injected interface, and in this phase **only** an interface: no
 * implementation, no SDK dependency, no credential, no endpoint, no network
 * call. `package.json` carries no payment-provider dependency, and a test
 * asserts it.
 *
 * The port returns Monacado's own vocabulary, not the provider's. Mapping a
 * provider's requirement model onto `PaymentReadinessStatus` and
 * `PaymentRequirementCode` is the adapter's job, so nothing provider-shaped
 * reaches a service, a record, or a column. That mapping is where the concrete
 * adapter's real work will be, and it is deferred with the adapter.
 */
export interface ProviderReadinessObservation {
  provider: PaymentProvider;
  providerAccountRef: ProviderAccountRef;
  readiness: PaymentReadinessStatus;
  outstandingRequirements: PaymentRequirementCode[];
}

export interface PaymentProviderPort {
  /** Ask the provider where this account currently stands. */
  fetchReadiness(providerAccountRef: ProviderAccountRef): Promise<ProviderReadinessObservation>;
}

// — Never on this record —

/**
 * Named as never-persistable, and not admissible through any input above.
 *
 * The list is assertable rather than aspirational: every input is a
 * `strictObject`, so each of these arrives as an unknown key and fails
 * validation. A test walks the list and proves it.
 */
export const NEVER_ON_PAYMENT_ACCOUNT = [
  "password",
  "passwordHash",
  "sessionToken",
  "apiKey",
  "secretKey",
  "publishableKey",
  "accessToken",
  "refreshToken",
  "bearerToken",
  "webhookSecret",
  "clientSecret",
  "bankAccountNumber",
  "routingNumber",
  "iban",
  "cardNumber",
  "taxId",
  "vatNumber",
  "ssn",
  "dateOfBirth",
  "legalName",
  "address",
  "identityDocument",
  "documentUrl",
  "kycPayload",
  "kybPayload",
  "underwritingData",
  "providerErrorPayload",
  "rawProviderResponse",
  "stackTrace",
] as const;

/**
 * Deferred, and not admissible through a metadata bag.
 *
 * Each belongs to a named later phase. Listing them here records that their
 * absence is a decision rather than an oversight.
 */
export const DEFERRED_PAYMENT_ACCOUNT_EXTENSIONS = [
  "concreteProviderAdapter",
  "hostedOnboardingSession",
  "providerWebhookIngestion",
  "charge",
  "paymentIntent",
  "order",
  "checkout",
  "capture",
  "refund",
  "chargeback",
  "settlement",
  "payoutExecution",
  "payoutSchedule",
  "reserve",
  "payoutHold",
  "riskPolicy",
  "restrictionScope",
  "transactionCap",
  "velocityControl",
  "taxClass",
  "taxCalculation",
  "transactionLedger",
  "notificationDelivery",
  "notificationObligation",
] as const;
