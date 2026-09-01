/**
 * Acting-subject resolution — the single account→subject reader (Phase 1.18).
 *
 * **One place answers "who is acting."** Before this phase there were four
 * copies of the same four queries: `materializeMarketplaceSubject` in the
 * participant service, a private `resolveSubject` in the Offer service, another
 * in the Listing service, and `materializeSubjectInTx` in the activation
 * service. They agreed on the queries and disagreed on one fact — two of them
 * read `ParticipantPaymentAccount` and two of them did not — so the *same*
 * account resolved to a payment-ready subject in one service and a
 * `NOT_STARTED` one in another. A gate reading readiness therefore answered
 * differently depending on which module asked, which is the failure mode a
 * single reader exists to prevent.
 *
 * The rows are handed to `toMarketplaceSubject` unprojected, because that
 * mapper is itself the allow-list: it reads a fixed set of columns and has no
 * field for an email, a display name, a password hash, or any private profile
 * datum, so none can reach an authorization decision even by accident.
 *
 * Everything here is read from **persisted state only**: `Account`,
 * `MarketplaceParticipant`, `MarketplaceRoleAssignment`, `AccountEntitlement`,
 * and the payment readiness the provider actually reported. Nothing is accepted
 * from a caller but the account id, and the account id names *who is asking* —
 * never *what they may do*. There is no parameter here through which an
 * authorization conclusion could arrive, which is the property Phase 1.18
 * exists to establish.
 *
 * **The account id is an identity claim, and it is only as good as its
 * source.** Inside this module it is trusted, because every caller sits behind
 * a boundary that resolved it from an authenticated session — see
 * `acting-participant-boundary.ts`, which is the only production path that
 * mints one. A future caller taking it from a request body would reintroduce
 * exactly the forgery this phase removed; that is what the boundary type is
 * for.
 *
 * **Reads only.** No function here writes, and none decides. Resolution
 * produces facts; the pure 0M.1/0M.2A/0M.3A/0M.4A decisions weigh them.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "../db/client";
import type { MarketplaceSubject } from "../../contracts/marketplace/participant";
import type {
  Account as AccountRow,
  MarketplaceParticipant as ParticipantRow,
  MarketplaceRoleAssignment as RoleAssignmentRow,
} from "@prisma/client";
import { toMarketplaceSubject } from "./participant-mapper";
import { readReadinessIn } from "./payment-account-service";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

/**
 * The acting account's own rows, before any decision is made about them.
 *
 * `participant` is `null` for the authenticated non-participant — an account
 * that exists and holds no marketplace identity. That is a legitimate state,
 * not an error, and it is a *different* state from "no such account", which
 * this function reports by returning `null` for the whole resolution.
 */
export interface ActingAccountRows {
  account: AccountRow;
  participant: ParticipantRow | null;
  roles: readonly RoleAssignmentRow[];
  internalCapabilities: readonly string[];
}

/**
 * Read one account's marketplace rows.
 *
 * Returns `null` when no such account exists. That is deliberately distinct
 * from an account holding nothing: collapsing them would report a deleted
 * account as merely unentitled, which is the same distinction
 * `resolveInternalAuthorizationSubject` draws for the internal vocabulary.
 *
 * Entitlements are read on **every** call, never from a token claim and never
 * from a cache, so a revocation fails closed on the very next call.
 */
export async function readActingAccountRows(
  tx: Tx,
  accountId: string,
): Promise<ActingAccountRows | null> {
  const account = await tx.account.findUnique({ where: { id: accountId } });
  if (account === null) return null;

  // `accountId` is `@unique` on MarketplaceParticipant, so this is the whole of
  // the account→participant relation. There is no second candidate to choose
  // between, and no participant id is accepted from a caller to disambiguate.
  const participant = await tx.marketplaceParticipant.findUnique({ where: { accountId } });

  const roles =
    participant === null
      ? []
      : await tx.marketplaceRoleAssignment.findMany({
          where: { participantId: participant.id },
          orderBy: { role: "asc" },
        });

  const entitlements = await tx.accountEntitlement.findMany({
    where: { accountId, status: "ACTIVE" },
    orderBy: { capability: "asc" },
  });

  return {
    account,
    participant,
    roles,
    internalCapabilities: entitlements.map((e) => e.capability),
  };
}

/**
 * Materialize the acting account's `MarketplaceSubject` from persisted state.
 *
 * An unknown account yields the **guest subject** rather than an error: "not
 * signed in" is a condition every 0M.1 gate already refuses with
 * `ACCOUNT_REQUIRED`, and raising here would turn every anonymous call into an
 * exception. An account with no participant yields `participant: null`, the
 * authenticated non-participant.
 *
 * Payment readiness is the provider's observed answer, read from
 * `ParticipantPaymentAccount`. It is **read, never derived**: no branch here
 * turns an admission status, a role, or an approval into a provider state. A
 * participant with no linked account is `NOT_STARTED` because nothing is
 * stored, which is the honest answer rather than a default.
 */
export async function resolveActingSubject(
  tx: Tx,
  accountId: string,
): Promise<MarketplaceSubject> {
  const rows = await readActingAccountRows(tx, accountId);
  if (rows === null) {
    return toMarketplaceSubject({
      account: null,
      participant: null,
      roles: [],
      internalCapabilities: [],
    });
  }

  const paymentReadiness =
    rows.participant === null ? undefined : await readReadinessIn(tx, rows.participant.id);

  return toMarketplaceSubject({
    account: rows.account,
    participant: rows.participant,
    roles: rows.roles,
    internalCapabilities: rows.internalCapabilities,
    ...(paymentReadiness !== undefined ? { paymentReadiness } : {}),
  });
}
