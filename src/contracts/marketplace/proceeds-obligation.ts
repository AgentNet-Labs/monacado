/**
 * Seller and promoter proceeds obligations (Phase 0M.9).
 *
 * **What Monacado owes whom for one completed sale** — the seller's proceeds, and
 * a promoter's net proceeds where a promoter earned any. An accounting claim, not
 * a payment.
 *
 * Five properties shape everything below:
 *
 *   1. **An obligation is owed money, never moved money.** There is no transfer,
 *      no batch, no schedule, no bank detail, no provider payout identifier, and
 *      no reserve. `PAID` records that Monacado has settled the claim; it does not
 *      settle it. Payout *execution* is not implemented in this phase.
 *
 *   2. **The amount is copied from the snapshot, never recomputed.** A seller's
 *      obligation is exactly `sellerProceedsMinorUnits`; a promoter's is exactly
 *      `promoterNetProceedsMinorUnits`. The `0M.T1` snapshot is authoritative, its
 *      reconciliation identity already holds, and a second calculation here would
 *      be a second answer that could disagree with the one the parties transacted
 *      under.
 *
 *   3. **A seller-direct sale has one obligation; a promoted sale has two.** Not
 *      "two, one of them zero" — a seller selling their own product has no
 *      promoter counterparty, and a zero-amount promoter row would describe one
 *      who earned nothing rather than one who does not exist. This is the same
 *      distinction `0M.4A` and `0M.T1` make structurally.
 *
 *   4. **One obligation per party per sale**, enforced by a unique index rather
 *      than by a service remembering. Paying a party twice for one sale is the
 *      failure this exists to prevent.
 *
 *   5. **Three states, forward-only.** Owed, releasable, settled. Nothing returns:
 *      a claw-back after a reversal is `0M.T2`'s reversal accounting and will be
 *      its own entry, never an edit that makes a paid obligation unpaid.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import {
  MARKETPLACE_PARTICIPANT_ID_RE,
  PROCEEDS_OBLIGATION_ID_RE,
  TRANSACTION_ECONOMIC_SNAPSHOT_ID_RE,
} from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import type { TransactionEconomics } from "./transaction-accounting";

// — Identity —

export const ProceedsObligationId = z
  .string()
  .regex(PROCEEDS_OBLIGATION_ID_RE, "obligationId must be mon:pobl:<opaque>");
export type ProceedsObligationId = z.infer<typeof ProceedsObligationId>;

// — Party —

/**
 * Which side of the supply relationship is owed.
 *
 * Monacado is deliberately **not** a member. Monacado's retained amount is not
 * owed to anyone — it is what Monacado kept, already recorded on the snapshot,
 * and an obligation row for it would model the retailer as its own creditor.
 */
export const PROCEEDS_PARTIES = ["SELLER", "PROMOTER"] as const;
export const ProceedsParty = z.enum(PROCEEDS_PARTIES);
export type ProceedsParty = z.infer<typeof ProceedsParty>;

// — Lifecycle —

/**
 * Where one claim stands.
 *
 *   - `PENDING` — owed, and not yet releasable. The buyer's funds may not have
 *     settled, a return window may be open, or a risk hold may apply.
 *   - `ELIGIBLE` — Monacado has determined the amount may be paid out.
 *   - `PAID` — Monacado has settled the claim.
 *
 * **What moves an obligation to `ELIGIBLE` is not decided here.** Funds
 * settlement is `0M.T1`'s settlement record, return windows are unbuilt, and
 * payout holds are explicitly `0M.R2`. This phase records the state and the
 * instant; the *policy* that advances it belongs to the phase that owns the rule.
 */
export const PROCEEDS_OBLIGATION_STATES = ["PENDING", "ELIGIBLE", "PAID"] as const;
export const ProceedsObligationState = z.enum(PROCEEDS_OBLIGATION_STATES);
export type ProceedsObligationState = z.infer<typeof ProceedsObligationState>;

export const INITIAL_PROCEEDS_OBLIGATION_STATE: ProceedsObligationState = "PENDING";

/**
 * Valid transitions, as an exhaustive table.
 *
 * Forward-only, and `PAID` is terminal. An obligation that could go back to
 * `PENDING` would mean a party had been paid and then un-paid, which is a
 * reversal — a new accounting entry under `0M.T2`, never a row that changed its
 * mind about a payment that already happened.
 */
export const PROCEEDS_OBLIGATION_TRANSITIONS: Record<
  ProceedsObligationState,
  readonly ProceedsObligationState[]
> = Object.freeze({
  PENDING: ["ELIGIBLE"],
  ELIGIBLE: ["PAID"],
  PAID: [],
});

export function isValidProceedsObligationTransition(
  from: ProceedsObligationState,
  to: ProceedsObligationState,
): boolean {
  return PROCEEDS_OBLIGATION_TRANSITIONS[from].includes(to);
}

export function isTerminalProceedsObligationState(state: ProceedsObligationState): boolean {
  return PROCEEDS_OBLIGATION_TRANSITIONS[state].length === 0;
}

// — Record —

/**
 * One party's claim on one sale.
 *
 * Note what has no field: a bank account, a payout method, a transfer or batch
 * identifier, a schedule, a reserve, a fee, a tax withholding, or any second
 * economic figure. The obligation names an amount already established elsewhere
 * and its standing, and that is the whole of it.
 */
export const ProceedsObligationRecord = z.strictObject({
  obligationId: ProceedsObligationId,
  /** The sale this claim arises from. The economics live there, not here. */
  snapshotId: z
    .string()
    .regex(TRANSACTION_ECONOMIC_SNAPSHOT_ID_RE, "snapshotId must be mon:txsnp:<opaque>"),
  participantId: z
    .string()
    .regex(MARKETPLACE_PARTICIPANT_ID_RE, "participantId must be mon:mpart:<opaque>"),
  party: ProceedsParty,

  /** Copied from the snapshot, never recalculated. */
  amountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  currency: CurrencyCode,

  state: ProceedsObligationState,
  /** When the claim arose — the instant of sale. Supplied, never a clock read. */
  accruedAt: z.iso.datetime(),
  becameEligibleAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProceedsObligationRecord = z.infer<typeof ProceedsObligationRecord>;

// — Derivation —

/** One claim, as derived from a snapshot. The shape the service writes. */
export interface DerivedProceedsClaim {
  party: ProceedsParty;
  amountMinorUnits: number;
}

/**
 * Which obligations one sale creates, and for how much.
 *
 * **Reads the snapshot's economics and computes nothing.** A seller-direct sale
 * yields one claim; a promoted sale yields two, and the promoter's is the
 * authoritative `promoterNetProceedsMinorUnits` — spread plus seller-funded
 * commission — rather than either component alone. Taking only the spread would
 * silently withhold the commission the seller funded, which is precisely the
 * conflation `MONACADO_MOR_BUSINESS_MODEL.md` §D warns against.
 *
 * The union's discriminator drives the branch, so a seller-direct sale has no
 * path to a promoter claim.
 */
export function deriveProceedsClaims(economics: TransactionEconomics): DerivedProceedsClaim[] {
  if (economics.transactionType === "SELLER_DIRECT") {
    return [{ party: "SELLER", amountMinorUnits: economics.sellerProceedsMinorUnits }];
  }
  return [
    { party: "SELLER", amountMinorUnits: economics.sellerProceedsMinorUnits },
    { party: "PROMOTER", amountMinorUnits: economics.promoterNetProceedsMinorUnits },
  ];
}

// — Inputs —

export const AdvanceProceedsObligationInput = z.strictObject({
  obligationId: ProceedsObligationId,
  to: ProceedsObligationState,
  at: z.iso.datetime(),
});
export type AdvanceProceedsObligationInput = z.infer<typeof AdvanceProceedsObligationInput>;

// — Never on a proceeds obligation —

/**
 * Named as never-persistable, and not admissible through any input above.
 *
 * The first group is **payout execution**, which this phase does not do. The
 * second is **holds and risk**, which is `0M.R2`. The third is **tax**, which is
 * `0M.T2`. The fourth is **recomputed economics**, which would be a second answer
 * to the snapshot.
 */
export const NEVER_ON_PROCEEDS_OBLIGATION = [
  // payout execution — not this phase
  "payoutId",
  "payoutBatchId",
  "transferId",
  "payoutMethod",
  "bankAccountNumber",
  "payoutScheduledAt",
  "providerPayoutRef",
  // holds and risk — 0M.R2
  "reserveAmountMinorUnits",
  "payoutHold",
  "riskScore",
  "velocityWindow",
  // tax — 0M.T2
  "taxWithheldMinorUnits",
  "taxFormId",
  // recomputed economics — the snapshot is authoritative
  "commercialRetailAmountMinorUnits",
  "monacadoRetainedAmountMinorUnits",
  "promoterRetailSpreadMinorUnits",
  "sellerFundedCommissionMinorUnits",
] as const;
