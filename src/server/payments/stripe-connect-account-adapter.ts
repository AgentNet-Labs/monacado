/**
 * The Stripe Connect readiness adapter (Phase 1.0) — SERVER ONLY.
 *
 * The concrete implementation of `0M.8`'s `PaymentProviderPort`, which that phase
 * declared and deliberately left empty. It answers one question — **where does
 * this participant's provider account stand** — and translates Stripe's answer
 * into Monacado's vocabulary before it reaches anything else.
 *
 * ## The translation is the whole job
 *
 * `0M.8` is explicit that "mapping a provider's requirement model onto
 * `PaymentReadinessStatus` and `PaymentRequirementCode` is the adapter's job, so
 * nothing provider-shaped reaches a service, a record, or a column". This file
 * is where that promise is kept. Nothing returned from here carries
 * `charges_enabled`, `currently_due`, `disabled_reason`, a Stripe requirement
 * string, an account object, or a provider message. `individual.verification.
 * document` becomes `DOCUMENT_VERIFICATION_REQUIRED` and the original string is
 * discarded — a requirement code is safe to render and safe to log, and the raw
 * string is neither.
 *
 * ## What this phase does and does not do with Connect
 *
 * **Does:** read readiness through the committed port, so
 * `syncProviderReadiness` and every `0M.1` capability decision downstream of it
 * work against a real Stripe test account rather than a stub.
 *
 * **Does:** create a test-mode Connect account and an onboarding link, as two
 * plain functions. They are **not behind a port**, because `0M.8` declared no
 * port for account creation and inventing one to hold a single Stripe call would
 * be a contract written for one implementation. What they return is a
 * `ProviderAccountRef`, which is exactly what the existing
 * `registerParticipantPaymentAccount` accepts — so the seam `0M.8` built is the
 * seam they use.
 *
 * **Does not:** execute a payout, a transfer, a destination charge, or an
 * application fee. There is no such call in this file, and no Monacado
 * `ProceedsObligation` reaches Stripe. Obligations record what is owed; moving
 * money remains unimplemented, and moving it through Connect would require the
 * payout holds, reserves, and transaction risk controls that are `0M.R2`.
 */

import "../server-only";
import {
  canonicalizeRequirements,
  ProviderAccountRef,
  type PaymentProviderPort,
  type PaymentRequirementCode,
  type ProviderReadinessObservation,
} from "../../contracts/marketplace/payment-account";
import type { PaymentReadinessStatus } from "../../contracts/marketplace/participant";
import { getStripeRuntime, type StripeRuntime } from "./stripe-client";
import type { Env } from "./stripe-runtime-config";

// — Requirement translation —

/**
 * Stripe requirement-string prefixes, in the order they are tested.
 *
 * Prefix matching rather than exact matching, because Stripe's strings are
 * hierarchical (`individual.verification.document`,
 * `individual.verification.additional_document`) and enumerating every leaf would
 * be a list that silently stops covering the space the day Stripe adds one.
 *
 * **Order matters.** The more specific prefix must be tested first, which is why
 * this is an ordered array and not an object.
 */
const REQUIREMENT_PREFIXES: ReadonlyArray<readonly [string, PaymentRequirementCode]> = [
  ["individual.verification", "DOCUMENT_VERIFICATION_REQUIRED"],
  ["company.verification", "DOCUMENT_VERIFICATION_REQUIRED"],
  ["documents", "DOCUMENT_VERIFICATION_REQUIRED"],
  ["individual", "IDENTITY_DETAILS_REQUIRED"],
  ["person", "REPRESENTATIVE_DETAILS_REQUIRED"],
  ["relationship", "REPRESENTATIVE_DETAILS_REQUIRED"],
  ["representative", "REPRESENTATIVE_DETAILS_REQUIRED"],
  ["owners", "REPRESENTATIVE_DETAILS_REQUIRED"],
  ["directors", "REPRESENTATIVE_DETAILS_REQUIRED"],
  ["executives", "REPRESENTATIVE_DETAILS_REQUIRED"],
  ["external_account", "PAYOUT_DETAILS_REQUIRED"],
  ["bank_account", "PAYOUT_DETAILS_REQUIRED"],
  ["settings.payouts", "PAYOUT_DETAILS_REQUIRED"],
  ["tos_acceptance", "PROVIDER_TERMS_ACCEPTANCE_REQUIRED"],
  ["business_profile", "BUSINESS_DETAILS_REQUIRED"],
  ["business_type", "BUSINESS_DETAILS_REQUIRED"],
  ["company", "BUSINESS_DETAILS_REQUIRED"],
  ["settings", "BUSINESS_DETAILS_REQUIRED"],
];

/**
 * Translate one Stripe requirement string.
 *
 * Anything unrecognised becomes `ADDITIONAL_VERIFICATION_REQUIRED` — "the
 * provider requires further verification it has not categorised". Stripe's list
 * grows, and an honest "something else is outstanding" beats forcing a new string
 * into the nearest-looking bucket and telling a participant to go fix the wrong
 * thing.
 */
export function toRequirementCode(requirement: string): PaymentRequirementCode {
  const key = requirement.trim().toLowerCase();
  for (const [prefix, code] of REQUIREMENT_PREFIXES) {
    if (key === prefix || key.startsWith(`${prefix}.`)) return code;
  }
  return "ADDITIONAL_VERIFICATION_REQUIRED";
}

/** Categories, deduplicated and canonically ordered, from raw Stripe strings. */
export function toRequirementCodes(
  requirements: ReadonlyArray<string | null | undefined>,
): PaymentRequirementCode[] {
  const codes: PaymentRequirementCode[] = [];
  for (const raw of requirements) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    codes.push(toRequirementCode(raw));
  }
  return canonicalizeRequirements(codes);
}

// — Readiness translation —

/**
 * Stripe disabled reasons that mean **the account is finished**, not waiting.
 *
 * Everything else Stripe calls a "disabled reason" is really "we are waiting on
 * you" or "we are deciding", and mapping those to `DISABLED` would tell a
 * participant to give up on an account they could still complete.
 */
const TERMINAL_DISABLED_REASONS: ReadonlySet<string> = new Set([
  "rejected.fraud",
  "rejected.incomplete_verification",
  "rejected.listed",
  "rejected.other",
  "rejected.platform_fraud",
  "rejected.platform_other",
  "rejected.platform_terms_of_service",
  "rejected.terms_of_service",
  "platform_paused",
]);

interface RequirementsShape {
  currently_due?: Array<string> | null;
  past_due?: Array<string> | null;
  eventually_due?: Array<string> | null;
  pending_verification?: Array<string> | null;
  disabled_reason?: string | null;
}

/**
 * Decide where an account stands, in Monacado's six-member vocabulary.
 *
 * The ordering encodes what matters most, and each step is a judgement worth
 * stating:
 *
 *   1. **Terminally rejected** → `DISABLED`. Nothing the participant does fixes it.
 *   2. **Something is due from the participant** → `DETAILS_REQUIRED`, whether or
 *      not charges currently work. `RESTRICTED` would say "the provider withheld
 *      something"; the truth is Monacado is waiting on the participant, and those
 *      lead to different messages.
 *   3. **Stripe is reviewing** → `PENDING_PROVIDER`. Monacado waits.
 *   4. **Charges and payouts both live** → `ENABLED`.
 *   5. **Previously working, now partly withheld** → `RESTRICTED`.
 *   6. **Nothing has happened yet** → `NOT_STARTED`.
 */
export function toReadinessStatus(account: {
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  requirements?: RequirementsShape | null;
}): PaymentReadinessStatus {
  const requirements = account.requirements ?? {};
  const disabledReason = requirements.disabled_reason ?? null;
  if (disabledReason !== null && TERMINAL_DISABLED_REASONS.has(disabledReason)) {
    return "DISABLED";
  }

  const due = [...(requirements.currently_due ?? []), ...(requirements.past_due ?? [])];
  if (due.length > 0) return "DETAILS_REQUIRED";

  if ((requirements.pending_verification ?? []).length > 0) return "PENDING_PROVIDER";

  const charges = account.charges_enabled === true;
  const payouts = account.payouts_enabled === true;
  if (charges && payouts) return "ENABLED";

  /* Nothing due, nothing pending, and the account still cannot both charge and
     pay out. Something was withheld by the provider after onboarding completed —
     which is precisely what RESTRICTED names. */
  if (account.details_submitted === true) return "RESTRICTED";

  return "NOT_STARTED";
}

// — The port —

export interface StripeConnectDeps {
  runtime?: StripeRuntime;
  env?: Env;
}

function resolveRuntime(deps: StripeConnectDeps): StripeRuntime {
  return deps.runtime ?? getStripeRuntime(deps.env);
}

/**
 * Ask Stripe where one participant's Connect account stands.
 *
 * Read-only. It retrieves an account and returns Monacado's vocabulary; it does
 * not create, update, enable, disable, or pay anything. Whether the observation
 * becomes Monacado state is `recordObservedProviderState`'s decision, and `0M.8`
 * is explicit that a transient port response is not state until it commits.
 *
 * The requirement set is drawn from `currently_due`, `past_due`, **and**
 * `pending_verification` together: all three are things outstanding at the
 * provider, and a participant reading "nothing outstanding" while Stripe reviews
 * a document would be reading something false.
 */
export function createStripeConnectReadinessPort(
  deps: StripeConnectDeps = {},
): PaymentProviderPort {
  return {
    async fetchReadiness(rawRef) {
      const providerAccountRef = ProviderAccountRef.parse(rawRef);
      const { client } = resolveRuntime(deps);
      const account = await client.accounts.retrieve(providerAccountRef);
      const requirements: RequirementsShape = account.requirements ?? {};

      const observation: ProviderReadinessObservation = {
        provider: "STRIPE",
        providerAccountRef,
        readiness: toReadinessStatus(account),
        outstandingRequirements: toRequirementCodes([
          ...(requirements.currently_due ?? []),
          ...(requirements.past_due ?? []),
          ...(requirements.pending_verification ?? []),
        ]),
      };
      return observation;
    },
  };
}

// — Test-mode onboarding, deliberately not a port —

/**
 * Create a Stripe **test-mode** Connect account and return its opaque reference.
 *
 * Returns a `ProviderAccountRef` and nothing else — no account object, no
 * capabilities hash, no requirements list. The caller's next step is
 * `registerParticipantPaymentAccount`, which is the only thing in the repository
 * that may persist the reference, and which already refuses a credential-shaped
 * string in that field.
 *
 * **No participant data is sent.** Not a name, not an email, not a tax
 * identifier, not an address. Monacado does not hold most of it, and what it does
 * hold is not Stripe's to receive merely because an account is being opened;
 * onboarding collects it from the participant directly, on Stripe's own hosted
 * form, which is the arrangement that keeps it off Monacado's disks.
 */
export async function createTestModeConnectAccount(
  args: { country: string },
  deps: StripeConnectDeps = {},
): Promise<ProviderAccountRef> {
  const { client } = resolveRuntime(deps);
  const account = await client.accounts.create({
    controller: {
      /* Stripe collects and owns the onboarding requirements and shows the
         participant their own dashboard. Monacado neither gathers nor stores
         the identity documents Connect requires. */
      stripe_dashboard: { type: "express" },
      fees: { payer: "application" },
      losses: { payments: "application" },
    },
    country: args.country,
    capabilities: { transfers: { requested: true } },
  });
  return ProviderAccountRef.parse(account.id);
}

/**
 * A one-time hosted onboarding URL for a Connect account.
 *
 * Short-lived and single-use by Stripe's own design, which is why it is generated
 * on demand and **persisted nowhere** — a stored onboarding link is a stale
 * bearer capability sitting in a column.
 */
export async function createConnectOnboardingLink(
  args: { providerAccountRef: string; refreshUrl: string; returnUrl: string },
  deps: StripeConnectDeps = {},
): Promise<string> {
  const { client } = resolveRuntime(deps);
  const link = await client.accountLinks.create({
    account: ProviderAccountRef.parse(args.providerAccountRef),
    refresh_url: args.refreshUrl,
    return_url: args.returnUrl,
    type: "account_onboarding",
  });
  return link.url;
}
