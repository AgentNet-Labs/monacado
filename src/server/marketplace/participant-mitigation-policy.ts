/**
 * The governance gate for participant-level mitigation (Phase 1.14) — SERVER ONLY.
 *
 * One question, asked before every adverse act: **do the terms in force actually
 * authorise this?**
 *
 * Phase 1.13 recorded, as a value a test reads, that restricting selling
 * capability on risk grounds and suspending a participant both "require new terms
 * before operating". This is that requirement made mechanical. Without it the
 * requirement would be a comment, and a comment is not a control.
 *
 * ## The ACTIVE version, never the newest shipped
 *
 * `LATEST_MARKETPLACE_POLICY_VERSION` is documented as "not an assertion that it
 * governs anything". A gate reading it would let merely publishing 1.3.0 confer
 * an authority nobody activated — which is precisely the confusion between
 * writing terms and governing under them that this phase must not make. So the
 * check reads the `ACTIVE` row from the database, and a deployment that has
 * shipped 1.3.0 but not activated it can still do nothing to a participant.
 *
 * ## Fails closed
 *
 * No active policy at all is a refusal, not a default. The safe reading of
 * silence is "no" — the same reading Phase 1.2 took when it made an absent risk
 * policy a denial rather than an assumed limit.
 */

import "../server-only";
import { MONACADO_MARKETPLACE_POLICY_ID } from "../../contracts/marketplace/marketplace-policy-content";
import { policyVersionAuthorizesParticipantMitigation } from "../../contracts/marketplace/participant-mitigation";
import { getActiveMarketplacePolicyVersionIn } from "../policy/marketplace-policy-service";
import { ParticipantMitigationNotAuthorizedByPolicyError } from "./participant-mitigation-errors";
import type { Prisma } from "@prisma/client";

export interface GoverningPolicyBinding {
  policyId: string;
  policyVersion: string;
}

/**
 * Resolve the terms this act is taken under, or refuse.
 *
 * Returns the binding the caller must record on the act. Binding it at the
 * moment of decision — rather than resolving it on read years later — is the
 * discipline an Order already follows for the terms that governed a purchase: a
 * participant asking for reconsideration months afterwards must be answered on
 * the terms that were in force, and Monacado's authority to have acted is only
 * checkable against the version it acted under.
 *
 * Resolved HERE, from the active row, and never taken from caller input —
 * otherwise an operator could cite whichever version suited the act.
 */
export async function assertParticipantMitigationAuthorizedInTx(
  tx: Prisma.TransactionClient,
): Promise<GoverningPolicyBinding> {
  const active = await getActiveMarketplacePolicyVersionIn(tx, MONACADO_MARKETPLACE_POLICY_ID);
  const version = active?.policyVersion ?? null;
  if (!policyVersionAuthorizesParticipantMitigation(version)) {
    throw new ParticipantMitigationNotAuthorizedByPolicyError(version);
  }
  return { policyId: MONACADO_MARKETPLACE_POLICY_ID, policyVersion: version! };
}
