/**
 * Derived JSON Schema export (ADR §8).
 *
 * JSON Schema is GENERATED from the Zod Product capsule schema and is a derived
 * interoperability artifact — never hand-authored, never a separate source of
 * truth. Generated output is written under generated/ and is git-ignored during
 * this phase (see docs/PRODUCT_CAPSULE.md).
 */

import { z } from "zod";
import { ProductCapsuleBase } from "../product/product.capsule";

export interface GeneratedSchema {
  name: string;
  schema: Record<string, unknown>;
}

/** Generate the JSON Schema for the Product capsule from its Zod definition. */
export function generateProductJsonSchema(): Record<string, unknown> {
  // Generated from the base object shape; cross-field refinements are not
  // expressible in vanilla JSON Schema and are enforced by Zod at runtime.
  return z.toJSONSchema(ProductCapsuleBase, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}

/** All schemas this phase exports. */
export function generateAllSchemas(): GeneratedSchema[] {
  return [{ name: "product.capsule.schema.json", schema: generateProductJsonSchema() }];
}
