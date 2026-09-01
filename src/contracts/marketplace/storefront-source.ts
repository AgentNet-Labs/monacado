/**
 * Authoritative Storefront source model (Phase 0M.3A).
 *
 * The **authoritative transactional record** for a marketplace storefront, plus
 * the immutable source versions a later Capsule Projection Shape will be
 * generated *from*. Business truth, not a published artifact.
 *
 * Five properties shape everything below:
 *
 *   1. **The database is the sole source of truth** (ADR §12). Every field here
 *      is authoritative; a capsule never supplies, repairs, or overrides it, and
 *      every business change is recorded before any projection occurs.
 *
 *   2. **One owner, and no role recorded on the Storefront.** It belongs to one
 *      MarketplaceParticipant — individual or organization. Marketplace roles
 *      (SELLER/PROMOTER) are the *owner's* commercial capabilities; governance
 *      roles (SUPER_OWNER/ADMIN) are the authority of *humans acting for* that
 *      owner. Administrative authority never makes a member a co-owner.
 *
 *   3. **A Storefront holds no Listings.** There is no Product, Offer, or
 *      Listing array here. Listings will reference Storefronts, not the reverse
 *      — an embedded array would make every listing change a Storefront change,
 *      and therefore a new Storefront source version.
 *
 *   4. **Lifecycle and visibility are separate axes.** Whether a Storefront is
 *      running and whether it may be seen are different questions; visibility can
 *      never revive an inactive one.
 *
 *   5. **Category-neutral and closed.** Media, themes, domains, navigation, SEO,
 *      localization, analytics, and plan limits are named as deferred rather than
 *      admitted through a metadata bag. Every schema is strict.
 *
 * No projection machinery: no capsule shape, JSON-LD, ontology term, Node or
 * capsule identity, mapping version, publication state, or Registrar field.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network.
 */

import { z } from "zod";
import { AUTHORIZING_ACTOR_ID_RE, SOURCE_RECORD_ID_RE } from "../capsule/identity";
import { canonicalJsonString } from "../integrity/canonical-json";
import { INTERNAL_STOREFRONT_ID_RE } from "./identity";
import { ACCOUNT_CAPABILITIES, AccountCapability, AccountId, AccountStatus } from "../account/account";
import { CapabilityReasonCode } from "./capability";
import {
  DRAFTING_ROLE_STATUSES,
  MarketplaceParticipantId,
  MarketplaceRoleAssignmentView,
  ParticipantStatus,
  PaymentReadinessStatus,
  permitsDrafting,
} from "./participant";

// — Identity —

/** The Storefront's source-record identity, in the existing `mon:srec:` form. */
export const StorefrontSourceRecordId = z
  .string()
  .regex(SOURCE_RECORD_ID_RE, "storefrontSourceRecordId must be opaque (mon:srec:<opaque>)");
export type StorefrontSourceRecordId = z.infer<typeof StorefrontSourceRecordId>;

/** The enduring internal Storefront identity. Never a Node, capsule, or URL. */
export const InternalStorefrontId = z
  .string()
  .regex(INTERNAL_STOREFRONT_ID_RE, "internalStorefrontId must be opaque (mon:storefront:<opaque>)");
export type InternalStorefrontId = z.infer<typeof InternalStorefrontId>;

/**
 * Who performed the authorized source action — the **resolved acting account**
 * (Phase 1.18), or a historical `mon:actor:` value on a row written before it.
 *
 * Derived, never supplied. It used to be a caller input beside the acting
 * account id, which made the audit trail forgeable and independently settable:
 * a caller could name any actor for an operation authorized against a different
 * identity. `AUTHORIZING_ACTOR_ID_RE` carries the full reasoning.
 *
 * Opaque by construction — an email, display name, or other private profile
 * datum must never be recorded here, and matches neither form.
 */
export const AuthorizingActorId = z
  .string()
  .regex(
    AUTHORIZING_ACTOR_ID_RE,
    "authorizedByActorId must be opaque (mon:acct:<opaque>, or a historical mon:actor:<opaque>)",
  );
export type AuthorizingActorId = z.infer<typeof AuthorizingActorId>;

/** A source-version label, in the existing bounded-string form. */
export const StorefrontSourceRecordVersion = z.string().min(1).max(64);
export type StorefrontSourceRecordVersion = z.infer<typeof StorefrontSourceRecordVersion>;

// — Public handle —

export const MIN_PUBLIC_HANDLE_LENGTH = 3;
export const MAX_PUBLIC_HANDLE_LENGTH = 63;

/**
 * The storefront's routing name — **not** its identity.
 *
 * Lowercase ASCII letters, digits, and single interior hyphens. The pattern is
 * written as segments (`a1-b2-c3`) rather than a character class plus separate
 * hyphen rules, so a leading hyphen, a trailing hyphen, and a `--` run are all
 * refused by the same expression instead of three checks someone could get out
 * of step.
 *
 * Case is fixed at lowercase because a handle that differed only in case from
 * another would be a different handle to a database and the same one to a person.
 * **Uniqueness is a persistence concern**, not a shape constraint.
 */
export const PUBLIC_HANDLE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const PublicHandle = z
  .string()
  .min(MIN_PUBLIC_HANDLE_LENGTH)
  .max(MAX_PUBLIC_HANDLE_LENGTH)
  .regex(
    PUBLIC_HANDLE_RE,
    "handle must be lowercase letters, digits, and single interior hyphens",
  );
export type PublicHandle = z.infer<typeof PublicHandle>;

// — Ownership —

/**
 * The marketplace roles that permit owning a Storefront **at all**.
 *
 * These are **commercial capabilities of the owning participant**, not of any
 * human acting for it, and not a classification of the Storefront. Holding
 * either qualifies; holding both qualifies once. `BUYER` and `INTERNAL_OPERATOR`
 * are absent by construction: buying is not retailing, and an internal
 * entitlement is not a marketplace role (0M.1 §1).
 *
 * **No role is recorded on the Storefront.** A Storefront belongs to a
 * participant, full stop — no Seller-basis or Promoter-basis mode, no
 * content-mode enum, no permitted-listing-type flags. What may be placed in it is
 * decided **per Listing**, against the roles the owner holds *at that moment*.
 */
export const STOREFRONT_CAPABLE_ROLES = ["SELLER", "PROMOTER"] as const;
export type StorefrontCapableRole = (typeof STOREFRONT_CAPABLE_ROLES)[number];

/**
 * What kind of thing the owning participant is.
 *
 * Recorded here as a **decision input**, supplied by the caller — this phase does
 * not implement the participant-kind model or any organization/membership
 * persistence. It exists because an organization-owned Storefront is administered
 * by *members*, and a decision that could not tell the two cases apart would have
 * to guess. `null` means "not resolved", which is honest and is never treated as
 * `INDIVIDUAL`.
 */
export const PARTICIPANT_KINDS = ["INDIVIDUAL", "ORGANIZATION"] as const;
export const ParticipantKind = z.enum(PARTICIPANT_KINDS);
export type ParticipantKind = z.infer<typeof ParticipantKind>;

// — Storefront governance —

/**
 * Governance roles describe the authority of a **human account acting for the
 * owner**. They are a different axis from `SELLER`/`PROMOTER`, which describe the
 * owning participant's commercial capabilities.
 *
 * **Administrative authority does not make anyone a co-owner.** An organization
 * member with `ADMIN` administers a Storefront the organization owns; ownership
 * stays with the one participant.
 */
export const STOREFRONT_GOVERNANCE_ROLES = ["SUPER_OWNER", "ADMIN"] as const;
export const StorefrontGovernanceRole = z.enum(STOREFRONT_GOVERNANCE_ROLES);
export type StorefrontGovernanceRole = z.infer<typeof StorefrontGovernanceRole>;

/** The governance role an actor holds for a Storefront, including holding none. */
export const ACTOR_GOVERNANCE_ROLES = ["SUPER_OWNER", "ADMIN", "NONE"] as const;
export const ActorGovernanceRole = z.enum(ACTOR_GOVERNANCE_ROLES);
export type ActorGovernanceRole = z.infer<typeof ActorGovernanceRole>;

/**
 * The lifecycle of one governance assignment.
 *
 * `NONE` is the absence of an assignment, distinct from a `REVOKED` one: "never
 * appointed" and "appointed and removed" are different facts, and an audit trail
 * that conflated them could not answer who used to hold authority.
 */
export const GOVERNANCE_ASSIGNMENT_STATUSES = [
  "NONE",
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
] as const;
export const GovernanceAssignmentStatus = z.enum(GOVERNANCE_ASSIGNMENT_STATUSES);
export type GovernanceAssignmentStatus = z.infer<typeof GovernanceAssignmentStatus>;

/**
 * What `SUPER_OWNER` alone may do — the exclusivity list.
 *
 * One active `SUPER_OWNER` is required before a Storefront may go live. They are
 * the ultimate human administrator and the responsible party for underwriting,
 * refunds, chargebacks, disputes, and payouts. **`ADMIN` never acquires these by
 * virtue of being `ADMIN`.**
 *
 * Recorded as data so the boundary is inspectable and testable rather than only
 * described in prose. None of these operations is implemented in this phase.
 */
export const SUPER_OWNER_EXCLUSIVE_AUTHORITIES = [
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
] as const;

/**
 * What `ADMIN` may do operationally — and `SUPER_OWNER` may do too, since
 * `SUPER_OWNER` inherits every `ADMIN` permission.
 *
 * The item-management entries are **future Listing-level permissions**, recorded
 * as a boundary. No Listing operation exists in this phase.
 */
export const ADMIN_OPERATIONAL_AUTHORITIES = [
  "storefront:presentation:edit",
  "storefront:listings:add",
  "storefront:listings:remove",
  "listing:price:seller-controlled:set",
  "listing:price:promoted:select",
] as const;

/** `SUPER_OWNER` inherits every `ADMIN` operational permission. */
export function governanceRoleGrantsOperationalAuthority(role: ActorGovernanceRole): boolean {
  return role === "SUPER_OWNER" || role === "ADMIN";
}

export function isSuperOwnerExclusive(authority: string): boolean {
  return (SUPER_OWNER_EXCLUSIVE_AUTHORITIES as readonly string[]).includes(authority);
}

// — Monacado go-live approval —

/**
 * Monacado's **resolved internal determination** that a Storefront satisfies every
 * go-live requirement — payment-provider approval, required profile information
 * received and reviewed, owner and Account neither suspended nor revoked, and the
 * remaining launch checks.
 *
 * It is **supplied to decisions and derived by nothing here.** It is not a
 * Storefront source field, is never public, and is never projection-eligible: it
 * is Monacado's opinion about a participant, not a fact about a shop.
 */
export const GO_LIVE_APPROVAL_STATUSES = ["APPROVED", "NOT_APPROVED"] as const;
export const StorefrontGoLiveApprovalStatus = z.enum(GO_LIVE_APPROVAL_STATUSES);
export type StorefrontGoLiveApprovalStatus = z.infer<typeof StorefrontGoLiveApprovalStatus>;

/**
 * How many **active `SUPER_OWNER` assignments** this Storefront has — the
 * resolved result of governance-assignment records that live outside this
 * contract.
 *
 * A bounded count rather than a boolean, because "appointed" collapses two very
 * different failures into one. `MULTIPLE` is not a safer `EXACTLY_ONE`: two people
 * each believing they hold final financial responsibility is a governance defect,
 * and going live under it would bake the ambiguity into a live shop.
 *
 * **An actor holding the SUPER_OWNER assignment does not prove no other one
 * exists.** The actor's own assignment and the population count are separate
 * facts, checked separately.
 */
export const SUPER_OWNER_CARDINALITIES = ["NONE", "EXACTLY_ONE", "MULTIPLE"] as const;
export const SuperOwnerCardinality = z.enum(SUPER_OWNER_CARDINALITIES);
export type SuperOwnerCardinality = z.infer<typeof SuperOwnerCardinality>;

/**
 * **Offer economics, Listing flow-through, and notice obligations live in the
 * documentation, not here.**
 *
 * The wholesale-plus-commission model, the promoter-earnings relationship, the
 * availability / wholesale-price / commission notice rules, and admin-panel notice
 * deduplication are binding requirements for future phases — recorded in
 * `docs/AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` and scheduled in the roadmap as
 * 0M.2C (Offer economics correction), the authoritative Listing phase, and the
 * notification phase.
 *
 * They are deliberately **not implemented in this module**. A Storefront source
 * model that carried Offer commission methods or Listing price-review states
 * would be claiming ownership of two domains it does not own, and the constants
 * would be the first thing a future phase had to reconcile against its own.
 */

// — Lifecycle —

export const STOREFRONT_LIFECYCLE_STATES = ["DRAFT", "ACTIVE", "SUSPENDED", "CLOSED"] as const;
export const StorefrontLifecycleState = z.enum(STOREFRONT_LIFECYCLE_STATES);
export type StorefrontLifecycleState = z.infer<typeof StorefrontLifecycleState>;

/**
 * Permitted transitions. `CLOSED` is terminal: reopening is a new Storefront
 * decision with its own record, not a state change that quietly restores a public
 * presence buyers already saw close.
 */
export const STOREFRONT_LIFECYCLE_TRANSITIONS: Record<
  StorefrontLifecycleState,
  readonly StorefrontLifecycleState[]
> = Object.freeze({
  DRAFT: ["ACTIVE", "CLOSED"],
  ACTIVE: ["SUSPENDED", "CLOSED"],
  SUSPENDED: ["ACTIVE", "CLOSED"],
  CLOSED: [],
});

/** The only state a Storefront may be created in. */
export const INITIAL_STOREFRONT_LIFECYCLE_STATE: StorefrontLifecycleState = "DRAFT";

export function isValidStorefrontLifecycleTransition(
  from: StorefrontLifecycleState,
  to: StorefrontLifecycleState,
): boolean {
  return STOREFRONT_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function isTerminalStorefrontLifecycleState(state: StorefrontLifecycleState): boolean {
  return STOREFRONT_LIFECYCLE_TRANSITIONS[state].length === 0;
}

// — Visibility —

/**
 * Who may find and reach the Storefront, for a Storefront that is otherwise
 * running.
 *
 * **Not publication state and not Node state.** A storefront can be `PUBLIC` and
 * unpublished, or published and later set `PRIVATE`; the two axes answer
 * different questions and are deliberately unable to express each other.
 */
export const STOREFRONT_VISIBILITY_STATES = ["PRIVATE", "UNLISTED", "PUBLIC"] as const;
export const StorefrontVisibility = z.enum(STOREFRONT_VISIBILITY_STATES);
export type StorefrontVisibility = z.infer<typeof StorefrontVisibility>;

/**
 * The three facts that decide whether the public can see a Storefront.
 *
 * Approval is one of them. **There is deliberately only one definition of public
 * access**: a helper that answered "accessible" while Monacado had withdrawn
 * approval would be a second, contradictory truth, and the one a UI would reach
 * for first.
 */
export interface StorefrontExposure {
  lifecycle: StorefrontLifecycleState;
  visibility: StorefrontVisibility;
  goLiveApproval: StorefrontGoLiveApprovalStatus;
}

/**
 * **Configured visibility intent** — what the owner has asked for, ignoring
 * whether Monacado permits it.
 *
 * Named to say exactly that. It answers "what did they set", never "what can the
 * public reach", and must not be used to decide access.
 */
export function visibilityIntentPermitsPublicAccess(visibility: StorefrontVisibility): boolean {
  return visibility === "PUBLIC" || visibility === "UNLISTED";
}

/**
 * Reachable by someone holding the address: `ACTIVE`, visibility permits it, and
 * Monacado's go-live approval stands.
 *
 * **Approval revocation makes this false immediately** — before any governed
 * workflow gets round to recording `PRIVATE`. Waiting for a persistence step
 * would leave a withdrawn storefront publicly reachable in the meantime.
 */
export function isPubliclyAccessible(state: StorefrontExposure): boolean {
  return (
    state.lifecycle === "ACTIVE" &&
    visibilityIntentPermitsPublicAccess(state.visibility) &&
    state.goLiveApproval === "APPROVED"
  );
}

/**
 * Listed in discovery — search, directories, browse.
 *
 * `PUBLIC` only, and approved. `UNLISTED` is the reachable-but-not-listed case,
 * which is why accessibility and discoverability are two functions rather than
 * one flag.
 */
export function isDiscoverable(state: StorefrontExposure): boolean {
  return state.visibility === "PUBLIC" && isPubliclyAccessible(state);
}

/**
 * Operationally **live**: `ACTIVE`, publicly reachable, and approved.
 *
 * Derived from three facts and **never stored** — there is deliberately no
 * `isLive` field. A stored boolean would be a fourth thing to keep in agreement
 * with the three, and the first to go stale when approval was revoked.
 *
 * `PRIVATE` therefore means **paused**: the shop exists and is not reachable.
 */
export function isStorefrontLive(state: StorefrontExposure): boolean {
  return isPubliclyAccessible(state);
}

/**
 * How exposed each visibility is, so "more" and "less" are comparable rather than
 * a hand-written table of six pairs.
 */
export const VISIBILITY_EXPOSURE_RANK: Record<StorefrontVisibility, number> = Object.freeze({
  PRIVATE: 0,
  UNLISTED: 1,
  PUBLIC: 2,
});

export function isExposureIncrease(
  from: StorefrontVisibility,
  to: StorefrontVisibility,
): boolean {
  return VISIBILITY_EXPOSURE_RANK[to] > VISIBILITY_EXPOSURE_RANK[from];
}

export function isExposureReduction(
  from: StorefrontVisibility,
  to: StorefrontVisibility,
): boolean {
  return VISIBILITY_EXPOSURE_RANK[to] < VISIBILITY_EXPOSURE_RANK[from];
}

// — Presentation —

export const MAX_DISPLAY_NAME_LENGTH = 120;
export const MAX_TAGLINE_LENGTH = 200;
export const MAX_SUMMARY_LENGTH = 2_000;

/**
 * The bounded public-facing text a Storefront carries.
 *
 * `tagline` and `summary` are **nullable, not optional**: an absent value has
 * exactly one representation (`null`), so an omitted key and an explicit null
 * cannot become two authoritative snapshots of the same Storefront — which would
 * be a spurious material change and a spurious source version.
 *
 * Text only. Media, themes, custom CSS, and scripts are deferred (§ deferred
 * extensions) and cannot arrive here.
 */
export const StorefrontPresentation = z.strictObject({
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  tagline: z.string().trim().min(1).max(MAX_TAGLINE_LENGTH).nullable(),
  summary: z.string().trim().min(1).max(MAX_SUMMARY_LENGTH).nullable(),
});
export type StorefrontPresentation = z.infer<typeof StorefrontPresentation>;

// — The authoritative current record —

/**
 * The current authoritative truth about one Storefront.
 *
 * There is **no field** for a Listing, Product, or Offer array; media, themes,
 * domains, navigation, SEO, localization, social links, analytics, plan limits,
 * moderation notes, publication state, Node or capsule identity, retention state,
 * or a metadata bag.
 */
export const StorefrontSourceRecord = z.strictObject({
  // Identity
  storefrontSourceRecordId: StorefrontSourceRecordId,
  internalStorefrontId: InternalStorefrontId,
  /** The latest immutable source version; the pointer into version history. */
  currentSourceRecordVersion: StorefrontSourceRecordVersion,

  /**
   * The participant that owns this Storefront — the whole of ownership. No role
   * basis accompanies it, because ownership is not role-shaped.
   */
  ownerParticipantId: MarketplaceParticipantId,

  // Source-system identity (the existing convention)
  sourceSystem: z.literal("monacado"),
  sourceRecordType: z.literal("Storefront"),
  sourceClass: z.literal("governed-database-record"),

  // Business state
  lifecycle: StorefrontLifecycleState,
  visibility: StorefrontVisibility,
  publicHandle: PublicHandle,
  presentation: StorefrontPresentation,

  // Record control — explicit instants, never read from a clock here
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontSourceRecord = z.infer<typeof StorefrontSourceRecord>;

// — The immutable source version —

/**
 * One complete, immutable snapshot of a Storefront's material business state.
 *
 * A snapshot, not a delta: a version that had to be replayed through its
 * predecessors to be understood would make reconstruction depend on an unbroken
 * chain, and one missing link would lose every version after it (Phase 0A.2 §4).
 */
export const StorefrontSourceVersion = z.strictObject({
  // Identity and lineage
  storefrontSourceRecordId: StorefrontSourceRecordId,
  sourceRecordVersion: StorefrontSourceRecordVersion,
  /** The version this one replaces; `null` for the first. */
  supersedesSourceRecordVersion: StorefrontSourceRecordVersion.nullable(),
  internalStorefrontId: InternalStorefrontId,

  // Source-system identity
  sourceSystem: z.literal("monacado"),
  sourceRecordType: z.literal("Storefront"),
  sourceClass: z.literal("governed-database-record"),

  // The complete material snapshot
  ownerParticipantId: MarketplaceParticipantId,
  lifecycle: StorefrontLifecycleState,
  visibility: StorefrontVisibility,
  publicHandle: PublicHandle,
  presentation: StorefrontPresentation,

  // Authorization trace
  authorizedByParticipantId: MarketplaceParticipantId,
  authorizedByActorId: AuthorizingActorId,
  recordedAt: z.iso.datetime(),
});
export type StorefrontSourceVersion = z.infer<typeof StorefrontSourceVersion>;

// — Material versus operational change classification —

/**
 * The fields whose change **is** a change in Storefront truth.
 *
 * **Role grants and revocations are not here.** They are participant facts, not
 * Storefront facts: granting a participant PROMOTER changes what they may place
 * in their Storefront, and changes nothing about the Storefront itself. Minting a
 * Storefront source version for a role change would attribute a participant event
 * to every Storefront they own.
 *
 * Future Listing membership changes are likewise absent — Listings reference
 * Storefronts, not the reverse.
 */
export const MATERIAL_STOREFRONT_FIELDS = [
  "ownerParticipantId",
  "lifecycle",
  "visibility",
  "publicHandle",
  "displayName",
  "tagline",
  "summary",
] as const;
export const MaterialStorefrontField = z.enum(MATERIAL_STOREFRONT_FIELDS);
export type MaterialStorefrontField = z.infer<typeof MaterialStorefrontField>;

/**
 * Changes that are **operational, not truth**.
 *
 * A view counter moving does not mean the storefront changed. Minting a semantic
 * version for one would fill history with events that assert nothing — and for a
 * counter that ticks on every page view, would fill it very fast.
 */
export const OPERATIONAL_ONLY_STOREFRONT_FIELDS = [
  "viewCount",
  "clickCount",
  "listingCount",
  "cacheState",
  "publicationRetryState",
  "workerLeaseState",
  "receiptProcessingState",
  "archiveLocation",
  "monitoringCounters",
  "lastReadAt",
] as const;
export const OperationalOnlyStorefrontField = z.enum(OPERATIONAL_ONLY_STOREFRONT_FIELDS);
export type OperationalOnlyStorefrontField = z.infer<typeof OperationalOnlyStorefrontField>;

/** A closed change vocabulary — an unrecognised field name is a failure, not a guess. */
export const StorefrontChangeField = z.union([
  MaterialStorefrontField,
  OperationalOnlyStorefrontField,
]);
export type StorefrontChangeField = z.infer<typeof StorefrontChangeField>;

export const StorefrontChangeSet = z
  .array(StorefrontChangeField)
  .max(MATERIAL_STOREFRONT_FIELDS.length + OPERATIONAL_ONLY_STOREFRONT_FIELDS.length);

export const StorefrontChangeClassification = z.strictObject({
  requiresNewSourceVersion: z.boolean(),
  materialFields: z.array(MaterialStorefrontField),
  operationalFields: z.array(OperationalOnlyStorefrontField),
});
export type StorefrontChangeClassification = z.infer<typeof StorefrontChangeClassification>;

export function classifyStorefrontChange(
  changedFields: readonly string[],
): StorefrontChangeClassification {
  const parsed = StorefrontChangeSet.parse(changedFields);
  const materialFields = parsed.filter(
    (f): f is MaterialStorefrontField => MaterialStorefrontField.safeParse(f).success,
  );
  const operationalFields = parsed.filter(
    (f): f is OperationalOnlyStorefrontField =>
      OperationalOnlyStorefrontField.safeParse(f).success,
  );
  return {
    requiresNewSourceVersion: materialFields.length > 0,
    materialFields,
    operationalFields,
  };
}

type StorefrontMaterialState = Pick<
  StorefrontSourceRecord,
  "ownerParticipantId" | "lifecycle" | "visibility" | "publicHandle" | "presentation"
>;

/**
 * Which material fields actually differ between two Storefront states.
 *
 * Presentation is reported field by field — a display-name change and a summary
 * change are different business events, even though both live under
 * `presentation`.
 */
export function materialChangesBetween(
  prior: StorefrontMaterialState,
  next: StorefrontMaterialState,
): MaterialStorefrontField[] {
  const changed: MaterialStorefrontField[] = [];
  const differs = (a: unknown, b: unknown) => canonicalJsonString(a) !== canonicalJsonString(b);

  if (prior.ownerParticipantId !== next.ownerParticipantId) changed.push("ownerParticipantId");
  if (prior.lifecycle !== next.lifecycle) changed.push("lifecycle");
  if (prior.visibility !== next.visibility) changed.push("visibility");
  if (prior.publicHandle !== next.publicHandle) changed.push("publicHandle");
  if (differs(prior.presentation.displayName, next.presentation.displayName)) {
    changed.push("displayName");
  }
  if (differs(prior.presentation.tagline, next.presentation.tagline)) changed.push("tagline");
  if (differs(prior.presentation.summary, next.presentation.summary)) changed.push("summary");
  return changed;
}

// — Projection eligibility (classification only) —

/**
 * Authoritative facts a **later** projection may draw on.
 *
 * The Storefront's own identity and its owner reach a capsule only through
 * Registrar-issued Node bindings decided in a later phase; the public URL is
 * derived from `publicHandle` rather than published as an internal field.
 */
export const PROJECTION_ELIGIBLE_STOREFRONT_FIELDS = [
  "internalStorefrontId",
  "ownerParticipantId",
  "publicHandle",
  "displayName",
  "tagline",
  "summary",
  "lifecycle",
  "visibility",
] as const;

/**
 * Never projection-eligible, in any phase.
 *
 * Every **governance** fact is here. Who administers a storefront is nobody's
 * business but the marketplace's: a public capsule naming its `SUPER_OWNER`
 * would publish an organization's internal structure as a side effect of listing
 * a shop.
 */
export const NEVER_PROJECTION_ELIGIBLE_STOREFRONT_DATA = [
  "rawOwnerParticipantId",
  "accountId",
  "roleAssignmentId",
  "superOwnerAccountId",
  "adminAccountIds",
  "organizationMembershipId",
  "governanceAssignment",
  "underwritingData",
  "internalAuthorizationEvidence",
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
] as const;

export function isProjectionEligibleStorefrontField(field: string): boolean {
  return (PROJECTION_ELIGIBLE_STOREFRONT_FIELDS as readonly string[]).includes(field);
}

export function isNeverProjectionEligibleStorefrontData(field: string): boolean {
  return (NEVER_PROJECTION_ELIGIBLE_STOREFRONT_DATA as readonly string[]).includes(field);
}

// — Deferred extensions —

/** Named as deferred, and not admissible through a metadata bag. */
export const DEFERRED_STOREFRONT_EXTENSIONS = [
  "capsuleProjection",
  "listings",
  "listingOrdering",
  "productPlacement",
  "offerPlacement",
  "merchandisingGroups",
  "collections",
  "logo",
  "heroImage",
  "mediaAssets",
  "designTemplate",
  "theme",
  "customization",
  "customDomain",
  "navigation",
  "seoConfiguration",
  "localization",
  "socialLinks",
  "paidPlacement",
  "planLimits",
  "moderationWorkflow",
  "analytics",
  "customCss",
  "customScripts",
] as const;

// — Authority decisions —

/**
 * Capabilities over one Storefront **record**.
 *
 * Distinct strings from the Phase 0M.1 participant-level capabilities
 * (`storefront:draft:create`, `storefront:activate`), which answer "may this
 * participant work with storefronts at all". These answer "may this actor do this
 * to this Storefront", and an audit trail must be able to tell them apart.
 */
export const STOREFRONT_CAPABILITIES = [
  "storefront:record:create",
  "storefront:presentation:edit",
  "storefront:record:activate",
  "storefront:record:resume",
  "storefront:visibility:increase",
  "storefront:visibility:reduce",
  "storefront:record:suspend",
  "storefront:record:close",
] as const;
export const StorefrontCapability = z.enum(STOREFRONT_CAPABILITIES);
export type StorefrontCapability = z.infer<typeof StorefrontCapability>;

/** Storefront-specific reasons, composed with the Phase 0M.1 vocabulary. */
export const STOREFRONT_SPECIFIC_REASON_CODES = [
  /** The acting Account is not authorized to act for the owner participant. */
  "ACTOR_NOT_AUTHORIZED_FOR_OWNER",
  /** The actor holds no governance assignment for this Storefront. */
  "GOVERNANCE_ASSIGNMENT_REQUIRED",
  /** The assignment exists but is not active. */
  "GOVERNANCE_ASSIGNMENT_NOT_ACTIVE",
  /** The assignment names a different Storefront. */
  "GOVERNANCE_ASSIGNMENT_STOREFRONT_MISMATCH",
  /** The action is reserved to the active SUPER_OWNER. */
  "SUPER_OWNER_REQUIRED",
  /** No active SUPER_OWNER is appointed for this Storefront. */
  "ACTIVE_SUPER_OWNER_NOT_APPOINTED",
  /** More than one active SUPER_OWNER exists; exactly one is required. */
  "MULTIPLE_ACTIVE_SUPER_OWNERS",
  /**
   * The resolved governance facts contradict each other — the actor is presented
   * as holding an active SUPER_OWNER assignment for this Storefront while the
   * resolved cardinality says none exists.
   */
  "INCONSISTENT_SUPER_OWNER_STATE",
  /** Monacado has not resolved this Storefront as approved to go live. */
  "GO_LIVE_NOT_APPROVED",
  /** The lifecycle move this capability implies is not a permitted transition. */
  "STOREFRONT_LIFECYCLE_TRANSITION_NOT_PERMITTED",
  /** The Storefront is closed; nothing further may be authorized. */
  "STOREFRONT_CLOSED",
  /** The Storefront is not publicly accessible, so there is nothing to withdraw. */
  "STOREFRONT_NOT_PUBLICLY_ACCESSIBLE",
  /** The Storefront must be ACTIVE before its exposure can be increased. */
  "STOREFRONT_NOT_ACTIVE",
  /** The requested visibility is the one already in effect. */
  "VISIBILITY_UNCHANGED",
  /** The requested change moves exposure the other way. */
  "VISIBILITY_CHANGE_DIRECTION_MISMATCH",
] as const;
export const StorefrontSpecificReasonCode = z.enum(STOREFRONT_SPECIFIC_REASON_CODES);

export const StorefrontReasonCode = z.union([CapabilityReasonCode, StorefrontSpecificReasonCode]);
export type StorefrontReasonCode = z.infer<typeof StorefrontReasonCode>;

export const StorefrontAuthorityDecision = z
  .strictObject({
    capability: StorefrontCapability,
    decision: z.enum(["ALLOW", "DENY"]),
    reasonCodes: z.array(StorefrontReasonCode).max(12),
  })
  .refine(
    (d) => (d.decision === "ALLOW" ? d.reasonCodes.length === 0 : d.reasonCodes.length > 0),
    "ALLOW carries no reason codes; DENY carries at least one",
  );
export type StorefrontAuthorityDecision = z.infer<typeof StorefrontAuthorityDecision>;

function allow(capability: StorefrontCapability): StorefrontAuthorityDecision {
  return { capability, decision: "ALLOW", reasonCodes: [] };
}

function deny(
  capability: StorefrontCapability,
  ...reasonCodes: StorefrontReasonCode[]
): StorefrontAuthorityDecision {
  return { capability, decision: "DENY", reasonCodes };
}

export function isStorefrontActionAllowed(decision: StorefrontAuthorityDecision): boolean {
  return decision.decision === "ALLOW";
}

// — Decision inputs: owner facts and actor facts, kept apart —

/**
 * Resolved facts about the **owning participant**.
 *
 * These are commercial facts about the owner — never about the human acting. An
 * organization's Seller role belongs to the organization; the member clicking the
 * button need not hold it personally, and this separation is what makes that
 * expressible.
 */
export const StorefrontOwnerFacts = z.strictObject({
  ownerParticipantId: MarketplaceParticipantId,
  /** `null` when unresolved — never silently treated as INDIVIDUAL. */
  ownerKind: ParticipantKind.nullable(),
  participantStatus: ParticipantStatus,
  /** The owner's marketplace role assignments. */
  roles: z.array(MarketplaceRoleAssignmentView).max(3),
  paymentReadiness: PaymentReadinessStatus,
});
export type StorefrontOwnerFacts = z.infer<typeof StorefrontOwnerFacts>;

/**
 * Resolved facts about the **acting human account**.
 *
 * `authorizedForOwnerParticipant` means "this account may act for the owner": for
 * an individual owner, that it is their account; for an organization owner, that
 * it is a member authorized to act. **It must never be inferred from an email
 * domain, a display name, or any private profile datum** — there is deliberately
 * no field here that could carry one.
 *
 * It stays a supplied *input to this pure decision*, exactly as
 * `hasProductAuthority` does for an Offer, and for the same reason: the decision
 * weighs facts rather than fetching them. What changed in Phase 1.18 is its
 * **provenance** one layer out. `resolveAuthorizationFacts` now derives it from
 * authoritative records — self-ownership, or an ACTIVE
 * `StorefrontGovernanceAssignment` — where it used to arrive on the service
 * input beside a caller-named actor participant, so anyone knowing one opaque id
 * could act as its holder. The organization case remains genuinely underivable
 * for want of a membership model, and therefore fails closed.
 */
export const StorefrontActorFacts = z.strictObject({
  accountId: AccountId,
  accountStatus: AccountStatus,
  authorizedForOwnerParticipant: z.boolean(),
  governanceRole: ActorGovernanceRole,
  governanceAssignmentStatus: GovernanceAssignmentStatus,
  /** The Storefront the assignment names; `null` when there is no assignment. */
  assignmentStorefrontId: InternalStorefrontId.nullable(),
  /**
   * Internal operator capabilities. Present so they can be shown to grant
   * nothing: every decision below ignores this field.
   */
  internalCapabilities: z.array(AccountCapability).max(ACCOUNT_CAPABILITIES.length),
});
export type StorefrontActorFacts = z.infer<typeof StorefrontActorFacts>;

/** Creating a Storefront: no Storefront exists yet, so no assignment can name one. */
export const CreateStorefrontRequest = z.strictObject({
  owner: StorefrontOwnerFacts,
  actor: StorefrontActorFacts,
});
export type CreateStorefrontRequest = z.infer<typeof CreateStorefrontRequest>;

/** Acting on a Storefront that exists, and therefore has a state. */
export const StorefrontRecordActionRequest = z.strictObject({
  owner: StorefrontOwnerFacts,
  actor: StorefrontActorFacts,
  storefrontId: InternalStorefrontId,
  lifecycle: StorefrontLifecycleState,
  visibility: StorefrontVisibility,
  /**
   * How many active SUPER_OWNER assignments this Storefront has. Supplied,
   * because it is a fact about the *governance records*, which live outside this
   * contract. Exactly one is required to go live.
   */
  activeSuperOwnerCardinality: SuperOwnerCardinality,
  /**
   * Monacado's resolved go-live determination. Supplied, never derived here, and
   * never stored on the Storefront.
   */
  goLiveApproval: StorefrontGoLiveApprovalStatus,
});
export type StorefrontRecordActionRequest = z.infer<typeof StorefrontRecordActionRequest>;

// — Shared gates —

/** The acting account must exist and be usable, and act for this owner. */
function actorProblem(actor: StorefrontActorFacts): StorefrontReasonCode | undefined {
  if (actor.accountStatus !== "ACTIVE") return "ACCOUNT_DISABLED";
  if (!actor.authorizedForOwnerParticipant) return "ACTOR_NOT_AUTHORIZED_FOR_OWNER";
  return undefined;
}

/**
 * The actor must hold an **active governance assignment naming this Storefront**.
 *
 * Three failures, three codes: no assignment, an assignment that is not active,
 * and an assignment for a different Storefront. An operator reading a denial
 * should not have to guess which.
 */
function governanceProblem(
  actor: StorefrontActorFacts,
  storefrontId: string,
): StorefrontReasonCode | undefined {
  if (actor.governanceRole === "NONE") return "GOVERNANCE_ASSIGNMENT_REQUIRED";
  if (actor.governanceAssignmentStatus !== "ACTIVE") return "GOVERNANCE_ASSIGNMENT_NOT_ACTIVE";
  if (actor.assignmentStorefrontId !== storefrontId) {
    return "GOVERNANCE_ASSIGNMENT_STOREFRONT_MISMATCH";
  }
  return undefined;
}

/** The owner must hold at least one Storefront-capable role in a usable status. */
function ownerRoleProblem(
  owner: StorefrontOwnerFacts,
  requireActive: boolean,
): CapabilityReasonCode | undefined {
  const held = owner.roles.filter((r) =>
    (STOREFRONT_CAPABLE_ROLES as readonly string[]).includes(r.role),
  );
  if (held.length === 0) return "ROLE_NOT_HELD";
  const usable = requireActive
    ? held.some((r) => r.status === "ACTIVE")
    : held.some((r) => (DRAFTING_ROLE_STATUSES as readonly string[]).includes(r.status));
  return usable ? undefined : "ROLE_NOT_ACTIVE";
}

/** The owner must be admitted to the marketplace and payable. */
function ownerCommerceProblem(owner: StorefrontOwnerFacts): StorefrontReasonCode | undefined {
  if (owner.participantStatus !== "ACTIVE") return "PARTICIPANT_NOT_ACTIVATED";
  const roleProblem = ownerRoleProblem(owner, true);
  if (roleProblem) return roleProblem;
  if (owner.paymentReadiness === "RESTRICTED") return "PAYMENT_RESTRICTED";
  if (owner.paymentReadiness !== "ENABLED") return "PAYMENT_NOT_ENABLED";
  return undefined;
}

// — Creation —

/**
 * Creating a Storefront record.
 *
 * Requires an enabled account authorized to act for a qualifying owner. It does
 * **not** require participant `ACTIVE`, payment readiness, or completed
 * underwriting — the thesis's bare-bones account may build a storefront and may
 * not sell from it.
 *
 * No governance assignment is required *here* because none can exist yet: the
 * Storefront being created is what an assignment would name. Designating the
 * initial `SUPER_OWNER` is part of the creation operation, and **activation
 * refuses to proceed without one**.
 */
export function canCreateStorefrontRecord(
  request: CreateStorefrontRequest,
): StorefrontAuthorityDecision {
  const capability = "storefront:record:create" as const;
  const problem = actorProblem(request.actor);
  if (problem) return deny(capability, problem);
  if (!permitsDrafting(request.owner.participantStatus)) {
    return deny(capability, "PARTICIPANT_STATUS_NOT_ELIGIBLE");
  }
  const roleProblem = ownerRoleProblem(request.owner, false);
  if (roleProblem) return deny(capability, roleProblem);
  return allow(capability);
}

// — Presentation —

/**
 * Editing the public presentation text.
 *
 * **Both `ADMIN` and `SUPER_OWNER` may.** Presentation is the operational work
 * an administrator exists to do, and `SUPER_OWNER` inherits every `ADMIN`
 * permission.
 *
 * **Never requires payment readiness or underwriting**, in any lifecycle state.
 * Correcting a misleading summary is exactly what an owner whose payments were
 * just restricted may most need to do; gating it behind a working payment account
 * would be punitive rather than protective. A `CLOSED` Storefront is refused: its
 * presentation is history.
 */
export function canEditStorefrontPresentation(
  request: StorefrontRecordActionRequest,
): StorefrontAuthorityDecision {
  const capability = "storefront:presentation:edit" as const;
  const problem = actorProblem(request.actor);
  if (problem) return deny(capability, problem);
  const governance = governanceProblem(request.actor, request.storefrontId);
  if (governance) return deny(capability, governance);
  if (!governanceRoleGrantsOperationalAuthority(request.actor.governanceRole)) {
    return deny(capability, "GOVERNANCE_ASSIGNMENT_REQUIRED");
  }
  if (request.lifecycle === "CLOSED") return deny(capability, "STOREFRONT_CLOSED");
  return allow(capability);
}

// — SUPER_OWNER-only actions —

/**
 * The shared gate for every action reserved to the active `SUPER_OWNER`.
 *
 * `ADMIN` is refused with `SUPER_OWNER_REQUIRED` rather than a generic
 * governance error, because "you are an administrator, and this is not an
 * administrator's decision" is the useful answer.
 */
function superOwnerProblem(
  request: StorefrontRecordActionRequest,
): StorefrontReasonCode | undefined {
  const problem = actorProblem(request.actor);
  if (problem) return problem;
  const governance = governanceProblem(request.actor, request.storefrontId);
  if (governance) return governance;
  if (request.actor.governanceRole !== "SUPER_OWNER") return "SUPER_OWNER_REQUIRED";
  return undefined;
}

/**
 * Exactly one active SUPER_OWNER, or a reason why not.
 *
 * Checked **independently of** whether the acting party holds the assignment: an
 * actor with SUPER_OWNER authority proves nothing about how many others there are.
 */
function superOwnerCardinalityProblem(
  cardinality: SuperOwnerCardinality,
): StorefrontReasonCode | undefined {
  if (cardinality === "NONE") return "ACTIVE_SUPER_OWNER_NOT_APPOINTED";
  if (cardinality === "MULTIPLE") return "MULTIPLE_ACTIVE_SUPER_OWNERS";
  return undefined;
}

/**
 * The actor's assignment and the resolved cardinality must be **mutually
 * consistent**.
 *
 * An actor presented as holding an active `SUPER_OWNER` assignment bound to this
 * Storefront cannot coexist with a resolved cardinality of `NONE` — that pair of
 * facts describes a storefront that both has and has not got a super owner.
 *
 * The safety-reducing actions have **no cardinality requirement** (a defective
 * multiplicity must never trap a storefront), so `NONE` there carries no policy
 * meaning at all — it is purely a signal that the two facts came from different
 * moments or different sources. **Fail closed and say so**, rather than acting on
 * a snapshot that cannot be true: an emergency platform-operator path is a
 * separate, audited future authority and must not be reachable by feeding
 * contradictory owner-governance facts.
 */
function superOwnerConsistencyProblem(
  request: StorefrontRecordActionRequest,
): StorefrontReasonCode | undefined {
  const actorClaimsActiveSuperOwner =
    request.actor.governanceRole === "SUPER_OWNER" &&
    request.actor.governanceAssignmentStatus === "ACTIVE" &&
    request.actor.assignmentStorefrontId === request.storefrontId;

  return actorClaimsActiveSuperOwner && request.activeSuperOwnerCardinality === "NONE"
    ? "INCONSISTENT_SUPER_OWNER_STATE"
    : undefined;
}

function evaluateLifecycleAction(
  capability: StorefrontCapability,
  request: StorefrontRecordActionRequest,
  target: StorefrontLifecycleState,
  options: { requiresCommerce: boolean },
): StorefrontAuthorityDecision {
  const problem = superOwnerProblem(request);
  if (problem) return deny(capability, problem);
  /* Cardinality is a *going-live* requirement. Suspending or closing must never
     be blocked by a governance defect — those are the actions that make a
     defective storefront safer. */
  if (options.requiresCommerce) {
    const cardinality = superOwnerCardinalityProblem(request.activeSuperOwnerCardinality);
    if (cardinality) return deny(capability, cardinality);
    const commerce = ownerCommerceProblem(request.owner);
    if (commerce) return deny(capability, commerce);
    if (request.goLiveApproval !== "APPROVED") return deny(capability, "GO_LIVE_NOT_APPROVED");
  } else {
    /* Standing down imposes no cardinality requirement — MULTIPLE must never trap
       a storefront — but contradictory facts still fail closed. */
    const inconsistent = superOwnerConsistencyProblem(request);
    if (inconsistent) return deny(capability, inconsistent);
  }
  if (isTerminalStorefrontLifecycleState(request.lifecycle)) {
    return deny(capability, "STOREFRONT_CLOSED");
  }
  if (!isValidStorefrontLifecycleTransition(request.lifecycle, target)) {
    return deny(capability, "STOREFRONT_LIFECYCLE_TRANSITION_NOT_PERMITTED");
  }
  return allow(capability);
}

/**
 * Taking a Storefront live.
 *
 * Requires the active `SUPER_OWNER`, an appointed active `SUPER_OWNER` for the
 * Storefront, the owner admitted and payable, **and explicit underwriting
 * approval**. An `ADMIN` is refused.
 */
export function canActivateStorefrontRecord(
  request: StorefrontRecordActionRequest,
): StorefrontAuthorityDecision {
  return evaluateLifecycleAction("storefront:record:activate", request, "ACTIVE", {
    requiresCommerce: true,
  });
}

/** Resuming a suspended Storefront — live again, so the same gates. */
export function canResumeStorefrontRecord(
  request: StorefrontRecordActionRequest,
): StorefrontAuthorityDecision {
  return evaluateLifecycleAction("storefront:record:resume", request, "ACTIVE", {
    requiresCommerce: true,
  });
}

/**
 * Suspending and closing **stand a Storefront down**, and never require payment
 * readiness or underwriting: an owner who cannot be paid must still be able to
 * stop trading.
 */
export function canSuspendStorefrontRecord(
  request: StorefrontRecordActionRequest,
): StorefrontAuthorityDecision {
  return evaluateLifecycleAction("storefront:record:suspend", request, "SUSPENDED", {
    requiresCommerce: false,
  });
}

export function canCloseStorefrontRecord(
  request: StorefrontRecordActionRequest,
): StorefrontAuthorityDecision {
  return evaluateLifecycleAction("storefront:record:close", request, "CLOSED", {
    requiresCommerce: false,
  });
}

/** A visibility change names where it is going. */
export const StorefrontVisibilityChangeRequest = StorefrontRecordActionRequest.extend({
  targetVisibility: StorefrontVisibility,
});
export type StorefrontVisibilityChangeRequest = z.infer<typeof StorefrontVisibilityChangeRequest>;

/**
 * **Increasing** exposure — `PRIVATE → UNLISTED | PUBLIC`, or
 * `UNLISTED → PUBLIC`.
 *
 * Reserved to the active `SUPER_OWNER`, and gated on Monacado's resolved go-live
 * approval: putting a shop in front of buyers is the moment every launch
 * requirement has to hold.
 *
 * **This decides; it does not act.** No value is mutated here — a pure decision
 * that also changed state would make the answer and the effect impossible to test
 * apart.
 */
export function canIncreaseStorefrontExposure(
  request: StorefrontVisibilityChangeRequest,
): StorefrontAuthorityDecision {
  const capability = "storefront:visibility:increase" as const;
  const problem = superOwnerProblem(request);
  if (problem) return deny(capability, problem);
  const cardinality = superOwnerCardinalityProblem(request.activeSuperOwnerCardinality);
  if (cardinality) return deny(capability, cardinality);
  if (request.lifecycle === "CLOSED") return deny(capability, "STOREFRONT_CLOSED");
  if (request.lifecycle !== "ACTIVE") return deny(capability, "STOREFRONT_NOT_ACTIVE");
  if (request.targetVisibility === request.visibility) {
    return deny(capability, "VISIBILITY_UNCHANGED");
  }
  if (!isExposureIncrease(request.visibility, request.targetVisibility)) {
    return deny(capability, "VISIBILITY_CHANGE_DIRECTION_MISMATCH");
  }
  if (request.goLiveApproval !== "APPROVED") return deny(capability, "GO_LIVE_NOT_APPROVED");
  return allow(capability);
}

/**
 * **Reducing** exposure — `PUBLIC → UNLISTED | PRIVATE`, or
 * `UNLISTED → PRIVATE`. `PRIVATE` is paused.
 *
 * Reserved to the active `SUPER_OWNER`, and **permitted even when approval has
 * been revoked or commercial readiness has failed**. Taking a shop down is the
 * one action that must never be blocked by the conditions that make taking it
 * down necessary.
 *
 * Note the asymmetry with `canIncreaseStorefrontExposure`: **restoring
 * `APPROVED` does not restore visibility.** The `SUPER_OWNER` must explicitly
 * make the Storefront live again, because a shop reappearing on its own is a
 * decision nobody made.
 */
export function canReduceStorefrontExposure(
  request: StorefrontVisibilityChangeRequest,
): StorefrontAuthorityDecision {
  const capability = "storefront:visibility:reduce" as const;
  const problem = superOwnerProblem(request);
  if (problem) return deny(capability, problem);
  const inconsistent = superOwnerConsistencyProblem(request);
  if (inconsistent) return deny(capability, inconsistent);
  if (request.lifecycle === "CLOSED") return deny(capability, "STOREFRONT_CLOSED");
  if (request.targetVisibility === request.visibility) {
    return deny(capability, "VISIBILITY_UNCHANGED");
  }
  if (!isExposureReduction(request.visibility, request.targetVisibility)) {
    return deny(capability, "VISIBILITY_CHANGE_DIRECTION_MISMATCH");
  }
  return allow(capability);
}

// — Deferred Listing-level capabilities —

/**
 * Capabilities that belong to a Listing model that does not exist yet.
 *
 * They return a bounded `DEFERRED` outcome rather than `ALLOW`/`DENY`, because
 * both would be lies: nobody may do these today, and the eventual rule is already
 * decided in outline. A caller that treated a `DENY` as "policy forbids this"
 * would be wrong.
 */
export const DEFERRED_STOREFRONT_CAPABILITIES = [
  "storefront:listings:manage",
  "listing:price:seller-controlled:set",
  "listing:price:promoted:select",
] as const;
export const DeferredStorefrontCapability = z.enum(DEFERRED_STOREFRONT_CAPABILITIES);
export type DeferredStorefrontCapability = z.infer<typeof DeferredStorefrontCapability>;

export const DEFERRAL_REASONS = [
  "LISTING_CONTRACT_NOT_DEFINED",
  "LISTING_PRICING_MODEL_UNRESOLVED",
  "COMMISSION_BASE_UNRESOLVED",
  "SETTLEMENT_ALLOCATION_UNRESOLVED",
] as const;
export const DeferralReason = z.enum(DEFERRAL_REASONS);
export type DeferralReason = z.infer<typeof DeferralReason>;

export const StorefrontDeferredDecision = z.strictObject({
  capability: DeferredStorefrontCapability,
  decision: z.literal("DEFERRED"),
  blockedBy: z.array(DeferralReason).min(1),
  /** Who will be permitted once the blockers are resolved. Documentation, not authority. */
  eventuallyPermittedTo: z.array(StorefrontGovernanceRole).min(1),
});
export type StorefrontDeferredDecision = z.infer<typeof StorefrontDeferredDecision>;

/**
 * Adding and removing Listings will be `ADMIN` and `SUPER_OWNER` work, subject to
 * Storefront authority, Listing lifecycle, Product and Offer authority, promotion
 * eligibility, and marketplace policy.
 *
 * **Removing a Listing must never delete the underlying Product or Offer** — a
 * shop taking something off its shelves does not destroy the item.
 */
export function canManageStorefrontListings(): StorefrontDeferredDecision {
  return {
    capability: "storefront:listings:manage",
    decision: "DEFERRED",
    blockedBy: ["LISTING_CONTRACT_NOT_DEFINED"],
    eventuallyPermittedTo: ["SUPER_OWNER", "ADMIN"],
  };
}

/**
 * Setting the retail price of a **seller-controlled** item — an item the
 * Storefront owner controls as Seller — will be performed under *delegated
 * Seller authority*, not personal authority.
 *
 * The relationship between the Offer's wholesale price, the Listing price, and
 * any Storefront-specific price is unresolved (see the architecture document).
 */
export function canSetSellerControlledListingPrice(): StorefrontDeferredDecision {
  return {
    capability: "listing:price:seller-controlled:set",
    decision: "DEFERRED",
    blockedBy: ["LISTING_CONTRACT_NOT_DEFINED", "LISTING_PRICING_MODEL_UNRESOLVED"],
    eventuallyPermittedTo: ["SUPER_OWNER", "ADMIN"],
  };
}

/**
 * Selecting the retail price of a **promoted** item — one owned by another
 * Seller.
 *
 * The binding rule, recorded now: **the retail price is the Promoter's to set.**
 * The creator controls the wholesale price and the commission, not what a
 * Promoter charges a buyer — a Promoter may price below wholesale by surrendering
 * part of their commission, at wholesale, or above it. Neither `ADMIN` nor
 * `SUPER_OWNER` gains authority to modify the creator's Product, Offer, or
 * commission terms.
 */
export function canSetPromotedListingPrice(): StorefrontDeferredDecision {
  return {
    capability: "listing:price:promoted:select",
    decision: "DEFERRED",
    blockedBy: [
      "LISTING_CONTRACT_NOT_DEFINED",
      "LISTING_PRICING_MODEL_UNRESOLVED",
      "COMMISSION_BASE_UNRESOLVED",
      "SETTLEMENT_ALLOCATION_UNRESOLVED",
    ],
    eventuallyPermittedTo: ["SUPER_OWNER", "ADMIN"],
  };
}
