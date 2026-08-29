/**
 * Phase 1.14 — Marketplace Policy 1.3.0 and governed risk mitigation.
 *
 * Pure. No database, no network, no credential. Every fact below is a vocabulary,
 * a document, or a pure decision — which is the point: the rules that decide
 * whether somebody's livelihood may be withheld should be checkable without
 * standing a marketplace up.
 *
 * The source-scanning tests near the end are deliberate. Several of this phase's
 * commitments — no automatic suspension, no prose, no publication — are
 * properties of what the code does NOT contain, and the only way to assert an
 * absence is to read the file.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  LATEST_MARKETPLACE_POLICY_VERSION,
  MARKETPLACE_POLICY_CONTENT_REFS,
  MARKETPLACE_POLICY_ONBOARDING_ACCEPTANCE,
  MARKETPLACE_POLICY_VERSION_1_3,
  MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_2_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_3,
  MONACADO_MARKETPLACE_POLICY_V1_3_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_HASH,
  marketplacePolicyDocument,
} from "../src/contracts/marketplace/marketplace-policy-content";
import { POLICY_SECTION_KEYS } from "../src/contracts/marketplace/marketplace-policy";
import {
  MITIGATION_CODE_FORBIDDEN_TERMS,
  NEVER_IN_PARTICIPANT_NOTICE,
  NEVER_ON_PARTICIPANT_MITIGATION,
  PARTICIPANT_MITIGATION_PUBLICATION_DISPOSITION,
  POLICY_VERSIONS_AUTHORIZING_PARTICIPANT_MITIGATION,
  RECONSIDERATION_DETERMINATIONS,
  RECONSIDERATION_GROUND_CODES,
  RECONSIDERATION_REMEDIATION_CLAIM_CODES,
  RECONSIDERATION_STATUSES,
  SUSPENSION_LIFT_REASON_CODES,
  SUSPENSION_PRESERVES,
  SUSPENSION_REASON_CODES,
  SUSPENSION_STATUSES,
  SuspendParticipantInput,
  isValidReconsiderationTransition,
  policyVersionAuthorizesParticipantMitigation,
  reinstatementTargetStatus,
  suspendedStatusIsSupported,
} from "../src/contracts/marketplace/participant-mitigation";
import {
  RESTRICTION_LIFT_REASON_CODES,
  RESTRICTION_REASON_CODES,
  RISK_DERIVED_RESTRICTION_REASON_CODES,
} from "../src/contracts/marketplace/participant-restriction";
import { DRAFTING_PARTICIPANT_STATUSES } from "../src/contracts/marketplace/participant";
import { PARTICIPANT_STATUS_TRANSITIONS } from "../src/contracts/marketplace/lifecycle";
import {
  ACCOUNT_CAPABILITIES,
  AccountCapability,
} from "../src/contracts/account/account";
import {
  PARTICIPANT_SUSPEND_CAPABILITY,
  canRestrictParticipant,
  canReviewParticipantRisk,
  canSuspendParticipant,
  isInternallyAuthorized,
} from "../src/contracts/account/internal-authorization";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SUBJECT_KINDS,
  PARTICIPANT_DECISION_CONTEXT_CODES,
} from "../src/contracts/marketplace/notification-obligation";
import {
  MARKETPLACE_POLICY_RISK_TERMS_REQUIRED,
  RISK_REVIEW_DISPOSITIONS,
} from "../src/contracts/marketplace/seller-risk-review";
import { FRAUD_AND_RISK_ANALYTICS_HANDOFF } from "../src/contracts/marketplace/transaction-dispute";

const readCode = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

/** The file with comments stripped — see the 1.13 suite for why. */
const readExecutableCode = (path: string): string =>
  readCode(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** The server modules that actually execute a mitigation act. */
const PHASE_SERVER_FILES = [
  "src/server/marketplace/participant-suspension-service.ts",
  "src/server/marketplace/participant-reconsideration-service.ts",
  "src/server/marketplace/participant-mitigation-policy.ts",
  "src/server/marketplace/participant-mitigation-notice.ts",
  "src/server/marketplace/participant-mitigation-errors.ts",
];

const PHASE_FILES = [
  "src/contracts/marketplace/participant-mitigation.ts",
  "src/server/marketplace/participant-suspension-service.ts",
  "src/server/marketplace/participant-reconsideration-service.ts",
  "src/server/marketplace/participant-mitigation-policy.ts",
  "src/server/marketplace/participant-mitigation-notice.ts",
  "src/server/marketplace/participant-mitigation-errors.ts",
];

const policyText = (): string =>
  MONACADO_MARKETPLACE_POLICY_V1_3.sections
    .flatMap((s) => s.paragraphs)
    .join("\n")
    .toLowerCase();

// — 1 · Marketplace Policy 1.3.0 —

describe("1.14 · Marketplace Policy 1.3.0 is a new document, not an edit", () => {
  it("leaves every earlier version's hash byte-identical", () => {
    /* THE immutability guarantee. A shared paragraph constant would move these,
       and therefore what participants are recorded as having accepted. */
    expect(MONACADO_MARKETPLACE_POLICY_V1_HASH).toBe(
      "sha256:e50e87716ca2156eb51afa0fab52d4ab925109e8147199ece3a8e3160443cb85",
    );
    expect(MONACADO_MARKETPLACE_POLICY_V1_1_HASH).toBe(
      "sha256:b0a48644c8c146e2247d20de20140f6e124435401cad1ce096140ca5128e74b6",
    );
    expect(MONACADO_MARKETPLACE_POLICY_V1_2_HASH).toBe(
      "sha256:ab1fea6a75edfb1f204c2656e218c42076ee8311294e6a816b2d12d455649181",
    );
  });

  it("derives its own hash and differs from every predecessor", () => {
    expect(MONACADO_MARKETPLACE_POLICY_V1_3_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const earlier of [
      MONACADO_MARKETPLACE_POLICY_V1_HASH,
      MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
      MONACADO_MARKETPLACE_POLICY_V1_2_HASH,
    ]) {
      expect(MONACADO_MARKETPLACE_POLICY_V1_3_HASH).not.toBe(earlier);
    }
  });

  it("shares no section object with an earlier version", () => {
    /* Identity, not equality: a shared object would be a shared byte. */
    const earlier = new Set(
      ["1.0.0", "1.1.0", "1.2.0"].flatMap((v) => marketplacePolicyDocument(v)!.sections),
    );
    for (const section of MONACADO_MARKETPLACE_POLICY_V1_3.sections) {
      expect(earlier.has(section), section.key).toBe(false);
    }
  });

  it("becomes the latest shipped version and requires reacceptance", () => {
    expect(LATEST_MARKETPLACE_POLICY_VERSION).toBe(MARKETPLACE_POLICY_VERSION_1_3);
    expect(MARKETPLACE_POLICY_ONBOARDING_ACCEPTANCE.get("1.3.0")).toBe(true);
    expect(MARKETPLACE_POLICY_CONTENT_REFS.get("1.3.0")).toBe("marketplace-policy/1.3.0");
    expect(marketplacePolicyDocument("1.3.0")).not.toBeNull();
  });

  it("keeps POLICY_CHANGES last and adds exactly two sections", () => {
    const keys = MONACADO_MARKETPLACE_POLICY_V1_3.sections.map((s) => s.key);
    expect(keys[keys.length - 1]).toBe("POLICY_CHANGES");
    expect(keys).toHaveLength(16);
    expect(keys).toContain("MARKETPLACE_INTEGRITY_AND_RISK_REVIEW");
    expect(keys).toContain("PARTICIPANT_RESTRICTIONS_AND_SUSPENSION");
    for (const added of [
      "MARKETPLACE_INTEGRITY_AND_RISK_REVIEW",
      "PARTICIPANT_RESTRICTIONS_AND_SUSPENSION",
    ]) {
      expect(POLICY_SECTION_KEYS as readonly string[]).toContain(added);
      /* Additive: no earlier version carries the new keys, which is why their
         canonical JSON and hashes are untouched. */
      for (const v of ["1.0.0", "1.1.0", "1.2.0"]) {
        expect(marketplacePolicyDocument(v)!.sections.map((s) => s.key)).not.toContain(added);
      }
    }
  });

  it("addresses the new sections to sellers and promoters, never buyers", () => {
    /* A buyer-facing section on how Monacado restricts sellers tells a buyer
       nothing they can act on and invites them to read an absence as an
       accusation. The one fact a buyer does need — that a completed purchase
       stands — lives on MONACADO_ROLE, which already reaches all three. */
    for (const key of [
      "MARKETPLACE_INTEGRITY_AND_RISK_REVIEW",
      "PARTICIPANT_RESTRICTIONS_AND_SUSPENSION",
    ]) {
      const section = MONACADO_MARKETPLACE_POLICY_V1_3.sections.find((s) => s.key === key)!;
      expect(section.audiences, key).not.toContain("BUYER");
      expect(section.audiences, key).toEqual(["SELLER", "PROMOTER"]);
    }
    const role = MONACADO_MARKETPLACE_POLICY_V1_3.sections.find(
      (s) => s.key === "MONACADO_ROLE",
    )!;
    expect(role.audiences).toContain("BUYER");
    expect(role.paragraphs.join(" ")).toContain("merchant of record for every purchase already");
  });

  it("changes no DISPUTE_EFFECT_ON_PROCEEDS paragraph", () => {
    /* Its load-bearing sentence — a per-sale hold "is not a suspension of a
       participant's other proceeds" — stays true and unedited. 1.3.0 adds a
       separately-grounded authority beside it rather than softening it. */
    const before = marketplacePolicyDocument("1.2.0")!.sections.find(
      (s) => s.key === "DISPUTE_EFFECT_ON_PROCEEDS",
    )!;
    const after = MONACADO_MARKETPLACE_POLICY_V1_3.sections.find(
      (s) => s.key === "DISPUTE_EFFECT_ON_PROCEEDS",
    )!;
    expect(after.paragraphs).toEqual(before.paragraphs);
    expect(after.references.length).toBe(before.references.length + 1);
  });
});

// — 2 · What the policy may not claim —

describe("1.14 · the policy text is a ceiling, not a wish list", () => {
  it("claims no automated fraud decision", () => {
    const text = policyText();
    for (const forbidden of [
      "automated system",
      "automatically suspend",
      "automatically restrict",
      "our systems determine",
      "proves",
      "fraudulent conduct",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    /* And says the opposite, in terms. */
    expect(text).toContain("a signal is a measurement, not a finding");
    expect(text).toContain("signals decide nothing by themselves");
  });

  it("promises no advance notice, no appeal, and no deadline", () => {
    const text = policyText();
    expect(text).toContain("nothing in this policy promises notice in advance");
    /* Never present at all: there is nothing in the implementation these could
       even be denying. */
    for (const overclaim of [
      "independent panel",
      "ombudsman",
      "right of appeal",
      "external review",
      "within 30 days",
      "business days",
    ]) {
      expect(text, overclaim).not.toContain(overclaim);
    }
    /* `arbitration`, `appeal`, and `independent review` DO appear — inside the
       sentences that deny them. Asserting their absence would have forbidden the
       disclaimer, which is the opposite of what this test is for. So the
       assertion is that every occurrence sits in a denial. */
    for (const sentence of text.split(".")) {
      const claims = ["arbitration", "appeal", "independent review"].filter((t) =>
        sentence.includes(t),
      );
      if (claims.length === 0) continue;
      expect(sentence, sentence.trim()).toMatch(/\bnot\b|\bno\b/);
    }
    /* Reconsideration is named for what it is, and its limits are stated. */
    expect(text).toContain("it is not an appeal to anybody outside monacado");
    expect(text).toContain("monacado is not obliged to reverse a decision");
  });

  it("promises no expiry, because none exists", () => {
    const text = policyText();
    expect(text).toContain("neither a restriction nor a suspension expires on its own");
  });

  it("states that obligations survive, and that identity is not deleted", () => {
    const text = policyText();
    expect(text).toContain("do not release a participant from what they already owe");
    expect(text).toContain(
      "does not remove their participant record, their roles, their completed orders",
    );
    expect(text).toContain("it is not a finding of fraud");
  });

  it("keeps seller and promoter responsibility separate", () => {
    const text = policyText();
    expect(text).toContain("neither outcome follows automatically from the other");
    expect(text).toContain(
      "does not by itself make either party responsible for the other's conduct",
    );
  });

  it("preserves the merchant-of-record framing and no facilitator wording", () => {
    const text = policyText();
    for (const forbidden of [
      "on behalf of the seller",
      "on behalf of a seller",
      "forwards funds",
      "forward buyer funds",
      "the seller's share of buyer payments",
      "pass through to seller",
      "payment facilitator",
      "payfac",
      "settlement to the seller",
      "processes payments for",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).toContain("withholding a payout is not a forfeiture");
  });
});

// — 3 · The governance gate —

describe("1.14 · the terms gate the act, and the ACTIVE version is what counts", () => {
  it("authorises participant mitigation only from 1.3.0", () => {
    expect([...POLICY_VERSIONS_AUTHORIZING_PARTICIPANT_MITIGATION]).toEqual(["1.3.0"]);
    expect(policyVersionAuthorizesParticipantMitigation("1.3.0")).toBe(true);
    for (const earlier of ["1.0.0", "1.1.0", "1.2.0"]) {
      expect(policyVersionAuthorizesParticipantMitigation(earlier), earlier).toBe(false);
    }
    /* Fails closed: no active policy is a refusal, not a default. */
    expect(policyVersionAuthorizesParticipantMitigation(null)).toBe(false);
  });

  it("reads the active row and never the newest shipped version", () => {
    /* `LATEST_MARKETPLACE_POLICY_VERSION` is documented as "not an assertion
       that it governs anything". A gate reading it would let publishing 1.3.0
       confer an authority nobody activated. */
    const gate = readExecutableCode("src/server/marketplace/participant-mitigation-policy.ts");
    expect(gate).toContain("getActiveMarketplacePolicyVersionIn");
    expect(gate).not.toContain("LATEST_MARKETPLACE_POLICY_VERSION");
  });

  it("gates risk-derived restriction grounds and only those", () => {
    /* Gating every restriction would make a deployment unable to finish
       underwriting until it had activated a policy about risk monitoring — an
       authority nobody claimed was missing. */
    for (const risky of RISK_DERIVED_RESTRICTION_REASON_CODES) {
      expect(RESTRICTION_REASON_CODES as readonly string[], risky).toContain(risky);
    }
    for (const operational of [
      "UNDERWRITING_REVIEW_REQUIRED",
      "PROVIDER_REQUIREMENT_UNRESOLVED",
      "MANUAL_OPERATIONAL_RESTRICTION",
    ]) {
      expect(RISK_DERIVED_RESTRICTION_REASON_CODES as readonly string[]).not.toContain(
        operational,
      );
    }
  });
});

// — 4 · Suspension —

describe("1.14 · suspension is not a restriction with a louder name", () => {
  it("differs from RESTRICTED on drafting, which is the real distinction", () => {
    /* The machine-readable content 0M.8 said the status lacked. A restriction
       withholds commerce and leaves the participant able to correct the work
       that caused it; a suspension withholds that too. */
    expect(DRAFTING_PARTICIPANT_STATUSES as readonly string[]).toContain("RESTRICTED");
    expect(DRAFTING_PARTICIPANT_STATUSES as readonly string[]).not.toContain("SUSPENDED");
  });

  it("uses transitions the committed lifecycle table already permits", () => {
    expect(PARTICIPANT_STATUS_TRANSITIONS.ACTIVE).toContain("SUSPENDED");
    expect(PARTICIPANT_STATUS_TRANSITIONS.RESTRICTED).toContain("SUSPENDED");
    expect(PARTICIPANT_STATUS_TRANSITIONS.SUSPENDED).toContain("ACTIVE");
    expect(PARTICIPANT_STATUS_TRANSITIONS.SUSPENDED).toContain("RESTRICTED");
    /* CLOSED is never a suspension outcome — it is terminal, and reopening is a
       new admission decision with its own record. */
    expect(PARTICIPANT_STATUS_TRANSITIONS.CLOSED).toEqual([]);
  });

  it("has two states, no expiry, and a separate lift vocabulary", () => {
    expect([...SUSPENSION_STATUSES]).toEqual(["ACTIVE", "LIFTED"]);
    const shared = SUSPENSION_REASON_CODES.filter((c) =>
      (SUSPENSION_LIFT_REASON_CODES as readonly string[]).includes(c),
    );
    expect(shared).toEqual([]);
  });

  it("names no conclusion in any mitigation vocabulary", () => {
    const every = [
      ...SUSPENSION_REASON_CODES,
      ...SUSPENSION_LIFT_REASON_CODES,
      ...RESTRICTION_REASON_CODES,
      ...RESTRICTION_LIFT_REASON_CODES,
      ...RECONSIDERATION_GROUND_CODES,
      ...RECONSIDERATION_REMEDIATION_CLAIM_CODES,
      ...RECONSIDERATION_DETERMINATIONS,
    ];
    for (const code of every) {
      for (const forbidden of MITIGATION_CODE_FORBIDDEN_TERMS) {
        expect(code, `${code}/${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("reinstates by reconciling rather than assuming", () => {
    /* Standing restrictions win. Restoring the remembered status blindly would
       leave a participant at ACTIVE holding active restrictions — the exact
       divergence the 0M.R1 invariant exists to prevent, in reverse. */
    expect(
      reinstatementTargetStatus({
        currentStatus: "SUSPENDED",
        activeRestrictionCount: 2,
        statusBeforeSuspension: "ACTIVE",
      }),
    ).toBe("RESTRICTED");
    expect(
      reinstatementTargetStatus({
        currentStatus: "SUSPENDED",
        activeRestrictionCount: 0,
        statusBeforeSuspension: "ACTIVE",
      }),
    ).toBe("ACTIVE");
    /* Remembered RESTRICTED with nothing standing returns to ACTIVE, because a
       participant is never RESTRICTED without active evidence. */
    expect(
      reinstatementTargetStatus({
        currentStatus: "SUSPENDED",
        activeRestrictionCount: 0,
        statusBeforeSuspension: "RESTRICTED",
      }),
    ).toBe("ACTIVE");
    /* Not suspended: nothing to reinstate. */
    expect(
      reinstatementTargetStatus({
        currentStatus: "ACTIVE",
        activeRestrictionCount: 0,
        statusBeforeSuspension: "ACTIVE",
      }),
    ).toBeNull();
  });

  it("is never SUSPENDED without evidence", () => {
    expect(suspendedStatusIsSupported(0)).toBe(false);
    expect(suspendedStatusIsSupported(1)).toBe(true);
  });

  it("preserves identity, roles, orders, and obligations", () => {
    for (const preserved of [
      "PARTICIPANT_IDENTITY",
      "MARKETPLACE_ROLES",
      "COMPLETED_ORDERS",
      "BUYER_REFUND_RIGHTS",
      "DISPUTE_OBLIGATIONS",
      "AUDIT_EVIDENCE",
    ]) {
      expect(SUSPENSION_PRESERVES as readonly string[], preserved).toContain(preserved);
    }
  });

  it("refuses a score, a note, or buyer data on any mitigation input", () => {
    const base = {
      participantId: "mon:mpart:ABCDEFGHJKMNPQRSTVWXYZ0123",
      reasonCode: "MANUAL_OPERATIONAL_SUSPENSION" as const,
      actingAccountId: "mon:acct:ABCDEFGHJKMNPQRSTVWXYZ0123",
      suspendedAt: "2028-09-01T09:00:00.000Z",
    };
    expect(SuspendParticipantInput.safeParse(base).success).toBe(true);
    for (const forbidden of NEVER_ON_PARTICIPANT_MITIGATION) {
      expect(
        SuspendParticipantInput.safeParse({ ...base, [forbidden]: 1 }).success,
        forbidden,
      ).toBe(false);
    }
  });
});

// — 5 · Authority —

describe("1.14 · suspending, restricting, and reviewing are three grants", () => {
  const subject = (capabilities: string[]) => ({
    accountId: "mon:acct:ABCDEFGHJKMNPQRSTVWXYZ0123",
    accountStatus: "ACTIVE" as const,
    capabilities: capabilities as never,
  });

  it("mints a narrow, non-wildcard capability", () => {
    expect(ACCOUNT_CAPABILITIES).toContain("participant:suspend");
    expect(PARTICIPANT_SUSPEND_CAPABILITY).toBe("participant:suspend");
    for (const capability of ACCOUNT_CAPABILITIES) {
      expect(capability, capability).not.toContain("*");
      expect(capability.toLowerCase(), capability).not.toContain("admin");
      expect(capability, capability).toMatch(/^[a-z][a-z-]*(:[a-z][a-z-]*)+$/);
    }
    for (const forbidden of ["participant:*", "admin", "risk:*", "participant:suspend "]) {
      expect(AccountCapability.safeParse(forbidden).success, forbidden).toBe(false);
    }
  });

  it("keeps all three independent in every direction", () => {
    expect(isInternallyAuthorized(canSuspendParticipant(subject(["participant:suspend"])))).toBe(
      true,
    );
    /* Restricting does not confer suspending — suspension reaches drafting and
       activation:submit, which a restriction may never touch. */
    expect(isInternallyAuthorized(canSuspendParticipant(subject(["participant:restrict"])))).toBe(
      false,
    );
    expect(
      isInternallyAuthorized(canSuspendParticipant(subject(["participant:risk-review"]))),
    ).toBe(false);
    /* And suspending confers neither of the others. */
    expect(isInternallyAuthorized(canRestrictParticipant(subject(["participant:suspend"])))).toBe(
      false,
    );
    expect(
      isInternallyAuthorized(canReviewParticipantRisk(subject(["participant:suspend"]))),
    ).toBe(false);
    expect(isInternallyAuthorized(canSuspendParticipant(subject([])))).toBe(false);
    expect(isInternallyAuthorized(canSuspendParticipant(null))).toBe(false);
  });
});

// — 6 · Reconsideration —

describe("1.14 · reconsideration is bounded and honest about its limits", () => {
  it("is forward-only with DECIDED terminal", () => {
    expect([...RECONSIDERATION_STATUSES]).toEqual(["RECEIVED", "UNDER_REVIEW", "DECIDED"]);
    expect(isValidReconsiderationTransition("RECEIVED", "UNDER_REVIEW")).toBe(true);
    expect(isValidReconsiderationTransition("RECEIVED", "DECIDED")).toBe(true);
    expect(isValidReconsiderationTransition("UNDER_REVIEW", "DECIDED")).toBe(true);
    expect(isValidReconsiderationTransition("DECIDED", "UNDER_REVIEW")).toBe(false);
    expect(isValidReconsiderationTransition("DECIDED", "RECEIVED")).toBe(false);
  });

  it("promises no escalation it cannot perform", () => {
    for (const determination of RECONSIDERATION_DETERMINATIONS) {
      for (const overclaim of ["ESCALATED", "REFERRED", "EXTERNAL", "ARBITRATION", "APPEAL"]) {
        expect(determination, `${determination}/${overclaim}`).not.toContain(overclaim);
      }
    }
    expect(RECONSIDERATION_DETERMINATIONS).toContain("UPHELD");
    expect(RECONSIDERATION_DETERMINATIONS).toContain("DECISION_LIFTED_ON_RECONSIDERATION");
  });

  it("admits an out-of-vocabulary ground so inadequacy is countable", () => {
    expect(RECONSIDERATION_GROUND_CODES).toContain("CIRCUMSTANCE_NOT_COVERED_BY_THESE_CODES");
    expect(RECONSIDERATION_REMEDIATION_CLAIM_CODES).toContain(
      "SUPPORTING_MATERIAL_HELD_OUTSIDE_MONACADO",
    );
  });
});

// — 7 · Notice —

describe("1.14 · a notice states the decision, never the analysis", () => {
  it("extends the existing vocabularies rather than inventing a table", () => {
    expect(NOTIFICATION_CATEGORIES).toContain("PARTICIPANT_STANDING_CHANGED");
    expect(NOTIFICATION_SUBJECT_KINDS).toContain("PARTICIPANT_DECISION");
    for (const code of PARTICIPANT_DECISION_CONTEXT_CODES) {
      expect(code.length).toBeLessThanOrEqual(48);
    }
    /* Every new member fits the existing column widths, which is why notice
       needs no migration. */
    expect("PARTICIPANT_STANDING_CHANGED".length).toBeLessThanOrEqual(48);
    expect("PARTICIPANT_DECISION".length).toBeLessThanOrEqual(32);
  });

  it("does not reuse the operator backlog category", () => {
    /* OPERATIONAL_ACTION_REQUIRED is Monacado's OWN queue and sends nobody a
       message. Filing a participant-facing adverse notice there would make both
       unreadable. */
    const notice = readExecutableCode(
      "src/server/marketplace/participant-mitigation-notice.ts",
    );
    expect(notice).not.toContain("OPERATIONAL_ACTION_REQUIRED");
    expect(notice).toContain("PARTICIPANT_STANDING_CHANGED");
  });

  it("keys the obligation on the decision, never the participant", () => {
    /* With the participant as subject, two decisions sharing a context code
       would collapse into one obligation and the second would silently never be
       raised. */
    const notice = readCode("src/server/marketplace/participant-mitigation-notice.ts");
    expect(notice).toContain("ref: input.decisionId");
    expect(notice).not.toContain("ref: input.participantId");
  });

  it("carries none of the analysis behind the decision", () => {
    const notice = readExecutableCode(
      "src/server/marketplace/participant-mitigation-notice.ts",
    );
    for (const forbidden of NEVER_IN_PARTICIPANT_NOTICE) {
      expect(notice, forbidden).not.toContain(forbidden);
    }
  });

  it("sends no email, because no contact is guaranteed after activation", () => {
    for (const path of PHASE_FILES) {
      const code = readExecutableCode(path);
      for (const forbidden of ["outboundEmailDelivery", "sendEmail", "mailPort", "enqueueEmail"]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

// — 8 · Nothing enforces itself —

describe("1.14 · only an explicit Staff act changes a participant's standing", () => {
  it("reads no disposition, score, or report anywhere in the mitigation path", () => {
    /* Server files only: the contract module names these tokens precisely
       because it declares them forbidden, and scanning it would forbid the
       prohibition from stating what it prohibits. */
    for (const path of PHASE_SERVER_FILES) {
      const code = readExecutableCode(path);
      for (const forbidden of [
        "dispositionCode",
        "reviewScore",
        "warrantsAttention",
        "DailySellerRiskReport",
        "runDailySellerRiskReport",
        "attentionScoreFloor",
        "SUSPENSION_RECOMMENDED",
      ]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("leaves the risk review unable to enforce anything", () => {
    const review = readExecutableCode("src/server/risk/participant-risk-review-service.ts");
    for (const forbidden of [
      "participantSuspension.create",
      "participantRestriction.create",
      "marketplaceParticipant.update",
      "suspendParticipant",
      "imposeParticipantRestriction",
    ]) {
      expect(review, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps every risk disposition a recommendation", () => {
    for (const disposition of RISK_REVIEW_DISPOSITIONS) {
      expect(disposition, disposition).not.toMatch(/^(SUSPENDED|RESTRICTED|HELD)$/);
    }
    expect(RISK_REVIEW_DISPOSITIONS).toContain("SUSPENSION_RECOMMENDED");
    expect(RISK_REVIEW_DISPOSITIONS as readonly string[]).not.toContain("SUSPENDED");
  });

  it("adds no automatic-action field to the review heuristics policy", () => {
    const heuristics = readCode("src/contracts/marketplace/seller-risk-review.ts");
    for (const forbidden of ["autoSuspendAt", "autoRestrictAt", "enforcementAction"]) {
      expect(heuristics.includes(`${forbidden}:`), forbidden).toBe(false);
    }
  });

  it("states how 1.3.0 is accepted, in both modes", () => {
    /* Not a boolean asserting that an existing participant must click Accept
       again — which is not Monacado's rule and never gated anything. */
    expect(MARKETPLACE_POLICY_RISK_TERMS_REQUIRED.acceptanceModes).toEqual([
      "EXPLICIT_ONBOARDING",
      "CONTINUED_USE_AFTER_EFFECTIVE_NOTICE",
    ]);
    expect("requiresReacceptance" in MARKETPLACE_POLICY_RISK_TERMS_REQUIRED).toBe(false);
  });

  it("records which phase actually delivered the mitigation workflow", () => {
    /* The 1.12 handoff claimed 1.13 owned this; 1.13 shipped no mitigation and
       said so in its readiness report. Both statements were committed and only
       one was true. */
    expect(FRAUD_AND_RISK_ANALYTICS_HANDOFF.deliveredByPhase1_14).toContain(
      "STAFF_MITIGATION_WORKFLOW_UP_TO_SUSPENSION",
    );
    expect(FRAUD_AND_RISK_ANALYTICS_HANDOFF.deliveredByPhase1_13).not.toContain(
      "STAFF_MITIGATION_WORKFLOW_UP_TO_SUSPENSION",
    );
  });
});

// — 9 · Private posture and MoR —

describe("1.14 · mitigation records are private and publish nothing", () => {
  it("projects no capsule and reaches no registrar", () => {
    expect(PARTICIPANT_MITIGATION_PUBLICATION_DISPOSITION.capsuleProjection).toBe("NONE");
    expect(PARTICIPANT_MITIGATION_PUBLICATION_DISPOSITION.visibility).toBe("PRIVATE");
    for (const [key, value] of Object.entries(PARTICIPANT_MITIGATION_PUBLICATION_DISPOSITION)) {
      if (key === "visibility") continue;
      expect(value, key).toBe("NONE");
    }
  });

  it("writes no outbox row and contacts no registrar", () => {
    for (const path of PHASE_SERVER_FILES) {
      const code = readExecutableCode(path);
      for (const forbidden of ["publicationOutbox", "registrar", "agentNet", "AgentNet"]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("preserves the merchant-of-record model in every file", () => {
    for (const path of [
      ...PHASE_FILES,
      "src/server/marketplace/order-errors.ts",
      "src/contracts/marketplace/marketplace-policy-content.ts",
      "src/server/marketplace/participant-restriction-service.ts",
    ]) {
      const code = readCode(path).toLowerCase();
      for (const forbidden of [
        "on behalf of a seller",
        "on behalf of the seller",
        "forwards funds",
        "forward buyer funds",
        "pass through to seller",
        "payment facilitator",
        "payfac",
        "reimburse the seller",
        "payout to seller",
        "settlement to the seller",
        "processes payments for",
      ]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("carries no prose column on any mitigation record", () => {
    const schema = readCode("prisma/schema.prisma");
    const models = schema.slice(schema.indexOf("model ParticipantSuspension"));
    for (const forbidden of [
      "note ",
      "internalNote",
      "investigatorNote",
      "freeTextReason",
      "staffRationale",
      "riskScore",
      "expiresAt",
    ]) {
      expect(models, forbidden).not.toContain(forbidden);
    }
  });
});
