/**
 * Transactional truth and capsule projection invariant tests (Phase 0A.2).
 *
 * NO DATABASE, NO NETWORK, NO CLOCK. Every decision under test is a pure function
 * of supplied data — including every time-derived fact, which arrives as a
 * boolean the caller computed rather than something read here.
 *
 * The numbered `describe` blocks correspond one-to-one with the properties Phase
 * 0A.2 was required to prove.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_REASON_CODES,
  ARTIFACT_KINDS,
  ARTIFACT_ROLE_BY_KIND,
  ArchitectureDecision,
  ArchiveEligibilityRequest,
  ArtifactKind,
  INITIAL_RETENTION_STORAGE_STATE,
  LEGAL_HOLD_STATUSES,
  LegalHoldStatus,
  PROJECTION_PIPELINE,
  PROVENANCE_ORIGIN_KINDS,
  PayloadPurgeRequest,
  ProjectionDirectionRequest,
  PublicationReplayRequest,
  RETENTION_STORAGE_STATES,
  RetainedEvidence,
  RetentionStorageState,
  SYSTEM_OF_RECORD,
  SourceVersionRetention,
  type ArchitectureReasonCode,
  artifactRole,
  assessReconstructionCapability,
  canTransitionToPurged,
  canWriteAuthoritativeRecord,
  capsuleEstablishesProvenance,
  evaluateArchiveEligibility,
  evaluatePayloadPurgeEligibility,
  evaluateProjectionDirection,
  evaluatePublicationReplaySource,
  evaluateRetentionStorageTransition,
  isLegalHoldApplicable,
  isPermitted,
  isProvenanceOrigin,
  isValidRetentionStorageTransition,
  setLegalHold,
} from "../src/contracts/architecture/transactional-truth";

// — Helpers —

function expectAllow(decision: ArchitectureDecision): void {
  ArchitectureDecision.parse(decision);
  expect(decision.decision).toBe("ALLOW");
  expect(decision.reasonCodes).toEqual([]);
}

function expectDenyIncluding(
  decision: ArchitectureDecision,
  ...codes: ArchitectureReasonCode[]
): void {
  ArchitectureDecision.parse(decision);
  expect(decision.decision).toBe("DENY");
  for (const code of codes) expect(decision.reasonCodes).toContain(code);
}

const HOT_UNHELD: SourceVersionRetention = Object.freeze({
  storageState: "HOT",
  legalHold: "NONE",
});
const ARCHIVED_UNHELD: SourceVersionRetention = Object.freeze({
  storageState: "ARCHIVED",
  legalHold: "NONE",
});

/** A source version that is fully clear to archive. */
const ARCHIVABLE: ArchiveEligibilityRequest = Object.freeze({
  retention: HOT_UNHELD,
  isCurrentVersion: false,
  activeTransactionRequiresHotAccess: false,
  archiveDestinationAvailable: true,
  publicationPreparationDurable: true,
});

/** A payload that clears every purge gate. Each test spoils exactly one. */
const PURGEABLE: PayloadPurgeRequest = Object.freeze({
  retention: ARCHIVED_UNHELD,
  isCurrentVersion: false,
  disputeOrRefundWindowOpen: false,
  financialOrTaxRetentionApplies: false,
  publicationAndReconciliationComplete: true,
  archiveCopyKind: "AUTHORITATIVE_SOURCE_SNAPSHOT",
  archiveCopyVerified: true,
  reconstructionRequired: false,
  verificationOnlyRetentionAuthorized: true,
});

const OBLIGATION_VERSION = "mon:srec:00000000000000000000000001";
const OTHER_VERSION = "mon:srec:00000000000000000000000002";
const PREPARED_HASH = "sha256:aaaa1111";

function replay(overrides: Partial<PublicationReplayRequest> = {}): PublicationReplayRequest {
  return PublicationReplayRequest.parse({
    obligationSourceVersionRef: OBLIGATION_VERSION,
    obligationPreparedProjectionHash: PREPARED_HASH,
    offeredSourceVersionRef: null,
    offeredPreparedProjectionHash: null,
    regeneratedFromCurrentRecord: false,
    ...overrides,
  });
}

// — 1 —

describe("1. the database is the sole system of record", () => {
  it("names one system of record", () => {
    expect(SYSTEM_OF_RECORD).toBe("AUTHORITATIVE_DATABASE");
  });

  it("classifies authoritative records, evidence, and projections distinctly", () => {
    expect(artifactRole("AUTHORITATIVE_SOURCE_MODEL")).toBe("AUTHORITATIVE_SOURCE");
    expect(artifactRole("AUTHORITATIVE_SOURCE_VERSION")).toBe("AUTHORITATIVE_SOURCE");
    expect(artifactRole("AUTHORITY_RECORD")).toBe("AUTHORITATIVE_SOURCE");
    expect(artifactRole("PUBLICATION_RECEIPT")).toBe("EVIDENCE");
    expect(artifactRole("CAPSULE_PROJECTION")).toBe("DERIVED_PROJECTION");
    expect(artifactRole("REGISTRAR_COPY")).toBe("DERIVED_PROJECTION");
  });

  it("assigns every artifact kind exactly one role", () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(ARTIFACT_ROLE_BY_KIND[kind]).toBeDefined();
    }
    expect(Object.keys(ARTIFACT_ROLE_BY_KIND)).toHaveLength(ARTIFACT_KINDS.length);
  });
});

// — 2 —

describe("2. a capsule's role is deterministic projection only", () => {
  it("no capsule artifact is an authoritative source", () => {
    for (const kind of ["CAPSULE_PROJECTION", "CAPSULE_PROJECTION_SHAPE", "REGISTRAR_COPY"] as const) {
      expect(artifactRole(kind)).toBe("DERIVED_PROJECTION");
    }
  });

  it("the pipeline ends at the capsule projection and starts at the authoritative record", () => {
    expect(PROJECTION_PIPELINE[0]).toBe("AUTHORITATIVE_SOURCE_MODEL");
    expect(PROJECTION_PIPELINE[PROJECTION_PIPELINE.length - 1]).toBe("CAPSULE_PROJECTION");
  });
});

// — 3 —

describe("3. database-to-capsule is the only permitted direction", () => {
  it("every forward step of the pipeline is permitted", () => {
    for (let i = 0; i < PROJECTION_PIPELINE.length - 1; i += 1) {
      expectAllow(
        evaluateProjectionDirection({ from: PROJECTION_PIPELINE[i], to: PROJECTION_PIPELINE[i + 1] }),
      );
    }
  });

  it("every backward step is refused", () => {
    for (let i = PROJECTION_PIPELINE.length - 1; i > 0; i -= 1) {
      expectDenyIncluding(
        evaluateProjectionDirection({ from: PROJECTION_PIPELINE[i], to: PROJECTION_PIPELINE[i - 1] }),
        "CAPSULE_TO_SOURCE_WRITE_FORBIDDEN",
      );
    }
  });

  it("a capsule may never flow into any authoritative record", () => {
    const authoritative: readonly ArtifactKind[] = [
      "AUTHORITATIVE_SOURCE_MODEL",
      "AUTHORITATIVE_SOURCE_VERSION",
      "AUTHORITY_RECORD",
      "PROJECTION_MAPPING",
    ];
    for (const to of authoritative) {
      for (const from of ["CAPSULE_PROJECTION", "REGISTRAR_COPY"] as const) {
        expectDenyIncluding(
          evaluateProjectionDirection({ from, to }),
          "CAPSULE_TO_SOURCE_WRITE_FORBIDDEN",
        );
      }
    }
  });

  it("evidence may not flow into an authoritative record either", () => {
    expectDenyIncluding(
      evaluateProjectionDirection({ from: "PUBLICATION_RECEIPT", to: "AUTHORITATIVE_SOURCE_MODEL" }),
      "ORIGIN_IS_NOT_AUTHORITATIVE",
    );
  });

  it("an authoritative record may produce evidence", () => {
    expectAllow(
      evaluateProjectionDirection({ from: "AUTHORITATIVE_SOURCE_VERSION", to: "GENERATION_RECORD" }),
    );
  });
});

// — 4 —

describe("4. capsule-derived authoritative writes are denied", () => {
  it("a capsule projection cannot author business truth", () => {
    expectDenyIncluding(
      canWriteAuthoritativeRecord({
        originKind: "CAPSULE_PROJECTION",
        writesAuthoritativeRecord: true,
      }),
      "CAPSULE_TO_SOURCE_WRITE_FORBIDDEN",
    );
  });

  it("a Registrar copy is refused by name", () => {
    expectDenyIncluding(
      canWriteAuthoritativeRecord({ originKind: "REGISTRAR_COPY", writesAuthoritativeRecord: true }),
      "REGISTRAR_COPY_IS_NOT_AUTHORITATIVE",
    );
  });

  it("a receipt may be recorded as evidence but may not change business truth", () => {
    expectAllow(
      canWriteAuthoritativeRecord({
        originKind: "PUBLICATION_RECEIPT",
        writesAuthoritativeRecord: false,
      }),
    );
    expectDenyIncluding(
      canWriteAuthoritativeRecord({
        originKind: "PUBLICATION_RECEIPT",
        writesAuthoritativeRecord: true,
      }),
      "ORIGIN_IS_NOT_AUTHORITATIVE",
    );
  });

  it("an authoritative record may write an authoritative record", () => {
    expectAllow(
      canWriteAuthoritativeRecord({
        originKind: "AUTHORITATIVE_SOURCE_MODEL",
        writesAuthoritativeRecord: true,
      }),
    );
  });
});

// — 5 —

describe("5. provenance originates outside the capsule", () => {
  it("a capsule projection is not a provenance origin", () => {
    expect(isProvenanceOrigin("CAPSULE_PROJECTION")).toBe(false);
    expect(isProvenanceOrigin("CAPSULE_PROJECTION_SHAPE")).toBe(false);
    expect(isProvenanceOrigin("REGISTRAR_COPY")).toBe(false);
    expect(capsuleEstablishesProvenance()).toBe(false);
  });

  it("source records, authority, audit, mapping, generation, receipts, and reconciliation are", () => {
    for (const kind of [
      "AUTHORITATIVE_SOURCE_MODEL",
      "AUTHORITATIVE_SOURCE_VERSION",
      "AUTHORITY_RECORD",
      "AUDIT_RECORD",
      "PROJECTION_MAPPING",
      "GENERATION_RECORD",
      "PUBLICATION_RECEIPT",
      "RECONCILIATION_RESULT",
    ] as const) {
      expect(isProvenanceOrigin(kind)).toBe(true);
    }
    expect(PROVENANCE_ORIGIN_KINDS).toHaveLength(8);
  });
});

// — 6 —

describe("6. retention storage state and legal hold are separate concepts", () => {
  it("the storage vocabulary describes location and disposition only", () => {
    expect(RETENTION_STORAGE_STATES).toEqual(["HOT", "ARCHIVE_PENDING", "ARCHIVED", "PURGED"]);
    /* Neither a hold nor an eligibility verdict is a place a payload can be. */
    expect(RetentionStorageState.safeParse("LEGAL_HOLD").success).toBe(false);
    expect(RetentionStorageState.safeParse("PURGE_ELIGIBLE").success).toBe(false);
  });

  it("the two facts travel together and change independently", () => {
    expect(SourceVersionRetention.safeParse(HOT_UNHELD).success).toBe(true);
    expect(LEGAL_HOLD_STATUSES).toEqual(["NONE", "ACTIVE"]);
    expect(LegalHoldStatus.safeParse("ARCHIVED").success).toBe(false);
  });

  it("shares no member with any business or publication vocabulary", () => {
    const businessish = [
      "DRAFT",
      "ACTIVE",
      "PROFILE_COMPLETE",
      "UNDER_REVIEW",
      "SUSPENDED",
      "CLOSED",
      "PENDING",
      "COMPLETED",
      "PUBLISHED",
      "REGISTERED",
      "ACCEPTED",
      "REJECTED",
      "REVOKED",
      "DEAD_LETTER",
    ];
    for (const state of RETENTION_STORAGE_STATES) {
      expect(businessish).not.toContain(state);
    }
  });

  it("starts hot and moves only through the table", () => {
    expect(INITIAL_RETENTION_STORAGE_STATE).toBe("HOT");
    expect(isValidRetentionStorageTransition("HOT", "ARCHIVE_PENDING")).toBe(true);
    expect(isValidRetentionStorageTransition("ARCHIVE_PENDING", "ARCHIVED")).toBe(true);
    expect(isValidRetentionStorageTransition("HOT", "ARCHIVED")).toBe(false);
    expectDenyIncluding(
      evaluateRetentionStorageTransition("HOT", "PURGED"),
      "RETENTION_TRANSITION_NOT_PERMITTED",
    );
  });

  it("failed archival returns to hot, and archival stays reversible until destruction", () => {
    expect(isValidRetentionStorageTransition("ARCHIVE_PENDING", "HOT")).toBe(true);
    expect(isValidRetentionStorageTransition("ARCHIVED", "HOT")).toBe(true);
  });

  it("PURGED is terminal", () => {
    for (const to of RETENTION_STORAGE_STATES) {
      expect(isValidRetentionStorageTransition("PURGED", to)).toBe(false);
    }
  });
});

// — 6b —

describe("6b. legal hold is orthogonal to storage state", () => {
  it("applies to hot data", () => {
    const held = setLegalHold(HOT_UNHELD, "ACTIVE");
    expect(held).toEqual({ storageState: "HOT", legalHold: "ACTIVE" });
    expect(isLegalHoldApplicable("HOT")).toBe(true);
  });

  it("applies to pending and archived data", () => {
    expect(isLegalHoldApplicable("ARCHIVE_PENDING")).toBe(true);
    expect(setLegalHold(ARCHIVED_UNHELD, "ACTIVE")).toEqual({
      storageState: "ARCHIVED",
      legalHold: "ACTIVE",
    });
  });

  it("activating a hold never moves the payload", () => {
    for (const storageState of ["HOT", "ARCHIVE_PENDING", "ARCHIVED"] as const) {
      const before = SourceVersionRetention.parse({ storageState, legalHold: "NONE" });
      expect(setLegalHold(before, "ACTIVE").storageState).toBe(storageState);
    }
  });

  it("nothing is left to hold once a payload is purged", () => {
    expect(isLegalHoldApplicable("PURGED")).toBe(false);
  });

  it("releasing a hold does not by itself authorize destruction", () => {
    /* A held, still-hot payload: releasing the hold leaves it hot, and hot data
       is not purgeable. Release and authorize-destruction stay two decisions. */
    const held = SourceVersionRetention.parse({ storageState: "HOT", legalHold: "ACTIVE" });
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({ ...PURGEABLE, retention: held }),
      "LEGAL_HOLD_IN_FORCE",
      "RETENTION_STATE_NOT_ARCHIVED",
    );
    const released = setLegalHold(held, "NONE");
    expect(released.storageState).toBe("HOT");
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({ ...PURGEABLE, retention: released }),
      "RETENTION_STATE_NOT_ARCHIVED",
    );
  });

  it("a released hold on archived data still faces every other gate", () => {
    const released = setLegalHold(
      SourceVersionRetention.parse({ storageState: "ARCHIVED", legalHold: "ACTIVE" }),
      "NONE",
    );
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({
        ...PURGEABLE,
        retention: released,
        disputeOrRefundWindowOpen: true,
      }),
      "DISPUTE_OR_REFUND_WINDOW_OPEN",
    );
  });
});

// — 6c —

describe("6c. purge eligibility is a computed decision, not a retention state", () => {
  it("no storage state means 'eligible'", () => {
    expect(RETENTION_STORAGE_STATES).not.toContain("PURGE_ELIGIBLE");
  });

  it("only an archived payload may be evaluated as purgeable", () => {
    for (const storageState of ["HOT", "ARCHIVE_PENDING", "PURGED"] as const) {
      expectDenyIncluding(
        evaluatePayloadPurgeEligibility({
          ...PURGEABLE,
          retention: { storageState, legalHold: "NONE" },
        }),
        "RETENTION_STATE_NOT_ARCHIVED",
      );
    }
    expectAllow(evaluatePayloadPurgeEligibility(PURGEABLE));
  });

  it("destruction requires a legal transition AND a passing decision", () => {
    expectAllow(canTransitionToPurged("ARCHIVED", evaluatePayloadPurgeEligibility(PURGEABLE)));

    /* Structurally legal, but the decision failed. */
    expectDenyIncluding(
      canTransitionToPurged(
        "ARCHIVED",
        evaluatePayloadPurgeEligibility({ ...PURGEABLE, reconstructionRequired: true }),
      ),
      "RECONSTRUCTION_STILL_REQUIRED",
    );

    /* Decision passed for an archived payload, but this payload is not archived. */
    expectDenyIncluding(
      canTransitionToPurged("HOT", evaluatePayloadPurgeEligibility(PURGEABLE)),
      "RETENTION_STATE_NOT_ARCHIVED",
    );
  });
});

// — 7 —

describe("7. current source versions cannot be archived or purged", () => {
  it("archival is refused while the version is current", () => {
    expectDenyIncluding(
      evaluateArchiveEligibility({ ...ARCHIVABLE, isCurrentVersion: true }),
      "SOURCE_VERSION_IS_CURRENT",
    );
  });

  it("purge is refused while the version is current", () => {
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({ ...PURGEABLE, isCurrentVersion: true }),
      "SOURCE_VERSION_IS_CURRENT",
    );
  });

  it("archival is refused while a live transaction needs hot access", () => {
    expectDenyIncluding(
      evaluateArchiveEligibility({ ...ARCHIVABLE, activeTransactionRequiresHotAccess: true }),
      "HOT_ACCESS_STILL_REQUIRED",
    );
  });

  it("archival is refused without a destination or durable publication preparation", () => {
    expectDenyIncluding(
      evaluateArchiveEligibility({ ...ARCHIVABLE, archiveDestinationAvailable: false }),
      "ARCHIVE_DESTINATION_UNAVAILABLE",
    );
    expectDenyIncluding(
      evaluateArchiveEligibility({ ...ARCHIVABLE, publicationPreparationDurable: false }),
      "PUBLICATION_PREPARATION_NOT_DURABLE",
    );
  });

  it("a clear version archives", () => {
    expectAllow(evaluateArchiveEligibility(ARCHIVABLE));
  });
});

// — 8 —

describe("8. a legal hold blocks purge", () => {
  it("blocks destruction of an otherwise clear archived payload", () => {
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({
        ...PURGEABLE,
        retention: setLegalHold(ARCHIVED_UNHELD, "ACTIVE"),
      }),
      "LEGAL_HOLD_IN_FORCE",
    );
  });

  it("blocks the move to PURGED even with a legal transition", () => {
    expectDenyIncluding(
      canTransitionToPurged(
        "ARCHIVED",
        evaluatePayloadPurgeEligibility({
          ...PURGEABLE,
          retention: setLegalHold(ARCHIVED_UNHELD, "ACTIVE"),
        }),
      ),
      "LEGAL_HOLD_IN_FORCE",
    );
  });

  it("blocks archival too, without changing where the payload is", () => {
    const held = setLegalHold(HOT_UNHELD, "ACTIVE");
    expectDenyIncluding(
      evaluateArchiveEligibility({ ...ARCHIVABLE, retention: held }),
      "LEGAL_HOLD_IN_FORCE",
    );
    expect(held.storageState).toBe("HOT");
  });

  it("does not revoke, supersede, or republish anything", () => {
    /* A hold is a storage-and-destruction constraint. It touches no capsule, no
       Node, and no publication state — there is no field here that could. */
    expect(Object.keys(setLegalHold(ARCHIVED_UNHELD, "ACTIVE")).sort()).toEqual([
      "legalHold",
      "storageState",
    ]);
  });
});

// — 9 —

describe("9. an open dispute blocks purge", () => {
  it("refuses while a dispute or refund window is open", () => {
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({ ...PURGEABLE, disputeOrRefundWindowOpen: true }),
      "DISPUTE_OR_REFUND_WINDOW_OPEN",
    );
  });

  it("refuses while financial, tax, or compliance retention applies", () => {
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({ ...PURGEABLE, financialOrTaxRetentionApplies: true }),
      "FINANCIAL_RETENTION_APPLIES",
    );
  });
});

// — 10 —

describe("10. incomplete publication reconciliation blocks purge", () => {
  it("refuses until publication and reconciliation are complete", () => {
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({
        ...PURGEABLE,
        publicationAndReconciliationComplete: false,
      }),
      "PUBLICATION_RECONCILIATION_INCOMPLETE",
    );
  });
});

// — 11 —

describe("11. a missing verified archive blocks purge", () => {
  it("refuses with no archive copy at all", () => {
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({ ...PURGEABLE, archiveCopyKind: "NONE" }),
      "NO_VERIFIED_ARCHIVE_COPY",
    );
  });

  it("refuses an unverified snapshot", () => {
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({ ...PURGEABLE, archiveCopyVerified: false }),
      "NO_VERIFIED_ARCHIVE_COPY",
    );
  });

  it("a capsule body or Registrar copy is not an archive of the source", () => {
    for (const kind of ["CAPSULE_BODY", "REGISTRAR_COPY"] as const) {
      expectDenyIncluding(
        evaluatePayloadPurgeEligibility({
          ...PURGEABLE,
          archiveCopyKind: kind,
          archiveCopyVerified: true,
        }),
        "NO_VERIFIED_ARCHIVE_COPY",
      );
    }
  });
});

// — 12 —

describe("12. a reconstruction-required policy blocks payload destruction", () => {
  it("refuses while deterministic reconstruction is still required", () => {
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({ ...PURGEABLE, reconstructionRequired: true }),
      "RECONSTRUCTION_STILL_REQUIRED",
    );
  });

  it("refuses without an explicit verification-only data-class policy", () => {
    expectDenyIncluding(
      evaluatePayloadPurgeEligibility({
        ...PURGEABLE,
        verificationOnlyRetentionAuthorized: false,
      }),
      "VERIFICATION_ONLY_RETENTION_NOT_AUTHORIZED",
    );
  });

  it("a fully cleared payload may be purged, and reports every failure at once", () => {
    expectAllow(evaluatePayloadPurgeEligibility(PURGEABLE));
    const everythingWrong = evaluatePayloadPurgeEligibility({
      retention: { storageState: "HOT", legalHold: "ACTIVE" },
      isCurrentVersion: true,
      disputeOrRefundWindowOpen: true,
      financialOrTaxRetentionApplies: true,
      publicationAndReconciliationComplete: false,
      archiveCopyKind: "NONE",
      archiveCopyVerified: false,
      reconstructionRequired: true,
      verificationOnlyRetentionAuthorized: false,
    });
    expect(everythingWrong.reasonCodes.length).toBeGreaterThanOrEqual(7);
    expect(new Set(everythingWrong.reasonCodes).size).toBe(everythingWrong.reasonCodes.length);
  });
});

// — 13 —

describe("13. hash-only retention verifies but does not reconstruct", () => {
  it("a hash alone cannot rebuild a source version", () => {
    expect(
      assessReconstructionCapability({
        fullSourceSnapshot: false,
        mappingVersion: false,
        contentHash: true,
        publicationReceipt: false,
      }),
    ).toEqual({ canReconstruct: false, canVerify: true });
  });

  it("a receipt alone cannot either", () => {
    expect(
      assessReconstructionCapability({
        fullSourceSnapshot: false,
        mappingVersion: false,
        contentHash: false,
        publicationReceipt: true,
      }),
    ).toEqual({ canReconstruct: false, canVerify: true });
  });

  it("nothing retained proves nothing", () => {
    expect(
      assessReconstructionCapability({
        fullSourceSnapshot: false,
        mappingVersion: false,
        contentHash: false,
        publicationReceipt: false,
      }),
    ).toEqual({ canReconstruct: false, canVerify: false });
  });
});

// — 14 —

describe("14. a full source snapshot plus its mapping supports reconstruction", () => {
  it("reconstructs with snapshot and mapping version", () => {
    expect(
      assessReconstructionCapability({
        fullSourceSnapshot: true,
        mappingVersion: true,
        contentHash: true,
        publicationReceipt: true,
      }),
    ).toEqual({ canReconstruct: true, canVerify: true });
  });

  it("a snapshot without its mapping version yields some capsule, not the published one", () => {
    expect(
      assessReconstructionCapability({
        fullSourceSnapshot: true,
        mappingVersion: false,
        contentHash: true,
        publicationReceipt: false,
      }),
    ).toEqual({ canReconstruct: false, canVerify: true });
  });

  it("a mapping version without a snapshot has nothing to map", () => {
    expect(
      assessReconstructionCapability({
        fullSourceSnapshot: false,
        mappingVersion: true,
        contentHash: false,
        publicationReceipt: false,
      }),
    ).toEqual({ canReconstruct: false, canVerify: false });
  });
});

// — 15 —

describe("15. publication replay requires the exact source version", () => {
  it("the obligation's own source version is accepted", () => {
    expectAllow(
      evaluatePublicationReplaySource(replay({ offeredSourceVersionRef: OBLIGATION_VERSION })),
    );
  });

  it("a different source version is refused", () => {
    expectDenyIncluding(
      evaluatePublicationReplaySource(replay({ offeredSourceVersionRef: OTHER_VERSION })),
      "SOURCE_VERSION_MISMATCH",
    );
  });

  it("the prepared canonical projection for that obligation is accepted", () => {
    expectAllow(
      evaluatePublicationReplaySource(replay({ offeredPreparedProjectionHash: PREPARED_HASH })),
    );
  });

  it("a different prepared projection is refused", () => {
    expectDenyIncluding(
      evaluatePublicationReplaySource(replay({ offeredPreparedProjectionHash: "sha256:bbbb2222" })),
      "PREPARED_PROJECTION_MISMATCH",
    );
  });

  it("offering no basis at all is refused", () => {
    expectDenyIncluding(
      evaluatePublicationReplaySource(replay()),
      "NO_EXACT_REPLAY_BASIS_SUPPLIED",
    );
  });
});

// — 16 —

describe("16. current entity state cannot substitute for an older obligation", () => {
  it("regenerating from the current record is refused outright", () => {
    expectDenyIncluding(
      evaluatePublicationReplaySource(replay({ regeneratedFromCurrentRecord: true })),
      "CURRENT_RECORD_SUBSTITUTION_FORBIDDEN",
    );
  });

  it("even when a matching source version is also offered", () => {
    /* The flag wins. A caller that regenerated from today's record and then
       attached yesterday's version id is describing two different things. */
    expectDenyIncluding(
      evaluatePublicationReplaySource(
        replay({
          regeneratedFromCurrentRecord: true,
          offeredSourceVersionRef: OBLIGATION_VERSION,
        }),
      ),
      "CURRENT_RECORD_SUBSTITUTION_FORBIDDEN",
    );
  });
});

// — 17 —

describe("17. unknown keys and enum values fail", () => {
  it("unknown enum members are refused", () => {
    expect(ArtifactKind.safeParse("PRODUCT").success).toBe(false);
    expect(RetentionStorageState.safeParse("DELETED").success).toBe(false);
    expect(RetentionStorageState.safeParse("ACTIVE").success).toBe(false);
    expect(SourceVersionRetention.safeParse({ storageState: "HOT" }).success).toBe(false);
    expect(
      SourceVersionRetention.safeParse({ ...HOT_UNHELD, heldBy: "legal@example.com" }).success,
    ).toBe(false);
  });

  it("unknown keys are refused on every request schema", () => {
    expect(
      ProjectionDirectionRequest.safeParse({
        from: "AUTHORITATIVE_SOURCE_VERSION",
        to: "CAPSULE_PROJECTION",
        force: true,
      }).success,
    ).toBe(false);
    expect(PayloadPurgeRequest.safeParse({ ...PURGEABLE, override: true }).success).toBe(false);
    expect(ArchiveEligibilityRequest.safeParse({ ...ARCHIVABLE, metadata: {} }).success).toBe(false);
    expect(RetainedEvidence.safeParse({
      fullSourceSnapshot: true,
      mappingVersion: true,
      contentHash: true,
      publicationReceipt: true,
      notes: "x",
    }).success).toBe(false);
  });

  it("a malformed decision is refused", () => {
    expect(
      ArchitectureDecision.safeParse({
        invariant: "archive-eligibility",
        decision: "ALLOW",
        reasonCodes: ["LEGAL_HOLD_IN_FORCE"],
      }).success,
    ).toBe(false);
    expect(
      ArchitectureDecision.safeParse({
        invariant: "archive-eligibility",
        decision: "DENY",
        reasonCodes: [],
      }).success,
    ).toBe(false);
    expect(ARCHITECTURE_REASON_CODES).toHaveLength(20);
  });

  it("a replay reference must be an opaque bounded identifier", () => {
    expect(
      PublicationReplayRequest.safeParse({
        ...replay(),
        offeredSourceVersionRef: "https://monacado.com/id/product/x",
      }).success,
    ).toBe(false);
  });

  it("no invariant reads ambient state", () => {
    const source = readFileSync(
      new URL("../src/contracts/architecture/transactional-truth.ts", import.meta.url),
      "utf8",
    );
    for (const token of [
      "process.env",
      "Date.now",
      "new Date",
      "Math.random",
      "fetch(",
      "prisma",
      "@prisma/client",
      "node:crypto",
    ]) {
      expect(source, `transactional-truth.ts must not reference ${token}`).not.toContain(token);
    }
  });

  it("isPermitted agrees with the decision it is given", () => {
    expect(isPermitted(evaluateArchiveEligibility(ARCHIVABLE))).toBe(true);
    expect(
      isPermitted(
        evaluatePayloadPurgeEligibility({
          ...PURGEABLE,
          retention: setLegalHold(ARCHIVED_UNHELD, "ACTIVE"),
        }),
      ),
    ).toBe(false);
  });
});
