/**
 * Shared internal-cause handling for Product persistence errors (Phases 0D,
 * 0E.1, 0E.2).
 *
 * Every repository/service error may carry the original failure for internal
 * diagnostics, but that cause frequently contains driver text — Prisma messages,
 * connection strings, hosts, ports, usernames, database names. Such text must
 * never reach a client through ordinary serialisation.
 *
 * The rule: the cause is **retained** on the error and readable in a debugger or
 * log statement that asks for it explicitly, but it is defined **non-enumerable**,
 * so it is invisible to `JSON.stringify`, object spread, `Object.keys`, and
 * `for...in`. It is also non-writable and non-configurable, so it cannot later be
 * redefined into an enumerable property.
 *
 * Public, deliberately-safe fields (`name`, `code`, `message`, and structured
 * fields such as conflicting field NAMES or Zod issue paths) stay as they are.
 */

/** The property name carrying the retained internal cause. */
export const INTERNAL_CAUSE_PROPERTY = "internalCause" as const;

/**
 * Attach the original cause to an error for internal diagnostics WITHOUT making
 * it serialisable. Always defines the property so its descriptor is locked down
 * even when there is no cause to record.
 */
export function attachInternalCause(target: object, cause: unknown): void {
  Object.defineProperty(target, INTERNAL_CAUSE_PROPERTY, {
    value: cause,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}
