/**
 * Phase 1.12 — dispute evidence response, and Marketplace Policy 1.2.0.
 *
 * Pure. No database, no network, no credential, no Stripe client. Every provider
 * object below is a plain literal shaped like what the pinned SDK types describe
 * — which is the point: if the adapter ever needed a real client to be tested, it
 * would be reaching one at runtime too.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DISPUTE_EVIDENCE_FILE_STORAGE_GAP,
  DISPUTE_EVIDENCE_PREPARATION_TRANSITIONS,
  DISPUTE_EVIDENCE_SUBMISSION_FAILURE_CODES,
  MONACADO_REPRESENTMENT_RULING,
  SELLER_DEFENSE_WORKFLOW,
  SELLER_EVIDENCE_INPUT_LIMITATION,
  DISPUTE_EVIDENCE_PREPARATION_STATUSES,
  NEVER_SUBMITTED_TO_PROVIDER,
  SELLER_ATTESTATION_CLAIMS,
  SUBMITTABLE_EVIDENCE_FIELDS,
  disputeEvidenceCompletenessFor,
  isRetryableDisputeEvidenceFailure,
  isValidDisputeEvidencePreparationTransition,
  type DisputeEvidencePreparationStatus,
} from "../src/contracts/marketplace/dispute-evidence";
import {
  classifyStripeDisputeEvidenceError,
  createStripeDisputeEvidenceAdapter,
  type StripeDisputeEvidenceClient,
} from "../src/server/payments/stripe-dispute-evidence-adapter";
import { disputeEvidenceIdempotencyKey } from "../src/server/marketplace/dispute-evidence-idempotency";
import { evaluateDisputeReadiness } from "../src/server/operations/dispute-readiness";
import { DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE } from "../src/contracts/marketplace/dispute-operations";
import {
  LATEST_MARKETPLACE_POLICY_VERSION,
  MARKETPLACE_POLICY_ONBOARDING_ACCEPTANCE,
  MARKETPLACE_POLICY_VERSION_1_2,
  MONACADO_MARKETPLACE_POLICY_V1,
  MONACADO_MARKETPLACE_POLICY_V1_1,
  MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_2,
  MONACADO_MARKETPLACE_POLICY_V1_2_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_HASH,
  marketplacePolicyDocument,
} from "../src/contracts/marketplace/marketplace-policy-content";
import {
  REFUND_GOVERNANCE_SECTION_KEYS,
  selectSection,
  selectSectionsForAudience,
} from "../src/contracts/marketplace/marketplace-policy";
import {
  SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT,
  SELLER_CHARGEBACK_FEE_POLICY_KEY,
  SELLER_CHARGEBACK_FEE_RULES,
  chargebackFeeAppliesTo,
} from "../src/contracts/marketplace/chargeback-fee";
import {
  DISPUTE_EVIDENCE_SUBMISSION_SEAM,
  DISPUTE_EXECUTION_DEFERRAL,
  FRAUD_AND_RISK_ANALYTICS_HANDOFF,
} from "../src/contracts/marketplace/transaction-dispute";
import { DISPUTE_NOTIFICATION_CONTEXT_CODES } from "../src/contracts/marketplace/notification-obligation";
import { OUTBOUND_EMAIL_PURPOSES } from "../src/contracts/marketplace/outbound-email";
import { NEVER_IN_DISPUTE_CAPSULE } from "../src/contracts/marketplace/dispute.capsule";
import { capsuleVisibilityFor } from "../src/contracts/capsule/visibility";

const readSource = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), "utf8");

const readCode = (relative: string): string =>
  readSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// — Provider fixtures —

const NOW = new Date("2028-09-14T09:00:00.000Z");
const DUE_BY_SECONDS = Math.floor(new Date("2028-09-20T09:00:00.000Z").getTime() / 1000);

const dispute = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "dp_test_1",
  object: "dispute",
  livemode: false,
  status: "needs_response",
  evidence_details: {
    due_by: DUE_BY_SECONDS,
    has_evidence: false,
    past_due: false,
    submission_count: 0,
  },
  ...overrides,
});

interface Recorded {
  updates: Array<{ id: string; params: Record<string, unknown>; options?: unknown }>;
  retrieves: string[];
}

function makeClient(
  onRetrieve: () => unknown,
  onUpdate: () => unknown,
): { client: StripeDisputeEvidenceClient; recorded: Recorded } {
  const recorded: Recorded = { updates: [], retrieves: [] };
  const client = {
    retrieveDispute: async (id: string) => {
      recorded.retrieves.push(id);
      const result = onRetrieve();
      if (result instanceof Error) throw result;
      return result;
    },
    updateDispute: async (id: string, params: Record<string, unknown>, options?: unknown) => {
      recorded.updates.push({ id, params, options });
      const result = onUpdate();
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as StripeDisputeEvidenceClient;
  return { client, recorded };
}

/* No gate variable exists any more. Kept as an empty env so the provider
   fixtures below read unchanged. */
const ENABLED_ENV = {} as Record<string, string>;

const REQUEST = {
  disputeId: "mon:dspt:X",
  providerDisputeRef: "dp_test_1",
  preparationId: "mon:evprp:X",
  evidence: { service_date: "2028-09-01T00:00:00.000Z" },
  finalSubmission: true,
  idempotencyKey: "mon-dsevd-abc",
  observedSubmissionCount: 0,
};

// ---------------------------------------------------------------------------

describe("1.12 — the provider's evidence surface, as the pinned SDK states it", () => {
  it("submits through dispute update, because the SDK has no submit method", async () => {
    const { client, recorded } = makeClient(
      () => dispute(),
      () => dispute({ evidence_details: { ...(dispute().evidence_details as object), submission_count: 1 } }),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence(REQUEST);
    expect(result.outcome).toBe("SUBMITTED");
    expect(recorded.updates).toHaveLength(1);
    expect(recorded.updates[0]!.id).toBe("dp_test_1");
  });

  it("never omits the submit flag, because the provider defaults it to true", async () => {
    const { client, recorded } = makeClient(
      () => dispute(),
      () => dispute({ evidence_details: { due_by: DUE_BY_SECONDS, has_evidence: true, past_due: false, submission_count: 1 } }),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    await port.submitEvidence(REQUEST);
    /* The single most dangerous ergonomic in the wrapped API: an omitted flag
       finalises the response. */
    expect("submit" in recorded.updates[0]!.params).toBe(true);
    expect(recorded.updates[0]!.params.submit).toBe(true);
  });

  it("distinguishes staged evidence from a final submission", async () => {
    const { client, recorded } = makeClient(
      () => dispute(),
      () => dispute({ evidence_details: { due_by: DUE_BY_SECONDS, has_evidence: true, past_due: false, submission_count: 0 } }),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence({ ...REQUEST, finalSubmission: false });
    expect(result.outcome).toBe("STAGED");
    expect(recorded.updates[0]!.params.submit).toBe(false);
  });

  it("treats the submission counter as the only proof finality took", async () => {
    /* `has_evidence` reports STAGING. A response whose counter did not move did
       not reach the bank, and reporting success would record a false fact. */
    const { client } = makeClient(
      () => dispute(),
      () => dispute({ evidence_details: { due_by: DUE_BY_SECONDS, has_evidence: true, past_due: false, submission_count: 0 } }),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence(REQUEST);
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome === "REFUSED") expect(result.retryable).toBe(true);
  });
});

describe("1.12 — the §I representment ruling is resolved", () => {
  it("records the ruling rather than a hold", () => {
    expect(MONACADO_REPRESENTMENT_RULING.ruling).toBe("RESOLVED");
    expect(MONACADO_REPRESENTMENT_RULING.responsibility).toBe("MONACADO_ALWAYS_RESPONDS");
    expect(MONACADO_REPRESENTMENT_RULING.supersedes).toBe(
      "MONACADO_MOR_BUSINESS_MODEL_SECTION_I_UNRESOLVED",
    );
  });

  it("leaves no constant anywhere still claiming the ruling is outstanding", () => {
    /* The correction's whole point. A stale `requiresRuling` would send an
       operator looking for a decision that has already been made. */
    for (const path of [
      "src/contracts/marketplace/dispute-evidence.ts",
      "src/contracts/marketplace/transaction-dispute.ts",
      "src/server/operations/dispute-readiness.ts",
      "src/server/payments/stripe-dispute-evidence-adapter.ts",
      "src/server/marketplace/dispute-evidence-service.ts",
      "scripts/dispute-evidence.ts",
    ]) {
      const code = readCode(path);
      expect(code, path).not.toContain("requiresRuling");
      expect(code, path).not.toContain("SUBMISSION_NOT_ENABLED");
      expect(code, path).not.toContain("isDisputeEvidenceSubmissionEnabled");
    }
  });

  it("keeps the seller heard without putting the seller in charge", () => {
    expect(MONACADO_REPRESENTMENT_RULING.sellerMustBeNotified).toBe(true);
    expect(MONACADO_REPRESENTMENT_RULING.sellerMayDefend).toBe(true);
    expect(MONACADO_REPRESENTMENT_RULING.sellerEvidenceDestination).toBe("MONACADO_ONLY");
    expect(MONACADO_REPRESENTMENT_RULING.sellerMayContactNetwork).toBe(false);
    expect(MONACADO_REPRESENTMENT_RULING.finalDecision).toBe("MONACADO");
    expect(MONACADO_REPRESENTMENT_RULING.providerSubmission).toBe("MONACADO");
    /* The load-bearing negative. */
    expect(MONACADO_REPRESENTMENT_RULING.sellerInputDelegatesAuthority).toBe(false);
  });

  it("states the seller defence path in order, with the provider last", () => {
    expect([...SELLER_DEFENSE_WORKFLOW]).toEqual([
      "DISPUTE_NOTICE",
      "SELLER_EVIDENCE_OPPORTUNITY",
      "MONACADO_REVIEW",
      "MONACADO_PROVIDER_RESPONSE",
    ]);
  });

  it("preserves the seller-input limitation explicitly", () => {
    /* The ruling grants an opportunity to supply a defence AND supporting proof.
       Monacado can take the first and cannot yet take the second, and the gap is
       in the channel rather than the policy. */
    expect(SELLER_EVIDENCE_INPUT_LIMITATION.structuredAttestation).toBe("IMPLEMENTED");
    expect(SELLER_EVIDENCE_INPUT_LIMITATION.documentUpload).toBe("NOT_IMPLEMENTED");
    expect(SELLER_EVIDENCE_INPUT_LIMITATION.selfServicePage).toBe("NOT_IMPLEMENTED");
  });

  it("submits once authorised, with no environment gate in the way", async () => {
    const { client, recorded } = makeClient(
      () => dispute(),
      () =>
        dispute({
          evidence_details: { due_by: DUE_BY_SECONDS, has_evidence: true, past_due: false, submission_count: 1 },
        }),
    );
    /* An empty env: no gate variable anywhere, and the send still happens. */
    const port = createStripeDisputeEvidenceAdapter({ env: {}, client, now: () => NOW });
    const result = await port.submitEvidence(REQUEST);
    expect(result.outcome).toBe("SUBMITTED");
    expect(recorded.updates).toHaveLength(1);
  });
});

describe("1.12 — textual evidence only, and no buyer identity crosses the boundary", () => {
  it("sends only fields the SDK types as plain strings", () => {
    for (const field of SUBMITTABLE_EVIDENCE_FIELDS) {
      expect(NEVER_SUBMITTED_TO_PROVIDER).not.toContain(field);
    }
  });

  it("names no document field as submittable, because none can be reached", () => {
    for (const field of DISPUTE_EVIDENCE_FILE_STORAGE_GAP.documentFieldsUnreachable) {
      expect(SUBMITTABLE_EVIDENCE_FIELDS as readonly string[]).not.toContain(field);
    }
  });

  it("refuses a payload carrying cardholder identity, whatever a caller passes", async () => {
    const { client, recorded } = makeClient(
      () => dispute(),
      () => dispute(),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence({
      ...REQUEST,
      evidence: { customer_email_address: "buyer@example.test" } as never,
    });
    expect(result.outcome).toBe("REFUSED");
    expect(recorded.updates).toHaveLength(0);
  });

  it("forbids every cardholder field and the free-text field by name", () => {
    for (const field of [
      "customer_name",
      "customer_email_address",
      "customer_purchase_ip",
      "billing_address",
      "shipping_address",
      "uncategorized_text",
    ]) {
      expect(NEVER_SUBMITTED_TO_PROVIDER).toContain(field);
    }
  });

  it("reads no buyer snapshot in the submission path", () => {
    /* The storage and capsule denylists do not govern an outbound call. This is
       the assertion that does. */
    for (const path of [
      "src/server/payments/stripe-dispute-evidence-adapter.ts",
      "src/server/marketplace/dispute-evidence-service.ts",
    ]) {
      const code = readCode(path);
      expect(code, path).not.toContain("getBuyerSnapshot");
      expect(code, path).not.toContain("orderBuyerSnapshot");
    }
  });

  it("refuses an empty package rather than spending a submission on silence", async () => {
    const { client, recorded } = makeClient(
      () => dispute(),
      () => dispute(),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence({ ...REQUEST, evidence: {} });
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome === "REFUSED") expect(result.failureCode).toBe("EVIDENCE_EMPTY");
    expect(recorded.updates).toHaveLength(0);
  });

  it("refuses a payload past the provider's character budget", async () => {
    const { client, recorded } = makeClient(
      () => dispute(),
      () => dispute(),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence({
      ...REQUEST,
      evidence: { product_description: "x".repeat(20_001) },
    });
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome === "REFUSED") expect(result.failureCode).toBe("EVIDENCE_TOO_LARGE");
    expect(recorded.updates).toHaveLength(0);
  });
});

describe("1.12 — the deadline and the provider's state gate the call", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "the bank permits no response at all",
      { evidence_details: { due_by: 0, has_evidence: false, past_due: false, submission_count: 0 } },
      "RESPONSE_NOT_PERMITTED",
    ],
    [
      "the deadline has passed",
      {
        evidence_details: {
          due_by: Math.floor(new Date("2028-09-01T00:00:00.000Z").getTime() / 1000),
          has_evidence: false,
          past_due: true,
          submission_count: 0,
        },
      },
      "DEADLINE_PASSED",
    ],
    [
      "evidence was already submitted",
      {
        evidence_details: {
          due_by: DUE_BY_SECONDS,
          has_evidence: true,
          past_due: false,
          submission_count: 1,
        },
      },
      "ALREADY_SUBMITTED",
    ],
    ["the dispute is already under review", { status: "under_review" }, "DISPUTE_NOT_OPEN"],
    ["the dispute is lost", { status: "lost" }, "DISPUTE_NOT_OPEN"],
    ["the dispute is won", { status: "won" }, "DISPUTE_NOT_OPEN"],
  ];

  for (const [label, overrides, expected] of cases) {
    it(`refuses, and calls nobody, when ${label}`, async () => {
      const { client, recorded } = makeClient(
        () => dispute(overrides),
        () => dispute(),
      );
      const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
      const result = await port.submitEvidence(REQUEST);
      expect(result.outcome).toBe("REFUSED");
      if (result.outcome === "REFUSED") expect(result.failureCode).toBe(expected);
      /* The read happened; the WRITE did not. */
      expect(recorded.updates).toHaveLength(0);
    });
  }

  it("submits on an inquiry that still needs a response", async () => {
    const { client, recorded } = makeClient(
      () => dispute({ status: "warning_needs_response" }),
      () =>
        dispute({
          evidence_details: { due_by: DUE_BY_SECONDS, has_evidence: true, past_due: false, submission_count: 1 },
        }),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence(REQUEST);
    expect(result.outcome).toBe("SUBMITTED");
    expect(recorded.updates).toHaveLength(1);
  });
});

describe("1.12 — idempotency distinguishes requests, not disputes", () => {
  const base = {
    disputeId: "mon:dspt:A",
    providerDisputeRef: "dp_1",
    revision: 1,
    finalSubmission: true,
  };

  it("derives the same key for a retry of the same submission", () => {
    expect(disputeEvidenceIdempotencyKey(base)).toBe(disputeEvidenceIdempotencyKey(base));
  });

  it("derives a different key for a different revision", () => {
    /* THE REGRESSION GUARD. Keying on the dispute alone would make a revision
       return the first call's cached response — a 200, a plausible object, and
       the revision silently never applied. */
    expect(disputeEvidenceIdempotencyKey(base)).not.toBe(
      disputeEvidenceIdempotencyKey({ ...base, revision: 2 }),
    );
  });

  it("derives a different key for staging versus final submission", () => {
    expect(disputeEvidenceIdempotencyKey(base)).not.toBe(
      disputeEvidenceIdempotencyKey({ ...base, finalSubmission: false }),
    );
  });

  it("contains no clock, counter, or randomness", () => {
    const code = readCode("src/server/marketplace/dispute-evidence-idempotency.ts");
    expect(code).not.toContain("Date.now");
    expect(code).not.toContain("Math.random");
    expect(code).not.toContain("randomBytes");
  });

  it("namespaces the key so it cannot collide with a refund or tax key", () => {
    expect(disputeEvidenceIdempotencyKey(base).startsWith("mon-dsevd-")).toBe(true);
  });

  it("passes the key on every provider write", async () => {
    const { client, recorded } = makeClient(
      () => dispute(),
      () =>
        dispute({
          evidence_details: { due_by: DUE_BY_SECONDS, has_evidence: true, past_due: false, submission_count: 1 },
        }),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    await port.submitEvidence(REQUEST);
    expect(recorded.updates[0]!.options).toEqual({ idempotencyKey: "mon-dsevd-abc" });
  });
});

describe("1.12 — TEST mode is refused three times, not twice", () => {
  it("refuses a dispute the provider itself reports as livemode", async () => {
    /* The belt-and-braces check 1.9's refund adapter could not make, because
       `Stripe.Refund` carries no `livemode`. `Stripe.Dispute` does. */
    const { client, recorded } = makeClient(
      () => dispute({ livemode: true }),
      () => dispute(),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence(REQUEST);
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome === "REFUSED") expect(result.failureCode).toBe("PROVIDER_MODE_NOT_PERMITTED");
    expect(recorded.updates).toHaveLength(0);
  });

  it("returns a normalised result rather than throwing when nothing is configured", async () => {
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, now: () => NOW });
    const result = await port.submitEvidence(REQUEST);
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome === "REFUSED") {
      expect(["PROVIDER_NOT_CONFIGURED", "PROVIDER_MODE_NOT_PERMITTED"]).toContain(
        result.failureCode,
      );
    }
  });

  it("resolves a test-mode credential before an SDK object exists", () => {
    const code = readCode("src/server/payments/stripe-dispute-evidence-adapter.ts");
    expect(code).toContain("resolveTestModeSecretKey");
  });
});

describe("1.12 — failures are classified, and no vendor text is kept", () => {
  const cases: Array<[string, unknown, string, boolean]> = [
    ["a connection error", { type: "StripeConnectionError" }, "PROVIDER_UNAVAILABLE", true],
    ["a rate limit", { statusCode: 429 }, "PROVIDER_UNAVAILABLE", true],
    ["a provider outage", { statusCode: 503 }, "PROVIDER_UNAVAILABLE", true],
    ["a missing dispute", { code: "resource_missing" }, "DISPUTE_NOT_FOUND", false],
    ["a rejected request", { type: "StripeInvalidRequestError" }, "EVIDENCE_REJECTED", false],
    ["an unrecognised shape", { nonsense: true }, "UNSPECIFIED_FAILURE", true],
  ];

  for (const [label, error, expected, retryable] of cases) {
    it(`classifies ${label} as ${expected}`, () => {
      expect(classifyStripeDisputeEvidenceError(error)).toBe(expected);
      expect(isRetryableDisputeEvidenceFailure(classifyStripeDisputeEvidenceError(error))).toBe(
        retryable,
      );
    });
  }

  it("reads no provider message", () => {
    const code = readCode("src/server/payments/stripe-dispute-evidence-adapter.ts");
    expect(code).not.toContain(".message");
  });

  it("returns only members of the closed failure vocabulary", async () => {
    const inputs: unknown[] = [
      new Error("boom"),
      { type: "StripeAuthenticationError" },
      { statusCode: 400 },
      null,
      undefined,
    ];
    for (const input of inputs) {
      expect(DISPUTE_EVIDENCE_SUBMISSION_FAILURE_CODES).toContain(
        classifyStripeDisputeEvidenceError(input),
      );
    }
  });

  it("surfaces a permanent invalid-state failure as terminal", async () => {
    const { client } = makeClient(
      () => dispute(),
      () => Object.assign(new Error("nope"), { type: "StripeInvalidRequestError" }),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence(REQUEST);
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome === "REFUSED") {
      expect(result.failureCode).toBe("EVIDENCE_REJECTED");
      expect(result.retryable).toBe(false);
    }
  });

  it("surfaces a transient failure as retryable", async () => {
    const { client } = makeClient(
      () => dispute(),
      () => Object.assign(new Error("net"), { type: "StripeConnectionError" }),
    );
    const port = createStripeDisputeEvidenceAdapter({ env: ENABLED_ENV, client, now: () => NOW });
    const result = await port.submitEvidence(REQUEST);
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome === "REFUSED") {
      expect(result.failureCode).toBe("PROVIDER_UNAVAILABLE");
      expect(result.retryable).toBe(true);
    }
  });
});

describe("1.12 — the review lifecycle", () => {
  it("is forward-only, with three terminals", () => {
    for (const terminal of ["SUBMITTED", "SUPERSEDED", "SUBMISSION_REFUSED"] as const) {
      expect(DISPUTE_EVIDENCE_PREPARATION_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("cannot reach SUBMITTED without passing through APPROVED", () => {
    /* The operator boundary, as a property of the transition table rather than a
       check somebody has to remember. */
    expect(isValidDisputeEvidencePreparationTransition("PREPARED", "SUBMITTED")).toBe(false);
    expect(isValidDisputeEvidencePreparationTransition("PREPARED", "APPROVED")).toBe(true);
    expect(isValidDisputeEvidencePreparationTransition("APPROVED", "SUBMITTED")).toBe(true);
  });

  it("is total over every declared status pair", () => {
    for (const from of DISPUTE_EVIDENCE_PREPARATION_STATUSES) {
      for (const to of DISPUTE_EVIDENCE_PREPARATION_STATUSES) {
        expect(typeof isValidDisputeEvidencePreparationTransition(from, to)).toBe("boolean");
      }
    }
    const statuses: readonly DisputeEvidencePreparationStatus[] =
      DISPUTE_EVIDENCE_PREPARATION_STATUSES;
    expect(statuses).toHaveLength(5);
  });

  it("keeps a supersession state, so an ageing approval is not a standing one", () => {
    expect(DISPUTE_EVIDENCE_PREPARATION_TRANSITIONS.APPROVED).toContain("SUPERSEDED");
  });

  it("never transmits a seller's assertion on its own", () => {
    /* A seller is an interested party. Recording an attestation writes an item;
       sending it still requires an approval. */
    const code = readCode("src/server/marketplace/dispute-evidence-service.ts");
    const recordFn = code.slice(code.indexOf("export async function recordSellerAttestation"));
    const body = recordFn.slice(0, recordFn.indexOf("export async function approveDisputeEvidence"));
    expect(body).not.toContain("submitEvidence");
    expect(body).not.toContain("deps.port");
  });

  it("bounds what a seller may assert, so no prose can be stored", () => {
    expect(SELLER_ATTESTATION_CLAIMS.length).toBeGreaterThan(0);
    for (const claim of SELLER_ATTESTATION_CLAIMS) {
      expect(claim).toMatch(/^[A-Z_]+$/);
    }
  });

  it("stores no free-text column on any evidence model", () => {
    const schema = readSource("prisma/schema.prisma");
    const start = schema.indexOf("model DisputeEvidenceItem {");
    const block = schema.slice(start, schema.indexOf("model DisputeEvidencePreparationItem"));
    /* Column declarations only — a doc comment may legitimately use the word
       "note" while explaining why there is no note column. */
    const columns = block
      .split("\n")
      .filter((line) => /^\s{2}[a-zA-Z]+\s/.test(line))
      .join("\n");
    for (const forbidden of ["note", "comment", "narrative", "statementText", "evidenceBody"]) {
      expect(columns, forbidden).not.toContain(forbidden);
    }
  });
});

describe("1.12 — evidence completeness is judged, not assumed", () => {
  it("calls a sale with nothing to say EMPTY", () => {
    expect(disputeEvidenceCompletenessFor([])).toBe("EMPTY");
  });

  it("calls a service date alone PARTIAL, because a bank will not weigh it", () => {
    expect(disputeEvidenceCompletenessFor(["SERVICE_DATE"])).toBe("PARTIAL");
  });

  it("calls two bound policy versions SUBSTANTIVE", () => {
    expect(
      disputeEvidenceCompletenessFor([
        "REFUND_POLICY_VERSION_BOUND_AT_PURCHASE",
        "MARKETPLACE_POLICY_VERSION_AT_PURCHASE",
      ]),
    ).toBe("SUBSTANTIVE");
  });
});

describe("1.12 — readiness reports a partial capability honestly", () => {
  const READY_ENV = {
    MONACADO_STRIPE_ENABLED: "true",
    MONACADO_STRIPE_MODE: "TEST",
    MONACADO_STRIPE_SECRET_KEY: "sk_test_0m9notarealkeyatall000000",
    MONACADO_STRIPE_WEBHOOK_SECRET: "whsec_0m9testsigningsecretvalue000000",
    MONACADO_STRIPE_SUCCESS_URL: "https://monacado.test/checkout/result",
    MONACADO_STRIPE_CANCEL_URL: "https://monacado.test/checkout/result",
  } as Record<string, string>;
  const AT = "2028-09-14T09:00:00.000Z";

  it("retains no blocker claiming representment is unauthorised", () => {
    const report = evaluateDisputeReadiness(AT, READY_ENV);
    expect(report.representmentAuthorised).toBe(true);
    expect(report.blockers).not.toContain("DISPUTE_EVIDENCE_RESPONSE_NOT_IMPLEMENTED");
    expect(report.blockers).not.toContain("DISPUTE_EVIDENCE_SUBMISSION_NOT_ENABLED");
  });

  it("reports the four capability dimensions separately", () => {
    const report = evaluateDisputeReadiness(AT, READY_ENV);
    expect(report.evidenceAssemblyImplemented).toBe(true);
    expect(report.operatorReviewImplemented).toBe(true);
    expect(report.providerSubmissionImplemented).toBe(true);
    expect(report.providerSubmissionConfigured).toBe(true);
    expect(report.providerMode).toBe("TEST");
  });

  it("names which evidence categories nothing can satisfy", () => {
    const report = evaluateDisputeReadiness(AT, READY_ENV);
    expect([...report.unsupportedEvidenceCategories].sort()).toEqual([
      "ACCESS_ACTIVITY_LOG",
      "SHIPPING_DOCUMENTATION",
    ]);
  });

  it("blocks on TEST-only mode and on unmonitored deadlines", () => {
    const report = evaluateDisputeReadiness(AT, READY_ENV);
    expect(report.blockers).toContain("DISPUTE_PROVIDER_MODE_TEST_ONLY");
    expect(report.deadlineMonitoringImplemented).toBe(false);
    expect(report.blockers).toContain("DISPUTE_DEADLINE_MONITORING_NOT_IMPLEMENTED");
  });

  it("still cannot go green, in any environment whatsoever", () => {
    /* The property that matters. `DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE` is read
       from a frozen constant, so no configuration clears it while whole classes
       of sale cannot be evidenced. */
    for (const env of [{}, READY_ENV] as Array<Record<string, string>>) {
      const report = evaluateDisputeReadiness(AT, env);
      expect(report.ready).toBe(false);
      expect(report.blockers).toContain("DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE");
    }
  });

  it("keeps file evidence explicit while it is deferred", () => {
    const report = evaluateDisputeReadiness(AT, READY_ENV);
    expect(report.documentSubmissionImplemented).toBe(false);
    expect(report.blockers).toContain("DISPUTE_EVIDENCE_DOCUMENT_SUBMISSION_NOT_IMPLEMENTED");
    expect(DISPUTE_EVIDENCE_FILE_STORAGE_GAP.objectStorage).toBe("NOT_IMPLEMENTED");
    expect(DISPUTE_EVIDENCE_FILE_STORAGE_GAP.providerFileUpload).toBe("NOT_IMPLEMENTED");
  });

  it("names the two evidence codes nothing can satisfy", () => {
    expect([...DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE].sort()).toEqual([
      "ACCESS_ACTIVITY_LOG",
      "SHIPPING_DOCUMENTATION",
    ]);
  });

  it("returns no secret value, only whether one is present", () => {
    const serialised = JSON.stringify(evaluateDisputeReadiness(AT, READY_ENV));
    expect(serialised).not.toContain("whsec_");
    expect(serialised).not.toContain("sk_test_");
  });

  it("makes no provider call and touches no row", () => {
    const code = readCode("src/server/operations/dispute-readiness.ts");
    expect(code).not.toContain("getPrisma");
    expect(code).not.toContain("fetch(");
  });
});

describe("1.12 — the operator surface carries no buyer detail", () => {
  it("prints no amount, address, or identity field", () => {
    const code = readCode("scripts/dispute-evidence.ts");
    for (const forbidden of [
      "buyerEmail",
      "buyerName",
      "billingAddress",
      "shippingAddress",
      "amountMinorUnits",
      "disputedAmount",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("reads no buyer snapshot", () => {
    const code = readCode("scripts/dispute-evidence.ts");
    expect(code).not.toContain("getBuyerSnapshot");
    expect(code).not.toContain("orderBuyerSnapshot");
  });

  it("prints a bounded refusal reason and never a thrown message", () => {
    const code = readCode("scripts/dispute-evidence.ts");
    expect(code).toContain("error.reason");
    expect(code).not.toContain("error.message");
  });

  it("makes no plan-dependent scheduling claim", () => {
    const source = readSource("scripts/dispute-evidence.ts");
    expect(source).not.toContain("cron");
    expect(source).not.toContain("vercel.json");
  });

  it("defaults submit to a dry run that contacts nobody", () => {
    const code = readCode("scripts/dispute-evidence.ts");
    /* The act is irreversible, so the default must be inert. */
    expect(code).toContain("dryRun = true");
  });
});

describe("1.12 — notifications, added without duplicating 1.11's", () => {
  it("reuses the evidence-required code rather than minting a synonym", () => {
    expect(DISPUTE_NOTIFICATION_CONTEXT_CODES).toContain("DISPUTE_EVIDENCE_REQUIRED");
  });

  it("adds exactly the three codes 1.12 needs", () => {
    for (const code of [
      "DISPUTE_EVIDENCE_REQUEST_UNANSWERED",
      "DISPUTE_EVIDENCE_SUBMITTED",
      "DISPUTE_EVIDENCE_SUBMISSION_FAILED",
    ]) {
      expect(DISPUTE_NOTIFICATION_CONTEXT_CODES).toContain(code);
    }
  });

  it("adds two email purposes and no buyer-facing one", () => {
    expect(OUTBOUND_EMAIL_PURPOSES).toContain("DISPUTE_EVIDENCE_REQUESTED");
    expect(OUTBOUND_EMAIL_PURPOSES).toContain("DISPUTE_EVIDENCE_SUBMITTED");
    /* No buyer hears from Monacado about a live dispute: anything written to a
       cardholder mid-adjudication is correspondence a bank may weigh. */
    expect(OUTBOUND_EMAIL_PURPOSES).not.toContain("DISPUTE_EVIDENCE_BUYER_NOTICE");
  });

  it("gives every new purpose a resolver branch, so none silently never sends", () => {
    /* The exact hazard hardened at 1.11: a purpose added to the enum without a
       resolver branch renders nothing and no test fails. */
    const resolver = readSource("src/server/notifications/email-message-resolver.ts");
    expect(resolver).toContain("DISPUTE_EVIDENCE_REQUESTED");
    expect(resolver).toContain("DISPUTE_EVIDENCE_SUBMITTED");
  });

  it("gives the seller request a caller, which 1.11's obligation never had", () => {
    const code = readCode("src/server/notifications/dispute-notice-service.ts");
    expect(code).toContain("requestSellerDisputeEvidence");
    expect(code).toContain("recordDisputeOperationalObligation(");
  });
});

describe("1.12 — Marketplace Policy 1.2.0 stands beside 1.1.0, not on it", () => {
  it("leaves 1.0.0's and 1.1.0's content hashes exactly where they were", () => {
    /* The load-bearing pair. Both are pinned wherever those versions have been
       recorded, and a single character moving in either would make every later
       bootstrap of it refuse with a content-hash mismatch. */
    expect(MONACADO_MARKETPLACE_POLICY_V1_HASH).toBe(
      "sha256:e50e87716ca2156eb51afa0fab52d4ab925109e8147199ece3a8e3160443cb85",
    );
    expect(MONACADO_MARKETPLACE_POLICY_V1_1_HASH).toBe(
      "sha256:b0a48644c8c146e2247d20de20140f6e124435401cad1ce096140ca5128e74b6",
    );
  });

  it("is a distinct version of the same policy, with its own hash", () => {
    expect(MONACADO_MARKETPLACE_POLICY_V1_2.policyVersion).toBe("1.2.0");
    expect(MONACADO_MARKETPLACE_POLICY_V1_2.policyId).toBe(MONACADO_MARKETPLACE_POLICY_V1_1.policyId);
    expect(MONACADO_MARKETPLACE_POLICY_V1_2_HASH).not.toBe(MONACADO_MARKETPLACE_POLICY_V1_1_HASH);
    expect(MONACADO_MARKETPLACE_POLICY_V1_2_HASH).not.toBe(MONACADO_MARKETPLACE_POLICY_V1_HASH);
    expect(MONACADO_MARKETPLACE_POLICY_V1_2_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("shares no section object with any earlier version", () => {
    /* The property that makes the duplication real rather than nominal. */
    for (const earlier of [MONACADO_MARKETPLACE_POLICY_V1, MONACADO_MARKETPLACE_POLICY_V1_1]) {
      for (const a of MONACADO_MARKETPLACE_POLICY_V1_2.sections) {
        for (const b of earlier.sections) {
          expect(a).not.toBe(b);
        }
      }
    }
  });

  it("carries no dispute section in any earlier version", () => {
    for (const key of [
      "DISPUTES_AND_CHARGEBACKS",
      "DISPUTE_EVIDENCE_AND_COOPERATION",
      "DISPUTE_EFFECT_ON_PROCEEDS",
    ] as const) {
      expect(selectSection(MONACADO_MARKETPLACE_POLICY_V1, key)).toBeNull();
      expect(selectSection(MONACADO_MARKETPLACE_POLICY_V1_1, key)).toBeNull();
      expect(selectSection(MONACADO_MARKETPLACE_POLICY_V1_2, key)).not.toBeNull();
    }
  });

  it("keeps every shipped version readable, and ends with policy changes", () => {
    for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
      expect(marketplacePolicyDocument(version)).not.toBeNull();
    }
    expect(marketplacePolicyDocument("9.9.9")).toBeNull();
    const keys = MONACADO_MARKETPLACE_POLICY_V1_2.sections.map((s) => s.key);
    expect(keys[keys.length - 1]).toBe("POLICY_CHANGES");
  });

  it("ships as a version of its own and requires reacceptance", () => {
    /* Re-scoped in Phase 1.14, which shipped 1.3.0 and took "is the latest"
       with it. That clause was never this phase's claim to make — 1.12's claim
       is that 1.2.0 EXISTS as a distinct version requiring fresh acceptance, and
       that stays true forever. Re-pinning the literal to 1.3.0 here would have
       made this suite assert something about a phase it does not describe. */
    expect(marketplacePolicyDocument(MARKETPLACE_POLICY_VERSION_1_2)).not.toBeNull();
    expect(MARKETPLACE_POLICY_ONBOARDING_ACCEPTANCE.get("1.2.0")).toBe(true);
    /* And superseding it did not unship it: every receipt for every sale made
       under 1.2.0 still resolves. */
    expect(LATEST_MARKETPLACE_POLICY_VERSION).not.toBe(MARKETPLACE_POLICY_VERSION_1_2);
  });
});

describe("1.12 — the dispute rules each audience is shown derive from 1.2.0", () => {
  const seller = selectSectionsForAudience(MONACADO_MARKETPLACE_POLICY_V1_2, "SELLER");
  const promoter = selectSectionsForAudience(MONACADO_MARKETPLACE_POLICY_V1_2, "PROMOTER");
  const buyer = selectSectionsForAudience(MONACADO_MARKETPLACE_POLICY_V1_2, "BUYER");
  const text = (sections: typeof seller): string =>
    sections.flatMap((s) => s.paragraphs).join("\n");

  it("tells a seller they must cooperate, and must not go to the network", () => {
    const body = text(seller);
    expect(body).toContain("must cooperate with a legitimate request for dispute evidence");
    expect(body).toContain("must not contact the buyer's bank");
    expect(body).toContain("does not limit a buyer's rights under the rules of a payment network");
  });

  it("tells a promoter their commission is conditional however the sale is undone", () => {
    const body = text(promoter);
    expect(body).toContain("conditional on the underlying sale remaining economically valid");
    expect(body).toContain("is not a party to a payment dispute");
    expect(body).toContain("not responsible for the seller's evidence");
  });

  it("tells a buyer their rights survive, and promises no outcome", () => {
    const body = text(buyer);
    expect(body).toContain("are separate from a seller's declared refund terms");
    expect(body).toContain("does not promise that any response will succeed");
    expect(body).toContain("does not erase the record of the sale");
  });

  it("never directs a buyer to raise a dispute instead of asking for a refund", () => {
    const body = text(buyer).toLowerCase();
    expect(body).not.toContain("contact your bank to");
    expect(body).not.toContain("ask your bank to reverse");
  });

  it("shows a buyer no evidence-cooperation or proceeds section", () => {
    const keys = buyer.map((s) => s.key);
    expect(keys).not.toContain("DISPUTE_EVIDENCE_AND_COOPERATION");
    expect(keys).not.toContain("DISPUTE_EFFECT_ON_PROCEEDS");
    expect(keys).toContain("DISPUTES_AND_CHARGEBACKS");
  });

  it("states no jurisdiction-specific conclusion and names no provider", () => {
    const body = text(MONACADO_MARKETPLACE_POLICY_V1_2.sections).toLowerCase();
    for (const forbidden of ["stripe", "paypal", "visa", "mastercard", "governing law", "arbitration"]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it("states the finalized-chargeback fee precisely, and only for a loss", () => {
    const body = text(MONACADO_MARKETPLACE_POLICY_V1_2.sections);
    expect(body).toContain("a $30 chargeback fee");
    expect(body).toContain("Opening a dispute does not incur the fee");
    expect(body).toContain("a dispute decided in the sale's favour does not incur it");
    expect(body).toContain("the record of that sale is not rewritten");
  });

  it("says Monacado determines and submits the response", () => {
    const body = text(MONACADO_MARKETPLACE_POLICY_V1_2.sections);
    expect(body).toContain("always responsible for responding to a payment dispute");
    expect(body).toContain("determines and submits the response");
    expect(body).toContain("does not transfer that responsibility to the seller");
  });
});

describe("1.12 — the receipt and the checkout disclosure do not move", () => {
  it("keeps every dispute section out of the refund-governance selector", () => {
    /* That array drives the buyer receipt and the checkout refund disclosure.
       Widening it would push chargeback text onto both surfaces silently. */
    for (const key of [
      "DISPUTES_AND_CHARGEBACKS",
      "DISPUTE_EVIDENCE_AND_COOPERATION",
      "DISPUTE_EFFECT_ON_PROCEEDS",
    ]) {
      expect(REFUND_GOVERNANCE_SECTION_KEYS as readonly string[]).not.toContain(key);
    }
  });
});

describe("1.12 — the capsule and the publication posture are unchanged", () => {
  it("keeps the dispute capsule private and unpublished", () => {
    expect(capsuleVisibilityFor("Dispute")).toBe("PRIVATE");
  });

  it("adds no evidence content to the capsule denylist's reach", () => {
    for (const forbidden of ["evidenceDocument", "evidenceFileId", "representmentEvidence"]) {
      expect(NEVER_IN_DISPUTE_CAPSULE).toContain(forbidden);
    }
  });

  it("publishes nothing to AgentNet from any 1.12 module", () => {
    for (const path of [
      "src/server/marketplace/dispute-evidence-service.ts",
      "src/server/payments/stripe-dispute-evidence-adapter.ts",
      "scripts/dispute-evidence.ts",
    ]) {
      const code = readCode(path);
      expect(code, path).not.toContain("agentnet");
      expect(code, path).not.toContain("AgentNet");
      expect(code, path).not.toContain("publicationOutbox");
    }
  });

  it("writes no provider-owned dispute state from the submission path", () => {
    /* A local "we submitted, mark it under review" would be indistinguishable
       from a network fact and would retire the operator's own to-do while the
       real deadline kept running. The webhook remains the only writer. */
    const code = readCode("src/server/marketplace/dispute-evidence-service.ts");
    /* No write to the dispute row at all. The provider's counters may be READ —
       the pre-flight guard needs them — but nothing here may set one. */
    expect(code).not.toContain("transactionDispute.update");
    expect(code).not.toContain("transactionDispute.upsert");
    expect(code).not.toContain("fundsState");
    expect(code).not.toContain("evidenceStagedAtProvider");
  });
});

describe("1.12 — the finalized-chargeback seller fee is governed, not compiled", () => {
  it("bootstraps at thirty dollars, as a seed rather than an authority", () => {
    expect(SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT.amountMinorUnits).toBe(3_000);
    expect(SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT.currency).toBe("USD");
    expect(SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT.policyKey).toBe(
      SELLER_CHARGEBACK_FEE_POLICY_KEY,
    );
  });

  it("never reads a compiled amount when assessing", () => {
    /* THE POINT OF THIS CORRECTION. The assessment path must resolve the governed
       policy; a fallback to the bootstrap constant would reintroduce the
       hardcoded fee while looking governed. */
    expect(SELLER_CHARGEBACK_FEE_RULES.compiledFallbackAtAssessment).toBe(false);
    const code = readCode("src/server/marketplace/transaction-dispute-service.ts");
    expect(code).not.toContain("SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT");
    expect(code).not.toContain("3_000");
    expect(code).not.toContain("3000");
  });

  it("resolves the governing version at finalization and binds it", () => {
    expect(SELLER_CHARGEBACK_FEE_RULES.versionResolvedAt).toBe("DISPUTE_FINALIZATION");
    expect(SELLER_CHARGEBACK_FEE_RULES.boundToAssessment).toBe(true);
  });

  it("applies to a loss, and to nothing else", () => {
    expect(chargebackFeeAppliesTo("LOST")).toBe(true);
    /* The row worth stating out loud: a seller who successfully defends a sale
       must be no worse off for having been disputed. */
    expect(chargebackFeeAppliesTo("WON")).toBe(false);
    expect(chargebackFeeAppliesTo("OPEN")).toBe(false);
    expect(chargebackFeeAppliesTo("NEEDS_RESPONSE")).toBe(false);
    expect(chargebackFeeAppliesTo("UNDER_REVIEW")).toBe(false);
    expect(chargebackFeeAppliesTo("CLOSED")).toBe(false);
    expect(SELLER_CHARGEBACK_FEE_RULES.assessedOnDisputeOpened).toBe(false);
    expect(SELLER_CHARGEBACK_FEE_RULES.assessedOnDisputeWon).toBe(false);
  });

  it("rewrites no historical economics, and collects nothing", () => {
    expect(SELLER_CHARGEBACK_FEE_RULES.rewritesHistoricalEconomics).toBe(false);
    expect(SELLER_CHARGEBACK_FEE_RULES.collection).toBe("NOT_IMPLEMENTED");
  });

  it("nets against no existing amount anywhere in the service", () => {
    /* The failure this design exists to prevent: a fee quietly deducted from a
       proceeds figure would restate what three parties were told they earned. */
    const code = readCode("src/server/marketplace/transaction-dispute-service.ts");
    const fn = code.slice(code.indexOf("async function assessSellerChargebackFeeInTx"));
    const body = fn.slice(0, fn.indexOf("async function raiseDisputeRecoveryExceptionsInTx"));
    expect(body).not.toContain("decrement");
    expect(body).not.toContain("transactionEconomicSnapshot");
    expect(body).not.toContain("proceedsObligation.update");
  });

  it("activation touches no assessed fee, so a change is prospective only", () => {
    const code = readCode("src/server/marketplace/chargeback-fee-policy-service.ts");
    const fn = code.slice(code.indexOf("export async function activateChargebackFeePolicyVersion"));
    expect(fn).not.toContain("sellerChargebackFee.");
  });

  it("stays distinct from the network's own dispute fee, which is still unbuilt", () => {
    expect(DISPUTE_EXECUTION_DEFERRAL.disputeFeeAccounting).toBe("NOT_IMPLEMENTED");
  });

  it("reuses the versioned-policy shape rather than a parallel config system", () => {
    /* DRAFT -> ACTIVE -> RETIRED under a unique activeMarker, the same technique
       CommercialPolicyVersionRow and SellerRefundPolicyVersionRow use. */
    const schema = readSource("prisma/schema.prisma");
    const block = schema.slice(schema.indexOf("model SellerChargebackFeePolicyVersionRow {"));
    expect(block).toContain("activeMarker");
    expect(block).toContain("@@unique([activeMarker])");
    expect(block).toContain("@@unique([policyId, policyVersion])");
    expect(block).toContain("recordedByAccountId");
    /* No config file, no env var, no JSON blob. */
    const service = readCode("src/server/marketplace/chargeback-fee-policy-service.ts");
    expect(service).not.toContain("process.env");
    expect(service).not.toContain("readFileSync");
  });
});

describe("1.12 — fraud and risk analytics belong to Phase 1.13", () => {
  it("names the whole scope as 1.13's", () => {
    expect(FRAUD_AND_RISK_ANALYTICS_HANDOFF.owner).toBe("PHASE_1_13");
    for (const item of [
      "REFUND_RATE",
      "CHARGEBACK_RATE",
      "CHARGEBACK_TO_REFUND_RATE",
      "EXPLICIT_ROLLING_WINDOWS",
      "NUMERATORS_AND_DENOMINATORS",
      "SELLER_ATTRIBUTION",
      "SELLER_BY_PROMOTER_ATTRIBUTION",
      "TRANSACTION_REFUND_AND_CHARGEBACK_VELOCITY",
      "AVERAGE_TICKET_VERSUS_GOVERNED_VERTICAL_NORMS",
      "GEOGRAPHIC_DIVERSITY_AND_ANOMALIES",
      "UNEXPECTED_VOLUME_SPIKES",
      "PROMOTER_CONCENTRATION_AND_ANOMALY",
      "DAILY_TOP_10_AND_TOP_100_SELLER_RISK_REVIEW",
      "EXPLAINABLE_REVIEW_REASONS",
      "STAFF_MITIGATION_WORKFLOW_UP_TO_SUSPENSION",
    ]) {
      expect(FRAUD_AND_RISK_ANALYTICS_HANDOFF.ownedByThatPhase, item).toContain(item);
    }
  });

  it("implements no score, threshold, or automatic suspension in 1.12", () => {
    for (const path of [
      "src/server/marketplace/dispute-evidence-service.ts",
      "src/server/marketplace/transaction-dispute-service.ts",
      "src/server/operations/dispute-readiness.ts",
      "scripts/dispute-evidence.ts",
    ]) {
      const code = readCode(path);
      for (const forbidden of ["riskScore", "suspendParticipant", "chargebackRate", "refundRate"]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("preserves the attribution 1.13 will need", () => {
    expect(FRAUD_AND_RISK_ANALYTICS_HANDOFF.attributionPreservedBy1_12).toContain(
      "SELLER_CHARGEBACK_FEE_NAMES_THE_SELLER_AND_THE_CAUSING_DISPUTE",
    );
    for (const absent of [
      "SCORING_THRESHOLDS",
      "AUTOMATIC_SUSPENSION",
      "RISK_TIERS",
      "OPAQUE_FRAUD_SCORE",
    ]) {
      expect(FRAUD_AND_RISK_ANALYTICS_HANDOFF.notImplementedHere, absent).toContain(absent);
    }
  });

  it("leaves the 1.11 seam saying the ruling is resolved", () => {
    expect(DISPUTE_EVIDENCE_SUBMISSION_SEAM.evidenceSubmission).toBe(
      "IMPLEMENTED_TEXT_ONLY_TEST_MODE",
    );
    expect("requiresRuling" in DISPUTE_EVIDENCE_SUBMISSION_SEAM).toBe(false);
  });
});
