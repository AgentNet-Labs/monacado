/**
 * Prepared-attempt dispatch (Phase 0E.6.1) — one narrow orchestration:
 * `sendPreparedPublicationAttempt`.
 *
 * It joins the durable side (a PREPARED submission attempt and its live claim)
 * to the transport boundary, sends exactly once, and records the consequence.
 *
 * The delicate part is deciding whether the attempt becomes DISPATCHED. That
 * flag is a claim about the outside world — "this request may have reached the
 * Registrar" — and it gates whether a later receipt may answer the attempt. So:
 *
 *   - transmitted (or possibly transmitted) → DISPATCHED;
 *   - provably not transmitted             → stays PREPARED, reusable.
 *
 * Ambiguity resolves toward DISPATCHED. Marking a delivered request as
 * undelivered invites a duplicate registration; marking an undelivered one as
 * dispatched merely costs a governed retry.
 *
 * There is no automatic retry, no outbox resolution, and no receipt creation
 * here. An immediate Registrar response is RETURNED, never persisted as a
 * receipt: turning it into one requires the full Phase 0E.4 reconciliation,
 * which is a separate ingestion step.
 */

import {
  RegistrarEndpoint,
  TransportResult,
  type RegisterResponseEnvelope,
  type RegistrarEndpoint as Endpoint,
  type RegistrarRegisterTransport,
  type TransportResult as Result,
} from "../../contracts/product/registrar-transport";
import {
  RegisterRequestBuildError,
  buildRegisterRequest,
} from "../../contracts/product/registrar-request-builder";
import { attemptRowToDomain } from "../product/submission-attempt-mapper";
import { PublicationSubmissionAttemptService } from "../product/submission-attempt-service";
import { getPrisma } from "../db/client";
import { ValidationError } from "../product/errors";
import { z } from "zod";
import { LockToken } from "../../contracts/product/product-publication";
import { SubmissionAttemptId } from "../../contracts/product/product-submission-attempt";
import {
  DispatchStateConflictError,
  RegisterRequestContractFailureError,
} from "./transport-errors";

type Db = ReturnType<typeof getPrisma>;

/** Input to one send. Every instant is explicit; no clock is read. */
export const SendPreparedAttemptInput = z.strictObject({
  submissionAttemptId: SubmissionAttemptId,
  /** Proves the caller still owns the claim that prepared this attempt. */
  lockToken: LockToken,
  /** The instant the lease is judged against, and the dispatch timestamp. */
  now: z.iso.datetime(),
  endpoint: RegistrarEndpoint,
});
export type SendPreparedAttemptInput = z.infer<typeof SendPreparedAttemptInput>;

/**
 * The outcome of one send: what the transport reported, whether the attempt was
 * marked dispatched, and the Registrar's validated response when there was one.
 *
 * `response` is evidence for a LATER receipt-ingestion step. It is deliberately
 * not a receipt and has not been reconciled against the attempt.
 */
export const SendPreparedAttemptResult = z.strictObject({
  transport: TransportResult,
  attemptDispatched: z.boolean(),
  submissionAttemptId: SubmissionAttemptId,
});
export type SendPreparedAttemptResult = z.infer<typeof SendPreparedAttemptResult>;

export interface SendPreparedAttemptOutcome extends SendPreparedAttemptResult {
  /** Present when the Registrar returned a valid envelope. NOT a receipt. */
  registrarResponse?: RegisterResponseEnvelope;
}

export class RegistrarDispatchService {
  constructor(
    private readonly transport: RegistrarRegisterTransport,
    private readonly db: Db = getPrisma(),
    private readonly attempts: PublicationSubmissionAttemptService = new PublicationSubmissionAttemptService(db),
  ) {}

  /**
   * Send one PREPARED attempt. Exactly one transport call is made — the caller
   * decides whether to try again, because only a layer that can see attempt
   * history can decide that safely.
   */
  async sendPreparedPublicationAttempt(input: unknown): Promise<SendPreparedAttemptOutcome> {
    const parsed = SendPreparedAttemptInput.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "Invalid dispatch input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      );
    }
    const req = parsed.data;

    // — 1. Load the attempt and everything it depends on —
    const attemptRow = await this.db.publicationSubmissionAttempt.findUnique({
      where: { submissionAttemptId: req.submissionAttemptId },
    });
    if (!attemptRow) {
      throw new DispatchStateConflictError("Submission attempt not found", ["submissionAttemptId"]);
    }
    const attempt = attemptRowToDomain(attemptRow);

    if (attempt.attemptStatus !== "PREPARED") {
      throw new DispatchStateConflictError(
        `Only a PREPARED attempt may be sent; this one is ${attempt.attemptStatus}`,
        ["attemptStatus"],
      );
    }

    const publicationRow = await this.db.productPublication.findUnique({
      where: { publicationId: attempt.publicationId },
    });
    if (!publicationRow) {
      throw new DispatchStateConflictError("Publication not found", ["publicationId"]);
    }
    const outboxRow = await this.db.publicationOutbox.findUnique({
      where: { outboxId: attempt.outboxId },
    });
    if (!outboxRow) {
      throw new DispatchStateConflictError("Outbox item not found", ["outboxId"]);
    }

    // — A settled publication has nothing to send —
    if (publicationRow.remediationState === "CLOSED") {
      throw new DispatchStateConflictError(
        "This publication was closed by a governed remediation decision",
        ["remediationState"],
      );
    }
    if (
      publicationRow.remediationState === "RESOLVED" ||
      publicationRow.registrationState === "ACCEPTED"
    ) {
      throw new DispatchStateConflictError("This publication is already resolved", [
        "registrationState",
      ]);
    }

    // — 2. The claim must still be live and owned, judged at the supplied time —
    if (outboxRow.outboxStatus !== "PROCESSING") {
      throw new DispatchStateConflictError(
        "The outbox item is no longer claimed",
        ["outboxStatus"],
      );
    }
    if (outboxRow.lockToken !== req.lockToken) {
      throw new DispatchStateConflictError("The presented lock token does not own this claim", [
        "lockToken",
      ]);
    }
    if (
      outboxRow.leaseExpiresAt === null ||
      outboxRow.leaseExpiresAt.getTime() <= Date.parse(req.now)
    ) {
      throw new DispatchStateConflictError("The claim lease has expired", ["leaseExpiresAt"]);
    }

    // — 3. Build the request from the immutable attempt and retained payload —
    let request;
    try {
      request = buildRegisterRequest({
        attempt,
        payload: outboxRow.payload ?? undefined,
        idempotencyKey: outboxRow.idempotencyKey,
      });
    } catch (e) {
      if (e instanceof RegisterRequestBuildError) {
        throw new RegisterRequestContractFailureError(
          e.issues.map((i) => `${i.rule}: ${i.reason}`),
        );
      }
      throw e;
    }

    // — 4. Exactly one transport invocation —
    const transport: Result = await this.transport.sendRegisterRequest(
      request,
      req.endpoint satisfies Endpoint,
    );

    // — 5-7. Record the consequence —
    //
    // `transmitted` already encodes the conservative reading: it is true for
    // AMBIGUOUS_DELIVERY, so an uncertain send still closes the door on reusing
    // this attempt.
    let attemptDispatched = false;
    if (transport.transmitted) {
      await this.attempts.markPublicationSubmissionAttemptDispatched({
        submissionAttemptId: req.submissionAttemptId,
        lockToken: req.lockToken,
        dispatchedAt: req.now,
      });
      attemptDispatched = true;
    }

    // — 8. The response is returned, never turned into a receipt here —
    return {
      ...SendPreparedAttemptResult.parse({
        transport,
        attemptDispatched,
        submissionAttemptId: req.submissionAttemptId,
      }),
      ...(transport.response !== undefined ? { registrarResponse: transport.response } : {}),
    };
  }
}
