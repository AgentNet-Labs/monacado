/**
 * Product tax-fact resolution (Phase 1.6) — SERVER ONLY.
 *
 * Reads the **authoritative Product source version** a Product currently points
 * at and returns the facts a production tax calculation needs: which version it
 * is, what it is classified as, and how it is delivered.
 *
 * ## It follows the source-version model, not a shortcut
 *
 * The same path `product-delivery-mode-service.ts` takes, for the same reasons:
 * the facts come from the `ProductSourceRecordVersionRow` the stable record
 * currently points at, they are **not** denormalised onto the stable row, and
 * they are **not** inferred from anything. No name, no category, no
 * `specifications` key, no `capabilities` entry. Reading a tax classification out
 * of a free-form spec would make a tax rate depend on how somebody phrased a
 * product description.
 *
 * ## Absent is reported, never guessed
 *
 * A Product with no version row, or a version row written before the fact
 * existed, yields `null` for that fact. This function deliberately does not
 * decide what absence means — it reports it, and the refusal lives in one place
 * at the checkout boundary.
 *
 * ## Why the version comes back too
 *
 * The classification alone would be enough to *calculate* with, and not enough to
 * *explain* afterwards. Returning the exact `(sourceRecordId, sourceRecordVersion)`
 * is what lets a sale pin the version its rate was computed from — so
 * reclassifying a Product tomorrow changes nothing about a sale made today.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { DeliveryMode } from "../../contracts/marketplace/basket-fulfillment";
import { ProductTaxClassification } from "../../contracts/product/product-tax-classification";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

/** What the Product's current source version declares, for tax purposes. */
export interface ProductTaxFacts {
  internalProductId: string;
  sourceRecordId: string;
  /** The EXACT version the stable record points at — never "latest". */
  sourceRecordVersion: string;
  /** `null` where the version declares none. Never defaulted. */
  taxClassification: ProductTaxClassification | null;
  /** `null` where the version declares none. Never defaulted. */
  deliveryMode: DeliveryMode | null;
}

/**
 * The tax facts a Product currently declares, or `null` if there is no Product.
 *
 * A missing Product and an unclassified Product are **different answers** and are
 * reported differently: the first has no record at all, the second has a record
 * that says nothing about tax. Collapsing them would leave a caller unable to
 * tell a data-entry gap from a broken reference.
 */
export async function resolveProductTaxFacts(
  tx: Tx,
  internalProductId: string,
): Promise<ProductTaxFacts | null> {
  const stable = await tx.product.findUnique({
    where: { internalProductId },
    select: { sourceRecordId: true, currentSourceRecordVersion: true },
  });
  if (stable === null) return null;

  const version = await tx.productSourceRecordVersionRow.findFirst({
    where: {
      sourceRecordId: stable.sourceRecordId,
      sourceRecordVersion: stable.currentSourceRecordVersion,
    },
    select: { factDeliveryMode: true, taxClassification: true },
  });
  if (version === null) return null;

  const classification = ProductTaxClassification.safeParse(version.taxClassification);
  const delivery = DeliveryMode.safeParse(version.factDeliveryMode);

  return {
    internalProductId,
    sourceRecordId: stable.sourceRecordId,
    sourceRecordVersion: stable.currentSourceRecordVersion,
    /* A value the enum does not recognise is treated as ABSENT rather than
       passed through — an unrecognised classification is exactly as undecidable
       as a missing one, and both must reach the same refusal. */
    taxClassification: classification.success ? classification.data : null,
    deliveryMode: delivery.success ? delivery.data : null,
  };
}

/**
 * How much of the catalogue is classified, for a launch review.
 *
 * Counts only what each Product **currently** points at, because that is what a
 * buyer would be sold today. Historical versions are deliberately excluded: they
 * are immutable, unclassifiable after the fact, and reporting them as gaps would
 * make a readiness figure that can never reach zero.
 *
 * Read-only, and it names no Product — a launch-review figure, not a work queue.
 * The queue is a separate question and would need paging, ordering, and a scope
 * decision this does not have.
 */
export async function summarizeProductTaxClassificationReadiness(
  tx: Tx,
): Promise<{ totalProducts: number; classified: number; unclassified: number }> {
  const rows = await tx.$queryRaw<Array<{ classified: bigint; total: bigint }>>`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN v.taxClassification IS NOT NULL THEN 1 ELSE 0 END) AS classified
    FROM Product p
    JOIN ProductSourceRecordVersionRow v
      ON v.sourceRecordId = p.sourceRecordId
     AND v.sourceRecordVersion = p.currentSourceRecordVersion
  `;
  const row = rows[0];
  const total = row === undefined ? 0 : Number(row.total ?? 0);
  const classified = row === undefined ? 0 : Number(row.classified ?? 0);
  return { totalProducts: total, classified, unclassified: total - classified };
}
