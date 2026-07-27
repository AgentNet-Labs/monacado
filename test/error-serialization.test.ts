/**
 * Error-serialization safety tests (Phases 0D, 0E.1, 0E.2).
 *
 * Repository and service errors retain their original cause for internal
 * diagnostics, but that cause must never escape through ordinary serialisation.
 * These tests run offline — no database required.
 */

import { describe, expect, it } from "vitest";
import {
  ConcurrencyConflictError,
  DatabaseError,
  DuplicateProductError,
  PersistedContractViolationError,
  ProductRepositoryError,
  ValidationError,
} from "../src/server/product/errors";
import {
  NodeIssuanceConflictError,
  PersistedNodeContractViolationError,
  ProductNodeError,
} from "../src/server/product/node-errors";
import {
  AtomicPreparationFailureError,
  DuplicateCapsuleIdError,
  IdempotencyConflictError,
  PersistedOutboxContractViolationError,
  ProductPublicationError,
  PublicationConflictError,
} from "../src/server/product/publication-errors";
import { INTERNAL_CAUSE_PROPERTY, attachInternalCause } from "../src/server/product/error-cause";

/**
 * An OBVIOUSLY SYNTHETIC stand-in for the driver text a real failure would carry
 * (connection string, host, port, username, password, database name). It is a
 * negative-test fixture — not a real credential, host, or database — and exists
 * only so the assertions below can prove none of it escapes.
 */
const SYNTHETIC_PASSWORD = "SYNTHETIC-NOT-A-REAL-PASSWORD";
const PRISMA_TEXT =
  "Invalid `prisma.product.create()` invocation: Can't reach database server at " +
  `\`198.51.100.7:9999\`. datasource db: mysql://synthetic-user:${SYNTHETIC_PASSWORD}` +
  "@198.51.100.7:9999/synthetic_disposable_db";

/** Every fragment that must never appear in a serialised error. */
const SECRETS = [
  "internalCause",
  SYNTHETIC_PASSWORD,
  "mysql://",
  "synthetic-user",
  "198.51.100.7",
  "9999",
  "synthetic_disposable_db",
  "prisma.product.create",
  "Can't reach database server",
];

/** One representative error from every family, each carrying a leaky cause. */
const withCause = (): Array<{ label: string; error: Error }> => [
  { label: "DatabaseError (0D)", error: new DatabaseError("Database operation failed", PRISMA_TEXT) },
  { label: "DuplicateProductError (0D)", error: new DuplicateProductError("Duplicate", PRISMA_TEXT) },
  {
    label: "PersistedContractViolationError (0D)",
    error: new PersistedContractViolationError("Malformed", ["facts.name: required"]),
  },
  {
    label: "NodeIssuanceConflictError (0E.1)",
    error: new NodeIssuanceConflictError("Conflict", ["nodeId"], PRISMA_TEXT),
  },
  {
    label: "PersistedNodeContractViolationError (0E.1)",
    error: new PersistedNodeContractViolationError("Malformed", ["lifecycleState: invalid"]),
  },
  {
    label: "PublicationConflictError (0E.2)",
    error: new PublicationConflictError("Conflict", ["outboxId"], PRISMA_TEXT),
  },
  {
    label: "DuplicateCapsuleIdError (0E.2)",
    error: new DuplicateCapsuleIdError("Already published", PRISMA_TEXT),
  },
  {
    label: "AtomicPreparationFailureError (0E.2)",
    error: new AtomicPreparationFailureError("Not committed", PRISMA_TEXT),
  },
  {
    label: "PersistedOutboxContractViolationError (0E.2)",
    error: new PersistedOutboxContractViolationError("Malformed", ["payloadHash: mismatch"]),
  },
];

describe("repository error serialization safety", () => {
  it("1. retains the internal cause for diagnostics", () => {
    const err = new DatabaseError("Database operation failed", PRISMA_TEXT);
    expect(err.internalCause).toBe(PRISMA_TEXT);

    // Also retained on the other families.
    const node = new NodeIssuanceConflictError("Conflict", ["nodeId"], "P2002");
    expect(node.internalCause).toBe("P2002");
    const pub = new PublicationConflictError("Conflict", ["outboxId"], "P2002");
    expect(pub.internalCause).toBe("P2002");
  });

  it("2. JSON.stringify omits the cause", () => {
    for (const { label, error } of withCause()) {
      const json = JSON.stringify(error);
      for (const secret of SECRETS) {
        expect(json, `${label} leaked "${secret}" via JSON.stringify`).not.toContain(secret);
      }
    }
  });

  it("3. object spread does not expose the cause", () => {
    for (const { label, error } of withCause()) {
      const spread = { ...error };
      expect(Object.keys(spread), label).not.toContain(INTERNAL_CAUSE_PROPERTY);
      const json = JSON.stringify(spread);
      for (const secret of SECRETS) {
        expect(json, `${label} leaked "${secret}" via spread`).not.toContain(secret);
      }
    }
  });

  it("3b. the cause is hidden from Object.keys, for...in, and entries", () => {
    const err = new DatabaseError("Database operation failed", PRISMA_TEXT);
    expect(Object.keys(err)).not.toContain(INTERNAL_CAUSE_PROPERTY);
    expect(Object.entries(err).map(([k]) => k)).not.toContain(INTERNAL_CAUSE_PROPERTY);
    const seen: string[] = [];
    for (const k in err) seen.push(k);
    expect(seen).not.toContain(INTERNAL_CAUSE_PROPERTY);
    // Non-enumerable, but genuinely present.
    expect(Object.getOwnPropertyNames(err)).toContain(INTERNAL_CAUSE_PROPERTY);
  });

  it("4. public name, code, and message remain available", () => {
    const err = new DatabaseError("Database operation failed", PRISMA_TEXT);
    expect(err.name).toBe("DatabaseError");
    expect(err.code).toBe("DATABASE_ERROR");
    expect(err.message).toBe("Database operation failed");
    expect(err).toBeInstanceOf(ProductRepositoryError);
    expect(err).toBeInstanceOf(Error);

    // name and code stay enumerable (deliberately part of the public shape).
    const json = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(json.name).toBe("DatabaseError");
    expect(json.code).toBe("DATABASE_ERROR");
  });

  it("4b. safe structured fields remain enumerable", () => {
    const conflict = new IdempotencyConflictError("Conflict", ["publishedAt", "capsulePolicyRef"]);
    const json = JSON.parse(JSON.stringify(conflict)) as Record<string, unknown>;
    expect(json.conflictingFields).toEqual(["publishedAt", "capsulePolicyRef"]);

    const validation = new ValidationError("Invalid", ["facts.name: required"]);
    expect(JSON.parse(JSON.stringify(validation))).toMatchObject({
      code: "VALIDATION_FAILED",
      issues: ["facts.name: required"],
    });
  });

  it("5. database credentials and raw Prisma text are absent from every surface", () => {
    for (const { label, error } of withCause()) {
      const surfaces = [
        error.message,
        error.name,
        String(error),
        JSON.stringify(error),
        JSON.stringify({ ...error }),
        // A common logging shape: enumerable own properties only.
        JSON.stringify(Object.fromEntries(Object.entries(error))),
      ].join(" ");
      for (const secret of SECRETS.filter((s) => s !== "internalCause")) {
        expect(surfaces, `${label} leaked "${secret}"`).not.toContain(secret);
      }
    }
  });

  it("5b. an errors-with-cause chain cannot be re-exposed by redefining the property", () => {
    const err = new DatabaseError("Database operation failed", PRISMA_TEXT);
    expect(() =>
      Object.defineProperty(err, INTERNAL_CAUSE_PROPERTY, {
        value: PRISMA_TEXT,
        enumerable: true,
      }),
    ).toThrow();
    expect(JSON.stringify(err)).not.toContain(SYNTHETIC_PASSWORD);
  });

  it("6. the base classes of all three families apply the same pattern", () => {
    const errors = [
      new ProductRepositoryError("DATABASE_ERROR", "x", PRISMA_TEXT),
      new ProductNodeError("PRODUCT_NOT_FOUND", "x", PRISMA_TEXT),
      new ProductPublicationError("PUBLICATION_CONFLICT", "x", PRISMA_TEXT),
    ];
    for (const err of errors) {
      expect(err.internalCause).toBe(PRISMA_TEXT);
      expect(JSON.stringify(err)).not.toContain(SYNTHETIC_PASSWORD);
    }
  });

  it("6b. errors without a cause still hide the property", () => {
    const err = new ConcurrencyConflictError("Version changed");
    expect(Object.keys(err)).not.toContain(INTERNAL_CAUSE_PROPERTY);
    expect(err.internalCause).toBeUndefined();
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      name: "ConcurrencyConflictError",
      code: "CONCURRENCY_CONFLICT",
    });
  });

  it("6c. attachInternalCause is reusable and always non-enumerable", () => {
    const target = new Error("plain") as Error & { internalCause?: unknown };
    attachInternalCause(target, PRISMA_TEXT);
    expect(target.internalCause).toBe(PRISMA_TEXT);
    expect(Object.keys(target)).not.toContain(INTERNAL_CAUSE_PROPERTY);
    expect(JSON.stringify(target)).not.toContain(SYNTHETIC_PASSWORD);
  });
});
