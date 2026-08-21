/**
 * Governed participant commerce-approval service (Phase 0M.9) — SERVER ONLY.
 *
 * The authoritative home of the go-live approval `0M.3A` defined and left as "a
 * supplied decision input". Until `0M.9` that input came from a caller, which was
 * tolerable while nothing could be bought. **A caller must not be able to make a
 * Listing purchasable by supplying `APPROVED`**, so it comes from here now.
 *
 * Six properties shape everything below, all of them `0M.R1`'s restriction
 * service's, restated only where this differs:
 *
 *   1. **Authority is the persisted `participant:commerce-approve` entitlement**,
 *      read from the database on every call. Not `activation:review`, which
 *      decides an *admission*; not `participant:restrict`, which **withholds** a
 *      capability rather than granting one; not a marketplace role; not
 *      ownership; not a caller assertion, for which there is no field.
 *
 *   2. **Separation of duties.** An actor may not decide commerce approval for
 *      the participant its own account owns — 0M.8's rule, extended here for the
 *      same reason: clearing yourself to take money is the decision that most
 *      obviously needs a second person.
 *
 *   3. **Authorization is checked before any participant state is read**, so an
 *      unauthorized caller learns nothing about the target, not even whether it
 *      exists.
 *
 *   4. **History is never rewritten.** Recording a decision supersedes the
 *      previous one — a state change with its own instant — and inserts a new
 *      row. Withdrawing approval does not edit the grant that stood.
 *
 *   5. **Absence means NOT_APPROVED**, interpreted in exactly one place
 *      (`effectiveCommerceApproval`). Nothing is seeded and no migration grants
 *      anyone clearance.
 *
 *   6. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected.
 *
 * No route, no UI, no risk machinery, and no provider state is read.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  ParticipantCommerceApprovalRecord,
  RecordCommerceApprovalInput,
  effectiveCommerceApproval,
  type CommerceApprovalDecision,
  type ParticipantCommerceApprovalRecord as ApprovalRecord,
} from "../../contracts/marketplace/participant-commerce-approval";
import {
  canApproveParticipantCommerce,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import { getPrisma } from "../db/client";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import {
  cryptoCommerceApprovalIdProvider,
  type CommerceApprovalIdProvider,
} from "./participant-commerce-approval-ids";
import { ParticipantNotFoundError } from "./participant-errors";
import {
  CommerceApprovalActorNotAuthorizedError,
  CommerceApprovalPersistenceFailureError,
  CommerceApprovalSelfActionNotPermittedError,
  CorruptCommerceApprovalRecordError,
  InvalidCommerceApprovalInputError,
} from "./participant-commerce-approval-errors";

type Db = ReturnType<typeof getPrisma>;

/**
 * Anything that can read a row.
 *
 * The approval read below uses model delegates only, so a transaction client
 * satisfies it — which is what lets checkout resolve approval inside whatever
 * read it is already performing.
 */
type Reader = Db | Prisma.TransactionClient;

export interface CommerceApprovalServiceDeps {
  db?: Db;
  ids?: CommerceApprovalIdProvider;
}

function isDomainError(error: unknown): boolean {
  return (
    error instanceof InvalidCommerceApprovalInputError ||
    error instanceof ParticipantNotFoundError ||
    error instanceof CommerceApprovalActorNotAuthorizedError ||
    error instanceof CommerceApprovalSelfActionNotPermittedError ||
    error instanceof CorruptCommerceApprovalRecordError
  );
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidCommerceApprovalInputError {
  return new InvalidCommerceApprovalInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

const iso = (d: Date): string => d.toISOString();

function rowToRecord(row: {
  id: string;
  participantId: string;
  decision: string;
  reasonCode: string;
  decidedAt: Date;
  decidedByAccountId: string;
  supersededAt: Date | null;
  createdAt: Date;
}): ApprovalRecord {
  const parsed = ParticipantCommerceApprovalRecord.safeParse({
    approvalId: row.id,
    participantId: row.participantId,
    decision: row.decision,
    reasonCode: row.reasonCode,
    decidedAt: iso(row.decidedAt),
    decidedByAccountId: row.decidedByAccountId,
    supersededAt: row.supersededAt === null ? null : iso(row.supersededAt),
    createdAt: iso(row.createdAt),
  });
  if (!parsed.success) {
    throw new CorruptCommerceApprovalRecordError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  return parsed.data;
}

/**
 * Refuse unless the acting account holds an active
 * `participant:commerce-approve` entitlement.
 *
 * Resolved from persisted state on every call — never a token claim and never a
 * cache — so a revocation fails closed on the very next decision.
 */
async function assertCommerceApprovalAuthority(db: Db, actingAccountId: string): Promise<void> {
  const subject = await resolveInternalAuthorizationSubject(actingAccountId, { db });
  const decision = canApproveParticipantCommerce(subject);
  if (!isInternallyAuthorized(decision)) {
    throw new CommerceApprovalActorNotAuthorizedError(decision.reasonCodes);
  }
}

/**
 * Record one governed commerce decision, superseding whatever stood before.
 *
 * The same operation approves and withdraws: both are governed decisions with an
 * actor, an instant, and a reason, and a separate "withdraw" path would invite
 * one to be recorded less carefully than the other.
 *
 * Order of checks, mirroring `0M.R1` exactly:
 *
 *   1. **Authorization**, before any participant state is read.
 *   2. **Self-action**, from the persisted `MarketplaceParticipant.accountId`
 *      foreign key — never inferred from an email, a name, or an identifier
 *      prefix.
 *   3. The supersession and the new row, in one transaction: the incumbent's
 *      marker must be free before the new one claims it, and the unique index
 *      makes "exactly one current decision" a database guarantee rather than a
 *      service remembering.
 */
export async function recordCommerceApproval(
  input: unknown,
  deps: CommerceApprovalServiceDeps = {},
): Promise<ApprovalRecord> {
  const parsed = RecordCommerceApprovalInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { participantId, decision, reasonCode, actingAccountId, decidedAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoCommerceApprovalIdProvider;
  const at = new Date(decidedAt);

  await assertCommerceApprovalAuthority(db, actingAccountId);

  try {
    return await db.$transaction(async (tx) => {
      const participant = await tx.marketplaceParticipant.findUnique({
        where: { id: participantId },
      });
      if (participant === null) throw new ParticipantNotFoundError();
      if (participant.accountId === actingAccountId) {
        throw new CommerceApprovalSelfActionNotPermittedError();
      }

      /* Supersede first, so the unique marker is free. The incumbent's decision,
         reason, instant, and actor are untouched — only its standing changes, so
         the history reads as what actually happened. */
      const incumbent = await tx.participantCommerceApproval.findUnique({
        where: { currentForParticipantId: participantId },
      });
      if (incumbent !== null) {
        await tx.participantCommerceApproval.update({
          where: { id: incumbent.id },
          data: { supersededAt: at, currentForParticipantId: null },
        });
      }

      const row = await tx.participantCommerceApproval.create({
        data: {
          id: ids.nextCommerceApprovalId(),
          participantId,
          decision,
          reasonCode,
          decidedAt: at,
          decidedByAccountId: actingAccountId,
          currentForParticipantId: participantId,
        },
      });
      return rowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    /* A unique violation here means two callers raced on the current marker; the
       index is the guarantee and one of them simply loses. It surfaces as a
       persistence failure rather than a domain condition, because "somebody else
       decided at the same instant" is not a governed outcome to report. */
    throw new CommerceApprovalPersistenceFailureError("recordCommerceApproval", error);
  }
}

/** The decision currently in force, or `null` when none has ever been made. */
export async function getCurrentCommerceApproval(
  participantId: string,
  deps: CommerceApprovalServiceDeps = {},
): Promise<ApprovalRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.participantCommerceApproval.findUnique({
      where: { currentForParticipantId: participantId },
    });
    return row === null ? null : rowToRecord(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new CommerceApprovalPersistenceFailureError("getCurrentCommerceApproval", error);
  }
}

/**
 * The approval status in force for one participant, from persisted state.
 *
 * **The function every eligibility decision reads**, and the only path by which a
 * go-live approval can now reach one. It takes a `Reader`, so a caller already
 * inside a transaction resolves the same answer without opening another.
 *
 * No record yields `NOT_APPROVED` through `effectiveCommerceApproval`, which is
 * the one place absence is interpreted.
 */
export async function resolveCommerceApproval(
  tx: Reader,
  participantId: string,
): Promise<CommerceApprovalDecision> {
  const row = await tx.participantCommerceApproval.findUnique({
    where: { currentForParticipantId: participantId },
    select: { decision: true },
  });
  return effectiveCommerceApproval(
    row === null ? null : { decision: row.decision as CommerceApprovalDecision },
  );
}

/** Every decision ever made about one participant, newest first. Append-only. */
export async function listCommerceApprovals(
  participantId: string,
  deps: CommerceApprovalServiceDeps = {},
): Promise<ApprovalRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.participantCommerceApproval.findMany({
      where: { participantId },
      orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
    });
    return rows.map(rowToRecord);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new CommerceApprovalPersistenceFailureError("listCommerceApprovals", error);
  }
}
