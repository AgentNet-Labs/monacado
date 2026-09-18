/**
 * What the signed-in `/account` page shows — SERVER ONLY (Phase 1.29; Storefronts
 * added in Phase 1.30).
 *
 * Read fresh from the database on every render, from the account id the session
 * resolved to. Nothing here is carried in the session: a name or address changed
 * elsewhere would otherwise go stale in a cookie, and the session would grow into
 * a second copy of the account.
 *
 * **A projection, not a record.** The account row includes its password hash and
 * its internal ids; this returns neither, nor the participant's or any role's id.
 * The page cannot render what it is never handed.
 *
 * The rows come from `readActingAccountRows`, the reader the marketplace
 * authority path already uses for account → participant → roles, so the page and
 * the services agree on what this account holds.
 */

import "../server-only";
import {
  permitsDrafting,
  type MarketplaceRole,
  type ParticipantStatus,
  type RoleAssignmentStatus,
} from "../../contracts/marketplace/participant";
import {
  SELF_SERVICE_ONBOARDING_ROLES,
  isDraftWritableParticipantStatus,
  type SelfServiceOnboardingRole,
} from "../../contracts/marketplace/participant-record";
import type {
  StorefrontLifecycleState,
  StorefrontVisibility,
} from "../../contracts/marketplace/storefront-source";
import { INCLUDED_STOREFRONT_ALLOWANCE } from "../../contracts/marketplace/storefront-record";
import { canCreateDraftStorefront, isAllowed } from "../../contracts/marketplace/capability";
import { readActingAccountRows } from "../marketplace/acting-subject-service";
import { toMarketplaceSubject } from "../marketplace/participant-mapper";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export interface AccountHomeRole {
  role: MarketplaceRole;
  status: RoleAssignmentStatus;
}

/**
 * One Storefront the account's participant owns (Phase 1.30): the name and
 * handle the owner chose, and where it stands. No internal id of any kind.
 */
export interface AccountHomeStorefront {
  displayName: string;
  /** `null` when unset — the source model's own representation (Phase 1.31). */
  tagline: string | null;
  summary: string | null;
  publicHandle: string;
  lifecycle: StorefrontLifecycleState;
  visibility: StorefrontVisibility;
  /**
   * Whether the page should offer the presentation editor (Phase 1.31): this
   * participant holds an ACTIVE SUPER_OWNER or ADMIN assignment on it, it is not
   * CLOSED, and the participant's status permits drafting. The route asks the
   * domain again; this only decides what to show.
   */
  canEditPresentation: boolean;
}

export interface AccountHome {
  name: string;
  email: string;
  emailVerified: boolean;
  /** `null` until the account begins Seller or Promoter setup. */
  marketplace: {
    status: ParticipantStatus;
    roles: AccountHomeRole[];
    /** Whether self-service setup may still add a role (the participant is drafting). */
    onboardingOpen: boolean;
  } | null;
  /**
   * The Seller/Promoter roles this account may start from the page now: every
   * one it does not hold, while setup is open; none once it is not.
   */
  setupRolesAvailable: SelfServiceOnboardingRole[];
  /** Storefronts the participant owns, oldest first. Empty without a participant. */
  storefronts: AccountHomeStorefront[];
  /**
   * Whether the page should offer to open a draft Storefront: the 0M.1
   * `canCreateDraftStorefront` decision over this account's own rows — a SELLER
   * or PROMOTER role in a drafting status, on a participant permitted to draft —
   * AND a Storefront left in the participant's allowance. The route asks the
   * domain again; this only decides what to show.
   */
  canCreateStorefront: boolean;
  /**
   * The participant may draft Storefronts but owns every one its allowance
   * covers: the next needs an upgrade. Never true alongside `canCreateStorefront`.
   */
  storefrontUpgradeRequired: boolean;
}

/** `undefined` when the account no longer exists — the page treats that as signed out. */
export async function readAccountHome(
  accountId: string,
  deps: { db?: Db } = {},
): Promise<AccountHome | undefined> {
  const db = deps.db ?? getPrisma();
  const rows = await readActingAccountRows(db, accountId);
  if (rows === null) return undefined;

  const { account, participant, roles } = rows;
  const storefronts =
    participant === null
      ? []
      : await readOwnedStorefronts(
          db,
          participant.id,
          permitsDrafting(participant.status as ParticipantStatus),
        );
  const mayDraftStorefront = isAllowed(
    canCreateDraftStorefront(
      toMarketplaceSubject({
        account,
        participant,
        roles,
        internalCapabilities: rows.internalCapabilities,
      }),
    ),
  );
  /* The same allowance `openOwnedDraftStorefront` enforces: the included
     Storefront, plus any upgrade entitlement — of which none exists yet. */
  const withinAllowance = storefronts.length < INCLUDED_STOREFRONT_ALLOWANCE;
  const canCreateStorefront = mayDraftStorefront && withinAllowance;
  const storefrontUpgradeRequired = mayDraftStorefront && !withinAllowance;
  const onboardingOpen =
    participant === null || isDraftWritableParticipantStatus(participant.status as ParticipantStatus);
  const held = new Set(roles.map((r) => r.role));

  return {
    setupRolesAvailable: onboardingOpen
      ? SELF_SERVICE_ONBOARDING_ROLES.filter((role) => !held.has(role))
      : [],
    storefronts,
    canCreateStorefront,
    storefrontUpgradeRequired,
    name: account.name,
    email: account.email,
    emailVerified: account.emailVerifiedAt !== null,
    marketplace:
      participant === null
        ? null
        : {
            status: participant.status as ParticipantStatus,
            roles: roles.map((r) => ({
              role: r.role as MarketplaceRole,
              status: r.status as RoleAssignmentStatus,
            })),
            onboardingOpen,
          },
  };
}

/**
 * The participant's Storefronts, each with the display name from its CURRENT
 * source version — the stable record carries the handle, lifecycle, and
 * visibility, and the version row is where the name lives.
 */
async function readOwnedStorefronts(
  db: Db,
  ownerParticipantId: string,
  participantMayDraft: boolean,
): Promise<AccountHomeStorefront[]> {
  const stores = await db.storefront.findMany({
    where: { ownerParticipantId },
    orderBy: { createdAt: "asc" },
    select: {
      internalStorefrontId: true,
      storefrontSourceRecordId: true,
      currentSourceRecordVersion: true,
      publicHandle: true,
      lifecycle: true,
      visibility: true,
    },
  });
  if (stores.length === 0) return [];

  const versions = await db.storefrontSourceRecordVersionRow.findMany({
    where: {
      OR: stores.map((s) => ({
        storefrontSourceRecordId: s.storefrontSourceRecordId,
        sourceRecordVersion: s.currentSourceRecordVersion,
      })),
    },
    select: {
      storefrontSourceRecordId: true,
      presentationDisplayName: true,
      presentationTagline: true,
      presentationSummary: true,
    },
  });
  const current = new Map(versions.map((v) => [v.storefrontSourceRecordId, v]));

  /* The participant's own ACTIVE governance on these Storefronts — the
     assignment `canEditStorefrontPresentation` requires. Ownership alone is not
     governance (0M.3C §3). */
  const governed = new Set(
    (
      await db.storefrontGovernanceAssignment.findMany({
        where: {
          participantId: ownerParticipantId,
          status: "ACTIVE",
          internalStorefrontId: { in: stores.map((s) => s.internalStorefrontId) },
        },
        select: { internalStorefrontId: true },
      })
    ).map((g) => g.internalStorefrontId),
  );

  return stores.map((s) => {
    const version = current.get(s.storefrontSourceRecordId);
    return {
      displayName: version?.presentationDisplayName ?? s.publicHandle,
      tagline: version?.presentationTagline ?? null,
      summary: version?.presentationSummary ?? null,
      publicHandle: s.publicHandle,
      lifecycle: s.lifecycle as StorefrontLifecycleState,
      visibility: s.visibility as StorefrontVisibility,
      canEditPresentation:
        participantMayDraft &&
        s.lifecycle !== "CLOSED" &&
        governed.has(s.internalStorefrontId),
    };
  });
}
