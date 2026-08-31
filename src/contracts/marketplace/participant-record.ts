/**
 * Persisted marketplace participant records (Phase 0M.5).
 *
 * The record shapes behind the 0M.1 read views. `participant.ts` says what a
 * capability decision may *see*; this module says what is durably *stored*, and
 * the two are deliberately different sizes — the view is narrower, and nothing
 * widens it.
 *
 * Five properties shape everything below:
 *
 *   1. **The database is the sole source of truth** (ADR §12). Every field here
 *      is authoritative transactional state. No capsule supplies, repairs, or
 *      overrides any of it, and this phase projects nothing at all.
 *
 *   2. **Private profile CONTENT has no representation.** `ParticipantProfileRecord`
 *      carries section completion markers and onboarding gates — never a legal
 *      name, address, date of birth, tax id, document, bank detail, provider
 *      identifier, phone number, or moderation note. Phase 0M.1 §9 defers the
 *      field-level contents; storing none of them is the strongest available
 *      privacy guarantee, because a projection cannot leak a field that does not
 *      exist.
 *
 *   3. **Completeness is derived, never stored.** `deriveProfileCompleteness` is
 *      the only answer, on the same reasoning that keeps `isLive` off the
 *      Storefront source model: a stored copy is a second answer that can
 *      disagree with the first. (Phase 0M.1 §9's candidate design listed
 *      `completeness` as a column; this refines it.)
 *
 *   4. **Payment readiness is absent.** There is no payment record, no readiness
 *      field, and no way to express ENABLED in this phase. 0M.8 adds the
 *      provider axis; until then `NOT_STARTED` is true by construction.
 *
 *   5. **The public projection is an allow-list that nothing implements yet.**
 *      `PUBLIC_PARTICIPANT_PROJECTION_FIELDS` settles 0M.1 open decision 4 by
 *      naming the permitted field set. No participant capsule, Node, or
 *      projection function is created here.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { AccountId } from "../account/account";
import {
  MARKETPLACE_PARTICIPANT_ID_RE,
  MARKETPLACE_ROLE_ASSIGNMENT_ID_RE,
  PARTICIPANT_ACTIVATION_ID_RE,
  PARTICIPANT_PROFILE_ID_RE,
} from "./identity";
import {
  MarketplaceRole,
  ParticipantStatus,
  RoleAssignmentStatus,
} from "./participant";

// — Identity —

export const ParticipantProfileId = z
  .string()
  .regex(PARTICIPANT_PROFILE_ID_RE, "profileId must be mon:mprof:<opaque>");
export type ParticipantProfileId = z.infer<typeof ParticipantProfileId>;

export const ParticipantActivationId = z
  .string()
  .regex(PARTICIPANT_ACTIVATION_ID_RE, "activationId must be mon:mact:<opaque>");
export type ParticipantActivationId = z.infer<typeof ParticipantActivationId>;

const ParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "participantId must be mon:mpart:<opaque>");

const RoleAssignmentId = z
  .string()
  .regex(MARKETPLACE_ROLE_ASSIGNMENT_ID_RE, "roleAssignmentId must be mon:mrole:<opaque>");

/**
 * Who decided a governed activation.
 *
 * **An `AccountId`, resolved in Phase 0M.8.** 0M.1 §9 anticipated a
 * `mon:actor:` form by analogy with the publication-remediation decision, which
 * has no account behind it. An activation reviewer does: the identity foundation
 * already rules that "the account id IS the actor id — one stable, opaque,
 * durable identity that authorization keys on" (`account-principal.ts`), and
 * `AuthenticatedPrincipal` types `actorId` as `AccountId` accordingly.
 *
 * Using that one identity is what binds the audit actor to the authorized
 * reviewer by construction: `activation:review` is evaluated against this exact
 * account, and this exact account is what the row records. A separate
 * `mon:actor:` value would be a second identity nothing verifies against the
 * first, and the audit trail could then name someone other than whoever was
 * actually checked.
 *
 * Still opaque, still never an email address or a display name, and still never
 * published — the activation record is private operational data (0M.1 §8).
 */
const ActorId = AccountId;

// — Draft-writable participant statuses —

/**
 * The participant statuses Phase 0M.5 may write.
 *
 * A strict subset of `PARTICIPANT_STATUSES`, and the enforcement point for
 * "this phase does not activate anyone". UNDER_REVIEW, ACTIVE, RESTRICTED, and
 * SUSPENDED are all absent: reaching any of them is a governed activation
 * decision recorded on `ParticipantActivation`, and this phase writes no
 * activation row, so it must not be able to produce the status one would
 * justify.
 *
 * PHASE 1.17 REMOVED `CLOSED`, AND THE REASON IT WAS HERE IS WHY IT HAD TO GO.
 * 0M.5 admitted it on the ground that "closing a draft that was never activated
 * needs no activation decision — it is the participant giving up, not Monacado
 * ruling". Both halves of that are still true of a DRAFT. Neither is true of the
 * function this constant gates: `advanceParticipantStatus` checks only the
 * TARGET status, and the 0M.1 table reaches `CLOSED` from `ACTIVE`,
 * `RESTRICTED`, `SUSPENDED`, and `UNDER_REVIEW` as well. So the member admitted
 * for the narrow case authorised the wide one, and any caller could
 * irreversibly close an admitted, restricted, or suspended participant with no
 * actor, no authorization, and no record of who did it or why.
 *
 * Closure is now its own governed act — `closeParticipant` in
 * `participant-closure-service` — which takes the participant's own account as
 * both the authorization principal and the audit actor, records a bounded reason
 * and the status it closed from, and raises the notice every other standing
 * change raises. This constant is once again what its name says: the statuses a
 * DRAFT-phase write may produce.
 */
export const DRAFT_WRITABLE_PARTICIPANT_STATUSES = [
  "DRAFT",
  "PROFILE_INCOMPLETE",
  "PROFILE_COMPLETE",
] as const satisfies readonly ParticipantStatus[];

export function isDraftWritableParticipantStatus(status: ParticipantStatus): boolean {
  return (DRAFT_WRITABLE_PARTICIPANT_STATUSES as readonly ParticipantStatus[]).includes(status);
}

// — Profile sections —

/**
 * The closed onboarding-section vocabulary (thesis §5.4).
 *
 * Sections, not fields. What each section *requires* is deliberately not frozen
 * here: the thesis requires the requirement set to be driven dynamically, and a
 * static global checklist in a committed enum is exactly what it warns against.
 * This phase records only whether a section has been satisfied.
 */
export const PARTICIPANT_PROFILE_SECTIONS = [
  "identity",
  "businessStructure",
  "representatives",
  "commercialProfile",
  "risk",
  "payoutConfiguration",
  "documents",
] as const;
export const ParticipantProfileSection = z.enum(PARTICIPANT_PROFILE_SECTIONS);
export type ParticipantProfileSection = z.infer<typeof ParticipantProfileSection>;

/** Per-section completion markers. Booleans only — never section content. */
export const ParticipantProfileMarkers = z.strictObject({
  identityComplete: z.boolean(),
  businessStructureComplete: z.boolean(),
  representativesComplete: z.boolean(),
  commercialProfileComplete: z.boolean(),
  riskComplete: z.boolean(),
  payoutConfigurationComplete: z.boolean(),
  documentsComplete: z.boolean(),
});
export type ParticipantProfileMarkers = z.infer<typeof ParticipantProfileMarkers>;

/**
 * The onboarding gates — 0M.1 open decision 2, settled here.
 *
 * Email verification and terms acceptance are **operational onboarding gates**,
 * enforced as profile prerequisites. They are never capsule facts and never
 * participant statuses; a distinct status would duplicate an account-level fact
 * onto the marketplace axis, and the two would drift.
 *
 * Note what is absent: the verified address. Only the *instant* verification
 * completed is recorded, because the address already lives on `Account` and a
 * second copy here would be a second thing to leak.
 */
export const ParticipantOnboardingGates = z.strictObject({
  emailVerifiedAt: z.iso.datetime().nullable(),
  termsAcceptedAt: z.iso.datetime().nullable(),
  termsVersion: z.string().min(1).max(64).nullable(),
});
export type ParticipantOnboardingGates = z.infer<typeof ParticipantOnboardingGates>;

export const PROFILE_COMPLETENESS = ["INCOMPLETE", "COMPLETE"] as const;
export const ProfileCompleteness = z.enum(PROFILE_COMPLETENESS);
export type ProfileCompleteness = z.infer<typeof ProfileCompleteness>;

/**
 * Derive completeness. The only answer — never stored, never cached.
 *
 * COMPLETE requires every section marker AND both onboarding gates. Terms
 * acceptance additionally requires the version that was accepted: "they agreed"
 * without "to what" is not an enforceable record.
 */
export function deriveProfileCompleteness(
  markers: ParticipantProfileMarkers,
  gates: ParticipantOnboardingGates,
): ProfileCompleteness {
  const everySection = Object.values(markers).every((done) => done === true);
  const gatesPassed =
    gates.emailVerifiedAt !== null &&
    gates.termsAcceptedAt !== null &&
    gates.termsVersion !== null;
  return everySection && gatesPassed ? "COMPLETE" : "INCOMPLETE";
}

// — Records —

export const MarketplaceParticipantRecord = z.strictObject({
  participantId: ParticipantId,
  accountId: AccountId,
  status: ParticipantStatus,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MarketplaceParticipantRecord = z.infer<typeof MarketplaceParticipantRecord>;

export const MarketplaceRoleAssignmentRecord = z.strictObject({
  roleAssignmentId: RoleAssignmentId,
  participantId: ParticipantId,
  role: MarketplaceRole,
  status: RoleAssignmentStatus,
  grantedAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type MarketplaceRoleAssignmentRecord = z.infer<typeof MarketplaceRoleAssignmentRecord>;

/**
 * The private profile record.
 *
 * Every field is a marker, a gate, or an identifier. There is no field for
 * private content, so `JSON.stringify` of this record cannot disclose any — the
 * guarantee holds without a filter, a denylist, or a reviewer noticing.
 */
export const ParticipantProfileRecord = z.strictObject({
  profileId: ParticipantProfileId,
  participantId: ParticipantId,
  markers: ParticipantProfileMarkers,
  gates: ParticipantOnboardingGates,
  /** Derived at read time; never a stored column. */
  completeness: ProfileCompleteness,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ParticipantProfileRecord = z.infer<typeof ParticipantProfileRecord>;

export const ACTIVATION_DECISIONS = [
  "APPROVED",
  "MORE_INFORMATION_REQUIRED",
  "REJECTED",
] as const;
export const ActivationDecision = z.enum(ACTIVATION_DECISIONS);
export type ActivationDecision = z.infer<typeof ActivationDecision>;

/**
 * One governed activation review.
 *
 * **Phase 0M.5 creates none.** The shape exists so 0M.8 records who decided what
 * rather than inventing an activation as a bare status write.
 */
export const ParticipantActivationRecord = z.strictObject({
  activationId: ParticipantActivationId,
  participantId: ParticipantId,
  submittedAt: z.iso.datetime(),
  decision: ActivationDecision.nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decidedByActorId: ActorId.nullable(),
  decisionReasonCode: z.string().min(1).max(64).nullable(),
});
export type ParticipantActivationRecord = z.infer<typeof ParticipantActivationRecord>;

// — Inputs —

/**
 * Create one draft participant.
 *
 * `initialRoles` may be empty: a participant who has claimed no role yet is a
 * legitimate state, and defaulting one on would be Monacado deciding what
 * someone came to do.
 */
export const CreateDraftParticipantInput = z.strictObject({
  accountId: AccountId,
  initialRoles: z.array(MarketplaceRole).max(3),
  now: z.iso.datetime(),
});
export type CreateDraftParticipantInput = z.infer<typeof CreateDraftParticipantInput>;

export const AssignParticipantRoleInput = z.strictObject({
  participantId: ParticipantId,
  role: MarketplaceRole,
  now: z.iso.datetime(),
});
export type AssignParticipantRoleInput = z.infer<typeof AssignParticipantRoleInput>;

/**
 * Create or update the private profile.
 *
 * Every marker and gate is optional so a caller may set one section without
 * restating the rest, and `strictObject` means an unknown key — the shape a
 * private field would arrive in — is a validation failure rather than a
 * silently ignored extra.
 */
export const UpdateParticipantProfileInput = z.strictObject({
  participantId: ParticipantId,
  markers: ParticipantProfileMarkers.partial().optional(),
  gates: ParticipantOnboardingGates.partial().optional(),
  now: z.iso.datetime(),
});
export type UpdateParticipantProfileInput = z.infer<typeof UpdateParticipantProfileInput>;

// — Public projection allow-list (0M.1 open decision 4) —

/**
 * The complete permitted field set of a future public participant projection.
 *
 * **Nothing in this phase implements it.** It is recorded now so the decision is
 * made before a capsule exists to be shaped by convenience, and so a later
 * projection is written against a closed list rather than against whatever the
 * record happens to hold.
 *
 * The ruling: a public participant projection may carry the participant's
 * public reference, the roles it holds with whether each is active, and its
 * admission status. Nothing else. Adding a field is an ADR-level decision, not
 * an implementation detail — in particular a display name is **absent**, because
 * no display name is stored, and the first one added must be an explicitly
 * public field rather than a private profile value promoted into view.
 */
export const PUBLIC_PARTICIPANT_PROJECTION_FIELDS = [
  "publicParticipantRef",
  "roles",
  "participantStatus",
] as const;
export type PublicParticipantProjectionField =
  (typeof PUBLIC_PARTICIPANT_PROJECTION_FIELDS)[number];

// — Privacy guard —

/**
 * Key fragments that must never appear anywhere in a participant projection.
 *
 * A backstop, **not** the privacy guarantee. The guarantee is structural: the
 * profile table has no column for any of these, and every schema above is a
 * `strictObject`. This scan exists to fail loudly if a future phase adds private
 * storage and then hands it to something projection-shaped.
 *
 * Deliberately separate from `integrity/forbidden-fields`, whose header records
 * that its substring matching is a temporary Phase 0B safeguard that must not be
 * expanded. This one is narrow, participant-specific, and matched on lowercase
 * substrings of the key only.
 */
const PRIVATE_PARTICIPANT_KEY_FRAGMENTS: readonly string[] = [
  // credentials and sessions
  "password",
  "passwordhash",
  "session",
  "token",
  "cookie",
  "secret",
  "credential",
  // contact and identity
  "email",
  "phone",
  "address",
  "dateofbirth",
  "dob",
  "legalname",
  "taxid",
  "ssn",
  // payment provider and underwriting
  "stripe",
  "payment",
  "payout",
  "bankaccount",
  "iban",
  "routingnumber",
  "provideraccount",
  "underwriting",
  "riskscore",
  "document",
  // internal governance
  "moderation",
  "internalnote",
  "reviewernote",
];

/**
 * Keys that contain a listed fragment but are approved, bounded, non-private
 * fields of an existing 0M.1 contract.
 *
 * Exactly one member, and it is named rather than accommodated by weakening the
 * fragment list: `paymentReadiness` is a closed enum on
 * `MarketplaceParticipantView` (`NOT_STARTED` … `DISABLED`) that carries no
 * provider identifier, no requirement detail, and no payout configuration.
 * Dropping the `payment` fragment to let it through would also let
 * `paymentMethodToken` through; an explicit exception keeps the scan strict.
 *
 * Adding a member here is a privacy decision. It is not a place to silence a
 * finding.
 */
const APPROVED_NON_PRIVATE_KEYS: ReadonlySet<string> = new Set(["paymentreadiness"]);

export interface ParticipantPrivacyFinding {
  /** Dotted path to the offending key. */
  path: string;
  key: string;
  fragment: string;
}

/**
 * Recursively find any private-looking key in a value intended for publication.
 *
 * Returns findings rather than throwing: the caller decides whether an
 * occurrence is a refusal or a test failure, and a guard that throws inside a
 * projection is a guard people route around.
 */
export function findParticipantPrivacyViolations(
  value: unknown,
  basePath = "",
): ParticipantPrivacyFinding[] {
  const findings: ParticipantPrivacyFinding[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const norm = key.toLowerCase();
      const fragment = APPROVED_NON_PRIVATE_KEYS.has(norm)
        ? undefined
        : PRIVATE_PARTICIPANT_KEY_FRAGMENTS.find((f) => norm.includes(f));
      const here = path ? `${path}.${key}` : key;
      if (fragment) findings.push({ path: here, key, fragment });
      walk(child, here);
    }
  };

  walk(value, basePath);
  return findings;
}

/** The fragments the guard refuses. Exposed so a test can assert coverage. */
export const PRIVATE_PARTICIPANT_KEY_FRAGMENT_LIST: readonly string[] =
  PRIVATE_PARTICIPANT_KEY_FRAGMENTS;
