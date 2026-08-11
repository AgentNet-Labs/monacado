/**
 * contracts:validate — validate the Capsule-Driven artifacts (offline).
 *
 * Checks ontology/context consistency, that a synthetic Product candidate and
 * its finalised published capsule validate, that recognised terms resolve
 * through the local context, and that the derived JSON Schemas generate. No
 * database or network access.
 */

import {
  ALL_TERMS,
  CONTEXT_TERMS,
  COMMERCE_CONTEXT,
  finalizeProductCapsule,
  generateAllSchemas,
  generateProductCandidate,
  validateProductCandidate,
  validatePublishedProductCapsule,
} from "../src/contracts/index";
import {
  syntheticFinalizeInputs,
  syntheticSourceRecord,
} from "../src/contracts/fixtures/synthetic-product";
import {
  syntheticStorefrontProjectionContext,
  syntheticStorefrontSourceVersion,
} from "../src/contracts/fixtures/synthetic-storefront";
import {
  storefrontSourceRecordToCapsuleProjection,
  verifyStorefrontCapsuleProjection,
} from "../src/contracts/marketplace/storefront.projection";
import { validateStorefrontCapsuleProjection } from "../src/contracts/marketplace/storefront.capsule";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

let checks = 0;
const pass = (msg: string) => {
  checks += 1;
  console.log(`✓ ${msg}`);
};

// 1. Ontology terms all appear in the context.
for (const term of ALL_TERMS) {
  if (!(term.term in COMMERCE_CONTEXT)) fail(`ontology term "${term.term}" missing from context`);
}
pass(`ontology: ${ALL_TERMS.length} terms all present in the context`);

// 2. Context defines no stray terms beyond the ontology.
const ontologyTermSet = new Set(ALL_TERMS.map((t) => t.term));
for (const ctxTerm of CONTEXT_TERMS) {
  if (!ontologyTermSet.has(ctxTerm)) fail(`context defines "${ctxTerm}" with no ontology term`);
}
pass(`context: ${CONTEXT_TERMS.length} terms all backed by ontology definitions`);

// 3. Synthetic candidate generates and validates.
const candidate = generateProductCandidate({
  source: syntheticSourceRecord(),
  version: "1.0.0",
  generatedAt: "2026-01-01T00:00:00.000Z",
});
if (!validateProductCandidate(candidate).ok) fail("synthetic candidate failed validation");
pass("candidate: synthetic Product candidate validates");

// 4. Finalised published capsule validates.
const published = finalizeProductCapsule({ candidate, ...syntheticFinalizeInputs() });
const result = validatePublishedProductCapsule(published);
if (!result.ok) fail(`published capsule failed validation: ${result.errors?.join("; ")}`);
pass("published: finalised Product capsule validates");

// 5. Published capsule has exactly the four ANS top-level members.
const top = Object.keys(published).sort();
const expectedTop = ["@context", "@type", "data", "metadata"];
if (JSON.stringify(top) !== JSON.stringify(expectedTop)) {
  fail(`published top-level members must be ${expectedTop.join(", ")}; got ${top.join(", ")}`);
}
pass("published: top-level members are exactly @context, @type, metadata, data");

// 6. Recognised terms used in the capsule resolve through the local context.
const STRUCTURAL = new Set(["@context", "@type", "metadata", "data"]);
const seen = new Set<string>();
const collect = (node: unknown): void => {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(collect);
  for (const [k, v] of Object.entries(node)) {
    if (!STRUCTURAL.has(k)) seen.add(k);
    collect(v);
  }
};
collect(published);
for (const term of seen) {
  if (ontologyTermSet.has(term) && !(term in COMMERCE_CONTEXT)) {
    fail(`capsule uses ontology term "${term}" not mapped in context`);
  }
}
pass("capsule: recognised terms resolve through the local context");

// 7. Synthetic Storefront source version projects and validates (Phase 0M.3B).
const storefrontSource = syntheticStorefrontSourceVersion();
const storefrontContext = syntheticStorefrontProjectionContext();
const storefrontCapsule = storefrontSourceRecordToCapsuleProjection({
  sourceVersion: storefrontSource,
  context: storefrontContext,
});
const storefrontValidation = validateStorefrontCapsuleProjection(storefrontCapsule);
if (!storefrontValidation.ok) {
  fail(`Storefront projection failed validation: ${storefrontValidation.errors?.join("; ")}`);
}
pass("storefront: synthetic Storefront source version projects and validates");

// 8. The Storefront projection is deterministic and re-derivable.
const storefrontRepeat = storefrontSourceRecordToCapsuleProjection({
  sourceVersion: storefrontSource,
  context: storefrontContext,
});
if (JSON.stringify(storefrontRepeat) !== JSON.stringify(storefrontCapsule)) {
  fail("Storefront projection is not deterministic for identical input");
}
if (
  !verifyStorefrontCapsuleProjection({
    sourceVersion: storefrontSource,
    context: storefrontContext,
    capsule: storefrontCapsule,
  }).matches
) {
  fail("Storefront projection does not verify against its own re-derivation");
}
pass("storefront: projection is deterministic and verifies against re-derivation");

// 9. Storefront capsule terms resolve through the local context.
const storefrontSeen = new Set<string>();
const collectStorefront = (node: unknown): void => {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(collectStorefront);
  for (const [k, v] of Object.entries(node)) {
    if (!STRUCTURAL.has(k)) storefrontSeen.add(k);
    collectStorefront(v);
  }
};
collectStorefront(storefrontCapsule);
for (const term of storefrontSeen) {
  if (ontologyTermSet.has(term) && !(term in COMMERCE_CONTEXT)) {
    fail(`Storefront capsule uses ontology term "${term}" not mapped in context`);
  }
}
if (!ontologyTermSet.has("Storefront") || !("Storefront" in COMMERCE_CONTEXT)) {
  fail("Storefront class term is not defined in both ontology and context");
}
pass("storefront: recognised terms resolve through the local context");

// 10. Derived JSON Schemas generate.
const schemas = generateAllSchemas();
for (const { name, schema } of schemas) {
  if (typeof schema !== "object" || schema === null) fail(`JSON Schema ${name} did not generate`);
}
pass(`json-schema: ${schemas.length} schema(s) generated from Zod`);

console.log(`\ncontracts:validate — ${checks} checks passed.`);
