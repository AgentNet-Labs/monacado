/**
 * Product Node repository — Monacado's OFFLINE Registrar-domain operations
 * (Phase 0E.1). Issues and manages the durable AgentNet Node for a Product and
 * its ANS lifecycle. No publication records, receipts, reconciliation, or
 * network/Registrar/Resolver calls. Returns validated domain objects, never raw
 * Prisma rows.
 */

import { Prisma } from "@prisma/client";
import type { ProductNode as ProductNodeRow } from "@prisma/client";
import {
  isAllowedTransition,
  LifecycleTransitionInput,
  ProductNode,
  ProductNodeIssuanceInput,
  REASON_REQUIRED_STATES,
  type NodeLifecycleState,
  type ProductNode as ProductNodeDomain,
} from "../../contracts/product/product-node";
import { getPrisma } from "../db/client";
import { DatabaseError, ValidationError } from "./errors";
import {
  InvalidLifecycleTransitionError,
  InvalidNodeIdError,
  NodeIssuanceConflictError,
  PersistedNodeContractViolationError,
  ProductNodeNotFoundError,
  ProductNotFoundError,
} from "./node-errors";

/** Monacado's offline Registrar identity (accreditation verification deferred). */
export const MONACADO_REGISTRAR_ID = "an:registrar:monacado" as const;

type Db = ReturnType<typeof getPrisma>;

const iso = (d: Date): string => d.toISOString();

/** Reconstruct a validated domain Product Node from a persisted row. */
function nodeRowToDomain(row: ProductNodeRow): ProductNodeDomain {
  const candidate = {
    id: row.id.toString(),
    nodeId: row.nodeId,
    internalProductId: row.internalProductId,
    nodeKind: row.nodeKind,
    lifecycleState: row.lifecycleState,
    lifecycleChangedAt: iso(row.lifecycleChangedAt),
    ...(row.lifecycleReasonCode !== null ? { lifecycleReasonCode: row.lifecycleReasonCode } : {}),
    nodePolicyRef: row.nodePolicyRef,
    nodePolicyVersion: row.nodePolicyVersion,
    registrarId: row.registrarId,
    ...(row.registrarAccreditationRef !== null
      ? { registrarAccreditationRef: row.registrarAccreditationRef }
      : {}),
    issuedAt: iso(row.issuedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
  const parsed = ProductNode.safeParse(candidate);
  if (!parsed.success) {
    throw new PersistedNodeContractViolationError(
      "Persisted Product Node violates the ProductNode contract",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** Issuance-time fields that must match for a repeated issuance to be idempotent. */
const ISSUANCE_FIELDS = [
  "nodeId",
  "nodeKind",
  "nodePolicyRef",
  "nodePolicyVersion",
  "registrarId",
  "registrarAccreditationRef",
  "issuedAt",
] as const;

export class ProductNodeRepository {
  constructor(private readonly db: Db = getPrisma()) {}

  /** Issue (or idempotently return) the durable Product Node. */
  async issueProductNode(input: unknown): Promise<ProductNodeDomain> {
    const parsed = ProductNodeIssuanceInput.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      if (parsed.error.issues.some((i) => i.path[0] === "nodeId")) {
        throw new InvalidNodeIdError("Invalid Node ID", issues);
      }
      throw new ValidationError("Invalid Product Node issuance input", issues);
    }
    const req = parsed.data;

    // Stable Product must exist.
    const product = await this.db.product.findUnique({
      where: { internalProductId: req.internalProductId },
    });
    if (!product) throw new ProductNotFoundError();

    // Idempotency / conflict against an existing Node for this Product.
    const existingForProduct = await this.db.productNode.findUnique({
      where: { internalProductId: req.internalProductId },
    });
    if (existingForProduct) {
      const conflicts = this.issuanceConflicts(existingForProduct, req);
      if (conflicts.length === 0) return nodeRowToDomain(existingForProduct); // idempotent
      throw new NodeIssuanceConflictError(
        "A different Product Node is already issued for this Product",
        conflicts,
      );
    }

    // nodeId must not already anchor a different Product.
    const existingForNodeId = await this.db.productNode.findUnique({ where: { nodeId: req.nodeId } });
    if (existingForNodeId) {
      throw new NodeIssuanceConflictError("This Node ID is already issued to another Product", ["nodeId"]);
    }

    try {
      const created = await this.db.productNode.create({
        data: {
          nodeId: req.nodeId,
          internalProductId: req.internalProductId,
          nodeKind: req.nodeKind,
          lifecycleState: "Active",
          lifecycleChangedAt: new Date(req.issuedAt),
          nodePolicyRef: req.nodePolicyRef,
          nodePolicyVersion: req.nodePolicyVersion,
          registrarId: req.registrarId,
          registrarAccreditationRef: req.registrarAccreditationRef ?? null,
          issuedAt: new Date(req.issuedAt),
        },
      });
      return nodeRowToDomain(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new NodeIssuanceConflictError("A conflicting Product Node already exists", ["nodeId"], e.code);
      }
      throw new DatabaseError("Product Node issuance failed", e instanceof Error ? e.message : undefined);
    }
  }

  private issuanceConflicts(row: ProductNodeRow, req: ProductNodeIssuanceInput): string[] {
    const rowView: Record<string, unknown> = {
      nodeId: row.nodeId,
      nodeKind: row.nodeKind,
      nodePolicyRef: row.nodePolicyRef,
      nodePolicyVersion: row.nodePolicyVersion,
      registrarId: row.registrarId,
      registrarAccreditationRef: row.registrarAccreditationRef ?? undefined,
      issuedAt: iso(row.issuedAt),
    };
    const reqView: Record<string, unknown> = {
      nodeId: req.nodeId,
      nodeKind: req.nodeKind,
      nodePolicyRef: req.nodePolicyRef,
      nodePolicyVersion: req.nodePolicyVersion,
      registrarId: req.registrarId,
      registrarAccreditationRef: req.registrarAccreditationRef,
      issuedAt: req.issuedAt,
    };
    return ISSUANCE_FIELDS.filter((f) => rowView[f] !== reqView[f]);
  }

  /** Retrieve a Product Node by its opaque Node ID. */
  async getProductNode(nodeId: string): Promise<ProductNodeDomain> {
    const row = await this.db.productNode.findUnique({ where: { nodeId } });
    if (!row) throw new ProductNodeNotFoundError();
    return nodeRowToDomain(row);
  }

  /** Retrieve a Product Node by the stable Product identity. */
  async getProductNodeByInternalProductId(internalProductId: string): Promise<ProductNodeDomain> {
    const row = await this.db.productNode.findUnique({ where: { internalProductId } });
    if (!row) throw new ProductNodeNotFoundError();
    return nodeRowToDomain(row);
  }

  /** Transition a Product Node's ANS lifecycle per the transition matrix. */
  async transitionProductNodeLifecycle(input: unknown): Promise<ProductNodeDomain> {
    const parsed = LifecycleTransitionInput.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      if (parsed.error.issues.some((i) => i.path[0] === "nodeId")) {
        throw new InvalidNodeIdError("Invalid Node ID", issues);
      }
      throw new ValidationError("Invalid lifecycle-transition input", issues);
    }
    const req = parsed.data;

    const row = await this.db.productNode.findUnique({ where: { nodeId: req.nodeId } });
    if (!row) throw new ProductNodeNotFoundError();
    const from = row.lifecycleState as NodeLifecycleState;

    // Same-state: idempotent no-op (no write, no reason required).
    if (req.toState === from) return nodeRowToDomain(row);

    if (!isAllowedTransition(from, req.toState)) {
      throw new InvalidLifecycleTransitionError(
        `Lifecycle transition ${from} -> ${req.toState} is not permitted`,
      );
    }
    if (REASON_REQUIRED_STATES.includes(req.toState) && !req.reasonCode) {
      throw new InvalidLifecycleTransitionError(
        `Transition to ${req.toState} requires a lifecycleReasonCode`,
      );
    }

    try {
      const updated = await this.db.productNode.update({
        where: { nodeId: req.nodeId },
        data: {
          lifecycleState: req.toState,
          lifecycleChangedAt: new Date(req.lifecycleChangedAt),
          lifecycleReasonCode: req.reasonCode ?? null,
        },
      });
      return nodeRowToDomain(updated);
    } catch (e) {
      throw new DatabaseError("Lifecycle transition failed", e instanceof Error ? e.message : undefined);
    }
  }
}
