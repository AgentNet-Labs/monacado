/**
 * Participant policy acceptance (Phase 1.3) — SERVER ONLY.
 *
 * Durable evidence that one participant undertook one **exact** policy version,
 * as one audience.
 *
 * ## History is never rewritten
 *
 * A newer version becoming `ACTIVE` does not touch, supersede, or invalidate an
 * existing acceptance row. "They accepted the terms" is worthless without "which
 * terms, and when", and a model that overwrote the answer would destroy the only
 * thing acceptance evidence is for.
 *
 * Re-acceptance is therefore a **new row**, not an update — and both remain
 * queryable afterwards, which a test asserts.
 *
 * ## Audience is part of the identity
 *
 * A participant holding both roles accepts as each, because the undertakings
 * differ: a seller promises fulfilment and support, a promoter promises truthful
 * promotion. One acceptance standing in for the other would record an agreement
 * nobody made.
 *
 * ## Recording, not deciding
 *
 * This service records what happened. Whether an acceptance *satisfies*
 * activation is `evaluatePolicyAcceptanceRequirement`'s question, and keeping the
 * two apart means a policy change cannot silently rewrite what somebody agreed to.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  ACCEPTANCE_REQUIRED_AUDIENCES,
  ParticipantPolicyAcceptanceRecord,
  type AcceptanceMechanism,
  type AcceptanceRequiredAudience,
} from "../../contracts/marketplace/marketplace-policy";
import { getPrisma } from "../db/client";
import { cryptoPolicyIdProvider, type PolicyIdProvider } from "./policy-ids";
import { PolicyError, PolicyPersistenceFailureError } from "./policy-errors";
import {
  readMarketplacePolicy,
  type PolicyServiceDeps,
} from "./marketplace-policy-service";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";

export interface AcceptanceDeps {
  db?: Db;
  ids?: PolicyIdProvider;
  /** Passed to `readMarketplacePolicy`. See `PolicyServiceDeps.documents`. */
  documents?: PolicyServiceDeps["documents"];
}

interface AcceptanceRow {
  id: string;
  participantId: string;
  policyId: string;
  policyVersion: string;
  audience: string;
  contentHash: string;
  mechanism: string;
  acceptedAt: Date;
  acceptedByAccountId: string;
  recordedAt: Date;
}

function rowToRecord(row: AcceptanceRow): ParticipantPolicyAcceptanceRecord {
  const parsed = ParticipantPolicyAcceptanceRecord.safeParse({
    acceptanceId: row.id,
    participantId: row.participantId,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    audience: row.audience,
    contentHash: row.contentHash,
    mechanism: row.mechanism,
    acceptedAt: row.acceptedAt.toISOString(),
    acceptedByAccountId: row.acceptedByAccountId,
    recordedAt: row.recordedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new PolicyError("CORRUPT_ACCEPTANCE", "A persisted policy acceptance is malformed");
  }
  return parsed.data;
}

export interface RecordedAcceptance {
  acceptance: ParticipantPolicyAcceptanceRecord;
  /** `true` when this exact acceptance already stood. Nothing was written. */
  alreadyAccepted: boolean;
}

/**
 * Record one acceptance.
 *
 * The content hash is **read from the governed version**, not supplied — and
 * `readMarketplacePolicy` verifies it against the source first, so an acceptance
 * cannot be recorded against prose that has drifted from the version governing it.
 *
 * A repeat of the same (participant × version × audience) is **idempotent**: the
 * unique index refuses it and the existing row is returned. Accepting twice is
 * one undertaking, not two, and a second row would misstate the record.
 */
export async function recordPolicyAcceptance(
  input: {
    participantId: string;
    policyId: string;
    policyVersion: string;
    audience: AcceptanceRequiredAudience;
    mechanism: AcceptanceMechanism;
    acceptedByAccountId: string;
    acceptedAt: string;
    recordedAt: string;
  },
  deps: AcceptanceDeps = {},
): Promise<RecordedAcceptance> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoPolicyIdProvider;

  const { version } = await readMarketplacePolicy(input.policyId, input.policyVersion, {
    db,
    documents: deps.documents,
  });

  try {
    const row = await db.participantPolicyAcceptance.create({
      data: {
        id: ids.nextAcceptanceId(),
        participantId: input.participantId,
        policyId: input.policyId,
        policyVersion: input.policyVersion,
        audience: input.audience,
        contentHash: version.contentHash,
        mechanism: input.mechanism,
        acceptedAt: new Date(input.acceptedAt),
        acceptedByAccountId: input.acceptedByAccountId,
        recordedAt: new Date(input.recordedAt),
      },
    });
    return { acceptance: rowToRecord(row), alreadyAccepted: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await db.participantPolicyAcceptance.findUnique({
        where: {
          participantId_policyId_policyVersion_audience: {
            participantId: input.participantId,
            policyId: input.policyId,
            policyVersion: input.policyVersion,
            audience: input.audience,
          },
        },
      });
      if (existing !== null) {
        return { acceptance: rowToRecord(existing), alreadyAccepted: true };
      }
    }
    if (error instanceof PolicyError) throw error;
    throw new PolicyPersistenceFailureError("recordPolicyAcceptance", error);
  }
}

// — Reads —

/** Every acceptance a participant has ever made, newest first. */
export async function listPolicyAcceptances(
  participantId: string,
  deps: AcceptanceDeps = {},
): Promise<ParticipantPolicyAcceptanceRecord[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.participantPolicyAcceptance.findMany({
    where: { participantId },
    orderBy: [{ acceptedAt: "desc" }, { id: "asc" }],
  });
  return rows.map(rowToRecord);
}

/** Shared read, usable inside and outside a transaction. */
export async function hasAcceptedIn(
  tx: Tx,
  args: {
    participantId: string;
    policyId: string;
    policyVersion: string;
    audience: AcceptanceRequiredAudience;
  },
): Promise<boolean> {
  const count = await tx.participantPolicyAcceptance.count({
    where: {
      participantId: args.participantId,
      policyId: args.policyId,
      policyVersion: args.policyVersion,
      audience: args.audience,
    },
  });
  return count > 0;
}

/**
 * Which audiences a participant must have accepted as, given their roles.
 *
 * Derived from the activatable roles held, so a seller-only participant is never
 * asked to accept promoter undertakings. A participant with neither role needs no
 * acceptance — activation refuses them for the absence of a role, which is the
 * more accurate complaint.
 */
export function requiredAcceptanceAudiences(
  roles: readonly string[],
): AcceptanceRequiredAudience[] {
  return ACCEPTANCE_REQUIRED_AUDIENCES.filter((audience) => roles.includes(audience));
}

/** Audiences a participant still owes acceptance for, against one version. */
export async function outstandingAcceptanceAudiences(
  tx: Tx,
  args: {
    participantId: string;
    policyId: string;
    policyVersion: string;
    roles: readonly string[];
  },
): Promise<AcceptanceRequiredAudience[]> {
  const required = requiredAcceptanceAudiences(args.roles);
  const outstanding: AcceptanceRequiredAudience[] = [];
  for (const audience of required) {
    const accepted = await hasAcceptedIn(tx, {
      participantId: args.participantId,
      policyId: args.policyId,
      policyVersion: args.policyVersion,
      audience,
    });
    if (!accepted) outstanding.push(audience);
  }
  return outstanding;
}
