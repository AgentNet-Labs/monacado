/**
 * Buyer refund persistence (Phase 1.9) — SERVER ONLY.
 *
 * Five operations, and the ordering between them is the whole guarantee:
 *
 * ```
 * evaluateRefundEligibility     ← reads only; every refusal, before anything exists
 * requestOrderRefund            ← commits PENDING. No provider is contacted.
 *      … a worker claims it …
 * claimDueRefunds
 *      … the provider is called OUTSIDE any transaction …
 * resolveRefundAttempt          ← REFUNDED | RETRY_PENDING | FAILED_PERMANENT
 *   └─ on REFUNDED, ONE transaction also writes the 1.2 accounting entry, moves
 *      the settlement row to REVERSED, commits the tax-reversal obligation, and
 *      raises any proceeds recovery exceptions.
 * ```
 *
 * ## Why the provider call is outside the transaction
 *
 * Calling Stripe inside a database transaction would hold a lock across a network
 * round trip and, worse, would mean a provider timeout rolled back Monacado's
 * record that it owes a buyer their money. `1.7`'s rule, applied in the other
 * direction: the obligation stands, and the unexecuted refund becomes durable
 * work.
 *
 * ## Why success commits five things at once
 *
 * The opposite trade-off, and for the opposite reason. Once the provider has
 * returned the funds, every consequence must land together or none of them can be
 * trusted: a buyer with their money and a settlement row still saying the sale
 * stands is a window in which a payout can be authorised on a refunded sale.
 * There is no provider call inside that transaction, so nothing about it is slow
 * or externally dependent.
 *
 * ## Immutable request-time facts
 *
 * `IMMUTABLE_REFUND_FIELDS` names what `requestOrderRefund` writes once.
 * `resolveRefundAttempt` writes only lifecycle columns and the two provider
 * fields that do not exist until the provider answers. A test asserts the
 * boundary holds across a retry.
 *
 * ## The claim
 *
 * Exactly `1.5`'s and `1.7`'s technique, reused rather than reinvented: one
 * guarded `updateMany` re-asserts eligibility and stamps a lock token, then the
 * rows are read back **by that token**. Two workers cannot claim one row. A live
 * claim is never stolen — this is lease *expiry*, not lock stealing.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  INITIAL_REFUND_STATUS,
  OrderRefundRecord,
  RefundEligibility,
  REFUND_RETRY_POLICY,
  classifyRefundFailure,
  deriveRefundAmount,
  nextRefundAttemptAt,
  refundIsCoherent,
  refundLifecycleState,
  requiresTaxReversal,
  reversalReasonForRefund,
  singleOrderLineRef,
  type RefundableOrderLine,
  type RefundFailureCode,
  type RefundLifecycleState,
  type RefundReasonCode,
  type RefundRefusalCode,
  type RefundRequestorKind,
} from "../../contracts/marketplace/order-refund";
import {
  refundWindowIsOpen,
  type SellerRefundPolicyVersionRecord,
  type ShippingRefundability,
} from "../../contracts/marketplace/seller-refund-policy";
import { readSellerRefundPolicyVersionIn } from "./seller-refund-policy-service";
import {
  INITIAL_PROCEEDS_RECOVERY_STATUS,
  recoveryReasonForObligationState,
} from "../../contracts/marketplace/proceeds-recovery";
import {
  INITIAL_TAX_REVERSAL_STATUS,
  REVERSED_TAX_TRANSACTION_LIFECYCLE_STATE,
  taxReversalProviderReference,
  type TaxReversalStatus,
} from "../../contracts/marketplace/tax-reversal";
import { getPrisma } from "../db/client";
import { cryptoRefundIdProvider, type RefundIdProvider } from "./refund-ids";
import {
  RefundAlreadyExistsError,
  RefundError,
  RefundPersistenceFailureError,
  RefundRefusedError,
} from "./refund-errors";
import { recordFullReversalInTx } from "./transaction-reversal-service";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";

export interface RefundServiceDeps {
  db?: Db;
  ids?: RefundIdProvider;
}

// — Mapping —

/**
 * The lines every read of a refund must bring with it.
 *
 * Declared once and spread into every query, so a code path cannot read a refund
 * without knowing what it returned. `lineRefs` is part of the record's identity —
 * a refund whose unit nobody could name would be exactly the ambiguity this
 * correction removed.
 */
const WITH_LINES = {
  lines: { select: { lineRef: true }, orderBy: { lineRef: "asc" } },
} as const;

interface RefundRow {
  id: string;
  orderId: string;
  snapshotId: string;
  scope: string;
  coversWholeOrder: boolean;
  sellerRefundPolicyId: string;
  sellerRefundPolicyVersion: string;
  reasonCode: string;
  requestorKind: string;
  requestedByAccountId: string | null;
  requestedAt: Date;
  provider: string;
  providerMode: string;
  providerTransactionRef: string;
  providerRefundRef: string | null;
  providerRefundCreatedAt: Date | null;
  currency: string;
  amountMinorUnits: bigint;
  linesRetailMinorUnits: bigint;
  linesTaxMinorUnits: bigint;
  refundedShippingMinorUnits: bigint;
  recordedAt: Date;
  status: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastFailureCode: string | null;
  lastFailureClass: string | null;
  finalizedAt: Date | null;
  requeueCount: number;
  lastRequeuedAt: Date | null;
  reversalId: string | null;
  updatedAt: Date;
}

/** A row plus its lines, as every query returns it. */
type RefundRowWithLines = RefundRow & { lines: Array<{ lineRef: string }> };

export function refundRowToRecord(
  row: RefundRow,
  lineRefs: readonly string[],
): OrderRefundRecord {
  const parsed = OrderRefundRecord.safeParse({
    refundId: row.id,
    orderId: row.orderId,
    snapshotId: row.snapshotId,
    scope: row.scope,
    lineRefs: [...lineRefs],
    coversWholeOrder: row.coversWholeOrder,
    sellerRefundPolicyId: row.sellerRefundPolicyId,
    sellerRefundPolicyVersion: row.sellerRefundPolicyVersion,
    reasonCode: row.reasonCode,
    requestorKind: row.requestorKind,
    requestedByAccountId: row.requestedByAccountId,
    requestedAt: row.requestedAt.toISOString(),
    provider: row.provider,
    providerMode: row.providerMode,
    providerTransactionRef: row.providerTransactionRef,
    providerRefundRef: row.providerRefundRef,
    providerRefundCreatedAt:
      row.providerRefundCreatedAt === null ? null : row.providerRefundCreatedAt.toISOString(),
    currency: row.currency,
    amountMinorUnits: Number(row.amountMinorUnits),
    linesRetailMinorUnits: Number(row.linesRetailMinorUnits),
    linesTaxMinorUnits: Number(row.linesTaxMinorUnits),
    refundedShippingMinorUnits: Number(row.refundedShippingMinorUnits),
    recordedAt: row.recordedAt.toISOString(),
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt === null ? null : row.nextAttemptAt.toISOString(),
    lastFailureCode: row.lastFailureCode,
    lastFailureClass: row.lastFailureClass,
    finalizedAt: row.finalizedAt === null ? null : row.finalizedAt.toISOString(),
    requeueCount: row.requeueCount,
    lastRequeuedAt: row.lastRequeuedAt === null ? null : row.lastRequeuedAt.toISOString(),
    reversalId: row.reversalId,
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new RefundError("CORRUPT_REFUND_RECORD", "A persisted refund row is malformed");
  }
  return parsed.data;
}

/** The common case: a row read with its lines included. */
function withLinesToRecord(row: RefundRowWithLines): OrderRefundRecord {
  return refundRowToRecord(row, row.lines.map((l) => l.lineRef));
}

// — Lines —

/**
 * Every refundable line on one Order, with its **sale-time** economics.
 *
 * ## Today: exactly one line, derived rather than stored
 *
 * An Order binds one Listing (`0M.9`), so it has one line. There is no
 * `OrderLine` table to read, and this phase deliberately does not build one — the
 * correction it implements is that the refund *policy* stops assuming one line,
 * not that the Order model gains a basket it has no other use for yet.
 *
 * So the line is composed from the Order's own durable quote: its merchandise
 * amount, its tax, and the exact Listing source version it was sold under. Every
 * figure is what the buyer was actually charged.
 *
 * ## What changes when the basket arrives
 *
 * This function starts reading `OrderLine` rows and returns several. **Nothing
 * above it changes**: callers already treat the result as a list, select from it,
 * and derive amounts per line. That is the whole point of routing today's single
 * line through the same shape.
 *
 * ## Shipping is not here
 *
 * One charge for one carriage, governed at Order level by the seller's policy.
 * Attaching a share of it to a line would be the proration
 * `SHIPPING_ALLOCATION_SEAM` refuses.
 */
export async function resolveRefundableOrderLines(
  orderId: string,
  deps: RefundServiceDeps = {},
): Promise<RefundableOrderLine[]> {
  const db = deps.db ?? getPrisma();
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      currency: true,
      internalProductId: true,
      listingSourceRecordId: true,
      listingSourceRecordVersion: true,
      quotedCommercialRetailAmountMinorUnits: true,
      quotedTaxAmountMinorUnits: true,
    },
  });
  if (order === null) return [];

  return [
    {
      lineRef: singleOrderLineRef(order.id),
      internalProductId: order.internalProductId,
      listingSourceRecordId: order.listingSourceRecordId,
      listingSourceRecordVersion: order.listingSourceRecordVersion,
      currency: order.currency,
      /* The Order's own quote — what the buyer was told they would be charged,
         and what the successful-sale path asserted the snapshot equalled. Never
         recomputed from a current Listing or commercial policy. */
      commercialRetailAmountMinorUnits: Number(order.quotedCommercialRetailAmountMinorUnits),
      /* Today the Order's whole tax is this line's tax, because there is one
         line. NOT a proportional split — when a second line exists, each line's
         tax comes from its own sale-time evidence, and nothing here would be
         reinterpreted as an allocation rule. */
      taxAmountMinorUnits: Number(order.quotedTaxAmountMinorUnits),
    },
  ];
}

// — Eligibility —

/**
 * May this Order be refunded, for which lines, and for how much?
 *
 * **Reads only.** Nothing is written, no provider is contacted, and every refusal
 * is reported rather than the first — an Order that is both unpaid *and* missing
 * a provider reference has two problems.
 *
 * ## The caller selects lines, never an amount
 *
 * `selectedLineRefs` names whole lines. There is no monetary parameter, so a
 * caller cannot ask for a figure of its own — and `requestedAmountMinorUnits`
 * exists **only so a caller who tries anyway is refused**
 * `PARTIAL_LINE_REFUND_NOT_SUPPORTED`. It is compared and discarded; it never
 * reaches a provider, a row, or the amount returned.
 *
 * Omitting `selectedLineRefs` selects **every** line, which is the ordinary case
 * and, today, the only executable one.
 *
 * ## Every figure comes from durable sale-time evidence and the bound policy
 *
 * Line economics come from the Order's own quote; shipping refundability comes
 * from the **seller refund-policy version bound at checkout**, never the seller's
 * current one. A refund priced from today's data or today's terms would return a
 * figure the buyer was never charged under terms they were never shown — and
 * both would look entirely correct.
 */
export async function evaluateRefundEligibility(
  args: {
    orderId: string;
    at: string;
    /** Whole lines. Omit to select every line on the Order. */
    selectedLineRefs?: readonly string[];
    /** The reason, because shipping refundability can depend on it. */
    reasonCode?: RefundReasonCode;
    /** Supplied ONLY so an arbitrary per-line amount can be refused. */
    requestedAmountMinorUnits?: number;
  },
  deps: RefundServiceDeps = {},
): Promise<RefundEligibility> {
  const db = deps.db ?? getPrisma();
  const refusals: RefundRefusalCode[] = [];
  const reasonCode: RefundReasonCode = args.reasonCode ?? "CUSTOMER_REQUEST";

  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: {
      id: true,
      lifecycle: true,
      currency: true,
      paidAt: true,
      sellerRefundPolicyId: true,
      sellerRefundPolicyVersion: true,
      quotedShippingAmountMinorUnits: true,
      quotedOtherPassThroughAmountMinorUnits: true,
    },
  });
  if (order === null) {
    return RefundEligibility.parse({
      orderId: args.orderId,
      eligible: false,
      refusals: ["ORDER_NOT_FOUND"],
      orderLines: [],
      selectedLineRefs: [],
      coversWholeOrder: false,
      refundableAmountMinorUnits: null,
      linesRetailMinorUnits: null,
      linesTaxMinorUnits: null,
      refundableShippingMinorUnits: null,
      shippingRefundable: null,
      sellerRefundPolicyId: null,
      sellerRefundPolicyVersion: null,
      currency: null,
      providerTransactionRef: null,
      provider: null,
      snapshotId: null,
      evaluatedAt: args.at,
    });
  }

  /* Nothing was taken, so nothing comes back. An unpaid Order is not a refund
     that failed — it is a sale that never happened. */
  if (order.lifecycle !== "PAID") refusals.push("ORDER_NOT_PAID");

  const snapshot = await db.transactionEconomicSnapshot.findUnique({
    where: { orderId: args.orderId },
    select: { id: true, currency: true },
  });
  if (snapshot === null) refusals.push("ECONOMIC_SNAPSHOT_MISSING");

  const settlement =
    snapshot === null
      ? null
      : await db.transactionSettlement.findUnique({
          where: { snapshotId: snapshot.id },
          select: { provider: true, providerTransactionRef: true, state: true },
        });

  const providerTransactionRef = settlement?.providerTransactionRef ?? null;
  const provider = settlement?.provider ?? null;
  if (providerTransactionRef === null || provider === null) {
    /* A paid Order whose settlement row never received the provider's evidence.
       There is no charge to name, and inventing one is not available. */
    refusals.push("PROVIDER_PAYMENT_REFERENCE_MISSING");
  }

  const existingRefund = await db.orderRefund.count({ where: { orderId: args.orderId } });
  if (existingRefund > 0) refusals.push("REFUND_ALREADY_EXISTS");

  if (snapshot !== null) {
    const reversed = await db.transactionReversal.count({ where: { snapshotId: snapshot.id } });
    /* A `1.2` entry with no `1.9` refund row means the sale was reversed by some
       other route — a chargeback, or an operator's direct accounting entry.
       Refunding it again would be a second credit. */
    if (reversed > 0 && existingRefund === 0) refusals.push("SALE_ALREADY_REVERSED");
    if (snapshot.currency !== order.currency) refusals.push("CURRENCY_MISMATCH");
    if (settlement !== null && settlement.state === "REVERSED" && existingRefund === 0) {
      refusals.push("CONFLICTING_REFUND_STATE");
    }
  }

  // — The seller's bound terms —

  /* THE VERSION THE ORDER BINDS, never the seller's current one. A seller who
     tightens their policy tomorrow does not retroactively tighten it for
     yesterday's buyer. */
  let policy: SellerRefundPolicyVersionRecord | null = null;
  if (order.sellerRefundPolicyId === null || order.sellerRefundPolicyVersion === null) {
    /* A pre-correction Order. Nothing is backfilled and today's terms are NOT
       substituted: refunding under terms the buyer was never shown would be
       worse than refusing, because it would look governed. */
    refusals.push("SELLER_REFUND_POLICY_NOT_BOUND");
  } else {
    try {
      policy = await readSellerRefundPolicyVersionIn(
        db,
        order.sellerRefundPolicyId,
        order.sellerRefundPolicyVersion,
      );
    } catch {
      /* The version's content no longer hashes to what the row claims. Refused
         rather than shown — the error's own detail is discarded here because
         this result is rendered to operators. */
      policy = null;
    }
    if (policy === null) {
      refusals.push("SELLER_REFUND_POLICY_UNREADABLE");
    } else {
      if (!policy.terms.refundsAllowed) {
        /* The seller's declared position. Monacado retains operational authority
           to refund anyway — see MARKETPLACE_REFUND_POSTURE — but that is an
           explicit override, not something this evaluation grants silently. */
        refusals.push("SELLER_REFUND_POLICY_FORBIDS_REFUND");
      }
      if (
        order.paidAt !== null &&
        !refundWindowIsOpen({
          refundWindowDays: policy.terms.refundWindowDays,
          paidAt: order.paidAt.toISOString(),
          at: args.at,
        })
      ) {
        refusals.push("SELLER_REFUND_WINDOW_EXPIRED");
      }
    }
  }

  // — The lines —

  const orderLines = await resolveRefundableOrderLines(args.orderId, { db });
  const requested = args.selectedLineRefs ?? orderLines.map((l) => l.lineRef);

  const selectedLines: RefundableOrderLine[] = [];
  for (const ref of requested) {
    const line = orderLines.find((l) => l.lineRef === ref);
    if (line === undefined) {
      refusals.push("REFUND_LINE_NOT_FOUND");
      continue;
    }
    if (!selectedLines.some((l) => l.lineRef === ref)) selectedLines.push(line);
  }
  if (selectedLines.length === 0 && !refusals.includes("REFUND_LINE_NOT_FOUND")) {
    refusals.push("NO_REFUND_LINES_SELECTED");
  }

  const coversWholeOrder =
    orderLines.length > 0 && selectedLines.length === orderLines.length;

  /* A SUBSET of lines is permitted by policy and not yet executable: there is no
     OrderLine table, `TransactionReversal` has only `FULL`, and no line-level
     provider tax evidence exists. FAIL CLOSED rather than approximate.
     Unreachable while an Order binds one Listing. */
  if (selectedLines.length > 0 && !coversWholeOrder) {
    refusals.push("SUBSET_LINE_REFUND_NOT_YET_EXECUTABLE");
  }

  // — The amount —

  let derived: ReturnType<typeof deriveRefundAmount> | null = null;
  if (selectedLines.length > 0 && policy !== null) {
    derived = deriveRefundAmount({
      selectedLines,
      orderLineCount: orderLines.length,
      quotedShippingAmountMinorUnits: Number(order.quotedShippingAmountMinorUnits),
      quotedOtherPassThroughAmountMinorUnits: Number(
        order.quotedOtherPassThroughAmountMinorUnits,
      ),
      shippingRefundability: policy.terms.shippingRefundability as ShippingRefundability,
      reasonCode,
    });
    if (!derived.derived) refusals.push(derived.refusal);
  }

  const total = derived !== null && derived.derived ? derived.totalMinorUnits : null;

  /* THE PARTIAL-LINE REFUSAL. Structural, and checked before anything is written
     or contacted. A caller asking for a figure other than what the selected lines
     and the bound policy produce is asking for an allocation nobody has ruled on
     — see PARTIAL_LINE_REFUND_DEFERRAL. */
  if (args.requestedAmountMinorUnits !== undefined && args.requestedAmountMinorUnits !== total) {
    refusals.push("PARTIAL_LINE_REFUND_NOT_SUPPORTED");
  }

  if (total !== null && total <= 0) {
    /* A selection that returns nothing is not a refund. Surfaced rather than
       executed as a zero-amount provider call. */
    refusals.push("REFUND_AMOUNT_DOES_NOT_RECONCILE");
  }

  const unique = Array.from(new Set(refusals));
  const eligible = unique.length === 0;

  /* The derived figures are reported WHENEVER the derivation succeeded, not only
     when the Order is eligible.
     
     They answer "what does this selection, under these terms, come to" — which is
     a different question from "may this be refunded", and one the pre-execution
     re-check genuinely needs. Nulling them on any refusal made that check dead
     code, because at execution time `REFUND_ALREADY_EXISTS` is always present:
     the row being executed IS that refund. */
  const amounts =
    derived !== null && derived.derived
      ? {
          refundableAmountMinorUnits: derived.totalMinorUnits,
          linesRetailMinorUnits: derived.linesRetailMinorUnits,
          linesTaxMinorUnits: derived.linesTaxMinorUnits,
          refundableShippingMinorUnits: derived.shippingMinorUnits,
          shippingRefundable: derived.shippingRefundable,
        }
      : {
          refundableAmountMinorUnits: null,
          linesRetailMinorUnits: null,
          linesTaxMinorUnits: null,
          refundableShippingMinorUnits: null,
          shippingRefundable: null,
        };

  return RefundEligibility.parse({
    orderId: args.orderId,
    eligible,
    refusals: unique,
    orderLines,
    selectedLineRefs: selectedLines.map((l) => l.lineRef),
    coversWholeOrder,
    ...amounts,
    sellerRefundPolicyId: order.sellerRefundPolicyId,
    sellerRefundPolicyVersion: order.sellerRefundPolicyVersion,
    currency: order.currency,
    providerTransactionRef,
    provider,
    snapshotId: snapshot?.id ?? null,
    evaluatedAt: args.at,
  });
}

// — Request —

export interface RequestRefundInput {
  orderId: string;
  reasonCode: RefundReasonCode;
  requestorKind: RefundRequestorKind;
  /** `null` for `SYSTEM`, and for a guest buyer. Never fabricated. */
  requestedByAccountId: string | null;
  requestedAt: string;
  /**
   * The whole lines to return. Omit to select **every** line on the Order.
   *
   * This is the only selection a caller makes. There is no monetary parameter,
   * which is what makes "a caller cannot choose an amount" structural rather than
   * a rule somebody validates.
   */
  selectedLineRefs?: readonly string[];
  /**
   * Supplied **only** so an arbitrary per-line amount can be refused.
   *
   * Compared against what the selected lines and the bound seller policy produce,
   * and then discarded. There is no path by which this value reaches the
   * provider, the row, or the amount returned.
   */
  requestedAmountMinorUnits?: number;
}

/**
 * Accept the obligation to refund the selected lines of one Order, each in full.
 *
 * **No provider is contacted.** The row commits `PENDING` and a worker executes
 * it, which is what makes a refund survive a crash between the decision and the
 * money moving.
 *
 * Refuses with **every** reason at once, before writing anything. An arbitrary
 * per-line amount in particular reaches no provider and leaves no row.
 *
 * The refund row and its lines commit **together**: a refund whose lines nobody
 * recorded would be a refund whose unit was unanswerable, which is precisely what
 * this correction exists to prevent.
 */
export async function requestOrderRefund(
  input: RequestRefundInput,
  deps: RefundServiceDeps = {},
): Promise<OrderRefundRecord> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoRefundIdProvider;

  const eligibility = await evaluateRefundEligibility(
    {
      orderId: input.orderId,
      at: input.requestedAt,
      reasonCode: input.reasonCode,
      ...(input.selectedLineRefs === undefined
        ? {}
        : { selectedLineRefs: input.selectedLineRefs }),
      ...(input.requestedAmountMinorUnits === undefined
        ? {}
        : { requestedAmountMinorUnits: input.requestedAmountMinorUnits }),
    },
    { db },
  );
  if (!eligibility.eligible) {
    if (eligibility.refusals.includes("REFUND_ALREADY_EXISTS")) {
      throw new RefundAlreadyExistsError();
    }
    throw new RefundRefusedError(eligibility.refusals);
  }

  /* Every one is non-null when `eligible` is true; asserted rather than assumed,
     because writing a refund against a charge nobody named, or under terms
     nobody bound, must fail loudly. */
  if (
    eligibility.snapshotId === null ||
    eligibility.provider === null ||
    eligibility.providerTransactionRef === null ||
    eligibility.currency === null ||
    eligibility.refundableAmountMinorUnits === null ||
    eligibility.linesRetailMinorUnits === null ||
    eligibility.linesTaxMinorUnits === null ||
    eligibility.refundableShippingMinorUnits === null ||
    eligibility.sellerRefundPolicyId === null ||
    eligibility.sellerRefundPolicyVersion === null
  ) {
    throw new RefundRefusedError(["CONFLICTING_REFUND_STATE"]);
  }

  const selected = eligibility.orderLines.filter((line) =>
    eligibility.selectedLineRefs.includes(line.lineRef),
  );

  try {
    const refundId = ids.nextRefundId();
    return await db.$transaction(async (tx) => {
      const row = await tx.orderRefund.create({
        data: {
          id: refundId,
          orderId: input.orderId,
          snapshotId: eligibility.snapshotId!,
          scope: "LINE_SET",
          coversWholeOrder: eligibility.coversWholeOrder,
          /* The version the ORDER binds, carried through the eligibility read.
             Never resolved live from the seller's current policy. */
          sellerRefundPolicyId: eligibility.sellerRefundPolicyId!,
          sellerRefundPolicyVersion: eligibility.sellerRefundPolicyVersion!,
          reasonCode: input.reasonCode,
          requestorKind: input.requestorKind,
          requestedByAccountId: input.requestedByAccountId,
          requestedAt: new Date(input.requestedAt),
          provider: eligibility.provider!,
          /* The deployment's payment mode. `STRIPE_MODES` has one member, so this
             is `TEST` by construction until a reviewed phase adds live support. */
          providerMode: "TEST",
          providerTransactionRef: eligibility.providerTransactionRef!,
          providerRefundRef: null,
          providerRefundCreatedAt: null,
          currency: eligibility.currency!,
          amountMinorUnits: BigInt(eligibility.refundableAmountMinorUnits!),
          linesRetailMinorUnits: BigInt(eligibility.linesRetailMinorUnits!),
          linesTaxMinorUnits: BigInt(eligibility.linesTaxMinorUnits!),
          refundedShippingMinorUnits: BigInt(eligibility.refundableShippingMinorUnits!),
          recordedAt: new Date(input.requestedAt),
          status: INITIAL_REFUND_STATUS,
          attemptCount: 0,
          /* Due immediately: a buyer's money should go back as soon as a worker
             runs, not after a backoff nothing has earned yet. */
          nextAttemptAt: new Date(input.requestedAt),
        },
      });

      for (const line of selected) {
        await tx.orderRefundLine.create({
          data: {
            refundId,
            lineRef: line.lineRef,
            internalProductId: line.internalProductId,
            listingSourceRecordId: line.listingSourceRecordId,
            listingSourceRecordVersion: line.listingSourceRecordVersion,
            currency: line.currency,
            commercialRetailAmountMinorUnits: BigInt(line.commercialRetailAmountMinorUnits),
            taxAmountMinorUnits: BigInt(line.taxAmountMinorUnits),
          },
        });
      }

      return refundRowToRecord(row, selected.map((l) => l.lineRef));
    });
  } catch (error) {
    if (error instanceof RefundError) throw error;
    if (isUniqueViolation(error)) throw new RefundAlreadyExistsError();
    throw new RefundPersistenceFailureError("requestOrderRefund", error);
  }
}

// — Claim —

export interface ClaimedRefund {
  record: OrderRefundRecord;
  lockToken: string;
}

export interface RefundClaim {
  claimed: ClaimedRefund[];
  /**
   * Rows that looked eligible and were taken first.
   *
   * Not an error — it is what concurrency looks like — but a **persistently**
   * non-zero count means more workers are running than the work needs.
   */
  conflicts: number;
}

/**
 * Claim due refunds for one worker.
 *
 * One guarded `updateMany` stamps a lock token onto every eligible row, then the
 * rows are read back **by that token**. Prisma has no `updateMany … LIMIT`, so
 * eligibility is narrowed by an id list gathered first — a row that stops being
 * eligible between the two statements simply is not claimed, because the `where`
 * re-asserts every condition. The select is a hint, never the guard.
 */
export async function claimDueRefunds(
  args: { now: string; limit: number },
  deps: RefundServiceDeps = {},
): Promise<RefundClaim> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoRefundIdProvider;
  const lockToken = ids.nextLockToken();
  const now = new Date(args.now);
  const leaseExpiresAt = new Date(
    now.getTime() + REFUND_RETRY_POLICY.claimLeaseSeconds * 1_000,
  );

  try {
    const eligible = await db.orderRefund.findMany({
      where: {
        status: { in: ["PENDING", "RETRY_PENDING"] },
        nextAttemptAt: { lte: now },
        lockToken: null,
      },
      select: { id: true },
      orderBy: { nextAttemptAt: "asc" },
      take: Math.max(1, Math.min(args.limit, 100)),
    });
    if (eligible.length === 0) return { claimed: [], conflicts: 0 };

    await db.orderRefund.updateMany({
      where: {
        id: { in: eligible.map((r) => r.id) },
        status: { in: ["PENDING", "RETRY_PENDING"] },
        nextAttemptAt: { lte: now },
        lockToken: null,
      },
      data: { status: "IN_PROGRESS", lockToken, lockedAt: now, leaseExpiresAt },
    });

    const claimed = await db.orderRefund.findMany({
      where: { lockToken },
      include: WITH_LINES,
    });
    return {
      claimed: claimed.map((row) => ({ record: withLinesToRecord(row), lockToken })),
      conflicts: eligible.length - claimed.length,
    };
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("claimDueRefunds", error);
  }
}

/**
 * Return refunds whose claim has expired to the pool.
 *
 * A worker that died mid-call leaves an `IN_PROGRESS` row; the lease expires and
 * the row becomes eligible again, so a crash costs an **attempt** rather than a
 * buyer's money. A live claim is never touched.
 */
export async function recoverStaleRefundClaims(
  args: { now: string },
  deps: RefundServiceDeps = {},
): Promise<number> {
  const db = deps.db ?? getPrisma();
  const now = new Date(args.now);
  try {
    const result = await db.orderRefund.updateMany({
      where: { status: "IN_PROGRESS", leaseExpiresAt: { lt: now } },
      data: {
        status: "RETRY_PENDING",
        lockToken: null,
        lockedAt: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
      },
    });
    return result.count;
  } catch (error) {
    throw new RefundPersistenceFailureError("recoverStaleRefundClaims", error);
  }
}

// — Resolve —

/** What one provider attempt produced. */
export type RefundAttemptOutcome =
  | {
      outcome: "REFUNDED";
      providerRefundRef: string;
      providerRefundCreatedAt: string;
    }
  | { outcome: "FAILED"; failureCode: RefundFailureCode };

/** Everything one successful refund brought into being, for the caller to report. */
export interface ResolvedRefund {
  refund: OrderRefundRecord;
  /** The `1.2` accounting entry, when this attempt succeeded. */
  reversalId: string | null;
  /** The tax-reversal obligation, when this sale had a reported Tax Transaction. */
  taxReversalId: string | null;
  /** Proceeds recovery exceptions raised. Empty when nothing was owed back. */
  recoveryExceptionIds: string[];
}

/**
 * Record what one attempt did, and — on success — every consequence at once.
 *
 * Guarded by the lock token, so a worker whose lease expired mid-call cannot
 * stamp a result over the row another worker has since taken.
 *
 * A success is refused if it does not cohere: `refundIsCoherent` requires a
 * provider reference and its instant, and requires that reference not to be the
 * original charge — a provider echoing the input is not a refund, and marking it
 * `REFUNDED` would bury the one fact worth surfacing. It is treated as a
 * permanent failure rather than silently accepted.
 */
export async function resolveRefundAttempt(
  args: {
    refundId: string;
    lockToken: string;
    result: RefundAttemptOutcome;
    at: string;
  },
  deps: RefundServiceDeps = {},
): Promise<ResolvedRefund | null> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoRefundIdProvider;

  try {
    const existing = await db.orderRefund.findUnique({
      where: { id: args.refundId },
      include: WITH_LINES,
    });
    if (existing === null || existing.lockToken !== args.lockToken) return null;

    const result = args.result;
    if (result.outcome === "FAILED") {
      const refund = await failRefundAttempt(db, existing, result.failureCode, args);
      return { refund, reversalId: null, taxReversalId: null, recoveryExceptionIds: [] };
    }

    const candidate = withLinesToRecord({
      ...existing,
      status: "REFUNDED",
      providerRefundRef: result.providerRefundRef,
      providerRefundCreatedAt: new Date(result.providerRefundCreatedAt),
    });
    if (!refundIsCoherent(candidate)) {
      const refund = await failRefundAttempt(db, existing, "EVIDENCE_INCONSISTENT", args);
      return { refund, reversalId: null, taxReversalId: null, recoveryExceptionIds: [] };
    }

    const success = { ...args, result };
    return await db.$transaction(async (tx) => finalizeRefundInTx(tx, existing, success, ids));
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("resolveRefundAttempt", error);
  }
}

/**
 * Everything a completed refund creates, committed together.
 *
 * ```
 *   1. the refund row → REFUNDED, with the provider's own reference
 *   2. the 1.2 accounting entry, and the settlement row → REVERSED
 *   3. the tax-reversal obligation, where a Tax Transaction was reported
 *   4. a recovery exception per already-paid or already-eligible proceeds claim
 * ```
 *
 * The invariants this makes structural: a refunded buyer with a settlement row
 * that still says the sale stands, a refunded sale whose tax reversal was never
 * committed, and a refunded sale whose already-paid proceeds nobody recorded are
 * each **impossible**, not merely unlikely.
 *
 * **No provider call happens inside this transaction**, so nothing about it is
 * slow or externally dependent.
 */
async function finalizeRefundInTx(
  tx: Prisma.TransactionClient,
  existing: RefundRowWithLines,
  args: {
    refundId: string;
    lockToken: string;
    result: Extract<RefundAttemptOutcome, { outcome: "REFUNDED" }>;
    at: string;
  },
  ids: RefundIdProvider,
): Promise<ResolvedRefund> {
  /* — 2 — The accounting entry, through `1.2`'s own service.
   *
   * It derives every reversed figure from the snapshot and refuses an unbalanced
   * entry before any row exists. NO ARITHMETIC HAPPENS HERE, and no amount is
   * passed in: a refund cannot return more than the sale earned because there is
   * no parameter through which it could. */
  const recorded = await recordFullReversalInTx(
    tx,
    {
      snapshotId: existing.snapshotId,
      kind: "REFUND",
      reasonCode: reversalReasonForRefund(
        existing.reasonCode as RefundReasonCode,
      ),
      provider: existing.provider as "STRIPE",
      providerReversalRef: args.result.providerRefundRef,
      /* When the money actually moved back — the PROVIDER's instant, not
         Monacado's. A reversal stamped with a worker's clock could not answer
         "when did the funds go back", which is the first question in a dispute. */
      occurredAt: args.result.providerRefundCreatedAt,
      recordedAt: args.at,
    },
    { nextReversalId: () => ids.nextReversalId() },
  );

  // — 1 — The refund row. Only lifecycle columns and the two provider fields.
  const row = await tx.orderRefund.update({
    where: { id: args.refundId },
    include: WITH_LINES,
    data: {
      status: "REFUNDED",
      providerRefundRef: args.result.providerRefundRef,
      providerRefundCreatedAt: new Date(args.result.providerRefundCreatedAt),
      attemptCount: existing.attemptCount + 1,
      nextAttemptAt: null,
      lockToken: null,
      lockedAt: null,
      leaseExpiresAt: null,
      finalizedAt: new Date(args.at),
      reversalId: recorded.reversal.reversalId,
    },
  });

  /* — 3 — The tax-reversal obligation.
   *
   * Committed here and NOT executed here, on `1.7`'s reasoning exactly: a second
   * provider call inside this transaction would hold a lock across a network
   * round trip, and a timeout would roll back a refund the buyer has already
   * received. The obligation becomes durable, retryable work. */
  const taxReversalId = await commitTaxReversalObligationInTx(tx, {
    orderId: existing.orderId,
    refundId: existing.id,
    recordedAt: args.at,
    taxReversalId: ids.nextTaxReversalId(),
  });

  /* — 4 — What a refund does to money already committed to somebody else. */
  const recoveryExceptionIds = await raiseProceedsRecoveryExceptionsInTx(tx, {
    refundId: existing.id,
    orderId: existing.orderId,
    snapshotId: existing.snapshotId,
    coversWholeOrder: existing.coversWholeOrder,
    raisedAt: args.at,
    ids,
  });

  return {
    refund: withLinesToRecord(row),
    reversalId: recorded.reversal.reversalId,
    taxReversalId,
    recoveryExceptionIds,
  };
}

/**
 * Commit the obligation to reverse this sale's tax with the provider.
 *
 * Returns `null` when the Order has **no recorded provider Tax Transaction** —
 * which is the only honest answer for a sale the tax provider never saw. There is
 * nothing to reverse, and fabricating a reversal target would be asserting that a
 * transaction existed. Reconciliation reports the gap as
 * `ORIGINAL_TAX_TRANSACTION_MISSING` rather than this function inventing one.
 *
 * **A zero-tax sale is not such a case.** `1.7` reports zero-tax sales precisely
 * so they appear as return lines, so a zero-tax sale has a recorded transaction
 * and gets a reversal like any other — see `requiresTaxReversal`.
 *
 * Every field is copied from the `1.7` record rather than joined to it, so the
 * record a filing rests on stays complete on its own.
 */
async function commitTaxReversalObligationInTx(
  tx: Prisma.TransactionClient,
  args: { orderId: string; refundId: string; recordedAt: string; taxReversalId: string },
): Promise<string | null> {
  const original = await tx.orderTaxTransaction.findUnique({
    where: { orderId: args.orderId },
  });
  if (original === null) return null;

  if (
    original.recordingStatus !== "RECORDED" ||
    original.providerTaxTransactionRef === null
  ) {
    /* The sale's tax was never successfully reported, so the provider holds
       nothing to reverse. The tax-recording row is still retrying or terminally
       failed and stays visible in `1.8`'s backlog; reconciliation surfaces the
       combination. Reversing a transaction that does not exist is not available. */
    return null;
  }

  if (
    !requiresTaxReversal({
      hasRecordedProviderTaxTransaction: true,
      taxAmountMinorUnits: Number(original.taxAmountMinorUnits),
    })
  ) {
    return null;
  }

  await tx.orderTaxReversal.create({
    data: {
      id: args.taxReversalId,
      orderId: args.orderId,
      refundId: args.refundId,
      taxTransactionId: original.id,
      scope: "FULL",
      provider: original.provider,
      providerMode: original.providerMode,
      originalProviderTaxTransactionRef: original.providerTaxTransactionRef,
      providerReversalRef: null,
      providerReversalCreatedAt: null,
      providerReference: taxReversalProviderReference(args.orderId),
      currency: original.currency,
      reversedTaxAmountMinorUnits: original.taxAmountMinorUnits,
      reversedTaxableBasisMinorUnits: original.taxableBasisMinorUnits,
      recordedAt: new Date(args.recordedAt),
      status: INITIAL_TAX_REVERSAL_STATUS,
      attemptCount: 0,
      /* Due immediately: the second half of one lifecycle should run in the same
         cycle as the first whenever a worker is available. */
      nextAttemptAt: new Date(args.recordedAt),
    },
  });
  return args.taxReversalId;
}

/**
 * Raise a recovery exception for every proceeds claim a refund cannot undo.
 *
 * **Seller and promoter alike.** A promoter's commission on a refunded line is
 * reversed economically on exactly the same terms as the seller's proceeds — and
 * that symmetry is deliberate rather than incidental. The alternative, silently
 * absorbing an already-paid promoter commission into Monacado's own economics,
 * would turn a refund into an unrecorded marketplace expense that nobody
 * authorised and no ledger names.
 *
 * ```
 * PENDING   → nothing. `advanceProceedsObligation` already refuses ELIGIBLE on a
 *             reversed sale, so the claim can never be paid; an exception for it
 *             would be an exception to nothing.
 * ELIGIBLE  → exception. Past the gate that would now refuse it. NOT demoted.
 * PAID      → exception. Money already left. NOT rewritten, NOT deleted.
 * ```
 *
 * ## The attributable amount, and why it is its own column
 *
 * `amountMinorUnits` is the obligation's whole figure; `attributableAmountMinorUnits`
 * is the part the **refunded lines** account for. They are equal for a
 * whole-Order refund, which is every refund today — and they are separate columns
 * because a subset-of-lines refund attributes only part of a party's proceeds. A
 * phase that discovered it needed the distinction later would be tempted to
 * overwrite the total, which is the historical rewrite this table exists to avoid.
 *
 * Both come from **sale-time commission evidence** — the obligation `0M.9` wrote
 * from the snapshot — and never from a fresh commission calculation.
 *
 * See `proceeds-recovery.ts` for why fabricating a negative obligation was
 * refused outright.
 */
async function raiseProceedsRecoveryExceptionsInTx(
  tx: Prisma.TransactionClient,
  args: {
    refundId: string;
    orderId: string;
    snapshotId: string;
    /**
     * Whether the refund covered every line.
     *
     * Today always `true`, because a subset refund is refused before it reaches
     * here. It is threaded through anyway so the attribution decision has an
     * input rather than an assumption baked into it.
     */
    coversWholeOrder: boolean;
    raisedAt: string;
    ids: RefundIdProvider;
  },
): Promise<string[]> {
  const obligations = await tx.proceedsObligation.findMany({
    where: { snapshotId: args.snapshotId },
    orderBy: { party: "asc" },
  });

  if (!args.coversWholeOrder) {
    /* Unreachable: `evaluateRefundEligibility` refuses a subset refund before a
       row exists. Asserted rather than assumed, because attributing a whole
       obligation to a partial refund would overstate what Monacado is owed back
       from a seller or a promoter — and it would do so silently. */
    throw new RefundError(
      "CORRUPT_REFUND_RECORD",
      "A subset-of-lines refund cannot attribute proceeds recovery",
    );
  }

  const raised: string[] = [];
  for (const obligation of obligations) {
    const reason = recoveryReasonForObligationState(
      obligation.state as "PENDING" | "ELIGIBLE" | "PAID",
    );
    if (reason === null) continue;

    const id = args.ids.nextProceedsRecoveryExceptionId();
    await tx.proceedsRecoveryException.create({
      data: {
        id,
        refundId: args.refundId,
        orderId: args.orderId,
        snapshotId: args.snapshotId,
        proceedsObligationId: obligation.id,
        participantId: obligation.participantId,
        party: obligation.party,
        /* COPIED from the obligation. What is at stake is exactly what Monacado
           committed to that party — seller proceeds or promoter commission
           alike, from sale-time evidence and never recomputed. */
        amountMinorUnits: obligation.amountMinorUnits,
        /* What the refunded lines attribute to it.
         *
         * Equal to the whole obligation, and today that is not an approximation:
         * a subset-of-lines refund is refused before it reaches here
         * (`SUBSET_LINE_REFUND_NOT_YET_EXECUTABLE`), so every refund that gets
         * this far covered every line. The assertion below says so rather than a
         * branch pretending to handle a case that cannot occur.
         *
         * When a subset refund becomes executable, this is where each party's
         * attributable share is computed from that phase's line-level commission
         * evidence — a value change, not a schema change. */
        attributableAmountMinorUnits: obligation.amountMinorUnits,
        currency: obligation.currency,
        reasonCode: reason,
        obligationStateAtRefund: obligation.state,
        status: INITIAL_PROCEEDS_RECOVERY_STATUS,
        resolutionCode: null,
        raisedAt: new Date(args.raisedAt),
      },
    });
    raised.push(id);
  }
  return raised;
}

async function failRefundAttempt(
  db: Db,
  existing: RefundRowWithLines,
  failureCode: RefundFailureCode,
  args: { refundId: string; at: string },
): Promise<OrderRefundRecord> {
  const failureClass = classifyRefundFailure(failureCode);
  const attemptCount = existing.attemptCount + 1;
  const retryAt =
    failureClass === "PERMANENT"
      ? null
      : nextRefundAttemptAt({ attemptCount, failedAt: args.at });
  const terminal = retryAt === null;

  const row = await db.orderRefund.update({
    where: { id: args.refundId },
    include: WITH_LINES,
    data: {
      status: terminal ? "FAILED_PERMANENT" : "RETRY_PENDING",
      attemptCount,
      nextAttemptAt: retryAt === null ? null : new Date(retryAt),
      lastFailureCode: failureCode,
      lastFailureClass: failureClass,
      lockToken: null,
      lockedAt: null,
      leaseExpiresAt: null,
      finalizedAt: terminal ? new Date(args.at) : null,
    },
  });
  return withLinesToRecord(row);
}

// — Marking the original tax report as reversed —

/**
 * Move the original `1.7` report's lifecycle to `REVERSED`.
 *
 * **The only column a reversal touches on that record**, and it is the value
 * `1.7` reserved for exactly this. Every sale-time fact underneath —
 * `IMMUTABLE_TAX_TRANSACTION_FIELDS` — is untouched, and a test asserts it.
 *
 * Called from the tax-reversal resolution path, in the same transaction that
 * marks the reversal `REVERSED`, so "the tax was reversed" and "the original says
 * so" cannot disagree.
 */
export async function markTaxTransactionReversedInTx(
  tx: Prisma.TransactionClient,
  taxTransactionId: string,
): Promise<void> {
  await tx.orderTaxTransaction.update({
    where: { id: taxTransactionId },
    data: { lifecycleState: REVERSED_TAX_TRANSACTION_LIFECYCLE_STATE },
  });
}

// — Reads —

export async function getRefundForOrder(
  orderId: string,
  deps: RefundServiceDeps = {},
): Promise<OrderRefundRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.orderRefund.findUnique({
      where: { orderId },
      include: WITH_LINES,
    });
    return row === null ? null : withLinesToRecord(row);
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("getRefundForOrder", error);
  }
}

export async function getRefund(
  refundId: string,
  deps: RefundServiceDeps = {},
): Promise<OrderRefundRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.orderRefund.findUnique({
      where: { id: refundId },
      include: WITH_LINES,
    });
    return row === null ? null : withLinesToRecord(row);
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("getRefund", error);
  }
}

/** Shared existence read, usable inside and outside a transaction. */
export async function isOrderRefundedIn(tx: Tx, orderId: string): Promise<boolean> {
  const row = await tx.orderRefund.findUnique({
    where: { orderId },
    select: { status: true },
  });
  return row?.status === "REFUNDED";
}

/**
 * The composite lifecycle for one Order, derived from both durable records.
 *
 * The single place a reader asks "where has this refund got to", so the operator
 * command, the reconciler, and the capsule projection all get one answer rather
 * than three that agree by accident.
 */
export async function getRefundLifecycleState(
  orderId: string,
  deps: RefundServiceDeps = {},
): Promise<RefundLifecycleState | null> {
  const db = deps.db ?? getPrisma();
  const refund = await db.orderRefund.findUnique({
    where: { orderId },
    select: { status: true },
  });
  if (refund === null) return null;
  const taxReversal = await db.orderTaxReversal.findUnique({
    where: { orderId },
    select: { status: true },
  });
  return refundLifecycleState({
    refundStatus: refund.status as OrderRefundRecord["status"],
    taxReversalStatus: (taxReversal?.status ?? null) as TaxReversalStatus | null,
  });
}

/**
 * The operational question: **which refunds are not finished, and why?**
 *
 * Answers it from Monacado's own rows — no provider call — carrying the attempt
 * count, the last normalised failure, and when the next attempt is due.
 */
export async function listUnresolvedRefunds(
  args: { limit?: number } = {},
  deps: RefundServiceDeps = {},
): Promise<OrderRefundRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.orderRefund.findMany({
      where: { status: { in: ["PENDING", "IN_PROGRESS", "RETRY_PENDING", "FAILED_PERMANENT"] } },
      orderBy: { recordedAt: "asc" },
      take: Math.max(1, Math.min(args.limit ?? 100, 500)),
      include: WITH_LINES,
    });
    return rows.map(withLinesToRecord);
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("listUnresolvedRefunds", error);
  }
}
