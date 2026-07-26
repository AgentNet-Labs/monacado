/**
 * Product Node domain contract (Phase 0E.1).
 *
 * The durable AgentNet Node associated with a Monacado Product. ANS lifecycle
 * lives on the Node — never on Product source records or capsules. Zod is the
 * single authored source of truth; types are inferred. The opaque Node ID reuses
 * the Phase 0B `AnsNodeId` contract (rejects semantic URLs, slugs, product /
 * source-record / capsule IDs, and any identifier encoding entity type/role/
 * name/hierarchy). No passthrough / catch-all / any / metadata bags.
 */

import { z } from "zod";
import { AnsNodeId } from "../capsule/envelope";
import { InternalProductId } from "./product-source-record";

/** ANS Node lifecycle states. */
export const NODE_LIFECYCLE_STATES = ["Active", "Inactive", "Retired", "Revoked"] as const;
export const NodeLifecycleState = z.enum(NODE_LIFECYCLE_STATES);
export type NodeLifecycleState = z.infer<typeof NodeLifecycleState>;

/** Internal Node classification (never encoded into nodeId). */
export const NODE_KINDS = ["product"] as const;
export const NodeKind = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKind>;

/** Registrar identity (Monacado's offline Registrar role). Not required opaque. */
export const RegistrarId = z.string().min(1);

/** A validated, persisted Product Node (domain object). */
export const ProductNode = z.strictObject({
  id: z.string().min(1),
  nodeId: AnsNodeId,
  internalProductId: InternalProductId,
  nodeKind: NodeKind,
  lifecycleState: NodeLifecycleState,
  lifecycleChangedAt: z.iso.datetime(),
  lifecycleReasonCode: z.string().min(1).optional(),
  nodePolicyRef: z.string().min(1),
  nodePolicyVersion: z.string().min(1),
  registrarId: RegistrarId,
  registrarAccreditationRef: z.string().min(1).optional(),
  issuedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProductNode = z.infer<typeof ProductNode>;

/** Input to issue a Product Node (initial lifecycle is Active at issuedAt). */
export const ProductNodeIssuanceInput = z.strictObject({
  nodeId: AnsNodeId,
  internalProductId: InternalProductId,
  nodeKind: NodeKind,
  nodePolicyRef: z.string().min(1),
  nodePolicyVersion: z.string().min(1),
  registrarId: RegistrarId,
  registrarAccreditationRef: z.string().min(1).optional(),
  issuedAt: z.iso.datetime(),
});
export type ProductNodeIssuanceInput = z.infer<typeof ProductNodeIssuanceInput>;

/** Input to transition a Product Node's lifecycle. */
export const LifecycleTransitionInput = z.strictObject({
  nodeId: AnsNodeId,
  toState: NodeLifecycleState,
  /** Explicit event time for the transition (supplied at the service boundary). */
  lifecycleChangedAt: z.iso.datetime(),
  /** Required when transitioning into Revoked or Retired. */
  reasonCode: z.string().min(1).optional(),
});
export type LifecycleTransitionInput = z.infer<typeof LifecycleTransitionInput>;

/**
 * Allowed lifecycle transitions (Phase 0E.1 initial policy). Same-state
 * transitions are treated as idempotent no-ops by the service and are not listed
 * here. Retired and Revoked are terminal (no outgoing transitions).
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<NodeLifecycleState, readonly NodeLifecycleState[]>> = {
  Active: ["Inactive", "Revoked", "Retired"],
  Inactive: ["Active", "Revoked", "Retired"],
  Retired: [],
  Revoked: [],
};

/** States that require a lifecycleReasonCode when transitioned into. */
export const REASON_REQUIRED_STATES: readonly NodeLifecycleState[] = ["Revoked", "Retired"];

/** True if `to` is a permitted transition from `from` (excludes same-state). */
export function isAllowedTransition(from: NodeLifecycleState, to: NodeLifecycleState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}
