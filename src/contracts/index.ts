/**
 * Monacado Capsule-Driven contracts — Phase 0B public surface.
 *
 * Semantic foundation for one creator-authoritative Product capsule. No
 * persistence, UI, publication, or network code lives here.
 */

// Ontology & context (semantic layer)
export * from "./ontology/commerce.ontology";
export * from "./ontology/commerce.context";

// Capsule envelope & identity
export * from "./capsule/envelope";
export * from "./capsule/identity";

// Product capsule
export * from "./product/product.capsule";
export * from "./product/product.authority";
export * from "./product/product.factory";

// Integrity
export * from "./integrity/canonical-json";
export * from "./integrity/hash";
export * from "./integrity/forbidden-fields";

// Derived JSON Schema
export * from "./jsonschema/export";
