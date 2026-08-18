/**
 * Prisma ⇄ domain mapping for marketplace participants (Phase 0M.5).
 *
 * Every row read is reconstructed into a validated domain record; malformed
 * persisted data surfaces as a structured `CorruptParticipantRecordError` rather
 * than a best-effort object. Raw Prisma rows never escape this adapter.
 *
 * The consequential function here is `toMarketplaceSubject`. It is the boundary
 * where persisted state becomes the input to the twelve 0M.1 capability
 * decisions, and it is built as an **allow-list projection**: it names every
 * field it emits, reads the profile table not at all, and has no parameter that
 * could carry a private value. A capability decision therefore cannot come to
 * depend on private profile data, because the data never reaches it.
 */

import type {
  Account as AccountRow,
  MarketplaceParticipant as ParticipantRow,
  MarketplaceRoleAssignment as RoleAssignmentRow,
  ParticipantActivation as ActivationRow,
  ParticipantProfile as ProfileRow,
} from "@prisma/client";
import {
  MarketplaceParticipantView,
  MarketplaceSubject,
  type MarketplaceSubject as Subject,
} from "../../contracts/marketplace/participant";
import { INITIAL_PAYMENT_READINESS } from "../../contracts/marketplace/lifecycle";
import {
  MarketplaceParticipantRecord,
  MarketplaceRoleAssignmentRecord,
  ParticipantActivationRecord,
  ParticipantOnboardingGates,
  ParticipantProfileMarkers,
  ParticipantProfileRecord,
  deriveProfileCompleteness,
  type MarketplaceParticipantRecord as ParticipantRecord,
  type MarketplaceRoleAssignmentRecord as RoleRecord,
  type ParticipantActivationRecord as ActivationRecord,
  type ParticipantProfileRecord as ProfileRecord,
} from "../../contracts/marketplace/participant-record";
import { CorruptParticipantRecordError } from "./participant-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const issuePaths = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] => Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)")));

/** Reconstruct a validated participant record from a persisted row. */
export function participantRowToRecord(row: ParticipantRow): ParticipantRecord {
  const parsed = MarketplaceParticipantRecord.safeParse({
    participantId: row.id,
    accountId: row.accountId,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptParticipantRecordError(issuePaths(parsed.error));
  return parsed.data;
}

export function roleAssignmentRowToRecord(row: RoleAssignmentRow): RoleRecord {
  const parsed = MarketplaceRoleAssignmentRecord.safeParse({
    roleAssignmentId: row.id,
    participantId: row.participantId,
    role: row.role,
    status: row.status,
    grantedAt: iso(row.grantedAt),
    activatedAt: isoOrNull(row.activatedAt),
    revokedAt: isoOrNull(row.revokedAt),
  });
  if (!parsed.success) throw new CorruptParticipantRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/**
 * Reconstruct the private profile record.
 *
 * `completeness` is derived here, from the markers and gates on the row. There
 * is no stored column to read, so a stale one cannot be read either.
 */
export function profileRowToRecord(row: ProfileRow): ProfileRecord {
  const markers = ParticipantProfileMarkers.safeParse({
    identityComplete: row.identityComplete,
    businessStructureComplete: row.businessStructureComplete,
    representativesComplete: row.representativesComplete,
    commercialProfileComplete: row.commercialProfileComplete,
    riskComplete: row.riskComplete,
    payoutConfigurationComplete: row.payoutConfigurationComplete,
    documentsComplete: row.documentsComplete,
  });
  const gates = ParticipantOnboardingGates.safeParse({
    emailVerifiedAt: isoOrNull(row.emailVerifiedAt),
    termsAcceptedAt: isoOrNull(row.termsAcceptedAt),
    termsVersion: row.termsVersion,
  });
  if (!markers.success) throw new CorruptParticipantRecordError(issuePaths(markers.error));
  if (!gates.success) throw new CorruptParticipantRecordError(issuePaths(gates.error));

  const parsed = ParticipantProfileRecord.safeParse({
    profileId: row.id,
    participantId: row.participantId,
    markers: markers.data,
    gates: gates.data,
    completeness: deriveProfileCompleteness(markers.data, gates.data),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptParticipantRecordError(issuePaths(parsed.error));
  return parsed.data;
}

export function activationRowToRecord(row: ActivationRow): ActivationRecord {
  const parsed = ParticipantActivationRecord.safeParse({
    activationId: row.id,
    participantId: row.participantId,
    submittedAt: iso(row.submittedAt),
    decision: row.decision,
    decidedAt: isoOrNull(row.decidedAt),
    decidedByActorId: row.decidedByActorId,
    decisionReasonCode: row.decisionReasonCode,
  });
  if (!parsed.success) throw new CorruptParticipantRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/**
 * Materialize the `MarketplaceSubject` the twelve 0M.1 capability decisions take.
 *
 * Three things this deliberately does NOT do:
 *
 *   - **It never reads `ParticipantProfile`.** The profile is not a parameter,
 *     so no capability decision can come to depend on a private value. That is
 *     structural, not a convention.
 *   - **It never reports payment readiness from storage.** No payment table
 *     exists in this phase, so readiness is the initial `NOT_STARTED` — this
 *     function cannot emit ENABLED, and 0M.8 replaces the constant with the
 *     provider's real answer.
 *   - **It never grants internal capabilities from a marketplace role.**
 *     `internalCapabilities` comes from `AccountEntitlement` and is passed
 *     through untouched; every function in `capability.ts` ignores it.
 *
 * A `null` participant with a non-null account is the authenticated non-participant;
 * both `null` is the guest buyer. Neither is an error.
 */
export function toMarketplaceSubject(input: {
  account: AccountRow | null;
  participant: ParticipantRow | null;
  roles: readonly RoleAssignmentRow[];
  internalCapabilities: readonly string[];
}): Subject {
  const account =
    input.account === null
      ? null
      : { accountId: input.account.id, status: input.account.status };

  const participant =
    input.participant === null
      ? null
      : {
          participantId: input.participant.id,
          accountId: input.participant.accountId,
          status: input.participant.status,
          roles: input.roles.map((r) => ({ role: r.role, status: r.status })),
          paymentReadiness: INITIAL_PAYMENT_READINESS,
        };

  // Validate the participant half on its own first, so a corrupt stored role or
  // status is reported as corrupt storage rather than as a malformed subject.
  if (participant !== null) {
    const view = MarketplaceParticipantView.safeParse(participant);
    if (!view.success) throw new CorruptParticipantRecordError(issuePaths(view.error));
  }

  const parsed = MarketplaceSubject.safeParse({
    account,
    participant,
    internalCapabilities: input.internalCapabilities,
  });
  if (!parsed.success) throw new CorruptParticipantRecordError(issuePaths(parsed.error));
  return parsed.data;
}
