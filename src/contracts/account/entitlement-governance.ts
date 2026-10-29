/**
 * Entitlement governance (first-operator governance phase).
 *
 * Until this phase an entitlement could be written by anything that imported
 * `grantAccountEntitlement`: no actor, no authority check, no record of who
 * granted what. The identity foundation deferred the answer explicitly — "the
 * first entitlement must be granted by an explicit, separately controlled
 * operation … with its own audit trail". This module is the closed vocabulary
 * of that operation.
 *
 * Four properties shape it:
 *
 *   1. **Every entitlement change is an act.** `AccountEntitlementAct` is an
 *      append-only record — target, capability, GRANT or REVOKE, basis, actor,
 *      instant. `AccountEntitlement` stays the current-state projection that
 *      authorization reads, and is never written without an act in the same
 *      transaction.
 *
 *   2. **Exactly one capability can be first-bootstrapped, once ever.** The
 *      bootstrap is the single act with no actor, so it is the narrowest
 *      possible: `entitlement:govern` only, to an existing ACTIVE account that
 *      proved its own address. A unique marker on the act makes it once-ever per
 *      capability — losing every holder does not re-open it, and nothing in the
 *      environment can.
 *
 *   3. **The governed surface is a closed list, not a wildcard.** An
 *      `entitlement:govern` holder may grant and revoke exactly
 *      `ENTITLEMENT_GOVERNED_CAPABILITIES` — the two policy-governance grants —
 *      and nothing else, not even `entitlement:govern` itself.
 *
 *   4. **The last governor cannot be removed.** With no re-bootstrap and no
 *      emergency path, removing the final `entitlement:govern` holder would be
 *      unrecoverable, so it is refused as its own reason.
 *
 * Pure. No I/O. Not exported through the browser-facing contracts barrel.
 */

import { z } from "zod";
import { ACCOUNT_ENTITLEMENT_ACT_ID_RE } from "../capsule/identity";
import { AccountCapability, AccountId } from "./account";

export const ENTITLEMENT_ACT_ACTIONS = ["GRANT", "REVOKE"] as const;
export const EntitlementActAction = z.enum(ENTITLEMENT_ACT_ACTIONS);
export type EntitlementActAction = z.infer<typeof EntitlementActAction>;

/**
 * Why an act was permitted.
 *
 *   GOVERNED              — an `entitlement:govern` holder acted; the actor is named.
 *   BOOTSTRAP_FIRST_GRANT — the once-ever first grant of a bootstrappable
 *                           capability; there is no actor, because there was
 *                           nobody yet who could be one.
 */
export const ENTITLEMENT_ACT_BASES = ["GOVERNED", "BOOTSTRAP_FIRST_GRANT"] as const;
export const EntitlementActBasis = z.enum(ENTITLEMENT_ACT_BASES);
export type EntitlementActBasis = z.infer<typeof EntitlementActBasis>;

/** The ONLY capabilities that may be first-bootstrapped. Exactly one. */
export const FIRST_GRANT_BOOTSTRAP_CAPABILITIES = [
  "entitlement:govern",
] as const satisfies readonly AccountCapability[];
export type FirstGrantBootstrapCapability = (typeof FIRST_GRANT_BOOTSTRAP_CAPABILITIES)[number];

/**
 * The ONLY capabilities an `entitlement:govern` holder may grant or revoke.
 *
 * Widening this list widens what the meta-capability can hand out, so each
 * addition is a governance decision, not a convenience.
 */
export const ENTITLEMENT_GOVERNED_CAPABILITIES = [
  "commercial-policy:govern",
  "marketplace-policy:govern",
] as const satisfies readonly AccountCapability[];
export type EntitlementGovernedCapability = (typeof ENTITLEMENT_GOVERNED_CAPABILITIES)[number];

/**
 * The single account-verification provenance a first-bootstrap target must
 * carry: the account consumed a real challenge sent to its address. An
 * operator-vouched (`ADMINISTRATIVE`) or grandfathered address is not proof.
 */
export const FIRST_GRANT_REQUIRED_VERIFICATION = "SELF_SERVICE_TOKEN" as const;

export function isFirstGrantBootstrapCapability(
  capability: string,
): capability is FirstGrantBootstrapCapability {
  return (FIRST_GRANT_BOOTSTRAP_CAPABILITIES as readonly string[]).includes(capability);
}

export function isEntitlementGovernedCapability(
  capability: string,
): capability is EntitlementGovernedCapability {
  return (ENTITLEMENT_GOVERNED_CAPABILITIES as readonly string[]).includes(capability);
}

/** Closed refusal vocabulary. Classifications only — never an id or an address. */
export const ENTITLEMENT_GOVERNANCE_REFUSALS = [
  /** The capability is not on the first-bootstrap allow-list. */
  "CAPABILITY_NOT_BOOTSTRAPPABLE",
  /** The capability is not on the governed surface. */
  "CAPABILITY_NOT_GOVERNABLE",
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_DISABLED",
  /** The target has not proved its address through a self-service challenge. */
  "EMAIL_NOT_SELF_VERIFIED",
  /** Some account already actively holds the capability. */
  "CAPABILITY_ALREADY_HELD",
  /** The once-ever first grant of this capability has already happened. */
  "FIRST_GRANT_ALREADY_CLAIMED",
  /** The actor lacks an active `entitlement:govern` (or is disabled or unknown). */
  "ACTOR_NOT_AUTHORIZED",
  "ENTITLEMENT_ALREADY_ACTIVE",
  "ENTITLEMENT_NOT_ACTIVE",
  /** The revocation would leave no active `entitlement:govern` holder. */
  "LAST_ENTITLEMENT_GOVERNOR",
] as const;
export const EntitlementGovernanceRefusal = z.enum(ENTITLEMENT_GOVERNANCE_REFUSALS);
export type EntitlementGovernanceRefusal = z.infer<typeof EntitlementGovernanceRefusal>;

export const BootstrapFirstEntitlementInput = z.strictObject({
  accountId: AccountId,
  capability: z.string().min(1).max(64),
  actedAt: z.iso.datetime(),
});
export type BootstrapFirstEntitlementInput = z.infer<typeof BootstrapFirstEntitlementInput>;

export const GovernedEntitlementChangeInput = z.strictObject({
  actorAccountId: AccountId,
  accountId: AccountId,
  capability: z.string().min(1).max(64),
  actedAt: z.iso.datetime(),
});
export type GovernedEntitlementChangeInput = z.infer<typeof GovernedEntitlementChangeInput>;

export const AccountEntitlementActId = z.string().regex(ACCOUNT_ENTITLEMENT_ACT_ID_RE);

export const AccountEntitlementActRecord = z.strictObject({
  actId: AccountEntitlementActId,
  accountId: AccountId,
  capability: AccountCapability,
  action: EntitlementActAction,
  basis: EntitlementActBasis,
  actorAccountId: AccountId.nullable(),
  actedAt: z.iso.datetime(),
});
export type AccountEntitlementActRecord = z.infer<typeof AccountEntitlementActRecord>;
