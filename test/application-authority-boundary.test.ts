/**
 * Phase 1.18 — the production authority boundary.
 *
 * Four guarantees, none of which any other suite asserts:
 *
 *   1. no marketplace input schema accepts an authorization conclusion;
 *   2. the trusted actor context cannot be built from data;
 *   3. the application layer supplies the actor and discards a claimed one;
 *   4. an internal (Staff) entitlement grants no marketplace authority.
 *
 * The *rules* those inputs used to feed are asserted where they always were —
 * `offer-source-model.test.ts` block 21 for Product authority,
 * `storefront-source-model.test.ts` blocks 8–12 for governance. This suite is
 * about provenance, which is the thing that changed.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CreateDraftOfferInput,
  UpdateOfferInput,
} from "../src/contracts/marketplace/offer-record";
import {
  AssignStorefrontGovernanceInput,
  CreateDraftStorefrontInput,
  SetGovernanceAssignmentStatusInput,
  UpdateStorefrontInput,
} from "../src/contracts/marketplace/storefront-record";
import {
  CreatePromotedListingInput,
  CreateSellerDirectListingInput,
  UpdateListingInput,
} from "../src/contracts/marketplace/listing-record";
import { ACCOUNT_CAPABILITIES } from "../src/contracts/account/account";
import {
  canAccrueCommission,
  canActivateStorefront,
  canCreateDraftProduct,
  canCreateDraftStorefront,
  canCreatePromotedListing,
  canCreateSellerDirectListing,
  canPublishOffer,
  canReceivePayout,
  canSubmitActivation,
  internalCapabilitiesGrantedByMarketplaceRoles,
  marketplaceCapabilitiesGrantedByInternalEntitlement,
} from "../src/contracts/marketplace/capability";

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), "utf8");

const BOUNDARY = "src/server/account/acting-participant-boundary.ts";
const APPLICATION = "src/server/marketplace/marketplace-application-service.ts";

/**
 * Every input schema a caller can reach on the three governed entities.
 *
 * Enumerated rather than globbed: a new mutation input must be added here
 * deliberately, and a test that discovered its own subjects would quietly cover
 * nothing when a file moved.
 */
const MUTATION_INPUTS = {
  CreateDraftOfferInput,
  UpdateOfferInput,
  CreateDraftStorefrontInput,
  UpdateStorefrontInput,
  AssignStorefrontGovernanceInput,
  SetGovernanceAssignmentStatusInput,
  CreateSellerDirectListingInput,
  CreatePromotedListingInput,
  UpdateListingInput,
} as const;

/**
 * Names that assert a *conclusion* rather than state a *fact*.
 *
 * The two that existed are named exactly; the rest are the shapes a later phase
 * would most plausibly reintroduce. A caller may say who it is and what it wants
 * done — never that it is allowed.
 */
const FORGEABLE_AUTHORITY_INPUTS = [
  "hasProductAuthority",
  "actorAuthorizedForOwnerParticipant",
  "authorizedByParticipantId",
  "authorized",
  "isAuthorized",
  "isOwner",
  "hasAuthority",
  "governanceRole",
  "isSuperOwner",
  "capabilities",
  "internalCapabilities",
] as const;

// — 1. No authorization conclusion is accepted as input —

describe("1. no marketplace mutation input accepts an authorization conclusion", () => {
  it("carries none of the forgeable authority members, on any input", () => {
    for (const [name, schema] of Object.entries(MUTATION_INPUTS)) {
      const keys = Object.keys(schema.shape);
      for (const forbidden of FORGEABLE_AUTHORITY_INPUTS) {
        expect(`${name}.${forbidden}`).toBe(`${name}.${keys.includes(forbidden) ? "PRESENT" : forbidden}`);
      }
    }
  });

  it("actively refuses one that is sent anyway, rather than ignoring it", () => {
    /* `strictObject` makes the removal a refusal. A caller still sending
       `hasProductAuthority: true` gets an input error, which is what turns a
       silently-ignored field into a visible contract break. */
    const offer = {
      internalProductId: `mon:product:${"A".repeat(26)}`,
      sellerParticipantId: `mon:mpart:${"B".repeat(26)}`,
      terms: {
        price: { type: "PAID", wholesalePriceMinorUnits: 5000, wholesalePriceCurrency: "USD" },
        promotion: { type: "NOT_PROMOTABLE" },
      },
      actingAccountId: "acct_1",
      now: "2027-10-01T09:00:00.000Z",
    };
    expect(CreateDraftOfferInput.safeParse(offer).success).toBe(true);
    expect(
      CreateDraftOfferInput.safeParse({ ...offer, hasProductAuthority: true }).success,
    ).toBe(false);

    const storefront = {
      ownerParticipantId: `mon:mpart:${"B".repeat(26)}`,
      publicHandle: "a-handle",
      presentation: { displayName: "Shop", tagline: null, summary: null },
      actingAccountId: "acct_1",
      now: "2027-10-01T09:00:00.000Z",
    };
    expect(CreateDraftStorefrontInput.safeParse(storefront).success).toBe(true);
    expect(
      CreateDraftStorefrontInput.safeParse({
        ...storefront,
        actorAuthorizedForOwnerParticipant: true,
      }).success,
    ).toBe(false);
    expect(
      CreateDraftStorefrontInput.safeParse({
        ...storefront,
        authorizedByParticipantId: `mon:mpart:${"B".repeat(26)}`,
      }).success,
    ).toBe(false);
  });
});

// — 2. The trusted actor context is not constructible from data —

describe("2. the acting-account context cannot be built from a request", () => {
  it("exports the type but not the class, so nothing outside can construct one", () => {
    const code = read(BOUNDARY);
    expect(code).toContain("class ResolvedActingAccount");
    // The class VALUE is never exported — only the type alias.
    expect(code).not.toMatch(/export\s+(abstract\s+)?class\s+ResolvedActingAccount/);
    expect(code).toContain("export type ActingAccount = ResolvedActingAccount");
  });

  it("holds a true private field, so a spoofed object is not one at runtime", () => {
    expect(read(BOUNDARY)).toContain("readonly #resolved = true");
  });

  it("is never produced by a zod schema, so no payload can parse into one", () => {
    const code = read(BOUNDARY);
    expect(code).not.toContain("z.custom");
    expect(code).not.toContain(".transform(");
    expect(code).not.toContain("from \"zod\"");
  });

  it("takes a cookie header and no account id — a caller cannot ask to be someone", () => {
    const code = read(BOUNDARY);
    const signature = code.slice(
      code.indexOf("export async function resolveActingAccount"),
      code.indexOf("): Promise<ActingAccountResolution>"),
    );
    expect(signature).toContain("cookieHeader");
    expect(signature).not.toContain("accountId");
    expect(signature).not.toContain("participantId");
  });

  it("carries identity only — no capability list, role, or risk field", () => {
    const code = read(BOUNDARY);
    for (const forbidden of ["capabilities", "governanceRole", "riskScore", "participantId"]) {
      expect(`ctx.${code.includes(`readonly ${forbidden}`) ? "PRESENT" : forbidden}`).toBe(
        `ctx.${forbidden}`,
      );
    }
  });
});

// — 3. The application layer supplies the actor —

describe("3. the application layer supplies the actor and discards a claimed one", () => {
  it("writes actingAccountId from the resolved actor, last", () => {
    const code = read(APPLICATION);
    /* The spread order is the control: whatever a body carried is overwritten,
       and the explicit destructure discards it before that even matters. */
    expect(code).toContain("const { actingAccountId: _discarded, ...rest } = input");
    expect(code).toContain("return { ...rest, actingAccountId: actor.accountId }");
  });

  it("every command takes the trusted actor as its first parameter", () => {
    const code = read(APPLICATION);
    const commands = code.match(/export async function \w+\(\n\s+actor: ActingAccount,/g) ?? [];
    /* Offer version, Storefront version, seller-direct Listing, promoted
       Listing, and Product source record. The actor is first on every one, so a
       command cannot be called without one. */
    expect(commands.length).toBe(5);
    expect(code).toContain("export async function createProductSourceRecordAs(");
  });

  it("makes no authorization decision of its own", () => {
    /* Authority is decided in the domain service, inside the transaction that
       writes. A decision made here would be forgeable one layer up, and would
       open a window in which a restriction could land unseen. */
    const code = read(APPLICATION);
    /* `resolveActingSubject` is the one exception, and it resolves identity
       rather than deciding anything: the Product command needs the acting
       account's own participant to record as creator authority.

       Matched by pattern rather than by literal prefix: every real decision is
       `canActivateStorefrontRecord(`, `canCreateDraftOffer(` and so on, so a
       probe for the bare stem `"canActivate("` could never fire and the case
       would pass while the layer decided whatever it liked. */
    expect(code).not.toMatch(/\bcan[A-Z]\w*\(/);
    expect(code).not.toMatch(/\brequireAllowed\(/);
    expect(code).not.toMatch(/\w*NotAuthorizedError\(/);
  });
});

// — 4. Staff authority is not marketplace authority —

describe("4. an internal entitlement grants no marketplace authority", () => {
  it("grants nothing, for every capability, to an account holding every entitlement", () => {
    /* Structural rather than sampled: an account holding EVERY internal
       capability and no participant is denied EVERY marketplace capability.
       This is the property that stops "Staff" becoming a global bypass. */
    const staffSubject = {
      account: { accountId: "acct_staff", status: "ACTIVE" as const },
      participant: null,
      internalCapabilities: [...ACCOUNT_CAPABILITIES],
    };

    /* Every subject-taking marketplace decision in the vocabulary. Enumerated
       because there is deliberately no generic dispatcher — one would be a place
       for a capability to acquire a default. */
    const decisions = {
      canCreateDraftStorefront,
      canCreateDraftProduct,
      canCreateSellerDirectListing,
      canCreatePromotedListing,
      canSubmitActivation,
      canActivateStorefront,
      canPublishOffer,
      canReceivePayout,
      canAccrueCommission,
    };
    for (const [name, decide] of Object.entries(decisions)) {
      expect(`${name}:${decide(staffSubject).decision}`).toBe(`${name}:DENY`);
    }
  });

  it("keeps the two vocabularies permanently disjoint, in both directions", () => {
    expect(marketplaceCapabilitiesGrantedByInternalEntitlement([...ACCOUNT_CAPABILITIES])).toEqual(
      [],
    );
    expect(
      internalCapabilitiesGrantedByMarketplaceRoles(["SELLER", "PROMOTER", "BUYER"]),
    ).toEqual([]);
  });

  it("is not consulted by the acting-account boundary at all", () => {
    /* `actorType` is a classification, never an authorization. Reading it here
       is how a Monacado employee ends up holding seller authority. */
    const code = read(BOUNDARY);
    expect(code).not.toContain("principal.actorType");
    expect(code).not.toContain("INTERNAL_OPERATOR_CAPABILITIES");
  });
});
