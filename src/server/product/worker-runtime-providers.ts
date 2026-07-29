/**
 * Concrete worker runtime providers (Phase 0E.7.2) — SERVER ONLY.
 *
 * The **only** place in the publication path that reads a real clock or generates
 * randomness. Everything downstream — the Phase 0E.7.1 cycle, the Phase 0E.6.3
 * orchestration, and every contract — receives instants and identities through
 * injected interfaces and has no fallback to `Date.now()`.
 *
 * That asymmetry is the point. Keeping ambient nondeterminism in one runtime
 * adapter is what lets every domain test control time exactly, and it means a
 * reviewer can find every clock read in this repository by reading one file.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import { SubmissionAttemptId } from "../../contracts/product/product-submission-attempt";
import type {
  RetryTimingProvider,
  SubmissionAttemptIdProvider,
  TimeProvider,
} from "../../contracts/product/publication-worker-cycle";
import { MAX_RETRY_DELAY_SECONDS, MIN_RETRY_DELAY_SECONDS } from "./worker-runtime-config";
import { WorkerDependencyConstructionFailureError } from "./worker-runtime-errors";

/** Length of the opaque body shared by every Monacado identifier. */
const OPAQUE_BODY_LENGTH = 26;

/**
 * A cryptographically random 26-character Crockford base32 body.
 *
 * `randomBytes` rather than `Math.random`: an attempt identifier ends up in
 * durable records and is the key a Registrar receipt must name, so a predictable
 * one would let a third party assert which attempt a receipt answers.
 *
 * `byte % 32` is bias-free here because 256 is an exact multiple of 32 — no
 * rejection sampling is needed, and pretending otherwise would add a loop with no
 * effect.
 */
function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/**
 * The system clock, exposed through the existing provider interface.
 *
 * Permitted here because this module *is* the runtime adapter. A domain service
 * doing the same thing would be untestable without freezing global time.
 */
export class SystemTimeProvider implements TimeProvider {
  now(): Date {
    return new Date();
  }
}

/**
 * Submission-attempt identities from cryptographically secure randomness.
 *
 * The generated id is validated against the existing contract before it is
 * returned, so a change to either the alphabet or the identifier shape fails here
 * rather than deep inside persistence. Nothing about the generation scheme is
 * exposed: callers see an opaque string.
 *
 * No identifier is generated at construction. One is produced only when the cycle
 * asks for one, immediately before a run — a command that finds no work therefore
 * burns exactly the one identity the orchestration needs to discover that.
 */
export class RandomSubmissionAttemptIdProvider implements SubmissionAttemptIdProvider {
  nextSubmissionAttemptId(): string {
    return SubmissionAttemptId.parse(`mon:attempt:${randomOpaqueBody()}`);
  }
}

/**
 * One fixed retry delay, applied to an **explicitly supplied** instant.
 *
 * `nextRetryAvailableAt = attemptedAt + delay`. No clock read, no jitter, no
 * backoff curve, no attempt-count input — so the same inputs always produce the
 * same instant, and a test can assert the exact value.
 *
 * Jitter, exponential backoff, and per-item attempt caps remain **deferred**: each
 * changes when work becomes eligible, which is a durable scheduling decision that
 * deserves its own phase rather than being smuggled in as a provider detail.
 *
 * This policy is consulted only for a retryable failure that was **proven not to
 * have been transmitted**. Ambiguous delivery never reaches it: the Phase 0E.6.3
 * orchestration leaves such an item PROCESSING under its lease and schedules
 * nothing, so nothing is ever resent on the strength of a guess.
 */
export class FixedDelayRetryTimingProvider implements RetryTimingProvider {
  private readonly delayMs: number;

  constructor(delaySeconds: number) {
    // Re-asserted at construction rather than trusted from the loader: this object
    // can be built by hand, and an unbounded delay would silently park work.
    if (
      !Number.isInteger(delaySeconds) ||
      delaySeconds < MIN_RETRY_DELAY_SECONDS ||
      delaySeconds > MAX_RETRY_DELAY_SECONDS
    ) {
      throw new WorkerDependencyConstructionFailureError("retryTiming");
    }
    this.delayMs = delaySeconds * 1_000;
  }

  nextRetryAvailableAt(context: { attemptedAt: Date; runIndex: number }): Date {
    return new Date(context.attemptedAt.getTime() + this.delayMs);
  }
}

/**
 * A correlation id for one command invocation.
 *
 * Generated once at entry-point startup when the operator supplied none. Opaque
 * and bounded, so it is safe to include in every emitted monitoring line — it
 * encodes no host, no environment, and no business meaning.
 *
 * The shape is `cyc-<26 Crockford chars>`, which satisfies `CYCLE_ID_RE` by
 * construction; a test asserts that rather than a runtime guard, because a guard
 * here could never fire and would be unreachable vocabulary.
 */
export function generateWorkerCycleId(): string {
  return `cyc-${randomOpaqueBody()}`;
}
