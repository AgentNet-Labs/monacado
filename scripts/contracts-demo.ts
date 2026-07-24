/**
 * contracts:demo — end-to-end demonstration of the Product capsule foundation.
 *
 * Runs with NO database and NO network. Uses fixed synthetic data so output is
 * deterministic across runs. Demonstrates the full Phase 0B chain and prints a
 * concise summary.
 */

import {
  COMMERCE_CONTEXT,
  COMMERCE_CONTEXT_REF,
  COMMERCE_ONTOLOGY_META,
  ProductAuthorityError,
  canWriteProductFacts,
  canonicalJsonString,
  contentHash,
  createProductCapsule,
  generateProductJsonSchema,
  reviseProductCapsule,
  validateProductCapsule,
} from "../src/contracts/index";
import {
  SYN_PROMOTER_ACTOR,
  SYN_REVISED_AT,
  syntheticCreateInput,
} from "../src/contracts/fixtures/synthetic-product";

const line = (label: string, value: string) => console.log(`  ${label.padEnd(28)} ${value}`);

console.log("Monacado Phase 0B — Product Capsule demo (offline, deterministic)\n");

// 1. Create a synthetic creator-authoritative Product capsule.
const v1 = createProductCapsule(syntheticCreateInput());
console.log("1. Product capsule created");
line("subject (node IRI)", v1.subject);
line("@id (capsule-version IRI)", v1["@id"]);
line("capsuleVersion", String(v1.capsuleVersion));
line("lifecycle", v1.lifecycle);

// 2. Zod validation.
const validation = validateProductCapsule(v1);
console.log(`\n2. Zod validation: ${validation.ok ? "PASS" : "FAIL"}`);

// 3. Ontology / context use.
console.log("\n3. Ontology & JSON-LD context");
line("ontology status", COMMERCE_ONTOLOGY_META.status);
line("@context reference", COMMERCE_CONTEXT_REF);
line("Product ->", String((COMMERCE_CONTEXT as Record<string, unknown>).Product));
line("promotable ->", String((COMMERCE_CONTEXT as Record<string, unknown>).promotable));

// 4. Authority validation.
const creatorDecision = canWriteProductFacts(syntheticCreateInput().actor);
const promoterDecision = canWriteProductFacts(SYN_PROMOTER_ACTOR);
console.log("\n4. Authority");
line("creator may write facts", String(creatorDecision.allowed));
line("promoter may write facts", String(promoterDecision.allowed));

// 5. Deterministic serialization — reordered keys, identical canonical string.
const reordered = Object.fromEntries(
  Object.entries(v1 as Record<string, unknown>).reverse(),
);
const s1 = canonicalJsonString(v1);
const s2 = canonicalJsonString(reordered);
console.log("\n5. Deterministic serialization");
line("canonical bytes", String(Buffer.byteLength(s1, "utf8")));
line("key-order independent", String(s1 === s2));

// 6. Content hashing.
console.log("\n6. Content hash");
line("v1 hash", contentHash(v1));

// 7. JSON Schema export (derived).
const schema = generateProductJsonSchema();
console.log("\n7. Derived JSON Schema");
line("top-level type", String((schema as Record<string, unknown>).type ?? "(composed)"));
line("has properties", String("properties" in schema));

// 8. Changed Product version + 9. supersession.
const { superseded, next } = reviseProductCapsule({
  current: v1,
  changes: {
    name: "Synthetic CLI Toolkit (Pro)",
    data: { ...v1.data, productVersion: 2, capabilities: ["scaffold", "validate", "export", "publish"] },
  },
  updatedAt: SYN_REVISED_AT,
  actor: syntheticCreateInput().actor,
});
console.log("\n8. Changed Product version");
line("next capsuleVersion", String(next.capsuleVersion));
line("next hash", contentHash(next));
line("hash changed", String(contentHash(next) !== contentHash(v1)));
console.log("\n9. Supersession");
line("next.supersedes", String(next.supersedes));
line("prior @id", v1["@id"]);
line("prior lifecycle now", superseded.lifecycle);

// 10. Rejected promoter modification.
console.log("\n10. Unauthorized promoter modification");
try {
  reviseProductCapsule({
    current: v1,
    changes: { name: "Hijacked name" },
    updatedAt: SYN_REVISED_AT,
    actor: SYN_PROMOTER_ACTOR,
  });
  line("result", "ERROR — should have been rejected");
  process.exit(1);
} catch (err) {
  line("rejected", String(err instanceof ProductAuthorityError));
}

// 11. Rejected price / commission field inside Product.
console.log("\n11. Rejected commercial fields inside Product");
const withPrice = { ...v1, data: { ...v1.data, price: 19.95 } };
const withCommission = { ...v1, data: { ...v1.data, promoterCommissionRate: 0.2 } };
line("price rejected", String(!validateProductCapsule(withPrice).ok));
line("commission rejected", String(!validateProductCapsule(withCommission).ok));

console.log("\ncontracts:demo — complete.");
