/**
 * Storefront capsule projection: context, eligibility, and mapping (Phase 0M.3B).
 *
 * The only permitted flow:
 *
 * ```
 * StorefrontSourceVersion → recorded projection context → projection mapping
 *   → Storefront Capsule Projection Shape
 * ```
 *
 * Six properties shape everything below, mirroring the Offer projection:
 *
 *   1. **One exact source version, supplied by the caller.** There is no
 *      "current record" parameter, no "latest" lookup, and no repository — the
 *      mapper cannot reach a database even if someone wanted it to.
 *
 *   2. **Public identity comes only from the context, and must be proven to
 *      match.** The context carries the internal ids it claims to stand for, the
 *      mapper checks them against the source version, and those internal ids are
 *      then discarded — used for validation, never emitted.
 *
 *   3. **Fails closed.** An ineligible Storefront, a mismatched binding, an
 *      invalid source version, or an invalid context produces an error, never a
 *      best-effort capsule. **Projection repairs nothing.**
 *
 *   4. **Deterministic.** Same source version + same context ⇒ byte-identical
 *      capsule and identical hash. Nothing reads a clock or generates
 *      randomness; the generation instant is a context field.
 *
 *   5. **It writes nothing.** No transactional fact, authority, provenance, Node
 *      registration, publication state, or source version is created here. There
 *      is deliberately **no inverse function** — no capsule-to-source mapper
 *      exists in this module or anywhere else.
 *
 *   6. **Provenance is represented, not created.** The capsule restates facts the
 *      database already holds — which source version, which mapping, when
 *      generated — and asserts none of them into being.
 *
 * Pure functions. No database, clock, environment read, randomness, or network.
 */

import { z } from "zod";
import {
  AnsNodeId,
  CapsuleId,
  PolicyRef,
  SemVer,
  type ProvenanceRecord,
} from "../capsule/envelope";
import { publishedContentHash, withPublishedContentHash } from "../integrity/hash";
import { AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF } from "../ontology/commerce.context";
import {
  STOREFRONT_TYPE,
  StorefrontCapsuleProjection,
  type StorefrontCapsuleData,
} from "./storefront.capsule";
import {
  InternalStorefrontId,
  StorefrontSourceRecordId,
  StorefrontSourceRecordVersion,
  StorefrontSourceVersion,
  isDiscoverable,
  isPubliclyAccessible,
  type StorefrontGoLiveApprovalStatus,
  type StorefrontLifecycleState,
  type StorefrontVisibility,
} from "./storefront-source";
import { MarketplaceParticipantId } from "./participant";

// — Eligibility —

/**
 * Why a Storefront source version may not be projected.
 *
 * `SUSPENDED` and `CLOSED` are ineligible **in this phase** for the same reason
 * the Offer projection defers `SUSPENDED`/`WITHDRAWN`: whether a suspension or a
 * closure should supersede, revoke, or simply stop refreshing an already-published
 * capsule is a publication-lifecycle decision, and answering it by quietly
 * projecting something would be answering it by accident.
 */
export const STOREFRONT_PROJECTION_ELIGIBILITY_REASONS = [
  "DRAFT_NOT_PUBLIC",
  "SUSPENDED_PUBLICATION_DEFERRED",
  "CLOSED_PUBLICATION_DEFERRED",
  "VISIBILITY_NOT_PUBLIC",
  "GO_LIVE_NOT_APPROVED",
] as const;
export const StorefrontProjectionIneligibilityReason = z.enum(
  STOREFRONT_PROJECTION_ELIGIBILITY_REASONS,
);
export type StorefrontProjectionIneligibilityReason = z.infer<
  typeof StorefrontProjectionIneligibilityReason
>;

export type StorefrontProjectionEligibility =
  | { eligible: true; discoverable: boolean }
  | { eligible: false; reason: StorefrontProjectionIneligibilityReason };

/**
 * Whether this Storefront may be projected, and whether it is discoverable.
 *
 * Go-live approval is **an input, never a Storefront field** (0M.3A): Monacado's
 * permission to be public is Monacado's, and storing it on the record the owner
 * controls would put the approver's decision inside the approved thing.
 *
 * The two derived answers come from the source model's own helpers —
 * `isPubliclyAccessible` and `isDiscoverable` — rather than from a second copy of
 * their logic. 0M.3A is explicit that there is only one definition of public
 * access, and a projection with its own would be the contradictory second.
 */
export function evaluateStorefrontProjectionEligibility(input: {
  lifecycle: StorefrontLifecycleState;
  visibility: StorefrontVisibility;
  goLiveApproval: StorefrontGoLiveApprovalStatus;
}): StorefrontProjectionEligibility {
  switch (input.lifecycle) {
    case "DRAFT":
      return { eligible: false, reason: "DRAFT_NOT_PUBLIC" };
    case "SUSPENDED":
      return { eligible: false, reason: "SUSPENDED_PUBLICATION_DEFERRED" };
    case "CLOSED":
      return { eligible: false, reason: "CLOSED_PUBLICATION_DEFERRED" };
    case "ACTIVE": {
      /* Order matters for the reason code, not the outcome: an unapproved
         PRIVATE storefront is reported as PRIVATE, because that is the thing its
         owner can act on. */
      if (input.visibility === "PRIVATE") {
        return { eligible: false, reason: "VISIBILITY_NOT_PUBLIC" };
      }
      if (!isPubliclyAccessible(input)) {
        return { eligible: false, reason: "GO_LIVE_NOT_APPROVED" };
      }
      return { eligible: true, discoverable: isDiscoverable(input) };
    }
  }
}

// — Projection context —

/**
 * The capsulization-side bindings the projection needs, and the proof that they
 * belong to this source version.
 *
 * Each binding pairs the **public** identifier with the **internal** identifier
 * it stands for. The internal half exists so the mapper can refuse a mismatched
 * pairing; it is validation input and never reaches the capsule.
 */
export const StorefrontNodeBinding = z.strictObject({
  /**
   * Registrar-issued Node for this Storefront. **Never derived from
   * `mon:storefront:`** and never encoding a handle, a name, or an owner — an
   * ANS Node ID is opaque, and a semantic one would leak business meaning into
   * the identity layer (ADR §11.5).
   */
  storefrontNode: AnsNodeId,
  /** The internal Storefront this Node stands for — checked, then discarded. */
  internalStorefrontId: InternalStorefrontId,
});

export const StorefrontOwnerNodeBinding = z.strictObject({
  /** The owner's approved public authority Node. */
  ownerAuthorityNode: AnsNodeId,
  /** The transactional participant it stands for — checked, then discarded. */
  ownerParticipantId: MarketplaceParticipantId,
});

/** Names the exact source version this projection is for. */
export const StorefrontSourceVersionBinding = z.strictObject({
  storefrontSourceRecordId: StorefrontSourceRecordId,
  sourceRecordVersion: StorefrontSourceRecordVersion,
});

export const StorefrontProjectionContext = z.strictObject({
  storefrontBinding: StorefrontNodeBinding,
  ownerBinding: StorefrontOwnerNodeBinding,
  sourceVersionBinding: StorefrontSourceVersionBinding,
  /**
   * Monacado's go-live approval at projection time.
   *
   * A supplied decision, not a Storefront field — and required, so a projection
   * cannot be produced by forgetting to ask.
   */
  goLiveApproval: z.enum(["APPROVED", "NOT_APPROVED"]),
  /** The capsule-version identity, issued elsewhere; this phase issues nothing. */
  capsuleId: CapsuleId,
  /** Semantic version of this capsule. */
  capsuleVersion: SemVer,
  /** The recorded projection-mapping version. Stamped into provenance. */
  mappingVersion: z.string().min(1).max(64),
  /** Explicit generation instant. There is no default and no clock read. */
  generatedAt: z.iso.datetime(),
  nodePolicy: PolicyRef,
  capsulePolicy: PolicyRef,
});
export type StorefrontProjectionContext = z.infer<typeof StorefrontProjectionContext>;

// — Errors —

export const STOREFRONT_PROJECTION_ERROR_CODES = [
  "INVALID_SOURCE_VERSION",
  "INVALID_PROJECTION_CONTEXT",
  "SOURCE_VERSION_BINDING_MISMATCH",
  "STOREFRONT_BINDING_MISMATCH",
  "OWNER_BINDING_MISMATCH",
  "NOT_PROJECTION_ELIGIBLE",
  "INVALID_PROJECTION_OUTPUT",
  /** A capsule version this mapper does not know how to produce. */
  "UNSUPPORTED_CAPSULE_VERSION",
  /** A mapping version other than the one this mapper implements. */
  "UNSUPPORTED_MAPPING_VERSION",
] as const;
export type StorefrontProjectionErrorCode =
  (typeof STOREFRONT_PROJECTION_ERROR_CODES)[number];

/**
 * A bounded failure. Carries a code and, for ineligibility, the bounded reason —
 * never a source value, an internal identifier, or a raw validation dump.
 */
export class StorefrontProjectionError extends Error {
  readonly code: StorefrontProjectionErrorCode;
  readonly reason?: StorefrontProjectionIneligibilityReason;

  constructor(
    code: StorefrontProjectionErrorCode,
    reason?: StorefrontProjectionIneligibilityReason,
  ) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "StorefrontProjectionError";
    this.code = code;
    this.reason = reason;
  }
}

// — Mapping —

/** The method recorded in provenance: this capsule is a projection of a version. */
export const STOREFRONT_PROJECTION_METHOD = "governed-source-version-projection" as const;

/**
 * The exact capsule version this mapper emits and accepts.
 *
 * Pinned rather than treated as a floor, on the Offer's reasoning: a future
 * `1.1.0` would carry claims this mapper does not know how to produce, and
 * accepting it implicitly would let a caller label output as a shape it is not.
 */
export const SUPPORTED_STOREFRONT_CAPSULE_VERSION = "1.0.0" as const;

/** The projection mapping version stamped into provenance. */
export const STOREFRONT_PROJECTION_MAPPING_VERSION = "storefront-projection/1.0.0" as const;

function buildProvenance(
  source: StorefrontSourceVersion,
  context: StorefrontProjectionContext,
): ProvenanceRecord {
  return {
    source: `${source.sourceSystem}:${source.sourceRecordType}:${source.storefrontSourceRecordId}@${source.sourceRecordVersion}`,
    method: STOREFRONT_PROJECTION_METHOD,
    /* The instant the authoritative fact was recorded — represented, not created.
       The capsule does not claim to have established it. */
    acquiredAt: source.recordedAt,
    assertionKind: "Asserted",
    sourceClass: source.sourceClass,
    sourceSystem: source.sourceSystem,
    sourceRecordType: source.sourceRecordType,
    sourceRecordId: source.storefrontSourceRecordId,
    sourceRecordVersion: source.sourceRecordVersion,
    generatedAt: context.generatedAt,
    generatorVersion: context.mappingVersion,
  };
}

/**
 * Project one identified source version into a public capsule.
 *
 * Order matters, and each step fails closed: validate the source version,
 * validate the context, prove every binding, check the version pins, check
 * eligibility, map, hash, re-validate the output. The output validation is not
 * belt-and-braces — it is what guarantees no internal identifier reached the
 * capsule through a field that accepts strings.
 *
 * **The authorization trace does not survive projection.** `authorizedByActorId`
 * and `authorizedByParticipantId` record who inside the marketplace approved a
 * change; they are never read here, so no mapping exists that could publish them.
 */
export function storefrontSourceRecordToCapsuleProjection(input: {
  sourceVersion: StorefrontSourceVersion;
  context: StorefrontProjectionContext;
}): StorefrontCapsuleProjection {
  const sourceParsed = StorefrontSourceVersion.safeParse(input.sourceVersion);
  if (!sourceParsed.success) throw new StorefrontProjectionError("INVALID_SOURCE_VERSION");
  const source = sourceParsed.data;

  const contextParsed = StorefrontProjectionContext.safeParse(input.context);
  if (!contextParsed.success) throw new StorefrontProjectionError("INVALID_PROJECTION_CONTEXT");
  const context = contextParsed.data;

  /* The context must be for THIS source version — not for the Storefront in
     general, and certainly not for whatever the current record happens to say. */
  if (
    context.sourceVersionBinding.storefrontSourceRecordId !== source.storefrontSourceRecordId ||
    context.sourceVersionBinding.sourceRecordVersion !== source.sourceRecordVersion
  ) {
    throw new StorefrontProjectionError("SOURCE_VERSION_BINDING_MISMATCH");
  }
  if (context.storefrontBinding.internalStorefrontId !== source.internalStorefrontId) {
    throw new StorefrontProjectionError("STOREFRONT_BINDING_MISMATCH");
  }
  if (context.ownerBinding.ownerParticipantId !== source.ownerParticipantId) {
    throw new StorefrontProjectionError("OWNER_BINDING_MISMATCH");
  }

  if (context.capsuleVersion !== SUPPORTED_STOREFRONT_CAPSULE_VERSION) {
    throw new StorefrontProjectionError("UNSUPPORTED_CAPSULE_VERSION");
  }
  if (context.mappingVersion !== STOREFRONT_PROJECTION_MAPPING_VERSION) {
    throw new StorefrontProjectionError("UNSUPPORTED_MAPPING_VERSION");
  }

  const eligibility = evaluateStorefrontProjectionEligibility({
    lifecycle: source.lifecycle,
    visibility: source.visibility,
    goLiveApproval: context.goLiveApproval,
  });
  if (!eligibility.eligible) {
    throw new StorefrontProjectionError("NOT_PROJECTION_ELIGIBLE", eligibility.reason);
  }

  const { displayName, tagline, summary } = source.presentation;

  const data: StorefrontCapsuleData = {
    publicHandle: source.publicHandle,
    name: displayName,
    /* One canonical public absence: a value the source holds as `null` is an
       omitted key, never `null`. The source already has exactly one
       representation of "absent", so this mapping is total. */
    ...(tagline !== null ? { slogan: tagline } : {}),
    ...(summary !== null ? { description: summary } : {}),
    discoverable: eligibility.discoverable,
    relationships: {
      operatedBy: context.ownerBinding.ownerAuthorityNode,
    },
  };

  const draft = {
    "@context": [COMMERCE_CONTEXT_REF, AN_O_CONTEXT_REF],
    "@type": STOREFRONT_TYPE,
    metadata: {
      capsuleId: context.capsuleId,
      bindsToNode: context.storefrontBinding.storefrontNode,
      version: context.capsuleVersion,
      provenance: buildProvenance(source, context),
      nodePolicy: context.nodePolicy,
      capsulePolicy: context.capsulePolicy,
    },
    data,
  };

  const hashed = withPublishedContentHash(draft);
  const result = StorefrontCapsuleProjection.safeParse(hashed);
  if (!result.success) throw new StorefrontProjectionError("INVALID_PROJECTION_OUTPUT");
  return result.data;
}

export interface StorefrontProjectionVerification {
  /** The supplied capsule's content is exactly what this source version produces. */
  matches: boolean;
  /** Hash of the re-derived capsule. */
  expectedContentHash: string;
  /** Hash RECOMPUTED from the supplied capsule's own content. */
  actualContentHash: string;
  /** Whether the supplied capsule's stored hash agrees with its own content. */
  storedContentHashConsistent: boolean;
}

/**
 * Re-derive a capsule from its source version and context, and report whether the
 * one supplied is the same artifact.
 *
 * The Product track already carries `verifyPersistedProductVersionMapping` for
 * exactly this purpose, and a publication phase will need the same question
 * answered for Storefronts: *is this published artifact still the one this source
 * version produces?*
 *
 * `actualContentHash` is **recomputed from the supplied capsule's content**, not
 * read from its `metadata.contentHash`. Trusting the stored value would let a
 * capsule whose body had been edited — while its hash was left alone — verify
 * successfully, which is precisely the tampering this function exists to catch.
 * `storedContentHashConsistent` reports that stale-hash case separately, so
 * "someone edited the body" is distinguishable from "this is a different
 * version's capsule".
 *
 * Pure, and it repairs nothing — it reports.
 */
export function verifyStorefrontCapsuleProjection(input: {
  sourceVersion: StorefrontSourceVersion;
  context: StorefrontProjectionContext;
  capsule: StorefrontCapsuleProjection;
}): StorefrontProjectionVerification {
  const expected = storefrontSourceRecordToCapsuleProjection({
    sourceVersion: input.sourceVersion,
    context: input.context,
  });
  const actual = publishedContentHash(input.capsule);
  return {
    matches: expected.metadata.contentHash === actual,
    expectedContentHash: expected.metadata.contentHash,
    actualContentHash: actual,
    storedContentHashConsistent: input.capsule.metadata.contentHash === actual,
  };
}
