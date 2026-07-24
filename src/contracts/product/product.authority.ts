/**
 * Product authority policy (ADR §2; Phase 0B authority rules).
 *
 * Deliberately small and explicit — NOT a broad claim-key vocabulary. The
 * Product capsule is creator-authoritative, so the only rule that matters here
 * is: who may create or modify creator-authoritative Product facts.
 *
 *   - creator  → may create and modify;
 *   - promoter → may NOT alter creator Product facts;
 *   - monacado → operational assertions do not belong in this capsule;
 *   - buyer    → observations do not belong in this capsule.
 *
 * (Monacado and buyer assertions are additionally blocked structurally by the
 * capsule schema and the forbidden-field scan; this policy governs the write
 * operation's actor.)
 */

import type { AuthorityClass } from "../capsule/envelope";

export interface Actor {
  role: AuthorityClass;
  /** Node IRI of the actor (e.g. a creator node IRI). */
  id: string;
}

export interface AuthorityDecision {
  allowed: boolean;
  reason?: string;
}

/** The authority that owns creator-authoritative Product facts. */
export const PRODUCT_FACT_AUTHORITY: AuthorityClass = "creator";

/** May this actor create or modify creator-authoritative Product facts? */
export function canWriteProductFacts(actor: Actor): AuthorityDecision {
  if (actor.role === PRODUCT_FACT_AUTHORITY) return { allowed: true };
  return {
    allowed: false,
    reason: `Role "${actor.role}" may not alter creator-authoritative Product facts; only "${PRODUCT_FACT_AUTHORITY}" may.`,
  };
}

/** Guard form: throws if the actor may not write Product facts. */
export function assertCanWriteProductFacts(actor: Actor): void {
  const decision = canWriteProductFacts(actor);
  if (!decision.allowed) {
    throw new ProductAuthorityError(decision.reason ?? "Not authorized");
  }
}

export class ProductAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductAuthorityError";
  }
}
