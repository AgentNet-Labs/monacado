/**
 * Process-signal shutdown adapter (Phase 0E.7.1) — SERVER ONLY.
 *
 * Translates SIGTERM/SIGINT into the `ShutdownSignal` the worker cycle polls.
 *
 * Kept in its own module, away from the domain cycle, because process signals are
 * an ambient global concern and the cycle must stay a pure function of its
 * injected collaborators. That separation is what lets a test drive shutdown
 * deterministically without touching `process`.
 *
 * Deliberate properties:
 *
 *   - **nothing happens on import.** Handlers register only when
 *     `createProcessShutdownSignal()` is called, so importing this module cannot
 *     change how the process responds to a signal;
 *   - **it never calls `process.exit`.** Exiting is the host's decision; killing
 *     the process here would abandon an in-flight request whose outcome has not
 *     been recorded — exactly the ambiguity the publication path works to avoid;
 *   - **it returns an unregister function**, and repeated registration cannot
 *     leak listeners because each call owns exactly the handlers it added;
 *   - **no worker starts.** This produces a signal, nothing more.
 */

import "../server-only";
import type { ShutdownSignal } from "../../contracts/product/publication-worker-cycle";

/** Signals a supervisor conventionally uses to ask for a graceful stop. */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
export type ShutdownSignalName = (typeof SHUTDOWN_SIGNALS)[number];

export interface ProcessShutdownSignal extends ShutdownSignal {
  /** Which signal was observed first, if any. */
  readonly signal: ShutdownSignalName | undefined;
  /** Remove exactly the handlers this call installed. Idempotent. */
  unregister(): void;
}

/**
 * Install shutdown handlers and return the signal the cycle can poll.
 *
 * The flag is one-way: once shutdown has been requested it stays requested. A
 * second SIGTERM does not clear it, and there is no un-request — a supervisor
 * that has asked twice certainly does not want us to carry on.
 */
export function createProcessShutdownSignal(
  options: { signals?: readonly ShutdownSignalName[] } = {},
): ProcessShutdownSignal {
  const signals = options.signals ?? SHUTDOWN_SIGNALS;
  let requested = false;
  let observed: ShutdownSignalName | undefined;
  let registered = true;

  // One handler per signal, held so `unregister` removes precisely these and
  // never another caller's.
  const handlers = new Map<ShutdownSignalName, () => void>();
  for (const name of signals) {
    const handler = (): void => {
      requested = true;
      // First signal wins: it is the one that explains why we are stopping.
      if (observed === undefined) observed = name;
    };
    handlers.set(name, handler);
    process.on(name, handler);
  }

  return {
    isShutdownRequested: () => requested,
    get signal() {
      return observed;
    },
    unregister() {
      if (!registered) return;
      registered = false;
      for (const [name, handler] of handlers) {
        process.off(name, handler);
      }
      handlers.clear();
    },
  };
}
