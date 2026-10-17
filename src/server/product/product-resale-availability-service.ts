/**
 * Product resale availability from the database (Phase 1.40) — SERVER ONLY.
 *
 * Reads the Seller's recorded resale-availability state (Contract §9.3) and,
 * with the derived lifecycle, the one resale-effectiveness answer future
 * promoted-commerce eligibility (§16.3) consumes. Reads only; each reader takes
 * a transaction so a writer decides on the same rows it writes.
 *
 * The current state is the act holding `currentForProductId`; no act means the
 * default `NOT_OFFERED`. Nothing else is read for it: not the legacy
 * `factPromotable`, not `generalAvailabilityState`, and no Storefront, Listing,
 * Offer, or Order row.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  DEFAULT_PRODUCT_RESALE_AVAILABILITY,
  ProductResaleAvailability,
  productResaleEffectiveness,
  type ProductResaleEffectiveness,
} from "../../contracts/product/product-resale-availability";
import type { ProductLifecycleState } from "../../contracts/product/product-lifecycle";
import { getPrisma } from "../db/client";
import { PersistedContractViolationError } from "./errors";
import { readProductLifecycleIn } from "./product-lifecycle-service";

type Tx = ReturnType<typeof getPrisma> | Prisma.TransactionClient;

export interface ProductResaleAvailabilityRead {
  resaleAvailability: ProductResaleAvailability;
  /** The current act's id, or `null` while the default stands. Never exposed. */
  currentActId: string | null;
}

/** A stored value outside the vocabulary is corruption, refused rather than guessed. */
function parseStored(value: string): ProductResaleAvailability {
  const parsed = ProductResaleAvailability.safeParse(value);
  if (!parsed.success) {
    throw new PersistedContractViolationError("Stored resale availability is outside the governed vocabulary", [
      "resaleAvailability: unknown value",
    ]);
  }
  return parsed.data;
}

/** The recorded resale availability of one Product. */
export async function readProductResaleAvailabilityIn(
  tx: Tx,
  internalProductId: string,
): Promise<ProductResaleAvailabilityRead> {
  const act = await tx.productResaleAvailabilityAct.findUnique({
    where: { currentForProductId: internalProductId },
    select: { id: true, resaleAvailability: true },
  });
  if (act === null) return { resaleAvailability: DEFAULT_PRODUCT_RESALE_AVAILABILITY, currentActId: null };
  return { resaleAvailability: parseStored(act.resaleAvailability), currentActId: act.id };
}

/** The recorded resale availability of several Products, keyed by internal id. */
export async function readProductResaleAvailabilitiesIn(
  tx: Tx,
  internalProductIds: readonly string[],
): Promise<Map<string, ProductResaleAvailability>> {
  const out = new Map<string, ProductResaleAvailability>(
    internalProductIds.map((id) => [id, DEFAULT_PRODUCT_RESALE_AVAILABILITY]),
  );
  if (internalProductIds.length === 0) return out;
  const acts = await tx.productResaleAvailabilityAct.findMany({
    where: { currentForProductId: { in: [...internalProductIds] } },
    select: { currentForProductId: true, resaleAvailability: true },
  });
  for (const act of acts) {
    if (act.currentForProductId !== null) out.set(act.currentForProductId, parseStored(act.resaleAvailability));
  }
  return out;
}

export interface ProductResaleEffectivenessRead extends ProductResaleEffectiveness {
  lifecycle: ProductLifecycleState;
  resaleAvailability: ProductResaleAvailability;
}

/**
 * The resale-effectiveness of one Product NOW — effective lifecycle `ACTIVE` and
 * resale `AVAILABLE` — or `null` when the Product does not exist. Necessary for
 * promoted commerce, never sufficient: Offer, Promotion Authorization, and
 * Promoter readiness are later gates this does not ask.
 */
export async function readProductResaleEffectivenessIn(
  tx: Tx,
  internalProductId: string,
): Promise<ProductResaleEffectivenessRead | null> {
  const lifecycleRead = await readProductLifecycleIn(tx, internalProductId);
  if (lifecycleRead === null) return null;
  const { resaleAvailability } = await readProductResaleAvailabilityIn(tx, internalProductId);
  const lifecycle = lifecycleRead.lifecycle.lifecycle;
  return { lifecycle, resaleAvailability, ...productResaleEffectiveness({ lifecycle, resaleAvailability }) };
}
