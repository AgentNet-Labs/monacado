/**
 * Product Node persistence + lifecycle integration tests (Phase 0E.1).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord } from "../src/contracts/index";
import { getPrisma, disconnectPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import {
  InvalidLifecycleTransitionError,
  InvalidNodeIdError,
  NodeIssuanceConflictError,
  PersistedNodeContractViolationError,
  ProductNotFoundError,
} from "../src/server/product/node-errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`N${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`N${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`N${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Node fixture product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      relationships: { creator: `an:node:${pad26(`N${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.1.0.0",
    recordStatus: "authoring-complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    capsuleGeneratedAt: "2026-01-01T06:30:00.000Z",
  };
}

function issuance(internalProductId: string, nodeSeed: string) {
  return {
    nodeId: `an:node:${pad26(nodeSeed)}`,
    internalProductId,
    nodeKind: "product" as const,
    nodePolicyRef: "an:policy:node:synthetic-0e",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  };
}

const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);
const repo = RUN ? new ProductRepository(db) : (undefined as unknown as ProductRepository);
const nodes = RUN ? new ProductNodeRepository(db) : (undefined as unknown as ProductNodeRepository);

/** Persist a fresh Product and return its record. */
async function seedProduct(): Promise<ProductSourceRecord> {
  const rec = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record: rec });
  return rec;
}

describe.skipIf(!RUN)("Product Node persistence + lifecycle (integration)", () => {
  beforeEach(async () => {
    await db.productNode.deleteMany({});
    await db.productSourceRecordVersionRow.deleteMany({});
    await db.product.deleteMany({});
  });
  afterAll(async () => {
    await disconnectPrisma();
  });

  it("1,3. issues a Node for an existing Product with an opaque Node ID", async () => {
    const rec = await seedProduct();
    const node = await nodes.issueProductNode(issuance(rec.internalProductId, `N${n}NODE`));
    expect(node.nodeId).toMatch(/^an:node:/);
    expect(node.lifecycleState).toBe("Active");
    expect(node.registrarId).toBe(MONACADO_REGISTRAR_ID);
  });

  it("2. issuance for a missing Product fails", async () => {
    await expect(
      nodes.issueProductNode(issuance(`mon:product:${pad26("MISSING")}`, "MISS0NODE")),
    ).rejects.toBeInstanceOf(ProductNotFoundError);
  });

  it("4-7. semantic URL / product / source-record / capsule IDs are rejected as Node ID", async () => {
    const rec = await seedProduct();
    for (const bad of [
      "https://monacado.com/id/product/01J9Z3K7Q0V2M5N8P4R6T1W3XY",
      rec.internalProductId,
      rec.sourceRecordId,
      `an:capsule:${pad26("CAP")}`,
    ]) {
      await expect(
        nodes.issueProductNode({ ...issuance(rec.internalProductId, "X0NODE"), nodeId: bad }),
      ).rejects.toBeInstanceOf(InvalidNodeIdError);
    }
  });

  it("8. one Product Node per internalProductId (different nodeId conflicts)", async () => {
    const rec = await seedProduct();
    await nodes.issueProductNode(issuance(rec.internalProductId, `N${n}A`));
    await expect(
      nodes.issueProductNode(issuance(rec.internalProductId, `N${n}B`)),
    ).rejects.toBeInstanceOf(NodeIssuanceConflictError);
  });

  it("9. nodeId is unique across Products", async () => {
    const a = await seedProduct();
    const b = await seedProduct();
    const shared = `an:node:${pad26("SHARED0NODE")}`;
    await nodes.issueProductNode({ ...issuance(a.internalProductId, "x"), nodeId: shared });
    await expect(
      nodes.issueProductNode({ ...issuance(b.internalProductId, "x"), nodeId: shared }),
    ).rejects.toBeInstanceOf(NodeIssuanceConflictError);
  });

  it("10. identical repeated issuance is idempotent", async () => {
    const rec = await seedProduct();
    const input = issuance(rec.internalProductId, `N${n}IDEM`);
    const first = await nodes.issueProductNode(input);
    const second = await nodes.issueProductNode(input);
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.id).toBe(first.id);
  });

  it("11. conflicting repeated issuance fails", async () => {
    const rec = await seedProduct();
    const input = issuance(rec.internalProductId, `N${n}CONF`);
    await nodes.issueProductNode(input);
    await expect(
      nodes.issueProductNode({ ...input, nodePolicyVersion: "2.0.0" }),
    ).rejects.toBeInstanceOf(NodeIssuanceConflictError);
  });

  it("12-13. retrieval by nodeId and by internalProductId", async () => {
    const rec = await seedProduct();
    const issued = await nodes.issueProductNode(issuance(rec.internalProductId, `N${n}GET`));
    expect((await nodes.getProductNode(issued.nodeId)).internalProductId).toBe(rec.internalProductId);
    expect((await nodes.getProductNodeByInternalProductId(rec.internalProductId)).nodeId).toBe(issued.nodeId);
  });

  it("14-15. Active -> Inactive -> Active", async () => {
    const rec = await seedProduct();
    const node = await nodes.issueProductNode(issuance(rec.internalProductId, `N${n}LC`));
    const inactive = await nodes.transitionProductNodeLifecycle({
      nodeId: node.nodeId,
      toState: "Inactive",
      lifecycleChangedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(inactive.lifecycleState).toBe("Inactive");
    const active = await nodes.transitionProductNodeLifecycle({
      nodeId: node.nodeId,
      toState: "Active",
      lifecycleChangedAt: "2026-02-02T00:00:00.000Z",
    });
    expect(active.lifecycleState).toBe("Active");
  });

  it("16-17. Active -> Revoked / Retired succeed with reason", async () => {
    const a = await seedProduct();
    const na = await nodes.issueProductNode(issuance(a.internalProductId, `N${n}RV`));
    const revoked = await nodes.transitionProductNodeLifecycle({
      nodeId: na.nodeId,
      toState: "Revoked",
      lifecycleChangedAt: "2026-02-01T00:00:00.000Z",
      reasonCode: "policy-violation",
    });
    expect(revoked.lifecycleState).toBe("Revoked");
    expect(revoked.lifecycleReasonCode).toBe("policy-violation");

    const b = await seedProduct();
    const nb = await nodes.issueProductNode(issuance(b.internalProductId, `N${n}RT`));
    const retired = await nodes.transitionProductNodeLifecycle({
      nodeId: nb.nodeId,
      toState: "Retired",
      lifecycleChangedAt: "2026-02-01T00:00:00.000Z",
      reasonCode: "superseded",
    });
    expect(retired.lifecycleState).toBe("Retired");
  });

  it("18-19. Revoked and Retired are terminal", async () => {
    const a = await seedProduct();
    const na = await nodes.issueProductNode(issuance(a.internalProductId, `N${n}TRV`));
    await nodes.transitionProductNodeLifecycle({ nodeId: na.nodeId, toState: "Revoked", lifecycleChangedAt: "2026-02-01T00:00:00.000Z", reasonCode: "x" });
    await expect(
      nodes.transitionProductNodeLifecycle({ nodeId: na.nodeId, toState: "Active", lifecycleChangedAt: "2026-03-01T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(InvalidLifecycleTransitionError);

    const b = await seedProduct();
    const nb = await nodes.issueProductNode(issuance(b.internalProductId, `N${n}TRT`));
    await nodes.transitionProductNodeLifecycle({ nodeId: nb.nodeId, toState: "Retired", lifecycleChangedAt: "2026-02-01T00:00:00.000Z", reasonCode: "x" });
    await expect(
      nodes.transitionProductNodeLifecycle({ nodeId: nb.nodeId, toState: "Inactive", lifecycleChangedAt: "2026-03-01T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(InvalidLifecycleTransitionError);
  });

  it("20. missing reason for Revoked or Retired fails", async () => {
    const rec = await seedProduct();
    const node = await nodes.issueProductNode(issuance(rec.internalProductId, `N${n}NR`));
    await expect(
      nodes.transitionProductNodeLifecycle({ nodeId: node.nodeId, toState: "Revoked", lifecycleChangedAt: "2026-02-01T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(InvalidLifecycleTransitionError);
    await expect(
      nodes.transitionProductNodeLifecycle({ nodeId: node.nodeId, toState: "Retired", lifecycleChangedAt: "2026-02-01T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(InvalidLifecycleTransitionError);
  });

  it("21. same-state transition is idempotent", async () => {
    const rec = await seedProduct();
    const node = await nodes.issueProductNode(issuance(rec.internalProductId, `N${n}SS`));
    const same = await nodes.transitionProductNodeLifecycle({
      nodeId: node.nodeId,
      toState: "Active",
      lifecycleChangedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(same.lifecycleState).toBe("Active");
    expect(same.lifecycleChangedAt).toBe(node.lifecycleChangedAt); // no-op, unchanged
  });

  it("22-23. Node lifecycle change does not alter Product source record or history", async () => {
    const rec = await seedProduct();
    await repo.createProductSourceRecordRevision({
      internalProductId: rec.internalProductId,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: "2026-02-01T00:00:00.000Z",
      capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
      facts: { ...rec.facts, name: "v2" },
    });
    const node = await nodes.issueProductNode(issuance(rec.internalProductId, `N${n}NC`));
    const before1 = await repo.getProductSourceRecordVersion(rec.sourceRecordId, "1");
    const beforeCurrent = await repo.getCurrentProductSourceRecord(rec.internalProductId);
    await nodes.transitionProductNodeLifecycle({
      nodeId: node.nodeId,
      toState: "Revoked",
      lifecycleChangedAt: "2026-03-01T00:00:00.000Z",
      reasonCode: "x",
    });
    expect(await repo.getProductSourceRecordVersion(rec.sourceRecordId, "1")).toEqual(before1);
    expect(await repo.getCurrentProductSourceRecord(rec.internalProductId)).toEqual(beforeCurrent);
  });

  it("24. malformed persisted Node data raises a structured contract violation", async () => {
    const rec = await seedProduct();
    const node = await nodes.issueProductNode(issuance(rec.internalProductId, `N${n}MAL`));
    await db.$executeRawUnsafe(
      "UPDATE ProductNode SET lifecycleState = 'not-a-state' WHERE nodeId = ?",
      node.nodeId,
    );
    await expect(nodes.getProductNode(node.nodeId)).rejects.toBeInstanceOf(
      PersistedNodeContractViolationError,
    );
  });

  it("25. errors do not expose database credentials", async () => {
    const rec = await seedProduct();
    const input = issuance(rec.internalProductId, `N${n}SEC`);
    await nodes.issueProductNode(input);
    try {
      await nodes.issueProductNode({ ...input, nodePolicyVersion: "9.9.9" });
      throw new Error("should have thrown");
    } catch (e) {
      const text = `${(e as Error).name} ${(e as Error).message}`;
      expect(text).not.toContain("3308");
      expect(text.toLowerCase()).not.toContain("mysql://");
      expect(text).not.toContain("root@");
      expect(e).toBeInstanceOf(NodeIssuanceConflictError);
    }
  });
});
