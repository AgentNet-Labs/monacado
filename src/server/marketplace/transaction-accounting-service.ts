/**
 * MoR transaction accounting service (Phase 0M.T1) — SERVER ONLY.
 *
 * The narrow application boundary over the immutable per-sale economic snapshot.
 * Five operations: record a snapshot from persisted sources, read one, reconstruct
 * and verify its economics, attach the provider's transaction reference, and
 * advance settlement state.
 *
 * Six properties shape everything below:
 *
 *   1. **No arithmetic is implemented here.** `calculateSellerDirectEconomics`
 *      and `calculatePromotedListingEconomics` are 0M.4A's, consumed unchanged,
 *      and `toWholesaleAcquisitionPolicy` is 0M.R1's bridge from storage to the
 *      committed policy contract. There is still exactly one implementation of
 *      the MoR, commission, and promoter-spread arithmetic in this repository.
 *
 *   2. **Every input to the economics is read from the database.** The retail
 *      price, the transaction type, the Offer binding, the wholesale price, and
 *      the seller-funded commission all come from persisted versions — never from
 *      the caller. A caller-supplied number could disagree with the terms
 *      actually offered and accepted, which is the divergence the exact binding
 *      exists to prevent.
 *
 *   3. **The lookups are exact.** `getCommercialPolicyVersion` — 0M.R1's
 *      *exact-version* read, deliberately not `getEffective…` — and the Listing
 *      and Offer version rows are found by `(sourceRecordId, versionLabel)`. No
 *      current-version pointer is followed anywhere in this module.
 *
 *   4. **The accounting identity is checked before the write**, and a snapshot
 *      that does not reconcile is refused rather than recorded.
 *
 *   5. **Economic facts are never updated.** No operation here writes to
 *      `TransactionEconomicSnapshot` after its insert; every mutation targets the
 *      separate `TransactionSettlement` row. The split is the enforcement.
 *
 *   6. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected.
 *
 * **No Order is created, no checkout runs, no payment is initiated, no payout
 * moves, no tax is calculated or remitted, and no provider SDK, credential, or
 * endpoint is touched.** `0M.9` owns the Order; `0M.T2` owns tax execution and
 * reversal accounting.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  AdvanceTransactionSettlementInput,
  INITIAL_TRANSACTION_SETTLEMENT_STATE,
  RecordProviderTransactionReferenceInput,
  RecordTransactionEconomicSnapshotInput,
  TransactionAccountingError,
  isValidTransactionSettlementTransition,
  reconcileTransactionEconomics,
  type TransactionEconomicSnapshotRecord,
  type TransactionEconomics,
  type TransactionSettlementRecord,
  type TransactionSettlementState,
} from "../../contracts/marketplace/transaction-accounting";
import {
  ListingEconomicsError,
  calculatePromotedListingEconomics,
  calculateSellerDirectEconomics,
  type ListingSourceVersion,
  type MonacadoWholesaleAcquisitionPolicy,
} from "../../contracts/marketplace/listing-source";
import {
  CommercialPolicyError,
  toWholesaleAcquisitionPolicy,
} from "../../contracts/marketplace/commercial-policy";
import { getPrisma } from "../db/client";
import { getCommercialPolicyVersion } from "./commercial-policy-service";
import { CommercialPolicyVersionNotFoundError } from "./commercial-policy-errors";
import { versionRowToSourceVersion as listingVersionRowToSourceVersion } from "./listing-mapper";
import { versionRowToSourceVersion as offerVersionRowToSourceVersion } from "./offer-mapper";
import {
  cryptoTransactionSnapshotIdProvider,
  type TransactionSnapshotIdProvider,
} from "./transaction-accounting-ids";
import {
  CommercialPolicyVersionNotBindableError,
  CorruptTransactionRecordError,
  DuplicateProviderTransactionReferenceError,
  InvalidSettlementTransitionError,
  InvalidTransactionAccountingInputError,
  ListingSourceVersionNotFoundError,
  OfferSourceVersionNotFoundError,
  ProviderTransactionReferenceAlreadyRecordedError,
  TransactionAccountingPersistenceFailureError,
  TransactionCurrencyMismatchError,
  TransactionEconomicsDriftedError,
  TransactionEconomicsRefusedError,
  TransactionReconciliationRefusedError,
  TransactionSettlementNotFoundError,
  TransactionSnapshotNotFoundError,
} from "./transaction-accounting-errors";
import {
  economicsToColumns,
  settlementRowToRecord,
  snapshotRowToRecord,
} from "./transaction-accounting-mapper";

type Db = ReturnType<typeof getPrisma>;

/**
 * Anything that can read a row.
 *
 * The read helpers below use model delegates only — never `$transaction` — so a
 * `Prisma.TransactionClient` satisfies them exactly as the client does. This is
 * what lets `0M.9` compute and write a sale's economics inside its own
 * transaction without a second implementation existing.
 */
type Reader = Db | Prisma.TransactionClient;

export interface TransactionAccountingServiceDeps {
  db?: Db;
  ids?: TransactionSnapshotIdProvider;
}

/** A snapshot with its settlement standing. The two are always read together. */
export interface TransactionSnapshotView {
  snapshot: TransactionEconomicSnapshotRecord;
  settlement: TransactionSettlementRecord;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";
const isForeignKeyViolation = (e: unknown): boolean => prismaCode(e) === "P2003";

/** Errors that must escape a catch block unwrapped rather than be disguised. */
function isDomainError(error: unknown): boolean {
  return (
    error instanceof InvalidTransactionAccountingInputError ||
    error instanceof TransactionSnapshotNotFoundError ||
    error instanceof TransactionSettlementNotFoundError ||
    error instanceof ListingSourceVersionNotFoundError ||
    error instanceof OfferSourceVersionNotFoundError ||
    error instanceof CommercialPolicyVersionNotBindableError ||
    error instanceof CommercialPolicyVersionNotFoundError ||
    error instanceof TransactionCurrencyMismatchError ||
    error instanceof TransactionEconomicsRefusedError ||
    error instanceof TransactionReconciliationRefusedError ||
    error instanceof TransactionEconomicsDriftedError ||
    error instanceof InvalidSettlementTransitionError ||
    error instanceof ProviderTransactionReferenceAlreadyRecordedError ||
    error instanceof DuplicateProviderTransactionReferenceError ||
    error instanceof CorruptTransactionRecordError
  );
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidTransactionAccountingInputError {
  return new InvalidTransactionAccountingInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

// — Reading the bound authoritative sources —

/**
 * Read one **exact** Listing source version.
 *
 * The stable row supplies the source-record identity; the version is then found
 * by `(listingSourceRecordId, sourceRecordVersion)`. The Listing's
 * `currentSourceRecordVersion` pointer is deliberately never consulted — a sale
 * ran under the terms named, not under whatever the Listing says today.
 */
async function readExactListingVersion(
  db: Reader,
  internalListingId: string,
  listingSourceRecordVersion: string,
): Promise<{ sourceVersion: ListingSourceVersion; listingSourceRecordId: string }> {
  const stable = await db.listing.findUnique({ where: { internalListingId } });
  if (stable === null) throw new ListingSourceVersionNotFoundError();

  const row = await db.listingSourceRecordVersionRow.findUnique({
    where: {
      listingSourceRecordId_sourceRecordVersion: {
        listingSourceRecordId: stable.listingSourceRecordId,
        sourceRecordVersion: listingSourceRecordVersion,
      },
    },
  });
  if (row === null) throw new ListingSourceVersionNotFoundError();

  return {
    sourceVersion: listingVersionRowToSourceVersion(row),
    listingSourceRecordId: stable.listingSourceRecordId,
  };
}

/**
 * Read the **exact** commercial policy version as the committed economics contract.
 *
 * 0M.R1's exact-version lookup, reused rather than reimplemented — and
 * deliberately not `getEffectiveWholesaleAcquisitionPolicy`, because a function
 * named "the current policy" must never be the one a transaction binds through.
 * A `DRAFT` version is refused by the committed bridge: nothing ever ran under
 * one, so it may not price a sale. A `RETIRED` version resolves normally.
 */
async function readExactPolicy(
  db: Reader,
  policyId: string,
  policyVersion: string,
): Promise<MonacadoWholesaleAcquisitionPolicy> {
  /* 0M.R1's exact-version read performs `findUnique` and nothing else, so a
     transaction client satisfies it; the cast is narrow and deliberate rather
     than a widening of that service's own dependency type, which would let a
     caller hand a transaction client to `activateCommercialPolicyVersion` — a
     function that genuinely does open one. */
  const version = await getCommercialPolicyVersion(policyId, policyVersion, {
    db: db as Db,
  });
  try {
    return toWholesaleAcquisitionPolicy(version);
  } catch (error) {
    if (error instanceof CommercialPolicyError) {
      throw new CommercialPolicyVersionNotBindableError(error);
    }
    throw error;
  }
}

/**
 * The seller-funded commission for a promoted sale, from the **exact** Offer
 * source version the Listing bound to.
 *
 * The Offer stays authoritative for its own wholesale price and commission, and
 * neither is recomputed here. The accepted wholesale price recorded on the
 * Listing version is cross-checked against the Offer version's own: they were
 * written from the same row by 0M.7, so a disagreement means a corrupt record
 * rather than a business condition, and it must fail loudly instead of paying
 * somebody a number nobody agreed to.
 */
async function readAcceptedOfferCommission(
  db: Reader,
  dependency: {
    offerSourceRecordId: string;
    acceptedOfferSourceRecordVersion: string;
    acceptedWholesalePriceMinorUnits: number;
    acceptedWholesalePriceCurrency: string;
  },
): Promise<number> {
  const row = await db.offerSourceRecordVersionRow.findUnique({
    where: {
      offerSourceRecordId_sourceRecordVersion: {
        offerSourceRecordId: dependency.offerSourceRecordId,
        sourceRecordVersion: dependency.acceptedOfferSourceRecordVersion,
      },
    },
  });
  if (row === null) throw new OfferSourceVersionNotFoundError();

  /* Reconstructed through 0M.6's own mapper, so a corrupt Offer row fails there
     rather than producing economics nobody could have agreed to. */
  const offer = offerVersionRowToSourceVersion(row);

  if (offer.terms.price.type !== "PAID") {
    /* 0M.7 refuses a promoted Listing over a FREE Offer, so this is unreachable
       through the service; refused rather than treated as a zero wholesale. */
    throw new TransactionEconomicsRefusedError("OFFER_NOT_PAID");
  }
  if (
    offer.terms.price.wholesalePriceMinorUnits !==
      dependency.acceptedWholesalePriceMinorUnits ||
    offer.terms.price.wholesalePriceCurrency !== dependency.acceptedWholesalePriceCurrency
  ) {
    throw new CorruptTransactionRecordError(["acceptedWholesalePriceMinorUnits"]);
  }

  return offer.economics.calculatedCommissionMinorUnits;
}

// — Computing the economics —

/**
 * Compute one sale's economics from the bound authoritative sources.
 *
 * The single place storage meets 0M.4A's calculators. Both refusals the
 * calculators can raise — an unsellable price, negative promoter proceeds, a
 * commission exceeding wholesale — are surfaced with the calculator's own bounded
 * code rather than rewritten.
 */
async function computeEconomics(
  db: Reader,
  input: {
    sourceVersion: ListingSourceVersion;
    policy: MonacadoWholesaleAcquisitionPolicy;
    currency: string;
    occurredAt: string;
  },
): Promise<{ commercialRetailAmountMinorUnits: number; economics: TransactionEconomics }> {
  const placement = input.sourceVersion.placement;

  if (placement.retail.retailPriceCurrency !== input.currency) {
    throw new TransactionCurrencyMismatchError("listingRetailCurrency");
  }
  if (input.policy.currency !== input.currency) {
    throw new TransactionCurrencyMismatchError("policyCurrency");
  }

  try {
    if (placement.listingType === "SELLER_DIRECT") {
      /* The EFFECTIVE price at the instant of sale: a scheduled sale window makes
         the sale price the commercial retail basis, and 0M.4A derives that from
         the persisted schedule plus a supplied instant. Nothing is stored for it. */
      const result = calculateSellerDirectEconomics({
        placement,
        now: input.occurredAt,
        policy: input.policy,
      });
      return {
        commercialRetailAmountMinorUnits: result.effectiveCommercialRetailPriceMinorUnits,
        economics: {
          transactionType: "SELLER_DIRECT",
          monacadoRetainedAmountMinorUnits: result.monacadoRetainedAmountMinorUnits,
          morWholesaleAcquisitionAmountMinorUnits:
            result.morWholesaleAcquisitionAmountMinorUnits,
          sellerProceedsMinorUnits: result.sellerProceedsMinorUnits,
        },
      };
    }

    const dependency = placement.offerDependency;
    const sellerFundedCommissionMinorUnits = await readAcceptedOfferCommission(db, dependency);

    /* A promoted Listing has no sale schedule — 0M.4A gives that branch no field
       for one — so the promoter's retail price IS the commercial retail basis. */
    const retail = placement.retail.retailPriceMinorUnits;
    const result = calculatePromotedListingEconomics({
      commercialRetailPriceMinorUnits: retail,
      currency: input.currency,
      offerWholesalePriceMinorUnits: dependency.acceptedWholesalePriceMinorUnits,
      offerWholesalePriceCurrency: dependency.acceptedWholesalePriceCurrency,
      sellerFundedCommissionMinorUnits,
      policy: input.policy,
    });

    return {
      commercialRetailAmountMinorUnits: retail,
      economics: {
        transactionType: "PROMOTED",
        offerBinding: {
          internalOfferId: dependency.internalOfferId,
          offerSourceRecordId: dependency.offerSourceRecordId,
          offerSourceRecordVersion: dependency.acceptedOfferSourceRecordVersion,
        },
        monacadoRetainedAmountMinorUnits: result.monacadoRetainedAmountMinorUnits,
        morWholesaleAcquisitionAmountMinorUnits:
          result.morWholesaleAcquisitionAmountMinorUnits,
        offerWholesalePriceMinorUnits: result.offerWholesalePriceMinorUnits,
        sellerFundedCommissionMinorUnits: result.sellerFundedCommissionMinorUnits,
        promoterRetailSpreadMinorUnits: result.promoterRetailSpreadMinorUnits,
        promoterNetProceedsMinorUnits: result.promoterNetProceedsMinorUnits,
        sellerProceedsMinorUnits: result.sellerProceedsMinorUnits,
      },
    };
  } catch (error) {
    if (error instanceof ListingEconomicsError) {
      throw new TransactionEconomicsRefusedError(error.code);
    }
    throw error;
  }
}

/** Check the accounting identity, and refuse rather than record an imbalance. */
function requireReconciled(input: {
  commercialRetailAmountMinorUnits: number;
  economics: TransactionEconomics;
}): void {
  try {
    reconcileTransactionEconomics(input);
  } catch (error) {
    if (error instanceof TransactionAccountingError) {
      throw new TransactionReconciliationRefusedError(error.code);
    }
    throw error;
  }
}

// — Operations —

/**
 * Record one sale's economics, with its settlement row, in a single transaction.
 *
 * The retail price is **not** a parameter: it is the effective price of the bound
 * Listing source version at `occurredAt`. Neither is the transaction type, the
 * Offer binding, the wholesale price, or the seller-funded commission — all are
 * read from the versions the Listing itself binds to.
 *
 * Both rows commit together or neither does. A snapshot without settlement
 * standing would be a financial record nobody could reconcile; a settlement row
 * without economics would be standing about nothing.
 *
 * **No Order is created and no payment is initiated.** The settlement row opens at
 * `PENDING` with no provider reference, because at this point nothing has been
 * charged.
 */
export async function recordTransactionEconomicSnapshot(
  input: unknown,
  deps: TransactionAccountingServiceDeps = {},
): Promise<TransactionSnapshotView> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoTransactionSnapshotIdProvider;
  try {
    return await db.$transaction((tx) =>
      recordTransactionEconomicSnapshotInTx(tx, input, ids),
    );
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isForeignKeyViolation(error)) throw new ListingSourceVersionNotFoundError(error);
    throw new TransactionAccountingPersistenceFailureError(
      "recordTransactionEconomicSnapshot",
      error,
    );
  }
}

/**
 * The whole of the above, inside a transaction a caller already holds.
 *
 * **Exported for `0M.9`**, whose successful-sale path must write the snapshot,
 * its settlement row, the proceeds obligations, the purchase evidence, and the
 * Order's move to `PAID` as one atomic act. A `PAID` Order without economics, or
 * economics without an Order, must be impossible rather than unlikely — and that
 * requires one transaction, which requires this entry point.
 *
 * It takes a `Prisma.TransactionClient` precisely so a caller cannot use it to
 * write outside a transaction by accident. Everything it does is identical to the
 * public function: the same reads, the same committed calculators, the same
 * reconciliation check before any row exists.
 */
export async function recordTransactionEconomicSnapshotInTx(
  tx: Prisma.TransactionClient,
  input: unknown,
  ids: TransactionSnapshotIdProvider = cryptoTransactionSnapshotIdProvider,
): Promise<TransactionSnapshotView> {
  const parsed = RecordTransactionEconomicSnapshotInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const v = parsed.data;

  const { sourceVersion, listingSourceRecordId } = await readExactListingVersion(
    tx,
    v.internalListingId,
    v.listingSourceRecordVersion,
  );
  const policy = await readExactPolicy(tx, v.policyId, v.policyVersion);

  const { commercialRetailAmountMinorUnits, economics } = await computeEconomics(tx, {
    sourceVersion,
    policy,
    currency: v.currency,
    occurredAt: v.occurredAt,
  });
  requireReconciled({ commercialRetailAmountMinorUnits, economics });

  const snapshotId = ids.nextSnapshotId();

  const snapshotRow = await tx.transactionEconomicSnapshot.create({
    data: {
      id: snapshotId,
      internalListingId: v.internalListingId,
      listingSourceRecordId,
      listingSourceRecordVersion: v.listingSourceRecordVersion,
      policyId: v.policyId,
      policyVersion: v.policyVersion,
      currency: v.currency,
      commercialRetailAmountMinorUnits: BigInt(commercialRetailAmountMinorUnits),
      ...economicsToColumns(economics),
      taxAmountMinorUnits: BigInt(v.taxAmountMinorUnits),
      shippingAmountMinorUnits: BigInt(v.shippingAmountMinorUnits),
      otherPassThroughAmountMinorUnits: BigInt(v.otherPassThroughAmountMinorUnits),
      occurredAt: new Date(v.occurredAt),
      recordedAt: new Date(v.recordedAt),
    },
  });

  const settlementRow = await tx.transactionSettlement.create({
    data: {
      snapshotId,
      state: INITIAL_TRANSACTION_SETTLEMENT_STATE,
      provider: null,
      providerTransactionRef: null,
    },
  });

  return {
    snapshot: snapshotRowToRecord(snapshotRow),
    settlement: settlementRowToRecord(settlementRow),
  };
}

/** Read one snapshot with its settlement standing. */
export async function getTransactionEconomicSnapshot(
  snapshotId: string,
  deps: TransactionAccountingServiceDeps = {},
): Promise<TransactionSnapshotView> {
  const db = deps.db ?? getPrisma();
  try {
    const snapshotRow = await db.transactionEconomicSnapshot.findUnique({
      where: { id: snapshotId },
    });
    if (snapshotRow === null) throw new TransactionSnapshotNotFoundError();

    const settlementRow = await db.transactionSettlement.findUnique({
      where: { snapshotId },
    });
    if (settlementRow === null) throw new TransactionSettlementNotFoundError();

    return {
      snapshot: snapshotRowToRecord(snapshotRow),
      settlement: settlementRowToRecord(settlementRow),
    };
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new TransactionAccountingPersistenceFailureError(
      "getTransactionEconomicSnapshot",
      error,
    );
  }
}

/**
 * Recompute a stored snapshot's economics from its bound sources and verify they
 * still match.
 *
 * **The proof that the exact binding works.** It re-reads the same Listing
 * version, the same Offer version, and the same policy version the snapshot names,
 * re-runs the committed calculators at the snapshot's own `occurredAt`, and
 * compares every stored amount. Because all three bindings name immutable
 * versions, a later Listing price, a renegotiated Offer, or a new commercial
 * policy changes nothing here — which is exactly what this asserts.
 *
 * A mismatch is `TransactionEconomicsDriftedError` naming the fields, never a
 * repair: a financial record that disagrees with its own sources is a fault to
 * surface, not a value to overwrite.
 */
export async function reconstructTransactionEconomics(
  snapshotId: string,
  deps: TransactionAccountingServiceDeps = {},
): Promise<{ snapshot: TransactionEconomicSnapshotRecord; matches: true }> {
  const db = deps.db ?? getPrisma();
  const { snapshot } = await getTransactionEconomicSnapshot(snapshotId, deps);

  try {
    const { sourceVersion } = await readExactListingVersion(
      db,
      snapshot.listingBinding.internalListingId,
      snapshot.listingBinding.listingSourceRecordVersion,
    );
    const policy = await readExactPolicy(
      db,
      snapshot.policyBinding.policyId,
      snapshot.policyBinding.policyVersion,
    );

    const recomputed = await computeEconomics(db, {
      sourceVersion,
      policy,
      currency: snapshot.currency,
      occurredAt: snapshot.occurredAt,
    });

    const drifted: string[] = [];
    if (
      recomputed.commercialRetailAmountMinorUnits !== snapshot.commercialRetailAmountMinorUnits
    ) {
      drifted.push("commercialRetailAmountMinorUnits");
    }

    const stored = snapshot.economics;
    const fresh = recomputed.economics;
    if (fresh.transactionType !== stored.transactionType) {
      drifted.push("transactionType");
    } else {
      for (const [key, value] of Object.entries(fresh)) {
        if (key === "transactionType") continue;
        const storedValue = (stored as Record<string, unknown>)[key];
        /* The Offer binding is a nested object; compared componentwise so a
           drifted version label is named rather than reported as "offerBinding". */
        if (key === "offerBinding") {
          const a = value as Record<string, string>;
          const b = (storedValue ?? {}) as Record<string, string>;
          for (const component of Object.keys(a)) {
            if (a[component] !== b[component]) drifted.push(`offerBinding.${component}`);
          }
          continue;
        }
        if (storedValue !== value) drifted.push(key);
      }
    }

    /* The identity is re-checked on the stored values too: a snapshot that stopped
       reconciling would be a fault even if it still matched its sources. */
    requireReconciled({
      commercialRetailAmountMinorUnits: snapshot.commercialRetailAmountMinorUnits,
      economics: stored,
    });

    if (drifted.length > 0) throw new TransactionEconomicsDriftedError(drifted);
    return { snapshot, matches: true };
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new TransactionAccountingPersistenceFailureError(
      "reconstructTransactionEconomics",
      error,
    );
  }
}

/**
 * Attach the provider's own transaction reference to a snapshot's settlement row.
 *
 * **Write-once**, and on the settlement row alone — the economic snapshot is not
 * touched. A recorded reference is the evidence of *which* external transaction
 * this sale is, and replacing it would silently re-point a financial record at a
 * different one.
 *
 * No provider is contacted. This records evidence a caller already holds; the
 * concrete provider adapter and the reconciliation workflow that would use it are
 * deferred, as 0M.8 deferred the onboarding adapter.
 */
export async function recordProviderTransactionReference(
  input: unknown,
  deps: TransactionAccountingServiceDeps = {},
): Promise<TransactionSettlementRecord> {
  const parsed = RecordProviderTransactionReferenceInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { snapshotId, provider, providerTransactionRef, recordedAt } = parsed.data;

  const db = deps.db ?? getPrisma();

  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.transactionSettlement.findUnique({ where: { snapshotId } });
      if (current === null) throw new TransactionSnapshotNotFoundError();
      if (current.providerTransactionRef !== null) {
        throw new ProviderTransactionReferenceAlreadyRecordedError();
      }

      const row = await tx.transactionSettlement.update({
        where: { snapshotId },
        data: {
          provider,
          providerTransactionRef,
          providerReferenceRecordedAt: new Date(recordedAt),
        },
      });
      return settlementRowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) throw new DuplicateProviderTransactionReferenceError(error);
    throw new TransactionAccountingPersistenceFailureError(
      "recordProviderTransactionReference",
      error,
    );
  }
}

/** Which instant column one settlement state stamps. `PENDING` is never a target. */
const SETTLEMENT_INSTANT_COLUMN: Record<
  Exclude<TransactionSettlementState, "PENDING">,
  "fundsReceivedAt" | "settledAt" | "reversedAt"
> = Object.freeze({
  FUNDS_RECEIVED: "fundsReceivedAt",
  SETTLED: "settledAt",
  REVERSED: "reversedAt",
});

/**
 * Advance a snapshot's settlement state, stamping the instant that state records.
 *
 * The economics are untouched — this writes to the settlement row only, which is
 * the whole reason the two tables are separate.
 *
 * `REVERSED` records **only** that the funds movement was undone. No reversal
 * amount is computed, nothing is recovered from seller or promoter economics, and
 * no refund-versus-chargeback distinction is drawn: that accounting is `0M.T2`
 * and will be its own entry rather than an edit to this one.
 */
export async function advanceTransactionSettlement(
  input: unknown,
  deps: TransactionAccountingServiceDeps = {},
): Promise<TransactionSettlementRecord> {
  const parsed = AdvanceTransactionSettlementInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { snapshotId, to, at } = parsed.data;

  const db = deps.db ?? getPrisma();

  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.transactionSettlement.findUnique({ where: { snapshotId } });
      if (current === null) throw new TransactionSnapshotNotFoundError();

      const from = current.state as TransactionSettlementState;
      if (!isValidTransactionSettlementTransition(from, to)) {
        throw new InvalidSettlementTransitionError(from, to);
      }

      const column = SETTLEMENT_INSTANT_COLUMN[to as Exclude<TransactionSettlementState, "PENDING">];
      const row = await tx.transactionSettlement.update({
        where: { snapshotId },
        data: { state: to, [column]: new Date(at) },
      });
      return settlementRowToRecord(row);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new TransactionAccountingPersistenceFailureError(
      "advanceTransactionSettlement",
      error,
    );
  }
}
