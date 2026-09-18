/**
 * What the signed-in `/account` page shows — SERVER ONLY (Phase 1.29).
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
import type {
  MarketplaceRole,
  ParticipantStatus,
  RoleAssignmentStatus,
} from "../../contracts/marketplace/participant";
import {
  SELF_SERVICE_ONBOARDING_ROLES,
  isDraftWritableParticipantStatus,
  type SelfServiceOnboardingRole,
} from "../../contracts/marketplace/participant-record";
import { readActingAccountRows } from "../marketplace/acting-subject-service";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export interface AccountHomeRole {
  role: MarketplaceRole;
  status: RoleAssignmentStatus;
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
}

/** `undefined` when the account no longer exists — the page treats that as signed out. */
export async function readAccountHome(
  accountId: string,
  deps: { db?: Db } = {},
): Promise<AccountHome | undefined> {
  const rows = await readActingAccountRows(deps.db ?? getPrisma(), accountId);
  if (rows === null) return undefined;

  const { account, participant, roles } = rows;
  const onboardingOpen =
    participant === null || isDraftWritableParticipantStatus(participant.status as ParticipantStatus);
  const held = new Set(roles.map((r) => r.role));

  return {
    setupRolesAvailable: onboardingOpen
      ? SELF_SERVICE_ONBOARDING_ROLES.filter((role) => !held.has(role))
      : [],
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
