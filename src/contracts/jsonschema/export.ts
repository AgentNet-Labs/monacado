/**
 * Derived JSON Schema export (ADR §8).
 *
 * JSON Schema is GENERATED from the Zod schemas and is a derived interoperability
 * artifact — never hand-authored, never a separate source of truth. Generated
 * from the base object shapes; cross-field refinements are Zod-runtime only and
 * not representable in vanilla JSON Schema. Output is written under generated/
 * and is git-ignored this phase.
 */

import { z } from "zod";
import {
  ProductCapsuleCandidateBase,
  PublishedProductCapsuleBase,
} from "../product/product.capsule";

export interface GeneratedSchema {
  name: string;
  schema: Record<string, unknown>;
}

export function generatePublishedProductJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PublishedProductCapsuleBase, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}

export function generateProductCandidateJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ProductCapsuleCandidateBase, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}

export function generateAllSchemas(): GeneratedSchema[] {
  return [
    { name: "product.capsule.published.schema.json", schema: generatePublishedProductJsonSchema() },
    { name: "product.capsule.candidate.schema.json", schema: generateProductCandidateJsonSchema() },
  ];
}
