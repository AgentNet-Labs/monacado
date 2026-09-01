/**
 * Storefront persistence contracts and scope boundaries (Phase 0M.3C).
 *
 * Offline: no database, no network, no clock. The database-backed behaviour
 * lives in `storefront-persistence.integration.test.ts`.
 *
 * The privacy and scope assertions are structural — they read the Prisma schema
 * and the committed source rather than exercising a function, because "there is
 * no column an approval could be stored in" keeps holding in a way that "the
 * service does not set one" does not.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFERRED_STOREFRONT_PERSISTENCE_EXTENSIONS,
  NEVER_ON_STOREFRONT_RECORD,
  STORED_GOVERNANCE_ASSIGNMENT_STATUSES,
  StorefrontGovernanceAssignmentRecord,
  CreateDraftStorefrontInput,
  UpdateStorefrontInput,
} from "../src/contracts/marketplace/storefront-record";
import { GOVERNANCE_ASSIGNMENT_STATUSES } from "../src/contracts/marketplace/storefront-source";
import { FORBIDDEN_INTERNAL_ID_PREFIXES } from "../src/contracts/capsule/internal-identifiers";

const source = (path: string): string =>
  readFileSync(new URL(path, import.meta.url).pathname, "utf8");

const codeOnly = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const SCHEMA = source("../prisma/schema.prisma");
const SCHEMA_CODE = codeOnly(SCHEMA);
const pad26 = (s: string) => (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

describe("go-live approval is never a Storefront fact", () => {
  it("has no approval column on either Storefront table", () => {
    const block = SCHEMA_CODE.slice(
      SCHEMA_CODE.indexOf("model Storefront {"),
      SCHEMA_CODE.indexOf("model StorefrontGovernanceAssignment {"),
    );
    for (const forbidden of ["approvedForGoLive", "goLiveApproved", "approvalState", "isLive"]) {
      expect(block).not.toContain(forbidden);
    }
  });

  it("refuses every named forbidden field on the input contracts", () => {
    const base = {
      ownerParticipantId: `mon:mpart:${pad26("OWNER")}`,
      publicHandle: "a-handle",
      presentation: { displayName: "Shop", tagline: null, summary: null },
      actingAccountId: "acct_synthetic_0m3c",
      now: "2027-09-01T09:00:00.000Z",
    };
    expect(CreateDraftStorefrontInput.safeParse(base).success).toBe(true);
    for (const forbidden of NEVER_ON_STOREFRONT_RECORD) {
      expect(CreateDraftStorefrontInput.safeParse({ ...base, [forbidden]: "x" }).success).toBe(
        false,
      );
    }
  });

  it("names approval, credential, payment, and risk fields among the refusals", () => {
    for (const field of [
      "approvedForGoLive",
      "goLiveApproved",
      "isLive",
      "accountId",
      "email",
      "participantProfile",
      "paymentProviderToken",
      "underwritingData",
      "riskClassification",
      "taxEvidence",
      "moderationNotes",
      "nodeId",
      "publicationState",
    ]) {
      expect(NEVER_ON_STOREFRONT_RECORD).toContain(field);
    }
  });
});

describe("stored governance status vocabulary", () => {
  it("excludes NONE, which is the absence of a row", () => {
    expect([...STORED_GOVERNANCE_ASSIGNMENT_STATUSES]).toEqual([
      "ACTIVE",
      "SUSPENDED",
      "REVOKED",
    ]);
    expect(GOVERNANCE_ASSIGNMENT_STATUSES).toContain("NONE");
    expect(STORED_GOVERNANCE_ASSIGNMENT_STATUSES as readonly string[]).not.toContain("NONE");
  });

  it("refuses NONE on a persisted assignment record", () => {
    const base = {
      governanceAssignmentId: `mon:sgov:${pad26("GOV")}`,
      internalStorefrontId: `mon:storefront:${pad26("SF")}`,
      participantId: `mon:mpart:${pad26("P")}`,
      role: "ADMIN" as const,
      status: "ACTIVE" as const,
      assignedAt: "2027-09-01T09:00:00.000Z",
      revokedAt: null,
    };
    expect(StorefrontGovernanceAssignmentRecord.safeParse(base).success).toBe(true);
    expect(
      StorefrontGovernanceAssignmentRecord.safeParse({ ...base, status: "NONE" }).success,
    ).toBe(false);
  });
});

describe("schema-level integrity", () => {
  /* The three Storefront tables and nothing after them.
     This slice used to run to end-of-file, so it silently policed every model
     any later phase appended. That was never what it asserted — the schema
     already carried `onDelete: Cascade` on subordinate rows BEFORE Storefront
     (`AccountSession`, `ParticipantProfile`, `ParticipantPaymentRequirementRow`),
     which is the established treatment for a row with no meaning apart from its
     parent. Bounded here so the assertion tests the tables it names. */
  const block = SCHEMA_CODE.slice(
    SCHEMA_CODE.indexOf("model Storefront {"),
    SCHEMA_CODE.indexOf("model Offer {"),
  );

  it("uses no CASCADE anywhere in the Storefront tables", () => {
    expect(block).not.toContain("onDelete: Cascade");
    expect(block.match(/onDelete: Restrict/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("makes the current handle unique and the historical handle not", () => {
    const stable = SCHEMA_CODE.slice(
      SCHEMA_CODE.indexOf("model Storefront {"),
      SCHEMA_CODE.indexOf("model StorefrontSourceRecordVersionRow {"),
    );
    const version = SCHEMA_CODE.slice(
      SCHEMA_CODE.indexOf("model StorefrontSourceRecordVersionRow {"),
      SCHEMA_CODE.indexOf("model StorefrontGovernanceAssignment {"),
    );
    expect(stable).toMatch(/publicHandle String @unique/);
    expect(version).toMatch(/publicHandle\s+String\s+@db.VarChar\(63\)/);
    expect(version).not.toMatch(/publicHandle\s+String\s+@unique/);
  });

  it("enforces at most one active SUPER_OWNER through a unique marker", () => {
    expect(block).toMatch(/activeSuperOwnerForStorefrontId String\? @unique/);
  });

  it("adds no Storefront Node or publication table", () => {
    /* `model Offer` was dropped from this list when Phase 0M.6 built it, and
       `model Order` when 0M.9 did. The list is narrowed rather than deleted, on
       the same reasoning 0M.5 used for the Storefront: what 0M.3C claims is that
       *it* added none of these, and the remainder are still absent. The Offer
       boundary this phase actually guards is asserted below. */
    for (const model of ["model StorefrontNode", "model StorefrontPublication"]) {
      expect(SCHEMA_CODE).not.toContain(model);
    }
  });

  it("keeps the Storefront's own tables free of Offer and Listing facts", () => {
    /* 0M.3A: a Storefront embeds no Product, Offer, or Listing array, and
       Listings reference Storefronts rather than the reverse.
       
       The invariant is about COLUMNS, not about Prisma's navigation fields. A
       back-relation like `listings Listing[]` is required for the relation to
       exist at all and creates no column — 0M.7's migration issues no ALTER
       TABLE against Storefront whatsoever, which is asserted separately below.
       What must never appear is a scalar Offer or Listing fact. */
    const storefrontTables = codeOnly(
      SCHEMA.slice(SCHEMA.indexOf("model Storefront {"), SCHEMA.indexOf("model Offer {")),
    );
    for (const field of [
      "wholesalePrice",
      "commissionBasisPoints",
      "priceType",
      "internalOfferId",
      "internalListingId",
      "retailPrice",
      "salePrice",
      "listingCount",
    ]) {
      expect(storefrontTables).not.toContain(field);
    }
  });

  it("gains no Storefront column from later entity phases", () => {
    /* The database-level statement of the same rule: neither the Offer phase nor
       the Listing phase altered the Storefront table. Foreign keys live on the
       referencing side, which is exactly what "Listings reference Storefronts,
       not the reverse" means in SQL. */
    const migrations = ["add_offer_persistence", "add_listing_persistence"];
    for (const name of migrations) {
      const dir = readdirSync(new URL("../prisma/migrations/", import.meta.url)).find((d) =>
        d.endsWith(name),
      );
      expect(dir).toBeDefined();
      const sql = source(`../prisma/migrations/${dir}/migration.sql`);
      expect(sql).not.toMatch(/ALTER TABLE `Storefront`/);
    }
  });
});

describe("service and scope boundaries", () => {
  const service = codeOnly(source("../src/server/marketplace/storefront-service.ts"));

  it("reads no clock, generates no randomness, and touches no environment", () => {
    expect(service).not.toContain("Date.now(");
    expect(service).not.toContain("Math.random(");
    expect(service).not.toMatch(/new Date\(\s*\)/);
    expect(service).not.toContain("process.env");
  });

  it("adds no HTTP route", () => {
    for (const forbidden of [
      "NextRequest",
      "NextResponse",
      "export async function GET",
      "export async function POST",
    ]) {
      expect(service).not.toContain(forbidden);
    }
  });

  it("reuses the 0M.3A authority decisions rather than reimplementing them", () => {
    expect(service).toContain("canCreateStorefrontRecord");
    expect(service).toContain("canEditStorefrontPresentation");
    expect(service).toContain("materialChangesBetween");
    expect(service).toContain("isValidStorefrontLifecycleTransition");
    expect(service).toContain("isStorefrontLive");
  });

  it("issues no Node and performs no publication or Registrar work", () => {
    for (const forbidden of [
      "an:node:",
      "capsuleId",
      "Registrar",
      "registrar",
      "publicationOutbox",
      "registrarReceipt",
    ]) {
      expect(service).not.toContain(forbidden);
    }
  });

  it("covers the new internal identifier in the shared guard", () => {
    expect(FORBIDDEN_INTERNAL_ID_PREFIXES).toContain("mon:sgov:");
    expect(FORBIDDEN_INTERNAL_ID_PREFIXES).toContain("mon:storefront:");
  });

  it("defers Node, publication, and downstream persistence explicitly", () => {
    for (const deferred of [
      "storefrontNode",
      "nodeIssuance",
      "publicationState",
      "offerPersistence",
      "listingPersistence",
      "goLiveApprovalWorkflow",
      "riskPolicy",
    ]) {
      expect(DEFERRED_STOREFRONT_PERSISTENCE_EXTENSIONS).toContain(deferred);
    }
  });

  it("carries no supplied authorization flag and no claimed actor participant (Phase 1.18)", () => {
    /* The inversion of what this test asserted through Phase 1.17.
       `actorAuthorizedForOwnerParticipant` was a caller-supplied boolean and
       `authorizedByParticipantId` was a caller-supplied actor identity; together
       they let anyone who knew one opaque participant id act as its holder. Both
       are gone, replaced by `actingAccountId`, and 0M.3A's actual prohibition —
       never infer authority from an email domain, a display name, or a private
       profile datum — is preserved: the derivation reads only
       `MarketplaceParticipant.accountId` and `StorefrontGovernanceAssignment`. */
    const code = codeOnly(source("../src/contracts/marketplace/storefront-record.ts"));
    expect(code).not.toContain("actorAuthorizedForOwnerParticipant");
    expect(code).not.toContain("authorizedByParticipantId");
    expect(code).toContain("actingAccountId: ActingAccountId");
  });

  it("accepts a partial update and refuses an unknown field", () => {
    const base = {
      internalStorefrontId: `mon:storefront:${pad26("SF")}`,
      sourceRecordVersion: "2",
      actingAccountId: "acct_synthetic_0m3c",
      now: "2027-09-02T09:00:00.000Z",
    };
    expect(UpdateStorefrontInput.safeParse(base).success).toBe(true);
    expect(UpdateStorefrontInput.safeParse({ ...base, surprise: 1 }).success).toBe(false);
  });
});
