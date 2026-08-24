/**
 * Tax runtime configuration (Phase 1.6) — SERVER ONLY.
 *
 * The boundary between deployment configuration and the tax adapters, following
 * `stripe-runtime-config.ts` and `mail-runtime-config.ts` deliberately rather
 * than inventing a third convention.
 *
 * Four properties:
 *
 *   1. **No secret value ever enters the parsed configuration object.** The
 *      configuration stores the *name* of the variable holding the API key, never
 *      the key. Anything that logs, serialises, or renders this object is
 *      therefore safe by construction rather than by discipline — which is what
 *      makes the operator readiness command safe to run in front of people.
 *
 *   2. **TEST MODE ONLY, and the credential is checked, not the label.** Tax
 *      calculation runs on the same Stripe credential the payment integration
 *      uses, through the same one function that refuses a live-prefixed key. Tax
 *      does not get its own, weaker door into the same account.
 *
 *   3. **Nothing is inferred.** Not where Monacado is registered, not which
 *      provider code a classification means, not whether anyone files a return.
 *      Each is either configured explicitly or reported as missing. A tax
 *      configuration that filled its own gaps would be a system asserting a
 *      fiscal position nobody took.
 *
 *   4. **Nothing is read at import time.** Configuration is resolved when a
 *      request needs it, so importing a module never touches `process.env`, and a
 *      test drives every branch by passing an environment in.
 *
 * No network call and no Stripe SDK import happens here.
 *
 * ## Why there are no default tax codes
 *
 * The obvious convenience — shipping `DIGITAL_GOOD → txcd_…` defaults so a
 * deployment works out of the box — is refused. A provider tax code is a
 * **fiscal determination about a specific business's registrations**, and a
 * default is that determination made by a repository on behalf of a company it
 * knows nothing about. Wrong, it under-collects silently and the error surfaces
 * as an assessment years later. So every classification's code is explicit
 * deployment configuration, and an unmapped classification refuses the sale.
 * `docs/PRODUCTION_TAX_INTEGRATION.md` lists the codes an operator should
 * *verify and set*, which is not the same as shipping them.
 */

import "../server-only";
import { z } from "zod";
import {
  PRODUCT_TAX_CLASSIFICATIONS,
  type ProductTaxClassification,
} from "../../contracts/product/product-tax-classification";
import { TaxProviderConfigurationError } from "./tax-errors";

export type Env = Record<string, string | undefined>;

const TRUTHY = new Set(["true", "1", "yes"]);

/** A shell-safe environment variable name. Never the value it names. */
export const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** The master switch. Anything other than true/1/yes means disabled. */
export function isTaxCalculationEnabled(env: Env = process.env): boolean {
  const raw = env.MONACADO_TAX_ENABLED;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

/** Which engine this deployment selects, uppercased and untrimmed of meaning. */
export function selectedTaxProvider(env: Env = process.env): string {
  return (env.MONACADO_TAX_PROVIDER ?? "").trim().toUpperCase();
}

// — Registration and filing posture —

/**
 * Where Monacado's tax registrations actually live.
 *
 * Stripe Tax owns registration configuration: an operator adds a registration in
 * the Stripe dashboard, and Stripe then collects for that jurisdiction. Monacado
 * cannot read that list at calculation time and **must not guess at it** — a
 * system that inferred "we are probably registered in California" would be
 * asserting a filing obligation nobody took on.
 *
 * So Monacado keeps the smallest honest thing: an explicit operator statement
 * that the provider-side registrations **have been configured deliberately**,
 * plus a free-form reference an auditor can follow back to the decision. It is
 * evidence that somebody looked, not a copy of what they found.
 */
export const REGISTRATION_POSTURES = [
  /** Nobody has stated anything. The default, and a blocker. */
  "UNCONFIGURED",
  /** An operator states the provider-side registrations are configured. */
  "PROVIDER_CONFIGURED",
] as const;
export const RegistrationPosture = z.enum(REGISTRATION_POSTURES);
export type RegistrationPosture = z.infer<typeof RegistrationPosture>;

/**
 * Who files and remits, as a stated fact rather than an assumption.
 *
 * `UNCONFIGURED` is the default and is a blocker for live commerce. It is not a
 * pedantic one: collecting tax creates an obligation to remit it, and a
 * deployment that has collected for six months without anyone naming who files is
 * a deployment with a liability and no filer.
 *
 * Neither member causes Monacado to file anything — see `TAX_FILING_BOUNDARY`.
 * They record which *external* arrangement exists.
 */
export const FILING_POSTURES = [
  "UNCONFIGURED",
  /** The provider's filing product is engaged (e.g. Stripe Tax filing). */
  "PROVIDER_MANAGED",
  /** Monacado's own finance function or its adviser files and remits. */
  "OPERATOR_MANAGED",
] as const;
export const FilingPosture = z.enum(FILING_POSTURES);
export type FilingPosture = z.infer<typeof FilingPosture>;

/**
 * The Monacado-side record that the tax integration is intentionally configured.
 *
 * Deliberately thin. It holds no jurisdiction list, no rate, no registration
 * number, and no filing calendar — every one of those would be a second copy of
 * something the provider or the operator's adviser owns authoritatively, and the
 * first divergence between the copies would be unresolvable.
 */
export const TaxComplianceConfig = z.strictObject({
  registrationPosture: RegistrationPosture,
  /**
   * A bounded operator reference to the decision — a ticket, a dated note, a
   * dashboard reference. Never a registration number and never a credential;
   * bounded characters so it cannot become a place to paste one.
   */
  registrationConfigRef: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9 :._#\/-]+$/, "registrationConfigRef must be a bounded operator reference")
    .nullable(),
  filingPosture: FilingPosture,
});
export type TaxComplianceConfig = z.infer<typeof TaxComplianceConfig>;

export function readTaxComplianceConfig(env: Env = process.env): TaxComplianceConfig {
  const registered =
    env.MONACADO_TAX_REGISTRATIONS_CONFIGURED !== undefined &&
    TRUTHY.has(env.MONACADO_TAX_REGISTRATIONS_CONFIGURED.trim().toLowerCase());
  const ref = (env.MONACADO_TAX_REGISTRATION_CONFIG_REF ?? "").trim();
  const filing = (env.MONACADO_TAX_FILING_POSTURE ?? "").trim().toUpperCase();

  const parsed = TaxComplianceConfig.safeParse({
    registrationPosture: registered ? "PROVIDER_CONFIGURED" : "UNCONFIGURED",
    registrationConfigRef: ref === "" ? null : ref,
    /* An unrecognised value is UNCONFIGURED, never a fallback to a posture
       somebody might have meant. A typo must not assert that a filer exists. */
    filingPosture: (FILING_POSTURES as readonly string[]).includes(filing)
      ? filing
      : "UNCONFIGURED",
  });
  if (!parsed.success) {
    throw new TaxProviderConfigurationError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  return parsed.data;
}

/**
 * A registration posture that is *complete*, not merely asserted.
 *
 * Claiming registrations are configured without saying where that decision is
 * recorded is half an answer, and the half that is missing is the one an auditor
 * asks for. Both halves or neither.
 */
export function registrationConfigurationIsComplete(config: TaxComplianceConfig): boolean {
  return config.registrationPosture === "PROVIDER_CONFIGURED" && config.registrationConfigRef !== null;
}

// — Stripe Tax —

/**
 * The one mode this phase supports, mirroring `STRIPE_MODES` exactly.
 *
 * A single-member enum rather than a boolean, so adding `LIVE` later is a
 * deliberate, reviewable, greppable edit. **Tax using Stripe does not widen
 * `STRIPE_MODES`**, and this list does not diverge from it: two mode vocabularies
 * over one Stripe account would eventually disagree, and the disagreement would
 * be a live charge from a deployment that believed it was in test.
 */
export const TAX_PROVIDER_MODE_SELECTIONS = ["TEST"] as const;

/** The Monacado tax-code environment variable for one classification. */
export function taxCodeEnvVarFor(classification: ProductTaxClassification): string {
  return `MONACADO_TAX_STRIPE_TAX_CODE_${classification}`;
}

/**
 * The validated, **secret-free** configuration of the Stripe Tax integration.
 *
 * `apiKeyEnvVar` is a variable NAME. Resolving it to a value happens only in
 * `stripe-runtime-config.ts`, only at the moment a request is about to be made.
 */
export const StripeTaxRuntimeConfig = z.strictObject({
  mode: z.enum(TAX_PROVIDER_MODE_SELECTIONS),
  /** The NAME of the variable holding the secret API key. Never the key. */
  apiKeyEnvVar: z.string().regex(ENV_VAR_NAME_RE, "must be an environment variable name"),
  /**
   * Monacado classification → provider tax code. Ships empty; see the header.
   *
   * A partial map is legitimate configuration: a deployment that sells only
   * software need not decide what its `PHYSICAL_GOOD` code would be. Selling one
   * it has not mapped is what refuses.
   */
  taxCodes: z.partialRecord(
    z.enum(PRODUCT_TAX_CLASSIFICATIONS),
    z.string().min(1).max(64),
  ),
  /** The provider tax code for shipping, where the deployment sets one. */
  shippingTaxCode: z.string().min(1).max(64).nullable(),
  /**
   * The version label of this mapping, pinned onto every calculation's evidence.
   *
   * What lets "we changed the SOFTWARE mapping in September" be checked against a
   * sale rather than argued about.
   */
  configVersion: z.string().min(1).max(64),
});
export type StripeTaxRuntimeConfig = z.infer<typeof StripeTaxRuntimeConfig>;

export const DEFAULT_TAX_CONFIG_VERSION = "1.6.0";

/**
 * Read the Stripe Tax block, or refuse with every issue at once.
 *
 * Refuses an unrecognised mode rather than defaulting to `TEST`: a deployment
 * that typed `MONACADO_TAX_STRIPE_MODE=LIVE` must be told that value is not
 * supported, not quietly given a test-mode integration it did not ask for.
 */
export function readStripeTaxRuntimeConfig(env: Env = process.env): StripeTaxRuntimeConfig {
  const taxCodes: Record<string, string> = {};
  for (const classification of PRODUCT_TAX_CLASSIFICATIONS) {
    const raw = (env[taxCodeEnvVarFor(classification)] ?? "").trim();
    if (raw !== "") taxCodes[classification] = raw;
  }

  const shipping = (env.MONACADO_TAX_STRIPE_SHIPPING_TAX_CODE ?? "").trim();

  const parsed = StripeTaxRuntimeConfig.safeParse({
    mode: (env.MONACADO_TAX_STRIPE_MODE ?? "TEST").trim().toUpperCase(),
    apiKeyEnvVar: (env.MONACADO_TAX_API_KEY_ENV ?? "").trim() || "MONACADO_STRIPE_SECRET_KEY",
    taxCodes,
    shippingTaxCode: shipping === "" ? null : shipping,
    configVersion:
      (env.MONACADO_TAX_CONFIG_VERSION ?? "").trim() || DEFAULT_TAX_CONFIG_VERSION,
  });
  if (!parsed.success) {
    throw new TaxProviderConfigurationError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  return parsed.data;
}

/** Classifications this deployment has mapped, and those it has not. */
export function taxCodeCoverage(config: StripeTaxRuntimeConfig): {
  mapped: ProductTaxClassification[];
  unmapped: ProductTaxClassification[];
} {
  const mapped: ProductTaxClassification[] = [];
  const unmapped: ProductTaxClassification[] = [];
  for (const classification of PRODUCT_TAX_CLASSIFICATIONS) {
    if (config.taxCodes[classification] === undefined) unmapped.push(classification);
    else mapped.push(classification);
  }
  return { mapped, unmapped };
}
