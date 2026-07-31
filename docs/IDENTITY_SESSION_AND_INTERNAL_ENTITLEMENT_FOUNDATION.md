# Identity, Session, and Internal Entitlement Foundation (Phase 0E.7.4.2A)

The minimum honest foundation for authenticating a human account and proving an
explicit **internal operational entitlement**.

It exists because Phase 0E.7.4.2 — the authenticated worker-status route — was
correctly blocked: the repository had no account, no session, no membership, no
role, and no entitlement, so the route could only have been built on something
forbidden (login-only access, an email-domain check, a hard-coded allow-list, or
an environment variable).

## What this is not

No login page, no logout page, no signup route, no dashboard, no UI, no HTTP route
of any kind. No email verification, password recovery, OAuth, social login, or
MFA. No organizations, memberships, seller/promoter onboarding, or Stripe. **No
general RBAC.**

There is one capability, one closed vocabulary, and one question this foundation
answers: *does this authenticated account hold an explicit internal entitlement?*

## Relational-first, never a capsule

Accounts are operational infrastructure state. The ADR's capsule-backed
publishable entities are Product, Storefront, Creator, Promoter, Listing, and
Offer — a person's login is none of those. Nothing here is ever published, no
capsule references these rows, and the three tables have no relation to any
publication table.

## Authentication framework decision

**A repository-local opaque-session implementation, not Auth.js.**

The deciding fact is documented by Auth.js itself:

> "It comes with the constraint that users authenticated in this manner are not
> persisted in the database, and consequently that the Credentials provider can
> only be used if JSON Web Tokens are enabled for sessions."

This phase requires a durable, server-validated session that fails closed the
instant it is revoked or its account is disabled. A JWT cannot do that without a
server-side lookup on every request — at which point the session table exists
anyway and the token's only advantage is gone, while its disadvantages (no
revocation, key rotation, replay until expiry) remain.

Two further reasons:

- the Auth.js Prisma adapter defines a model literally named `Account` meaning
  *OAuth provider linkage*, colliding head-on with Monacado's `Account` meaning
  *the human account*. Importing that schema would conflict with the identity
  semantics this phase is establishing;
- App Router support lives in `next-auth@beta` (v5); stable is v4. A beta is a
  poor foundation for the authorization substrate everything internal will rest
  on, and we need **zero** OAuth providers — the only part of Auth.js that would
  have earned its complexity.

**Tradeoff accepted:** we own the session code. It is ~200 lines of opaque token,
digest, expiry, and revocation with no cryptography of our own invention — and
password hashing, the part that genuinely must not be hand-rolled, is delegated to
a library.

## Account model

| Field | Rule |
| --- | --- |
| `id` | `mon:acct:<26 Crockford>`, opaque, from `crypto.randomBytes` |
| `name` | display only — **never authoritative for identity or authorization** |
| `email` | as typed, for display and correspondence |
| `normalizedEmail` | **unique**; authoritative for lookup |
| `passwordHash` | Argon2id PHC string |
| `status` | `ACTIVE` \| `DISABLED` |

**The account id is the only authorization key.** It is never derived from the
email, because an address is a mutable contact detail that a person may change or
that may be reassigned — binding an entitlement to it would make authorization
follow the mailbox rather than the person.

### Email normalization

Trim, then lowercase. Deterministic, and applied before every lookup and the
uniqueness check, so `Ada@Example.com` and `ada@example.com` cannot both exist.

Provider-specific canonicalisation is deliberately **not** performed. Stripping
dots or `+tags` is a Gmail convention, not a rule of email; applying it would
merge `a.b@example.com` and `ab@example.com` into one account at providers where
those are genuinely different mailboxes — silently handing one person's account to
another.

## Password security

**Argon2id via `@node-rs/argon2`.** Argon2id won the Password Hashing Competition
and is the current OWASP first choice: memory-hard, so a GPU or ASIC attacker
cannot buy the orders-of-magnitude advantage they get against a fast hash, and the
`id` variant defends both side-channel and time-memory tradeoff attacks.

`@node-rs/argon2` rather than `argon2` because it ships prebuilt napi binaries —
no `node-gyp`, no compiler at install time. That is exactly the "installation and
deployment compatibility are clean" test that selects Argon2id over bcrypt.

- Cost parameters are named explicitly (19 MiB, 2 iterations, 1 lane — the current
  OWASP guidance) so a change is a reviewable edit, not an invisible dependency
  bump.
- Length bounds: **minimum 12** (these accounts gate internal operational data,
  and length is the cheapest defence against credential stuffing), maximum 256
  (an abuse bound; Argon2id has no bcrypt-style 72-byte truncation).
- Bounds are checked **before** hashing, so an oversized value cannot consume
  memory-hard work on its way to being refused.
- The library owns salting (fresh random salt per hash, embedded in the PHC
  string) and verification. No algorithm is invented here.
- `verifyPassword` returns `false` for every failure — wrong password, malformed
  hash, unusable input — so a caller cannot distinguish "this account's hash is
  corrupt" from "this password is wrong". The first answer confirms the account
  exists.
- The Argon2id variant is pinned numerically (the library exposes it as an ambient
  `const enum` that `isolatedModules` forbids importing) and **verified by a test
  asserting the literal `$argon2id$` prefix**, so a wrong constant fails loudly
  rather than silently selecting Argon2d.

### Login failure is one answer

Unknown address, wrong password, disabled account, and malformed input all raise
the same `INVALID_CREDENTIALS` with no fields and no detail. A test asserts the
messages are byte-identical.

The message alone is not enough: a fast-path miss on an unknown address would let
the *clock* answer the question the message refused to. So authentication always
performs one real Argon2id verification — against the stored hash when a row was
found, against a **process-local decoy hash** when it was not — and the status
check happens *after* verification, so a disabled account costs the same time as
an active one with a wrong password.

## Session model

Opaque, server-validated, revocable.

- The token is **256 bits** of `crypto.randomBytes`, rendered base64url.
- Only its **SHA-256 digest** is persisted, under a unique index. Reading the
  database yields no usable credential.
- The raw token exists in exactly two places: the return value of
  `createAccountSession`, and the caller's cookie. It is never written anywhere and
  is not recoverable — losing it means creating a new session.

> **Why SHA-256 here and Argon2id for passwords.** A slow, memory-hard hash makes
> guessing a *low-entropy human secret* expensive. A 256-bit random token cannot
> be guessed at all, so that cost buys nothing — while a fast digest keeps session
> resolution cheap on every request. Argon2id for tokens would be a self-inflicted
> denial of service; SHA-256 for passwords would be a real vulnerability. The
> asymmetry is deliberate.

Digests are matched by the database's unique index — an indexed equality lookup,
not a byte-by-byte compare in application code — so there is no string-comparison
timing signal.

### Lifetime, revocation, and disabling

- Bounded TTL: 60 s … 30 days, default **12 hours** (long enough that an operator
  is not re-authenticating through an incident, short enough that a forgotten
  session is not a standing key).
- `resolveAccountSession` returns `undefined` — never throws — for unknown,
  expired, revoked, or since-disabled. These are ordinary "not signed in" answers;
  distinguishing them would tell the holder of a stale token *why* it is stale.
- **Disabling an account invalidates its live sessions on the next request**,
  because resolution reads the account's status rather than trusting the session.
- Revocation is **idempotent**: signing out twice succeeds quietly, and the first
  revocation instant is kept rather than rewritten. Revoking an unknown token is
  also not an error — it would reveal whether the token was ever real.
- `revokeAllAccountSessions` provides "sign out everywhere".
- Resolution is **read-only by default**; `touch: true` is opt-in so a caller
  performing a read does not silently turn it into a write on every request.

## Cookie policy

Pure string helpers — no framework import, no `next/headers`, no request/response
object, and **no `process.env`**. `secure` is a required argument, so the decision
belongs to the caller at the edge rather than to an ambient read buried in a
helper.

| Attribute | Value | Why |
| --- | --- | --- |
| name | `monacado_session` | fixed |
| `HttpOnly` | always | script cannot read it, so an XSS bug cannot exfiltrate it |
| `SameSite` | `Strict` | stricter than the Lax floor — no cross-site flow legitimately needs this cookie, so CSRF surface is removed rather than mitigated |
| `Path` | `/` | one session per origin |
| `Domain` | **omitted** | host-only, never shared with a sibling subdomain |
| `Secure` | caller-supplied | `true` in any real deployment |
| `Max-Age` | bounded | matches the session TTL |

The cookie carries **only the opaque token**. No account id, email, name, status,
role, or capability is encoded into it, so it cannot assert anything a client could
tamper with. The deletion helper repeats every attribute, because a browser only
replaces a cookie when name, path, and domain agree.

No UI uses these yet — they exist so the deferred route adapter has one reviewed
place to set and clear a session.

## Entitlement model

One explicit persisted grant of one capability to one account id.

- Capability vocabulary is a **closed enum** with exactly one member:
  `publication-worker:status:read`. An unrecognised capability is a validation
  failure, so a typo grants nothing and an attacker cannot invent one.
- One row per `(accountId, capability)` — enforced by a unique index. Granting is
  **idempotent** and preserves the original `grantedAt`; revoking flips the row.
  A full grant/revoke audit log is deliberately deferred.
- Revoking something not held is not an error: the caller's intent is satisfied
  either way, and failing would tempt a bootstrap script to skip the call.
- **Revocation fails closed immediately** — authorization reads this row on every
  request rather than trusting a claim cached in a token.

Authorization is **never** derived from: successful login, email address, email
domain, an environment allow-list, a hard-coded account id or address, a request
header, a query parameter, or anything outside the session system. A test seeds two
accounts at the *same* domain — one entitled, one not — and asserts only the
entitled one passes.

Deletion behaviour is deliberate: `AccountSession` is **CASCADE** (an ephemeral
credential, not history — deleting the account must not leave a resolvable session
behind), `AccountEntitlement` is **RESTRICT** (an authorization record; deleting an
account that still holds one is refused, forcing explicit revocation first).

## Safe principal projection

`resolveAuthenticatedPrincipal(token, { now })` → `AuthenticatedPrincipal` or
`undefined`.

```
actorId · actorType · accountId · sessionId · capabilities
```

That is the complete field set. There is no field for an email, a name, a password
hash, a raw or hashed token, a cookie, a database row, or a claims bag — so none
can leak by accident.

> **`INTERNAL_OPERATOR` is reached only through an active persisted entitlement.**
> An ordinary authenticated account projects as `ACCOUNT` — a valid principal that
> simply holds no internal capability.

Keeping those two apart is what stops "successfully logged in" from drifting into
"authorized to read operational data", which is the most common way an internal
surface quietly becomes a public one. Capabilities are read from the database on
every resolution and allow-listed on the way out, so a value no longer in the
vocabulary grants nothing even if a row still carries it.

## Bootstrap policy

**No operator is created automatically.** There is no environment-based operator
email, no startup grant, no migration-seeded administrator, no hard-coded account
id, and no public entitlement endpoint. A test greps the services for all of these.

The first entitlement must be granted by an explicit, separately controlled
operation calling `grantAccountEntitlement` — a future bootstrap command, or a test
fixture. **Production bootstrap therefore requires a controlled operation and its
own audit trail**, both deferred: this phase provides the service such an operation
would call, not the operation itself.

## Error model

Six reachable codes: `INVALID_ACCOUNT_INPUT`, `DUPLICATE_ACCOUNT_EMAIL`,
`INVALID_CREDENTIALS`, `ACCOUNT_NOT_FOUND`, `UNSUPPORTED_CAPABILITY`,
`ACCOUNT_PERSISTENCE_FAILURE`.

Deliberately **not** errors: an expired or revoked session (`undefined`), and an
account holding no capability (`false`). Those are conditions a caller handles, not
faults.

No error carries a password, hash, raw or hashed token, cookie, email, database
message, or stack. `DUPLICATE_ACCOUNT_EMAIL` is reachable only from administrative
creation — if a public signup is ever added, it must not surface that code, for the
enumeration reason above. Internal causes use the shared non-enumerable pattern.

## Transaction boundaries

**No transaction spans password hashing.** Argon2id is deliberately slow and
memory-hard; holding a transaction open across it would pin a connection for the
whole cost and let a burst of logins exhaust the pool. The hash is computed first,
outside any transaction, and only the write is transactional.

Uniqueness is enforced by the database's unique index rather than a read-then-write
check, so two concurrent creations cannot both succeed.

## How this unblocks Phase 0E.7.4.2

The route can now:

1. read the session cookie with `readSessionCookie`;
2. resolve it with `resolveAuthenticatedPrincipal` — `undefined` → **401**;
3. require `actorType === "INTERNAL_OPERATOR"` and the capability in
   `principal.capabilities` — otherwise **403**;
4. translate `actorId` (the durable account id) into the Phase 0E.7.4.1 caller
   context, whose `actorType` vocabulary already includes `INTERNAL_OPERATOR`;
5. delegate to `getInternalPublicationWorkerStatus`, which independently authorizes
   before querying.

Nothing forbidden is required: no login-only access, no email domain, no allow-list,
no environment variable.

## Deferred

- **Login, logout, and signup surfaces** of any kind — UI or route.
- **A controlled operator-bootstrap command** and its audit trail.
- **Email verification, password recovery**, and any outbound email.
- **OAuth, social login, MFA**, and session-device management.
- **Organizations, memberships, and Seller/Promoter activation** — the thesis
  defines these, and they are a separate phase.
- **General RBAC**, permission administration, and a grant/revoke audit log.
- **Rate limiting and lockout** on repeated authentication failures — the timing
  and message defences here address enumeration, not brute force at volume.
- Production identity integration, deployment wiring, Stripe, and marketplace UI.
