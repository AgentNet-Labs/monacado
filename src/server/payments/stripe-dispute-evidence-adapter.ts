/**
 * The Stripe dispute evidence adapter (Phase 1.12) — SERVER ONLY.
 *
 * The first implementation of `DisputeEvidenceSubmissionPort`, which Phase 1.11
 * declared and deliberately left empty — **in TEST mode only.**
 *
 * Submission is now **authorised**: `MONACADO_REPRESENTMENT_RULING` resolves the
 * §I question 1.11 recorded as outstanding, and states that Monacado always
 * responds to a dispute attributable to one of its transactions. There is no
 * governance gate in this module any more — the question it held open has an
 * answer, so the check is gone rather than defaulted open.
 *
 * What still gates a send is capability, not permission: an operator-approved
 * preparation, a respondable dispute, an open deadline, a matching provider
 * reference, and a TEST-mode credential.
 *
 * A SEPARATE FILE from `stripe-dispute-adapter.ts` on purpose. That module is
 * intake: it verifies a signed webhook and reads. A 1.11 test asserts it contains
 * no `disputes.update`, and that assertion is still worth keeping — the module
 * that receives a provider's statement should not also be the module that answers
 * it. Splitting them keeps the intake guard true and meaningful rather than
 * trading it away.
 *
 * ## 1.11's stated technical reason for deferring was wrong, and this corrects it
 *
 * The seam recorded that *"every field that matters … is typed `string | File`
 * and needs a provider file upload."* That describes the **response** object,
 * which expands file objects on read. On the **request** object every field is a
 * plain string. Nine of them accept a *file identifier* obtainable only by
 * uploading, and those stay unreachable — but eighteen are ordinary text, and
 * several are direct projections of immutable Monacado records.
 *
 * So text-only evidence submission is possible with no object storage. What is
 * lost by deferring uploads is real and is stated in
 * `DISPUTE_EVIDENCE_FILE_STORAGE_GAP` rather than hidden: the strongest single
 * item in a card-not-present representment is the receipt as the buyer received
 * it, and it is a document field.
 *
 * ## One operation, and no way to concede
 *
 * `disputes.update`. There is no `disputes.close` behind this port and no method
 * that could reach one. Closing a dispute is an immediate, irreversible
 * acceptance of loss, and a capability that cannot be called cannot be called by
 * mistake — the same judgement that kept `refunds.cancel` off the refund port.
 *
 * ## `submit` is never omitted
 *
 * The provider's flag **defaults to true**: a call that forgets it finalises the
 * response. So finality is a required field at every layer of this phase and is
 * written explicitly on every call. This is the single most dangerous ergonomic
 * in the API being wrapped.
 *
 * ## Idempotency distinguishes requests, not disputes
 *
 * A dispute legitimately produces several distinct POSTs to one URL. A key
 * derived from the dispute alone would make a revision return the first call's
 * cached response — a 200, a plausible object, and the revision silently never
 * applied. See `dispute-evidence-idempotency.ts`, which keys on the logical
 * request instead.
 *
 * ## TEST mode is refused three times, not twice
 *
 * | Check | What it stops |
 * | --- | --- |
 * | `config.mode !== "TEST"` | a deployment configured for live mode |
 * | `resolveTestModeSecretKey` | a live credential in a "test" deployment |
 * | `dispute.livemode === true` | a live object reached with a key believed to be test |
 *
 * The third is the belt-and-braces check `1.9`'s refund adapter explicitly could
 * not make, because `Stripe.Refund` carries no `livemode`. `Stripe.Dispute` does,
 * and 1.11 already reads it on intake. It is used here for the same reason.
 *
 * ## No raw payload, ever
 *
 * The provider's error text can echo the request, and the request named a dispute
 * that names a buyer's charge. Errors are classified into the port's closed
 * vocabulary at this boundary from structured fields only, and the vendor's
 * message is discarded unread.
 */

import "../server-only";
import type Stripe from "stripe";
import {
  DisputeEvidenceSubmissionRequest,
  MONACADO_REPRESENTMENT_RULING,
  NEVER_SUBMITTED_TO_PROVIDER,
  isRetryableDisputeEvidenceFailure,
  type DisputeEvidenceSubmissionFailureCode,
  type DisputeEvidenceSubmissionPort,
  type DisputeEvidenceSubmissionResult,
} from "../../contracts/marketplace/dispute-evidence";
import { getStripeClient } from "./stripe-client";
import {
  readStripeRuntimeConfig,
  resolveTestModeSecretKey,
  type Env,
  type StripeRuntimeConfig,
} from "./stripe-runtime-config";

/** The provider's combined character budget across every evidence field. */
export const STRIPE_EVIDENCE_COMBINED_CHARACTER_LIMIT = 150_000;
/** The per-field budget the provider documents for its long text fields. */
export const STRIPE_EVIDENCE_FIELD_CHARACTER_LIMIT = 20_000;

/**
 * The provider statuses that still permit a response.
 *
 * Gated on Monacado's own normalised `NEEDS_RESPONSE` rather than on the wider
 * "not terminal" set, which includes `UNDER_REVIEW` — a dispute already answered.
 * Submitting into that spends a submission that no longer exists.
 */
const RESPONDABLE_PROVIDER_STATUSES: readonly string[] = Object.freeze([
  "needs_response",
  "warning_needs_response",
]);

/**
 * The two Stripe dispute operations Monacado performs.
 *
 * One read and one write, so a test injects a double and **no network call occurs
 * anywhere in the test suite**. There is deliberately no `close`.
 */
export interface StripeDisputeEvidenceClient {
  retrieveDispute(id: string): Promise<Stripe.Dispute>;
  updateDispute(
    id: string,
    params: Stripe.DisputeUpdateParams,
    options?: { idempotencyKey?: string },
  ): Promise<Stripe.Dispute>;
}

/** The live client, built from the same test-mode-only credential path. */
export function createStripeDisputeEvidenceClient(
  config: StripeRuntimeConfig,
  env: Env = process.env,
): StripeDisputeEvidenceClient {
  /* Resolved here as well as inside `getStripeClient` so a live credential is
     refused before an SDK object exists, not merely before a call is made. */
  resolveTestModeSecretKey(config.apiKeyEnvVar, env);
  const client = getStripeClient(config, env);
  return {
    retrieveDispute: (id) => client.disputes.retrieve(id),
    updateDispute: (id, params, options) => client.disputes.update(id, params, options ?? {}),
  };
}

/**
 * Classify a provider failure without keeping a word of it.
 *
 * Reads only the SDK's structured fields — never `message`, which can echo the
 * request. An unrecognised shape is `UNSPECIFIED_FAILURE` and therefore
 * transient, which is the conservative reading `1.9` settled on: a condition
 * nobody has classified should be retried rather than abandoned.
 */
export function classifyStripeDisputeEvidenceError(
  error: unknown,
): DisputeEvidenceSubmissionFailureCode {
  const candidate = error as { type?: unknown; code?: unknown; statusCode?: unknown } | null;
  const type = typeof candidate?.type === "string" ? candidate.type : "";
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const status = typeof candidate?.statusCode === "number" ? candidate.statusCode : 0;

  if (type === "StripeConnectionError" || type === "StripeAPIError") return "PROVIDER_UNAVAILABLE";
  if (status === 429 || status >= 500) return "PROVIDER_UNAVAILABLE";
  if (type === "StripeAuthenticationError" || type === "StripePermissionError") {
    return "EVIDENCE_REJECTED";
  }
  if (code === "resource_missing") return "DISPUTE_NOT_FOUND";
  if (type === "StripeInvalidRequestError" || (status >= 400 && status < 500)) {
    return "EVIDENCE_REJECTED";
  }
  return "UNSPECIFIED_FAILURE";
}

function refused(
  failureCode: DisputeEvidenceSubmissionFailureCode,
): DisputeEvidenceSubmissionResult {
  return { outcome: "REFUSED", failureCode, retryable: isRetryableDisputeEvidenceFailure(failureCode) };
}

export interface StripeDisputeEvidenceAdapterDeps {
  env?: Env;
  config?: StripeRuntimeConfig;
  client?: StripeDisputeEvidenceClient;
  /** Supplied so a submission instant is the caller's, never a clock read here. */
  now?: () => Date;
}

/**
 * Build the adapter.
 *
 * Every refusal is a normalised **result**, never a throw: a submission failure
 * leaves a durable preparation row that an operator can see and, where the code
 * is transient, retry. Throwing would make the failure the caller's problem to
 * classify, which is how vendor text escapes.
 */
export function createStripeDisputeEvidenceAdapter(
  deps: StripeDisputeEvidenceAdapterDeps = {},
): DisputeEvidenceSubmissionPort {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  let client: StripeDisputeEvidenceClient | undefined = deps.client;

  return {
    async submitEvidence(rawRequest): Promise<DisputeEvidenceSubmissionResult> {
      /* Parsed into a normalised REFUSAL rather than allowed to throw.
       *
       * The schema is the outermost guard on what may reach a provider: it
       * rejects any field outside the submittable set — every cardholder field
       * included — and anything past the per-field character budget. A caller
       * that passed one should get a bounded code back, not a validation error
       * carrying the offending payload in its message. */
      let request: DisputeEvidenceSubmissionRequest;
      try {
        request = DisputeEvidenceSubmissionRequest.parse(rawRequest);
      } catch {
        const candidate = rawRequest as { evidence?: Record<string, unknown> } | null;
        const values = Object.values(candidate?.evidence ?? {});
        const oversized = values.some(
          (value) => typeof value === "string" && value.length > STRIPE_EVIDENCE_FIELD_CHARACTER_LIMIT,
        );
        return refused(oversized ? "EVIDENCE_TOO_LARGE" : "EVIDENCE_REJECTED");
      }

      /* An empty package is refused before the provider is troubled. Updating the
         evidence hash with nothing in it would still count as a response, and
         would spend the one submission on silence. */
      const fields = Object.entries(request.evidence).filter(
        ([, value]) => typeof value === "string" && value.length > 0,
      );
      if (fields.length === 0) return refused("EVIDENCE_EMPTY");

      /* Nothing on the never-submit list may leave, whatever a caller passed.
         The storage and capsule denylists do not govern an outbound call, so this
         is the boundary that does. */
      if (fields.some(([key]) => NEVER_SUBMITTED_TO_PROVIDER.includes(key))) {
        return refused("EVIDENCE_REJECTED");
      }

      const combined = fields.reduce((total, [, value]) => total + value.length, 0);
      if (
        combined > STRIPE_EVIDENCE_COMBINED_CHARACTER_LIMIT ||
        fields.some(([, value]) => value.length > STRIPE_EVIDENCE_FIELD_CHARACTER_LIMIT)
      ) {
        return refused("EVIDENCE_TOO_LARGE");
      }

      if (client === undefined) {
        try {
          const config = deps.config ?? readStripeRuntimeConfig(env);
          if (config.mode !== "TEST") return refused("PROVIDER_MODE_NOT_PERMITTED");
          client = createStripeDisputeEvidenceClient(config, env);
        } catch {
          /* The configuration error's own message is discarded: it names
             environment variables, and a worker log is not the place to enumerate
             a deployment's credential layout. */
          return refused("PROVIDER_NOT_CONFIGURED");
        }
      }

      /* PRE-FLIGHT READ. The strongest guard this API offers: the provider's own
         submission counter. A dispute that has been answered cannot be answered
         again, and finding that out before writing costs one call and saves the
         only submission there was. */
      let current: Stripe.Dispute;
      try {
        current = await client.retrieveDispute(request.providerDisputeRef);
      } catch (error) {
        return refused(classifyStripeDisputeEvidenceError(error));
      }

      if (current.livemode === true) return refused("PROVIDER_MODE_NOT_PERMITTED");

      const details = current.evidence_details;
      if (details != null && details.submission_count >= 1) return refused("ALREADY_SUBMITTED");
      if (request.observedSubmissionCount >= 1) return refused("ALREADY_SUBMITTED");

      /* `due_by === 0` means the bank permits no response at all. It is a
         different fact from an absent deadline, and conflating them wastes the
         only window there was. */
      if (details != null && details.due_by === 0) return refused("RESPONSE_NOT_PERMITTED");
      if (details?.due_by != null && details.due_by > 0) {
        if (details.due_by * 1000 <= now().getTime()) return refused("DEADLINE_PASSED");
      }

      if (!RESPONDABLE_PROVIDER_STATUSES.includes(current.status ?? "")) {
        return refused("DISPUTE_NOT_OPEN");
      }

      let updated: Stripe.Dispute;
      try {
        updated = await client.updateDispute(
          request.providerDisputeRef,
          {
            evidence: Object.fromEntries(fields) as Stripe.DisputeUpdateParams.Evidence,
            /* ALWAYS EXPLICIT. The provider defaults this to true, so an omitted
               flag finalises the response. */
            submit: request.finalSubmission,
          },
          { idempotencyKey: request.idempotencyKey },
        );
      } catch (error) {
        return refused(classifyStripeDisputeEvidenceError(error));
      }

      if (updated.livemode === true) return refused("PROVIDER_MODE_NOT_PERMITTED");

      const after = updated.evidence_details;
      const at = now().toISOString();

      if (!request.finalSubmission) {
        return {
          outcome: "STAGED",
          provider: "STRIPE",
          providerMode: "TEST",
          providerHasEvidence: after?.has_evidence ?? false,
          providerSubmissionCount: after?.submission_count ?? 0,
          stagedAt: at,
        };
      }

      /* POST-FLIGHT ASSERTION. `has_evidence` reports STAGING, not submission, so
         it proves nothing about finality. The counter moving is the only proof
         the response reached the bank; if it did not move, the submission did not
         land, and reporting success would record a durable fact that is false. */
      const countAfter = after?.submission_count ?? 0;
      if (countAfter <= request.observedSubmissionCount) return refused("UNSPECIFIED_FAILURE");

      return {
        outcome: "SUBMITTED",
        provider: "STRIPE",
        providerMode: "TEST",
        providerSubmissionCount: countAfter,
        providerSubmittedPastDue: after?.past_due ?? false,
        submittedAt: at,
      };
    },
  };
}

export { MONACADO_REPRESENTMENT_RULING };
