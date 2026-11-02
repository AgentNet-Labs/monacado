/**
 * Governed risk-policy bootstrap (Phase 1.46) — SERVER ONLY.
 *
 * Puts one risk policy version into force so the executable checkout's risk
 * gate (`MONACADO_RISK_POLICY_ID`) has something to read. Before this there was
 * no operator path: `createRiskPolicy` exists but checks no authority, and
 * composing create → record → activate was left to whoever held the grant.
 *
 * Minimal, and deliberately not a policy-authoring tool:
 *
 *   1. **Governed.** The actor must actively hold `risk-policy:govern`, checked
 *      before any row is read or written — including the policy shell, which
 *      `createRiskPolicy` would otherwise create for anyone. The record and
 *      activate steps re-check the same grant through the existing services.
 *
 *   2. **Named policy.** The operator supplies the policy id the deployment
 *      already names (`MONACADO_RISK_POLICY_ID`), so no environment change is
 *      needed; with none, a fresh id is minted and reported.
 *
 *   3. **Never overrides.** An ACTIVE version with the same controls is
 *      `ALREADY_ACTIVE` and writes nothing; one with different controls is a
 *      refusal. Changing controls is a later governed act, not a bootstrap.
 *
 *   4. **Resumable.** Version "1" left DRAFT by an interrupted run is activated
 *      if its controls match, and refused if they do not; a RETIRED one is never
 *      resurrected.
 */

import "../server-only";
import {
  canGovernRiskPolicy,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import { RiskPolicyId } from "../../contracts/marketplace/transaction-risk";
import { getPrisma } from "../db/client";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import { cryptoRiskPolicyIdProvider, type RiskPolicyIdProvider } from "./risk-ids";
import { activateRiskPolicyVersion, createRiskPolicy, recordRiskPolicyVersion } from "./risk-policy-service";

type Db = ReturnType<typeof getPrisma>;

export const RISK_POLICY_BOOTSTRAP_VERSION = "1" as const;
export const RISK_POLICY_BOOTSTRAP_LABEL = "Monacado first-sale risk policy" as const;

export const RISK_POLICY_BOOTSTRAP_REFUSALS = [
  "ACTOR_NOT_AUTHORIZED",
  "INVALID_POLICY_ID",
  "INVALID_CONTROLS",
  /** An ACTIVE version with other controls already governs this policy. */
  "CONFLICTING_ACTIVE_VERSION",
  /** Version "1" exists with other controls. */
  "BOOTSTRAP_VERSION_DIVERGED",
  /** Version "1" was retired; the bootstrap never resurrects it. */
  "BOOTSTRAP_VERSION_RETIRED",
] as const;
export type RiskPolicyBootstrapRefusal = (typeof RISK_POLICY_BOOTSTRAP_REFUSALS)[number];

export class RiskPolicyBootstrapRefusedError extends Error {
  readonly refusal: RiskPolicyBootstrapRefusal;
  constructor(refusal: RiskPolicyBootstrapRefusal) {
    super(`Risk policy bootstrap refused: ${refusal}`);
    this.name = "RiskPolicyBootstrapRefusedError";
    this.refusal = refusal;
  }
}

/** The controls a version carries — the whole of what the bootstrap decides. */
export interface RiskPolicyControls {
  currency: string;
  maxSingleOrderCommercialAmountMinorUnits: number;
  requireSellerCommerceApproval: boolean;
  requireSellerPaymentReadiness: boolean;
}

export interface RiskPolicyBootstrapDeps {
  db?: Db;
  ids?: RiskPolicyIdProvider;
}

export interface RiskPolicyBootstrapOutcome {
  outcome: "ALREADY_ACTIVE" | "ACTIVATED";
  policyId: string;
  policyVersion: string;
}

export interface RiskPolicyBootstrapInspection {
  actorAuthorized: boolean;
  policyExists: boolean;
  activeVersion: string | null;
  activeMatches: boolean | null;
  bootstrapVersionStatus: string | null;
}

function sameControls(
  row: {
    currency: string;
    maxSingleOrderCommercialAmountMinorUnits: bigint;
    requireSellerCommerceApproval: boolean;
    requireSellerPaymentReadiness: boolean;
  },
  controls: RiskPolicyControls,
): boolean {
  return (
    row.currency === controls.currency &&
    row.maxSingleOrderCommercialAmountMinorUnits === BigInt(controls.maxSingleOrderCommercialAmountMinorUnits) &&
    row.requireSellerCommerceApproval === controls.requireSellerCommerceApproval &&
    row.requireSellerPaymentReadiness === controls.requireSellerPaymentReadiness
  );
}

async function actorAuthorized(db: Db, actorAccountId: string): Promise<boolean> {
  return isInternallyAuthorized(
    canGovernRiskPolicy(await resolveInternalAuthorizationSubject(actorAccountId, { db })),
  );
}

function requirePolicyId(policyId: string | null): string | null {
  if (policyId === null) return null;
  if (!RiskPolicyId.safeParse(policyId).success) throw new RiskPolicyBootstrapRefusedError("INVALID_POLICY_ID");
  return policyId;
}

async function readState(db: Db, policyId: string | null) {
  if (policyId === null) return { exists: false, active: null, bootstrap: null } as const;
  const policy = await db.riskPolicy.findUnique({ where: { id: policyId }, select: { id: true } });
  if (policy === null) return { exists: false, active: null, bootstrap: null } as const;
  const active = await db.riskPolicyVersionRow.findFirst({ where: { policyId, status: "ACTIVE" } });
  const bootstrap = await db.riskPolicyVersionRow.findUnique({
    where: { policyId_policyVersion: { policyId, policyVersion: RISK_POLICY_BOOTSTRAP_VERSION } },
  });
  return { exists: true, active, bootstrap } as const;
}

/** What the bootstrap would find. Read-only; ids and statuses only. */
export async function inspectRiskPolicyBootstrap(
  input: { actorAccountId: string; policyId: string | null; controls: RiskPolicyControls },
  deps: RiskPolicyBootstrapDeps = {},
): Promise<RiskPolicyBootstrapInspection> {
  const db = deps.db ?? getPrisma();
  const policyId = requirePolicyId(input.policyId);
  const state = await readState(db, policyId);
  return {
    actorAuthorized: await actorAuthorized(db, input.actorAccountId),
    policyExists: state.exists,
    activeVersion: state.active?.policyVersion ?? null,
    activeMatches: state.active === null ? null : sameControls(state.active, input.controls),
    bootstrapVersionStatus: state.bootstrap?.status ?? null,
  };
}

/** Put the named (or a new) risk policy's version "1" into force. */
export async function bootstrapRiskPolicy(
  input: { actorAccountId: string; policyId: string | null; controls: RiskPolicyControls; now: string },
  deps: RiskPolicyBootstrapDeps = {},
): Promise<RiskPolicyBootstrapOutcome> {
  const db = deps.db ?? getPrisma();
  const { controls } = input;
  if (
    !Number.isSafeInteger(controls.maxSingleOrderCommercialAmountMinorUnits) ||
    controls.maxSingleOrderCommercialAmountMinorUnits <= 0
  ) {
    throw new RiskPolicyBootstrapRefusedError("INVALID_CONTROLS");
  }
  let policyId = requirePolicyId(input.policyId);
  if (!(await actorAuthorized(db, input.actorAccountId))) {
    throw new RiskPolicyBootstrapRefusedError("ACTOR_NOT_AUTHORIZED");
  }

  const state = await readState(db, policyId);
  if (state.active !== null) {
    if (!sameControls(state.active, controls)) throw new RiskPolicyBootstrapRefusedError("CONFLICTING_ACTIVE_VERSION");
    return { outcome: "ALREADY_ACTIVE", policyId: state.active.policyId, policyVersion: state.active.policyVersion };
  }
  if (state.bootstrap !== null) {
    if (state.bootstrap.status === "RETIRED") throw new RiskPolicyBootstrapRefusedError("BOOTSTRAP_VERSION_RETIRED");
    if (!sameControls(state.bootstrap, controls)) throw new RiskPolicyBootstrapRefusedError("BOOTSTRAP_VERSION_DIVERGED");
  }

  if (!state.exists) {
    const named = policyId;
    const ids = named === null ? (deps.ids ?? cryptoRiskPolicyIdProvider) : { nextRiskPolicyId: () => named };
    policyId = (await createRiskPolicy({ label: RISK_POLICY_BOOTSTRAP_LABEL, now: input.now }, { db, ids })).policyId;
  }
  const id = policyId!;
  if (state.bootstrap === null) {
    await recordRiskPolicyVersion(
      {
        policyId: id,
        policyVersion: RISK_POLICY_BOOTSTRAP_VERSION,
        ...controls,
        effectiveFrom: input.now,
        recordedByAccountId: input.actorAccountId,
        recordedAt: input.now,
      },
      { db },
    );
  }
  const activated = await activateRiskPolicyVersion(
    {
      policyId: id,
      policyVersion: RISK_POLICY_BOOTSTRAP_VERSION,
      activatedByAccountId: input.actorAccountId,
      activatedAt: input.now,
    },
    { db },
  );
  return { outcome: "ACTIVATED", policyId: activated.policyId, policyVersion: activated.policyVersion };
}
