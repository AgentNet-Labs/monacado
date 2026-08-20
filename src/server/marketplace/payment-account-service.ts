/**
 * Participant payment-provider account service (Phase 0M.8) — SERVER ONLY.
 *
 * The narrow application boundary over payment-provider readiness. Four
 * operations: link a participant to a provider account, read that account,
 * record an observation of the provider's answer, and report the readiness the
 * capability decisions consume.
 *
 * Five properties shape everything below:
 *
 *   1. **0M.8 moves no money.** Nothing here creates a charge, payment intent,
 *      order, capture, refund, chargeback, settlement, payout, or ledger entry,
 *      and no value in this module is an amount. It records who is ready to be
 *      paid; it pays nobody.
 *
 *   2. **The provider's answer is observed, never assumed.** An account is
 *      created `NOT_STARTED` — `RegisterPaymentAccountInput` has no `readiness`
 *      parameter — and every subsequent value arrives through
 *      `recordObservedProviderState` with the instant it was observed. The 0M.1
 *      transition table is enforced on the way in, so `NOT_STARTED → ENABLED`
 *      is refused: a path that reached ENABLED without the provider deciding
 *      would let an operator mark an unverified participant payable.
 *
 *   3. **No live provider is contacted.** `PaymentProviderPort` is an injected
 *      interface with no implementation in this phase and no dependency behind
 *      it. `syncProviderReadiness` accepts the port and does the persistence
 *      half; the adapter that would satisfy it is deferred.
 *
 *   4. **Nothing provider-shaped is persisted.** No credential, no dossier, no
 *      raw payload, no provider error body. Every input is a `strictObject`, so
 *      an unknown key — the shape any of those would arrive in — is a validation
 *      failure rather than a silently ignored extra.
 *
 *   5. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected,
 *      matching every other service in this repository.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  RecordObservedProviderStateInput,
  RegisterPaymentAccountInput,
  canonicalizeRequirements,
  type ParticipantPaymentAccountRecord,
  type PaymentProvider,
  type PaymentProviderPort,
} from "../../contracts/marketplace/payment-account";
import {
  INITIAL_PAYMENT_READINESS,
  isValidPaymentReadinessTransition,
} from "../../contracts/marketplace/lifecycle";
import type { PaymentReadinessStatus } from "../../contracts/marketplace/participant";
import { getPrisma } from "../db/client";
import { cryptoParticipantIdProvider, type ParticipantIdProvider } from "./participant-ids";
import { ParticipantNotFoundError } from "./participant-errors";
import {
  AmbiguousPaymentReadinessError,
  CorruptPaymentAccountRecordError,
  DuplicatePaymentAccountError,
  InvalidPaymentAccountInputError,
  InvalidPaymentReadinessTransitionError,
  MultiplePaymentProvidersNotSupportedInPhaseError,
  PaymentAccountNotFoundError,
  PaymentAccountPersistenceFailureError,
  ProviderAccountRefAlreadyLinkedError,
  ProviderAccountRefMismatchError,
} from "./payment-account-errors";
import { paymentAccountRowToRecord } from "./payment-account-mapper";

type Db = ReturnType<typeof getPrisma>;

export interface PaymentAccountServiceDeps {
  db?: Db;
  ids?: ParticipantIdProvider;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const isUniqueViolation = (error: unknown): boolean => prismaCode(error) === "P2002";
const isForeignKeyViolation = (error: unknown): boolean => prismaCode(error) === "P2003";

/** Which unique index a P2002 came from, so two very different causes stay distinct. */
function uniqueTarget(error: unknown): string {
  const meta = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (Array.isArray(meta)) return meta.join(",");
  return typeof meta === "string" ? meta : "";
}

/** Errors that must escape a catch block UNWRAPPED — see participant-service. */
function isDomainError(error: unknown): boolean {
  return (
    error instanceof ParticipantNotFoundError ||
    error instanceof PaymentAccountNotFoundError ||
    error instanceof CorruptPaymentAccountRecordError ||
    error instanceof AmbiguousPaymentReadinessError ||
    error instanceof InvalidPaymentReadinessTransitionError ||
    error instanceof ProviderAccountRefMismatchError ||
    error instanceof MultiplePaymentProvidersNotSupportedInPhaseError
  );
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidPaymentAccountInputError {
  return new InvalidPaymentAccountInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

/**
 * Link one participant to one provider account.
 *
 * Created at `INITIAL_PAYMENT_READINESS` and at no other status. Two uniqueness
 * guarantees do the real work, both at the index rather than in a read-then-write
 * check so concurrent callers cannot both succeed:
 *
 *   - `(participantId, provider)` — one account per participant per provider;
 *   - `(provider, providerAccountRef)` — one provider account belongs to exactly
 *     one participant, so a payout attribution built on it is never ambiguous.
 *
 * A participant that already holds an account with a *different* provider is
 * refused with a phase-gate error rather than a domain one: the schema permits
 * the row, but no rule yet says which of two disagreeing providers supplies the
 * participant's single `paymentReadiness`, and inventing one would be commercial
 * policy written inside a persistence phase.
 */
export async function registerParticipantPaymentAccount(
  input: unknown,
  deps: PaymentAccountServiceDeps = {},
): Promise<ParticipantPaymentAccountRecord> {
  const parsed = RegisterPaymentAccountInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { participantId, provider, providerAccountRef } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantIdProvider;
  const paymentAccountId = ids.nextPaymentAccountId();

  try {
    return await db.$transaction(async (tx) => {
      const participant = await tx.marketplaceParticipant.findUnique({
        where: { id: participantId },
      });
      if (participant === null) throw new ParticipantNotFoundError();

      const existing = await tx.participantPaymentAccount.findMany({ where: { participantId } });
      if (existing.some((row) => row.provider !== provider)) {
        throw new MultiplePaymentProvidersNotSupportedInPhaseError();
      }

      await tx.participantPaymentAccount.create({
        data: {
          id: paymentAccountId,
          participantId,
          provider,
          providerAccountRef,
          readiness: INITIAL_PAYMENT_READINESS,
          readinessObservedAt: null,
        },
      });

      return await readAccountInTx(tx, participantId, provider);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) {
      throw uniqueTarget(error).includes("providerAccountRef")
        ? new ProviderAccountRefAlreadyLinkedError(error)
        : new DuplicatePaymentAccountError(error);
    }
    if (isForeignKeyViolation(error)) throw new ParticipantNotFoundError();
    throw new PaymentAccountPersistenceFailureError("registerParticipantPaymentAccount", error);
  }
}

/** Read one participant's account with one provider. */
export async function getParticipantPaymentAccount(
  participantId: string,
  provider: PaymentProvider,
  deps: PaymentAccountServiceDeps = {},
): Promise<ParticipantPaymentAccountRecord> {
  const db = deps.db ?? getPrisma();
  try {
    return await readAccountInTx(db, participantId, provider);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new PaymentAccountPersistenceFailureError("getParticipantPaymentAccount", error);
  }
}

/**
 * Persist one observation of the provider's current answer.
 *
 * The external-observation boundary, and the only way a readiness other than
 * `NOT_STARTED` enters the database. Four things are recorded together because
 * any one alone is unreconcilable later: the provider, the observed value, the
 * instant, and the account reference it was observed for.
 *
 * Three refusals, each fail-closed:
 *
 *   - **A reference mismatch is not an update.** An observation naming a
 *     different provider account than the stored one is a reconciliation
 *     failure; re-pointing the row would rewrite which external account the
 *     participant is linked to on the strength of one API response.
 *   - **An illegal transition is refused**, from the 0M.1 table, not a local
 *     copy of it.
 *   - **Nothing is inferred.** Recording `ENABLED` moves no participant status;
 *     that is a governed decision with its own audit row.
 *
 * Requirements are replaced wholesale rather than merged: the provider reports a
 * current outstanding set, and merging would leave a satisfied requirement
 * standing forever because no message ever said "this one is done".
 *
 * **Idempotent for a repeated identical observation.** Re-recording the current
 * readiness is permitted even where the transition table has no self-edge —
 * polling the same answer twice is the normal case, not an illegal move.
 */
export async function recordObservedProviderState(
  input: unknown,
  deps: PaymentAccountServiceDeps = {},
): Promise<ParticipantPaymentAccountRecord> {
  const parsed = RecordObservedProviderStateInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { participantId, provider, providerAccountRef, readiness, observedAt } = parsed.data;
  const requirements = canonicalizeRequirements(parsed.data.outstandingRequirements);
  const at = new Date(observedAt);

  const db = deps.db ?? getPrisma();

  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.participantPaymentAccount.findUnique({
        where: { participantId_provider: { participantId, provider } },
      });
      if (row === null) throw new PaymentAccountNotFoundError();

      if (row.providerAccountRef !== providerAccountRef) {
        throw new ProviderAccountRefMismatchError();
      }

      const from = row.readiness as PaymentReadinessStatus;
      if (from !== readiness && !isValidPaymentReadinessTransition(from, readiness)) {
        throw new InvalidPaymentReadinessTransitionError(from, readiness);
      }

      await tx.participantPaymentAccount.update({
        where: { id: row.id },
        data: { readiness, readinessObservedAt: at },
      });

      // Replace the outstanding set. Deleting first keeps this a statement of
      // what is outstanding NOW rather than an accumulation of everything the
      // provider has ever asked for.
      await tx.participantPaymentRequirementRow.deleteMany({
        where: { paymentAccountId: row.id },
      });
      for (const requirementCode of requirements) {
        await tx.participantPaymentRequirementRow.create({
          data: { paymentAccountId: row.id, requirementCode, observedAt: at },
        });
      }

      return await readAccountInTx(tx, participantId, provider);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new PaymentAccountPersistenceFailureError("recordObservedProviderState", error);
  }
}

/**
 * Ask the provider where an account stands, then persist the answer.
 *
 * The seam between the deferred adapter and durable Monacado state, and the
 * reason the two halves are separate functions: everything below the port is
 * persistence this phase implements and tests, while everything above it is the
 * concrete provider integration this phase does not begin.
 *
 * The port returns Monacado's vocabulary, never the provider's — mapping a
 * provider's requirement model onto `PaymentReadinessStatus` and
 * `PaymentRequirementCode` is the adapter's job, so nothing provider-shaped
 * reaches this function, the record, or a column.
 *
 * A transient port response is **not** Monacado state until
 * `recordObservedProviderState` commits it.
 */
export async function syncProviderReadiness(
  args: {
    participantId: string;
    provider: PaymentProvider;
    observedAt: string;
    port: PaymentProviderPort;
  },
  deps: PaymentAccountServiceDeps = {},
): Promise<ParticipantPaymentAccountRecord> {
  const current = await getParticipantPaymentAccount(args.participantId, args.provider, deps);
  const observation = await args.port.fetchReadiness(current.providerAccountRef);

  return await recordObservedProviderState(
    {
      participantId: args.participantId,
      provider: args.provider,
      providerAccountRef: observation.providerAccountRef,
      readiness: observation.readiness,
      outstandingRequirements: observation.outstandingRequirements,
      observedAt: args.observedAt,
    },
    deps,
  );
}

/**
 * The readiness the 0M.1 capability decisions consume for one participant.
 *
 * `NOT_STARTED` when no account has been linked — the same answer 0M.5 returned
 * from a constant, now true because nothing is stored rather than because
 * nothing could be.
 *
 * Refuses rather than chooses when two accounts exist. The value feeds
 * `canReceivePayout`, and picking one of two disagreeing providers is the
 * undecided reduction rule the registration path already refuses to create.
 */
export async function evaluateParticipantPaymentReadiness(
  participantId: string,
  deps: PaymentAccountServiceDeps = {},
): Promise<PaymentReadinessStatus> {
  const db = deps.db ?? getPrisma();
  try {
    return await readReadinessIn(db, participantId);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new PaymentAccountPersistenceFailureError("evaluateParticipantPaymentReadiness", error);
  }
}

/** Shared readiness read, usable inside and outside a transaction. */
export async function readReadinessIn(
  tx: Db | Prisma.TransactionClient,
  participantId: string,
): Promise<PaymentReadinessStatus> {
  const rows = await tx.participantPaymentAccount.findMany({ where: { participantId } });
  if (rows.length === 0) return INITIAL_PAYMENT_READINESS;
  if (rows.length > 1) throw new AmbiguousPaymentReadinessError();
  return rows[0]!.readiness as PaymentReadinessStatus;
}

/** Shared account read used inside and outside a transaction. */
async function readAccountInTx(
  tx: Db | Prisma.TransactionClient,
  participantId: string,
  provider: PaymentProvider,
): Promise<ParticipantPaymentAccountRecord> {
  const row = await tx.participantPaymentAccount.findUnique({
    where: { participantId_provider: { participantId, provider } },
  });
  if (row === null) throw new PaymentAccountNotFoundError();

  const requirements = await tx.participantPaymentRequirementRow.findMany({
    where: { paymentAccountId: row.id },
    orderBy: { requirementCode: "asc" },
  });

  return paymentAccountRowToRecord(row, requirements);
}
