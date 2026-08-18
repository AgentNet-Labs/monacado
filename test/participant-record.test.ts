/**
 * Participant record contracts, privacy guard, and scope boundaries (Phase 0M.5).
 *
 * Offline: no database, no network, no clock. The database-backed behaviour
 * lives in `participant-persistence.integration.test.ts`.
 *
 * The privacy assertions here are deliberately structural — they read the Prisma
 * schema and the committed source files rather than exercising a function. A test
 * that only checks "the projector does not emit an email" passes right up until
 * someone writes a second projector; a test that checks "there is no column an
 * email could be stored in" keeps holding.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_DECISIONS,
  DRAFT_WRITABLE_PARTICIPANT_STATUSES,
  PARTICIPANT_PROFILE_SECTIONS,
  PRIVATE_PARTICIPANT_KEY_FRAGMENT_LIST,
  PUBLIC_PARTICIPANT_PROJECTION_FIELDS,
  ParticipantOnboardingGates,
  ParticipantProfileMarkers,
  ParticipantProfileRecord,
  CreateDraftParticipantInput,
  UpdateParticipantProfileInput,
  deriveProfileCompleteness,
  findParticipantPrivacyViolations,
  isDraftWritableParticipantStatus,
} from "../src/contracts/marketplace/participant-record";
import {
  PARTICIPANT_STATUSES,
  MARKETPLACE_ROLES,
} from "../src/contracts/marketplace/participant";
import { MARKETPLACE_CAPABILITIES } from "../src/contracts/marketplace/capability";

const source = (path: string): string =>
  readFileSync(new URL(path, import.meta.url).pathname, "utf8");

/**
 * Strip comments so a scan asserts about CODE, not prose.
 *
 * Necessary rather than fastidious: these modules document what they refuse, so
 * the words "capsule", "process.env", and "address" all appear legitimately in
 * doc comments explaining their own absence. A scan that could not tell the two
 * apart would force the documentation to be deleted to make the test pass, which
 * is exactly backwards.
 */
const codeOnly = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const SCHEMA = source("../prisma/schema.prisma");
const SCHEMA_CODE = codeOnly(SCHEMA);

const ALL_MARKERS_DONE: ParticipantProfileMarkers = {
  identityComplete: true,
  businessStructureComplete: true,
  representativesComplete: true,
  commercialProfileComplete: true,
  riskComplete: true,
  payoutConfigurationComplete: true,
  documentsComplete: true,
};

const ALL_GATES_PASSED: ParticipantOnboardingGates = {
  emailVerifiedAt: "2027-05-01T10:00:00.000Z",
  termsAcceptedAt: "2027-05-01T10:01:00.000Z",
  termsVersion: "terms/2027-01",
};

describe("participant profile completeness (derived, never stored)", () => {
  it("is COMPLETE only when every section and both gates are satisfied", () => {
    expect(deriveProfileCompleteness(ALL_MARKERS_DONE, ALL_GATES_PASSED)).toBe("COMPLETE");
  });

  it("is INCOMPLETE when any single section is outstanding", () => {
    for (const key of Object.keys(ALL_MARKERS_DONE) as (keyof ParticipantProfileMarkers)[]) {
      const markers = { ...ALL_MARKERS_DONE, [key]: false };
      expect(deriveProfileCompleteness(markers, ALL_GATES_PASSED)).toBe("INCOMPLETE");
    }
  });

  it("is INCOMPLETE without email verification", () => {
    const gates = { ...ALL_GATES_PASSED, emailVerifiedAt: null };
    expect(deriveProfileCompleteness(ALL_MARKERS_DONE, gates)).toBe("INCOMPLETE");
  });

  it("is INCOMPLETE without terms acceptance", () => {
    const gates = { ...ALL_GATES_PASSED, termsAcceptedAt: null };
    expect(deriveProfileCompleteness(ALL_MARKERS_DONE, gates)).toBe("INCOMPLETE");
  });

  it("refuses terms acceptance with no recorded version", () => {
    // "They agreed" without "to what" is not an enforceable record.
    const gates = { ...ALL_GATES_PASSED, termsVersion: null };
    expect(deriveProfileCompleteness(ALL_MARKERS_DONE, gates)).toBe("INCOMPLETE");
  });

  it("has no stored completeness column in the schema", () => {
    const profileModel = SCHEMA.slice(
      SCHEMA.indexOf("model ParticipantProfile {"),
      SCHEMA.indexOf("model ParticipantActivation {"),
    );
    expect(profileModel).not.toMatch(/^\s+completeness\s/m);
  });
});

describe("draft-only scope", () => {
  it("permits writing only DRAFT, PROFILE_INCOMPLETE, PROFILE_COMPLETE, and CLOSED", () => {
    expect([...DRAFT_WRITABLE_PARTICIPANT_STATUSES]).toEqual([
      "DRAFT",
      "PROFILE_INCOMPLETE",
      "PROFILE_COMPLETE",
      "CLOSED",
    ]);
  });

  it("refuses every status that requires a governed activation decision", () => {
    for (const status of ["UNDER_REVIEW", "ACTIVE", "RESTRICTED", "SUSPENDED"] as const) {
      expect(isDraftWritableParticipantStatus(status)).toBe(false);
    }
  });

  it("classifies every participant status as writable or not, with none unaccounted for", () => {
    for (const status of PARTICIPANT_STATUSES) {
      expect(typeof isDraftWritableParticipantStatus(status)).toBe("boolean");
    }
    expect(DRAFT_WRITABLE_PARTICIPANT_STATUSES.length).toBeLessThan(PARTICIPANT_STATUSES.length);
  });

  it("stores no payment-readiness column anywhere in the schema", () => {
    // Payment readiness has no storage in this phase, so nothing can report
    // ENABLED. 0M.8 adds the provider axis.
    expect(SCHEMA_CODE).not.toMatch(/paymentReadiness/);
    expect(SCHEMA_CODE).not.toMatch(/model ParticipantPaymentAccount/);
  });

  it("creates no participant Node or participant capsule model", () => {
    expect(SCHEMA_CODE).not.toMatch(/model ParticipantNode/);
    expect(SCHEMA_CODE).not.toMatch(/model MarketplaceParticipantCapsule/);
  });

  it("adds no Offer, Listing, Review, or Order persistence", () => {
    /* Storefront persistence arrived later, in Phase 0M.3C — this assertion was
       narrowed then rather than deleted, because what 0M.5 actually claims is
       that *it* added none, and the remaining four are still absent. */
    for (const model of ["model Offer", "model Listing", "model Review", "model Order"]) {
      expect(SCHEMA_CODE).not.toContain(model);
    }
  });
});

describe("private profile has no storage for private content", () => {
  const profileModel = codeOnly(
    SCHEMA.slice(
      SCHEMA.indexOf("model ParticipantProfile {"),
      SCHEMA.indexOf("model ParticipantActivation {"),
    ),
  );

  it("declares only markers, gates, identifiers, and timestamps", () => {
    const declared = profileModel
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[a-zA-Z]\w*\s+\w/.test(line))
      .map((line) => line.split(/\s+/)[0]!)
      // The `model ParticipantProfile {` header line itself.
      .filter((name) => name !== "model");

    expect(declared.sort()).toEqual(
      [
        "businessStructureComplete",
        "commercialProfileComplete",
        "createdAt",
        "documentsComplete",
        "emailVerifiedAt",
        "id",
        "identityComplete",
        "participant",
        "participantId",
        "payoutConfigurationComplete",
        "representativesComplete",
        "riskComplete",
        "termsAcceptedAt",
        "termsVersion",
        "updatedAt",
      ].sort(),
    );
  });

  it("has no column for any private identity, contact, payment, or moderation value", () => {
    for (const forbidden of [
      "legalName",
      "tradingName",
      "address",
      "dateOfBirth",
      "taxId",
      "ssn",
      "phone",
      "bankAccount",
      "iban",
      "routingNumber",
      "stripeAccountId",
      "providerAccountRef",
      "documentRef",
      "moderationNote",
      "internalNote",
      "riskScore",
    ]) {
      expect(profileModel).not.toContain(forbidden);
    }
  });

  it("stores the email VERIFICATION INSTANT but never an email address", () => {
    expect(profileModel).toContain("emailVerifiedAt");
    // No column that could hold the address itself.
    expect(profileModel).not.toMatch(/^\s+email\s+String/m);
    expect(profileModel).not.toContain("verifiedEmail");
  });

  it("keeps the profile record contract closed against unknown keys", () => {
    const valid = {
      profileId: "mon:mprof:0123456789ABCDEFGHJKMNPQRS",
      participantId: "mon:mpart:0123456789ABCDEFGHJKMNPQRS",
      markers: ALL_MARKERS_DONE,
      gates: ALL_GATES_PASSED,
      completeness: "COMPLETE" as const,
      createdAt: "2027-05-01T10:00:00.000Z",
      updatedAt: "2027-05-01T10:00:00.000Z",
    };
    expect(ParticipantProfileRecord.safeParse(valid).success).toBe(true);
    expect(
      ParticipantProfileRecord.safeParse({ ...valid, legalName: "Ada Lovelace" }).success,
    ).toBe(false);
  });

  it("refuses a private field smuggled into a profile update input", () => {
    const base = {
      participantId: "mon:mpart:0123456789ABCDEFGHJKMNPQRS",
      now: "2027-05-01T10:00:00.000Z",
    };
    expect(UpdateParticipantProfileInput.safeParse(base).success).toBe(true);
    expect(
      UpdateParticipantProfileInput.safeParse({ ...base, residentialAddress: "1 Main St" })
        .success,
    ).toBe(false);
    expect(
      UpdateParticipantProfileInput.safeParse({
        ...base,
        markers: { identityComplete: true, legalName: "Ada" },
      }).success,
    ).toBe(false);
  });
});

describe("participant privacy guard", () => {
  it("finds a private key at any depth", () => {
    const findings = findParticipantPrivacyViolations({
      participantStatus: "DRAFT",
      nested: { deeper: [{ emailAddress: "person@example.com" }] },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("nested.deeper[0].emailAddress");
    expect(findings[0]!.fragment).toBe("email");
  });

  it("refuses credentials, session data, payment identifiers, and moderation notes", () => {
    for (const key of [
      "passwordHash",
      "sessionToken",
      "stripeAccountId",
      "payoutBankAccount",
      "underwritingStatus",
      "residentialAddress",
      "phoneNumber",
      "internalNote",
      "moderationFlag",
    ]) {
      expect(findParticipantPrivacyViolations({ [key]: "x" })).toHaveLength(1);
    }
  });

  it("permits paymentReadiness, the one approved exception, without widening the scan", () => {
    // A closed enum on MarketplaceParticipantView carrying no provider detail.
    expect(findParticipantPrivacyViolations({ paymentReadiness: "NOT_STARTED" })).toEqual([]);
    // The exception is that key alone — everything else containing "payment" still fails.
    expect(findParticipantPrivacyViolations({ paymentMethodToken: "x" })).toHaveLength(1);
    expect(findParticipantPrivacyViolations({ paymentProviderAccountId: "acct_1" })).toHaveLength(1);
  });

  it("permits the approved public projection field set", () => {
    const projection = {
      publicParticipantRef: "an:node:0123456789ABCDEFGHJKMNPQRS",
      roles: [{ role: "SELLER", active: true }],
      participantStatus: "ACTIVE",
    };
    expect(findParticipantPrivacyViolations(projection)).toEqual([]);
  });

  it("covers every category the phase brief names", () => {
    for (const fragment of [
      "email",
      "password",
      "session",
      "stripe",
      "payment",
      "underwriting",
      "address",
      "phone",
      "moderation",
    ]) {
      expect(PRIVATE_PARTICIPANT_KEY_FRAGMENT_LIST).toContain(fragment);
    }
  });
});

describe("public participant projection ruling (0M.1 decision 4)", () => {
  it("names a closed field set that excludes private, credential, and payment data", () => {
    expect([...PUBLIC_PARTICIPANT_PROJECTION_FIELDS]).toEqual([
      "publicParticipantRef",
      "roles",
      "participantStatus",
    ]);
  });

  it("emits no projection function in this phase", () => {
    const contract = source("../src/contracts/marketplace/participant-record.ts");
    expect(contract).not.toContain("export function projectPublicParticipant");
  });

  it("carries no display name, because none is stored", () => {
    expect(PUBLIC_PARTICIPANT_PROJECTION_FIELDS as readonly string[]).not.toContain("displayName");
    expect(SCHEMA_CODE.slice(SCHEMA_CODE.indexOf("model MarketplaceParticipant {"))).not.toContain(
      "displayName",
    );
  });
});

describe("Creator vs Seller ruling (0M.1 decision 1)", () => {
  it("keeps one neutral participant identity with additive roles", () => {
    expect([...MARKETPLACE_ROLES]).toEqual(["SELLER", "PROMOTER", "BUYER"]);
    // No second identity table competing with MarketplaceParticipant.
    expect(SCHEMA_CODE).not.toContain("model Creator");
    expect(SCHEMA_CODE).not.toContain("model Seller");
  });
});

describe("service and contract boundaries", () => {
  it("keeps the participant service free of clocks, randomness, and env reads", () => {
    const service = codeOnly(source("../src/server/marketplace/participant-service.ts"));
    expect(service).not.toContain("Date.now(");
    expect(service).not.toContain("Math.random(");
    expect(service).not.toContain("process.env");
  });

  it("adds no HTTP route or UI", () => {
    const service = codeOnly(source("../src/server/marketplace/participant-service.ts"));
    for (const forbidden of ["NextRequest", "NextResponse", "export async function GET", "export async function POST"]) {
      expect(service).not.toContain(forbidden);
    }
  });

  it("does not export marketplace contracts through the browser-facing barrel", () => {
    const barrel = source("../src/contracts/index.ts");
    expect(barrel).not.toContain("marketplace/participant");
  });

  it("never reads the profile while materializing a subject", () => {
    const mapper = codeOnly(source("../src/server/marketplace/participant-mapper.ts"));
    const fn = mapper.slice(mapper.indexOf("export function toMarketplaceSubject"));
    expect(fn).not.toContain("profile");
    expect(fn).not.toContain("ProfileRow");
  });

  it("touches no Registrar, Publisher, Node, or capsule code", () => {
    for (const file of [
      "../src/server/marketplace/participant-service.ts",
      "../src/server/marketplace/participant-mapper.ts",
      "../src/contracts/marketplace/participant-record.ts",
    ]) {
      // Precise tokens, not the bare word "capsule": these modules legitimately
      // import identifier regexes from `contracts/capsule/identity`, which is
      // the shared identity vocabulary and not capsule generation.
      const code = codeOnly(source(file));
      for (const forbidden of [
        "Registrar",
        "registrar",
        "@context",
        "CapsuleProjection",
        "finalize",
        "publishedBy",
        "an:node:",
        "AnsNodeId",
      ]) {
        expect(code).not.toContain(forbidden);
      }
    }
  });
});

describe("vocabularies", () => {
  it("names seven onboarding sections and three activation decisions", () => {
    expect(PARTICIPANT_PROFILE_SECTIONS).toHaveLength(7);
    expect([...ACTIVATION_DECISIONS]).toEqual([
      "APPROVED",
      "MORE_INFORMATION_REQUIRED",
      "REJECTED",
    ]);
  });

  it("still exposes exactly twelve marketplace capabilities", () => {
    expect(MARKETPLACE_CAPABILITIES).toHaveLength(12);
  });

  it("accepts at most three initial roles on a draft participant", () => {
    const base = { accountId: "mon:acct:0123456789ABCDEFGHJKMNPQRS", now: "2027-05-01T10:00:00.000Z" };
    expect(
      CreateDraftParticipantInput.safeParse({
        ...base,
        initialRoles: ["SELLER", "PROMOTER", "BUYER"],
      }).success,
    ).toBe(true);
    expect(
      CreateDraftParticipantInput.safeParse({ ...base, initialRoles: ["INTERNAL_OPERATOR"] })
        .success,
    ).toBe(false);
  });
});
