/**
 * Order buyer snapshot persistence (Phase 1.2 correction) — SERVER ONLY.
 *
 * Two writes, and the ordering between them is the whole security property:
 *
 * ```
 * captureBuyerSnapshot(BUYER_SUPPLIED)      ← at checkout, before payment
 *      … buyer pays on Stripe's hosted page …
 * confirmBuyerSnapshot(PROVIDER_CONFIRMED)  ← after the payment succeeded
 * ```
 *
 * ## Why a buyer-supplied snapshot exists at all
 *
 * Tax must be computed **before** a buyer is charged, and the only address that
 * exists at that instant is the one they typed. So checkout captures it, prices
 * tax on it, and records that it came from the buyer.
 *
 * ## Why the provider's version wins
 *
 * The confirmed Checkout Session carries the details the payment **actually
 * authorized**. A browser can post anything; a completed payment cannot. So
 * confirmation supersedes — and the supersession is one-directional:
 *
 *   - `BUYER_SUPPLIED` → `PROVIDER_CONFIRMED` **replaces** the details.
 *   - `PROVIDER_CONFIRMED` → `BUYER_SUPPLIED` is **refused**. Once a payment has
 *     told Monacado who paid, no later caller-supplied address may overwrite it.
 *
 * That refusal is what makes "Stripe-confirmed details cannot be overridden by
 * caller-supplied conflicting address data" a rule rather than a convention.
 *
 * ## What it never touches
 *
 * No `Account` is created, no `MarketplaceParticipant` is fabricated, and no Node
 * or capsule is projected. A guest with a full snapshot is still a guest.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  BuyerCheckoutDetailsInput,
  OrderBuyerSnapshotRecord,
  deriveTaxJurisdiction,
  type BuyerDetailSource,
  type PostalAddress,
} from "../../contracts/marketplace/order-buyer-snapshot";
import { normalizeEmail } from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { OrderServiceError } from "./order-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export class BuyerSnapshotError extends OrderServiceError {
  readonly detail: string;
  constructor(detail: string, message: string) {
    super("BUYER_SNAPSHOT_REFUSED", message);
    this.name = "BuyerSnapshotError";
    this.detail = detail;
  }
}

export interface BuyerSnapshotIdProvider {
  nextBuyerSnapshotId(): string;
}

export interface BuyerSnapshotDeps {
  db?: Db;
  ids?: BuyerSnapshotIdProvider;
}

interface SnapshotRow {
  id: string;
  orderId: string;
  name: string;
  email: string;
  billingLine1: string;
  billingLine2: string | null;
  billingCity: string;
  billingRegion: string | null;
  billingPostalCode: string | null;
  billingCountryCode: string;
  shippingLine1: string | null;
  shippingLine2: string | null;
  shippingCity: string | null;
  shippingRegion: string | null;
  shippingPostalCode: string | null;
  shippingCountryCode: string | null;
  taxCountryCode: string;
  taxRegionCode: string | null;
  detailSource: string;
  capturedAt: Date;
  updatedAt: Date;
}

function rowToRecord(row: SnapshotRow): OrderBuyerSnapshotRecord {
  /* NULL means "this basket needed no delivery address" — a fact worth reading
     back, not a gap. A partially-present address is treated as absent: an
     address missing its line or country is not one anything could ship to. */
  const shipping: PostalAddress | null =
    row.shippingLine1 === null || row.shippingCity === null || row.shippingCountryCode === null
      ? null
      : {
          line1: row.shippingLine1,
          line2: row.shippingLine2,
          city: row.shippingCity,
          region: row.shippingRegion,
          postalCode: row.shippingPostalCode,
          countryCode: row.shippingCountryCode,
        };

  const parsed = OrderBuyerSnapshotRecord.safeParse({
    buyerSnapshotId: row.id,
    orderId: row.orderId,
    name: row.name,
    email: row.email,
    billingAddress: {
      line1: row.billingLine1,
      line2: row.billingLine2,
      city: row.billingCity,
      region: row.billingRegion,
      postalCode: row.billingPostalCode,
      countryCode: row.billingCountryCode,
    },
    shippingAddress: shipping,
    taxCountryCode: row.taxCountryCode,
    taxRegionCode: row.taxRegionCode,
    detailSource: row.detailSource,
    capturedAt: row.capturedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new BuyerSnapshotError("CORRUPT_RECORD", "A persisted buyer snapshot is malformed");
  }
  return parsed.data;
}

/** Billing columns. Required, so every field is non-null by construction. */
function billingColumns(address: PostalAddress) {
  return {
    billingLine1: address.line1,
    billingLine2: address.line2,
    billingCity: address.city,
    billingRegion: address.region,
    billingPostalCode: address.postalCode,
    billingCountryCode: address.countryCode,
  };
}

/** Shipping columns. Conditional — see `SHIPPING_ADDRESS_POLICY`. */
function shippingColumns(address: PostalAddress | null) {
  if (address === null) {
    return {
      shippingLine1: null,
      shippingLine2: null,
      shippingCity: null,
      shippingRegion: null,
      shippingPostalCode: null,
      shippingCountryCode: null,
    };
  }
  return {
    shippingLine1: address.line1,
    shippingLine2: address.line2,
    shippingCity: address.city,
    shippingRegion: address.region,
    shippingPostalCode: address.postalCode,
    shippingCountryCode: address.countryCode,
  };
}

/**
 * Record who is buying, from what they supplied at checkout.
 *
 * Written **after** the Order exists and **before** any payment is initiated, so
 * a payment is never taken from a buyer Monacado has no record of.
 *
 * The email is normalised through `0M.1`'s own `normalizeEmail`, reused rather
 * than restated, so the same person typing different casing is the same
 * recipient downstream.
 */
export async function captureBuyerSnapshot(
  args: { orderId: string; details: unknown; capturedAt: string },
  deps: BuyerSnapshotDeps = {},
): Promise<OrderBuyerSnapshotRecord> {
  const parsed = BuyerCheckoutDetailsInput.safeParse(args.details);
  if (!parsed.success) {
    throw new BuyerSnapshotError(
      "INVALID_DETAILS",
      "Buyer checkout details are missing or malformed",
    );
  }
  const details = parsed.data;
  const db = deps.db ?? getPrisma();
  const ids = deps.ids;
  if (ids === undefined) {
    throw new BuyerSnapshotError("ID_PROVIDER_REQUIRED", "an id provider is required");
  }

  const jurisdiction = deriveTaxJurisdiction(details.billingAddress);

  const row = await db.orderBuyerSnapshot.create({
    data: {
      id: ids.nextBuyerSnapshotId(),
      orderId: args.orderId,
      name: details.name,
      email: normalizeEmail(details.email),
      ...billingColumns(details.billingAddress),
      ...shippingColumns(details.shippingAddress),
      taxCountryCode: jurisdiction.taxCountryCode,
      taxRegionCode: jurisdiction.taxRegionCode,
      detailSource: "BUYER_SUPPLIED" satisfies BuyerDetailSource,
      capturedAt: new Date(args.capturedAt),
    },
  });
  return rowToRecord(row);
}

/**
 * Supersede the snapshot with the details the payment actually authorized.
 *
 * Called only from the confirmation path, with data read back from the completed
 * Checkout Session. **A `PROVIDER_CONFIRMED` snapshot is never downgraded**: once
 * a payment has told Monacado who paid, no later caller-supplied address
 * overwrites it, and a second confirmation of the same order is idempotent rather
 * than a second overwrite.
 *
 * Fields the provider does not report are **left as the buyer supplied them**
 * rather than nulled. Stripe reports what it collected; a field it omits is a
 * field it has no opinion about, and discarding the buyer's answer because the
 * provider stayed silent would lose information for no gain.
 */
export async function confirmBuyerSnapshot(
  args: {
    orderId: string;
    confirmed: {
      name: string | null;
      email: string | null;
      billingAddress: PostalAddress | null;
      shippingAddress: PostalAddress | null;
    };
    confirmedAt: string;
  },
  deps: BuyerSnapshotDeps = {},
): Promise<OrderBuyerSnapshotRecord | null> {
  const db = deps.db ?? getPrisma();
  const existing = await db.orderBuyerSnapshot.findUnique({ where: { orderId: args.orderId } });
  if (existing === null) return null;

  /* Already authorized by a payment. A redelivered confirmation carries the same
     facts, and anything else claiming to update it is exactly what must not. */
  if (existing.detailSource === "PROVIDER_CONFIRMED") return rowToRecord(existing);

  const billing = args.confirmed.billingAddress;
  const jurisdiction = billing === null ? null : deriveTaxJurisdiction(billing);

  const row = await db.orderBuyerSnapshot.update({
    where: { orderId: args.orderId },
    data: {
      ...(args.confirmed.name === null ? {} : { name: args.confirmed.name }),
      ...(args.confirmed.email === null
        ? {}
        : { email: normalizeEmail(args.confirmed.email) }),
      ...(billing === null ? {} : billingColumns(billing)),
      ...(args.confirmed.shippingAddress === null
        ? {}
        : shippingColumns(args.confirmed.shippingAddress)),
      ...(jurisdiction === null
        ? {}
        : {
            taxCountryCode: jurisdiction.taxCountryCode,
            taxRegionCode: jurisdiction.taxRegionCode,
          }),
      detailSource: "PROVIDER_CONFIRMED" satisfies BuyerDetailSource,
      capturedAt: new Date(args.confirmedAt),
    },
  });
  return rowToRecord(row);
}

// — Reads —

export async function getBuyerSnapshot(
  orderId: string,
  deps: BuyerSnapshotDeps = {},
): Promise<OrderBuyerSnapshotRecord | null> {
  const db = deps.db ?? getPrisma();
  const row = await db.orderBuyerSnapshot.findUnique({ where: { orderId } });
  return row === null ? null : rowToRecord(row);
}

/** Shared read, usable inside and outside a transaction. */
export async function getBuyerSnapshotIn(
  tx: Tx,
  orderId: string,
): Promise<OrderBuyerSnapshotRecord | null> {
  const row = await tx.orderBuyerSnapshot.findUnique({ where: { orderId } });
  return row === null ? null : rowToRecord(row);
}
