/**
 * Safe, bounded error metadata for durable work records (Phase 0E.3).
 *
 * When outbox processing fails, a short reason is persisted so operators can see
 * WHY without opening a debugger. That persisted text is the single most likely
 * place for a connection string, a credential, a capsule body, or an integrity
 * hash to leak into durable storage — so it is deliberately narrow.
 *
 * The rule is REJECT, not scrub: unsafe content fails loudly at the boundary
 * rather than being silently mangled into something that looks safe but is not.
 * Callers must therefore pass a deliberate, human-written summary — never a raw
 * driver message, and never a serialised payload.
 *
 * This module has no dependencies on the capsule, publication, or persistence
 * layers so it can be shared without import cycles.
 */

import { z } from "zod";

/** Maximum stored lengths (bounded so a payload cannot be smuggled in). */
export const MAX_ERROR_CODE_LENGTH = 64;
export const MAX_ERROR_SUMMARY_LENGTH = 256;

/**
 * A stable, machine-readable error code: SCREAMING_SNAKE_CASE only. The shape
 * alone excludes URLs, JSON, whitespace-separated prose, and secrets.
 */
export const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Why a candidate summary/code was refused. Reasons name the CLASS, never the value. */
export interface UnsafeMetadataFinding {
  rule: string;
  reason: string;
}

interface Rule {
  rule: string;
  reason: string;
  test: RegExp;
}

/**
 * Content classes that must never enter durable error metadata. Each rule names
 * a class of secret/oversharing rather than a specific value.
 */
const UNSAFE_RULES: readonly Rule[] = [
  {
    rule: "uri-credentials",
    reason: "contains a URI with embedded credentials (scheme://user:pass@host)",
    test: /[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i,
  },
  {
    rule: "connection-string",
    reason: "contains a database connection scheme",
    test: /\b(mysql|mariadb|postgres|postgresql|mongodb|redis|sqlserver|jdbc)\s*:\/\//i,
  },
  {
    rule: "database-url",
    reason: "references DATABASE_URL",
    test: /DATABASE_URL/i,
  },
  {
    rule: "secret-assignment",
    reason: "contains a credential or token assignment",
    test: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|authorization|bearer|credentials?)\b\s*[:=]/i,
  },
  {
    rule: "integrity-hash",
    reason: "contains an integrity hash",
    test: /\bsha(?:1|256|384|512)\s*:\s*[0-9a-f]{8,}/i,
  },
  {
    rule: "capsule-body",
    reason: "contains JSON-LD capsule content",
    test: /@context|@type|"metadata"\s*:|"payload"\s*:/i,
  },
  {
    rule: "control-characters",
    reason: "contains control characters",
    // eslint-disable-next-line no-control-regex
    test: /[\u0000-\u001F\u007F]/,
  },
];

/** All findings for a candidate error summary (empty when safe). */
export function findUnsafeErrorMetadata(value: string): UnsafeMetadataFinding[] {
  return UNSAFE_RULES.filter((r) => r.test.test(value)).map(({ rule, reason }) => ({ rule, reason }));
}

/** True when the value carries no forbidden content class. */
export function isSafeErrorMetadata(value: string): boolean {
  return findUnsafeErrorMetadata(value).length === 0;
}

const safeRefine = (value: string, ctx: z.RefinementCtx): void => {
  for (const finding of findUnsafeErrorMetadata(value)) {
    ctx.addIssue({
      code: "custom",
      // The finding names the class only — the offending value is never echoed.
      message: `unsafe error metadata (${finding.rule}): ${finding.reason}`,
    });
  }
};

/** Stable machine-readable failure code. */
export const SafeErrorCode = z
  .string()
  .regex(ERROR_CODE_RE, "errorCode must be SCREAMING_SNAKE_CASE, 1-64 chars")
  .superRefine(safeRefine);
export type SafeErrorCode = z.infer<typeof SafeErrorCode>;

/** Short, human-written, bounded failure summary. */
export const SafeErrorSummary = z
  .string()
  .min(1)
  .max(MAX_ERROR_SUMMARY_LENGTH, `errorSummary must be at most ${MAX_ERROR_SUMMARY_LENGTH} characters`)
  .superRefine(safeRefine);
export type SafeErrorSummary = z.infer<typeof SafeErrorSummary>;
