/**
 * Governed Product suspension and reinstatement (Phase 1.39, Contract §9.1) —
 * SERVER ONLY. No route reaches this module; it is the primitive a future
 * operator surface will call.
 *
 * A Monacado-controlled administrative commerce block on ONE Product. Distinct
 * from `ParticipantSuspension` (which withdraws a participant's admission) and
 * never Seller-controlled.
 *
 * ## Order of checks (on `participant-suspension-service`'s pattern)
 *
 *   1. **Authorization** from persisted entitlement state — an explicit active
 *      `product:suspend` grant — before any Product row is read.
 *   2. Inside one transaction, the Product row locked: the Product exists, and
 *      the acting account's participant does not author it (no self-action).
 *   3. The evidence row, in the same transaction.
 *
 * ## What a suspension records
 *
 * Product, reason, instant, actor — and the effective lifecycle IMMEDIATELY
 * BEFORE, with the activation then in effect when it was `ACTIVE`. That is the
 * context §9.1's reinstatement rule needs: lifting may restore `ACTIVE` only
 * where it existed immediately before, and never create it. Lifting does not
 * write a lifecycle at all — the lifecycle is derived — so "restore" means only
 * that the recorded activation stays eligible to be in effect, and it is in
 * effect after the lift only if the Product is complete and every readiness fact
 * held continuously throughout (`contracts/product/product-lifecycle.ts`).
 *
 * History is never destroyed: lifting is a state change with its own instant,
 * actor, and reason, and the claim is conditional on the suspension still being
 * ACTIVE, so a concurrent lift changes nothing.
 *
 * Neither act writes a source version, an Offer, a Listing, an Order, or any
 * publication state.
 */

import "../server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AccountId } from "../../contracts/account/account";
import {
  canSuspendProduct,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import {
  ProductSuspensionLiftReasonCode,
  ProductSuspensionReasonCode,
  type ProductLifecycleState,
} from "../../contracts/product/product-lifecycle";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import { getPrisma } from "../db/client";
import {
  ProductAlreadySuspendedError,
  ProductNotAvailableError,
  ProductSuspensionAlreadyLiftedError,
  ProductSuspensionNotAuthorizedError,
  ProductSuspensionNotFoundError,
  ProductSuspensionSelfActionNotPermittedError,
  ValidationError,
} from "../product/errors";
import {
  cryptoProductLifecycleIdProvider,
  type ProductLifecycleIdProvider,
} from "../product/product-lifecycle-ids";
import { readProductLifecycleIn } from "../product/product-lifecycle-service";

type Db = ReturnType<typeof getPrisma>;

export interface ProductSuspensionServiceDeps {
  db?: Db;
  ids?: ProductLifecycleIdProvider;
}

export const SuspendProductInput = z.strictObject({
  internalProductId: z.string().min(1),
  reasonCode: ProductSuspensionReasonCode,
  /** The acting internal account — authorization principal AND audit actor. */
  actingAccountId: AccountId,
  suspendedAt: z.iso.datetime(),
});

export const ReinstateProductInput = z.strictObject({
  suspensionId: z.string().min(1),
  reasonCode: ProductSuspensionLiftReasonCode,
  actingAccountId: AccountId,
  reinstatedAt: z.iso.datetime(),
});

export interface ProductSuspensionResult {
  suspensionId: string;
  status: "ACTIVE" | "LIFTED";
  lifecycleBeforeSuspension: Exclude<ProductLifecycleState, "SUSPENDED">;
  /** The Product's effective lifecycle after the act, derived from current facts. */
  lifecycleNow: ProductLifecycleState;
}

function inputError(error: z.ZodError): ValidationError {
  return new ValidationError(
    "Invalid Product suspension input",
    error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  );
}

async function assertProductSuspensionAuthority(db: Db, actingAccountId: string): Promise<void> {
  const subject = await resolveInternalAuthorizationSubject(actingAccountId, { db });
  if (!isInternallyAuthorized(canSuspendProduct(subject))) {
    throw new ProductSuspensionNotAuthorizedError();
  }
}

/** Refuse when the acting account's own participant authors this Product. */
async function assertNotSelfAction(
  tx: Prisma.TransactionClient,
  actingAccountId: string,
  authorityParticipantId: string | null,
): Promise<void> {
  if (authorityParticipantId === null) return;
  const participant = await tx.marketplaceParticipant.findUnique({
    where: { accountId: actingAccountId },
    select: { id: true },
  });
  if (participant?.id === authorityParticipantId) {
    throw new ProductSuspensionSelfActionNotPermittedError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Suspend a Product. */
export async function suspendProduct(
  input: unknown,
  deps: ProductSuspensionServiceDeps = {},
): Promise<ProductSuspensionResult> {
  const parsed = SuspendProductInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { internalProductId, reasonCode, actingAccountId, suspendedAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoProductLifecycleIdProvider;
  const suspensionId = ids.nextProductSuspensionId();

  await assertProductSuspensionAuthority(db, actingAccountId);

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT internalProductId FROM Product WHERE internalProductId = ${internalProductId} FOR UPDATE`;
      const before = await readProductLifecycleIn(tx, internalProductId);
      if (before === null) throw new ProductNotAvailableError();
      await assertNotSelfAction(tx, actingAccountId, before.authorityParticipantId);

      const lifecycleBefore = before.lifecycle.lifecycle;
      if (lifecycleBefore === "SUSPENDED") throw new ProductAlreadySuspendedError();

      await tx.productSuspension.create({
        data: {
          id: suspensionId,
          internalProductId,
          reasonCode,
          status: "ACTIVE",
          lifecycleBeforeSuspension: lifecycleBefore,
          /* Only an activation IN EFFECT is recorded — a lapsed one is history,
             and recording it would let reinstatement resurrect it. */
          activationIdBeforeSuspension: before.lifecycle.activationInEffect
            ? before.currentActivationId
            : null,
          imposedAt: new Date(suspendedAt),
          imposedByAccountId: actingAccountId,
          activeForProductId: internalProductId,
        },
      });

      const after = await readProductLifecycleIn(tx, internalProductId);
      return {
        suspensionId,
        status: "ACTIVE" as const,
        lifecycleBeforeSuspension: lifecycleBefore,
        lifecycleNow: after!.lifecycle.lifecycle,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductAlreadySuspendedError();
    throw error;
  }
}

/**
 * Lift a Product suspension. The resulting lifecycle is RE-EVALUATED from
 * current facts, never blindly restored (Contract §9.1).
 */
export async function reinstateProduct(
  input: unknown,
  deps: ProductSuspensionServiceDeps = {},
): Promise<ProductSuspensionResult> {
  const parsed = ReinstateProductInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { suspensionId, reasonCode, actingAccountId, reinstatedAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  await assertProductSuspensionAuthority(db, actingAccountId);

  return db.$transaction(async (tx) => {
    const existing = await tx.productSuspension.findUnique({
      where: { id: suspensionId },
      select: { internalProductId: true, lifecycleBeforeSuspension: true },
    });
    if (existing === null) throw new ProductSuspensionNotFoundError();
    const internalProductId = existing.internalProductId;

    await tx.$queryRaw`SELECT internalProductId FROM Product WHERE internalProductId = ${internalProductId} FOR UPDATE`;
    const current = await readProductLifecycleIn(tx, internalProductId);
    if (current === null) throw new ProductNotAvailableError();
    await assertNotSelfAction(tx, actingAccountId, current.authorityParticipantId);

    const claimed = await tx.productSuspension.updateMany({
      where: { id: suspensionId, status: "ACTIVE" },
      data: {
        status: "LIFTED",
        liftedAt: new Date(reinstatedAt),
        liftedByAccountId: actingAccountId,
        liftedReasonCode: reasonCode,
        /* Released, so the Product may be suspended again later — as a NEW row. */
        activeForProductId: null,
      },
    });
    if (claimed.count !== 1) throw new ProductSuspensionAlreadyLiftedError();

    const after = await readProductLifecycleIn(tx, internalProductId);
    return {
      suspensionId,
      status: "LIFTED" as const,
      lifecycleBeforeSuspension:
        existing.lifecycleBeforeSuspension as ProductSuspensionResult["lifecycleBeforeSuspension"],
      lifecycleNow: after!.lifecycle.lifecycle,
    };
  });
}
