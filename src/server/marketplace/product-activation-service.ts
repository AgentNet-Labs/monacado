/**
 * Explicit Seller Product activation (Phase 1.39, Contract §9.2) — SERVER ONLY.
 *
 * The ONLY path that creates `ACTIVE` Product commercial authority. Meeting the
 * requirements makes activation permissible; it never happens by itself, and
 * restoring readiness after a lapse never re-activates a Product — the Seller
 * calls this again.
 *
 * ## Order, and why
 *
 *   1. The revision token is well-formed (no I/O for a malformed request).
 *   2. The Product exists AND the acting participant holds creator authority
 *      over its current version — one error for both, so a guessed reference
 *      learns nothing.
 *   3. Inside ONE transaction, with the Product row locked (`FOR UPDATE`):
 *        - the token still names the current version (a stale page cannot
 *          activate a version the Seller never saw);
 *        - authority is asked again;
 *        - the effective lifecycle and every readiness gate are derived from the
 *          rows as this transaction sees them — never from the request;
 *        - SUSPENDED, already ACTIVE, and not ready are refused, in that order;
 *        - the incumbent activation (lapsed, or the Product would be ACTIVE) is
 *          superseded and the new activation recorded with its readiness basis.
 *
 * The row lock serialises two activations of one Product: the second sees the
 * first's authority in effect and is refused as already ACTIVE. The unique
 * `currentForProductId` marker is the database's own guarantee behind that.
 *
 * ## What it does not do
 *
 * Requires no Storefront, Listing, or Offer, and writes none. Writes no source
 * version, no Order, payment, payout, Node, capsule, publication, or outbox
 * state. `resaleAvailability` does not exist yet and is not touched.
 */

import "../server-only";
import { Prisma } from "@prisma/client";
import { activationBasisFrom } from "../../contracts/product/product-lifecycle";
import { getPrisma } from "../db/client";
import {
  ConcurrencyConflictError,
  ProductActivationNotReadyError,
  ProductAlreadyActiveError,
  ProductNotAvailableError,
  ProductSuspendedError,
  ValidationError,
} from "../product/errors";
import {
  cryptoProductLifecycleIdProvider,
  type ProductLifecycleIdProvider,
} from "../product/product-lifecycle-ids";
import { readProductLifecycleIn } from "../product/product-lifecycle-service";
import { ProductRevisionToken, productRevisionToken } from "../product/product-revision-token";
import { resolveActingSubject } from "./acting-subject-service";
import { participantHoldsProductAuthority } from "./product-authority-service";

type Db = ReturnType<typeof getPrisma>;

export interface ProductActivationServiceDeps {
  db?: Db;
  ids?: ProductLifecycleIdProvider;
}

export interface ActivatedProduct {
  /** The stable application reference — unchanged by activation. */
  productRef: string;
  lifecycle: "ACTIVE";
  /** The current version's revision token — unchanged; activation writes no version. */
  revisionToken: string;
}

function staleActivation(): ConcurrencyConflictError {
  return new ConcurrencyConflictError(
    "The Product changed since this activation was requested; the expected revision is not current",
  );
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Activate a Product the acting account's participant authors.
 *
 * Throws `ValidationError`, `ProductNotAvailableError`,
 * `ConcurrencyConflictError` (stale token, or a concurrent activation won the
 * race), `ProductSuspendedError`, `ProductAlreadyActiveError`, or
 * `ProductActivationNotReadyError` with the blockers.
 */
export async function activateProductAs(
  actor: { accountId: string },
  request: { productRef: string; expectedRevision: string; now: string },
  deps: ProductActivationServiceDeps = {},
): Promise<ActivatedProduct> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoProductLifecycleIdProvider;

  const expected = ProductRevisionToken.safeParse(request.expectedRevision);
  if (!expected.success) {
    throw new ValidationError("Invalid Product revision token", ["expectedRevision: malformed"]);
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
      /* Serialise with any other activation, suspension, or pointer move of
         this Product: each locks or updates this row first. */
      await tx.$queryRaw`SELECT internalProductId FROM Product WHERE internalProductId = ${internalProductId} FOR UPDATE`;

      const read = await readProductLifecycleIn(tx, internalProductId);
      if (read === null) throw new ProductNotAvailableError();
      if (
        productRevisionToken(read.sourceRecordId, read.currentSourceRecordVersion) !== expected.data
      ) {
        throw staleActivation();
      }
      if (!(await participantHoldsProductAuthority(tx, internalProductId, participantId))) {
        throw new ProductNotAvailableError();
      }

      const { lifecycle } = read;
      if (lifecycle.lifecycle === "SUSPENDED") throw new ProductSuspendedError();
      if (lifecycle.lifecycle === "ACTIVE") throw new ProductAlreadyActiveError();
      if (!lifecycle.readiness.ready) {
        throw new ProductActivationNotReadyError(lifecycle.readiness.blockers);
      }

      /* Readiness passed, so every basis instant exists; refuse rather than
         guess if one does not. */
      const basis = activationBasisFrom(read.basisNow);
      if (basis === null || basis.participantId !== participantId) {
        throw new ProductActivationNotReadyError(["PARTICIPANT_MISSING"]);
      }

      const at = new Date(request.now);
      if (read.currentActivationId !== null) {
        await tx.productActivation.update({
          where: { id: read.currentActivationId },
          data: { supersededAt: at, currentForProductId: null },
        });
      }
      await tx.productActivation.create({
        data: {
          id: ids.nextProductActivationId(),
          internalProductId,
          participantId,
          activatedByAccountId: actor.accountId,
          activatedAt: at,
          activatedSourceRecordVersion: read.currentSourceRecordVersion,
          activatedVersionSeq: read.currentVersionSeq,
          basisEmailVerifiedAt: new Date(basis.emailVerifiedAt),
          basisSellerRoleActivatedAt: new Date(basis.sellerRoleActivatedAt),
          basisPaymentEnabledSince: new Date(basis.paymentEnabledSince),
          basisRestrictionCount: basis.restrictionCount,
          basisParticipantSuspensionCount: basis.participantSuspensionCount,
          basisNonApprovalDecisionCount: basis.nonApprovalDecisionCount,
          basisProductSuspensionCount: basis.productSuspensionCount,
          currentForProductId: internalProductId,
        },
      });

      return {
        productRef: read.productRef,
        lifecycle: "ACTIVE" as const,
        revisionToken: productRevisionToken(read.sourceRecordId, read.currentSourceRecordVersion),
      };
    });
  } catch (error) {
    /* Two activations racing past the lock is impossible; the unique marker
       makes it a refusal rather than two current activations if it ever were. */
    if (isUniqueViolation(error)) throw staleActivation();
    throw error;
  }
}
