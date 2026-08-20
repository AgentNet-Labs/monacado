/**
 * Payment-provider account and activation-review contract tests (Phase 0M.8).
 *
 * Offline and pure. No database, no clock, no network, no provider. Every value
 * is synthetic; no real personal data appears.
 *
 * One `describe` per required property, matching the 0M.1/0M.5 test convention.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFERRED_PAYMENT_ACCOUNT_EXTENSIONS,
  NEVER_ON_PAYMENT_ACCOUNT,
  OutstandingRequirements,
  PAYMENT_PROVIDERS,
  PAYMENT_REQUIREMENT_CODES,
  ParticipantPaymentAccountRecord,
  ProviderAccountRef,
  RecordObservedProviderStateInput,
  RegisterPaymentAccountInput,
  canonicalizeRequirements,
} from "../src/contracts/marketplace/payment-account";
import {
  ACTIVATION_APPROVAL_REFUSAL_CODES,
  ACTIVATION_DECISION_REASON_CODES,
  ACTIVATION_PHASE_WRITABLE_PARTICIPANT_STATUSES,
  REASON_CODES_BY_DECISION,
  DecideParticipantActivationInput,
  RESTRICTION_SCOPE_REQUIRED_STATUSES,
  evaluateActivationApproval,
  isActivationPhaseWritableParticipantStatus,
  isCoherentDecisionReason,
  participantStatusAfterDecision,
  requiresRestrictionScope,
  roleStatusOnActivationApproval,
  roleStatusOnActivationSubmission,
} from "../src/contracts/marketplace/activation-review";
import {
  PAYMENT_READINESS_TRANSITIONS,
  INITIAL_PAYMENT_READINESS,
  isValidPaymentReadinessTransition,
} from "../src/contracts/marketplace/lifecycle";
import { PAYMENT_READINESS_STATUSES } from "../src/contracts/marketplace/participant";
import { MARKETPLACE_CAPABILITIES } from "../src/contracts/marketplace/capability";
import { ACCOUNT_CAPABILITIES, AccountCapability } from "../src/contracts/account/account";
import {
  ACTIVATION_REVIEW_CAPABILITY,
  INTERNAL_AUTHORIZATION_REASON_CODES,
  canReadPublicationWorkerStatus,
  canReviewParticipantActivation,
  isInternallyAuthorized,
} from "../src/contracts/account/internal-authorization";
import { findParticipantPrivacyViolations } from "../src/contracts/marketplace/participant-record";

const PARTICIPANT = "mon:mpart:M8PARTA0000000000000000000";
const PAY_ACCOUNT = "mon:mpay:M8PAYACCT00000000000000000";
const REF = "acct_synthetic_0m8_reference";
const NOW = "2027-07-01T09:00:00.000Z";

const approvalInput = (overrides: Record<string, unknown> = {}) => ({
  participantStatus: "UNDER_REVIEW" as const,
  profileComplete: true,
  roles: [{ role: "SELLER" as const, status: "PENDING_ACTIVATION" as const }],
  paymentReadiness: "ENABLED" as const,
  ...overrides,
});

const ACCOUNT = "mon:acct:M8ACCT00000000000000000000";
const reviewerSubject = (overrides: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT,
  accountStatus: "ACTIVE" as const,
  capabilities: [ACTIVATION_REVIEW_CAPABILITY],
  ...overrides,
});

// — 1 —

describe("0M.8 · the readiness lifecycle is 0M.1's, not a second copy", () => {
  it("reuses the committed vocabulary verbatim", () => {
    expect(PAYMENT_READINESS_STATUSES).toEqual([
      "NOT_STARTED",
      "DETAILS_REQUIRED",
      "PENDING_PROVIDER",
      "ENABLED",
      "RESTRICTED",
      "DISABLED",
    ]);
  });

  it("creates only at NOT_STARTED", () => {
    expect(INITIAL_PAYMENT_READINESS).toBe("NOT_STARTED");
    // The register input has no `readiness` parameter at all, so a caller cannot
    // assert one — the strongest available form of "created NOT_STARTED".
    const withReadiness = RegisterPaymentAccountInput.safeParse({
      participantId: PARTICIPANT,
      provider: "STRIPE",
      providerAccountRef: REF,
      readiness: "ENABLED",
      now: NOW,
    });
    expect(withReadiness.success).toBe(false);
  });

  it("refuses NOT_STARTED to ENABLED — readiness is the provider's answer", () => {
    expect(isValidPaymentReadinessTransition("NOT_STARTED", "ENABLED")).toBe(false);
  });

  it("permits the onboarding path the phase actually walks", () => {
    expect(isValidPaymentReadinessTransition("NOT_STARTED", "DETAILS_REQUIRED")).toBe(true);
    expect(isValidPaymentReadinessTransition("DETAILS_REQUIRED", "PENDING_PROVIDER")).toBe(true);
    expect(isValidPaymentReadinessTransition("PENDING_PROVIDER", "ENABLED")).toBe(true);
    expect(isValidPaymentReadinessTransition("ENABLED", "DISABLED")).toBe(true);
    expect(isValidPaymentReadinessTransition("DISABLED", "DETAILS_REQUIRED")).toBe(true);
  });

  it("the table is exhaustive over the vocabulary", () => {
    expect(Object.keys(PAYMENT_READINESS_TRANSITIONS).sort()).toEqual(
      [...PAYMENT_READINESS_STATUSES].sort(),
    );
  });
});

// — 2 —

describe("0M.8 · provider neutrality", () => {
  it("names the counterparty and nothing provider-shaped", () => {
    expect(PAYMENT_PROVIDERS).toEqual(["STRIPE"]);
  });

  /**
   * The real neutrality assertion. Naming *which* provider is a Monacado fact;
   * importing that provider's state model is what a migration is made of.
   */
  it("no provider-shaped term appears in any status or requirement vocabulary", () => {
    const providerShaped = [
      "charges_enabled",
      "payouts_enabled",
      "currently_due",
      "past_due",
      "eventually_due",
      "disabled_reason",
      "capabilities",
      "requirements",
      "acct_",
      "stripe",
      "connect",
      "express",
      "custom_account",
    ];
    const vocabulary = [
      ...PAYMENT_READINESS_STATUSES,
      ...PAYMENT_REQUIREMENT_CODES,
      ...ACTIVATION_DECISION_REASON_CODES,
      ...ACTIVATION_APPROVAL_REFUSAL_CODES,
    ].map((v) => v.toLowerCase());

    for (const term of providerShaped) {
      expect(vocabulary.some((v) => v.includes(term))).toBe(false);
    }
  });

  it("no payment-provider SDK is a dependency of this repository", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    for (const forbidden of ["stripe", "@stripe/stripe-js", "braintree", "adyen", "paypal"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

// — 3 —

describe("0M.8 · the provider account reference is an opaque external identifier", () => {
  it("accepts an ordinary external reference", () => {
    expect(ProviderAccountRef.safeParse(REF).success).toBe(true);
  });

  it("refuses a Monacado identifier — the two identity layers stay apart", () => {
    expect(ProviderAccountRef.safeParse("mon:mpart:M8PARTA0000000000000000000").success).toBe(false);
    expect(ProviderAccountRef.safeParse("mon:mpay:M8PAYACCT00000000000000000").success).toBe(false);
  });

  it("refuses the shapes provider secrets take", () => {
    for (const secret of [
      "sk_live_abcdef",
      "sk_test_abcdef",
      "rk_live_abcdef",
      "whsec_abcdef",
      "Bearer abcdef",
      "pk_live_abcdef",
    ]) {
      expect(ProviderAccountRef.safeParse(secret).success).toBe(false);
    }
  });

  it("refuses surrounding whitespace, which is how a pasted value arrives", () => {
    expect(ProviderAccountRef.safeParse(`  ${REF}  `).success).toBe(false);
  });
});

// — 4 —

describe("0M.8 · requirements are bounded categories, never the provider's dossier", () => {
  it("is a closed vocabulary of areas", () => {
    expect(PAYMENT_REQUIREMENT_CODES).toContain("IDENTITY_DETAILS_REQUIRED");
    expect(PAYMENT_REQUIREMENT_CODES).toContain("BUSINESS_DETAILS_REQUIRED");
    expect(PAYMENT_REQUIREMENT_CODES).toContain("PAYOUT_DETAILS_REQUIRED");
    expect(PAYMENT_REQUIREMENT_CODES).toContain("ADDITIONAL_VERIFICATION_REQUIRED");
  });

  it("refuses an unrecognised code rather than storing free text", () => {
    expect(OutstandingRequirements.safeParse(["THE_PASSPORT_SCAN_WAS_BLURRY"]).success).toBe(false);
  });

  it("refuses a duplicate — the same category twice is one outstanding thing", () => {
    expect(
      OutstandingRequirements.safeParse(["IDENTITY_DETAILS_REQUIRED", "IDENTITY_DETAILS_REQUIRED"])
        .success,
    ).toBe(false);
  });

  it("canonicalizes to a deterministic order so a stored set round-trips stably", () => {
    const a = canonicalizeRequirements(["PAYOUT_DETAILS_REQUIRED", "IDENTITY_DETAILS_REQUIRED"]);
    const b = canonicalizeRequirements(["IDENTITY_DETAILS_REQUIRED", "PAYOUT_DETAILS_REQUIRED"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["IDENTITY_DETAILS_REQUIRED", "PAYOUT_DETAILS_REQUIRED"]);
  });
});

// — 5 —

describe("0M.8 · privacy: no credential, dossier, or raw payload is admissible", () => {
  /**
   * The guarantee is structural — every input is a `strictObject`, so each of
   * these arrives as an unknown key. This walks the named list and proves it
   * rather than trusting the header comment.
   */
  it("every NEVER_ON_PAYMENT_ACCOUNT key is refused by the register input", () => {
    for (const key of NEVER_ON_PAYMENT_ACCOUNT) {
      const parsed = RegisterPaymentAccountInput.safeParse({
        participantId: PARTICIPANT,
        provider: "STRIPE",
        providerAccountRef: REF,
        now: NOW,
        [key]: "synthetic",
      });
      expect(parsed.success, `${key} must be refused`).toBe(false);
    }
  });

  it("every NEVER_ON_PAYMENT_ACCOUNT key is refused by the observation input", () => {
    for (const key of NEVER_ON_PAYMENT_ACCOUNT) {
      const parsed = RecordObservedProviderStateInput.safeParse({
        participantId: PARTICIPANT,
        provider: "STRIPE",
        providerAccountRef: REF,
        readiness: "DETAILS_REQUIRED",
        outstandingRequirements: [],
        observedAt: NOW,
        [key]: "synthetic",
      });
      expect(parsed.success, `${key} must be refused`).toBe(false);
    }
  });

  it("a raw KYC/KYB payload cannot enter through a nested bag", () => {
    expect(
      RecordObservedProviderStateInput.safeParse({
        participantId: PARTICIPANT,
        provider: "STRIPE",
        providerAccountRef: REF,
        readiness: "DETAILS_REQUIRED",
        outstandingRequirements: ["IDENTITY_DETAILS_REQUIRED"],
        observedAt: NOW,
        metadata: { kyc: { legalName: "Synthetic Person", taxId: "000-00-0000" } },
      }).success,
    ).toBe(false);
  });

  it("the record itself carries nothing the participant privacy guard refuses", () => {
    const record = ParticipantPaymentAccountRecord.parse({
      paymentAccountId: PAY_ACCOUNT,
      participantId: PARTICIPANT,
      provider: "STRIPE",
      providerAccountRef: REF,
      readiness: "ENABLED",
      readinessObservedAt: NOW,
      outstandingRequirements: [],
      createdAt: NOW,
      updatedAt: NOW,
    });

    /* `provider`, `providerAccountRef`, and `paymentAccountId` legitimately
       contain the `payment`/`provideraccount` fragments the guard scans for —
       they are this record's whole subject. What matters is that the record
       carries no *content*: the scan is run over a projection with those three
       structural keys removed, and must find nothing. */
    const { provider, providerAccountRef, paymentAccountId, ...rest } = record;
    expect(findParticipantPrivacyViolations(rest)).toEqual([]);
    expect(provider).toBe("STRIPE");
    expect(providerAccountRef).toBe(REF);
    expect(paymentAccountId).toBe(PAY_ACCOUNT);
  });

  it("names the money, risk, tax, and notification work it does not do", () => {
    for (const deferred of [
      "charge",
      "order",
      "checkout",
      "refund",
      "chargeback",
      "settlement",
      "payoutExecution",
      "riskPolicy",
      "restrictionScope",
      "taxCalculation",
      "transactionLedger",
      "notificationDelivery",
      "concreteProviderAdapter",
    ]) {
      expect(DEFERRED_PAYMENT_ACCOUNT_EXTENSIONS).toContain(deferred);
    }
  });
});

// — 6 —

describe("0M.8 · approval prerequisites", () => {
  it("allows only when every prerequisite holds", () => {
    expect(evaluateActivationApproval(approvalInput())).toEqual({
      decision: "ALLOW",
      refusalCodes: [],
    });
  });

  it("requires provider readiness ENABLED", () => {
    for (const readiness of ["NOT_STARTED", "DETAILS_REQUIRED", "PENDING_PROVIDER", "DISABLED"] as const) {
      const out = evaluateActivationApproval(approvalInput({ paymentReadiness: readiness }));
      expect(out.decision).toBe("DENY");
      expect(out.refusalCodes).toContain("PAYMENT_NOT_ENABLED");
    }
  });

  it("distinguishes a provider hold from a provider that has not finished", () => {
    const out = evaluateActivationApproval(approvalInput({ paymentReadiness: "RESTRICTED" }));
    expect(out.refusalCodes).toContain("PAYMENT_RESTRICTED");
    expect(out.refusalCodes).not.toContain("PAYMENT_NOT_ENABLED");
  });

  it("requires a submitted review", () => {
    const out = evaluateActivationApproval(approvalInput({ participantStatus: "PROFILE_COMPLETE" }));
    expect(out.refusalCodes).toContain("NO_ACTIVATION_UNDER_REVIEW");
  });

  it("requires profile completeness", () => {
    const out = evaluateActivationApproval(approvalInput({ profileComplete: false }));
    expect(out.refusalCodes).toContain("PROFILE_NOT_COMPLETE");
  });

  it("requires an activatable role — a BUYER alone is not one", () => {
    const out = evaluateActivationApproval(
      approvalInput({ roles: [{ role: "BUYER", status: "ACTIVE" }] }),
    );
    expect(out.refusalCodes).toContain("NO_ACTIVATABLE_ROLE");
  });

  /**
   * A reviewer told one requirement at a time discovers the list one round trip
   * at a time. This is the property that makes the review usable.
   */
  it("collects every outstanding refusal rather than the first", () => {
    const out = evaluateActivationApproval(
      approvalInput({
        participantStatus: "DRAFT",
        profileComplete: false,
        roles: [],
        paymentReadiness: "NOT_STARTED",
      }),
    );
    expect(out.refusalCodes).toEqual(
      expect.arrayContaining([
        "NO_ACTIVATION_UNDER_REVIEW",
        "PROFILE_NOT_COMPLETE",
        "NO_ACTIVATABLE_ROLE",
        "PAYMENT_NOT_ENABLED",
      ]),
    );
  });

  /**
   * Reviewer authority is settled before this evaluator is reached, against
   * persisted entitlement state. It has no field here, so a caller cannot assert
   * it — and an authorization failure cannot leak participant state alongside it.
   */
  it("accepts no reviewer-authorization input at all", () => {
    expect(ACTIVATION_APPROVAL_REFUSAL_CODES).not.toContain("REVIEWER_NOT_AUTHORIZED");
    for (const key of ["reviewerAuthorization", "reviewerAuthorized", "isAuthorized"]) {
      expect(() => evaluateActivationApproval({ ...approvalInput(), [key]: true } as never)).toThrow();
    }
  });

  it("accepts no risk input — 0M.R1 cannot be smuggled in early", () => {
    for (const key of ["riskScore", "riskClassification", "restrictionScope", "reserveAmount"]) {
      expect(() => evaluateActivationApproval({ ...approvalInput(), [key]: 1 } as never)).toThrow();
    }
  });
});

// — 7 —

describe("0M.8 · the RESTRICTED / SUSPENDED phase gate", () => {
  it("names exactly the two statuses that lack a restriction scope", () => {
    expect([...RESTRICTION_SCOPE_REQUIRED_STATUSES]).toEqual(["RESTRICTED", "SUSPENDED"]);
    expect(requiresRestrictionScope("RESTRICTED")).toBe(true);
    expect(requiresRestrictionScope("SUSPENDED")).toBe(true);
  });

  it("excludes both from every status this phase may write", () => {
    expect(ACTIVATION_PHASE_WRITABLE_PARTICIPANT_STATUSES).not.toContain("RESTRICTED");
    expect(ACTIVATION_PHASE_WRITABLE_PARTICIPANT_STATUSES).not.toContain("SUSPENDED");
    expect(isActivationPhaseWritableParticipantStatus("RESTRICTED")).toBe(false);
    expect(isActivationPhaseWritableParticipantStatus("SUSPENDED")).toBe(false);
  });

  it("adds exactly the two statuses the governed review exists to reach", () => {
    expect(isActivationPhaseWritableParticipantStatus("UNDER_REVIEW")).toBe(true);
    expect(isActivationPhaseWritableParticipantStatus("ACTIVE")).toBe(true);
  });

  it("no decision produces RESTRICTED or SUSPENDED", () => {
    for (const decision of ["APPROVED", "MORE_INFORMATION_REQUIRED", "REJECTED"] as const) {
      const next = participantStatusAfterDecision(decision);
      expect(next).not.toBe("RESTRICTED");
      expect(next).not.toBe("SUSPENDED");
    }
  });
});

// — 8 —

describe("0M.8 · decision outcomes and their evidence", () => {
  it("only APPROVED admits", () => {
    expect(participantStatusAfterDecision("APPROVED")).toBe("ACTIVE");
  });

  it("MORE_INFORMATION_REQUIRED returns the participant to PROFILE_INCOMPLETE", () => {
    expect(participantStatusAfterDecision("MORE_INFORMATION_REQUIRED")).toBe("PROFILE_INCOMPLETE");
  });

  /**
   * The lifecycle has no rejected state, and CLOSED means the participant gave
   * up. Closing on Monacado's behalf would end an admission the participant may
   * legitimately resubmit.
   */
  it("REJECTED moves no status and never closes the participant", () => {
    expect(participantStatusAfterDecision("REJECTED")).toBeNull();
  });

  it("pairs each reason code with exactly one decision", () => {
    const all = Object.values(REASON_CODES_BY_DECISION).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ACTIVATION_DECISION_REASON_CODES].sort());
  });

  it("refuses an audit row that argues with itself", () => {
    expect(isCoherentDecisionReason("APPROVED", "PREREQUISITES_SATISFIED")).toBe(true);
    expect(isCoherentDecisionReason("APPROVED", "PROVIDER_DECLINED")).toBe(false);
    expect(isCoherentDecisionReason("REJECTED", "PREREQUISITES_SATISFIED")).toBe(false);
  });

  it("carries no free text — every reason code is a classification", () => {
    for (const code of ACTIVATION_DECISION_REASON_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
    }
  });
});

// — 9 —

describe("0M.8 · role progression follows the 0M.1 role table", () => {
  it("submission moves a DRAFT role to PENDING_ACTIVATION", () => {
    expect(roleStatusOnActivationSubmission("DRAFT")).toBe("PENDING_ACTIVATION");
  });

  it("approval moves a PENDING_ACTIVATION role to ACTIVE", () => {
    expect(roleStatusOnActivationApproval("PENDING_ACTIVATION")).toBe("ACTIVE");
  });

  it("neither operation revives a REVOKED role or restores a SUSPENDED one", () => {
    expect(roleStatusOnActivationSubmission("REVOKED")).toBeNull();
    expect(roleStatusOnActivationApproval("REVOKED")).toBeNull();
    expect(roleStatusOnActivationSubmission("SUSPENDED")).toBeNull();
    expect(roleStatusOnActivationApproval("SUSPENDED")).toBeNull();
  });

  it("approval does not re-activate an already ACTIVE role", () => {
    expect(roleStatusOnActivationApproval("ACTIVE")).toBeNull();
  });
});

// — 10 —

describe("0M.8 · the two capability vocabularies stay disjoint", () => {
  it("the internal Account vocabulary contains activation:review", () => {
    expect(ACCOUNT_CAPABILITIES).toContain("activation:review");
    expect(ACTIVATION_REVIEW_CAPABILITY).toBe("activation:review");
  });

  it("the marketplace vocabulary does NOT contain activation:review", () => {
    expect(MARKETPLACE_CAPABILITIES).not.toContain("activation:review");
  });

  it("the internal vocabulary does NOT gain activation:submit", () => {
    expect(ACCOUNT_CAPABILITIES).not.toContain("activation:submit");
    expect(MARKETPLACE_CAPABILITIES).toContain("activation:submit");
  });

  it("the two vocabularies share no member at all", () => {
    const marketplace = new Set<string>(MARKETPLACE_CAPABILITIES);
    for (const internal of ACCOUNT_CAPABILITIES) {
      expect(marketplace.has(internal)).toBe(false);
    }
  });

  it("neither vocabulary accepts the other's capability strings", () => {
    expect(AccountCapability.safeParse("activation:submit").success).toBe(false);
    expect(AccountCapability.safeParse("storefront:draft:create").success).toBe(false);
    expect(AccountCapability.safeParse("activation:review").success).toBe(true);
  });

  it("an unknown capability string remains refused", () => {
    for (const unknown of ["activation:approve", "admin", "*", "activation:review ", ""]) {
      expect(AccountCapability.safeParse(unknown).success).toBe(false);
    }
  });

  it("the existing internal capability is preserved, not replaced", () => {
    /* Narrowed at Phase 0M.R1, which added `participant:restrict` as the third
       member. The claim this test actually makes is that 0M.8's addition was
       additive — the 0E.7.4.1 capability is still there, and `activation:review`
       joined it rather than replacing it. A fixed count was incidental to there
       having been two. */
    expect(ACCOUNT_CAPABILITIES).toContain("publication-worker:status:read");
    expect(ACCOUNT_CAPABILITIES).toContain("activation:review");
  });
});

// — 11 —

describe("0M.8 · reviewer authority is a persisted internal entitlement", () => {
  it("allows an active account holding activation:review", () => {
    const decision = canReviewParticipantActivation(reviewerSubject());
    expect(isInternallyAuthorized(decision)).toBe(true);
    expect(decision.capability).toBe("activation:review");
    expect(decision.reasonCodes).toEqual([]);
  });

  it("refuses an account holding no internal capability", () => {
    const decision = canReviewParticipantActivation(reviewerSubject({ capabilities: [] }));
    expect(isInternallyAuthorized(decision)).toBe(false);
    expect(decision.capability).toBe("activation:review");
    expect(decision.reasonCodes).toEqual(["INTERNAL_CAPABILITY_NOT_GRANTED"]);
  });

  /** An unrelated internal capability must not stand in for this one. */
  it("refuses an account holding only publication-worker:status:read", () => {
    const decision = canReviewParticipantActivation(
      reviewerSubject({ capabilities: ["publication-worker:status:read"] }),
    );
    expect(isInternallyAuthorized(decision)).toBe(false);
    expect(decision.reasonCodes).toEqual(["INTERNAL_CAPABILITY_NOT_GRANTED"]);
  });

  it("and the converse — activation:review grants no worker-status read", () => {
    const decision = canReadPublicationWorkerStatus(reviewerSubject());
    expect(isInternallyAuthorized(decision)).toBe(false);
    expect(decision.capability).toBe("publication-worker:status:read");
  });

  it("refuses a disabled account even when the entitlement is held", () => {
    const decision = canReviewParticipantActivation(reviewerSubject({ accountStatus: "DISABLED" }));
    expect(isInternallyAuthorized(decision)).toBe(false);
    expect(decision.reasonCodes).toEqual(["INTERNAL_ACCOUNT_DISABLED"]);
  });

  it("refuses a null subject — an unknown account is not merely unentitled", () => {
    const decision = canReviewParticipantActivation(null);
    expect(isInternallyAuthorized(decision)).toBe(false);
    expect(decision.reasonCodes).toEqual(["INTERNAL_ACCOUNT_REQUIRED"]);
  });

  /**
   * The structural guarantee. A marketplace role, a participant, or an ownership
   * relation is not merely ignored — there is nowhere to put one, so no future
   * edit can quietly make one grant this capability.
   */
  it("has no parameter through which a role or ownership could confer authority", () => {
    for (const key of [
      "roles",
      "role",
      "participantId",
      "participant",
      "ownsParticipant",
      "isAccountOwner",
      "marketplaceRoles",
    ]) {
      expect(() => canReviewParticipantActivation({ ...reviewerSubject(), [key]: true } as never)).toThrow();
    }
  });

  it("SELLER, PROMOTER, and BUYER are not members of the internal vocabulary", () => {
    for (const role of ["SELLER", "PROMOTER", "BUYER"]) {
      expect(AccountCapability.safeParse(role).success).toBe(false);
      expect(ACCOUNT_CAPABILITIES as readonly string[]).not.toContain(role);
    }
  });

  it("reports the governing capability on every decision, allowed or refused", () => {
    expect(canReviewParticipantActivation(reviewerSubject()).capability).toBe("activation:review");
    expect(canReviewParticipantActivation(null).capability).toBe("activation:review");
  });

  it("refusal reason codes are bounded classifications carrying no value", () => {
    for (const code of INTERNAL_AUTHORIZATION_REASON_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
    }
  });
});

// — 12 —

describe("0M.8 · the decide input carries who is acting, never what they may do", () => {
  const decideInput = (overrides: Record<string, unknown> = {}) => ({
    participantId: PARTICIPANT,
    decision: "APPROVED" as const,
    decisionReasonCode: "PREREQUISITES_SATISFIED" as const,
    reviewerAccountId: ACCOUNT,
    decidedAt: NOW,
    ...overrides,
  });

  it("accepts the reviewing account id", () => {
    expect(DecideParticipantActivationInput.safeParse(decideInput()).success).toBe(true);
  });

  it("has no authorization field, and refuses one", () => {
    for (const key of [
      "reviewerAuthorization",
      "reviewerAuthorized",
      "authorized",
      "capabilities",
      "isInternalOperator",
    ]) {
      expect(
        DecideParticipantActivationInput.safeParse(decideInput({ [key]: true })).success,
        `${key} must be refused`,
      ).toBe(false);
    }
  });

  /**
   * One identity, not two. A separately supplied audit actor could name someone
   * other than whoever was actually authorized.
   */
  it("refuses a second, separately supplied actor identity", () => {
    expect(
      DecideParticipantActivationInput.safeParse(
        decideInput({ reviewerActorId: "mon:actor:M8ACTR00000000000000000000" }),
      ).success,
    ).toBe(false);
    expect(
      DecideParticipantActivationInput.safeParse(decideInput({ decidedByActorId: ACCOUNT })).success,
    ).toBe(false);
  });

  it("refuses a participant identity in the reviewer position", () => {
    expect(
      DecideParticipantActivationInput.safeParse({ ...decideInput(), reviewerAccountId: PARTICIPANT })
        .success,
    ).toBe(false);
  });

  it("refuses an email or display name as the reviewer", () => {
    for (const value of ["reviewer@example.invalid", "Synthetic Reviewer"]) {
      expect(
        DecideParticipantActivationInput.safeParse(decideInput({ reviewerAccountId: value })).success,
      ).toBe(false);
    }
  });
});
