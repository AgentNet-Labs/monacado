/**
 * Seller Product resale availability (Phase 1.40, Contract §9.3) — SERVER ONLY.
 *
 * The ONLY path that changes a Product's resale availability. It is a Seller
 * act: the acting participant must hold creator authority over the Product's
 * current version. No internal grant substitutes for that — an operator account
 * that does not author the Product gets the same not-found as anyone else.
 *
 * ## Order, and why
 *
 *   1. The Product exists AND the acting participant holds Product authority —
 *      one error for both, so a guessed reference learns nothing.
 *   2. Inside ONE transaction, with the Product row locked (`FOR UPDATE`):
 *        - authority is asked again;
 *        - the effective lifecycle and the current resale state are read from
 *          the rows as this transaction sees them — never from the request;
 *        - `decideResaleAvailabilityChange` decides: unchanged (nothing
 *          written), not governed, `AVAILABLE` while not `ACTIVE`, or a change;
 *        - a change releases the current act's marker and records a new act
 *          naming the one it supersedes.
 *
 * The row lock serialises two requests for one Product — and serialises them
 * with activation, suspension, and revision, which lock or update the same row
 * first — so the second request decides on the first's result: a duplicate is a
 * no-op, a conflicting one is decided against the new state. The unique
 * `currentForProductId` and `supersedesActId` columns are the database's own
 * guarantee behind that.
 *
 * ## What it does not do
 *
 * Changes no lifecycle, activation, or suspension, and no lifecycle change ever
 * calls it. Requires no Storefront, Listing, Offer, or Promotion Authorization,
 * and writes none. Writes no source version, Order, payment, payout, Node,
 * capsule, publication, or outbox state. Never reads the legacy `promotable`
 * fact or `generalAvailabilityState`.
 */

import "../server-only";
import { Prisma } from "@prisma/client";
import {
  ProductResaleAvailability,
  decideResaleAvailabilityChange,
  productResaleEffectiveness,
} from "../../contracts/product/product-resale-availability";
import type { ProductLifecycleState } from "../../contracts/product/product-lifecycle";
import { getPrisma } from "../db/client";
import {
  ConcurrencyConflictError,
  ProductNotAvailableError,
  ProductResaleAvailabilityRequiresActiveError,
  ProductResaleAvailabilityTransitionNotGovernedError,
  ValidationError,
} from "../product/errors";
import {
  cryptoProductResaleAvailabilityIdProvider,
  type ProductResaleAvailabilityIdProvider,
} from "../product/product-lifecycle-ids";
import { readProductLifecycleIn } from "../product/product-lifecycle-service";
import { readProductResaleAvailabilityIn } from "../product/product-resale-availability-service";
import { resolveActingSubject } from "./acting-subject-service";
import { participantHoldsProductAuthority } from "./product-authority-service";

type Db = ReturnType<typeof getPrisma>;

export interface ProductResaleAvailabilityServiceDeps {
  db?: Db;
  ids?: ProductResaleAvailabilityIdProvider;
}

export interface ProductResaleAvailabilityResult {
  /** The stable application reference — never an internal id. */
  productRef: string;
  resaleAvailability: ProductResaleAvailability;
  /** `false` when the Product was already in the requested state; nothing was written. */
  changed: boolean;
  lifecycle: ProductLifecycleState;
  /** Lifecycle `ACTIVE` AND resale `AVAILABLE` — necessary, never sufficient, for promoted commerce. */
  resaleEffective: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Set the resale availability of a Product the acting account's participant
 * authors.
 *
 * Throws `ValidationError`, `ProductNotAvailableError`,
 * `ProductResaleAvailabilityTransitionNotGovernedError`,
 * `ProductResaleAvailabilityRequiresActiveError`, or `ConcurrencyConflictError`
 * (a concurrent change slipped past the lock — never expected).
 */
export async function setProductResaleAvailabilityAs(
  actor: { accountId: string },
  request: { productRef: string; resaleAvailability: string; now: string },
  deps: ProductResaleAvailabilityServiceDeps = {},
): Promise<ProductResaleAvailabilityResult> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoProductResaleAvailabilityIdProvider;

  const target = ProductResaleAvailability.safeParse(request.resaleAvailability);
  if (!target.success) {
    throw new ValidationError("Invalid resale availability", ["resaleAvailability: unknown value"]);
  }

  const product = await db.product.findUnique({
    where: { productRef: request.productRef },
    select: { internalProductId: true },
  });
  if (product === null) throw new ProductNotAvailableError();
  const internalProductId = product.internalProductId;

  const subject = await resolveActingSubject(db, actor.accountId);
  const participantId = subject.participant?.participantId;
  if (
    participantId === undefined ||
    !(await participantHoldsProductAuthority(db, internalProductId, participantId))
  ) {
    throw new ProductNotAvailableError();
  }

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT internalProductId FROM Product WHERE internalProductId = ${internalProductId} FOR UPDATE`;

      if (!(await participantHoldsProductAuthority(tx, internalProductId, participantId))) {
        throw new ProductNotAvailableError();
      }
      const lifecycleRead = await readProductLifecycleIn(tx, internalProductId);
      if (lifecycleRead === null) throw new ProductNotAvailableError();
      const lifecycle = lifecycleRead.lifecycle.lifecycle;
      const current = await readProductResaleAvailabilityIn(tx, internalProductId);

      const decision = decideResaleAvailabilityChange({
        current: current.resaleAvailability,
        target: target.data,
        lifecycle,
      });
      if (decision.outcome === "REFUSED") {
        throw decision.reason === "PRODUCT_NOT_ACTIVE"
          ? new ProductResaleAvailabilityRequiresActiveError()
          : new ProductResaleAvailabilityTransitionNotGovernedError();
      }

      if (decision.outcome === "CHANGE") {
        if (current.currentActId !== null) {
          await tx.productResaleAvailabilityAct.update({
            where: { id: current.currentActId },
            data: { currentForProductId: null },
          });
        }
        await tx.productResaleAvailabilityAct.create({
          data: {
            id: ids.nextProductResaleAvailabilityActId(),
            internalProductId,
            resaleAvailability: decision.to,
            previousResaleAvailability: decision.from,
            supersedesActId: current.currentActId,
            participantId,
            actedByAccountId: actor.accountId,
            actedAt: new Date(request.now),
            lifecycleAtAct: lifecycle,
            currentForProductId: internalProductId,
          },
        });
      }

      return {
        productRef: lifecycleRead.productRef,
        resaleAvailability: target.data,
        changed: decision.outcome === "CHANGE",
        lifecycle,
        resaleEffective: productResaleEffectiveness({ lifecycle, resaleAvailability: target.data }).effective,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConcurrencyConflictError("The Product's resale availability changed concurrently");
    }
    throw error;
  }
}
