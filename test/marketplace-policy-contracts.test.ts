/**
 * Marketplace policy, acceptance, and email-contact contract tests (Phase 1.3).
 *
 * **NO NETWORK, NO MAIL, NO DATABASE.** Pure shapes and pure decisions; the
 * persistence behaviour lives in `marketplace-policy.integration.test.ts`.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_REQUIRED_AUDIENCES,
  BUYER_ACCEPTANCE_MODEL,
  MarketplacePolicyVersionRecord,
  NEVER_ON_MARKETPLACE_POLICY,
  ParticipantPolicyAcceptanceRecord,
  POLICY_AUDIENCES,
  POLICY_SECTION_KEYS,
  POLICY_VERSION_STATUSES,
  selectSection,
  selectSectionsForAudience,
} from "../src/contracts/marketplace/marketplace-policy";
import {
  MONACADO_MARKETPLACE_POLICY_ID,
  MONACADO_MARKETPLACE_POLICY_V1,
  MONACADO_MARKETPLACE_POLICY_V1_HASH,
  marketplacePolicyContentHash,
  marketplacePolicyDocument,
} from "../src/contracts/marketplace/marketplace-policy-content";
import {
  BOUNCE_POSTURE,
  EMAIL_CONTACT_STATES,
  NEVER_ON_EMAIL_CONTACT,
  ParticipantEmailContactRecord,
  VERIFICATION_METHOD,
  VERIFICATION_TOKEN_BYTES,
  VERIFICATION_TOKEN_TTL_SECONDS,
  isUsableContactState,
  resolveEffectiveSupportContact,
} from "../src/contracts/marketplace/participant-email-contact";
import { DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE } from "../src/contracts/marketplace/digital-delivery-policy";
import {
  ACTIVATION_APPROVAL_REFUSAL_CODES,
  evaluateActivationApproval,
} from "../src/contracts/marketplace/activation-review";

const opaque = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const PARTICIPANT = `mon:mpart:${opaque("P13PART")}`;
const ACCOUNT = `mon:acct:${opaque("P13ACCT")}`;
const AT = "2028-07-01T09:00:00.000Z";

const approvalInput = (overrides: Record<string, unknown> = {}) => ({
  participantStatus: "UNDER_REVIEW" as const,
  profileComplete: true,
  roles: [{ role: "SELLER" as const, status: "PENDING_ACTIVATION" as const }],
  paymentReadiness: "ENABLED" as const,
  outstandingPolicyAudiences: [] as Array<"SELLER" | "PROMOTER">,
  hasVerifiedSupportContact: true,
  ...overrides,
});

// — 1 —

describe("1.3 · one policy source, many renderings", () => {
  it("selects the sections each audience is shown, in document order", () => {
    const seller = selectSectionsForAudience(MONACADO_MARKETPLACE_POLICY_V1, "SELLER");
    const promoter = selectSectionsForAudience(MONACADO_MARKETPLACE_POLICY_V1, "PROMOTER");
    const buyer = selectSectionsForAudience(MONACADO_MARKETPLACE_POLICY_V1, "BUYER");

    expect(seller.map((s) => s.key)).toContain("SELLER_RESPONSIBILITIES");
    expect(seller.map((s) => s.key)).not.toContain("PROMOTER_RESPONSIBILITIES");
    expect(promoter.map((s) => s.key)).toContain("PROMOTER_RESPONSIBILITIES");
    expect(promoter.map((s) => s.key)).not.toContain("SELLER_RESPONSIBILITIES");
    expect(buyer.map((s) => s.key)).toContain("BUYER_CHECKOUT_INFORMATION");

    /* Monacado's role is shared rather than triplicated — three copies of one
       fact would be three things to keep identical. */
    for (const view of [seller, promoter, buyer]) {
      expect(view.map((s) => s.key)).toContain("MONACADO_ROLE");
    }

    /* Order is the DOCUMENT's, never re-sorted per audience: a policy read in a
       different order is a different policy. */
    const documentOrder = MONACADO_MARKETPLACE_POLICY_V1.sections.map((s) => s.key);
    for (const view of [seller, promoter, buyer]) {
      const keys = view.map((s) => s.key);
      expect(keys).toEqual(documentOrder.filter((k) => keys.includes(k)));
    }
  });

  it("keeps every audience and section key closed", () => {
    expect(POLICY_AUDIENCES).toEqual(["SELLER", "PROMOTER", "BUYER"]);
    expect(ACCEPTANCE_REQUIRED_AUDIENCES).toEqual(["SELLER", "PROMOTER"]);
    /* A buyer accepts nothing to buy: gating a purchase behind a click-through
       would add friction to the one flow that must not have it, and a guest has
       no durable identity to record an acceptance against. */
    expect(BUYER_ACCEPTANCE_MODEL).toBe("DISCLOSURE_NOT_ACCEPTANCE");
    for (const section of MONACADO_MARKETPLACE_POLICY_V1.sections) {
      expect(POLICY_SECTION_KEYS).toContain(section.key);
    }
  });

  it("states the digital-delivery allowance and takes it from the policy constant", () => {
    const delivery = selectSection(MONACADO_MARKETPLACE_POLICY_V1, "DIGITAL_DELIVERY");
    expect(delivery).not.toBeNull();
    const prose = delivery!.paragraphs.join(" ");
    expect(prose).toContain(`${DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE} successful downloads`);
    expect(DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE).toBe(5);

    /* The durable right and the transient credential, kept apart in the prose
       exactly as they are in the code. */
    expect(prose).toMatch(/durable entitlement/i);
    expect(prose).toMatch(/is not the entitlement/i);
    expect(prose).toMatch(/permanent reusable secret link/i);
    /* Seller owns exceptional access; Monacado owns the infrastructure. */
    expect(prose).toMatch(/seller's authorisation|seller decides/i);
  });

  it("references mutable commercial figures instead of copying them", () => {
    const prose = MONACADO_MARKETPLACE_POLICY_V1.sections
      .flatMap((s) => s.paragraphs)
      .join(" ");
    /* A copied rate is a second authority, and the copy is always the one
       somebody reads. */
    expect(prose).not.toMatch(/7\.5\s*%|750 basis points|\$1\.00 fixed/);
    const commercial = selectSection(
      MONACADO_MARKETPLACE_POLICY_V1,
      "COMMERCIAL_POLICY_REFERENCE",
    );
    expect(commercial!.references.some((r) => r.kind === "COMMERCIAL_POLICY")).toBe(true);
  });

  it("states operating rules and invents no legal conclusion", () => {
    /* The banned list is a list of FIELDS, checked as fields. The prose is
       checked separately below: "the applicable tax jurisdiction" is an
       operating fact, while a `jurisdiction` field would be a legal ruling. */
    const serialised = JSON.stringify(MONACADO_MARKETPLACE_POLICY_V1);
    for (const forbidden of NEVER_ON_MARKETPLACE_POLICY) {
      expect(serialised, forbidden).not.toContain(`"${forbidden}"`);
    }

    /* No jurisdiction-specific conclusion: that is counsel's, not a contract
       module's. */
    const prose = MONACADO_MARKETPLACE_POLICY_V1.sections
      .flatMap((s) => s.paragraphs)
      .join(" ")
      .toLowerCase();
    for (const legal of [
      "governing law",
      "warranty",
      "limitation of liability",
      "arbitration",
      "indemnif",
      "under the laws of",
    ]) {
      expect(prose, legal).not.toContain(legal);
    }
  });

  it("carries no markup, so one source renders to every channel", () => {
    for (const section of MONACADO_MARKETPLACE_POLICY_V1.sections) {
      for (const paragraph of section.paragraphs) {
        expect(paragraph).not.toMatch(/<[a-z/]|\*\*|^#|\[.*\]\(/i);
      }
    }
  });
});

// — 2 —

describe("1.3 · the content hash binds prose to a version", () => {
  it("is deterministic and independent of key order", () => {
    const again = marketplacePolicyContentHash(MONACADO_MARKETPLACE_POLICY_V1);
    expect(again).toBe(MONACADO_MARKETPLACE_POLICY_V1_HASH);
    expect(again).toMatch(/^sha256:[0-9a-f]{64}$/);

    /* Re-serialised through JSON — key order preserved but object identity
       different — must hash identically, or the binding is worthless. */
    const roundTripped = JSON.parse(JSON.stringify(MONACADO_MARKETPLACE_POLICY_V1));
    expect(marketplacePolicyContentHash(roundTripped)).toBe(MONACADO_MARKETPLACE_POLICY_V1_HASH);
  });

  it("changes when a single character of prose changes", () => {
    /* THE failure this exists to detect: prose moving without a version bump. */
    const tampered = JSON.parse(JSON.stringify(MONACADO_MARKETPLACE_POLICY_V1));
    tampered.sections[0].paragraphs[0] = `${tampered.sections[0].paragraphs[0]}.`;
    expect(marketplacePolicyContentHash(tampered)).not.toBe(
      MONACADO_MARKETPLACE_POLICY_V1_HASH,
    );
  });

  it("resolves a document by version, and nothing for an unknown one", () => {
    expect(marketplacePolicyDocument("1.0.0")).not.toBeNull();
    expect(marketplacePolicyDocument("9.9.9")).toBeNull();
  });

  it("reuses 0M.R1's version lifecycle rather than inventing one", () => {
    expect(POLICY_VERSION_STATUSES).toEqual(["DRAFT", "ACTIVE", "RETIRED"]);
    const record = MarketplacePolicyVersionRecord.parse({
      policyId: MONACADO_MARKETPLACE_POLICY_ID,
      policyVersion: "1.0.0",
      status: "ACTIVE",
      title: "Monacado Marketplace Policy",
      contentRef: "marketplace-policy/1.0.0",
      contentHash: MONACADO_MARKETPLACE_POLICY_V1_HASH,
      requiresReacceptance: true,
      effectiveFrom: AT,
      recordedByAccountId: ACCOUNT,
      recordedAt: AT,
      activatedAt: AT,
      retiredAt: null,
    });
    expect(record.status).toBe("ACTIVE");
  });
});

// — 3 —

describe("1.3 · acceptance records an exact version and audience", () => {
  const base = {
    acceptanceId: `mon:pacc:${opaque("P13ACC")}`,
    participantId: PARTICIPANT,
    policyId: MONACADO_MARKETPLACE_POLICY_ID,
    policyVersion: "1.0.0",
    audience: "SELLER" as const,
    contentHash: MONACADO_MARKETPLACE_POLICY_V1_HASH,
    mechanism: "ONBOARDING_AFFIRMATION" as const,
    acceptedAt: AT,
    acceptedByAccountId: ACCOUNT,
    recordedAt: AT,
  };

  it("pins the exact bytes accepted", () => {
    const parsed = ParticipantPolicyAcceptanceRecord.parse(base);
    /* "They accepted the terms" is worthless without "which terms". */
    expect(parsed.policyVersion).toBe("1.0.0");
    expect(parsed.contentHash).toBe(MONACADO_MARKETPLACE_POLICY_V1_HASH);
  });

  it("refuses a buyer audience — a buyer accepts nothing to buy", () => {
    expect(
      ParticipantPolicyAcceptanceRecord.safeParse({ ...base, audience: "BUYER" }).success,
    ).toBe(false);
  });

  it("has no field for a mutable status or free-text note", () => {
    for (const forbidden of ["status", "state", "note", "withdrawnAt", "supersededBy"]) {
      expect(
        ParticipantPolicyAcceptanceRecord.safeParse({ ...base, [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });
});

// — 4 —

describe("1.3 · the support-contact resolver is the only precedence", () => {
  const verified = (address: string) => ({ address, state: "VERIFIED" as const });
  const unverified = (address: string) => ({ address, state: "UNVERIFIED" as const });

  it("prefers a verified dedicated address", () => {
    const out = resolveEffectiveSupportContact({
      primary: verified("owner@example.test"),
      dedicated: verified("help@example.test"),
    });
    expect(out).toEqual({
      available: true,
      address: "help@example.test",
      source: "DEDICATED_SUPPORT",
    });
  });

  it("falls back to the verified primary when no dedicated address is set", () => {
    /* A single-operator seller is never forced to run a second mailbox. */
    const out = resolveEffectiveSupportContact({
      primary: verified("owner@example.test"),
      dedicated: null,
    });
    expect(out).toEqual({
      available: true,
      address: "owner@example.test",
      source: "PRIMARY_PROFILE",
    });
  });

  it("does NOT let an unverified dedicated address displace a working primary", () => {
    /* Switching optimistically would make every typo an outage on the one
       channel a buyer uses to complain about it. */
    const out = resolveEffectiveSupportContact({
      primary: verified("owner@example.test"),
      dedicated: unverified("typo@example.test"),
    });
    expect(out).toEqual({
      available: true,
      address: "owner@example.test",
      source: "PRIMARY_PROFILE",
    });
  });

  it("falls back rather than failing when a dedicated address degrades", () => {
    const out = resolveEffectiveSupportContact({
      primary: verified("owner@example.test"),
      dedicated: { address: "help@example.test", state: "DELIVERY_FAILED" },
    });
    expect(out).toMatchObject({ available: true, source: "PRIMARY_PROFILE" });
  });

  it("reports no contact when nothing is usable, and says which kind of nothing", () => {
    expect(
      resolveEffectiveSupportContact({
        primary: unverified("owner@example.test"),
        dedicated: null,
      }),
    ).toEqual({ available: false, reason: "NO_VERIFIED_ADDRESS" });

    /* An operator needs to know whether to chase onboarding or an outage. */
    expect(
      resolveEffectiveSupportContact({
        primary: { address: "owner@example.test", state: "REVERIFY_REQUIRED" },
        dedicated: null,
      }),
    ).toEqual({ available: false, reason: "VERIFIED_ADDRESS_REQUIRES_REVERIFICATION" });

    expect(
      resolveEffectiveSupportContact({ primary: null, dedicated: null }),
    ).toEqual({ available: false, reason: "NO_VERIFIED_ADDRESS" });
  });

  it("treats exactly one state as usable", () => {
    expect(EMAIL_CONTACT_STATES).toEqual([
      "UNVERIFIED",
      "VERIFIED",
      "REVERIFY_REQUIRED",
      "DELIVERY_FAILED",
    ]);
    for (const state of EMAIL_CONTACT_STATES) {
      expect(isUsableContactState(state), state).toBe(state === "VERIFIED");
    }
  });

  it("is not reimplemented anywhere else", () => {
    /* Four copies of a fallback rule is four chances to disclose the wrong
       address — and the wrong address means a buyer's complaint reaches nobody. */
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const file of [
      "../src/server/payments/executable-checkout-service.ts",
      "../src/server/notifications/transactional-notice-service.ts",
      "../src/server/policy/order-policy-view-service.ts",
    ]) {
      const source = strip(readFileSync(new URL(file, import.meta.url), "utf8"));
      expect(source.includes("DEDICATED_SUPPORT"), file).toBe(false);
    }
  });
});

// — 5 —

describe("1.3 · email contacts and verification", () => {
  const contact = (over: Record<string, unknown> = {}) => ({
    contactId: `mon:pemc:${opaque("P13EMC")}`,
    participantId: PARTICIPANT,
    purpose: "DEDICATED_SUPPORT" as const,
    address: "help@example.test",
    state: "VERIFIED" as const,
    verifiedAt: AT,
    degradedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });

  it("never stores a copy of the primary address", () => {
    /* 0M.5: the address already lives on Account and a second copy here would
       be a second thing to leak. */
    expect(
      ParticipantEmailContactRecord.safeParse(
        contact({ purpose: "PRIMARY_PROFILE", address: null }),
      ).success,
    ).toBe(true);
    expect(
      ParticipantEmailContactRecord.safeParse(
        contact({ purpose: "PRIMARY_PROFILE", address: "owner@example.test" }),
      ).success,
    ).toBe(false);
    /* A dedicated address exists nowhere else, so it must be carried. */
    expect(
      ParticipantEmailContactRecord.safeParse(
        contact({ purpose: "DEDICATED_SUPPORT", address: null }),
      ).success,
    ).toBe(false);
  });

  it("requires a verified contact to record when it verified", () => {
    expect(
      ParticipantEmailContactRecord.safeParse(contact({ verifiedAt: null })).success,
    ).toBe(false);
  });

  it("carries no token, tracking, or reputation field", () => {
    for (const forbidden of NEVER_ON_EMAIL_CONTACT) {
      expect(
        ParticipantEmailContactRecord.safeParse(contact({ [forbidden]: "x" })).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("uses a signed one-time link and refuses SMTP mailbox probing", () => {
    expect(VERIFICATION_METHOD.ownership).toBe("SIGNED_SINGLE_USE_LINK");
    /* VRFY and dial-up probes are unreliable, widely treated as abuse, and
       prove nothing about who controls the mailbox even when they answer. */
    expect(VERIFICATION_METHOD.smtpMailboxProbing).toBe("NOT_USED");
    expect(VERIFICATION_METHOD.proves).toBe("CONTROL_AT_ONE_INSTANT");
  });

  it("issues a high-entropy token that expires", () => {
    expect(VERIFICATION_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
    expect(VERIFICATION_TOKEN_TTL_SECONDS).toBeGreaterThan(0);
    expect(VERIFICATION_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(7 * 24 * 60 * 60);
  });

  it("names the bounce states without pretending to process bounces", () => {
    expect(BOUNCE_POSTURE.statesAvailable).toEqual(["REVERIFY_REQUIRED", "DELIVERY_FAILED"]);
    expect(BOUNCE_POSTURE.automaticTransitions).toBe("NONE_IN_THIS_PHASE");
    expect(BOUNCE_POSTURE.onDegradation).toBe("SELLER_SUPPLIES_AND_VERIFIES_REPLACEMENT");
  });

  it("introduces no plaintext token column anywhere in the schema", () => {
    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    for (const forbidden of ["token ", "verificationToken", "tokenPlaintext", "verificationLink"]) {
      expect(new RegExp(`^\\s+${forbidden.trim()}\\s`, "mi").test(schema), forbidden).toBe(false);
    }
    /* Only the digest is written down. */
    expect(/^\s+tokenDigest\s/m.test(schema)).toBe(true);
  });

  it("hashes a token rather than storing it", async () => {
    const { hashVerificationToken } = await import(
      "../src/server/policy/email-verification-service"
    );
    const token = "a-known-token-value";
    expect(hashVerificationToken(token)).toBe(
      createHash("sha256").update(token, "utf8").digest("hex"),
    );
    expect(hashVerificationToken(token)).not.toContain(token);
  });
});

// — 6 —

describe("1.3 · activation requires acceptance and a support contact", () => {
  it("allows when both prerequisites hold", () => {
    expect(evaluateActivationApproval(approvalInput())).toEqual({
      decision: "ALLOW",
      refusalCodes: [],
    });
  });

  it("refuses a seller who has not accepted the current policy", () => {
    const out = evaluateActivationApproval(
      approvalInput({ outstandingPolicyAudiences: ["SELLER"] }),
    );
    expect(out.decision).toBe("DENY");
    expect(out.refusalCodes).toContain("MARKETPLACE_POLICY_NOT_ACCEPTED");
  });

  it("refuses a promoter who has not accepted the current policy", () => {
    const out = evaluateActivationApproval(
      approvalInput({
        roles: [{ role: "PROMOTER", status: "PENDING_ACTIVATION" }],
        outstandingPolicyAudiences: ["PROMOTER"],
      }),
    );
    expect(out.decision).toBe("DENY");
    expect(out.refusalCodes).toContain("MARKETPLACE_POLICY_NOT_ACCEPTED");
  });

  it("refuses when no verified support contact remains", () => {
    /* An activated seller with nowhere for buyers to go. Fails closed. */
    const out = evaluateActivationApproval(
      approvalInput({ hasVerifiedSupportContact: false }),
    );
    expect(out.decision).toBe("DENY");
    expect(out.refusalCodes).toContain("NO_VERIFIED_SUPPORT_CONTACT");
  });

  it("keeps the new refusals distinct from profile completeness", () => {
    /* Different remedies: one is finishing a form, the other is agreeing to
       something, the third is fixing a mailbox. */
    for (const code of ["MARKETPLACE_POLICY_NOT_ACCEPTED", "NO_VERIFIED_SUPPORT_CONTACT"]) {
      expect(ACTIVATION_APPROVAL_REFUSAL_CODES).toContain(code);
    }
    const out = evaluateActivationApproval(
      approvalInput({ outstandingPolicyAudiences: ["SELLER"], hasVerifiedSupportContact: false }),
    );
    expect(out.refusalCodes).not.toContain("PROFILE_NOT_COMPLETE");
    expect(out.refusalCodes).toHaveLength(2);
  });
});
