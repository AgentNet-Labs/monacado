/**
 * Seller Product revision (Phase 1.38) — SERVER ONLY.
 *
 * A Seller restates the facts self-service revision governs — `name`,
 * `description`, `deliveryMode`, and the Seller shipping policy — and the
 * Product gains ONE new immutable source version saying so. This is what lets a
 * Seller satisfy `PRODUCT_COMPLETENESS_V1` (`PRODUCT_COMPLETENESS_PROFILE.md`
 * §7): a description added after drafting, or a shipping policy for a shipped
 * Product, can now be stated.
 *
 * ## It is the existing version model, not a new one
 *
 * The write is `ProductRepository.createProductSourceRecordRevision`: a new
 * `ProductSourceRecordVersionRow`, the stable record's current-version pointer
 * advanced exactly once under its optimistic-concurrency guard, and every
 * earlier version untouched. The stable `productRef` never moves. Nothing here
 * updates a version row in place.
 *
 * ## What carries forward
 *
 * Everything the input does not govern: `promotable`, `generalAvailabilityState`,
 * `productVersion`, image, specifications, capabilities, relationships, the
 * authority block, `taxClassification`, `recordStatus`, `capsuleSemver`, and
 * `mappingVersion`. A Seller cannot reach any of them here — in particular not
 * the Monacado-authoritative `taxClassification`.
 *
 * ## Delivery-mode changes
 *
 * The input restates the shipping policy beside the delivery mode, and
 * `ProductRevisionInput` refuses a policy beside a non-shipped mode. So a
 * Product revised from `PHYSICAL` to `DIGITAL` gets a new version with **no**
 * policy (the old version keeps its own), and a Product revised to `PHYSICAL`
 * without a policy simply has none — it is incomplete until one is stated.
 * `FREE` is never invented.
 *
 * ## Conditional on what the Seller edited
 *
 * Every revision names the state it was made from with an opaque revision token
 * (`product-revision-token.ts`). If the Product has moved on since — another tab
 * or session saved first — the revision is refused with
 * `ConcurrencyConflictError` and writes nothing: no version, no pointer move.
 * The token is checked before any work and again INSIDE the write transaction,
 * against the current pointer the transaction sees, so a stale edit can never
 * silently overwrite a newer one. A success returns the new state's token.
 *
 * ## Authority
 *
 * The acting participant must hold creator authority over the Product's
 * current version (`participantHoldsProductAuthority`), and must still be
 * permitted to author Products at all (`assertAccountMayAuthorProductIn`). Both
 * are asked again INSIDE the revision transaction, so neither a suspension nor
 * an authority change can land between the decision and the write. "No such
 * Product" and "someone else's Product" are one error.
 *
 * ## What it does not do
 *
 * No lifecycle state, activation, Offer, Listing, Order, payment, payout,
 * Node, capsule, publication, or outbox state is read for a decision or written.
 * It evaluates completeness for the caller's convenience and stores none.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { canonicalJsonString } from "../../contracts/integrity/canonical-json";
import {
  ProductRevisionInput,
  type ProductSourceRecord,
} from "../../contracts/product/product-source-record";
import {
  evaluateProductCompletenessV1,
  productCompletenessInputFromRecord,
  type ProductCompletenessResult,
} from "../../contracts/product/product-completeness";
import { ProductRepository } from "../product/product-repository";
import {
  ConcurrencyConflictError,
  ProductNotAvailableError,
  ProductRevisionUnchangedError,
  ValidationError,
} from "../product/errors";
import { ProductRevisionToken, productRevisionToken } from "../product/product-revision-token";
import { getPrisma } from "../db/client";
import { resolveActingSubject } from "./acting-subject-service";
import { participantHoldsProductAuthority } from "./product-authority-service";
import { assertAccountMayAuthorProductIn } from "./product-authoring-service";

type Db = ReturnType<typeof getPrisma>;

export interface RevisedProduct {
  /** The stable application reference — unchanged by the revision. */
  productRef: string;
  /** The new current source version, as written. */
  record: ProductSourceRecord;
  /** `PRODUCT_COMPLETENESS_V1` over the new current version. */
  completeness: ProductCompletenessResult;
  /** The opaque revision token of the new current version — what the next edit sends. */
  revisionToken: string;
}

/** The refusal for an edit made from a state that is no longer current. */
function staleRevision(): ConcurrencyConflictError {
  return new ConcurrencyConflictError(
    "The Product changed since this revision was prepared; the expected revision is not current",
  );
}

/**
 * The next version label after `prior`. Self-service Products are versioned
 * "1", "2", …; a label that is not a positive integer was not written by this
 * path and is refused rather than guessed past.
 */
export function nextSourceRecordVersion(prior: string): string {
  if (!/^[1-9][0-9]{0,8}$/.test(prior)) {
    throw new ValidationError("Unsupported source-record version label", [
      "sourceRecordVersion: not a self-service version label",
    ]);
  }
  return String(Number(prior) + 1);
}

/** The prior version's governed facts plus the Seller's restatement. */
function revisedFacts(
  prior: ProductSourceRecord,
  input: ProductRevisionInput,
): ProductSourceRecord["facts"] {
  const { description: _priorDescription, ...rest } = prior.facts;
  return {
    ...rest,
    name: input.name,
    ...(input.description !== null ? { description: input.description } : {}),
    deliveryMode: input.deliveryMode,
  };
}

/**
 * Revise a Product the acting account's participant authors.
 *
 * `input` is validated here against `ProductRevisionInput` (any shipping amount
 * already in minor units). Throws `ValidationError`, `ProductNotAvailableError`,
 * `ProductRevisionUnchangedError`, the authoring refusals
 * `assertAccountMayAuthorProductIn` raises, or the repository's
 * `ConcurrencyConflictError` when another revision won the race.
 */
export async function reviseProductAs(
  actor: { accountId: string },
  request: { productRef: string; expectedRevision: string; input: unknown; now: string },
  deps: { db?: Db } = {},
): Promise<RevisedProduct> {
  const db = deps.db ?? getPrisma();

  const expected = ProductRevisionToken.safeParse(request.expectedRevision);
  if (!expected.success) {
    throw new ValidationError("Invalid Product revision token", ["expectedRevision: malformed"]);
  }

  const parsed = ProductRevisionInput.safeParse(request.input);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid Product revision input",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const input = parsed.data;

  const product = await db.product.findUnique({
    where: { productRef: request.productRef },
    select: { internalProductId: true, productRef: true },
  });
  if (product === null) throw new ProductNotAvailableError();

  const subject = await resolveActingSubject(db, actor.accountId);
  const participantId = subject.participant?.participantId;
  if (
    participantId === undefined ||
    !(await participantHoldsProductAuthority(db, product.internalProductId, participantId))
  ) {
    throw new ProductNotAvailableError();
  }

  const repository = new ProductRepository(db);
  const prior = await repository.getCurrentProductSourceRecord(product.internalProductId);

  /* Stale before any work: the Seller edited a state that is no longer current.
     Checked before "unchanged", so a stale tab is told to reload rather than
     told its edit was a no-op against a version it never saw. */
  if (productRevisionToken(prior.sourceRecordId, prior.sourceRecordVersion) !== expected.data) {
    throw staleRevision();
  }

  const facts = revisedFacts(prior, input);
  const shippingPolicy = input.shippingPolicy;

  /* Same content, no new version: a version that changes nothing records no
     event. Compared canonically so key order cannot make equal facts unequal. */
  if (
    canonicalJsonString(facts) === canonicalJsonString(prior.facts) &&
    canonicalJsonString(shippingPolicy ?? null) === canonicalJsonString(prior.shippingPolicy ?? null)
  ) {
    throw new ProductRevisionUnchangedError();
  }

  const record = await repository.createProductSourceRecordRevision({
    internalProductId: product.internalProductId,
    expectedCurrentSourceRecordVersion: prior.sourceRecordVersion,
    sourceRecordVersion: nextSourceRecordVersion(prior.sourceRecordVersion),
    updatedAt: request.now,
    capsuleGeneratedAt: request.now,
    facts,
    shippingPolicy,
    authorize: async (tx: Prisma.TransactionClient) => {
      /* The authoritative check, against the current pointer THIS transaction
         sees. The repository has already refused a pointer that moved off
         `prior`; this states the Seller's condition directly, so it holds
         whatever the repository's own guard does. */
      const current = await tx.product.findUnique({
        where: { internalProductId: product.internalProductId },
        select: { sourceRecordId: true, currentSourceRecordVersion: true },
      });
      if (
        current === null ||
        productRevisionToken(current.sourceRecordId, current.currentSourceRecordVersion) !== expected.data
      ) {
        throw staleRevision();
      }
      await assertAccountMayAuthorProductIn(tx, actor.accountId, participantId);
      if (!(await participantHoldsProductAuthority(tx, product.internalProductId, participantId))) {
        throw new ProductNotAvailableError();
      }
    },
  });

  return {
    productRef: product.productRef,
    record,
    completeness: evaluateProductCompletenessV1(productCompletenessInputFromRecord(record)),
    revisionToken: productRevisionToken(record.sourceRecordId, record.sourceRecordVersion),
  };
}
