/**
 * Marketplace policy bootstrap (Phase 1.4) — SERVER ONLY.
 *
 * Phase 1.3 made an `ACTIVE` marketplace policy a **prerequisite** for
 * participant activation and for every new checkout, and then shipped no way to
 * put one there: the document exists as a source module, the governance tables
 * exist, and nothing connects them outside a test fixture. A deployment could
 * therefore refuse every activation and every sale, correctly, forever.
 *
 * This is the connection, and it is deliberately the **smallest** one: it records
 * the exact shipped version and, when an operator explicitly asks, activates it.
 *
 * ## Phase 1.10: more than one version is shipped
 *
 * `1.10` published Marketplace Policy 1.1.0 beside the already-`ACTIVE` 1.0.0, so
 * "the shipped policy" stopped being a single thing. Two consequences, both
 * narrow:
 *
 *   - `policyVersion` selects which shipped version to act on, defaulting to the
 *     newest. An unshipped version is refused, never defaulted.
 *   - **Recording a `DRAFT` beside a standing `ACTIVE` version is permitted.** A
 *     `DRAFT` governs nobody — no participant accepts it, no checkout binds it,
 *     nothing reads it — and it is precisely how the next governed version comes
 *     into existence. The `CONFLICTING_ACTIVE_VERSION` refusal now guards the act
 *     it was written to guard, which is **activation**, and no longer blocks the
 *     supported publish-then-activate path through the only tooling that has one.
 *
 * ## It refuses rather than resolves
 *
 * Four things are treated as somebody else's decision, and each is a refusal with
 * a bounded code rather than something this repairs:
 *
 * | Situation | Why it is not repaired here |
 * | --- | --- |
 * | another version is `ACTIVE` **and activation was asked for** | replacing it would retire terms participants are live under, silently. Whoever wants that supersession must perform it deliberately |
 * | the requested version is not one this deployment ships | a mistyped version is a mistake about which terms are being published, and publishing different ones instead is the worst reading of it |
 * | the persisted hash disagrees with the source | the prose moved without a version bump. Rewriting the row would destroy the only evidence of the drift |
 * | the shipped version is `RETIRED` | `0M.R1`'s rule, kept: a retired version never returns, because reactivation makes "which terms applied when" unanswerable |
 * | the recording account does not exist | governance records *who* recorded a version, and a fabricated recorder is worse than an unrecorded one |
 *
 * **No historical version is ever written to.** The only writes are: create the
 * policy identity if absent, create the shipped version as `DRAFT` if absent, and
 * move that same row `DRAFT → ACTIVE`. Nothing else is touched, and there is no
 * path here that retires anything — `activateMarketplacePolicyVersion` retires a
 * standing version, so this refuses before calling it when one exists.
 *
 * ## Idempotent by observation, not by upsert
 *
 * The state is read first and the action is chosen from it, so a second run
 * reports `NO_CHANGE_ALREADY_ACTIVE` and writes nothing. An upsert would have
 * been shorter and would have quietly overwritten exactly the rows the table
 * exists to keep immutable.
 */

import "../server-only";
import {
  LATEST_MARKETPLACE_POLICY_VERSION,
  MONACADO_MARKETPLACE_POLICY_ID,
  MARKETPLACE_POLICY_CONTENT_REFS,
  MARKETPLACE_POLICY_DOCUMENTS,
  MARKETPLACE_POLICY_ONBOARDING_ACCEPTANCE,
  marketplacePolicyContentHash,
} from "../../contracts/marketplace/marketplace-policy-content";
import type {
  MarketplacePolicyDocument,
  PolicyContentHash,
} from "../../contracts/marketplace/marketplace-policy";
import { getPrisma } from "../db/client";
import {
  activateMarketplacePolicyVersion,
  ensureMarketplacePolicy,
  getActiveMarketplacePolicyVersion,
  getMarketplacePolicyVersion,
  recordMarketplacePolicyVersion,
  type PolicyServiceDeps,
} from "./marketplace-policy-service";

/**
 * Whether this run may write.
 *
 * `INSPECT` reads the same state and reports the same action, having changed
 * nothing — so an operator can see what a bootstrap *would* do against a database
 * before it does it.
 */
export const BOOTSTRAP_MODES = ["INSPECT", "APPLY"] as const;
export type BootstrapMode = (typeof BOOTSTRAP_MODES)[number];

/** What the shipped version looks like in the database right now. */
export const PERSISTED_POLICY_STATES = ["ABSENT", "DRAFT", "ACTIVE", "RETIRED"] as const;
export type PersistedPolicyState = (typeof PERSISTED_POLICY_STATES)[number];

/**
 * The action taken, or — in `INSPECT` — the action that would be taken.
 *
 * Bounded, because an operator command's output is read by people and by
 * scripts, and a free-text summary is one neither can rely on.
 */
export const BOOTSTRAP_ACTIONS = [
  /** Nothing existed: the version was recorded `DRAFT` and then activated. */
  "RECORD_AND_ACTIVATE",
  /** Nothing existed: the version was recorded `DRAFT`. Activation not requested. */
  "RECORD_DRAFT",
  /** The version existed as `DRAFT` and was activated. */
  "ACTIVATE_EXISTING_DRAFT",
  /** The exact shipped version is already `ACTIVE`. Nothing was written. */
  "NO_CHANGE_ALREADY_ACTIVE",
  /** The version exists as `DRAFT` and activation was not requested. */
  "NO_CHANGE_ALREADY_DRAFT",
  /** Refused. See `refusal`. */
  "REFUSED",
] as const;
export type BootstrapAction = (typeof BOOTSTRAP_ACTIONS)[number];

/**
 * Why a bootstrap refused.
 *
 * Every one of these is a state a human must resolve. None is retried, and none
 * is worked around: a bootstrap that could clear its own obstacles would be a
 * bootstrap that could replace the terms a marketplace is operating under.
 */
export const BOOTSTRAP_REFUSALS = [
  /** A different version of this policy is `ACTIVE`. Never replaced here. */
  "CONFLICTING_ACTIVE_VERSION",
  /** The persisted hash and the source document disagree. The prose moved. */
  "CONTENT_HASH_MISMATCH",
  /** The shipped version is `RETIRED`, and a retired version never returns. */
  "SHIPPED_VERSION_RETIRED",
  /** The account named as the recorder does not exist. */
  "RECORDING_ACCOUNT_NOT_FOUND",
  /**
   * The requested version is not one this deployment ships (Phase 1.10).
   *
   * Refused rather than defaulted to the latest. `--version=1.2.0` typed at a
   * deployment that ships 1.1.0 is a mistake about what is being published, and
   * silently recording something else would be recording terms nobody asked for.
   */
  "SHIPPED_VERSION_UNKNOWN",
] as const;
export type BootstrapRefusal = (typeof BOOTSTRAP_REFUSALS)[number];

/**
 * Everything an operator needs, and nothing else.
 *
 * There is no field for a connection string, an environment variable, an account
 * email, or policy prose — the report is printed, and a printed report is a log
 * line somewhere.
 */
export interface PolicyBootstrapOutcome {
  mode: BootstrapMode;
  policyId: string;
  policyVersion: string;
  /**
   * The shipped content this version names. `null` only for
   * `SHIPPED_VERSION_UNKNOWN`, where no content exists to name.
   */
  contentRef: string | null;
  /**
   * The hash derived from the shipped source module, always recomputed.
   *
   * `null` only for `SHIPPED_VERSION_UNKNOWN` — there is no document to hash, and
   * a placeholder digest reported as a source hash would be a fabricated one.
   */
  sourceHash: PolicyContentHash | null;
  /** The hash on the persisted row, or `null` when no row exists. */
  persistedHash: string | null;
  persistedState: PersistedPolicyState;
  action: BootstrapAction;
  /** `false` in `INSPECT`, and `false` for every refusal. */
  applied: boolean;
  /** Whether this run moved the shipped version into `ACTIVE`. */
  activated: boolean;
  refusal: BootstrapRefusal | null;
  /** The version standing in the way, only for `CONFLICTING_ACTIVE_VERSION`. */
  conflictingActiveVersion: string | null;
  /**
   * Whichever version is `ACTIVE` right now, refusal or not (Phase 1.10).
   *
   * Reported on **every** outcome, because recording a new `DRAFT` beside a
   * standing `ACTIVE` version is now an ordinary success, and an operator reading
   * "RECORD_DRAFT" needs to see which terms are still governing while it sits
   * there. `conflictingActiveVersion` stays what it was — the version that
   * *blocked* an activation — so a script reading either keeps its meaning.
   */
  standingActiveVersion: string | null;
  /**
   * Whether adopting this version requires participants to accept again.
   *
   * Read from the shipped registry, never decided here. Reported so an operator
   * planning an activation can see the consequence before performing one.
   */
  requiresReacceptance: boolean;
}

export interface PolicyBootstrapInput {
  /** The internal `Account` id recording this version. Never an email. */
  recordedByAccountId: string;
  now: string;
  /**
   * Whether to move the shipped version into `ACTIVE`.
   *
   * Explicit, and off by default. Activating is the act that starts governing
   * live participants and live sales, and a command that did it as a side effect
   * of "initialise the database" would be doing it by accident.
   */
  activate: boolean;
  mode: BootstrapMode;
  /**
   * Which shipped version to act on. Defaults to the newest this deployment
   * ships (Phase 1.10).
   *
   * Present because a deployment now ships more than one, and "the shipped
   * policy" stopped being a single thing the moment 1.1.0 existed. A version this
   * deployment does not ship is `SHIPPED_VERSION_UNKNOWN`, never silently the
   * latest.
   */
  policyVersion?: string;
}

export interface PolicyBootstrapDeps extends PolicyServiceDeps {
  /**
   * The document this bootstrap treats as "shipped".
   *
   * Injected **only** so a test can exercise this whole path against its own
   * policy identity rather than recording, activating, and retiring versions of
   * the real one that every other suite's participants are activated under. It is
   * a **source** seam, not a content seam — whatever document is supplied, the
   * hash is still derived from it and still checked against what is persisted, so
   * nothing here is weakened by the substitution.
   *
   * A caller supplying this must also supply `documents`, because
   * `recordMarketplacePolicyVersion` resolves the content from that registry.
   */
  shipped?: {
    document: MarketplacePolicyDocument;
    contentRef: string;
    /** Defaults to `true`, matching every version this repository ships. */
    requiresReacceptance?: boolean;
  };
}

/** One shipped version: its content, its ref, and its reacceptance decision. */
interface ShippedVersion {
  document: MarketplacePolicyDocument;
  contentRef: string;
  requiresReacceptance: boolean;
}

/**
 * The shipped version this run acts on, unless a test substitutes one.
 *
 * `null` when the requested version is not one this deployment ships — a refusal
 * rather than a fallback to the newest, because a version typed by an operator is
 * a statement about which terms they mean to publish.
 */
const resolveShipped = (
  deps: PolicyBootstrapDeps,
  requestedVersion: string | undefined,
): ShippedVersion | null => {
  if (deps.shipped !== undefined) {
    return {
      document: deps.shipped.document,
      contentRef: deps.shipped.contentRef,
      requiresReacceptance: deps.shipped.requiresReacceptance ?? true,
    };
  }
  const version = requestedVersion ?? LATEST_MARKETPLACE_POLICY_VERSION;
  const document = MARKETPLACE_POLICY_DOCUMENTS.get(version);
  const contentRef = MARKETPLACE_POLICY_CONTENT_REFS.get(version);
  if (document === undefined || contentRef === undefined) return null;
  return {
    document,
    contentRef,
    requiresReacceptance: MARKETPLACE_POLICY_ONBOARDING_ACCEPTANCE.get(version) ?? true,
  };
};

const base = (
  mode: BootstrapMode,
  shipped: ShippedVersion,
  sourceHash: PolicyContentHash,
) => ({
  mode,
  policyId: shipped.document.policyId,
  policyVersion: shipped.document.policyVersion,
  contentRef: shipped.contentRef,
  sourceHash,
  persistedHash: null as string | null,
  persistedState: "ABSENT" as PersistedPolicyState,
  applied: false,
  activated: false,
  refusal: null as BootstrapRefusal | null,
  conflictingActiveVersion: null as string | null,
  standingActiveVersion: null as string | null,
  requiresReacceptance: shipped.requiresReacceptance,
});

/**
 * Record — and optionally activate — the shipped Marketplace Policy version.
 *
 * Reads the whole picture first, decides once, then writes at most the two rows
 * it is entitled to write. Refusals are **returned**, not thrown: a conflicting
 * `ACTIVE` version is an ordinary state of the world an operator must be shown,
 * not an exception a command has to catch to report properly.
 */
export async function bootstrapMarketplacePolicy(
  input: PolicyBootstrapInput,
  deps: PolicyBootstrapDeps = {},
): Promise<PolicyBootstrapOutcome> {
  const db = deps.db ?? getPrisma();
  const source = resolveShipped(deps, input.policyVersion);
  if (source === null) {
    /* Refused before the database client is used at all. A version this
       deployment does not ship names no content, so there is nothing to hash,
       nothing to compare, and nothing to record. */
    return {
      mode: input.mode,
      policyId: MONACADO_MARKETPLACE_POLICY_ID,
      policyVersion: input.policyVersion ?? LATEST_MARKETPLACE_POLICY_VERSION,
      contentRef: null,
      sourceHash: null,
      persistedHash: null,
      persistedState: "ABSENT",
      action: "REFUSED",
      applied: false,
      activated: false,
      refusal: "SHIPPED_VERSION_UNKNOWN",
      conflictingActiveVersion: null,
      standingActiveVersion: null,
      requiresReacceptance: false,
    };
  }
  const policyId = source.document.policyId;
  const policyVersion = source.document.policyVersion;
  /* Derived from the source on every run, never read from a constant: the whole
     binding is worthless if the hash can be stale. */
  const sourceHash = marketplacePolicyContentHash(source.document);
  const out = base(input.mode, source, sourceHash);

  const shipped = await getMarketplacePolicyVersion(policyId, policyVersion, deps);
  const active = await getActiveMarketplacePolicyVersion(policyId, deps);

  if (shipped !== null) {
    out.persistedHash = shipped.contentHash;
    out.persistedState = shipped.status;
  }
  out.standingActiveVersion = active === null ? null : active.policyVersion;

  /* 1 — The prose moved without a version bump. The row is EVIDENCE of that and
     is left exactly as it is; rewriting it would erase the only record. */
  if (shipped !== null && shipped.contentHash !== sourceHash) {
    return { ...out, action: "REFUSED", refusal: "CONTENT_HASH_MISMATCH" };
  }

  /* 2 — Somebody else's version is governing, and this run wants to ACTIVATE.
     Fail closed: retiring the standing version is a supersession decision, and
     this command is not where one gets made.

     Gated on `activate` since Phase 1.10, and the distinction is the point.
     Recording a version as `DRAFT` governs nobody: it creates an immutable row
     nothing reads until somebody activates it, and it is exactly how the next
     governed version comes into existence beside the one still in force. The
     refusal exists to stop a command retiring live terms by accident — which a
     DRAFT cannot do — so extending it to cover recording would have made the
     supported path (publish the next version, activate it deliberately later)
     unreachable through the only tooling that exists for it. */
  if (input.activate && active !== null && active.policyVersion !== policyVersion) {
    return {
      ...out,
      action: "REFUSED",
      refusal: "CONFLICTING_ACTIVE_VERSION",
      conflictingActiveVersion: active.policyVersion,
    };
  }

  /* 3 — 0M.R1's rule, unchanged: a retired version never returns. */
  if (shipped !== null && shipped.status === "RETIRED") {
    return { ...out, action: "REFUSED", refusal: "SHIPPED_VERSION_RETIRED" };
  }

  if (shipped !== null && shipped.status === "ACTIVE") {
    return { ...out, action: "NO_CHANGE_ALREADY_ACTIVE" };
  }

  const wouldActivate = input.activate;
  const plannedAction: BootstrapAction =
    shipped === null
      ? wouldActivate
        ? "RECORD_AND_ACTIVATE"
        : "RECORD_DRAFT"
      : wouldActivate
        ? "ACTIVATE_EXISTING_DRAFT"
        : "NO_CHANGE_ALREADY_DRAFT";

  if (input.mode === "INSPECT") {
    return { ...out, action: plannedAction };
  }

  /* Only checked when something is actually about to be written. Governance
     records who recorded a version, and a recorder that does not exist is not a
     record. */
  if (plannedAction !== "NO_CHANGE_ALREADY_DRAFT") {
    const recorder = await db.account.findUnique({
      where: { id: input.recordedByAccountId },
      select: { id: true },
    });
    if (recorder === null) {
      return { ...out, action: "REFUSED", refusal: "RECORDING_ACCOUNT_NOT_FOUND" };
    }
  }

  if (plannedAction === "NO_CHANGE_ALREADY_DRAFT") {
    return { ...out, action: plannedAction };
  }

  if (shipped === null) {
    await ensureMarketplacePolicy(
      { policyId, label: source.document.title, now: input.now },
      deps,
    );
    const recorded = await recordMarketplacePolicyVersion(
      {
        policyId,
        policyVersion,
        contentRef: source.contentRef,
        /* The publisher's judgement, carried from the shipped registry rather
           than decided here. Whether a version obliges participants to accept
           again is a governance call made once, by whoever wrote the version. */
        requiresReacceptance: source.requiresReacceptance,
        effectiveFrom: input.now,
        recordedByAccountId: input.recordedByAccountId,
        recordedAt: input.now,
      },
      deps,
    );
    out.persistedHash = recorded.contentHash;
    out.persistedState = recorded.status;
  }

  if (!wouldActivate) {
    return { ...out, action: "RECORD_DRAFT", applied: true };
  }

  const activated = await activateMarketplacePolicyVersion(
    {
      policyId,
      policyVersion,
      activatedByAccountId: input.recordedByAccountId,
      activatedAt: input.now,
    },
    deps,
  );

  return {
    ...out,
    persistedHash: activated.contentHash,
    persistedState: activated.status,
    action: plannedAction,
    applied: true,
    activated: true,
  };
}
