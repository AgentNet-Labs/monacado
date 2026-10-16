/**
 * Monacado Product tax classification (Phase 1.39) — SERVER ONLY.
 *
 * `taxClassification` is a Monacado fiscal control fact (Phase 1.6): what kind
 * of thing is sold, for tax. It is Monacado's to assign, never the Seller's, and
 * the Product activation gate requires it. This is the one path that assigns or
 * changes it.
 *
 * ## Authority
 *
 * An explicit active `product:tax-classify` entitlement — asked BEFORE any
 * Product is read (so an unauthorised caller learns nothing about which
 * references exist) and asked AGAIN inside the write transaction. Owning or
 * authoring the Product confers nothing, and an account whose own participant
 * authors the Product may not classify it even with the grant — the self-action
 * rule every comparable staff power applies.
 *
 * ## Persistence
 *
 * The classification lives on the immutable Product source version, so a change
 * is a NEW version written through `createProductSourceRecordRevision`: earlier
 * versions untouched, the current pointer advanced once under its optimistic
 * guard, `productRef` unchanged, every Seller fact and the creator authority
 * carried forward. The act's evidence — who, when, which version, what it
 * replaced — is a `ProductTaxClassificationAct` row in the same transaction.
 *
 * ## What it never does
 *
 * Infers, defaults, or clears a classification (there is no clearing: a revision
 * cannot erase a sale's tax basis). Accepts `PHYSICAL_GOOD` for a Product
 * delivered `DIGITAL` — the one contradiction refused. Changes completeness,
 * which is the Seller's and does not read this fact. Activates a Product — the
 * Seller still does that explicitly. Writes an Offer, Listing, Storefront, Order,
 * payment, Node, publication, or outbox row.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { canClassifyProductTax, isInternallyAuthorized } from "../../contracts/account/internal-authorization";
import {
  ProductTaxClassification,
  taxClassificationAgreesWithDelivery,
} from "../../contracts/product/product-tax-classification";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import { getPrisma } from "../db/client";
import {
  ProductNotAvailableError,
  ProductTaxClassificationContradictsDeliveryError,
  ProductTaxClassificationNotAuthorizedError,
  ProductTaxClassificationSelfActionNotPermittedError,
  ProductTaxClassificationUnchangedError,
  ValidationError,
} from "../product/errors";
import {
  cryptoProductLifecycleIdProvider,
  type ProductLifecycleIdProvider,
} from "../product/product-lifecycle-ids";
import { ProductRepository } from "../product/product-repository";
import { nextSourceRecordVersion } from "./product-revision-service";

type Db = ReturnType<typeof getPrisma>;

export interface ProductTaxClassificationServiceDeps {
  db?: Db;
  ids?: ProductLifecycleIdProvider;
}

export interface ClassifiedProduct {
  productRef: string;
  taxClassification: ProductTaxClassification;
}

async function assertTaxClassifyAuthority(
  db: Db | Prisma.TransactionClient,
  actingAccountId: string,
): Promise<void> {
  const subject = await resolveInternalAuthorizationSubject(actingAccountId, { db });
  if (!isInternallyAuthorized(canClassifyProductTax(subject))) {
    throw new ProductTaxClassificationNotAuthorizedError();
  }
}

/**
 * Assign or change a Product's tax classification as a Monacado operator.
 *
 * Throws `ValidationError`, `ProductTaxClassificationNotAuthorizedError`,
 * `ProductNotAvailableError`, `ProductTaxClassificationSelfActionNotPermittedError`,
 * `ProductTaxClassificationContradictsDeliveryError`,
 * `ProductTaxClassificationUnchangedError`, or `ConcurrencyConflictError` (the
 * Product was revised concurrently; nothing was written).
 */
export async function classifyProductTaxAs(
  actor: { accountId: string },
  request: { productRef: string; taxClassification: unknown; now: string },
  deps: ProductTaxClassificationServiceDeps = {},
): Promise<ClassifiedProduct> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoProductLifecycleIdProvider;

  const parsed = ProductTaxClassification.safeParse(request.taxClassification);
  if (!parsed.success) {
    throw new ValidationError("Invalid Product tax classification", ["taxClassification: not a governed classification"]);
  }
  const taxClassification = parsed.data;

  await assertTaxClassifyAuthority(db, actor.accountId);

  const product = await db.product.findUnique({
    where: { productRef: request.productRef },
    select: { internalProductId: true, productRef: true },
  });
  if (product === null) throw new ProductNotAvailableError();

  const repository = new ProductRepository(db);
  const prior = await repository.getCurrentProductSourceRecord(product.internalProductId);

  /* Checked against `prior`, which the repository's optimistic guard pins as the
     version being superseded — a concurrent Seller revision is a conflict, not
     a classification silently applied to facts it was never checked against. */
  const deliveryMode = prior.facts.deliveryMode;
  if (deliveryMode !== undefined && !taxClassificationAgreesWithDelivery(taxClassification, deliveryMode)) {
    throw new ProductTaxClassificationContradictsDeliveryError();
  }
  if (prior.taxClassification === taxClassification) {
    throw new ProductTaxClassificationUnchangedError();
  }

  const sourceRecordVersion = nextSourceRecordVersion(prior.sourceRecordVersion);
  await repository.createProductSourceRecordRevision({
    internalProductId: product.internalProductId,
    expectedCurrentSourceRecordVersion: prior.sourceRecordVersion,
    sourceRecordVersion,
    updatedAt: request.now,
    capsuleGeneratedAt: request.now,
    taxClassification,
    authorize: async (tx) => {
      /* The decision and the write see the same rows. */
      await assertTaxClassifyAuthority(tx, actor.accountId);
      const actingParticipant = await tx.marketplaceParticipant.findUnique({
        where: { accountId: actor.accountId },
        select: { id: true },
      });
      if (actingParticipant !== null) {
        const current = await tx.productSourceRecordVersionRow.findUnique({
          where: {
            sourceRecordId_sourceRecordVersion: {
              sourceRecordId: prior.sourceRecordId,
              sourceRecordVersion: prior.sourceRecordVersion,
            },
          },
          select: { authorityCreatorParticipantId: true },
        });
        /* Stricter than "holds authority": naming the participant as creator at
           all is enough to refuse, whatever the authorization state says. */
        if (current?.authorityCreatorParticipantId === actingParticipant.id) {
          throw new ProductTaxClassificationSelfActionNotPermittedError();
        }
      }
    },
    recordEvidence: async (tx, next) => {
      await tx.productTaxClassificationAct.create({
        data: {
          id: ids.nextProductTaxClassificationId(),
          internalProductId: product.internalProductId,
          sourceRecordVersion: next.sourceRecordVersion,
          previousTaxClassification: prior.taxClassification ?? null,
          taxClassification,
          classifiedAt: new Date(request.now),
          classifiedByAccountId: actor.accountId,
        },
      });
    },
  });

  return { productRef: product.productRef, taxClassification };
}
