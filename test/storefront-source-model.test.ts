/**
 * Authoritative Storefront source-model tests (Phase 0M.3A).
 *
 * NO DATABASE, NO NETWORK, NO CLOCK. Every instant is an explicit literal, and
 * every authority decision is a pure function of its argument.
 *
 * The numbered `describe` blocks correspond one-to-one with the properties Phase
 * 0M.3A was required to prove.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MarketplaceParticipantView,
  MarketplaceRole,
  MarketplaceSubject,
  ParticipantStatus,
  PaymentReadinessStatus,
  RoleAssignmentStatus,
} from "../src/contracts/marketplace/participant";
import {
  ACTOR_GOVERNANCE_ROLES,
  ADMIN_OPERATIONAL_AUTHORITIES,
  ActorGovernanceRole,
  DEFERRED_STOREFRONT_EXTENSIONS,
  INITIAL_STOREFRONT_LIFECYCLE_STATE,
  MATERIAL_STOREFRONT_FIELDS,
  MAX_PUBLIC_HANDLE_LENGTH,
  NEVER_PROJECTION_ELIGIBLE_STOREFRONT_DATA,
  OPERATIONAL_ONLY_STOREFRONT_FIELDS,
  GO_LIVE_APPROVAL_STATUSES,
  SUPER_OWNER_CARDINALITIES,
  PARTICIPANT_KINDS,
  PROJECTION_ELIGIBLE_STOREFRONT_FIELDS,
  PublicHandle,
  STOREFRONT_CAPABILITIES,
  STOREFRONT_CAPABLE_ROLES,
  STOREFRONT_GOVERNANCE_ROLES,
  STOREFRONT_LIFECYCLE_STATES,
  STOREFRONT_VISIBILITY_STATES,
  StorefrontActorFacts,
  StorefrontAuthorityDecision,
  StorefrontDeferredDecision,
  StorefrontGovernanceRole,
  StorefrontLifecycleState,
  StorefrontOwnerFacts,
  StorefrontPresentation,
  StorefrontRecordActionRequest,
  StorefrontVisibilityChangeRequest,
  StorefrontSourceRecord,
  StorefrontSourceVersion,
  StorefrontVisibility,
  canActivateStorefrontRecord,
  canCloseStorefrontRecord,
  canCreateStorefrontRecord,
  canIncreaseStorefrontExposure,
  canReduceStorefrontExposure,
  canEditStorefrontPresentation,
  canManageStorefrontListings,
  canResumeStorefrontRecord,
  canSetPromotedListingPrice,
  canSetSellerControlledListingPrice,
  canSuspendStorefrontRecord,
  classifyStorefrontChange,
  governanceRoleGrantsOperationalAuthority,
  isDiscoverable,
  isNeverProjectionEligibleStorefrontData,
  isProjectionEligibleStorefrontField,
  isPubliclyAccessible,
  isStorefrontLive,
  visibilityIntentPermitsPublicAccess,
  isSuperOwnerExclusive,
  isTerminalStorefrontLifecycleState,
  isValidStorefrontLifecycleTransition,
  materialChangesBetween,
} from "../src/contracts/marketplace/storefront-source";

// — Fixtures —

const body = (n: number): string => String(n).padStart(26, "0");

const ACCOUNT_ID = `mon:acct:${body(1)}`;
const OWNER_PARTICIPANT_ID = `mon:mpart:${body(2)}`;
const OTHER_PARTICIPANT_ID = `mon:mpart:${body(3)}`;
const STOREFRONT_SREC_ID = `mon:srec:${body(4)}`;
const INTERNAL_STOREFRONT_ID = `mon:storefront:${body(5)}`;
const OTHER_STOREFRONT_ID = `mon:storefront:${body(6)}`;
const ACTOR_ID = `mon:actor:${body(7)}`;

const PRESENTATION = {
  displayName: "Highland Coffee Roasters",
  tagline: "Small-batch beans, roasted weekly",
  summary: null,
} as const;

function storefrontRecord(overrides: Record<string, unknown> = {}) {
  return StorefrontSourceRecord.parse({
    storefrontSourceRecordId: STOREFRONT_SREC_ID,
    internalStorefrontId: INTERNAL_STOREFRONT_ID,
    currentSourceRecordVersion: "1",
    ownerParticipantId: OWNER_PARTICIPANT_ID,
    sourceSystem: "monacado",
    sourceRecordType: "Storefront",
    sourceClass: "governed-database-record",
    lifecycle: "DRAFT",
    visibility: "PRIVATE",
    publicHandle: "highland-coffee",
    presentation: PRESENTATION,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
}

function storefrontVersion(overrides: Record<string, unknown> = {}) {
  return StorefrontSourceVersion.parse({
    storefrontSourceRecordId: STOREFRONT_SREC_ID,
    sourceRecordVersion: "2",
    supersedesSourceRecordVersion: "1",
    internalStorefrontId: INTERNAL_STOREFRONT_ID,
    sourceSystem: "monacado",
    sourceRecordType: "Storefront",
    sourceClass: "governed-database-record",
    ownerParticipantId: OWNER_PARTICIPANT_ID,
    lifecycle: "ACTIVE",
    visibility: "PUBLIC",
    publicHandle: "highland-coffee",
    presentation: PRESENTATION,
    authorizedByParticipantId: OWNER_PARTICIPANT_ID,
    authorizedByActorId: ACTOR_ID,
    recordedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  });
}

const SUPER_OWNER_ACCOUNT_ID = `mon:acct:${body(11)}`;
const ADMIN_ACCOUNT_ID = `mon:acct:${body(12)}`;

/** A qualifying owner: admitted, active Seller role, payable, underwritten. */
function ownerFacts(overrides: Record<string, unknown> = {}): StorefrontOwnerFacts {
  return StorefrontOwnerFacts.parse({
    ownerParticipantId: OWNER_PARTICIPANT_ID,
    ownerKind: "INDIVIDUAL",
    participantStatus: "ACTIVE",
    roles: [{ role: "SELLER", status: "ACTIVE" }],
    paymentReadiness: "ENABLED",
    ...overrides,
  });
}

/** The active SUPER_OWNER for this Storefront. */
function actorFacts(overrides: Record<string, unknown> = {}): StorefrontActorFacts {
  return StorefrontActorFacts.parse({
    accountId: SUPER_OWNER_ACCOUNT_ID,
    accountStatus: "ACTIVE",
    authorizedForOwnerParticipant: true,
    governanceRole: "SUPER_OWNER",
    governanceAssignmentStatus: "ACTIVE",
    assignmentStorefrontId: INTERNAL_STOREFRONT_ID,
    internalCapabilities: [],
    ...overrides,
  });
}

function createRequest(spec: {
  owner?: Record<string, unknown>;
  actor?: Record<string, unknown>;
} = {}) {
  return {
    owner: ownerFacts(spec.owner),
    /* Creation happens before any assignment can name the Storefront. */
    actor: actorFacts({
      governanceRole: "NONE",
      governanceAssignmentStatus: "NONE",
      assignmentStorefrontId: null,
      ...spec.actor,
    }),
  };
}

function actionRequest(spec: {
  owner?: Record<string, unknown>;
  actor?: Record<string, unknown>;
  lifecycle?: StorefrontLifecycleState;
  visibility?: StorefrontVisibility;
  activeSuperOwnerCardinality?: "NONE" | "EXACTLY_ONE" | "MULTIPLE";
  goLiveApproval?: "APPROVED" | "NOT_APPROVED";
} = {}): StorefrontRecordActionRequest {
  return StorefrontRecordActionRequest.parse({
    owner: ownerFacts(spec.owner),
    actor: actorFacts(spec.actor),
    storefrontId: INTERNAL_STOREFRONT_ID,
    lifecycle: spec.lifecycle ?? "ACTIVE",
    visibility: spec.visibility ?? "PUBLIC",
    activeSuperOwnerCardinality: spec.activeSuperOwnerCardinality ?? "EXACTLY_ONE",
    goLiveApproval: spec.goLiveApproval ?? "APPROVED",
  });
}

function visibilityRequest(spec: Parameters<typeof actionRequest>[0] & {
  targetVisibility?: StorefrontVisibility;
} = {}): StorefrontVisibilityChangeRequest {
  return StorefrontVisibilityChangeRequest.parse({
    ...actionRequest(spec),
    targetVisibility: spec.targetVisibility ?? "PUBLIC",
  });
}

function expectAllow(decision: StorefrontAuthorityDecision): void {
  StorefrontAuthorityDecision.parse(decision);
  expect(decision.decision).toBe("ALLOW");
  expect(decision.reasonCodes).toEqual([]);
}

function expectDeny(decision: StorefrontAuthorityDecision, ...codes: string[]): void {
  StorefrontAuthorityDecision.parse(decision);
  expect(decision.decision).toBe("DENY");
  expect(decision.reasonCodes).toEqual(codes);
}

// — 1 —

describe("1. the current Storefront record has a strict shape", () => {
  it("accepts a complete authoritative record", () => {
    const record = storefrontRecord();
    expect(record.internalStorefrontId).toBe(INTERNAL_STOREFRONT_ID);
    expect(record.sourceRecordType).toBe("Storefront");
    expect(record.ownerParticipantId).toBe(OWNER_PARTICIPANT_ID);
  });

  it("refuses Node, capsule, mapping, publication, and retention fields", () => {
    for (const intruder of [
      { nodeId: "an:node:X" },
      { capsuleId: "an:capsule:X" },
      { mappingVersion: "1.0.0" },
      { capsuleSemver: "1.0.0" },
      { publicationStatus: "PREPARED" },
      { registrationState: "ACCEPTED" },
      { receiptId: "mon:rcpt:X" },
      { retentionState: "HOT" },
      { legalHold: "ACTIVE" },
      { metadata: {} },
    ]) {
      expect(StorefrontSourceRecord.safeParse({ ...storefrontRecord(), ...intruder }).success).toBe(
        false,
      );
    }
  });

  it("an absent tagline or summary has exactly one representation", () => {
    /* Nullable, not optional: an omitted key and an explicit null would be two
       authoritative snapshots of the same Storefront. */
    expect(StorefrontPresentation.safeParse({ displayName: "A Shop" }).success).toBe(false);
    expect(
      StorefrontPresentation.safeParse({ displayName: "A Shop", tagline: null, summary: null })
        .success,
    ).toBe(true);
    const { presentation: _p, ...withoutPresentation } = storefrontRecord();
    expect(StorefrontSourceRecord.safeParse(withoutPresentation).success).toBe(false);
  });

  it("presentation text is bounded and non-empty", () => {
    expect(
      StorefrontPresentation.safeParse({ displayName: "", tagline: null, summary: null }).success,
    ).toBe(false);
    expect(
      StorefrontPresentation.safeParse({
        displayName: "x".repeat(121),
        tagline: null,
        summary: null,
      }).success,
    ).toBe(false);
    expect(
      StorefrontPresentation.safeParse({
        displayName: "A Shop",
        tagline: "x".repeat(201),
        summary: null,
      }).success,
    ).toBe(false);
    expect(
      StorefrontPresentation.safeParse({
        displayName: "A Shop",
        tagline: null,
        summary: "x".repeat(2_001),
      }).success,
    ).toBe(false);
  });
});

// — 2 —

describe("2. the immutable source version has a strict shape", () => {
  it("carries the complete material snapshot and its authorization trace", () => {
    const version = storefrontVersion();
    expect(version.sourceRecordVersion).toBe("2");
    expect(version.supersedesSourceRecordVersion).toBe("1");
    expect(version.authorizedByActorId).toBe(ACTOR_ID);
    expect(version.recordedAt).toBe("2026-08-01T12:00:00.000Z");
    for (const field of [
      "ownerParticipantId",
      "lifecycle",
      "visibility",
      "publicHandle",
      "presentation",
    ]) {
      expect(Object.keys(version)).toContain(field);
    }
  });

  it("a first version supersedes nothing", () => {
    expect(
      storefrontVersion({ sourceRecordVersion: "1", supersedesSourceRecordVersion: null })
        .supersedesSourceRecordVersion,
    ).toBeNull();
  });

  it("refuses Node, capsule, projection, publication, Registrar, and analytics fields", () => {
    for (const intruder of [
      { nodeId: "an:node:X" },
      { capsuleId: "an:capsule:X" },
      { mappingVersion: "1.0.0" },
      { registrarResponse: {} },
      { publicationId: "mon:pub:X" },
      { analytics: {} },
      { retentionState: "ARCHIVED" },
      { rowId: 1 },
    ]) {
      expect(
        StorefrontSourceVersion.safeParse({ ...storefrontVersion(), ...intruder }).success,
      ).toBe(false);
    }
  });

  it("the authorizing actor must be opaque — never an email or a name", () => {
    for (const bad of ["owner@example.com", "Ada Lovelace", ACCOUNT_ID]) {
      expect(
        StorefrontSourceVersion.safeParse({ ...storefrontVersion(), authorizedByActorId: bad })
          .success,
      ).toBe(false);
    }
  });
});

// — 3 —

describe("3. the internal Storefront identity is not a Node", () => {
  it("uses the internal mon:storefront: form", () => {
    expect(storefrontRecord().internalStorefrontId).toMatch(/^mon:storefront:/);
  });

  it("refuses ANS, capsule, URL, and source-record values", () => {
    for (const bad of [
      "an:node:01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "an:capsule:01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "https://monacado.com/s/highland-coffee",
      STOREFRONT_SREC_ID,
      "highland-coffee",
    ]) {
      expect(
        StorefrontSourceRecord.safeParse({ ...storefrontRecord(), internalStorefrontId: bad })
          .success,
      ).toBe(false);
    }
  });

  it("is distinct from the source-record identity", () => {
    const record = storefrontRecord();
    expect(record.internalStorefrontId).not.toBe(record.storefrontSourceRecordId);
  });
});

// — 4 —

describe("4. the public handle is strictly validated", () => {
  const accepts = (publicHandle: string) => PublicHandle.safeParse(publicHandle).success;

  it("accepts lowercase letters, digits, and single interior hyphens", () => {
    for (const handle of ["abc", "highland-coffee", "shop-2026", "a1b2c3", "x".repeat(63)]) {
      expect(accepts(handle), handle).toBe(true);
    }
  });

  it("refuses uppercase, underscores, spaces, and other punctuation", () => {
    for (const handle of ["Highland", "high_land", "high land", "shop!", "shop.name", "café"]) {
      expect(accepts(handle), handle).toBe(false);
    }
  });

  it("refuses leading, trailing, and repeated hyphens", () => {
    for (const handle of ["-shop", "shop-", "-shop-", "high--land", "a---b"]) {
      expect(accepts(handle), handle).toBe(false);
    }
  });

  it("enforces the length bounds", () => {
    expect(accepts("ab")).toBe(false);
    expect(accepts("abc")).toBe(true);
    expect(accepts("x".repeat(MAX_PUBLIC_HANDLE_LENGTH))).toBe(true);
    expect(accepts("x".repeat(MAX_PUBLIC_HANDLE_LENGTH + 1))).toBe(false);
    expect(accepts("")).toBe(false);
  });

  it("is separate from identity — it is routing, not a key", () => {
    const record = storefrontRecord();
    expect(record.publicHandle).not.toBe(record.internalStorefrontId);
  });
});

// — 5 —

describe("5. a Storefront belongs to one participant, with no role and no co-owners", () => {
  it("ownership is a single participant reference", () => {
    const record = storefrontRecord();
    expect(record.ownerParticipantId).toBe(OWNER_PARTICIPANT_ID);
    const { ownerParticipantId: _omitted, ...withoutOwner } = record;
    expect(StorefrontSourceRecord.safeParse(withoutOwner).success).toBe(false);
  });

  it("no owner array, co-owner, or administrator array exists", () => {
    for (const intruder of [
      { ownerParticipantIds: [OWNER_PARTICIPANT_ID] },
      { coOwnerParticipantId: OTHER_PARTICIPANT_ID },
      { coOwners: [] },
      { administrators: [] },
      { admins: [ADMIN_ACCOUNT_ID] },
      { members: [] },
      { organizationMembers: [] },
      { superOwnerAccountId: SUPER_OWNER_ACCOUNT_ID },
      { governanceAssignments: [] },
    ]) {
      expect(StorefrontSourceRecord.safeParse({ ...storefrontRecord(), ...intruder }).success).toBe(
        false,
      );
      expect(
        StorefrontSourceVersion.safeParse({ ...storefrontVersion(), ...intruder }).success,
      ).toBe(false);
    }
  });

  it("no ownership-role field or Storefront mode exists", () => {
    for (const intruder of [
      { ownershipRole: "SELLER" },
      { ownershipAuthorityRole: "PROMOTER" },
      { storefrontMode: "SELLER_ONLY" },
      { contentMode: "HYBRID" },
      { allowsOwnedProducts: true },
      { permittedListingTypes: ["OWNED"] },
    ]) {
      expect(StorefrontSourceRecord.safeParse({ ...storefrontRecord(), ...intruder }).success).toBe(
        false,
      );
    }
  });

  it("organization ownership needs no Storefront change", () => {
    /* An organization-owned Storefront is the same shape as an individual-owned
       one. The owner's kind is a participant fact supplied to decisions, not a
       Storefront field. */
    expect(PARTICIPANT_KINDS).toEqual(["INDIVIDUAL", "ORGANIZATION"]);
    for (const ownerKind of PARTICIPANT_KINDS) {
      expectAllow(canCreateStorefrontRecord(createRequest({ owner: { ownerKind } })));
    }
    expect(Object.keys(storefrontRecord())).not.toContain("ownerKind");
  });
});

// — 6 —

describe("6. governance roles are SUPER_OWNER and ADMIN, separate from marketplace roles", () => {
  it("the governance vocabulary is exactly two roles", () => {
    expect(STOREFRONT_GOVERNANCE_ROLES).toEqual(["SUPER_OWNER", "ADMIN"]);
    expect(ACTOR_GOVERNANCE_ROLES).toEqual(["SUPER_OWNER", "ADMIN", "NONE"]);
    for (const notGovernance of ["SELLER", "PROMOTER", "BUYER", "INTERNAL_OPERATOR", "OWNER"]) {
      expect(StorefrontGovernanceRole.safeParse(notGovernance).success, notGovernance).toBe(false);
    }
  });

  it("marketplace roles are not governance roles, and vice versa", () => {
    for (const governance of STOREFRONT_GOVERNANCE_ROLES) {
      expect(MarketplaceRole.safeParse(governance).success, governance).toBe(false);
    }
    for (const marketplace of STOREFRONT_CAPABLE_ROLES) {
      expect(ActorGovernanceRole.safeParse(marketplace).success, marketplace).toBe(false);
    }
  });

  it("SUPER_OWNER inherits every ADMIN operational permission", () => {
    expect(governanceRoleGrantsOperationalAuthority("SUPER_OWNER")).toBe(true);
    expect(governanceRoleGrantsOperationalAuthority("ADMIN")).toBe(true);
    expect(governanceRoleGrantsOperationalAuthority("NONE")).toBe(false);
  });

  it("the SUPER_OWNER exclusivity list covers lifecycle, visibility, and finance", () => {
    for (const exclusive of [
      "storefront:activate",
      "storefront:resume",
      "storefront:visibility:deactivate",
      "storefront:suspend",
      "storefront:close",
      "storefront:governance:appoint-admin",
      "storefront:governance:revoke-admin",
      "financial:underwriting-responsibility",
      "financial:refunds",
      "financial:chargebacks",
      "financial:disputes",
      "financial:payout-administration",
    ]) {
      expect(isSuperOwnerExclusive(exclusive), exclusive).toBe(true);
      expect(ADMIN_OPERATIONAL_AUTHORITIES as readonly string[]).not.toContain(exclusive);
    }
  });

  it("presentation and item management are ADMIN operational authorities", () => {
    for (const operational of ADMIN_OPERATIONAL_AUTHORITIES) {
      expect(isSuperOwnerExclusive(operational), operational).toBe(false);
    }
  });
});

// — 7 —

describe("7. the owner's marketplace roles are not the acting member's", () => {
  it("owner facts carry the roles; actor facts carry none", () => {
    expect(Object.keys(ownerFacts())).toContain("roles");
    expect(Object.keys(actorFacts())).not.toContain("roles");
    expect(Object.keys(actorFacts())).not.toContain("participantId");
  });

  it("an organization member with no personal marketplace role may still act", () => {
    /* The organization holds SELLER; the member holds a governance assignment.
       Nothing requires the human to hold a marketplace role personally. */
    expectAllow(
      canActivateStorefrontRecord(
        actionRequest({
          owner: { ownerKind: "ORGANIZATION" },
          actor: { accountId: SUPER_OWNER_ACCOUNT_ID, governanceRole: "SUPER_OWNER" },
          lifecycle: "DRAFT",
        }),
      ),
    );
  });

  it("an owner lacking any Storefront-capable role is refused", () => {
    expectDeny(
      canActivateStorefrontRecord(
        actionRequest({ owner: { roles: [{ role: "BUYER", status: "ACTIVE" }] }, lifecycle: "DRAFT" }),
      ),
      "ROLE_NOT_HELD",
    );
    expectDeny(
      canCreateStorefrontRecord(
        createRequest({ owner: { roles: [{ role: "BUYER", status: "ACTIVE" }] } }),
      ),
      "ROLE_NOT_HELD",
    );
  });

  it("either Storefront-capable role qualifies the owner", () => {
    for (const role of ["SELLER", "PROMOTER"] as const) {
      expectAllow(
        canCreateStorefrontRecord(
          createRequest({ owner: { roles: [{ role, status: "DRAFT" }] } }),
        ),
      );
      expectAllow(
        canActivateStorefrontRecord(
          actionRequest({ owner: { roles: [{ role, status: "ACTIVE" }] }, lifecycle: "DRAFT" }),
        ),
      );
    }
  });

  it("authorization to act for the owner is supplied, never derived", () => {
    /* No email, domain, or profile field exists on actor facts to derive it from. */
    for (const key of ["email", "emailDomain", "displayName", "legalName", "profile"]) {
      expect(
        StorefrontActorFacts.safeParse({ ...actorFacts(), [key]: "x" }).success,
        key,
      ).toBe(false);
    }
    expectDeny(
      canEditStorefrontPresentation(
        actionRequest({ actor: { authorizedForOwnerParticipant: false } }),
      ),
      "ACTOR_NOT_AUTHORIZED_FOR_OWNER",
    );
  });

  it("member authority comes from an explicit governance assignment", () => {
    expectDeny(
      canEditStorefrontPresentation(
        actionRequest({ actor: { governanceRole: "NONE", governanceAssignmentStatus: "NONE" } }),
      ),
      "GOVERNANCE_ASSIGNMENT_REQUIRED",
    );
    for (const status of ["SUSPENDED", "REVOKED"] as const) {
      expectDeny(
        canEditStorefrontPresentation(
          actionRequest({ actor: { governanceAssignmentStatus: status } }),
        ),
        "GOVERNANCE_ASSIGNMENT_NOT_ACTIVE",
      );
    }
    expectDeny(
      canEditStorefrontPresentation(
        actionRequest({ actor: { assignmentStorefrontId: OTHER_STOREFRONT_ID } }),
      ),
      "GOVERNANCE_ASSIGNMENT_STOREFRONT_MISMATCH",
    );
  });
});

// — 8 —

describe("8. presentation may be edited by ADMIN and SUPER_OWNER", () => {
  it("an active ADMIN may edit", () => {
    expectAllow(
      canEditStorefrontPresentation(
        actionRequest({ actor: { accountId: ADMIN_ACCOUNT_ID, governanceRole: "ADMIN" } }),
      ),
    );
  });

  it("an active SUPER_OWNER may edit", () => {
    expectAllow(canEditStorefrontPresentation(actionRequest({})));
  });

  it("editing never requires payment readiness or underwriting", () => {
    for (const lifecycle of ["DRAFT", "ACTIVE", "SUSPENDED"] as const) {
      expectAllow(
        canEditStorefrontPresentation(
          actionRequest({
            owner: {
              paymentReadiness: "RESTRICTED",
              participantStatus: "PROFILE_INCOMPLETE",
            },
            goLiveApproval: "NOT_APPROVED",
            actor: { governanceRole: "ADMIN" },
            lifecycle,
          }),
        ),
      );
    }
  });

  it("a CLOSED Storefront is immutable", () => {
    expectDeny(
      canEditStorefrontPresentation(actionRequest({ lifecycle: "CLOSED" })),
      "STOREFRONT_CLOSED",
    );
  });
});

// — 9 —

describe("9. only the active SUPER_OWNER may activate, resume, or withdraw visibility", () => {
  const asAdmin = { accountId: ADMIN_ACCOUNT_ID, governanceRole: "ADMIN" as const };

  it("an ADMIN may not activate", () => {
    expectDeny(
      canActivateStorefrontRecord(actionRequest({ actor: asAdmin, lifecycle: "DRAFT" })),
      "SUPER_OWNER_REQUIRED",
    );
  });

  it("an ADMIN may not resume", () => {
    expectDeny(
      canResumeStorefrontRecord(actionRequest({ actor: asAdmin, lifecycle: "SUSPENDED" })),
      "SUPER_OWNER_REQUIRED",
    );
  });

  it("an ADMIN may not increase or reduce exposure", () => {
    expectDeny(
      canIncreaseStorefrontExposure(
        visibilityRequest({ actor: asAdmin, visibility: "PRIVATE", targetVisibility: "PUBLIC" }),
      ),
      "SUPER_OWNER_REQUIRED",
    );
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({ actor: asAdmin, visibility: "PUBLIC", targetVisibility: "PRIVATE" }),
      ),
      "SUPER_OWNER_REQUIRED",
    );
  });

  it("an ADMIN may not suspend or close", () => {
    expectDeny(
      canSuspendStorefrontRecord(actionRequest({ actor: asAdmin, lifecycle: "ACTIVE" })),
      "SUPER_OWNER_REQUIRED",
    );
    expectDeny(
      canCloseStorefrontRecord(actionRequest({ actor: asAdmin, lifecycle: "ACTIVE" })),
      "SUPER_OWNER_REQUIRED",
    );
  });

  it("the SUPER_OWNER may activate when every commerce gate passes", () => {
    expectAllow(canActivateStorefrontRecord(actionRequest({ lifecycle: "DRAFT" })));
    expectAllow(canResumeStorefrontRecord(actionRequest({ lifecycle: "SUSPENDED" })));
  });

  it("the SUPER_OWNER may reduce exposure along every downward step", () => {
    for (const [visibility, targetVisibility] of [
      ["PUBLIC", "UNLISTED"],
      ["PUBLIC", "PRIVATE"],
      ["UNLISTED", "PRIVATE"],
    ] as const) {
      expectAllow(canReduceStorefrontExposure(visibilityRequest({ visibility, targetVisibility })));
    }
  });

  it("a no-op or wrong-direction visibility change is refused", () => {
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({ visibility: "PUBLIC", targetVisibility: "PUBLIC" }),
      ),
      "VISIBILITY_UNCHANGED",
    );
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({ visibility: "PRIVATE", targetVisibility: "PUBLIC" }),
      ),
      "VISIBILITY_CHANGE_DIRECTION_MISMATCH",
    );
    expectDeny(
      canIncreaseStorefrontExposure(
        visibilityRequest({ visibility: "PUBLIC", targetVisibility: "PRIVATE" }),
      ),
      "VISIBILITY_CHANGE_DIRECTION_MISMATCH",
    );
  });

  it("the SUPER_OWNER may suspend and close", () => {
    expectAllow(canSuspendStorefrontRecord(actionRequest({ lifecycle: "ACTIVE" })));
    expectAllow(canCloseStorefrontRecord(actionRequest({ lifecycle: "ACTIVE" })));
    expectAllow(canCloseStorefrontRecord(actionRequest({ lifecycle: "DRAFT" })));
  });

  it("standing down never requires payment readiness or underwriting", () => {
    const stalled = { paymentReadiness: "DISABLED" as const };
    expectAllow(canSuspendStorefrontRecord(actionRequest({ owner: stalled, lifecycle: "ACTIVE" })));
    expectAllow(canCloseStorefrontRecord(actionRequest({ owner: stalled, lifecycle: "ACTIVE" })));
  });

  it("a decision decides; it mutates nothing", () => {
    const request = visibilityRequest({ visibility: "PUBLIC", targetVisibility: "PRIVATE" });
    const before = JSON.stringify(request);
    canReduceStorefrontExposure(request);
    canSuspendStorefrontRecord(request);
    expect(JSON.stringify(request)).toBe(before);
  });
});

// — 10 —

describe("10. exactly one active SUPER_OWNER is required before going live", () => {
  it("the boolean is gone; cardinality is bounded", () => {
    expect(SUPER_OWNER_CARDINALITIES).toEqual(["NONE", "EXACTLY_ONE", "MULTIPLE"]);
    expect(Object.keys(actionRequest())).not.toContain("activeSuperOwnerAppointed");
    expect(Object.keys(actionRequest())).toContain("activeSuperOwnerCardinality");
    expect(
      StorefrontRecordActionRequest.safeParse({
        ...actionRequest(),
        activeSuperOwnerCardinality: true,
      }).success,
    ).toBe(false);
  });

  it("NONE denies activation, resumption, and increased exposure", () => {
    expectDeny(
      canActivateStorefrontRecord(
        actionRequest({ lifecycle: "DRAFT", activeSuperOwnerCardinality: "NONE" }),
      ),
      "ACTIVE_SUPER_OWNER_NOT_APPOINTED",
    );
    expectDeny(
      canResumeStorefrontRecord(
        actionRequest({ lifecycle: "SUSPENDED", activeSuperOwnerCardinality: "NONE" }),
      ),
      "ACTIVE_SUPER_OWNER_NOT_APPOINTED",
    );
    expectDeny(
      canIncreaseStorefrontExposure(
        visibilityRequest({
          visibility: "PRIVATE",
          targetVisibility: "PUBLIC",
          activeSuperOwnerCardinality: "NONE",
        }),
      ),
      "ACTIVE_SUPER_OWNER_NOT_APPOINTED",
    );
  });

  it("MULTIPLE denies activation, resumption, and increased exposure", () => {
    /* Two people each believing they hold final financial responsibility is a
       governance defect, not a safer state. */
    expectDeny(
      canActivateStorefrontRecord(
        actionRequest({ lifecycle: "DRAFT", activeSuperOwnerCardinality: "MULTIPLE" }),
      ),
      "MULTIPLE_ACTIVE_SUPER_OWNERS",
    );
    expectDeny(
      canResumeStorefrontRecord(
        actionRequest({ lifecycle: "SUSPENDED", activeSuperOwnerCardinality: "MULTIPLE" }),
      ),
      "MULTIPLE_ACTIVE_SUPER_OWNERS",
    );
    expectDeny(
      canIncreaseStorefrontExposure(
        visibilityRequest({
          visibility: "PRIVATE",
          targetVisibility: "PUBLIC",
          activeSuperOwnerCardinality: "MULTIPLE",
        }),
      ),
      "MULTIPLE_ACTIVE_SUPER_OWNERS",
    );
  });

  it("holding the SUPER_OWNER assignment does not bypass MULTIPLE", () => {
    /* The actor's own assignment and the population count are separate facts. */
    const request = actionRequest({
      lifecycle: "DRAFT",
      actor: { governanceRole: "SUPER_OWNER", governanceAssignmentStatus: "ACTIVE" },
      activeSuperOwnerCardinality: "MULTIPLE",
    });
    expect(request.actor.governanceRole).toBe("SUPER_OWNER");
    expectDeny(canActivateStorefrontRecord(request), "MULTIPLE_ACTIVE_SUPER_OWNERS");
  });

  it("EXACTLY_ONE satisfies the cardinality requirement", () => {
    expectAllow(
      canActivateStorefrontRecord(
        actionRequest({ lifecycle: "DRAFT", activeSuperOwnerCardinality: "EXACTLY_ONE" }),
      ),
    );
  });

  it("MULTIPLE never traps a Storefront: reduction, suspension, and closure proceed", () => {
    /* A defective multiplicity must not prevent a valid active SUPER_OWNER from
       making the storefront safer. */
    expectAllow(
      canReduceStorefrontExposure(
        visibilityRequest({
          visibility: "PUBLIC",
          targetVisibility: "PRIVATE",
          activeSuperOwnerCardinality: "MULTIPLE",
        }),
      ),
    );
    expectAllow(
      canSuspendStorefrontRecord(
        actionRequest({ lifecycle: "ACTIVE", activeSuperOwnerCardinality: "MULTIPLE" }),
      ),
    );
    expectAllow(
      canCloseStorefrontRecord(
        actionRequest({ lifecycle: "ACTIVE", activeSuperOwnerCardinality: "MULTIPLE" }),
      ),
    );
  });

  it("EXACTLY_ONE permits the safety-reducing actions", () => {
    expectAllow(
      canReduceStorefrontExposure(
        visibilityRequest({
          visibility: "PUBLIC",
          targetVisibility: "PRIVATE",
          activeSuperOwnerCardinality: "EXACTLY_ONE",
        }),
      ),
    );
    expectAllow(
      canSuspendStorefrontRecord(
        actionRequest({ lifecycle: "ACTIVE", activeSuperOwnerCardinality: "EXACTLY_ONE" }),
      ),
    );
    expectAllow(
      canCloseStorefrontRecord(
        actionRequest({ lifecycle: "ACTIVE", activeSuperOwnerCardinality: "EXACTLY_ONE" }),
      ),
    );
  });

  it("an active SUPER_OWNER actor with cardinality NONE is a contradiction, and fails closed", () => {
    /* The actor holds an active SUPER_OWNER assignment bound to this Storefront
       while the resolved count says none exists — the two facts cannot both be
       true, so the snapshot is refused rather than acted on. An emergency
       platform-operator path must not be reachable this way. */
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({
          visibility: "PUBLIC",
          targetVisibility: "PRIVATE",
          activeSuperOwnerCardinality: "NONE",
        }),
      ),
      "INCONSISTENT_SUPER_OWNER_STATE",
    );
    expectDeny(
      canSuspendStorefrontRecord(
        actionRequest({ lifecycle: "ACTIVE", activeSuperOwnerCardinality: "NONE" }),
      ),
      "INCONSISTENT_SUPER_OWNER_STATE",
    );
    expectDeny(
      canCloseStorefrontRecord(
        actionRequest({ lifecycle: "ACTIVE", activeSuperOwnerCardinality: "NONE" }),
      ),
      "INCONSISTENT_SUPER_OWNER_STATE",
    );
  });

  it("a missing or inactive actor assignment is denied whatever the cardinality", () => {
    for (const cardinality of ["NONE", "EXACTLY_ONE", "MULTIPLE"] as const) {
      expectDeny(
        canReduceStorefrontExposure(
          visibilityRequest({
            visibility: "PUBLIC",
            targetVisibility: "PRIVATE",
            activeSuperOwnerCardinality: cardinality,
            actor: { governanceRole: "NONE", governanceAssignmentStatus: "NONE" },
          }),
        ),
        "GOVERNANCE_ASSIGNMENT_REQUIRED",
      );
      expectDeny(
        canSuspendStorefrontRecord(
          actionRequest({
            lifecycle: "ACTIVE",
            activeSuperOwnerCardinality: cardinality,
            actor: { governanceAssignmentStatus: "REVOKED" },
          }),
        ),
        "GOVERNANCE_ASSIGNMENT_NOT_ACTIVE",
      );
      expectDeny(
        canCloseStorefrontRecord(
          actionRequest({
            lifecycle: "ACTIVE",
            activeSuperOwnerCardinality: cardinality,
            actor: { governanceRole: "ADMIN" },
          }),
        ),
        "SUPER_OWNER_REQUIRED",
      );
    }
  });

  it("no commercial-readiness gate is reintroduced for valid safety-reducing actions", () => {
    const unready = {
      participantStatus: "SUSPENDED" as const,
      paymentReadiness: "DISABLED" as const,
      roles: [{ role: "SELLER", status: "REVOKED" }],
    };
    for (const cardinality of ["EXACTLY_ONE", "MULTIPLE"] as const) {
      expectAllow(
        canReduceStorefrontExposure(
          visibilityRequest({
            owner: unready,
            goLiveApproval: "NOT_APPROVED",
            activeSuperOwnerCardinality: cardinality,
            visibility: "PUBLIC",
            targetVisibility: "PRIVATE",
          }),
        ),
      );
      expectAllow(
        canSuspendStorefrontRecord(
          actionRequest({
            owner: unready,
            goLiveApproval: "NOT_APPROVED",
            activeSuperOwnerCardinality: cardinality,
            lifecycle: "ACTIVE",
          }),
        ),
      );
      expectAllow(
        canCloseStorefrontRecord(
          actionRequest({
            owner: unready,
            goLiveApproval: "NOT_APPROVED",
            activeSuperOwnerCardinality: cardinality,
            lifecycle: "ACTIVE",
          }),
        ),
      );
    }
  });

  it("draft creation does not require a SUPER_OWNER, since none can exist yet", () => {
    expectAllow(
      canCreateStorefrontRecord(
        createRequest({ actor: { governanceRole: "NONE", governanceAssignmentStatus: "NONE" } }),
      ),
    );
  });

  it("Monacado go-live approval is required to activate, and is supplied explicitly", () => {
    expectDeny(
      canActivateStorefrontRecord(
        actionRequest({ goLiveApproval: "NOT_APPROVED", lifecycle: "DRAFT" }),
      ),
      "GO_LIVE_NOT_APPROVED",
    );
  });

  it("draft creation requires neither participant ACTIVE, payment, nor underwriting", () => {
    for (const participantStatus of ["DRAFT", "PROFILE_INCOMPLETE", "UNDER_REVIEW"] as const) {
      expectAllow(
        canCreateStorefrontRecord(
          createRequest({
            owner: {
              participantStatus,
              paymentReadiness: "NOT_STARTED",
              roles: [{ role: "SELLER", status: "DRAFT" }],
            },
          }),
        ),
      );
    }
  });

  it("activation requires the owner admitted and payable", () => {
    expectDeny(
      canActivateStorefrontRecord(
        actionRequest({ owner: { participantStatus: "PROFILE_COMPLETE" }, lifecycle: "DRAFT" }),
      ),
      "PARTICIPANT_NOT_ACTIVATED",
    );
    for (const [paymentReadiness, code] of [
      ["NOT_STARTED", "PAYMENT_NOT_ENABLED"],
      ["RESTRICTED", "PAYMENT_RESTRICTED"],
    ] as const) {
      expectDeny(
        canActivateStorefrontRecord(
          actionRequest({ owner: { paymentReadiness }, lifecycle: "DRAFT" }),
        ),
        code,
      );
    }
  });
});

// — 11 —

describe("11. internal entitlement alone grants no Storefront authority", () => {
  const operator = {
    authorizedForOwnerParticipant: false,
    governanceRole: "NONE" as const,
    governanceAssignmentStatus: "NONE" as const,
    assignmentStorefrontId: null,
    internalCapabilities: ["publication-worker:status:read"],
  };

  it("an operator with no authorization and no assignment is denied everything", () => {
    expectDeny(
      canCreateStorefrontRecord(createRequest({ actor: operator })),
      "ACTOR_NOT_AUTHORIZED_FOR_OWNER",
    );
    for (const decide of [
      canEditStorefrontPresentation,
      canActivateStorefrontRecord,
      canResumeStorefrontRecord,
      canSuspendStorefrontRecord,
      canCloseStorefrontRecord,
    ]) {
      expectDeny(
        decide(actionRequest({ actor: operator, lifecycle: "ACTIVE", visibility: "PUBLIC" })),
        "ACTOR_NOT_AUTHORIZED_FOR_OWNER",
      );
    }
    for (const decide of [canIncreaseStorefrontExposure, canReduceStorefrontExposure]) {
      expectDeny(
        decide(
          visibilityRequest({ actor: operator, visibility: "PRIVATE", targetVisibility: "PUBLIC" }),
        ),
        "ACTOR_NOT_AUTHORIZED_FOR_OWNER",
      );
    }
  });

  it("holding the internal capability changes no decision", () => {
    const withCapability = actionRequest({
      actor: { internalCapabilities: ["publication-worker:status:read"] },
      lifecycle: "DRAFT",
    });
    const without = actionRequest({ lifecycle: "DRAFT" });
    expect(canActivateStorefrontRecord(withCapability)).toEqual(
      canActivateStorefrontRecord(without),
    );
  });

  it("an internal capability never substitutes for a governance assignment", () => {
    expectDeny(
      canActivateStorefrontRecord(
        actionRequest({
          actor: {
            governanceRole: "NONE",
            governanceAssignmentStatus: "NONE",
            internalCapabilities: ["publication-worker:status:read"],
          },
          lifecycle: "DRAFT",
        }),
      ),
      "GOVERNANCE_ASSIGNMENT_REQUIRED",
    );
  });
});

// — 12 —

describe("12. financial responsibility is exclusive to SUPER_OWNER", () => {
  it("every financial authority is SUPER_OWNER-exclusive", () => {
    for (const financial of [
      "financial:underwriting-responsibility",
      "financial:refunds",
      "financial:chargebacks",
      "financial:disputes",
      "financial:payout-administration",
    ]) {
      expect(isSuperOwnerExclusive(financial), financial).toBe(true);
      expect(ADMIN_OPERATIONAL_AUTHORITIES as readonly string[]).not.toContain(financial);
    }
  });

  it("no Stripe, refund, chargeback, or payout operation is implemented", () => {
    const source = readFileSync(
      new URL("../src/contracts/marketplace/storefront-source.ts", import.meta.url),
      "utf8",
    );
    for (const token of ["stripe", "acct_", "chargebackAmount", "refundAmount", "payoutSchedule"]) {
      expect(source.toLowerCase()).not.toContain(token.toLowerCase());
    }
    /* Underwriting appears only as a supplied readiness fact, never as data. */
    expect(Object.keys(actionRequest())).toContain("goLiveApproval");
    for (const providerish of ["stripeAccountId", "bankAccount", "taxId", "payoutSchedule"]) {
      expect(
        StorefrontOwnerFacts.safeParse({ ...ownerFacts(), [providerish]: "x" }).success,
        providerish,
      ).toBe(false);
    }
  });
});

// — 13 —

describe("13. future item-management and pricing authority is deferred, not decided", () => {
  it("Listing management is deferred to ADMIN and SUPER_OWNER", () => {
    const decision = StorefrontDeferredDecision.parse(canManageStorefrontListings());
    expect(decision.decision).toBe("DEFERRED");
    expect(decision.blockedBy).toContain("LISTING_CONTRACT_NOT_DEFINED");
    expect(decision.eventuallyPermittedTo).toEqual(["SUPER_OWNER", "ADMIN"]);
  });

  it("seller-controlled pricing is deferred on an unresolved pricing model", () => {
    const decision = StorefrontDeferredDecision.parse(canSetSellerControlledListingPrice());
    expect(decision.blockedBy).toContain("LISTING_PRICING_MODEL_UNRESOLVED");
    expect(decision.eventuallyPermittedTo).toEqual(["SUPER_OWNER", "ADMIN"]);
  });

  it("promoted pricing is additionally blocked on commission and settlement", () => {
    const decision = StorefrontDeferredDecision.parse(canSetPromotedListingPrice());
    expect(decision.blockedBy).toEqual([
      "LISTING_CONTRACT_NOT_DEFINED",
      "LISTING_PRICING_MODEL_UNRESOLVED",
      "COMMISSION_BASE_UNRESOLVED",
      "SETTLEMENT_ALLOCATION_UNRESOLVED",
    ]);
  });

  it("no creator price-floor policy remains anywhere", () => {
    /* Superseded: the creator controls wholesale price and commission; the
       Promoter controls the buyer-facing retail price. */
    const supersededTerms = ["creator" + "PriceFloor", "creator" + "MinimumRetailPrice", "MS" + "RP"];
    for (const file of [
      "../src/contracts/marketplace/storefront-source.ts",
      "../docs/AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md",
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      for (const term of supersededTerms) {
        expect(text, `${file} must not use ${term}`).not.toContain(term);
      }
    }
  });

  it("no Listing state or pricing calculation is implemented", () => {
    const source = readFileSync(
      new URL("../src/contracts/marketplace/storefront-source.ts", import.meta.url),
      "utf8",
    );
    for (const token of ["listingPrice", "computePrice", "calculateCommission", "markup ="]) {
      expect(source).not.toContain(token);
    }
  });
});

// — 13b —

describe("13b. go-live approval, live/paused control, and promotion economics", () => {
  it("go-live approval is a supplied decision input, never Storefront source truth", () => {
    expect(GO_LIVE_APPROVAL_STATUSES).toEqual(["APPROVED", "NOT_APPROVED"]);
    expect(Object.keys(actionRequest())).toContain("goLiveApproval");
    for (const shape of [storefrontRecord(), storefrontVersion()]) {
      expect(Object.keys(shape)).not.toContain("goLiveApproval");
    }
    for (const intruder of [
      { goLiveApproval: "APPROVED" },
      { goLiveApprovalStatus: "APPROVED" },
      { stripeStatus: "verified" },
      { isLive: true },
    ]) {
      expect(StorefrontSourceRecord.safeParse({ ...storefrontRecord(), ...intruder }).success).toBe(
        false,
      );
      expect(
        StorefrontSourceVersion.safeParse({ ...storefrontVersion(), ...intruder }).success,
      ).toBe(false);
    }
    expect(isProjectionEligibleStorefrontField("goLiveApproval")).toBe(false);
  });

  it("live is derived from three facts and never stored", () => {
    expect(
      isStorefrontLive({ lifecycle: "ACTIVE", visibility: "PUBLIC", goLiveApproval: "APPROVED" }),
    ).toBe(true);
    expect(
      isStorefrontLive({ lifecycle: "ACTIVE", visibility: "UNLISTED", goLiveApproval: "APPROVED" }),
    ).toBe(true);
    /* PRIVATE is paused. */
    expect(
      isStorefrontLive({ lifecycle: "ACTIVE", visibility: "PRIVATE", goLiveApproval: "APPROVED" }),
    ).toBe(false);
    /* Approval alone is not live, and neither is exposure alone. */
    expect(
      isStorefrontLive({ lifecycle: "ACTIVE", visibility: "PUBLIC", goLiveApproval: "NOT_APPROVED" }),
    ).toBe(false);
    expect(
      isStorefrontLive({ lifecycle: "SUSPENDED", visibility: "PUBLIC", goLiveApproval: "APPROVED" }),
    ).toBe(false);
  });

  it("APPROVED permits increased exposure when every governance gate passes", () => {
    for (const [visibility, targetVisibility] of [
      ["PRIVATE", "UNLISTED"],
      ["PRIVATE", "PUBLIC"],
      ["UNLISTED", "PUBLIC"],
    ] as const) {
      expectAllow(
        canIncreaseStorefrontExposure(visibilityRequest({ visibility, targetVisibility })),
      );
    }
  });

  it("NOT_APPROVED denies increased exposure", () => {
    expectDeny(
      canIncreaseStorefrontExposure(
        visibilityRequest({
          visibility: "PRIVATE",
          targetVisibility: "PUBLIC",
          goLiveApproval: "NOT_APPROVED",
        }),
      ),
      "GO_LIVE_NOT_APPROVED",
    );
  });

  it("NOT_APPROVED still permits reduced exposure", () => {
    /* Taking a shop down must never be blocked by the conditions that make taking
       it down necessary. */
    for (const owner of [{}, { paymentReadiness: "DISABLED" as const }]) {
      expectAllow(
        canReduceStorefrontExposure(
          visibilityRequest({
            owner,
            visibility: "PUBLIC",
            targetVisibility: "PRIVATE",
            goLiveApproval: "NOT_APPROVED",
          }),
        ),
      );
    }
  });

  it("increasing exposure requires an ACTIVE lifecycle", () => {
    expectDeny(
      canIncreaseStorefrontExposure(
        visibilityRequest({ lifecycle: "SUSPENDED", visibility: "PRIVATE", targetVisibility: "PUBLIC" }),
      ),
      "STOREFRONT_NOT_ACTIVE",
    );
  });

  it("restoring APPROVED does not restore visibility by itself", () => {
    /* The Storefront is paused. Approval returning changes the approval fact and
       nothing else; the SUPER_OWNER must explicitly go live again. */
    const paused = { lifecycle: "ACTIVE" as const, visibility: "PRIVATE" as const };
    expect(isStorefrontLive({ ...paused, goLiveApproval: "APPROVED" })).toBe(false);
    expectAllow(
      canIncreaseStorefrontExposure(visibilityRequest({ ...paused, targetVisibility: "PUBLIC" })),
    );
  });

  it("no Offer, Listing, or notification fact belongs to the Storefront", () => {
    for (const foreign of [
      "wholesalePrice",
      "promoterRetailPrice",
      "commissionMethod",
      "commissionRate",
      "fixedCommissionAmount",
      "commercialAvailability",
      "listingState",
      "priceReviewRequired",
      "notices",
      "noticeCount",
    ]) {
      expect(MATERIAL_STOREFRONT_FIELDS as readonly string[]).not.toContain(foreign);
      expect(
        StorefrontSourceRecord.safeParse({ ...storefrontRecord(), [foreign]: 1 }).success,
        foreign,
      ).toBe(false);
      expect(
        StorefrontSourceVersion.safeParse({ ...storefrontVersion(), [foreign]: 1 }).success,
        foreign,
      ).toBe(false);
    }
  });
});

// — 13d —

describe("13d. approval gates operational access, and reduction is never gated on it", () => {
  it("NOT_APPROVED makes an ACTIVE + PUBLIC Storefront inaccessible and undiscoverable", () => {
    const withdrawn = {
      lifecycle: "ACTIVE",
      visibility: "PUBLIC",
      goLiveApproval: "NOT_APPROVED",
    } as const;
    expect(isPubliclyAccessible(withdrawn)).toBe(false);
    expect(isDiscoverable(withdrawn)).toBe(false);
    expect(isStorefrontLive(withdrawn)).toBe(false);
    /* …and it takes effect immediately, before any workflow records PRIVATE. */
    expect(withdrawn.visibility).toBe("PUBLIC");
  });

  it("APPROVED + ACTIVE + PUBLIC is accessible and discoverable", () => {
    const live = { lifecycle: "ACTIVE", visibility: "PUBLIC", goLiveApproval: "APPROVED" } as const;
    expect(isPubliclyAccessible(live)).toBe(true);
    expect(isDiscoverable(live)).toBe(true);
    expect(isStorefrontLive(live)).toBe(true);
  });

  it("APPROVED + ACTIVE + UNLISTED is accessible but not discoverable", () => {
    const unlisted = {
      lifecycle: "ACTIVE",
      visibility: "UNLISTED",
      goLiveApproval: "APPROVED",
    } as const;
    expect(isPubliclyAccessible(unlisted)).toBe(true);
    expect(isDiscoverable(unlisted)).toBe(false);
  });

  it("PRIVATE is inaccessible however approved", () => {
    for (const goLiveApproval of ["APPROVED", "NOT_APPROVED"] as const) {
      const paused = { lifecycle: "ACTIVE", visibility: "PRIVATE", goLiveApproval } as const;
      expect(isPubliclyAccessible(paused)).toBe(false);
      expect(isDiscoverable(paused)).toBe(false);
    }
  });

  it("configured visibility intent is a separate, clearly-named question", () => {
    /* One definition of public access; intent is named so it cannot be mistaken
       for it. */
    expect(visibilityIntentPermitsPublicAccess("PUBLIC")).toBe(true);
    expect(visibilityIntentPermitsPublicAccess("UNLISTED")).toBe(true);
    expect(visibilityIntentPermitsPublicAccess("PRIVATE")).toBe(false);
    /* Intent may permit access while approval withholds it. */
    expect(
      isPubliclyAccessible({
        lifecycle: "ACTIVE",
        visibility: "PUBLIC",
        goLiveApproval: "NOT_APPROVED",
      }),
    ).toBe(false);
  });

  it("restoring APPROVED does not mutate visibility", () => {
    const record = storefrontRecord({ lifecycle: "ACTIVE", visibility: "PRIVATE" });
    expect(
      isPubliclyAccessible({
        lifecycle: record.lifecycle,
        visibility: record.visibility,
        goLiveApproval: "APPROVED",
      }),
    ).toBe(false);
    expect(record.visibility).toBe("PRIVATE");
  });

  it("there is no stored isLive field", () => {
    for (const shape of [storefrontRecord(), storefrontVersion()]) {
      expect(Object.keys(shape)).not.toContain("isLive");
    }
    for (const intruder of [{ isLive: true }, { live: true }, { operationallyLive: false }]) {
      expect(StorefrontSourceRecord.safeParse({ ...storefrontRecord(), ...intruder }).success).toBe(
        false,
      );
    }
  });

  it("reduction requires every actor gate — it is not role-only authorization", () => {
    const base = { visibility: "PUBLIC", targetVisibility: "PRIVATE" } as const;
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({ ...base, actor: { accountStatus: "DISABLED" } }),
      ),
      "ACCOUNT_DISABLED",
    );
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({ ...base, actor: { authorizedForOwnerParticipant: false } }),
      ),
      "ACTOR_NOT_AUTHORIZED_FOR_OWNER",
    );
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({
          ...base,
          actor: { governanceRole: "NONE", governanceAssignmentStatus: "NONE" },
        }),
      ),
      "GOVERNANCE_ASSIGNMENT_REQUIRED",
    );
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({ ...base, actor: { governanceAssignmentStatus: "REVOKED" } }),
      ),
      "GOVERNANCE_ASSIGNMENT_NOT_ACTIVE",
    );
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({ ...base, actor: { assignmentStorefrontId: OTHER_STOREFRONT_ID } }),
      ),
      "GOVERNANCE_ASSIGNMENT_STOREFRONT_MISMATCH",
    );
    expectDeny(
      canReduceStorefrontExposure(
        visibilityRequest({ ...base, actor: { governanceRole: "ADMIN" } }),
      ),
      "SUPER_OWNER_REQUIRED",
    );
  });

  it("reduction requires no commercial readiness of any kind", () => {
    expectAllow(
      canReduceStorefrontExposure(
        visibilityRequest({
          visibility: "PUBLIC",
          targetVisibility: "PRIVATE",
          goLiveApproval: "NOT_APPROVED",
          activeSuperOwnerCardinality: "MULTIPLE",
          owner: {
            participantStatus: "SUSPENDED",
            paymentReadiness: "DISABLED",
            roles: [{ role: "SELLER", status: "REVOKED" }],
          },
        }),
      ),
    );
  });
});

// — 13c —

describe("13c. Offer, Listing, and notification policy stays out of this module", () => {
  const source = readFileSync(
    new URL("../src/contracts/marketplace/storefront-source.ts", import.meta.url),
    "utf8",
  );

  it("contains no executable Offer commission model", () => {
    for (const token of [
      "COMMISSION_METHODS",
      "PERCENT_OF_WHOLESALE",
      "FIXED_AMOUNT",
      "CREATOR_CONTROLLED_OFFER_FACTS",
      "REQUIRED_CREATOR_DISCLOSURES",
      "PROMOTER_EARNINGS_RELATIONSHIP",
      "wholesalePrice",
      "commissionRate",
    ]) {
      expect(source, `storefront-source.ts must not define ${token}`).not.toContain(token);
    }
  });

  it("contains no executable Listing flow-through model", () => {
    for (const token of [
      "LISTING_EFFECT_BY_CHANGE_CATEGORY",
      "PROMOTER_CONTROLLED_LISTING_FACTS",
      "remainsSellable",
      "requiresExplicitPriceReview",
      "priceReview",
    ]) {
      expect(source, `storefront-source.ts must not define ${token}`).not.toContain(token);
    }
  });

  it("contains no notification deduplication implementation", () => {
    for (const token of [
      "noticeDeduplicationKey",
      "OFFER_CHANGE_CATEGORIES",
      "REQUIRED_NOTICE_CONTENT",
      "CANONICAL_NOTICE_CHANNEL",
      "SUPPLEMENTAL_NOTICE_CHANNELS",
      "ADMIN_PANEL",
    ]) {
      expect(source, `storefront-source.ts must not define ${token}`).not.toContain(token);
    }
  });

  it("keeps only Storefront-domain concerns", () => {
    /* What the module *is* allowed to hold. */
    for (const token of [
      "StorefrontSourceRecord",
      "StorefrontGoLiveApprovalStatus",
      "SuperOwnerCardinality",
      "STOREFRONT_GOVERNANCE_ROLES",
      "MATERIAL_STOREFRONT_FIELDS",
    ]) {
      expect(source).toContain(token);
    }
  });
});

// — 14 —

describe("14. documentation records the governance and pricing boundaries", () => {
  const doc = readFileSync(
    new URL("../docs/AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md", import.meta.url),
    "utf8",
  );

  it("states that a Storefront may hold owned, promoted, or mixed Listings", () => {
    expect(doc).toContain("owned Listings, promoted Listings, or both");
    expect(doc).toContain("per Listing");
  });

  it("states that ADMIN and SUPER_OWNER may eventually manage Listings", () => {
    expect(doc).toContain("ADMIN` and `SUPER_OWNER` may eventually add or remove Listings");
  });

  it("states that the Promoter controls the retail price and the creator does not", () => {
    expect(doc).toContain("The creator does not control the Promoter's final retail price");
    expect(doc).toContain("no creator-enforced minimum resale price");
  });

  it("states the commission methods and that retail price does not change commission", () => {
    expect(doc).toContain("PERCENT_OF_WHOLESALE");
    expect(doc).toContain("FIXED_AMOUNT");
    expect(doc).toContain(
      "The Promoter's retail price does not change the commission due",
    );
  });

  it("states that the exact commission must never surprise the creator", () => {
    expect(doc).toContain("exact calculated commission per completed sale");
    expect(doc).toContain("must never surprise the creator");
  });

  it("states the admin panel is the canonical notice channel", () => {
    expect(doc).toContain("The canonical channel is the Monacado admin panel");
    expect(doc).toContain("can never replace it");
  });

  it("states the flow-through rules for availability, wholesale, and commission", () => {
    expect(doc).toContain("never destructively deleted");
    expect(doc).toContain("acknowledgement alone does not reactivate");
    expect(doc).toContain("Monacado never automatically changes a Promoter's retail price");
  });

  it("states that removing a Listing does not delete the Product or Offer", () => {
    expect(doc).toContain("must never delete the underlying Product or Offer");
  });

  it("records the required Offer-economics correction", () => {
    expect(doc).toContain("Offer-economics correction is required before any Listing pricing");
    expect(doc).toContain("are not modified in this phase");
  });

  it("the roadmap schedules 0M.2C, Listing, and notification work as not started", () => {
    const roadmap = readFileSync(
      new URL("../docs/POST_0E7_MARKETPLACE_ROADMAP.md", import.meta.url),
      "utf8",
    );
    expect(roadmap).toContain("0M.2C");
    expect(roadmap).toContain("Offer economics correction");
    /* Phase 0M.5 merged the duplicate Listing entry into the canonical 0M.4A
       heading; 0M.4A then delivered the Listing source model. One entry, and the
       Storefront model itself is unchanged by either phase. */
    expect(roadmap).toContain("0M.4A — Authoritative Listing Source Model");
    expect(roadmap).not.toContain("0M.4A′");
    /* Risk management is now a named phase, and still not started. */
    expect(roadmap).toContain("0M.R — Risk Management and Commercial Controls");
    /* Narrowed at Phase 0M.N1, which implemented the obligation half. What this
       asserts is that notification work is a NAMED, scheduled phase rather than
       an unowned intention — and that the deferred delivery half stays named
       too. The "(required, not started)" wording was incidental to nothing
       having been built yet. */
    expect(roadmap).toContain("0M.N1 — Notification Obligation Records");
    expect(roadmap).toContain("`0M.N2` remains deferred");
    /* Phase 0M.3B delivered the Storefront projection, so this pair is now
       complete. The source model itself is unchanged by that phase. */
    expect(roadmap).toContain("Storefront Capsule Projection Shape | **complete**");
    expect(roadmap).toContain("Authoritative Storefront Source Model | **complete**");
  });

  it("the documented flow-through rules survive the module cleanup", () => {
    /* The policy is binding on future phases even though no code implements it. */
    expect(doc).toContain("PERCENT_OF_WHOLESALE");
    expect(doc).toContain("FIXED_AMOUNT");
    expect(doc).toContain("Commercial availability");
    expect(doc).toContain("Wholesale price");
    expect(doc).toContain("Commission terms");
    expect(doc).toContain("acknowledgement alone does not reactivate");
    expect(doc).toContain("The canonical channel is the Monacado admin panel");
  });
});

// — 24 —

describe("24. material changes require a new source version", () => {
  it("every material field triggers one", () => {
    for (const field of MATERIAL_STOREFRONT_FIELDS) {
      expect(classifyStorefrontChange([field]).requiresNewSourceVersion).toBe(true);
    }
    expect(MATERIAL_STOREFRONT_FIELDS).toHaveLength(7);
    /* Role assignments are participant facts, not Storefront facts. */
    for (const roleish of ["ownershipRole", "roles", "roleAssignment"]) {
      expect(MATERIAL_STOREFRONT_FIELDS as readonly string[]).not.toContain(roleish);
      expect(() => classifyStorefrontChange([roleish])).toThrow();
    }
  });

  it("a real diff reports exactly the fields that moved", () => {
    const prior = storefrontRecord();
    expect(materialChangesBetween(prior, prior)).toEqual([]);
    expect(
      materialChangesBetween(prior, storefrontRecord({ ownerParticipantId: OTHER_PARTICIPANT_ID })),
    ).toEqual(["ownerParticipantId"]);
    expect(materialChangesBetween(prior, storefrontRecord({ lifecycle: "ACTIVE" }))).toEqual([
      "lifecycle",
    ]);
    expect(materialChangesBetween(prior, storefrontRecord({ visibility: "PUBLIC" }))).toEqual([
      "visibility",
    ]);
    expect(materialChangesBetween(prior, storefrontRecord({ publicHandle: "new-handle" }))).toEqual([
      "publicHandle",
    ]);
  });

  it("presentation fields are reported individually", () => {
    const prior = storefrontRecord();
    expect(
      materialChangesBetween(
        prior,
        storefrontRecord({ presentation: { ...PRESENTATION, displayName: "Renamed" } }),
      ),
    ).toEqual(["displayName"]);
    expect(
      materialChangesBetween(
        prior,
        storefrontRecord({ presentation: { ...PRESENTATION, tagline: null } }),
      ),
    ).toEqual(["tagline"]);
    expect(
      materialChangesBetween(
        prior,
        storefrontRecord({ presentation: { ...PRESENTATION, summary: "Now with a summary." } }),
      ),
    ).toEqual(["summary"]);
  });
});

// — 25 —

describe("25. operational counters and publication state create no source version", () => {
  it("every operational field is version-free", () => {
    for (const field of OPERATIONAL_ONLY_STOREFRONT_FIELDS) {
      const classified = classifyStorefrontChange([field]);
      expect(classified.requiresNewSourceVersion).toBe(false);
      expect(classified.operationalFields).toEqual([field]);
    }
    expect(OPERATIONAL_ONLY_STOREFRONT_FIELDS).toHaveLength(10);
  });

  it("a mixed change still requires a version, and reports both sets", () => {
    const classified = classifyStorefrontChange(["viewCount", "publicHandle", "listingCount"]);
    expect(classified.requiresNewSourceVersion).toBe(true);
    expect(classified.materialFields).toEqual(["publicHandle"]);
    expect(classified.operationalFields).toEqual(["viewCount", "listingCount"]);
  });

  it("an empty change set requires nothing", () => {
    expect(classifyStorefrontChange([]).requiresNewSourceVersion).toBe(false);
  });

  it("an unclassified field name is a validation failure, never a guess", () => {
    expect(() => classifyStorefrontChange(["someNewField"])).toThrow();
    expect(() => classifyStorefrontChange(["nodeId"])).toThrow();
  });
});

// — 26 —

describe("26. private fields are excluded from projection eligibility", () => {
  it("the two classifications are disjoint", () => {
    for (const field of PROJECTION_ELIGIBLE_STOREFRONT_FIELDS) {
      expect(isNeverProjectionEligibleStorefrontData(field)).toBe(false);
    }
    for (const field of NEVER_PROJECTION_ELIGIBLE_STOREFRONT_DATA) {
      expect(isProjectionEligibleStorefrontField(field)).toBe(false);
    }
  });

  it("account, role, identity, payment, billing, moderation, and analytics data are never eligible", () => {
    for (const field of [
      "accountId",
      "roleAssignmentId",
      "email",
      "legalIdentity",
      "privateProfile",
      "paymentReadiness",
      "paymentProviderId",
      "subscriptionPlan",
      "billingPlan",
      "internalModerationNotes",
      "analytics",
      "listingContents",
      "publicationMachinery",
      "auditInternals",
      "sourceRetentionState",
      "legalHoldState",
      "rawOwnerParticipantId",
      "superOwnerAccountId",
      "adminAccountIds",
      "organizationMembershipId",
      "governanceAssignment",
      "underwritingData",
      "internalAuthorizationEvidence",
    ]) {
      expect(isNeverProjectionEligibleStorefrontData(field)).toBe(true);
      expect(isProjectionEligibleStorefrontField(field)).toBe(false);
    }
  });

  it("no Seller/Promoter role basis is projection-eligible", () => {
    /* There is no basis to project. Nothing in the eligible set names a role. */
    for (const roleish of [
      "ownershipRole",
      "ownershipAuthorityRole",
      "storefrontMode",
      "contentMode",
      "roles",
      "roleAssignment",
    ]) {
      expect(isProjectionEligibleStorefrontField(roleish), roleish).toBe(false);
    }
    for (const field of PROJECTION_ELIGIBLE_STOREFRONT_FIELDS) {
      expect(field.toLowerCase()).not.toContain("role");
      expect(field.toLowerCase()).not.toContain("mode");
    }
  });

  it("no such data exists on the record to begin with", () => {
    for (const intruder of [
      { accountId: ACCOUNT_ID },
      { paymentReadiness: "ENABLED" },
      { subscriptionPlan: "pro" },
      { internalModerationNotes: "watch this one" },
      { analytics: { views: 10 } },
    ]) {
      expect(StorefrontSourceRecord.safeParse({ ...storefrontRecord(), ...intruder }).success).toBe(
        false,
      );
    }
  });
});

// — 27 —

describe("27. deferred extensions cannot enter through metadata", () => {
  it("each deferred extension is refused on the record and the version", () => {
    for (const extension of DEFERRED_STOREFRONT_EXTENSIONS) {
      expect(
        StorefrontSourceRecord.safeParse({ ...storefrontRecord(), [extension]: {} }).success,
        extension,
      ).toBe(false);
      expect(
        StorefrontSourceVersion.safeParse({ ...storefrontVersion(), [extension]: {} }).success,
        extension,
      ).toBe(false);
    }
    expect(DEFERRED_STOREFRONT_EXTENSIONS.length).toBeGreaterThanOrEqual(24);
  });

  it("there is no metadata, extension, or customization bag", () => {
    for (const bag of ["metadata", "extensions", "custom", "attributes", "extra", "settings"]) {
      expect(
        StorefrontSourceRecord.safeParse({ ...storefrontRecord(), [bag]: { theme: "dark" } })
          .success,
      ).toBe(false);
    }
  });

  it("presentation is closed to media and styling", () => {
    for (const intruder of [{ logo: "https://x" }, { theme: "dark" }, { customCss: "body{}" }]) {
      expect(StorefrontPresentation.safeParse({ ...PRESENTATION, ...intruder }).success).toBe(
        false,
      );
    }
  });
});

// — 28 —

describe("28. unknown keys and enum values fail", () => {
  it("unknown enum members are refused", () => {
    expect(StorefrontLifecycleState.safeParse("ARCHIVED").success).toBe(false);
    expect(StorefrontLifecycleState.safeParse("PUBLISHED").success).toBe(false);
    expect(StorefrontVisibility.safeParse("HIDDEN").success).toBe(false);
  });

  it("unknown keys are refused on every shape", () => {
    expect(StorefrontSourceRecord.safeParse({ ...storefrontRecord(), extra: 1 }).success).toBe(
      false,
    );
    expect(StorefrontSourceVersion.safeParse({ ...storefrontVersion(), extra: 1 }).success).toBe(
      false,
    );
    expect(StorefrontPresentation.safeParse({ ...PRESENTATION, extra: 1 }).success).toBe(false);
  });

  it("the source-system triple is fixed", () => {
    for (const intruder of [
      { sourceSystem: "external" },
      { sourceRecordType: "Offer" },
      { sourceClass: "imported" },
    ]) {
      expect(StorefrontSourceRecord.safeParse({ ...storefrontRecord(), ...intruder }).success).toBe(
        false,
      );
    }
  });

  it("a malformed decision is refused", () => {
    expect(
      StorefrontAuthorityDecision.safeParse({
        capability: "storefront:owned:activate",
        decision: "ALLOW",
        reasonCodes: ["ROLE_NOT_HELD"],
      }).success,
    ).toBe(false);
    expect(
      StorefrontAuthorityDecision.safeParse({
        capability: "storefront:owned:activate",
        decision: "DENY",
        reasonCodes: [],
      }).success,
    ).toBe(false);
    expect(
      StorefrontAuthorityDecision.safeParse({
        capability: "storefront:owned:delete",
        decision: "DENY",
        reasonCodes: ["ROLE_NOT_HELD"],
      }).success,
    ).toBe(false);
    expect(STOREFRONT_CAPABILITIES).toHaveLength(8);
  });

  it("no decision reads ambient state", () => {
    const source = readFileSync(
      new URL("../src/contracts/marketplace/storefront-source.ts", import.meta.url),
      "utf8",
    );
    for (const token of [
      "process.env",
      "Date.now",
      "new Date",
      "Math.random",
      "fetch(",
      "prisma",
      "@prisma/client",
      "node:crypto",
    ]) {
      expect(source, `storefront-source.ts must not reference ${token}`).not.toContain(token);
    }
  });

  it("no capsule, ontology, or projection import exists", () => {
    const source = readFileSync(
      new URL("../src/contracts/marketplace/storefront-source.ts", import.meta.url),
      "utf8",
    );
    for (const token of ["capsule/envelope", "commerce.ontology", "commerce.context", "AnsNodeId"]) {
      expect(source, `storefront-source.ts must not reference ${token}`).not.toContain(token);
    }
  });
});
