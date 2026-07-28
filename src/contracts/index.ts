/**
 * Monacado Capsule-Driven contracts — Phase 0B.1 public surface (ANS-aligned).
 *
 * Offline semantic foundation for one creator-authoritative Product capsule:
 * candidate generation, ANS-conformant publication, deterministic hashing, and
 * derived JSON Schema. No persistence, UI, publication worker, or network code.
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
export * from "./product/product-source-record";
export * from "./product/product-node";
export * from "./product/product-publication";
export * from "./product/safe-error-metadata";
export * from "./product/product-publication-outbox";
export * from "./product/product-registrar-receipt";
export * from "./product/product-publication-remediation";

// Integrity
export * from "./integrity/canonical-json";
export * from "./integrity/hash";
export * from "./integrity/forbidden-fields";

// Derived JSON Schema
export * from "./jsonschema/export";
