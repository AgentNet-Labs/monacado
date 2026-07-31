/**
 * Principal-to-caller mapping and route authorization (Phase 0E.7.4.2B) —
 * SERVER ONLY.
 *
 * Two small pure pieces that sit between the identity foundation and the Phase
 * 0E.7.4.1 application service, and translate rather than decide.
 *
 * ## Two independent enforcement boundaries
 *
 * This is the point of the whole arrangement, so it is worth stating plainly:
 *
 *   1. `resolveAuthenticatedPrincipal` derives `INTERNAL_OPERATOR` **only** from an
 *      active persisted entitlement, read from the database on every request;
 *   2. the status service **independently** calls its injected authorizer before
 *      its first worker-run query.
 *
 * Neither trusts the other. If the mapper below were ever weakened, the service
 * would still refuse; if the service's authorizer were ever bypassed, the mapper
 * would still have refused to produce a caller context. A single boundary would
 * make one careless edit sufficient.
 */

import "../server-only";
import {
  PUBLICATION_WORKER_STATUS_READ_CAPABILITY,
  type InternalCallerContext,
  type PublicationWorkerStatusAuthorizer,
  type WorkerStatusAuthorizationDecision,
} from "../../contracts/product/publication-worker-status";
import type { AuthenticatedPrincipal } from "../../contracts/account/account";

/**
 * Map a resolved account principal onto the worker-status caller context.
 *
 * Returns `undefined` when the principal must not be admitted — an ordinary
 * authenticated `ACCOUNT`, or an `INTERNAL_OPERATOR` whose capability list somehow
 * lacks the one being requested. Both checks are made, rather than trusting
 * `actorType` alone, because the type is a *derived* summary and the capability
 * list is the fact it was derived from.
 *
 * The projection is deliberately lossy. `accountId`, `sessionId`, and the raw
 * capabilities array all stay behind: the service needs an opaque actor, a type, a
 * capability, and a correlation id, and handing it anything more would widen what
 * an audit event or a future log line could accidentally carry.
 */
export function mapAccountPrincipalToWorkerStatusCaller(
  principal: AuthenticatedPrincipal,
  requestId: string,
): InternalCallerContext | undefined {
  if (principal.actorType !== "INTERNAL_OPERATOR") return undefined;
  if (!principal.capabilities.includes(PUBLICATION_WORKER_STATUS_READ_CAPABILITY)) {
    return undefined;
  }
  return {
    // The stable, opaque account-derived identity — never a name or an address.
    actorId: principal.actorId,
    actorType: "INTERNAL_OPERATOR",
    requestedCapability: PUBLICATION_WORKER_STATUS_READ_CAPABILITY,
    requestId,
  };
}

/**
 * The authorizer this route hands to the status service.
 *
 * It re-asserts what the mapper already checked, against the **same** persisted
 * principal — not against a header, a cookie value, an email, a domain, an
 * environment variable, a hard-coded account, or a query parameter, none of which
 * appear anywhere in this module.
 *
 * There is no permissive default: the decision is `DENIED` unless both conditions
 * hold.
 */
export function createPrincipalWorkerStatusAuthorizer(
  principal: AuthenticatedPrincipal,
): PublicationWorkerStatusAuthorizer {
  return {
    authorizePublicationWorkerStatusRead(caller): WorkerStatusAuthorizationDecision {
      if (principal.actorType !== "INTERNAL_OPERATOR") return "DENIED";
      if (!principal.capabilities.includes(PUBLICATION_WORKER_STATUS_READ_CAPABILITY)) {
        return "DENIED";
      }
      // The caller context must still describe the principal it came from — a
      // mismatch means something rewrote it between mapping and authorization.
      if (caller.actorId !== principal.actorId) return "DENIED";
      if (caller.requestedCapability !== PUBLICATION_WORKER_STATUS_READ_CAPABILITY) {
        return "DENIED";
      }
      return "AUTHORIZED";
    },
  };
}
