/**
 * The outbound email dispatcher (Phase 1.5) — SERVER ONLY.
 *
 * One bounded cycle: recover what a dead worker left, claim what is due, and for
 * each claimed row resolve → render → send → record. **No loop, no scheduler, no
 * `setInterval`, no self-rescheduling** — exactly the shape
 * `worker:publication:once` established, and for the same reason: deciding to run
 * a second cycle stays entirely outside, which is what makes this safe to run by
 * hand, from a protected endpoint, or from a future scheduler without any of them
 * inheriting a hidden loop.
 *
 * ## The order within one delivery
 *
 * ```
 *   claimed
 *      │
 *      ├─ resolve recipient + render from authoritative state
 *      │     └─ cannot ⇒ RECIPIENT_UNRESOLVABLE (permanent) or a transient code
 *      │
 *      ├─ suppression check  ← immediately before the send, never at enqueue
 *      │     └─ suppressed ⇒ DESTINATION_SUPPRESSED (permanent). Nothing is sent.
 *      │
 *      ├─ MailPort.send
 *      │
 *      └─ resolve the claim: DELIVERED | RETRY_PENDING | PERMANENTLY_FAILED
 * ```
 *
 * The suppression check is deliberately **here and not at enqueue**. A receipt
 * committed on Monday and retried on Tuesday must respect a hard bounce that
 * arrived on Monday night; a check performed once, at commit time, would keep
 * writing to an address the provider has already told Monacado is dead.
 *
 * ## One failure never stops the batch
 *
 * Every per-delivery failure is caught, classified, and recorded against that
 * row. A malformed Order or a provider timeout on message three must not abandon
 * messages four and five — and a worker that threw halfway through would leave
 * those rows claimed until their lease expired.
 *
 * ## What it does not do
 *
 * It writes no `NotificationObligation`, reads none to decide whether a message is
 * owed, and advances none. `AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` §3a is
 * unchanged: the admin panel is canonical and email is supplemental, so five
 * attempts at a notice leave the obligation exactly as owed as one did.
 */

import "../server-only";
import type { MailPort } from "../../contracts/marketplace/notification-delivery";
import {
  classifyFailure,
  EMAIL_RETRY_POLICY,
  type OutboundEmailDeliveryRecord,
} from "../../contracts/marketplace/outbound-email";
import { getPrisma } from "../db/client";
import { resolveMailPort, resolvedMailProvider } from "./mail-port";
import {
  claimDueEmailDeliveries,
  recoverStaleEmailClaims,
  resolveEmailDelivery,
  type OutboundEmailDeps,
} from "./outbound-email-service";
import { emailAddressDigest, isAddressSuppressedIn } from "./email-suppression-service";
import {
  resolveOutboundMessage,
  type MessageResolverDeps,
} from "./email-message-resolver";
import { DeliveryClaimConflictError } from "./outbound-email-errors";

type Db = ReturnType<typeof getPrisma>;

/** How many deliveries one cycle will take. Bounded; a cycle is not a drain. */
export const DEFAULT_DISPATCH_LIMIT = 25;

export interface EmailDispatcherDeps extends OutboundEmailDeps, MessageResolverDeps {
  db?: Db;
  /** The provider name recorded on the row. Derived from the env by default. */
  providerName?: string;
}

/** What one cycle did. Counts only — no address, no subject, no body. */
export interface EmailDispatchCycleResult {
  recovered: number;
  claimed: number;
  delivered: number;
  retryScheduled: number;
  permanentlyFailed: number;
  suppressed: number;
  /** Claims lost to an expired lease mid-send. Visible, never silent. */
  claimConflicts: number;
}

const emptyResult = (): EmailDispatchCycleResult => ({
  recovered: 0,
  claimed: 0,
  delivered: 0,
  retryScheduled: 0,
  permanentlyFailed: 0,
  suppressed: 0,
  claimConflicts: 0,
});

/**
 * Send one claimed delivery and record what happened.
 *
 * Exported so a test can drive a single message end to end without a batch, and
 * so an operator command can. It **always** resolves the claim, whichever way the
 * attempt went — a claimed row that is never resolved is a row that waits out its
 * lease for no reason.
 */
export async function dispatchClaimedEmailDelivery(
  claim: { delivery: OutboundEmailDeliveryRecord; lockToken: string },
  at: string,
  port: MailPort,
  deps: EmailDispatcherDeps = {},
): Promise<"DELIVERED" | "RETRY_SCHEDULED" | "PERMANENTLY_FAILED" | "SUPPRESSED"> {
  const db = deps.db ?? getPrisma();
  const provider = deps.providerName ?? resolvedMailProvider(deps.env ?? process.env);

  const record = async (resolution: {
    outcomeClass: "ACCEPTED" | "TRANSIENT" | "PERMANENT";
    providerMessageRef: string | null;
    failureCode: Parameters<typeof classifyFailure>[0] | null;
    destinationDigest: string | null;
  }) =>
    resolveEmailDelivery(
      {
        deliveryId: claim.delivery.deliveryId,
        lockToken: claim.lockToken,
        resolution: { ...resolution, provider, at },
      },
      deps,
    );

  const message = await resolveOutboundMessage(claim.delivery, at, deps);
  if (!message.resolved) {
    const outcomeClass = classifyFailure(message.failureCode);
    const settled = await record({
      outcomeClass,
      providerMessageRef: null,
      failureCode: message.failureCode,
      destinationDigest: null,
    });
    return settled.status === "RETRY_PENDING" ? "RETRY_SCHEDULED" : "PERMANENTLY_FAILED";
  }

  const destinationDigest = emailAddressDigest(message.destination);

  /* Immediately before the send, never at enqueue. */
  if (await isAddressSuppressedIn(db, message.destination)) {
    await record({
      outcomeClass: "PERMANENT",
      providerMessageRef: null,
      failureCode: "DESTINATION_SUPPRESSED",
      destinationDigest,
    });
    return "SUPPRESSED";
  }

  let result;
  try {
    result = await port.send({
      to: message.destination,
      subject: message.subject,
      text: message.text,
    });
  } catch {
    /* A port that throws is a port misbehaving — `MailPort` says an ordinary
       refusal is a result. The thrown value is deliberately NOT inspected: it is
       the most likely place for an address, a rendered body, or a live
       verification credential to be hiding. */
    result = { outcome: "REFUSED" as const, failureCode: "UNSPECIFIED_FAILURE" as const };
  }

  if (result.outcome === "ACCEPTED") {
    await record({
      outcomeClass: "ACCEPTED",
      providerMessageRef: result.providerMessageRef,
      failureCode: null,
      destinationDigest,
    });
    return "DELIVERED";
  }

  const settled = await record({
    outcomeClass: classifyFailure(result.failureCode),
    providerMessageRef: null,
    failureCode: result.failureCode,
    destinationDigest,
  });
  return settled.status === "RETRY_PENDING" ? "RETRY_SCHEDULED" : "PERMANENTLY_FAILED";
}

/**
 * One bounded dispatch cycle.
 *
 * Recovery runs **first**: a row abandoned by a dead worker should be eligible in
 * the same cycle that notices it, rather than waiting for the next one.
 */
export async function runEmailDispatchCycle(
  input: { now: string; limit?: number },
  port?: MailPort,
  deps: EmailDispatcherDeps = {},
): Promise<EmailDispatchCycleResult> {
  const limit = input.limit ?? DEFAULT_DISPATCH_LIMIT;
  const mail = port ?? resolveMailPort(deps.env ?? process.env);
  const result = emptyResult();

  result.recovered = await recoverStaleEmailClaims({ now: input.now, limit }, deps);

  const claims = await claimDueEmailDeliveries({ now: input.now, limit }, deps);
  result.claimed = claims.length;

  for (const claim of claims) {
    try {
      const outcome = await dispatchClaimedEmailDelivery(claim, input.now, mail, deps);
      if (outcome === "DELIVERED") result.delivered += 1;
      else if (outcome === "RETRY_SCHEDULED") result.retryScheduled += 1;
      else if (outcome === "SUPPRESSED") result.suppressed += 1;
      else result.permanentlyFailed += 1;
    } catch (error) {
      /* One bad delivery never abandons the rest of the batch. A lost claim is
         counted rather than swallowed: it means a lease expired mid-send, which
         is a thing an operator should be able to see happening. */
      if (error instanceof DeliveryClaimConflictError) {
        result.claimConflicts += 1;
        continue;
      }
      throw error;
    }
  }

  return result;
}

/**
 * Claim and send exactly these deliveries, now.
 *
 * The enqueue-then-attempt-immediately path. A buyer should not wait for a
 * scheduler to learn their payment succeeded, and a caller that has just
 * committed a message is the caller best placed to try it — but the commitment
 * is already durable, so a failure here schedules a retry instead of losing a
 * receipt, which is exactly what `1.1` could not do.
 *
 * Restricted to the given ids on purpose: draining an unrelated backlog inside a
 * webhook that has a payment provider waiting on it would make somebody else's
 * outage this response's latency.
 */
export async function dispatchEmailDeliveriesNow(
  input: { deliveryIds: readonly string[]; now: string },
  port?: MailPort,
  deps: EmailDispatcherDeps = {},
): Promise<EmailDispatchCycleResult> {
  const result = emptyResult();
  if (input.deliveryIds.length === 0) return result;

  const mail = port ?? resolveMailPort(deps.env ?? process.env);
  const claims = await claimDueEmailDeliveries(
    { now: input.now, limit: input.deliveryIds.length, only: input.deliveryIds },
    deps,
  );
  result.claimed = claims.length;

  for (const claim of claims) {
    try {
      const outcome = await dispatchClaimedEmailDelivery(claim, input.now, mail, deps);
      if (outcome === "DELIVERED") result.delivered += 1;
      else if (outcome === "RETRY_SCHEDULED") result.retryScheduled += 1;
      else if (outcome === "SUPPRESSED") result.suppressed += 1;
      else result.permanentlyFailed += 1;
    } catch (error) {
      if (error instanceof DeliveryClaimConflictError) {
        result.claimConflicts += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

/** The policy this dispatcher runs under, for an operator report. */
export const DISPATCHER_POLICY = {
  maxAttempts: EMAIL_RETRY_POLICY.maxAttempts,
  backoffSeconds: EMAIL_RETRY_POLICY.backoffSeconds,
  claimLeaseSeconds: EMAIL_RETRY_POLICY.claimLeaseSeconds,
  defaultLimit: DEFAULT_DISPATCH_LIMIT,
} as const;
