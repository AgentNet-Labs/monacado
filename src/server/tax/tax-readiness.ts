/**
 * Tax production readiness (Phase 1.6) — SERVER ONLY.
 *
 * One question, answered in one place: **is this deployment's tax integration
 * fit to charge real buyers?**
 *
 * ## It reads configuration, and calls nobody
 *
 * `1.2`'s live-readiness check probed the tax port by *performing a calculation*.
 * That was safe while every adapter was a local test double and is **not** safe
 * now: with Stripe Tax selected, a readiness check would have made a live API
 * call to a payment provider every time an operator ran it, from a command
 * documented as read-only. This module is pure configuration inspection — no
 * network, no database, no clock, no credential value read.
 *
 * That is a deliberate narrowing of what "operational" can mean here. A
 * configuration check cannot prove the engine answers; it can prove the
 * deployment has decided everything the engine needs. Proving the engine answers
 * is a test-mode calculation somebody performs on purpose, not a side effect of
 * asking whether the configuration is complete.
 *
 * ## It infers nothing
 *
 * Not where Monacado is registered, not whether anyone files a return, not what
 * `SOFTWARE` should map to. Each is configured explicitly or reported missing.
 * A readiness check that filled its own gaps would be a system asserting a fiscal
 * position nobody took — and it would assert it in the one document an operator
 * reads *instead of* checking.
 *
 * ## Nothing here can pass while live commerce is impossible
 *
 * `LIVE_PROVIDER_NOT_ENABLED` is reported by construction, exactly as
 * `live-commerce-readiness.ts` reports it: `STRIPE_MODES` has one member, so no
 * configuration can satisfy it. Tax being ready to calculate and Monacado being
 * permitted to charge live are different questions, and this reports both
 * separately rather than collapsing them into one optimistic boolean.
 */

import "../server-only";
import {
  PRODUCTION_TAX_PROVIDERS,
  TAX_FILING_BOUNDARY,
  TaxProvider,
} from "../../contracts/marketplace/tax-calculation";
import type { ProductTaxClassification } from "../../contracts/product/product-tax-classification";
import { STRIPE_MODES } from "../payments/stripe-runtime-config";
import { TaxProviderConfigurationError } from "./tax-errors";
import {
  isTaxCalculationEnabled,
  readStripeTaxRuntimeConfig,
  readTaxComplianceConfig,
  registrationConfigurationIsComplete,
  selectedTaxProvider,
  taxCodeCoverage,
  taxCodeEnvVarFor,
  type Env,
  type FilingPosture,
  type RegistrationPosture,
} from "./tax-runtime-config";

/**
 * Why tax is not ready, as a closed vocabulary.
 *
 * Bounded codes rather than sentences, on the same terms as every other reason
 * vocabulary here: safe to log, safe to render on an operations page, and
 * carrying no credential, threshold, jurisdiction, or party.
 */
export const TAX_READINESS_BLOCKER_CODES = [
  /** The master switch is off. Checkout cannot establish a tax amount at all. */
  "TAX_CALCULATION_NOT_CONFIGURED",
  /** A provider is named that this deployment does not implement. */
  "TAX_PROVIDER_NOT_RECOGNISED",
  /** The named provider is a test adapter and must never govern real commerce. */
  "TAX_PROVIDER_NOT_PRODUCTION_CAPABLE",
  /** The provider block is present but malformed or incomplete. */
  "TAX_PROVIDER_CONFIGURATION_INVALID",
  /** The credential the provider needs is not named, or is not test mode. */
  "TAX_PROVIDER_CREDENTIAL_NOT_CONFIGURED",
  /** No Monacado classification is mapped to a provider tax code. */
  "PRODUCT_TAX_CLASSIFICATION_MAPPING_REQUIRED",
  /**
   * Tax can be calculated but not **reported** (Phase 1.7).
   *
   * A deployment able to price a sale and unable to record the provider Tax
   * Transaction collects tax that never reaches a return. Distinct from
   * calculation readiness precisely so clearing one cannot look like clearing
   * both.
   */
  "TAX_TRANSACTION_RECORDING_NOT_AVAILABLE",
  /** Nobody has stated that provider-side registrations are configured. */
  "REGISTRATION_CONFIGURATION_REQUIRED",
  /** Nobody has stated who files and remits what is collected. */
  "FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED",
  /** Live provider support does not exist. Cleared only by a reviewed phase. */
  "LIVE_PROVIDER_NOT_ENABLED",
] as const;
export type TaxReadinessBlockerCode = (typeof TAX_READINESS_BLOCKER_CODES)[number];

/**
 * The headline state, for an operator who reads one line.
 *
 * Ordered by which blocker is most fundamental, and reported as the *first*
 * unresolved one rather than a list — the list is right there in `blockers`, and
 * a headline that said four things at once would be a headline nobody reads.
 */
export const TAX_READINESS_STATES = [
  /** Every control the calculation needs is configured. */
  "CALCULATION_READY",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_CONFIGURATION_REQUIRED",
  "PRODUCT_CLASSIFICATION_CONFIGURATION_REQUIRED",
  /** Calculation is configured; the post-payment recording half is not. */
  "TAX_TRANSACTION_RECORDING_REQUIRED",
  "REGISTRATION_CONFIGURATION_REQUIRED",
  "FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED",
] as const;
export type TaxReadinessState = (typeof TAX_READINESS_STATES)[number];

export interface TaxReadinessReport {
  /** The selected provider, or `null` where the name is unrecognised. */
  provider: TaxProvider | null;
  /** What the deployment literally set, so a typo is visible rather than erased. */
  selectedProviderName: string;
  /** Only ever `TEST` in this phase. `null` when no provider is configured. */
  providerMode: "TEST" | null;
  enabled: boolean;
  productionCapableProvider: boolean;
  /**
   * Whether every control a calculation needs is present.
   *
   * **Configuration completeness, not proof of service.** See the module header.
   */
  calculationConfigured: boolean;
  /**
   * Whether this deployment can **report** a paid sale to the provider (1.7).
   *
   * A separate answer from `calculationConfigured`, and deliberately so: pricing
   * a sale and recording it are different capabilities, and a system that can do
   * the first but not the second collects tax that never reaches a return.
   */
  taxTransactionRecordingAvailable: boolean;
  /**
   * Whether the **whole** tax lifecycle — calculate, then report — is available.
   *
   * Still not a filing claim. Recording transactions is what makes a provider's
   * reports contain Monacado's sales; who files them remains a separate,
   * separately-stated posture.
   */
  taxLifecycleReady: boolean;
  state: TaxReadinessState;
  blockers: TaxReadinessBlockerCode[];
  satisfied: string[];
  /** Variable NAMES only — the whole report is safe to print. */
  requiredEnvVars: { present: string[]; missing: string[] };
  classificationMapping: {
    mapped: ProductTaxClassification[];
    unmapped: ProductTaxClassification[];
  };
  registration: {
    posture: RegistrationPosture;
    configRefPresent: boolean;
    complete: boolean;
  };
  filing: {
    posture: FilingPosture;
    /** What this repository actually does about filing: nothing. */
    monacadoFiles: false;
    providerRecordsTransactions: boolean;
    /** Stated so a reader cannot mistake `1.7` for a filing capability. */
    recordingImpliesFilingReadiness: false;
  };
  /** Always `false` in this phase, by construction. */
  liveTaxCommercePermitted: boolean;
  evaluatedAt: string;
}

/**
 * Is a credential *named and present*, without reading its value.
 *
 * Presence and test-mode shape are checked; the value is never returned, never
 * stored, and never included in the report. The prefix check is why an operator
 * running this before launch finds a live key that a `MODE=TEST` label would have
 * hidden — and the report says only which variable, never what is in it.
 */
function credentialPosture(
  apiKeyEnvVar: string,
  env: Env,
): "PRESENT_TEST_MODE" | "MISSING" | "NOT_TEST_MODE" {
  const raw = env[apiKeyEnvVar];
  if (raw === undefined || raw.trim() === "") return "MISSING";
  return raw.trim().startsWith("sk_test_") ? "PRESENT_TEST_MODE" : "NOT_TEST_MODE";
}

/**
 * Evaluate the tax integration's production readiness.
 *
 * Read-only in the strongest sense: no write, no configuration change, no
 * provider contact, no database access, and no secret value in the result. An
 * unreadable control counts as a **blocker**, never as satisfied — a check that
 * cannot run has not passed.
 */
export function evaluateTaxReadiness(at: string, env: Env = process.env): TaxReadinessReport {
  const blockers: TaxReadinessBlockerCode[] = [];
  const satisfied: string[] = [];
  const present: string[] = [];
  const missing: string[] = [];

  const enabled = isTaxCalculationEnabled(env);
  const selectedName = selectedTaxProvider(env);
  const parsedProvider = TaxProvider.safeParse(selectedName);
  const provider = parsedProvider.success ? parsedProvider.data : null;
  const productionCapable =
    provider !== null && PRODUCTION_TAX_PROVIDERS.includes(provider);

  if (!enabled) {
    blockers.push("TAX_CALCULATION_NOT_CONFIGURED");
    missing.push("MONACADO_TAX_ENABLED");
  } else {
    present.push("MONACADO_TAX_ENABLED");
    satisfied.push("TAX_CALCULATION_ENABLED");
  }

  if (selectedName === "") {
    missing.push("MONACADO_TAX_PROVIDER");
    if (enabled) blockers.push("TAX_PROVIDER_NOT_RECOGNISED");
  } else {
    present.push("MONACADO_TAX_PROVIDER");
    if (provider === null) blockers.push("TAX_PROVIDER_NOT_RECOGNISED");
    else if (!productionCapable) {
      /* A test adapter returning a plausible number is MORE dangerous than no
         engine, because its answers look calculated. */
      blockers.push("TAX_PROVIDER_NOT_PRODUCTION_CAPABLE");
    } else satisfied.push("TAX_PROVIDER_SELECTED");
  }

  // — The provider block, read only when a production provider is selected —

  let mapping: { mapped: ProductTaxClassification[]; unmapped: ProductTaxClassification[] } = {
    mapped: [],
    unmapped: [],
  };
  let providerMode: "TEST" | null = null;

  if (productionCapable) {
    try {
      const config = readStripeTaxRuntimeConfig(env);
      providerMode = config.mode;
      mapping = taxCodeCoverage(config);

      const posture = credentialPosture(config.apiKeyEnvVar, env);
      if (posture === "PRESENT_TEST_MODE") {
        present.push(config.apiKeyEnvVar);
        satisfied.push("TAX_PROVIDER_CREDENTIAL");
      } else {
        /* `NOT_TEST_MODE` is reported through the same blocker as `MISSING`
           deliberately: neither may be used, and distinguishing them in a code
           would tell a reader of the report something about the credential's
           shape. The env var NAME in `missing` is enough to act on. */
        missing.push(config.apiKeyEnvVar);
        blockers.push("TAX_PROVIDER_CREDENTIAL_NOT_CONFIGURED");
      }

      if (mapping.mapped.length === 0) {
        blockers.push("PRODUCT_TAX_CLASSIFICATION_MAPPING_REQUIRED");
      } else satisfied.push("PRODUCT_TAX_CLASSIFICATION_MAPPING");
      for (const classification of mapping.mapped) present.push(taxCodeEnvVarFor(classification));
      for (const classification of mapping.unmapped) missing.push(taxCodeEnvVarFor(classification));
    } catch (error) {
      if (error instanceof TaxProviderConfigurationError) {
        blockers.push("TAX_PROVIDER_CONFIGURATION_INVALID");
      } else throw error;
    }
  }

  // — Registration and filing: stated, or missing. Never inferred. —

  const compliance = readTaxComplianceConfig(env);
  const registrationComplete = registrationConfigurationIsComplete(compliance);
  if (registrationComplete) {
    satisfied.push("TAX_REGISTRATION_CONFIGURATION");
    present.push("MONACADO_TAX_REGISTRATIONS_CONFIGURED", "MONACADO_TAX_REGISTRATION_CONFIG_REF");
  } else {
    blockers.push("REGISTRATION_CONFIGURATION_REQUIRED");
    if (compliance.registrationPosture !== "PROVIDER_CONFIGURED") {
      missing.push("MONACADO_TAX_REGISTRATIONS_CONFIGURED");
    }
    if (compliance.registrationConfigRef === null) {
      missing.push("MONACADO_TAX_REGISTRATION_CONFIG_REF");
    }
  }

  if (compliance.filingPosture === "UNCONFIGURED") {
    /* Collecting tax creates an obligation to remit it. A deployment that has
       collected for six months with nobody named as filer has a liability and no
       filer, and that is not a pedantic blocker. */
    blockers.push("FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED");
    missing.push("MONACADO_TAX_FILING_POSTURE");
  } else {
    satisfied.push("TAX_FILING_POSTURE_STATED");
    present.push("MONACADO_TAX_FILING_POSTURE");
  }

  // — Tax transaction recording (Phase 1.7) —
  //
  // Recording a paid sale needs exactly what calculating one needs: the same
  // provider, the same test-mode credential, the same configuration block. What
  // it does NOT need is a classification mapping — the transaction is created
  // from a calculation Stripe already holds, not from a fresh classification.
  //
  // So the capability is reported separately rather than folded in: they are
  // different questions, and a deployment that can price a sale but cannot
  // report it collects tax that never reaches a return.
  const recordingAvailable =
    productionCapable &&
    !blockers.includes("TAX_PROVIDER_CONFIGURATION_INVALID") &&
    !blockers.includes("TAX_PROVIDER_CREDENTIAL_NOT_CONFIGURED");
  if (recordingAvailable) satisfied.push("TAX_TRANSACTION_RECORDING");
  else if (enabled) blockers.push("TAX_TRANSACTION_RECORDING_NOT_AVAILABLE");

  // — Live commerce, by construction —

  const liveSupported = (STRIPE_MODES as readonly string[]).includes("LIVE");
  if (!liveSupported) blockers.push("LIVE_PROVIDER_NOT_ENABLED");

  /* Calculation readiness deliberately EXCLUDES registration and filing: a
     deployment can be able to calculate correctly while still owing the
     compliance decisions. Reporting them as one number would let clearing the
     easy half look like clearing both. */
  const calculationBlockers: readonly TaxReadinessBlockerCode[] = [
    "TAX_CALCULATION_NOT_CONFIGURED",
    "TAX_PROVIDER_NOT_RECOGNISED",
    "TAX_PROVIDER_NOT_PRODUCTION_CAPABLE",
    "TAX_PROVIDER_CONFIGURATION_INVALID",
    "TAX_PROVIDER_CREDENTIAL_NOT_CONFIGURED",
    "PRODUCT_TAX_CLASSIFICATION_MAPPING_REQUIRED",
  ];
  const calculationConfigured = !blockers.some((b) => calculationBlockers.includes(b));

  /* The WHOLE lifecycle: price it, then report it. Deliberately not a filing
     claim — recording transactions is what makes a provider's reports contain
     Monacado's sales; who files them is a separate, separately-stated posture. */
  const taxLifecycleReady = calculationConfigured && recordingAvailable;

  const state: TaxReadinessState = !enabled
    ? "PROVIDER_NOT_CONFIGURED"
    : blockers.includes("TAX_PROVIDER_NOT_RECOGNISED") ||
        blockers.includes("TAX_PROVIDER_NOT_PRODUCTION_CAPABLE") ||
        blockers.includes("TAX_PROVIDER_CONFIGURATION_INVALID") ||
        blockers.includes("TAX_PROVIDER_CREDENTIAL_NOT_CONFIGURED")
      ? "PROVIDER_CONFIGURATION_REQUIRED"
      : blockers.includes("PRODUCT_TAX_CLASSIFICATION_MAPPING_REQUIRED")
        ? "PRODUCT_CLASSIFICATION_CONFIGURATION_REQUIRED"
        : blockers.includes("TAX_TRANSACTION_RECORDING_NOT_AVAILABLE")
          ? "TAX_TRANSACTION_RECORDING_REQUIRED"
          : blockers.includes("REGISTRATION_CONFIGURATION_REQUIRED")
            ? "REGISTRATION_CONFIGURATION_REQUIRED"
            : blockers.includes("FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED")
              ? "FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED"
              : "CALCULATION_READY";

  return {
    provider,
    selectedProviderName: selectedName,
    providerMode,
    enabled,
    productionCapableProvider: productionCapable,
    calculationConfigured,
    taxTransactionRecordingAvailable: recordingAvailable,
    taxLifecycleReady,
    state,
    blockers,
    satisfied,
    requiredEnvVars: {
      present: Array.from(new Set(present)),
      missing: Array.from(new Set(missing)),
    },
    classificationMapping: mapping,
    registration: {
      posture: compliance.registrationPosture,
      configRefPresent: compliance.registrationConfigRef !== null,
      complete: registrationComplete,
    },
    filing: {
      posture: compliance.filingPosture,
      monacadoFiles: false,
      providerRecordsTransactions: TAX_FILING_BOUNDARY.providerRecordsTransactions,
      /* Reporting transactions is NOT filing readiness. A provider whose reports
         now contain Monacado's sales still needs somebody named to file them. */
      recordingImpliesFilingReadiness: false,
    },
    /* By construction, and not a placeholder: live-mode support does not exist,
       so no configuration can make this true. */
    liveTaxCommercePermitted: liveSupported && blockers.length === 0,
    evaluatedAt: at,
  };
}
