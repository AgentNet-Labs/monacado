/**
 * Single-run publication orchestration (Phase 0E.6.3) — SERVER ONLY.
 *
 * `runOneProductPublication` claims and processes **at most one** due item, then
 * returns. There is no loop, no scheduler, no polling, and no automatic resend.
 * Invoking again is the caller's decision.
 *
 * This module is a composer, not a re-implementation. Claiming, lease rules,
 * attempt preparation, dispatch guards, and outcome persistence all live in the
 * services of earlier phases and are called, never duplicated. What is genuinely
 * new here is the *decision table* mapping one transport outcome onto durable
 * state — and the boundaries around it.
 *
 * Two properties matter most:
 *
 *   1. **No database transaction spans the HTTP request.** The claim, the
 *      attempt, and the outcome are three separate committed boundaries with the
 *      network call between the second and third. Holding a transaction open
 *      across a call that can hang for the whole timeout would pin a connection
 *      and hold row locks against every other worker.
 *
 *   2. **Ambiguity never resends.** Whenever we cannot prove the request failed
 *      to arrive, the item stays PROCESSING and the attempt stays DISPATCHED.
 *      Guessing "not delivered" and being wrong duplicates a registration;
 *      guessing the other way merely costs a governed retry.
 */

import "../server-only";
import type { getPrisma } from "../db/client";
import { getPrisma as prisma } from "../db/client";
import {
  PublicationRunResult,
  RunOnePublicationInput,
  type PublicationRunResult as RunResult,
} from "../../contracts/product/publication-run";
import type { RegistrarConfigurationLoad } from "../../server/registrar/registrar-runtime-config";
import { createConfiguredRegistrarTransport } from "../../server/registrar/registrar-runtime-factory";
import type { EnvironmentSource } from "../../server/registrar/registrar-runtime-config";
import { PublicationOutboxRepository } from "./publication-outbox-repository";
import { PublicationSubmissionAttemptService } from "./submission-attempt-service";
import { RegistrarDispatchService } from "../registrar/registrar-dispatch-service";
import { NoEligibleOutboxItemError } from "./outbox-errors";
import {
  InvalidRunInputError,
  PostTransportPersistenceFailureError,
  RunRetryTimeRequiredError,
  RunStateConflictError,
  RuntimeNotReadyError,
} from "./publication-run-errors";
import type { RegistrarRegisterTransport } from "../../contracts/product/registrar-transport";

type Db = ReturnType<typeof getPrisma>;

export interface RunOneProductPublicationDeps {
  /** The loaded Phase 0E.6.2 configuration. Only DISABLED or READY is accepted. */
  configuration: RegistrarConfigurationLoad;
  /** Where the bearer secret lives. Injected; the orchestrator reads no env. */
  secretSource: EnvironmentSource;
  /**
   * An already-constructed transport to use instead of building one from
   * `configuration`. The Phase 0E.7.2 entry point passes the transport it built at
   * startup, so exactly one exists per command; tests pass a fake.
   */
  transportOverride?: RegistrarRegisterTransport;
  db?: Db;
}

/** Bounded, safe metadata for a failure we are persisting onto the work item. */
function safeFailure(
  outcome: string,
  detail: { code?: string; summary?: string } | undefined,
): { errorCode: string; errorSummary: string } {
  return {
    errorCode: detail?.code ?? outcome,
    errorSummary: detail?.summary ?? `Transport reported ${outcome}`,
  };
}

/**
 * Process at most one due publication.
 *
 * The flow is deliberately linear and unrepeatable: validate, construct, claim,
 * prepare, send once, record. Any step that finds nothing to do returns early
 * rather than looking for other work.
 */
export async function runOneProductPublication(
  input: unknown,
  deps: RunOneProductPublicationDeps,
): Promise<RunResult> {
  const parsed = RunOnePublicationInput.safeParse(input);
  if (!parsed.success) {
    throw new InvalidRunInputError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const req = parsed.data;

  // — 1. Configuration, before any database access —
  //
  // A disabled Registrar must not even look at the queue: claiming an item we
  // could never send would lock real work behind a lease for no reason.
  if (deps.configuration.state === "DISABLED") {
    return PublicationRunResult.parse({ outcome: "DISABLED" });
  }
  if (deps.configuration.state !== "READY") {
    // INCOMPLETE or INVALID — an operator fault. Refuse before claiming.
    throw new RuntimeNotReadyError(deps.configuration.state);
  }

  // Exact-origin validation and transport construction happen here, still before
  // any claim, and before any secret is read.
  const configured = createConfiguredRegistrarTransport(deps.configuration.config, {
    secretSource: deps.secretSource,
  });

  const db = deps.db ?? prisma();
  const outboxRepo = new PublicationOutboxRepository(db);
  const attempts = new PublicationSubmissionAttemptService(db);
  const dispatcher = new RegistrarDispatchService(
    deps.transportOverride ?? configured.transport,
    db,
    attempts,
  );

  // — 2. Claim exactly one item (its own committed boundary) —
  let claim;
  try {
    claim = await outboxRepo.claimNextPublicationOutbox({
      now: req.now,
      leaseDurationSeconds: req.leaseDurationSeconds,
    });
  } catch (error) {
    if (error instanceof NoEligibleOutboxItemError) {
      return PublicationRunResult.parse({ outcome: "NO_ELIGIBLE_WORK" });
    }
    throw error;
  }

  const { outbox, lockToken } = claim;
  const base = { outboxId: outbox.outboxId, publicationId: outbox.publicationId };

  // — 3. Prepare exactly one attempt for this claim (its own boundary) —
  //
  // Replaying a run with the same submissionAttemptId is idempotent: the
  // preparation service refuses a second attempt for the same claim rather than
  // creating a duplicate.
  await attempts.preparePublicationSubmissionAttempt({
    publicationId: outbox.publicationId,
    outboxId: outbox.outboxId,
    lockToken,
    submissionAttemptId: req.submissionAttemptId,
    preparedAt: req.preparedAt,
  });

  // — 4. Exactly one transport call, OUTSIDE any database transaction —
  const sent = await dispatcher.sendPreparedPublicationAttempt({
    submissionAttemptId: req.submissionAttemptId,
    lockToken,
    now: req.dispatchedAt,
    endpoint: configured.endpoint,
  });

  const { transport } = sent;
  const common = {
    ...base,
    submissionAttemptId: req.submissionAttemptId,
    transmitted: transport.transmitted,
    ...(transport.httpStatus !== undefined ? { httpStatus: transport.httpStatus } : {}),
  };

  // — 5. Record the consequence (a third, guarded boundary) —
  try {
    switch (transport.outcome) {
      /**
       * The Registrar accepted. This is NOT registration: the publication stays
       * unresolved and no receipt is created, because turning a response into an
       * authoritative receipt requires the full Phase 0E.4 reconciliation.
       */
      case "SUCCESS":
        return PublicationRunResult.parse({
          ...common,
          outcome: "SENT",
          attemptStatus: "DISPATCHED",
          outboxStatus: "PROCESSING",
        });

      /**
       * The Registrar answered "no". The exchange worked perfectly, so this is
       * not a transport failure and must not dead-letter: an authoritative
       * REJECTED state still requires a reconciled receipt naming this attempt.
       * The claim and payload are preserved for that.
       */
      case "REMOTE_REJECTION":
        return PublicationRunResult.parse({
          ...common,
          outcome: "REMOTE_REJECTION",
          attemptStatus: "DISPATCHED",
          outboxStatus: "PROCESSING",
        });

      /**
       * Possibly delivered. Nothing moves: the attempt stays DISPATCHED, the
       * item stays PROCESSING under its lease, and no retry is scheduled. This
       * is the duplicate-registration guard.
       */
      case "AMBIGUOUS_DELIVERY":
        return PublicationRunResult.parse({
          ...common,
          outcome: "AMBIGUOUS_DELIVERY",
          attemptStatus: "DISPATCHED",
          outboxStatus: "PROCESSING",
        });

      case "RETRYABLE_TRANSPORT_FAILURE": {
        // Only a failure we can prove preceded transmission may be rescheduled.
        // A retryable classification that DID leave (a 5xx, say) is ambiguous in
        // the way that matters — the Registrar may have processed it — so it is
        // treated as ambiguous rather than resent.
        if (transport.transmitted) {
          return PublicationRunResult.parse({
            ...common,
            outcome: "AMBIGUOUS_DELIVERY",
            attemptStatus: "DISPATCHED",
            outboxStatus: "PROCESSING",
          });
        }
        if (req.retryAvailableAt === undefined) {
          // Not defaulted: inventing a retry time would be this module reading a
          // clock and choosing a backoff — the caller's decision, not ours.
          throw new RunRetryTimeRequiredError();
        }

        // The attempt never left, so it can never be answered: retire it.
        await attempts.markPublicationSubmissionAttemptAbandoned({
          submissionAttemptId: req.submissionAttemptId,
          abandonedAt: req.dispatchedAt,
        });
        await outboxRepo.markPublicationOutboxRetryable({
          outboxId: outbox.outboxId,
          lockToken,
          availableAt: req.retryAvailableAt,
          ...safeFailure("RETRYABLE_TRANSPORT_FAILURE", transport.failure),
        });
        return PublicationRunResult.parse({
          ...common,
          outcome: "RETRY_SCHEDULED",
          attemptStatus: "ABANDONED",
          outboxStatus: "RETRYABLE",
          retryAvailableAt: req.retryAvailableAt,
        });
      }

      case "TERMINAL_TRANSPORT_FAILURE": {
        // A DISPATCHED attempt is left alone even here: it may still be answered
        // by a late receipt, and abandoning it would throw that evidence away.
        // Only an attempt that provably never left is retired.
        if (!sent.attemptDispatched) {
          await attempts.markPublicationSubmissionAttemptAbandoned({
            submissionAttemptId: req.submissionAttemptId,
            abandonedAt: req.dispatchedAt,
          });
        }
        await outboxRepo.markPublicationOutboxDeadLetter({
          outboxId: outbox.outboxId,
          lockToken,
          ...safeFailure("TERMINAL_TRANSPORT_FAILURE", transport.failure),
        });
        return PublicationRunResult.parse({
          ...common,
          outcome: "DEAD_LETTERED",
          attemptStatus: sent.attemptDispatched ? "DISPATCHED" : "ABANDONED",
          outboxStatus: "DEAD_LETTER",
        });
      }
    }
  } catch (error) {
    if (error instanceof RunRetryTimeRequiredError) throw error;

    // The request went out but its consequence could not be recorded. This is
    // the one genuinely dangerous state in the phase: the durable record no
    // longer describes the outside world. It is reported, never resent.
    const failure = new PostTransportPersistenceFailureError(transport.transmitted, error);
    if (isStaleClaim(error)) {
      // A newer owner exists — a recovery sweep or a governed remediation moved
      // this item while we were on the network. Refusing to write is correct:
      // a stale worker must not overwrite newer state.
      throw new RunStateConflictError(
        "The claim was no longer current when the outcome was applied",
        ["lockToken", "outboxStatus"],
        error,
      );
    }
    throw failure;
  }
}

/** Recognise the existing ownership/staleness errors without importing their text. */
function isStaleClaim(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  return (
    code === "OUTBOX_LOCK_TOKEN_MISMATCH" ||
    code === "STALE_CLAIM" ||
    code === "INVALID_OUTBOX_TRANSITION" ||
    code === "OUTBOX_NOT_FOUND"
  );
}
