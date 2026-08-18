/**
 * Prisma ⇄ domain mapping for Storefronts (Phase 0M.3C).
 *
 * **This module is the reason the phase exists.** Until now the Storefront
 * capsule projection could only ever be handed a synthetic fixture, because
 * nothing could persist or retrieve a `StorefrontSourceVersion`. The declared
 * pipeline —
 *
 *   AUTHORITATIVE_SOURCE_MODEL → AUTHORITATIVE_SOURCE_VERSION
 *     → PROJECTION_MAPPING → CAPSULE_PROJECTION_SHAPE → CAPSULE_PROJECTION
 *
 * — was missing its second stage. `versionRowToSourceVersion` supplies it: a
 * persisted row round-trips **exactly** into the canonical contract shape that
 * `storefrontSourceRecordToCapsuleProjection` already consumes, with no field
 * added, dropped, or reinterpreted.
 *
 * Every row read is reconstructed through the contract's own schema; malformed
 * persisted data surfaces as a structured `CorruptStorefrontRecordError` rather
 * than a best-effort object. Raw Prisma rows never escape this adapter.
 */

import type {
  MarketplaceParticipant as ParticipantRow,
  MarketplaceRoleAssignment as RoleAssignmentRow,
  Storefront as StorefrontRow,
  StorefrontGovernanceAssignment as GovernanceRow,
  StorefrontSourceRecordVersionRow as VersionRow,
} from "@prisma/client";
import { INITIAL_PAYMENT_READINESS } from "../../contracts/marketplace/lifecycle";
import {
  StorefrontGovernanceAssignmentRecord,
  type StorefrontGovernanceAssignmentRecord as GovernanceRecord,
} from "../../contracts/marketplace/storefront-record";
import {
  StorefrontSourceRecord,
  StorefrontSourceVersion,
  type ActorGovernanceRole,
  type GovernanceAssignmentStatus,
  type StorefrontActorFacts,
  type StorefrontOwnerFacts,
  type StorefrontSourceRecord as SourceRecord,
  type StorefrontSourceVersion as SourceVersion,
  type SuperOwnerCardinality,
} from "../../contracts/marketplace/storefront-source";
import { CorruptStorefrontRecordError } from "./storefront-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const issuePaths = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] => Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)")));

/**
 * Reconstruct one immutable source version from its persisted row.
 *
 * The mapping is total and lossless in both directions: every contract member
 * has exactly one column, and every column has exactly one member. `tagline` and
 * `summary` stay `null` rather than becoming `undefined`, because the source
 * contract holds them as nullable — collapsing the two would give absence a
 * second representation and could mint a spurious material change.
 */
export function versionRowToSourceVersion(row: VersionRow): SourceVersion {
  const parsed = StorefrontSourceVersion.safeParse({
    storefrontSourceRecordId: row.storefrontSourceRecordId,
    sourceRecordVersion: row.sourceRecordVersion,
    supersedesSourceRecordVersion: row.supersedesSourceRecordVersion,
    internalStorefrontId: row.internalStorefrontId,

    sourceSystem: row.sourceSystem,
    sourceRecordType: row.sourceRecordType,
    sourceClass: row.sourceClass,

    ownerParticipantId: row.ownerParticipantId,
    lifecycle: row.lifecycle,
    visibility: row.visibility,
    publicHandle: row.publicHandle,
    presentation: {
      displayName: row.presentationDisplayName,
      tagline: row.presentationTagline,
      summary: row.presentationSummary,
    },

    authorizedByParticipantId: row.authorizedByParticipantId,
    authorizedByActorId: row.authorizedByActorId,
    recordedAt: iso(row.recordedAt),
  });
  if (!parsed.success) throw new CorruptStorefrontRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/**
 * Reconstruct the stable record from its row and its current version.
 *
 * `presentation` comes from the **current version**, not from the stable row:
 * the version is authoritative for material facts, and duplicating presentation
 * onto the pointer row would create a second answer that could drift.
 */
export function storefrontRowToSourceRecord(
  row: StorefrontRow,
  currentVersion: VersionRow,
): SourceRecord {
  const parsed = StorefrontSourceRecord.safeParse({
    storefrontSourceRecordId: row.storefrontSourceRecordId,
    internalStorefrontId: row.internalStorefrontId,
    currentSourceRecordVersion: row.currentSourceRecordVersion,
    ownerParticipantId: row.ownerParticipantId,

    sourceSystem: currentVersion.sourceSystem,
    sourceRecordType: currentVersion.sourceRecordType,
    sourceClass: currentVersion.sourceClass,

    lifecycle: row.lifecycle,
    visibility: row.visibility,
    publicHandle: row.publicHandle,
    presentation: {
      displayName: currentVersion.presentationDisplayName,
      tagline: currentVersion.presentationTagline,
      summary: currentVersion.presentationSummary,
    },

    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptStorefrontRecordError(issuePaths(parsed.error));
  return parsed.data;
}

export function governanceRowToRecord(row: GovernanceRow): GovernanceRecord {
  const parsed = StorefrontGovernanceAssignmentRecord.safeParse({
    governanceAssignmentId: row.id,
    internalStorefrontId: row.internalStorefrontId,
    participantId: row.participantId,
    role: row.role,
    status: row.status,
    assignedAt: iso(row.assignedAt),
    revokedAt: isoOrNull(row.revokedAt),
  });
  if (!parsed.success) throw new CorruptStorefrontRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/** Persisted rows → the 0M.3A owner facts an authority decision may see. */
export function toStorefrontOwnerFacts(input: {
  owner: ParticipantRow;
  roles: readonly RoleAssignmentRow[];
}): StorefrontOwnerFacts {
  return {
    ownerParticipantId: input.owner.id,
    /**
     * `null`, and deliberately so. The participant model records no
     * INDIVIDUAL/ORGANIZATION kind, and 0M.3A is explicit that an unresolved
     * kind is `null` and is **never silently treated as INDIVIDUAL**. Inventing
     * one here would be exactly that.
     */
    ownerKind: null,
    participantStatus: input.owner.status as StorefrontOwnerFacts["participantStatus"],
    roles: input.roles.map((r) => ({
      role: r.role as StorefrontOwnerFacts["roles"][number]["role"],
      status: r.status as StorefrontOwnerFacts["roles"][number]["status"],
    })),
    /**
     * No payment record exists (0M.8 owns that axis), so readiness is the
     * initial value by construction. This cannot report ENABLED.
     */
    paymentReadiness: INITIAL_PAYMENT_READINESS,
  };
}

/**
 * Persisted rows → the 0M.3A actor facts an authority decision may see.
 *
 * `authorizedForOwnerParticipant` is **supplied by the caller**, never derived.
 * 0M.3A forbids inferring it from an email domain, a display name, or any
 * private profile datum, and nothing reachable here could supply one.
 *
 * An absent governance assignment becomes `NONE`/`NONE` with a `null`
 * storefront — the contract's representation of "never appointed", which it
 * keeps distinct from `REVOKED`.
 */
export function toStorefrontActorFacts(input: {
  accountId: string;
  accountStatus: string;
  authorizedForOwnerParticipant: boolean;
  assignment: GovernanceRow | null;
  internalCapabilities: readonly string[];
}): StorefrontActorFacts {
  const role: ActorGovernanceRole =
    input.assignment === null ? "NONE" : (input.assignment.role as ActorGovernanceRole);
  const status: GovernanceAssignmentStatus =
    input.assignment === null
      ? "NONE"
      : (input.assignment.status as GovernanceAssignmentStatus);

  return {
    accountId: input.accountId,
    accountStatus: input.accountStatus as StorefrontActorFacts["accountStatus"],
    authorizedForOwnerParticipant: input.authorizedForOwnerParticipant,
    governanceRole: role,
    governanceAssignmentStatus: status,
    assignmentStorefrontId: input.assignment === null ? null : input.assignment.internalStorefrontId,
    internalCapabilities:
      input.internalCapabilities as StorefrontActorFacts["internalCapabilities"],
  };
}

/**
 * How many ACTIVE SUPER_OWNER assignments a Storefront has, in the contract's
 * own three-valued vocabulary.
 *
 * `MULTIPLE` is unreachable while the unique index holds — it exists so the
 * cardinality is honestly representable if a future migration ever relaxed the
 * constraint, rather than being quietly assumed impossible.
 */
export function superOwnerCardinality(activeCount: number): SuperOwnerCardinality {
  if (activeCount === 0) return "NONE";
  return activeCount === 1 ? "EXACTLY_ONE" : "MULTIPLE";
}
