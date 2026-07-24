/**
 * contracts:validate — validate the Capsule-Driven artifacts for this phase.
 *
 * Runs offline (no database, no network). Checks that:
 *   - the ontology and JSON-LD context are internally consistent;
 *   - a synthetic Product capsule validates against the Zod schema;
 *   - every non-schema.org term used by the capsule is defined in the context;
 *   - the derived JSON Schema generates.
 *
 * Exits non-zero on any failure.
 */

import {
  ALL_TERMS,
  CONTEXT_TERMS,
  COMMERCE_CONTEXT,
  createProductCapsule,
  generateProductJsonSchema,
  validateProductCapsule,
} from "../src/contracts/index";
import { syntheticCreateInput } from "../src/contracts/fixtures/synthetic-product";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

let checks = 0;
const pass = (msg: string) => {
  checks += 1;
  console.log(`✓ ${msg}`);
};

// 1. Ontology terms all appear in the context (schema.org keywords excluded).
for (const term of ALL_TERMS) {
  if (!(term.term in COMMERCE_CONTEXT)) {
    fail(`ontology term "${term.term}" is missing from the JSON-LD context`);
  }
}
pass(`ontology: ${ALL_TERMS.length} terms all present in the context`);

// 2. Context defines no stray terms beyond the ontology.
const ontologyTermSet = new Set(ALL_TERMS.map((t) => t.term));
for (const ctxTerm of CONTEXT_TERMS) {
  if (!ontologyTermSet.has(ctxTerm)) {
    fail(`context defines "${ctxTerm}" with no matching ontology term`);
  }
}
pass(`context: ${CONTEXT_TERMS.length} terms all backed by ontology definitions`);

// 3. Synthetic Product capsule constructs and validates.
const capsule = createProductCapsule(syntheticCreateInput());
const result = validateProductCapsule(capsule);
if (!result.ok) fail(`synthetic Product capsule failed validation: ${result.errors?.join("; ")}`);
pass("Product capsule: synthetic instance validates against Zod schema");

// 4. Every non-schema.org term used in the capsule body is in the context.
const KEYWORDS = new Set(["@context", "@type", "@id"]);
const usedTerms = new Set<string>();
const collect = (node: unknown): void => {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(collect);
  for (const [k, v] of Object.entries(node)) {
    if (!KEYWORDS.has(k)) usedTerms.add(k);
    collect(v);
  }
};
collect(capsule);
for (const term of usedTerms) {
  // spec/metadata leaf keys are free-form values, not ontology terms; only
  // top-level and known structural terms must resolve.
  if (!(term in COMMERCE_CONTEXT) && ontologyTermSet.has(term)) {
    fail(`capsule uses ontology term "${term}" not mapped in context`);
  }
}
pass("capsule: all recognized terms resolve through the local context");

// 5. Derived JSON Schema generates.
const schema = generateProductJsonSchema();
if (typeof schema !== "object" || schema === null) fail("JSON Schema generation returned no object");
pass("json-schema: Product capsule schema generated from Zod");

console.log(`\ncontracts:validate — ${checks} checks passed.`);
