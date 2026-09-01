/**
 * Persisted Storefront records and governance (Phase 0M.3C).
 *
 * The record shapes behind the 0M.3A source model. `storefront-source.ts` says
 * what a Storefront *is* and who may change it; this module says what is durably
 * *stored* and what a caller supplies to change it.
 *
 * Four properties shape everything below:
 *
 *   1. **The database is the sole source of truth** (ADR §12). Every field here
 *      is authoritative transactional state. The capsule projection reads from
 *      it one way and writes nothing back.
 *
 *   2. **This module adds no Storefront fact.** Every persisted field maps
 *      one-to-one onto a `StorefrontSourceVersion` member, so a stored row
 *      round-trips exactly into the contract the projection already consumes.
 *      Persistence must not widen the source model.
 *
 *   3. **Go-live approval is not a Storefront fact.** 0M.3A makes it a supplied
 *      decision input, and there is deliberately no input, record, or column for
 *      it here — storing the approver's decision inside the approved thing is
 *      exactly the coupling that model avoids.
 *
 *   4. **Governance is a second axis, never a second ownership.** An assignment
 *      grants administrative authority over one Storefront; it never makes the
 *      assignee a co-owner, and `Storefront.ownerParticipantId` is untouched by
 *      any governance operation.
 *
 * Pure data. No database, clock, environment read, randomness, or network. Not
 * exported through the browser-facing barrel.
 */

import { z } from "zod";
import { STOREFRONT_GOVERNANCE_ASSIGNMENT_ID_RE } from "./identity";
import { MarketplaceParticipantId } from "./participant";
import {
  InternalStorefrontId,
  PublicHandle,
  StorefrontGovernanceRole,
  StorefrontLifecycleState,
  StorefrontPresentation,
  StorefrontSourceRecordId,
  StorefrontSourceRecordVersion,
  StorefrontVisibility,
} from "./storefront-source";

// — Identity —

export const StorefrontGovernanceAssignmentId = z
  .string()
  .regex(
    STOREFRONT_GOVERNANCE_ASSIGNMENT_ID_RE,
    "governanceAssignmentId must be mon:sgov:<opaque>",
  );
export type StorefrontGovernanceAssignmentId = z.infer<typeof StorefrontGovernanceAssignmentId>;

/**
 * The account whose marketplace identity and Storefront governance are read.
 *
 * **Phase 1.18 replaced `authorizedByParticipantId` and
 * `actorAuthorizedForOwnerParticipant` with this one member.** Those two let a
 * caller name which participant it was and then assert that the participant was
 * authorized — so knowing one opaque id was enough to appoint yourself
 * SUPER_OWNER of any Storefront. The acting participant is now resolved from
 * `MarketplaceParticipant.accountId`, and authorization to act for the owner is
 * derived from self-ownership or an ACTIVE governance assignment.
 *
 * This names who is asking, never what they may do. A production caller must
 * take it from an authenticated session, never from a request body — see
 * `src/server/account/acting-participant-boundary.ts`.
 */
const ActingAccountId = z.string().min(1).max(191);

// — Governance assignment —

/**
 * The statuses a **stored** governance assignment may hold.
 *
 * `NONE` is a member of the 0M.3A vocabulary but is deliberately **not storable**:
 * it means "no assignment exists", which is the absence of a row. Persisting it
 * would make "never appointed" and "appointed then removed" indistinguishable —
 * exactly the distinction that model draws.
 */
export const STORED_GOVERNANCE_ASSIGNMENT_STATUSES = [
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
] as const;
export const StoredGovernanceAssignmentStatus = z.enum(STORED_GOVERNANCE_ASSIGNMENT_STATUSES);
export type StoredGovernanceAssignmentStatus = z.infer<typeof StoredGovernanceAssignmentStatus>;

export const StorefrontGovernanceAssignmentRecord = z.strictObject({
  governanceAssignmentId: StorefrontGovernanceAssignmentId,
  internalStorefrontId: InternalStorefrontId,
  participantId: MarketplaceParticipantId,
  role: StorefrontGovernanceRole,
  status: StoredGovernanceAssignmentStatus,
  assignedAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type StorefrontGovernanceAssignmentRecord = z.infer<
  typeof StorefrontGovernanceAssignmentRecord
>;

// — Inputs —

/**
 * Create one draft Storefront and its first immutable source version.
 *
 * The first version is always `DRAFT` and `PRIVATE`: 0M.3A's lifecycle starts at
 * `DRAFT`, and a Storefront that were publicly visible before anyone reviewed it
 * would defeat the go-live gate entirely. Neither is a caller choice.
 *
 * The authorization trace is **derived, not supplied**: the service records the
 * resolved acting participant and the resolved acting account, so a caller can
 * name neither the participant it acted as nor the actor credited for the act.
 */
export const CreateDraftStorefrontInput = z.strictObject({
  ownerParticipantId: MarketplaceParticipantId,
  publicHandle: PublicHandle,
  presentation: StorefrontPresentation,

  /** The account acting. The audit actor is derived from it, never supplied. */
  actingAccountId: ActingAccountId,

  /** Explicit instants. Nothing here reads a clock. */
  now: z.iso.datetime(),
});
export type CreateDraftStorefrontInput = z.infer<typeof CreateDraftStorefrontInput>;

/**
 * A material update, minting a new immutable source version.
 *
 * Every member is optional: a caller states only what changes, and the service
 * compares the result against the current version using 0M.3A's own
 * `materialChangesBetween`. An update that changes nothing material mints no
 * version — a version that asserted nothing would be history noise.
 *
 * `sourceRecordVersion` is supplied rather than generated, matching the Product
 * and Offer convention: the version label is a caller-controlled identity, and a
 * service that invented one would make two concurrent writers agree by accident.
 */
export const UpdateStorefrontInput = z.strictObject({
  internalStorefrontId: InternalStorefrontId,
  /** The new immutable version's label. Must not already exist. */
  sourceRecordVersion: StorefrontSourceRecordVersion,

  /** Only the members a caller intends to change. */
  publicHandle: PublicHandle.optional(),
  presentation: StorefrontPresentation.optional(),
  lifecycle: StorefrontLifecycleState.optional(),
  visibility: StorefrontVisibility.optional(),

  actingAccountId: ActingAccountId,
  now: z.iso.datetime(),
});
export type UpdateStorefrontInput = z.infer<typeof UpdateStorefrontInput>;

export const AssignStorefrontGovernanceInput = z.strictObject({
  internalStorefrontId: InternalStorefrontId,
  participantId: MarketplaceParticipantId,
  role: StorefrontGovernanceRole,

  actingAccountId: ActingAccountId,
  now: z.iso.datetime(),
});
export type AssignStorefrontGovernanceInput = z.infer<typeof AssignStorefrontGovernanceInput>;

export const SetGovernanceAssignmentStatusInput = z.strictObject({
  internalStorefrontId: InternalStorefrontId,
  participantId: MarketplaceParticipantId,
  status: StoredGovernanceAssignmentStatus,

  actingAccountId: ActingAccountId,
  now: z.iso.datetime(),
});
export type SetGovernanceAssignmentStatusInput = z.infer<
  typeof SetGovernanceAssignmentStatusInput
>;

// — Privacy —

/**
 * Field names that must never appear on a persisted Storefront record.
 *
 * Every schema above is a `strictObject`, so an unknown key already fails. This
 * list makes the intent explicit and gives a test something to enumerate — the
 * same belt-and-braces pattern the participant and Listing models use, and
 * equally not the primary control.
 *
 * `approvedForGoLive` and friends are here for a different reason from the
 * others: not because they are private, but because storing Monacado's approval
 * on the Storefront would break the boundary 0M.3A drew.
 */
export const NEVER_ON_STOREFRONT_RECORD = [
  // Approval belongs to the approver, not the approved thing
  "approvedForGoLive",
  "goLiveApproved",
  "approvalState",
  "isLive",
  // Credentials and private identity
  "accountId",
  "email",
  "passwordHash",
  "sessionToken",
  "participantProfile",
  "legalName",
  "address",
  "taxId",
  // Payment, risk, underwriting
  "paymentProviderToken",
  "stripeAccountId",
  "payoutCredentials",
  "underwritingData",
  "riskScore",
  "riskClassification",
  "taxEvidence",
  // Governance-as-content and moderation
  "moderationNotes",
  // Capsule / publication machinery
  "capsuleId",
  "nodeId",
  "bindsToNode",
  "publicationState",
  "contentHash",
] as const;

/** Named as deferred, and not admissible through a metadata bag. */
export const DEFERRED_STOREFRONT_PERSISTENCE_EXTENSIONS = [
  "storefrontNode",
  "nodeIssuance",
  "publicationState",
  "outbox",
  "receipt",
  "listings",
  "offerPersistence",
  "listingPersistence",
  "goLiveApprovalWorkflow",
  "paymentOnboarding",
  "riskPolicy",
] as const;
