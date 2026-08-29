/**
 * Identity, session, and entitlement contracts (Phase 0E.7.4.2A).
 *
 * The minimum honest foundation for authenticating a human account and proving an
 * explicit internal operational entitlement. It is **not** a role system, not an
 * onboarding flow, and not a profile.
 *
 * Four properties shape everything below:
 *
 *   1. **The account id is the only authorization key.** Opaque, durable, and
 *      never derived from the email — an address is a mutable contact detail that
 *      a person may change or that may be reassigned, so binding an entitlement to
 *      it would make authorization follow the mailbox rather than the person.
 *
 *   2. **Capabilities are a closed vocabulary**, not free-form strings. One
 *      capability exists in this phase. Generalized RBAC is deliberately absent:
 *      an unbounded permission language is a much larger security surface than the
 *      single question this foundation has to answer.
 *
 *   3. **Nothing secret survives projection.** No schema here carries a password,
 *      a password hash, a raw session token, a token hash, or a cookie — so a
 *      projection cannot leak one by accident.
 *
 *   4. **Every instant is explicit.** No schema or function here reads a clock or
 *      generates randomness; both are injected at the service boundary.
 *
 * Pure data. Not exported through the browser-facing contracts barrel.
 */

import { z } from "zod";
import {
  ACCOUNT_ENTITLEMENT_ID_RE,
  ACCOUNT_ID_RE,
  ACCOUNT_SESSION_ID_RE,
} from "../capsule/identity";

// — Identity —

export const AccountId = z.string().regex(ACCOUNT_ID_RE, "accountId must be mon:acct:<opaque>");
export type AccountId = z.infer<typeof AccountId>;

export const AccountSessionId = z
  .string()
  .regex(ACCOUNT_SESSION_ID_RE, "sessionId must be mon:asess:<opaque>");
export type AccountSessionId = z.infer<typeof AccountSessionId>;

export const AccountEntitlementId = z
  .string()
  .regex(ACCOUNT_ENTITLEMENT_ID_RE, "entitlementId must be mon:aent:<opaque>");
export type AccountEntitlementId = z.infer<typeof AccountEntitlementId>;

// — Email —

/** Bounded by RFC 5321's practical maximum. */
export const MAX_EMAIL_LENGTH = 320;

/**
 * A deliberately conservative address shape: one `@`, no whitespace, no angle
 * brackets or commas, and a dotted domain. This is a *storage* guard, not an
 * attempt to implement RFC 5322 — deliverability is proven by sending mail, which
 * this phase does not do.
 */
export const EMAIL_RE = /^[^\s@<>,;"]{1,64}@[^\s@<>,;".]+(\.[^\s@<>,;".]+)+$/;

export const AccountEmail = z
  .string()
  .min(3)
  .max(MAX_EMAIL_LENGTH)
  .regex(EMAIL_RE, "must be a plausible email address");

/**
 * Deterministic normalisation: trim, then lowercase.
 *
 * Provider-specific canonicalisation is deliberately **not** performed. Stripping
 * dots or `+tags` is a Gmail convention, not a rule of email, and applying it
 * would merge `a.b@example.com` and `ab@example.com` into one account at
 * providers where those are genuinely different mailboxes — silently handing one
 * person's account to another. Case-folding is the only transformation the
 * standard actually supports treating as equivalent in practice.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// — Password —

/**
 * Twelve, not eight. These accounts gate internal operational data, and the
 * cheapest meaningful defence against credential stuffing is length.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * An upper bound so a single request cannot hand the hasher an arbitrarily large
 * input. Argon2id has no bcrypt-style 72-byte truncation, so this is purely an
 * abuse bound, not a security ceiling.
 */
export const MAX_PASSWORD_LENGTH = 256;

export const AccountPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `password must be at most ${MAX_PASSWORD_LENGTH} characters`);

// — Account —

/** ACTIVE may authenticate; DISABLED may not, and its sessions stop resolving. */
export const ACCOUNT_STATUSES = ["ACTIVE", "DISABLED"] as const;
export const AccountStatus = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const AccountName = z.string().trim().min(1).max(191);

export const CreateAccountInput = z.strictObject({
  name: AccountName,
  email: AccountEmail,
  password: AccountPassword,
  createdAt: z.iso.datetime(),
  /** Defaults to ACTIVE; present so a disabled account can be seeded in a test. */
  status: AccountStatus.optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountInput>;

export const AuthenticateAccountInput = z.strictObject({
  email: z.string().min(1).max(MAX_EMAIL_LENGTH),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
export type AuthenticateAccountInput = z.infer<typeof AuthenticateAccountInput>;

/**
 * The safe view of an account.
 *
 * `passwordHash` is absent by construction, not by filtering — there is no field
 * for it, so no projection can carry one.
 */
export const AccountRecord = z.strictObject({
  accountId: AccountId,
  name: z.string(),
  email: z.string(),
  normalizedEmail: z.string(),
  status: AccountStatus,
  createdAt: z.iso.datetime(),
});
export type AccountRecord = z.infer<typeof AccountRecord>;

// — Capabilities —

/**
 * The closed **internal** capability vocabulary.
 *
 * A closed enum rather than a string means an unrecognised capability is a
 * validation failure at the boundary, so a typo grants nothing and an attacker
 * cannot invent one.
 *
 * Every member answers a question about **Monacado's own operations**, never
 * about marketplace participation:
 *
 *   - `publication-worker:status:read` (0E.7.4.1) — may this internal account
 *     read publication-worker operational health?
 *   - `activation:review` (0M.8) — may this internal account make the governed
 *     participant-activation decision?
 *   - `participant:restrict` (0M.R1) — may this internal account impose or lift a
 *     governed participant restriction?

 * `participant:restrict` is separate from `activation:review` rather than folded
 * into it, because a restriction reaches capabilities an activation review never
 * touches: taking a storefront live, publishing an Offer, receiving a payout,
 * accruing commission, submitting reviews. Reusing `activation:review` would
 * silently widen a grant whose holder was approved to decide one admission
 * review — the same one-enum-two-questions drift 0M.1 §1 refuses. It is also
 * deliberately narrow: not `admin`, not `risk:*`, not a wildcard.
 *
 * **This vocabulary and `MARKETPLACE_CAPABILITIES` are disjoint, permanently.**
 * `activation:review` is here and not there because activation review is
 * Monacado's operational act; `activation:submit` is there and not here because
 * submitting is a participant's act. The two answer different questions about
 * different subjects, and a single enum serving both is the drift 0M.1 §1 exists
 * to prevent — `marketplaceCapabilitiesGrantedByInternalEntitlement` and
 * `internalCapabilitiesGrantedByMarketplaceRoles` both return the empty array
 * permanently, in both directions.
 *
 * Membership is granted **only** by an explicit active `AccountEntitlement`.
 * Nothing about holding a marketplace role, owning a participant, or owning the
 * account grants a member of this list.
 */
export const ACCOUNT_CAPABILITIES = [
  "publication-worker:status:read",
  "activation:review",
  "participant:restrict",
  "participant:commerce-approve",
  /**
   * Phase 1.13. A FIFTH NARROW GRANT, minted rather than folded in, for the
   * reason 0M.9 gave when it minted the fourth: an existing internal capability
   * is not a place to put a new authority merely because it is also internal.
   *
   * This one is narrow in an unusually important direction. It authorises
   * READING risk analytics and RECORDING what a reviewer decided. It authorises
   * NOTHING else — in particular it does not authorise imposing a restriction,
   * which remains `participant:restrict` and is checked separately. That
   * separation is the whole safeguard: a reviewer who concludes
   * `SUSPENSION_RECOMMENDED` still cannot act on their own conclusion, so a
   * recommendation can never become its own execution.
   */
  "participant:risk-review",
  /**
   * Phase 1.14. A SIXTH NARROW GRANT, and the widest-reaching one yet, which is
   * precisely why it is minted rather than folded into `participant:restrict`.
   *
   * A restriction withholds a named commercial capability and is structurally
   * forbidden from reaching drafting or `activation:submit` — a participant must
   * be able to answer a restriction. A suspension withholds those too. Reusing
   * the restrict grant would silently hand every current restrictor the power to
   * remove a participant's ability to answer their own case, which is the exact
   * "silent widening" this vocabulary was split to prevent.
   *
   * It authorises suspending AND reinstating, on the precedent
   * `participant:restrict` sets by authorising both imposing and lifting: an
   * authority that can start an adverse action but not end it is worse than one
   * that can do neither.
   */
  "participant:suspend",
] as const;
export const AccountCapability = z.enum(ACCOUNT_CAPABILITIES);
export type AccountCapability = z.infer<typeof AccountCapability>;

export const ENTITLEMENT_STATUSES = ["ACTIVE", "REVOKED"] as const;
export const EntitlementStatus = z.enum(ENTITLEMENT_STATUSES);
export type EntitlementStatus = z.infer<typeof EntitlementStatus>;

export const GrantAccountEntitlementInput = z.strictObject({
  accountId: AccountId,
  capability: AccountCapability,
  grantedAt: z.iso.datetime(),
});
export type GrantAccountEntitlementInput = z.infer<typeof GrantAccountEntitlementInput>;

export const RevokeAccountEntitlementInput = z.strictObject({
  accountId: AccountId,
  capability: AccountCapability,
  revokedAt: z.iso.datetime(),
});
export type RevokeAccountEntitlementInput = z.infer<typeof RevokeAccountEntitlementInput>;

export const AccountEntitlementRecord = z.strictObject({
  entitlementId: AccountEntitlementId,
  accountId: AccountId,
  capability: AccountCapability,
  status: EntitlementStatus,
  grantedAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type AccountEntitlementRecord = z.infer<typeof AccountEntitlementRecord>;

// — Session —

/** Bounds on a session's lifetime. */
export const MIN_SESSION_TTL_SECONDS = 60;
export const MAX_SESSION_TTL_SECONDS = 2_592_000; // 30 days
/**
 * Twelve hours. Long enough that an operator is not re-authenticating through an
 * incident, short enough that a forgotten session is not a standing key.
 */
export const DEFAULT_SESSION_TTL_SECONDS = 43_200;

export const CreateAccountSessionInput = z.strictObject({
  accountId: AccountId,
  createdAt: z.iso.datetime(),
  ttlSeconds: z.int().min(MIN_SESSION_TTL_SECONDS).max(MAX_SESSION_TTL_SECONDS),
});
export type CreateAccountSessionInput = z.infer<typeof CreateAccountSessionInput>;

/**
 * The safe view of a session. There is no `tokenHash` field and no `token` field:
 * the raw token is returned exactly once, from `createAccountSession`, as a value
 * separate from this record.
 */
export const AccountSessionRecord = z.strictObject({
  sessionId: AccountSessionId,
  accountId: AccountId,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});
export type AccountSessionRecord = z.infer<typeof AccountSessionRecord>;

// — Authenticated principal —

/**
 * Actor types a resolved session may produce.
 *
 * `INTERNAL_OPERATOR` is reached **only** through an active persisted
 * entitlement. An ordinary authenticated account is `ACCOUNT` — a perfectly valid
 * authenticated principal that simply holds no internal capability. Keeping the
 * two distinct is what stops "logged in" from drifting into "authorized".
 */
export const PRINCIPAL_ACTOR_TYPES = ["ACCOUNT", "INTERNAL_OPERATOR"] as const;
export const PrincipalActorType = z.enum(PRINCIPAL_ACTOR_TYPES);
export type PrincipalActorType = z.infer<typeof PrincipalActorType>;

/**
 * What a resolved session hands to a route adapter.
 *
 * Enumerated field by field, with no email, name, password hash, token, token
 * hash, cookie, database row, or claims bag. A later route translates this into
 * the Phase 0E.7.4.1 caller context; it must never need anything more than this.
 */
export const AuthenticatedPrincipal = z.strictObject({
  /** Stable and opaque; equal to the account id. */
  actorId: AccountId,
  actorType: PrincipalActorType,
  accountId: AccountId,
  sessionId: AccountSessionId,
  /** Allow-listed from active persisted entitlements. Never from a token claim. */
  capabilities: z.array(AccountCapability).max(ACCOUNT_CAPABILITIES.length),
});
export type AuthenticatedPrincipal = z.infer<typeof AuthenticatedPrincipal>;
