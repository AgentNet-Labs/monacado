/**
 * Publication remediation contracts (Phase 0E.5.2).
 *
 * When a registration is refused, or a receipt turns out to describe something
 * else, someone has to decide what happens next. Nothing decides that
 * automatically: a **remediation** is one immutable record of a GOVERNED HUMAN
 * DECISION — who decided, what they chose, why, when, and what state the
 * publication was in at the time.
 *
 * A remediation never rewrites history. Registrar receipts stay exactly as
 * recorded, expected identifiers and hashes stay as prepared, and the capsule
 * payload is never regenerated or altered. Remediation only decides whether the
 * existing work is retried or abandoned.
 *
 * OFFLINE only: no Registrar call, no Publisher submission, no Resolver lookup,
 * no scheduler, no automatic remediation, and no reopening of a closed decision.
 *
 * Zod is the single authored source of truth; types are inferred. No passthrough,
 * `any`, or unrestricted JSON.
 */

import { z } from "zod";
import { ACTOR_ID_RE, REMEDIATION_ID_RE } from "../capsule/identity";
import {
  OutboxId,
  OutboxStatus,
  ProductPublication,
  ProductPublicationOutbox,
  PublicationId,
  ReconciliationState,
  RegistrationState,
  RemediationState,
} from "./product-publication";
import { SafeErrorCode, SafeErrorSummary } from "./safe-error-metadata";

/** Opaque identifier for one recorded remediation decision. */
export const RemediationId = z
  .string()
  .regex(REMEDIATION_ID_RE, "remediationId must be opaque (mon:rem:<opaque>)");

/**
 * Who decided. Deliberately opaque: an email address, display name, or other
 * private profile datum must never be persisted as the deciding actor. The
 * mapping from an opaque actor to a real person is an authorisation concern for
 * a later phase, not something this record carries.
 */
export const ActorId = z
  .string()
  .regex(ACTOR_ID_RE, "decidedBy must be an opaque actor id (mon:actor:<opaque>), never an email or profile");

/**
 * The two decisions available. Bounded on purpose — there is no REOPEN, no
 * FORCE_ACCEPT, and no SUPERSEDE in this phase.
 *
 *   RETRY — authorise one further registration attempt with the SAME capsule.
 *   CLOSE — accept that this publication will not be registered.
 */
export const REMEDIATION_ACTIONS = ["RETRY", "CLOSE"] as const;
export const RemediationAction = z.enum(REMEDIATION_ACTIONS);
export type RemediationAction = z.infer<typeof RemediationAction>;

// — Input —

/**
 * Input to one remediation decision. Every timestamp is supplied explicitly —
 * no clock is read inside the service, matching the discipline used throughout
 * the Product phases.
 */
export const RemediateProductPublicationInput = z
  .strictObject({
    publicationId: PublicationId,
    remediationId: RemediationId,
    action: RemediationAction,
    /** Bounded, sanitised justification code. */
    reasonCode: SafeErrorCode,
    /** Optional bounded, sanitised human note. */
    reasonSummary: SafeErrorSummary.optional(),
    decidedBy: ActorId,
    decidedAt: z.iso.datetime(),
    /** Required for RETRY: when the re-authorised item becomes eligible again. */
    retryAvailableAt: z.iso.datetime().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === "RETRY" && input.retryAvailableAt === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["retryAvailableAt"],
        message: "RETRY requires an explicit retryAvailableAt",
      });
    }
    if (input.action === "CLOSE" && input.retryAvailableAt !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["retryAvailableAt"],
        message: "CLOSE must not supply retryAvailableAt",
      });
    }
  });
export type RemediateProductPublicationInput = z.infer<typeof RemediateProductPublicationInput>;

// — Persisted remediation —

const RemediationCoreFields = {
  remediationId: RemediationId,
  publicationId: PublicationId,
  outboxId: OutboxId.optional(),
  remediationAction: RemediationAction,
  /** The state decided against — audit only, never rewritten. */
  priorRegistrationState: RegistrationState,
  priorReconciliationState: ReconciliationState,
  priorOutboxStatus: OutboxStatus,
  priorRemediationState: RemediationState,
  reasonCode: SafeErrorCode,
  reasonSummary: SafeErrorSummary.optional(),
  decidedBy: ActorId,
  decidedAt: z.iso.datetime(),
  retryAvailableAt: z.iso.datetime().optional(),
} as const;

/**
 * A validated, persisted remediation decision. Immutable once written: there is
 * no update operation and the row carries no `updatedAt`. It holds no receipt
 * contents and no capsule body.
 */
export const PublicationRemediation = z.strictObject({
  id: z.string().min(1),
  ...RemediationCoreFields,
  createdAt: z.iso.datetime(),
});
export type PublicationRemediation = z.infer<typeof PublicationRemediation>;

/** The validated remediation before persistence assigns the row id and timestamp. */
export const PublicationRemediationWrite = z.strictObject(RemediationCoreFields);
export type PublicationRemediationWrite = z.infer<typeof PublicationRemediationWrite>;

// — Result —

export const RemediationResult = z.strictObject({
  publication: ProductPublication,
  outbox: ProductPublicationOutbox,
  remediation: PublicationRemediation,
  remediationState: RemediationState,
  /** True when this call returned an existing identical decision (idempotent replay). */
  alreadyRemediated: z.boolean(),
});
export type RemediationResult = z.infer<typeof RemediationResult>;

// — State rules —

/** States from which a remediation decision may be taken. */
export const REMEDIABLE_STATES: readonly RemediationState[] = ["REQUIRED"];

/** States in which no further remediation is permitted in this phase. */
export const TERMINAL_REMEDIATION_STATES: readonly RemediationState[] = ["CLOSED", "RESOLVED"];

/** True when a governed decision is currently open for this publication. */
export function requiresRemediation(remediationState: RemediationState): boolean {
  return REMEDIABLE_STATES.includes(remediationState);
}

/**
 * Fields that must agree for a repeated `remediationId` to be an idempotent
 * replay rather than a conflict.
 */
export const REMEDIATION_IDENTITY_FIELDS = [
  "publicationId",
  "remediationAction",
  "reasonCode",
  "reasonSummary",
  "decidedBy",
  "decidedAt",
  "retryAvailableAt",
] as const;
export type RemediationIdentityField = (typeof REMEDIATION_IDENTITY_FIELDS)[number];

// — Cross-entity consistency —

/**
 * Cross-entity invariants that no single row can express. A publication and its
 * outbox item must agree about what remediation has decided:
 *
 *   RETRY_AUTHORIZED — a retry was authorised, so the work item must be waiting
 *                      to be re-claimed AND must still hold the capsule body.
 *   CLOSED           — nobody is working on it, so no claim ownership may remain.
 *   RESOLVED         — settled by a matching acceptance, so the registration must
 *                      say so and the transient body must be gone.
 *
 * Returns issue strings (empty when consistent). Field names only — never hashes,
 * tokens, or payload contents.
 */
export function publicationRemediationConsistencyIssues(
  publication: {
    remediationState: string;
    registrationState: string;
    reconciliationState: string;
  },
  outbox: { outboxStatus: string; payload?: unknown },
): string[] {
  const issues: string[] = [];
  const payloadRetained = outbox.payload !== undefined;

  switch (publication.remediationState) {
    case "RETRY_AUTHORIZED":
      if (outbox.outboxStatus !== "RETRYABLE") {
        issues.push("remediationState: RETRY_AUTHORIZED requires outboxStatus RETRYABLE");
      }
      if (!payloadRetained) {
        issues.push("remediationState: RETRY_AUTHORIZED requires a retained payload");
      }
      break;
    case "CLOSED":
      if (outbox.outboxStatus === "PROCESSING") {
        issues.push("remediationState: CLOSED must not leave a claimed (PROCESSING) work item");
      }
      break;
    case "RESOLVED":
      if (
        publication.registrationState !== "ACCEPTED" ||
        publication.reconciliationState !== "MATCHED"
      ) {
        issues.push("remediationState: RESOLVED requires registration ACCEPTED and reconciliation MATCHED");
      }
      if (payloadRetained) {
        issues.push("remediationState: RESOLVED requires the capsule payload to be disposed");
      }
      break;
    default:
      break;
  }
  return issues;
}
