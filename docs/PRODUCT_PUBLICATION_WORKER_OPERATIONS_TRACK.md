# Phase 0E.7 — Publication Worker Operations Track: Status and Closure

The 0E.7 track took publication from "a bounded cycle exists" to "an authorized
operator can ask how the worker is doing, over HTTP, and get a safe answer."

**With Phase 0E.7.4.2B complete, this track is closed.**

## Completed capabilities

| Capability | Phase |
| --- | --- |
| **Bounded worker cycle** — single-run orchestration at most `maximumRuns` times, then returns | 0E.7.1 |
| **One-shot executable** — `npm run worker:publication:once`, one cycle per invocation | 0E.7.2 |
| **Runtime configuration** — strict, disabled-by-default, bounded, secret-free | 0E.7.2 |
| **Signal handling** — SIGTERM/SIGINT cooperative shutdown, handlers unregistered in `finally` | 0E.7.2 |
| **Safe JSON Lines monitoring** — allow-listed fields, stdout/stderr policy, contained failures | 0E.7.2 |
| **Durable worker-run records** — one bounded row per runnable invocation | 0E.7.3 |
| **Worker health assessment** — pure, explicit-time, deterministic precedence | 0E.7.3 |
| **Internal status application service** — authorize-before-query, bounded reads, safe projection | 0E.7.4.1 |
| **Account / session / operator-entitlement prerequisite** | 0E.7.4.2A |
| **Authenticated internal status route** | 0E.7.4.2B |

| Phase | Commit |
| --- | --- |
| 0E.7.1 | `a556510` |
| 0E.7.2 | `3072d20` |
| 0E.7.3 | `1409e80` |
| 0E.7.4.1 | `9aac6a7` |
| 0E.7.4.2A | `8556579` |
| 0E.7.4.2B | *this phase* |

## The properties the track was built to hold

Each was established once and never relaxed by a later phase:

1. **The cycle always terminates.** No sleep, timer, polling, recursion, or
   self-rescheduling anywhere in the track. Deciding to run again is always
   external.
2. **Ambiguity never resends.** An item whose delivery cannot be disproven stays
   `PROCESSING` under its lease; nothing retries it.
3. **Publishing requires durable evidence.** A failed `STARTED` write stops the
   command; a failed terminal write never reruns the cycle, because by then the
   request is already sent.
4. **Evidence is never authority.** Worker-run rows record that a command ran;
   publication, outbox, attempt, receipt, and remediation records remain the sole
   authorities for what happened to the work.
5. **Codes and counts only.** No payload, receipt body, credential, endpoint, hash,
   token, environment value, or raw error reaches durable storage, monitoring
   output, an error, an audit event, or an HTTP response.
6. **Authorize before you query.** Established in 0E.7.4.1 and preserved as two
   independent boundaries in 0E.7.4.2B.
7. **Explicit time and identity.** Every instant and identifier is injected; the
   only clock reads and randomness live in named runtime adapters.

## 0E.7.4.2A was a cross-cutting prerequisite discovered during route implementation

The route phase was **correctly blocked** on its first attempt. The repository had
no account, session, membership, role, or entitlement, so the route could only have
been built on something the brief forbade — login-only access, an email domain, a
hard-coded allow-list, or an environment variable.

Identity was therefore **not** planned work inside the worker-operations track; it
was a cross-cutting dependency surfaced by trying to build the route honestly.
Rather than weaken the authorization rule, 0E.7.4.2A added the minimum foundation,
and 0E.7.4.2B then satisfied every original constraint without exception. That
block is the most useful thing the track produced: the alternative was an internal
endpoint whose access rule nobody would have wanted to defend.

**Git history and prior phase numbering remain unchanged.** 0E.7.4.2A was inserted
as a lettered prerequisite rather than by renumbering, so every earlier phase
number, commit, and document reference still means exactly what it meant when it
was written. Nothing was rewritten, amended, or resequenced.

## Closing state

- 10 migrations, all applied.
- `db:check`: **90** end-to-end checks.
- One executable command (`worker:publication:once`) and one HTTP route
  (`GET /api/internal/operations/publication-worker/status`).
- No daemon, scheduler, cron, polling loop, heartbeat, alert sender, dashboard,
  public endpoint, or automatic reconciliation exists anywhere in the track.

## Explicitly deferred

Each was named as deferred in the phase that surfaced it and remains open. None is a
defect in the track; each is a decision the track deliberately did not make.

**Operations**
- **Operator dashboard** — and any UI over worker status.
- **Scheduler or hosted cron** — nothing invokes the one-shot command automatically.
- **Production worker deployment** — choosing a cadence, a supervisor, and a host.
- **Production deployment validation** — no deployment has been exercised or proven.
- **Alerts and routing** — email, Slack, SMS, PagerDuty, webhooks; plus metrics
  export and a monitoring backend.
- **Retention purge** for worker-run history.
- Stale-run reconciliation invocation — the bounded operation exists; nothing calls
  it automatically, by design.

**Identity and access**
- **Service-account identity** — bearer tokens and `INTERNAL_SERVICE`.
- **General RBAC** and permission administration.
- **Production operator bootstrap** — a controlled, audited grant operation.
- **Authentication rate limiting and lockout** — on login and on the status route.
- Login, logout, and signup surfaces.
- Production audit integrity — durable, tamper-evident route audit.
- Email verification, password recovery, OAuth, MFA.

**Publication**
- Automatic receipt ingestion, webhooks, and pollers.
- Live Registrar calls; production secret provisioning and rotation.
- Advanced retry policy — jitter, exponential backoff, per-item attempt caps.

**Platform**
- Production database wiring; Resolver integration; Stripe.

## Phase 0E.7 closes after this route

With the authenticated internal status route in place, **the 0E.7
worker-operations track is closed.** No further worker-operations phase is planned;
the deferred items above are future work, not open track obligations.

## Development returns to the marketplace sequence

Subsequent development leaves worker operations and resumes the marketplace path,
in this order:

1. **Account / Seller / Promoter / Buyer** and activation-lifecycle reconciliation.
2. **Offer capsule** and persistence.
3. **Storefront and Listing capsules.**
4. **Seller / Promoter draft onboarding.**
5. **Activation profile and Stripe Connect.**
6. **Buyer purchase vertical slice.**

Step 1 will need to reconcile the Phase 0E.7.4.2A `Account` model — deliberately
minimal, credentials only — with the fuller marketplace account the product thesis
describes (registration, activation states, profiles, and roles). That
reconciliation is the natural first task of the marketplace sequence, not unfinished
worker-operations work.

**None of that work begins in this phase.**

## Reference

- [`PRODUCT_PUBLICATION_WORKER_CYCLE.md`](PRODUCT_PUBLICATION_WORKER_CYCLE.md)
- [`PRODUCT_PUBLICATION_WORKER_ENTRYPOINT.md`](PRODUCT_PUBLICATION_WORKER_ENTRYPOINT.md)
- [`PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md`](PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md)
- [`PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_SERVICE.md`](PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_SERVICE.md)
- [`PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_ROUTE.md`](PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_ROUTE.md)
- [`IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md`](IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md)
