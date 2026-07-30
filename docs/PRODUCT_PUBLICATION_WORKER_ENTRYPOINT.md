# Executable Publication Worker Entry Point (Phase 0E.7.2)

One command. One bounded cycle. Then the process ends.

```
npm run worker:publication:once
```

`scripts/run-publication-worker.ts` validates operational configuration, installs
shutdown handling, invokes **exactly one**
`runProductPublicationWorkerCycle`, emits safe machine-readable output, releases
what it owns, and returns.

## What this is not

There is no daemon, no scheduler, no cron, no `setTimeout`/`setInterval`, no
sleep, no polling, no self-rescheduling, no restart, and no loop around the cycle.
Deciding to run a second cycle stays entirely outside: a supervisor invokes the
command again.

That is what makes the command safe to run by hand, from `db:check`, or from a
future scheduler without any of them inheriting a hidden loop
([`PRODUCT_PUBLICATION_WORKER_CYCLE.md`](PRODUCT_PUBLICATION_WORKER_CYCLE.md)).

## Worker environment variables

All server-only. None is `NEXT_PUBLIC_`, and **none holds a secret** — the
credential's *location* stays in the Registrar configuration
([`PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md`](PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md)),
and its value is resolved only when a request is signed.

| Variable | Required when enabled | Bounds |
| --- | --- | --- |
| `MONACADO_PUBLICATION_WORKER_ENABLED` | — (master switch) | `true`/`1`/`yes` enables; anything else disables |
| `MONACADO_PUBLICATION_WORKER_MAX_RUNS` | yes | `1 … 100` (the Phase 0E.7.1 bound) |
| `MONACADO_PUBLICATION_WORKER_LEASE_SECONDS` | yes | `1 … 86400` |
| `MONACADO_PUBLICATION_WORKER_RETRY_DELAY_SECONDS` | yes | `1 … 86400` |
| `MONACADO_PUBLICATION_WORKER_RECOVERY_ENABLED` | no | boolean; default `false` |
| `MONACADO_PUBLICATION_WORKER_RECOVERY_LIMIT` | when recovery is enabled | `1 … 1000` |
| `MONACADO_PUBLICATION_WORKER_OUTPUT_MODE` | no | `JSON_LINES` (default) or `SILENT` |
| `MONACADO_PUBLICATION_WORKER_CYCLE_ID` | no | `[A-Za-z0-9._:-]{1,64}` |

An **unrecognised** `MONACADO_PUBLICATION_WORKER_*` variable is refused outright,
before the enable flag is even read. The dangerous typo is in the switch itself:
`…_WORKER_ENABLE=true` would otherwise leave the worker silently disabled and an
operator convinced it was running. Failing loudly costs a clear error; failing
quietly costs a queue that never drains.

The parsed configuration is bounds, a mode, and an optional correlation id —
nothing else, and no arbitrary metadata map.

## Disabled by default

With `MONACADO_PUBLICATION_WORKER_ENABLED` unset, the command emits one
`worker.disabled` line and exits `0`, having performed:

- **no database query** — no client is even constructed;
- **no secret read** — the secret source is never touched;
- no signal-handler installation;
- no transport construction.

There are deliberately **no defaults** for the bounds. An unconfigured deployment
publishes nothing rather than guessing, and there is no default that could
accidentally enable publication.

A disabled configuration may omit every Registrar and cycle value. An **enabled**
one requires all three cycle inputs *and* a `READY` Registrar configuration: an
enabled worker paired with a disabled Registrar is reported as `INCOMPLETE`,
because the operator asked for a cycle that could never send anything.

## Four load states

`DISABLED`, `INCOMPLETE`, `INVALID`, `READY` — the same vocabulary as Phase
0E.6.2, because each calls for a different operator response. A malformed or
unfinished load is a **state, not an exception**: a one-shot command must emit a
safe machine-readable line and a non-zero exit code, and nobody needs a stack
trace to be told a variable is unset.

## Process lifecycle

Ordering is a safety property, not a style choice.

Phase 0E.7.3 adds two durable steps to this sequence — a `STARTED` row immediately
before the cycle and a terminal row immediately after it. Their two
persistence-failure rules are deliberately asymmetric (a failed `STARTED` write
stops the command; a failed terminal write never reruns the cycle) and are
documented in
[`PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md`](PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md).
Disabled and rejected invocations still create no database client, so they persist
no row.

1. **Load** worker and Registrar configuration from `process.env`. This is the
   only read of `process.env` in the publication path; every collaborator receives
   an injected environment object.
2. **Disabled** → one line, exit `0`, return. Nothing else happens.
3. **Invalid / incomplete** → safe issue code and configuration **field names
   only**, non-zero exit code, nothing claimed.
4. **Registrar readiness** — `validateRegistrarRuntimeReadiness` re-applies the
   exact-origin allow-list **before** checking that the credential is present, so
   a misconfigured endpoint never causes a secret to be read. Presence only; the
   value is never read here.
5. **Construct** the credential provider and configured transport, the time
   provider, the submission-attempt id provider, the fixed retry-timing provider,
   the monitoring hooks, and the shutdown signal — then the database client.
6. **Invoke one** `runProductPublicationWorkerCycle`. The entry point passes the
   transport it constructed, so exactly one transport exists per command.
7. **Emit** the final validated cycle result.
8. **`finally`**: unregister signal handlers, then disconnect what the command
   owns.
9. **Set** `process.exitCode` and **return**.

Every check that can refuse to run happens *before* anything can be claimed, so
**a startup failure cannot leave a claimed outbox item behind** — at the moment it
is raised, nothing had been claimed. Once the cycle begins, the Phase 0E.7.1 and
0E.6.3 guarantees are authoritative
([`PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md`](PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md)).

The command opens **no transaction of its own**, so none can span the HTTP call or
two runs.

## It never calls `process.exit`

`main` sets `process.exitCode` and returns, letting Node exit naturally once the
event loop drains.

`process.exit` would truncate a pending stream write and, worse, could kill the
process mid-request — abandoning an in-flight registration whose outcome has not
been recorded, which is exactly the ambiguity the publication path works to avoid.
A test asserts both that `process.exit` is never called and that the source
contains no call to it.

## Signal handling

`createProcessShutdownSignal` (Phase 0E.7.1) translates SIGTERM/SIGINT into the
boolean the cycle polls.

- Handlers install **only after configuration is valid enough to run** and the
  dependencies are built. Installing them earlier would change how the process
  responds to a signal during a run that never happens. A disabled or rejected
  invocation installs none.
- `unregister()` runs in `finally`, removes exactly the handlers this command
  installed, and is idempotent — **no listener survives `main`**, asserted by a
  test that compares listener counts before and after.
- The flag latches; the adapter never calls `process.exit`.

A shutdown request is a **successful** outcome: `SHUTDOWN_REQUESTED` exits `0`,
because an operator who asked us to stop got what they asked for.

## Safe JSON-lines monitoring

One JSON object per line, on an **injected** sink, so a test asserts the exact
bytes and only the production command touches a real stream. No logging framework
and no `console`: `console.log` interleaves and reformats, and a dependency would
be a lot of surface area for `write(line + "\n")`.

Each line carries `event`, `at` (UTC ISO), `cycleId`, and that event's own safe
fields.

| Event | Stream |
| --- | --- |
| `worker.disabled` | stdout |
| `worker.cycle_started` | stdout |
| `worker.expired_claims_recovered` | stdout |
| `worker.run_started` | stdout |
| `worker.run_completed` | stdout |
| `worker.cycle_completed` | stdout |
| `worker.result` | stdout |
| `worker.configuration_rejected` | stderr |
| `worker.registrar_not_ready` | stderr |
| `worker.startup_failure` | stderr |
| `worker.run_failed` | stderr |
| `worker.cleanup_failed` | stderr |
| `worker.monitoring_failure` | stderr |

**stdout carries the run's story; stderr carries what an operator must act on** —
so a shell pipeline can consume the narrative cleanly while failures survive a
caller that discards stdout.

### Allow-list, not deny-list

Every line is assembled from **explicitly named fields**. Nothing is spread from a
domain object, so a field added to a contract later cannot appear in the output by
accident — it appears only when someone writes it in the adapter and decides it is
safe. Counts records are copied numeric-entry by numeric-entry, and issue codes
that do not already match the shared safe-code shape are **dropped** rather than
truncated, because an unrecognised string is exactly where a raw driver message
would arrive.

Never emitted: a capsule or request payload, a receipt body, a credential, the
NAME of a secret variable, an endpoint or any URL, an integrity or content hash, a
lock token, a claim-token hash, the environment, or a raw Prisma/Zod/network
error.

### Output failure cannot cause a resend

A sink that throws, or a value that will not serialise, is contained in the
adapter: it attempts one minimal fallback line and otherwise counts the failure
and returns. It never throws at the cycle, never changes an outcome, and never
triggers a resend — a line written after a request was transmitted cannot unsend
it. The Phase 0E.7.1 cycle independently swallows a throwing hook as a
`MONITORING_HOOK_FAILURE` issue code.

`SILENT` mode returns before serialising, so an embedding caller pays nothing.

## Exit-code policy

| Code | Meaning |
| --- | --- |
| `0` | `DISABLED`, `COMPLETED`, `NO_WORK`, `RUN_LIMIT_REACHED`, `SHUTDOWN_REQUESTED` |
| `1` | the cycle returned `FAILED`, or threw |
| `70` | a runtime dependency could not be constructed, or the durable `STARTED` row could not be written (sysexits `EX_SOFTWARE`) |
| `75` | the cycle succeeded but its durable terminal record could not be written (sysexits `EX_TEMPFAIL`) |
| `78` | configuration invalid, incomplete, or not ready (sysexits `EX_CONFIG`) |

`75` is distinct from `1` deliberately: "the cycle failed" and "the cycle succeeded
but we could not record it" call for opposite responses — investigate the
publication path versus investigate the status store — and collapsing them would
send an operator to the wrong place
([`PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md`](PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md)).

The mapping from cycle outcome to exit code is a **closed record**, so a new
outcome without an exit code is a type error rather than a silent success.

A cycle that **completed coherently** is a success regardless of what the
Registrar said. `SENT`, `REMOTE_REJECTION`, `RETRY_SCHEDULED`, `DEAD_LETTERED`,
and `AMBIGUOUS_DELIVERY` are all correctly-recorded business outcomes; exiting
non-zero for them would make a supervisor treat "the Registrar declined this
product" as "the worker is broken".

The two sysexits values are borrowed deliberately: an operator reading `78` sees a
configuration problem and `70` an internal one, without consulting a table.

## Resource cleanup

- The command disconnects **only what it created**. A `dbCreated` flag guards
  against a double disconnect and against releasing a client an embedding caller
  owns (`db:check` passes its own client with a no-op `disconnect`).
- Cleanup runs after success, after a failed cycle, and after a startup failure.
- **Cleanup failure is tolerated.** The cycle has already finished, nothing remains
  to undo, and it must never change the outcome or start another cycle. Only a
  bounded code (`RESOURCE_CLEANUP_FAILURE`,
  `SHUTDOWN_HANDLER_CLEANUP_FAILURE`) is reported — never the underlying message,
  which is where a connection string would appear.
- The command starts no MySQL and no external service.

## Time, identity, and fixed retry timing

`src/server/product/worker-runtime-providers.ts` is the **only** place in the
publication path that reads a real clock or generates randomness. Everything
downstream receives instants and identities through injected interfaces with no
fallback to `Date.now()` — which is what lets every domain test control time
exactly, and lets a reviewer find every clock read by opening one file.

- **`SystemTimeProvider`** — `new Date()`, in the runtime adapter only.
- **`RandomSubmissionAttemptIdProvider`** — `mon:attempt:<26 Crockford chars>`
  from `crypto.randomBytes`, validated against the existing contract before it is
  returned. `randomBytes` rather than `Math.random` because an attempt identifier
  is the key a Registrar receipt must name, so a predictable one would let a third
  party assert which attempt a receipt answers. No id is generated during
  configuration validation; **one is produced only when the cycle asks**.
- **Cycle id** — caller-supplied, else the configured value, else generated once at
  startup. Opaque, bounded, and safe to echo on every line.
- **`FixedDelayRetryTimingProvider`** — `nextRetryAvailableAt = attemptedAt +
  delay`, applied to an **explicitly supplied** instant. No clock read, no jitter,
  no backoff curve, no attempt-count input, so the same inputs always produce the
  same instant. The bound is re-asserted at construction rather than trusted from
  the loader.

This policy is consulted only for a retryable failure **proven not to have been
transmitted**. Ambiguous delivery never reaches it: the orchestration leaves such
an item `PROCESSING` under its lease and schedules nothing, so nothing is resent
on the strength of a guess.

> **Deferred:** jitter, exponential backoff, and per-item attempt caps. Each
> changes when work becomes eligible, which is a durable scheduling decision that
> deserves its own phase rather than being smuggled in as a provider detail.

## Optional stale-claim recovery

When `…_RECOVERY_ENABLED` is set, the command passes a bounded sweep to the cycle,
which runs it **once at cycle start**
([`PRODUCT_PUBLICATION_LEASE_RECOVERY.md`](PRODUCT_PUBLICATION_LEASE_RECOVERY.md)).
Recovered items become eligible at the cycle's own start instant — explicit, never
computed inside the sweep. Only safe counts reach the output.

## No automatic receipt ingestion

The command creates no `RegistrarReceipt` and calls no ingestion path. A sent
attempt is left `DISPATCHED`, awaiting an explicit, separately-authorised
ingestion
([`PRODUCT_REGISTRAR_RECEIPT_INGESTION.md`](PRODUCT_REGISTRAR_RECEIPT_INGESTION.md)).
`db:check` asserts the receipt count is unchanged after a successful command.

## Error model

One error class, `WorkerDependencyConstructionFailureError`, with one code and a
closed set of stage names (`transport`, `retryTiming`, `database`, `clock`). It is
raised before anything can be claimed.

Deliberately **not** errors, each for a reason: invalid and incomplete
configuration (result states), monitoring output failure (contained in the
adapter), resource cleanup failure (a bounded issue code after the cycle has
finished), and direct-runner failure (the guard returns a boolean and `main`
classifies its own faults, which is what makes the exit code deterministic).
Classes mirroring the configuration states were written and removed as unreachable
vocabulary, following the same cleanup applied in Phases 0E.6.1 and 0E.6.2.

Errors carry a code and a stage name only, and reuse the hardened non-enumerable
internal-cause pattern, so `JSON.stringify(error)` cannot leak a retained cause.

## Package command

```json
"worker:publication:once": "tsx scripts/run-publication-worker.ts"
```

One process, one cycle, then exit. No watch mode, no `nodemon`, no scheduler, no
shell loop, no automatic restart, no embedded secret, and no default enabled
configuration. A test asserts the script string contains none of those.

Nothing runs on **import**: `main` is exported for tests and invoked only behind a
direct-execution guard. The guard matches this file's name in `argv[1]` rather
than using `import.meta.url` or `require.main`, because the repository ships no
`"type": "module"` — the same source is loaded as CJS by `tsx` and as ESM by
Vitest, and only one of those idioms exists in each. `dotenv/config` is imported
inside the guard, so importing the module for its exports cannot mutate a test's
environment.

## Local test usage

Everything ambient is injectable: environment, secret source, clock, randomness,
output sink, exit-code target, shutdown signal, database client, disconnect,
transport, and `fetch` — plus the cycle function itself, so a test asserts it runs
exactly once.

- `test/publication-worker-entrypoint.test.ts` — no database, no network.
- `npm run db:check` — a command-level walkthrough against the disposable local
  MySQL with a fake transport: a disabled invocation leaves the queue untouched,
  an enabled one runs exactly one bounded cycle within `maximumRuns`, no receipt
  is created, no signal listener survives, the output is valid JSON with nothing
  sensitive in it, and cleanup leaves FK-safe state.

No test contacts an external Registrar or opens a socket.

## Deferred

- **Deployment.** No deployment manifest, cron configuration, systemd unit, Render
  job, Vercel cron, GitHub Actions worker, or process manager. Choosing an
  invocation cadence and a supervisor is a deployment decision, and this phase
  deliberately supplies a command it can call rather than making that choice.
- **Production secret provisioning**, rotation, and scoping; real endpoint values.
  There is no real endpoint, Registrar identifier, or credential in this
  repository.
- **Production database wiring.**
- Automatic repeated cycles, scheduling, polling, and restart policy.
- A monitoring backend, metrics export, and alerting — this phase emits lines; it
  ships nothing that consumes them.
- Automatic receipt ingestion, webhooks, and pollers; live Registrar calls;
  authentication and authorisation; Resolver integration; Stripe; UI; Storefront,
  Listing, Offer, Review, and Buyer functionality.
