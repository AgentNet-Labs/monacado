/**
 * Server-only guard (Phase 0E.6.2).
 *
 * Importing this module asserts that the importing module must never be
 * evaluated in a browser bundle. Modules that read secrets, or that carry the
 * NAME of a secret variable, import it for effect:
 *
 *     import "../server-only";
 *
 * The repository has no `server-only` package and no client components yet, so
 * this is the narrowest protection that needs no new dependency: if such a
 * module is ever pulled into a client bundle, it fails loudly at evaluation
 * rather than silently shipping a secret-adjacent code path to a browser.
 *
 * This is a backstop, not the primary control. The primary control is that
 * secret-bearing modules live under `src/server/` and are never re-exported
 * through the browser-facing `src/contracts` barrel — which a test asserts.
 */

if (typeof window !== "undefined") {
  throw new Error(
    "This module is server-only and must not be imported into a client bundle.",
  );
}

export {};
