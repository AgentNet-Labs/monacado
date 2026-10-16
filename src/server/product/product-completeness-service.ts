/**
 * Product completeness from the database (Phase 1.38) — SERVER ONLY.
 *
 * Reads the Seller-authoritative facts of the Product's **current
 * authoritative source version** — the `ProductSourceRecordVersionRow` the
 * stable record points at, never "latest", never a version a caller names — and
 * evaluates `PRODUCT_COMPLETENESS_V1` over them with the one evaluator in
 * `product-completeness.ts`.
 *
 * The seam later Product activation asks through: it takes a transaction, so an
 * activation decision can read completeness against the same rows it writes.
 *
 * Reads only the columns completeness needs; `taxClassification`,
 * `generalAvailabilityState`, and `recordStatus` are not selected, so they
 * cannot influence the answer. Stores nothing.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  evaluateProductCompletenessV1,
  type ProductCompletenessResult,
} from "../../contracts/product/product-completeness";
import { shippingPolicyFromColumns } from "./persistence-mapper";
import { getPrisma } from "../db/client";

type Tx = ReturnType<typeof getPrisma> | Prisma.TransactionClient;

/** The columns of a version row completeness reads — and only those. */
export const PRODUCT_COMPLETENESS_COLUMNS = {
  factName: true,
  factDescription: true,
  factDeliveryMode: true,
  shippingPolicyMethod: true,
  shippingFixedChargeMinorUnits: true,
  shippingFixedChargeCurrency: true,
} as const;

/** Evaluate completeness over one version row's completeness columns. */
export function evaluateCompletenessOfVersionRow(row: {
  factName: string;
  factDescription: string | null;
  factDeliveryMode: string | null;
  shippingPolicyMethod: string | null;
  shippingFixedChargeMinorUnits: bigint | null;
  shippingFixedChargeCurrency: string | null;
}): ProductCompletenessResult {
  return evaluateProductCompletenessV1({
    name: row.factName,
    description: row.factDescription,
    deliveryMode: row.factDeliveryMode,
    shippingPolicy: shippingPolicyFromColumns(row),
  });
}

/**
 * `PRODUCT_COMPLETENESS_V1` for a Product's current version, or `null` when the
 * Product or its current version does not exist. A missing Product is not an
 * incomplete one, and the two are not collapsed.
 */
export async function readCurrentProductCompleteness(
  tx: Tx,
  internalProductId: string,
): Promise<ProductCompletenessResult | null> {
  const product = await tx.product.findUnique({
    where: { internalProductId },
    select: { sourceRecordId: true, currentSourceRecordVersion: true },
  });
  if (product === null) return null;

  const row = await tx.productSourceRecordVersionRow.findUnique({
    where: {
      sourceRecordId_sourceRecordVersion: {
        sourceRecordId: product.sourceRecordId,
        sourceRecordVersion: product.currentSourceRecordVersion,
      },
    },
    select: PRODUCT_COMPLETENESS_COLUMNS,
  });
  return row === null ? null : evaluateCompletenessOfVersionRow(row);
}
