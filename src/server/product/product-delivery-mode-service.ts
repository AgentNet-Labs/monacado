/**
 * Product delivery-mode resolution (Phase 1.2 correction) — SERVER ONLY.
 *
 * Reads the **authoritative Product source version** for each basket line and
 * returns its declared delivery mode.
 *
 * ## It follows the source-version model, not a shortcut
 *
 * The mode is read from the `ProductSourceRecordVersionRow` the Product's stable
 * record currently points at — the same authoritative path every other Product
 * fact travels. It is **not** denormalised onto the stable row and **not**
 * inferred from anything: no name, no category, no `specifications` key, no
 * `capabilities` entry. Those are free-form and creator-supplied, and reading a
 * checkout rule out of one would make whether a buyer is asked for an address
 * depend on how somebody phrased a spec.
 *
 * ## Absent is reported, never guessed
 *
 * A Product with no version row, or a version row that predates the fact, yields
 * `null`. `evaluateBasketFulfillment` then refuses the checkout. This function
 * deliberately does not decide what absence means — it reports it, and the policy
 * lives in one place.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import type { BasketDeliveryLine } from "../../contracts/marketplace/basket-fulfillment";
import { DeliveryMode } from "../../contracts/marketplace/basket-fulfillment";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

/**
 * The delivery mode each Product currently declares.
 *
 * Takes a list because the rule is a basket rule; a single-Listing checkout
 * passes one id. Order is preserved so a caller can correlate refusals.
 */
export async function resolveBasketDeliveryLines(
  tx: Tx,
  internalProductIds: readonly string[],
): Promise<BasketDeliveryLine[]> {
  const lines: BasketDeliveryLine[] = [];

  for (const internalProductId of internalProductIds) {
    const stable = await tx.product.findUnique({
      where: { internalProductId },
      select: { sourceRecordId: true, currentSourceRecordVersion: true },
    });
    if (stable === null) {
      lines.push({ internalProductId, deliveryMode: null });
      continue;
    }

    /* The version the stable record POINTS AT — never "latest", and never a
       version a caller named. A buyer's checkout is governed by what the Product
       currently declares. */
    const version = await tx.productSourceRecordVersionRow.findFirst({
      where: {
        sourceRecordId: stable.sourceRecordId,
        sourceRecordVersion: stable.currentSourceRecordVersion,
      },
      select: { factDeliveryMode: true },
    });

    const parsed = DeliveryMode.safeParse(version?.factDeliveryMode);
    lines.push({
      internalProductId,
      /* A value the enum does not recognise is treated as ABSENT rather than
         passed through — an unrecognised mode is exactly as undecidable as a
         missing one, and both must reach the same refusal. */
      deliveryMode: parsed.success ? parsed.data : null,
    });
  }

  return lines;
}
