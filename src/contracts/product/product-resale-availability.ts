/**
 * Seller-controlled Product resale availability (Phase 1.40, Contract §9.3) — pure.
 *
 * A Product-wide switch for the third-party promotion / resale channel, owned by
 * the Seller. It is a SEPARATE AXIS from the Product lifecycle (§9.1): neither is
 * derived from, stored as, or rewritten by the other.
 *
 * | State         | Meaning                                                        |
 * | ------------- | -------------------------------------------------------------- |
 * | `NOT_OFFERED` | not offered for third-party resale — every Product's default   |
 * | `AVAILABLE`   | the Seller has affirmatively opened the Product to resale      |
 * | `PAUSED`      | the Seller has temporarily stopped resale availability         |
 * | `WITHDRAWN`   | the Seller has intentionally ended resale availability         |
 *
 * ## Governed transitions, and only those
 *
 * | From          | To                       | Source                                   |
 * | ------------- | ------------------------ | ---------------------------------------- |
 * | `NOT_OFFERED` | `AVAILABLE`              | §9.3 — only while lifecycle is `ACTIVE`  |
 * | `AVAILABLE`   | `PAUSED`                 | §9.3, §16.4 "Pausing resale availability" |
 * | `AVAILABLE`   | `WITHDRAWN`              | §9.3, §16.2 "pause or withdraw"          |
 * | `PAUSED`      | `AVAILABLE`              | §9.3 / §16.4 "resuming" — only while `ACTIVE` |
 * | `PAUSED`      | `WITHDRAWN`              | §9.3 "ended … indefinitely or permanently" |
 *
 * Deliberately NOT governed, and therefore refused:
 *
 *   - anything out of `WITHDRAWN` — "Re-opening a withdrawn Product requires
 *     governed future handling and is not defined here" (§9.3);
 *   - `NOT_OFFERED → PAUSED` / `WITHDRAWN` — pausing or ending an availability
 *     that never existed is not defined;
 *   - anything back to `NOT_OFFERED` — the state means the Seller has not made
 *     the Product available, which stops being true once they have.
 *
 * ## The lifecycle gate governs SETTING `AVAILABLE`, nothing else
 *
 * §9.3: a Seller may set `AVAILABLE` only while the effective lifecycle is
 * `ACTIVE`. A preserved `AVAILABLE` is never reset when the lifecycle later
 * moves; it is simply ineffective until the Product is `ACTIVE` again. `PAUSED`
 * and `WITHDRAWN` are protective and may be chosen in any lifecycle state.
 *
 * Seller `PAUSED` / `WITHDRAWN` are distinct from Monacado `SUSPENDED`; neither
 * is used as, or recorded as, the other.
 *
 * ## Resale-effectiveness
 *
 * `productResaleEffectiveness` is the one question future promoted-commerce
 * eligibility (§16.3) asks of this axis: lifecycle `ACTIVE` AND resale
 * `AVAILABLE`. It is necessary, never sufficient — Offer, Promotion
 * Authorization, and Promoter readiness are later gates and are not asked here.
 * The legacy Product `promotable` fact and `generalAvailabilityState` are never
 * inputs: `promotable` is retired as a governing requirement (§9.3, §34).
 */

import { z } from "zod";
import type { ProductLifecycleState } from "./product-lifecycle";

export const PRODUCT_RESALE_AVAILABILITY_STATES = [
  "NOT_OFFERED",
  "AVAILABLE",
  "PAUSED",
  "WITHDRAWN",
] as const;
export const ProductResaleAvailability = z.enum(PRODUCT_RESALE_AVAILABILITY_STATES);
export type ProductResaleAvailability = z.infer<typeof ProductResaleAvailability>;

/** Every Product starts here; no act is recorded for it. */
export const DEFAULT_PRODUCT_RESALE_AVAILABILITY: ProductResaleAvailability = "NOT_OFFERED";

/** The governed transitions — the table above, and nothing else. */
const GOVERNED_TRANSITIONS: Readonly<Record<ProductResaleAvailability, readonly ProductResaleAvailability[]>> = {
  NOT_OFFERED: ["AVAILABLE"],
  AVAILABLE: ["PAUSED", "WITHDRAWN"],
  PAUSED: ["AVAILABLE", "WITHDRAWN"],
  WITHDRAWN: [],
};

/** The states a Seller may move to from `current`, ignoring the lifecycle gate. */
export function governedResaleAvailabilityTargets(
  current: ProductResaleAvailability,
): readonly ProductResaleAvailability[] {
  return GOVERNED_TRANSITIONS[current];
}

/** Why a requested change is refused, as a closed vocabulary. */
export const RESALE_AVAILABILITY_REFUSALS = ["TRANSITION_NOT_GOVERNED", "PRODUCT_NOT_ACTIVE"] as const;
export type ResaleAvailabilityRefusal = (typeof RESALE_AVAILABILITY_REFUSALS)[number];

export type ResaleAvailabilityDecision =
  | { outcome: "UNCHANGED" }
  | { outcome: "CHANGE"; from: ProductResaleAvailability; to: ProductResaleAvailability }
  | { outcome: "REFUSED"; reason: ResaleAvailabilityRefusal };

/**
 * Decide one Seller request, in a fixed order:
 *
 *   1. the target IS the current state → `UNCHANGED` (nothing is written; a
 *      preserved `AVAILABLE` re-requested while not `ACTIVE` is still no
 *      change, because nothing would be set);
 *   2. the transition is not governed → `TRANSITION_NOT_GOVERNED`;
 *   3. the target is `AVAILABLE` and the effective lifecycle is not `ACTIVE`
 *      → `PRODUCT_NOT_ACTIVE`;
 *   4. otherwise → `CHANGE`.
 */
export function decideResaleAvailabilityChange(input: {
  current: ProductResaleAvailability;
  target: ProductResaleAvailability;
  lifecycle: ProductLifecycleState;
}): ResaleAvailabilityDecision {
  const { current, target, lifecycle } = input;
  if (target === current) return { outcome: "UNCHANGED" };
  if (!GOVERNED_TRANSITIONS[current].includes(target)) {
    return { outcome: "REFUSED", reason: "TRANSITION_NOT_GOVERNED" };
  }
  if (target === "AVAILABLE" && lifecycle !== "ACTIVE") {
    return { outcome: "REFUSED", reason: "PRODUCT_NOT_ACTIVE" };
  }
  return { outcome: "CHANGE", from: current, to: target };
}

/**
 * Each governed target from `current`, with whether the lifecycle permits it
 * now — what a page offers, and why it holds one back. The route decides again.
 */
export function resaleAvailabilityOptions(
  current: ProductResaleAvailability,
  lifecycle: ProductLifecycleState,
): Array<{ target: ProductResaleAvailability; refusal: ResaleAvailabilityRefusal | null }> {
  return GOVERNED_TRANSITIONS[current].map((target) => {
    const decision = decideResaleAvailabilityChange({ current, target, lifecycle });
    return { target, refusal: decision.outcome === "REFUSED" ? decision.reason : null };
  });
}

/** Why a Product is not resale-effective; `null` when it is. */
export type ResaleIneffectiveReason = "LIFECYCLE_NOT_ACTIVE" | "RESALE_NOT_AVAILABLE";

export interface ProductResaleEffectiveness {
  effective: boolean;
  /**
   * The first reason, lifecycle before resale: a non-`ACTIVE` Product stops all
   * commerce whatever the Seller's resale choice says (§9.3).
   */
  ineffectiveBecause: ResaleIneffectiveReason | null;
}

/**
 * Whether this axis permits third-party resale NOW: effective lifecycle `ACTIVE`
 * AND resale availability `AVAILABLE`. Necessary for promoted commerce (§16.3
 * items 1–2), never sufficient.
 */
export function productResaleEffectiveness(input: {
  lifecycle: ProductLifecycleState;
  resaleAvailability: ProductResaleAvailability;
}): ProductResaleEffectiveness {
  if (input.lifecycle !== "ACTIVE") return { effective: false, ineffectiveBecause: "LIFECYCLE_NOT_ACTIVE" };
  if (input.resaleAvailability !== "AVAILABLE") {
    return { effective: false, ineffectiveBecause: "RESALE_NOT_AVAILABLE" };
  }
  return { effective: true, ineffectiveBecause: null };
}
