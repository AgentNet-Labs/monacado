/**
 * Password hashing (Phase 0E.7.4.2A) — SERVER ONLY.
 *
 * **Argon2id, via `@node-rs/argon2`.** Argon2id won the Password Hashing
 * Competition and is the current OWASP first choice: it is memory-hard, so a GPU
 * or ASIC attacker cannot buy the orders-of-magnitude advantage they get against
 * a fast hash, and the `id` variant defends both side-channel and time-memory
 * tradeoff attacks.
 *
 * `@node-rs/argon2` rather than the `argon2` package because it ships prebuilt
 * napi binaries — no `node-gyp`, no compiler toolchain at install time, which is
 * exactly the "installation and deployment compatibility are clean" test that
 * decides Argon2id over bcrypt.
 *
 * No algorithm is invented here and no hashing is hand-rolled. The library owns
 * salting (a fresh random salt per hash, embedded in the PHC string) and
 * verification; this module owns only bounds and the shape of failure.
 *
 * Nothing in this file logs, returns, or embeds a password or a hash in an error.
 */

import "../server-only";
import { hash, verify } from "@node-rs/argon2";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../../contracts/account/account";

/**
 * Argon2id.
 *
 * The library exposes this as an ambient `const enum`, which `isolatedModules`
 * forbids importing, so the value is pinned numerically here. That is only safe
 * because it is verified rather than assumed: a test asserts every produced hash
 * carries the literal `$argon2id$` prefix, so a wrong constant — or a reordered
 * enum in a future release — fails loudly instead of silently selecting Argon2d.
 */
const ARGON2ID = 2;

/**
 * Cost parameters. These are the library defaults, which track the current OWASP
 * Argon2id guidance (19 MiB, 2 iterations, 1 lane); they are named here so a
 * future change is a deliberate, reviewable edit rather than an invisible
 * dependency bump.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Every hash this module produces must begin with this. Asserted by a test. */
export const ARGON2ID_PREFIX = "$argon2id$";

/** Longest PHC string the column accepts. Argon2id output is far shorter. */
export const MAX_PASSWORD_HASH_LENGTH = 255;

/**
 * Hash a password. Rejects out-of-bounds input **before** hashing, so an
 * oversized value cannot consume memory-hard work on its way to being refused.
 *
 * Returns a PHC string (`$argon2id$v=19$m=...`) carrying its own salt and
 * parameters, so a future cost increase can re-hash old passwords on next login
 * without a schema change.
 */
export async function hashPassword(password: string): Promise<string> {
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    // Deliberately says nothing about the value, only that it was refused.
    throw new RangeError("password length is outside the permitted bounds");
  }
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns `false` rather than throwing for every failure mode — wrong password,
 * malformed hash, unusable input. A caller must not be able to distinguish "this
 * account's hash is corrupt" from "this password is wrong", because the first
 * answer confirms the account exists.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (typeof password !== "string" || typeof storedHash !== "string") return false;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  if (storedHash.length === 0) return false;
  try {
    return await verify(storedHash, password);
  } catch {
    // A malformed or unrecognised hash is an authentication failure, never an
    // error the caller can inspect.
    return false;
  }
}

/**
 * A hash to verify against when no account was found.
 *
 * Authenticating an unknown address still performs one real Argon2id
 * verification, so the response time of "no such account" resembles that of
 * "wrong password". Without this, the timing difference is a free account
 * enumeration oracle — the generic error message alone does not close it.
 *
 * Computed lazily once per process, never persisted, and never a real credential.
 */
let decoyHash: Promise<string> | undefined;
export function timingDecoyHash(): Promise<string> {
  decoyHash ??= hash("monacado-timing-decoy-not-a-credential", ARGON2_OPTIONS);
  return decoyHash;
}
