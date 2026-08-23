/**
 * Email suppression and reachability (Phase 1.5) — SERVER ONLY.
 *
 * **The one place that answers "may Monacado write to this address".**
 *
 * A hard bounce means the address does not exist or refuses mail; a complaint
 * means the recipient asked not to be written to. Both are permanent facts about
 * the destination rather than about the message, so continuing to send is not
 * persistence — it is how a sender's domain reputation is destroyed, and in the
 * complaint case it is also ignoring somebody who said stop.
 *
 * ## Suppression is a state, not a verdict
 *
 * `liftedAt` exists so an address that starts working again can be remediated by
 * **proving control of it** — the same signed single-use link `1.3` already
 * built — while the row remains as the evidence of why it was ever suppressed.
 * Lifting is never automatic and never a consequence of time passing: nothing
 * about a mailbox becomes true because a month went by.
 *
 * ## Digest only
 *
 * The list is keyed by SHA-256 of the normalised address and holds no address.
 * A suppression list is otherwise a directory of every address that ever failed,
 * which is a more attractive table to read than the one it was protecting.
 * Monacado can still answer the only question it needs to — "may I write to
 * *this* address", for an address it already holds.
 *
 * ## A soft bounce never lands here
 *
 * A full mailbox or a greylisting is exactly what the retry policy exists for.
 * Suppressing on one converts a transient condition into a permanent one, and
 * the recipient never finds out why they stopped hearing from Monacado.
 */

import "../server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { normalizeEmail } from "../../contracts/account/account";
import {
  EmailSuppressionRecord,
  type SuppressionReason,
} from "../../contracts/marketplace/outbound-email";
import { getPrisma } from "../db/client";
import {
  cryptoOutboundEmailIdProvider,
  type OutboundEmailIdProvider,
} from "./outbound-email-ids";
import {
  CorruptOutboundEmailRecordError,
  OutboundEmailPersistenceFailureError,
} from "./outbound-email-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface SuppressionDeps {
  db?: Db;
  ids?: OutboundEmailIdProvider;
}

/**
 * The digest that stands in for an address.
 *
 * Normalised first — trim and lowercase, through `0M.1`'s own `normalizeEmail`,
 * reused rather than restated so the digest of an address always matches however
 * it was typed. The same construction `0M.9` uses for a guest claim code, `1.1`
 * for a delivery destination, and `1.3` for a challenge address.
 */
export function emailAddressDigest(address: string): string {
  return createHash("sha256").update(normalizeEmail(address), "utf8").digest("hex");
}

interface SuppressionRow {
  id: string;
  addressDigest: string;
  reason: string;
  evidenceEventId: string | null;
  suppressedAt: Date;
  liftedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: SuppressionRow): EmailSuppressionRecord {
  const parsed = EmailSuppressionRecord.safeParse({
    suppressionId: row.id,
    addressDigest: row.addressDigest,
    reason: row.reason,
    evidenceEventId: row.evidenceEventId,
    suppressedAt: row.suppressedAt.toISOString(),
    liftedAt: row.liftedAt === null ? null : row.liftedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new CorruptOutboundEmailRecordError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  return parsed.data;
}

/**
 * Suppress a destination.
 *
 * Idempotent on the digest: a second hard bounce for the same address updates the
 * standing decision rather than accumulating a log of every bounce it produced.
 * A **re-suppression clears `liftedAt`** — an address that was remediated and
 * bounced again is suppressed again, and the row says so.
 */
export async function suppressEmailAddress(
  input: {
    address: string;
    reason: SuppressionReason;
    evidenceEventId: string | null;
    at: string;
  },
  deps: SuppressionDeps = {},
): Promise<EmailSuppressionRecord> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOutboundEmailIdProvider;
  const digest = emailAddressDigest(input.address);
  const at = new Date(input.at);

  try {
    const row = await db.emailSuppression.upsert({
      where: { addressDigest: digest },
      create: {
        id: ids.nextSuppressionId(),
        addressDigest: digest,
        reason: input.reason,
        evidenceEventId: input.evidenceEventId,
        suppressedAt: at,
        createdAt: at,
      },
      update: {
        reason: input.reason,
        evidenceEventId: input.evidenceEventId,
        suppressedAt: at,
        liftedAt: null,
      },
    });
    return toRecord(row);
  } catch (error) {
    throw new OutboundEmailPersistenceFailureError("suppressEmailAddress", error);
  }
}

/**
 * Suppress by digest, for a caller that holds one and not the address.
 *
 * The webhook path uses this: a provider event is normalised to a digest at the
 * boundary, and nothing downstream of that boundary needs the address back.
 */
export async function suppressEmailDigestIn(
  tx: Tx,
  input: {
    addressDigest: string;
    reason: SuppressionReason;
    evidenceEventId: string | null;
    at: string;
    suppressionId: string;
  },
): Promise<void> {
  const at = new Date(input.at);
  await tx.emailSuppression.upsert({
    where: { addressDigest: input.addressDigest },
    create: {
      id: input.suppressionId,
      addressDigest: input.addressDigest,
      reason: input.reason,
      evidenceEventId: input.evidenceEventId,
      suppressedAt: at,
      createdAt: at,
    },
    update: {
      reason: input.reason,
      evidenceEventId: input.evidenceEventId,
      suppressedAt: at,
      liftedAt: null,
    },
  });
}

/**
 * Whether a standing suppression forbids writing to this address.
 *
 * The check the dispatcher makes immediately before every send — not once at
 * enqueue. A message committed on Monday and retried on Tuesday must respect a
 * bounce that arrived on Monday night.
 */
export async function isAddressSuppressedIn(tx: Tx, address: string): Promise<boolean> {
  const row = await tx.emailSuppression.findUnique({
    where: { addressDigest: emailAddressDigest(address) },
    select: { liftedAt: true },
  });
  return row !== null && row.liftedAt === null;
}

export async function isAddressSuppressed(
  address: string,
  deps: SuppressionDeps = {},
): Promise<boolean> {
  return isAddressSuppressedIn(deps.db ?? getPrisma(), address);
}

export async function getEmailSuppression(
  address: string,
  deps: SuppressionDeps = {},
): Promise<EmailSuppressionRecord | null> {
  const db = deps.db ?? getPrisma();
  const row = await db.emailSuppression.findUnique({
    where: { addressDigest: emailAddressDigest(address) },
  });
  return row === null ? null : toRecord(row);
}

/**
 * Lift a suppression, because control of the address was proved again.
 *
 * Called from the verification path, and from nowhere automatic. The row is kept
 * — a lifted suppression still records that the address once hard-bounced, which
 * is exactly what an operator wants when it happens a second time.
 */
export async function liftEmailSuppressionIn(
  tx: Tx,
  input: { addressDigest: string; at: string },
): Promise<void> {
  await tx.emailSuppression.updateMany({
    where: { addressDigest: input.addressDigest, liftedAt: null },
    data: { liftedAt: new Date(input.at) },
  });
}
