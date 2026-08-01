/**
 * Transactional truth and capsule projection invariants (Phase 0A.2).
 *
 * Monacado conducts commerce through an **authoritative transactional platform**
 * and publishes **deterministic capsule projections of selected transactional
 * truth**. This module is that sentence made executable.
 *
 * Five properties shape everything below:
 *
 *   1. **The database is the sole system of record.** Every business fact,
 *      authority, lifecycle state, and piece of audit evidence lives in an
 *      authoritative relational record. A capsule is a *projection of* such a
 *      record and is never one.
 *
 *   2. **Projection runs one way.** Authoritative record → immutable source
 *      version → projection mapping → capsule projection → registration. The
 *      reverse is denied by name, not left undefined: an undefined direction is
 *      one someone eventually implements.
 *
 *   3. **Capsules do not create provenance.** Provenance originates in source
 *      records, source versions, authority records, audit records, mapping
 *      versions, generation records, receipts, and reconciliation results. A
 *      capsule may *represent* provenance claims; representing is not
 *      establishing.
 *
 *   4. **Verification is not reconstruction.** A hash or a receipt proves that a
 *      payload was what it claimed to be. Neither can rebuild it. Only a full
 *      authoritative source snapshot plus its mapping version can.
 *
 *   5. **Retention is its own lifecycle, and three separate things.** *Where* a
 *      payload is stored, *whether* it is under legal hold, and *whether* it may
 *      be destroyed are three independent questions. Storage location is a
 *      lifecycle; legal hold is an orthogonal flag; purge eligibility is a
 *      computed decision and never a stored state. All three are independent of
 *      business state and of whether the capsule was published.
 *
 * Pure data and pure decisions. No database, no clock (every instant-derived fact
 * arrives as supplied data), no environment read, no randomness, no network, and
 * no arbitrary metadata anywhere in a schema.
 */

import { z } from "zod";

// — What kind of thing is this? —

/**
 * The artifact vocabulary this architecture reasons about.
 *
 * Closed, and deliberately covering both sides of the boundary, because the
 * interesting questions are all about which side a given artifact is on.
 */
export const ARTIFACT_KINDS = [
  /** A live authoritative relational record — the current business truth. */
  "AUTHORITATIVE_SOURCE_MODEL",
  /** One immutable historical snapshot of that record. */
  "AUTHORITATIVE_SOURCE_VERSION",
  /** The versioned rules that turn a source version into a projection shape. */
  "PROJECTION_MAPPING",
  /** The schema a capsule projection must satisfy. */
  "CAPSULE_PROJECTION_SHAPE",
  /** One generated, canonicalized, hashed capsule. */
  "CAPSULE_PROJECTION",
  /** An authority or authorization record. */
  "AUTHORITY_RECORD",
  /** An audit record of a governed decision. */
  "AUDIT_RECORD",
  /** A record that one projection was generated from one source version. */
  "GENERATION_RECORD",
  /** A Registrar-issued result for one submission. */
  "PUBLICATION_RECEIPT",
  /** The result of comparing a receipt to the publication it claims to answer. */
  "RECONCILIATION_RESULT",
  /** A copy of a capsule body held by the Registrar or a resolver. */
  "REGISTRAR_COPY",
] as const;
export const ArtifactKind = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/**
 * Which side of the boundary an artifact sits on.
 *
 * `EVIDENCE` is a third role, not a hedge: a receipt is authoritative about *what
 * the Registrar answered* and authoritative about nothing else. Collapsing it
 * into `AUTHORITATIVE_SOURCE` is exactly how a Registrar response becomes
 * business truth.
 */
export const ARTIFACT_ROLES = ["AUTHORITATIVE_SOURCE", "EVIDENCE", "DERIVED_PROJECTION"] as const;
export const ArtifactRole = z.enum(ARTIFACT_ROLES);
export type ArtifactRole = z.infer<typeof ArtifactRole>;

export const ARTIFACT_ROLE_BY_KIND: Record<ArtifactKind, ArtifactRole> = Object.freeze({
  AUTHORITATIVE_SOURCE_MODEL: "AUTHORITATIVE_SOURCE",
  AUTHORITATIVE_SOURCE_VERSION: "AUTHORITATIVE_SOURCE",
  AUTHORITY_RECORD: "AUTHORITATIVE_SOURCE",
  PROJECTION_MAPPING: "AUTHORITATIVE_SOURCE",
  AUDIT_RECORD: "EVIDENCE",
  GENERATION_RECORD: "EVIDENCE",
  PUBLICATION_RECEIPT: "EVIDENCE",
  RECONCILIATION_RESULT: "EVIDENCE",
  CAPSULE_PROJECTION_SHAPE: "DERIVED_PROJECTION",
  CAPSULE_PROJECTION: "DERIVED_PROJECTION",
  REGISTRAR_COPY: "DERIVED_PROJECTION",
});

export function artifactRole(kind: ArtifactKind): ArtifactRole {
  return ARTIFACT_ROLE_BY_KIND[kind];
}

/** The single system of record. A constant, so no caller has to decide. */
export const SYSTEM_OF_RECORD = "AUTHORITATIVE_DATABASE" as const;

/**
 * Artifact kinds that may originate provenance.
 *
 * A capsule projection is absent, and its absence is the point: a capsule may
 * carry provenance *claims* that were established elsewhere.
 */
export const PROVENANCE_ORIGIN_KINDS = [
  "AUTHORITATIVE_SOURCE_MODEL",
  "AUTHORITATIVE_SOURCE_VERSION",
  "AUTHORITY_RECORD",
  "AUDIT_RECORD",
  "PROJECTION_MAPPING",
  "GENERATION_RECORD",
  "PUBLICATION_RECEIPT",
  "RECONCILIATION_RESULT",
] as const satisfies readonly ArtifactKind[];

export function isProvenanceOrigin(kind: ArtifactKind): boolean {
  return (PROVENANCE_ORIGIN_KINDS as readonly ArtifactKind[]).includes(kind);
}

/**
 * Whether a capsule projection establishes provenance. Permanently `false`.
 *
 * Written as a function rather than a comment so the claim is executable, and so
 * changing it is a reviewable edit rather than a drift in someone's mental model.
 */
export function capsuleEstablishesProvenance(): false {
  return false;
}

// — Decisions —

export const ARCHITECTURE_INVARIANTS = [
  "projection-direction",
  "authoritative-write-origin",
  "retention-transition",
  "archive-eligibility",
  "payload-purge-eligibility",
  "publication-replay-source",
] as const;
export const ArchitectureInvariant = z.enum(ARCHITECTURE_INVARIANTS);
export type ArchitectureInvariant = z.infer<typeof ArchitectureInvariant>;

/**
 * The closed denial vocabulary.
 *
 * Classifications only. No path, payload, hash, identifier value, provider
 * message, or free text can appear in one.
 */
export const ARCHITECTURE_REASON_CODES = [
  /** The write would flow capsule → authoritative record. */
  "CAPSULE_TO_SOURCE_WRITE_FORBIDDEN",
  /** The proposed origin of an authoritative write is not an authoritative record. */
  "ORIGIN_IS_NOT_AUTHORITATIVE",
  /** A Registrar or resolver copy was offered as authoritative. */
  "REGISTRAR_COPY_IS_NOT_AUTHORITATIVE",
  /** The retention transition is not in the table. */
  "RETENTION_TRANSITION_NOT_PERMITTED",
  /** The source version is still the current one. */
  "SOURCE_VERSION_IS_CURRENT",
  /** A live transaction still needs hot access. */
  "HOT_ACCESS_STILL_REQUIRED",
  /** The archive destination is unavailable. */
  "ARCHIVE_DESTINATION_UNAVAILABLE",
  /** Publication preparation is not durable yet. */
  "PUBLICATION_PREPARATION_NOT_DURABLE",
  /** A legal hold is in force. */
  "LEGAL_HOLD_IN_FORCE",
  /** A dispute or refund window is open. */
  "DISPUTE_OR_REFUND_WINDOW_OPEN",
  /** Financial, tax, or compliance retention applies. */
  "FINANCIAL_RETENTION_APPLIES",
  /** Publication or reconciliation has not completed. */
  "PUBLICATION_RECONCILIATION_INCOMPLETE",
  /** No verified archive copy of the authoritative snapshot exists. */
  "NO_VERIFIED_ARCHIVE_COPY",
  /** Deterministic reconstruction is still required by policy. */
  "RECONSTRUCTION_STILL_REQUIRED",
  /** No data-class policy permits verification-only retention. */
  "VERIFICATION_ONLY_RETENTION_NOT_AUTHORIZED",
  /** Destruction was proposed for a payload that is not archived. */
  "RETENTION_STATE_NOT_ARCHIVED",
  /** The replay source is not the obligation's exact source version. */
  "SOURCE_VERSION_MISMATCH",
  /** The entity's current record was offered in place of the bound version. */
  "CURRENT_RECORD_SUBSTITUTION_FORBIDDEN",
  /** The prepared canonical projection does not match the obligation's. */
  "PREPARED_PROJECTION_MISMATCH",
  /** Neither an exact source version nor a prepared projection was supplied. */
  "NO_EXACT_REPLAY_BASIS_SUPPLIED",
] as const;
export const ArchitectureReasonCode = z.enum(ARCHITECTURE_REASON_CODES);
export type ArchitectureReasonCode = z.infer<typeof ArchitectureReasonCode>;

export const ARCHITECTURE_DECISIONS = ["ALLOW", "DENY"] as const;
export const ArchitectureDecisionOutcome = z.enum(ARCHITECTURE_DECISIONS);
export type ArchitectureDecisionOutcome = z.infer<typeof ArchitectureDecisionOutcome>;

/** `ALLOW` carries no reasons; `DENY` carries at least one. */
export const ArchitectureDecision = z
  .strictObject({
    invariant: ArchitectureInvariant,
    decision: ArchitectureDecisionOutcome,
    reasonCodes: z.array(ArchitectureReasonCode).max(ARCHITECTURE_REASON_CODES.length),
  })
  .refine(
    (d) => (d.decision === "ALLOW" ? d.reasonCodes.length === 0 : d.reasonCodes.length > 0),
    "ALLOW carries no reason codes; DENY carries at least one",
  );
export type ArchitectureDecision = z.infer<typeof ArchitectureDecision>;

function allow(invariant: ArchitectureInvariant): ArchitectureDecision {
  return { invariant, decision: "ALLOW", reasonCodes: [] };
}

function deny(
  invariant: ArchitectureInvariant,
  ...reasonCodes: ArchitectureReasonCode[]
): ArchitectureDecision {
  return { invariant, decision: "DENY", reasonCodes };
}

export function isPermitted(decision: ArchitectureDecision): boolean {
  return decision.decision === "ALLOW";
}

// — Projection direction —

/**
 * The only permitted flow, written as an ordered pipeline so a future stage is
 * inserted deliberately rather than assumed.
 */
export const PROJECTION_PIPELINE = [
  "AUTHORITATIVE_SOURCE_MODEL",
  "AUTHORITATIVE_SOURCE_VERSION",
  "PROJECTION_MAPPING",
  "CAPSULE_PROJECTION_SHAPE",
  "CAPSULE_PROJECTION",
] as const satisfies readonly ArtifactKind[];

export const ProjectionDirectionRequest = z.strictObject({
  from: ArtifactKind,
  to: ArtifactKind,
});
export type ProjectionDirectionRequest = z.infer<typeof ProjectionDirectionRequest>;

/**
 * May data flow from `from` to `to`?
 *
 * Permitted only when it moves forward along the pipeline. Any flow whose
 * destination is an authoritative record and whose origin is a projection is
 * denied by name.
 */
export function evaluateProjectionDirection(
  request: ProjectionDirectionRequest,
): ArchitectureDecision {
  const invariant = "projection-direction" as const;
  const { from, to } = request;

  if (artifactRole(to) === "AUTHORITATIVE_SOURCE") {
    if (artifactRole(from) === "DERIVED_PROJECTION") {
      return deny(invariant, "CAPSULE_TO_SOURCE_WRITE_FORBIDDEN");
    }
    if (artifactRole(from) === "EVIDENCE") {
      return deny(invariant, "ORIGIN_IS_NOT_AUTHORITATIVE");
    }
  }

  const fromIndex = (PROJECTION_PIPELINE as readonly ArtifactKind[]).indexOf(from);
  const toIndex = (PROJECTION_PIPELINE as readonly ArtifactKind[]).indexOf(to);
  if (fromIndex >= 0 && toIndex >= 0 && toIndex <= fromIndex) {
    return deny(invariant, "CAPSULE_TO_SOURCE_WRITE_FORBIDDEN");
  }
  return allow(invariant);
}

/**
 * What is being offered as the basis for writing an authoritative record.
 *
 * `writesAuthoritativeRecord` is explicit rather than inferred: recording a
 * receipt is a legitimate evidence write, and the question here is only whether
 * *business truth* may be changed on this basis.
 */
export const AuthoritativeWriteRequest = z.strictObject({
  originKind: ArtifactKind,
  writesAuthoritativeRecord: z.boolean(),
});
export type AuthoritativeWriteRequest = z.infer<typeof AuthoritativeWriteRequest>;

/**
 * May this origin be the basis of an authoritative write?
 *
 * Only an authoritative record may. A capsule projection may not; a Registrar
 * copy may not, and is called out separately because "the Registrar has it, so it
 * must be true" is the specific mistake this refuses.
 */
export function canWriteAuthoritativeRecord(
  request: AuthoritativeWriteRequest,
): ArchitectureDecision {
  const invariant = "authoritative-write-origin" as const;
  if (!request.writesAuthoritativeRecord) return allow(invariant);

  switch (artifactRole(request.originKind)) {
    case "AUTHORITATIVE_SOURCE":
      return allow(invariant);
    case "DERIVED_PROJECTION":
      return request.originKind === "REGISTRAR_COPY"
        ? deny(invariant, "REGISTRAR_COPY_IS_NOT_AUTHORITATIVE")
        : deny(invariant, "CAPSULE_TO_SOURCE_WRITE_FORBIDDEN");
    default:
      return deny(invariant, "ORIGIN_IS_NOT_AUTHORITATIVE");
  }
}

// — Retention storage lifecycle —

/**
 * Where the authoritative payload physically is, and whether it still exists.
 *
 * **This lifecycle describes location and disposition only.** It deliberately
 * excludes both legal hold and purge eligibility, which were previously —
 * wrongly — members of it:
 *
 *   - **Legal hold is orthogonal.** A hold can apply to hot, pending, or
 *     archived data. Modelling it as a *location* forced a held payload to
 *     forget where it actually was, and made releasing a hold a storage move.
 *   - **Purge eligibility is a computed decision, never a stored state.** A
 *     persisted `PURGE_ELIGIBLE` is a stale answer waiting to be acted on after
 *     the facts behind it changed — a dispute opened, a hold arrived — which is
 *     precisely how data gets destroyed that should not have been.
 *
 * Also disjoint from every business and publication vocabulary in the
 * repository: no `ACTIVE`, no `PUBLISHED`, no `DRAFT`. A shared member would
 * invite the inference that publication state decides storage state.
 */
export const RETENTION_STORAGE_STATES = ["HOT", "ARCHIVE_PENDING", "ARCHIVED", "PURGED"] as const;
export const RetentionStorageState = z.enum(RETENTION_STORAGE_STATES);
export type RetentionStorageState = z.infer<typeof RetentionStorageState>;

/**
 * Storage transitions.
 *
 * `ARCHIVE_PENDING → HOT` exists for **failed archival**: a copy that did not
 * verify must return to where it came from rather than being stranded mid-move.
 *
 * `ARCHIVED → HOT` keeps **archival reversible right up until destruction**, which
 * is the whole reason archiving and purging are separate acts.
 *
 * `ARCHIVED → PURGED` is structurally permitted here and is **not sufficient on
 * its own** — see `canTransitionToPurged`, which additionally requires a passing
 * purge-eligibility decision.
 *
 * `PURGED` is terminal. There is no path back, because there is nothing to come
 * back to.
 */
export const RETENTION_STORAGE_TRANSITIONS: Record<
  RetentionStorageState,
  readonly RetentionStorageState[]
> = Object.freeze({
  HOT: ["ARCHIVE_PENDING"],
  ARCHIVE_PENDING: ["ARCHIVED", "HOT"],
  ARCHIVED: ["PURGED", "HOT"],
  PURGED: [],
});

/** Every payload starts hot. */
export const INITIAL_RETENTION_STORAGE_STATE: RetentionStorageState = "HOT";

export function isValidRetentionStorageTransition(
  from: RetentionStorageState,
  to: RetentionStorageState,
): boolean {
  return RETENTION_STORAGE_TRANSITIONS[from].includes(to);
}

export function evaluateRetentionStorageTransition(
  from: RetentionStorageState,
  to: RetentionStorageState,
): ArchitectureDecision {
  const invariant = "retention-transition" as const;
  return isValidRetentionStorageTransition(from, to)
    ? allow(invariant)
    : deny(invariant, "RETENTION_TRANSITION_NOT_PERMITTED");
}

// — Legal hold —

/**
 * Whether destruction is legally blocked. Orthogonal to storage location.
 *
 * A two-member status rather than a bare boolean so it reads the same way at
 * every call site and so a future `RELEASED_PENDING_REVIEW` is an additive
 * change rather than a type change.
 */
export const LEGAL_HOLD_STATUSES = ["NONE", "ACTIVE"] as const;
export const LegalHoldStatus = z.enum(LEGAL_HOLD_STATUSES);
export type LegalHoldStatus = z.infer<typeof LegalHoldStatus>;

/** The complete retention position of one source version: where, and held or not. */
export const SourceVersionRetention = z.strictObject({
  storageState: RetentionStorageState,
  legalHold: LegalHoldStatus,
});
export type SourceVersionRetention = z.infer<typeof SourceVersionRetention>;

/**
 * A hold may attach wherever the payload still exists.
 *
 * Only `PURGED` refuses it — not as a policy judgement, but because there is
 * nothing left to preserve.
 */
export function isLegalHoldApplicable(storageState: RetentionStorageState): boolean {
  return storageState !== "PURGED";
}

/**
 * Apply or release a hold.
 *
 * Returns the storage state **untouched**, by construction: placing a hold is not
 * a storage move, and releasing one is not a storage move either. The two facts
 * travel together and change independently.
 */
export function setLegalHold(
  retention: SourceVersionRetention,
  legalHold: LegalHoldStatus,
): SourceVersionRetention {
  const parsed = SourceVersionRetention.parse(retention);
  return { storageState: parsed.storageState, legalHold };
}

// — Reconstruction versus verification —

/**
 * What is still retained for one source version.
 *
 * Booleans, not dates or blobs: this decides *capability*, and the facts that
 * decide it are supplied by the caller who holds the storage truth.
 */
export const RetainedEvidence = z.strictObject({
  /** The complete authoritative source snapshot. */
  fullSourceSnapshot: z.boolean(),
  /** The recorded projection mapping version that produced the capsule. */
  mappingVersion: z.boolean(),
  /** The capsule's content hash. */
  contentHash: z.boolean(),
  /** A Registrar publication receipt. */
  publicationReceipt: z.boolean(),
});
export type RetainedEvidence = z.infer<typeof RetainedEvidence>;

export const ReconstructionAssessment = z.strictObject({
  /** A byte-identical capsule can be rebuilt from what remains. */
  canReconstruct: z.boolean(),
  /** A capsule presented from elsewhere can be checked against what remains. */
  canVerify: z.boolean(),
});
export type ReconstructionAssessment = z.infer<typeof ReconstructionAssessment>;

/**
 * What the retained evidence can actually do.
 *
 * **A hash is never sufficient to rebuild a source version.** It is a one-way
 * digest: it can refute a candidate and can confirm one, and it cannot produce
 * one. Reconstruction requires the full snapshot *and* the mapping version that
 * shaped it — a snapshot without its mapping yields some capsule, not the
 * published one.
 */
export function assessReconstructionCapability(
  retained: RetainedEvidence,
): ReconstructionAssessment {
  const parsed = RetainedEvidence.parse(retained);
  return {
    canReconstruct: parsed.fullSourceSnapshot && parsed.mappingVersion,
    canVerify: parsed.contentHash || parsed.publicationReceipt,
  };
}

// — Archive eligibility —

export const ArchiveEligibilityRequest = z.strictObject({
  retention: SourceVersionRetention,
  /** True while this version is the entity's current one. */
  isCurrentVersion: z.boolean(),
  /** True while a live transaction still needs hot access. */
  activeTransactionRequiresHotAccess: z.boolean(),
  archiveDestinationAvailable: z.boolean(),
  /** Publication preparation for this version is durably recorded. */
  publicationPreparationDurable: z.boolean(),
});
export type ArchiveEligibilityRequest = z.infer<typeof ArchiveEligibilityRequest>;

/**
 * May this source version leave hot storage?
 *
 * A legal hold blocks the *move* as well as destruction: preserving evidence in
 * place is the conservative reading, and an archival pass that relocated held
 * data would have to answer for it later.
 *
 * Every failing condition is reported, not just the first: an operator planning
 * an archival pass needs the whole list, and returning one reason at a time turns
 * one decision into four round trips.
 */
export function evaluateArchiveEligibility(
  request: ArchiveEligibilityRequest,
): ArchitectureDecision {
  const invariant = "archive-eligibility" as const;
  const reasons: ArchitectureReasonCode[] = [];

  if (request.isCurrentVersion) reasons.push("SOURCE_VERSION_IS_CURRENT");
  if (request.activeTransactionRequiresHotAccess) reasons.push("HOT_ACCESS_STILL_REQUIRED");
  if (!request.archiveDestinationAvailable) reasons.push("ARCHIVE_DESTINATION_UNAVAILABLE");
  if (!request.publicationPreparationDurable) reasons.push("PUBLICATION_PREPARATION_NOT_DURABLE");
  if (request.retention.legalHold === "ACTIVE") reasons.push("LEGAL_HOLD_IN_FORCE");
  if (!isValidRetentionStorageTransition(request.retention.storageState, "ARCHIVE_PENDING")) {
    reasons.push("RETENTION_TRANSITION_NOT_PERMITTED");
  }

  return reasons.length === 0 ? allow(invariant) : deny(invariant, ...reasons);
}

// — Payload purge eligibility —

/**
 * What kind of copy is held in the archive.
 *
 * A capsule body and a Registrar copy are listed **so they can be refused**. Both
 * are projections of the source; neither can stand in for it, because a
 * projection carries only the claims someone approved for publication and none of
 * the private facts, authority linkage, or mapping controls the source version
 * holds.
 */
export const ARCHIVE_COPY_KINDS = [
  "NONE",
  "AUTHORITATIVE_SOURCE_SNAPSHOT",
  "CAPSULE_BODY",
  "REGISTRAR_COPY",
] as const;
export const ArchiveCopyKind = z.enum(ARCHIVE_COPY_KINDS);
export type ArchiveCopyKind = z.infer<typeof ArchiveCopyKind>;

export const PayloadPurgeRequest = z.strictObject({
  retention: SourceVersionRetention,
  isCurrentVersion: z.boolean(),
  /** A dispute or refund window is open — supplied as data, never computed here. */
  disputeOrRefundWindowOpen: z.boolean(),
  financialOrTaxRetentionApplies: z.boolean(),
  publicationAndReconciliationComplete: z.boolean(),
  /** What the archive actually holds, and whether that copy was verified. */
  archiveCopyKind: ArchiveCopyKind,
  archiveCopyVerified: z.boolean(),
  /** Policy still requires deterministic reconstruction of this version. */
  reconstructionRequired: z.boolean(),
  /**
   * An explicit data-class policy states that verification-only retention is
   * acceptable for this class. Destruction is refused without one — silence is
   * never consent to destroy a payload.
   */
  verificationOnlyRetentionAuthorized: z.boolean(),
});
export type PayloadPurgeRequest = z.infer<typeof PayloadPurgeRequest>;

/**
 * May the authoritative payload for this source version be destroyed?
 *
 * **A computed decision, never a stored state.** It is asked at the moment of
 * destruction and answered from facts as they are then — a persisted verdict
 * would outlive the dispute that opened, or the hold that arrived, after it was
 * written.
 *
 * Every gate is a refusal condition, and all failures are reported together.
 * Nothing here decides *when* — the caller supplies every time-derived fact.
 */
export function evaluatePayloadPurgeEligibility(
  request: PayloadPurgeRequest,
): ArchitectureDecision {
  const invariant = "payload-purge-eligibility" as const;
  const reasons: ArchitectureReasonCode[] = [];

  if (request.retention.legalHold === "ACTIVE") reasons.push("LEGAL_HOLD_IN_FORCE");
  /* Only an archived payload is a candidate. Hot data is destroyed from hot
     storage by nobody, and a pending archival has not been verified yet. */
  if (request.retention.storageState !== "ARCHIVED") reasons.push("RETENTION_STATE_NOT_ARCHIVED");
  if (request.isCurrentVersion) reasons.push("SOURCE_VERSION_IS_CURRENT");
  if (request.disputeOrRefundWindowOpen) reasons.push("DISPUTE_OR_REFUND_WINDOW_OPEN");
  if (request.financialOrTaxRetentionApplies) reasons.push("FINANCIAL_RETENTION_APPLIES");
  if (!request.publicationAndReconciliationComplete) {
    reasons.push("PUBLICATION_RECONCILIATION_INCOMPLETE");
  }
  /* Only a verified authoritative snapshot counts. A capsule body or a Registrar
     copy in the archive is not an archive of the source. */
  if (request.archiveCopyKind !== "AUTHORITATIVE_SOURCE_SNAPSHOT" || !request.archiveCopyVerified) {
    reasons.push("NO_VERIFIED_ARCHIVE_COPY");
  }
  if (request.reconstructionRequired) reasons.push("RECONSTRUCTION_STILL_REQUIRED");
  if (!request.verificationOnlyRetentionAuthorized) {
    reasons.push("VERIFICATION_ONLY_RETENTION_NOT_AUTHORIZED");
  }

  return reasons.length === 0 ? allow(invariant) : deny(invariant, ...reasons);
}

/**
 * May the payload actually move to `PURGED`?
 *
 * Two independent conditions, both required: the storage transition must be
 * structurally legal **and** a purge-eligibility decision must have passed. The
 * transition table alone is not authority to destroy — that is the entire reason
 * eligibility is computed rather than stored.
 */
export function canTransitionToPurged(
  storageState: RetentionStorageState,
  purgeDecision: ArchitectureDecision,
): ArchitectureDecision {
  const invariant = "payload-purge-eligibility" as const;
  const reasons: ArchitectureReasonCode[] = [];

  if (!isValidRetentionStorageTransition(storageState, "PURGED")) {
    reasons.push(
      storageState === "ARCHIVED"
        ? "RETENTION_TRANSITION_NOT_PERMITTED"
        : "RETENTION_STATE_NOT_ARCHIVED",
    );
  }
  if (purgeDecision.decision !== "ALLOW") {
    for (const code of purgeDecision.reasonCodes) {
      if (!reasons.includes(code)) reasons.push(code);
    }
  }

  return reasons.length === 0 ? allow(invariant) : deny(invariant, ...reasons);
}

// — Publication replay —

/** A bounded opaque reference. Never a payload, a URL, or a human-readable name. */
const OpaqueRef = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,191}$/, "must be an opaque bounded identifier");

/**
 * What a replay is being asked to publish.
 *
 * The obligation's own basis is named separately from what the caller offers, so
 * "publish this obligation" and "publish whatever the entity looks like now"
 * cannot be the same call.
 */
export const PublicationReplayRequest = z.strictObject({
  /** The exact source version the obligation was bound to. */
  obligationSourceVersionRef: OpaqueRef,
  /** The canonical projection hash prepared for that obligation, if any. */
  obligationPreparedProjectionHash: OpaqueRef.nullable(),
  /** The source version the caller proposes to use. */
  offeredSourceVersionRef: OpaqueRef.nullable(),
  /** The prepared canonical projection the caller proposes to use. */
  offeredPreparedProjectionHash: OpaqueRef.nullable(),
  /**
   * The caller proposes regenerating from the entity's *current* record. Named
   * explicitly so it can be refused rather than silently attempted.
   */
  regeneratedFromCurrentRecord: z.boolean(),
});
export type PublicationReplayRequest = z.infer<typeof PublicationReplayRequest>;

/**
 * May this basis satisfy that publication obligation?
 *
 * Exactly two acceptable bases: the obligation's own source version, or the
 * canonical projection already prepared for it. The entity's current record is
 * never one — an obligation records what was true when it was created, and
 * republishing today's facts under yesterday's obligation silently rewrites
 * history in the one place that is supposed to be immutable.
 */
export function evaluatePublicationReplaySource(
  request: PublicationReplayRequest,
): ArchitectureDecision {
  const invariant = "publication-replay-source" as const;

  if (request.regeneratedFromCurrentRecord) {
    return deny(invariant, "CURRENT_RECORD_SUBSTITUTION_FORBIDDEN");
  }
  if (request.offeredSourceVersionRef !== null) {
    return request.offeredSourceVersionRef === request.obligationSourceVersionRef
      ? allow(invariant)
      : deny(invariant, "SOURCE_VERSION_MISMATCH");
  }
  if (request.offeredPreparedProjectionHash !== null) {
    return request.obligationPreparedProjectionHash !== null &&
      request.offeredPreparedProjectionHash === request.obligationPreparedProjectionHash
      ? allow(invariant)
      : deny(invariant, "PREPARED_PROJECTION_MISMATCH");
  }
  return deny(invariant, "NO_EXACT_REPLAY_BASIS_SUPPLIED");
}
