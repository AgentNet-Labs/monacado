# Single-Run Publication Orchestration (Phase 0E.6.3)

`runOneProductPublication` claims and processes **at most one** due Product
publication outbox item, then returns.

There is no worker, no scheduler, no cron, no polling loop, and no automatic
resend. Deciding to invoke again is the caller's job.

Validated against the disposable local database with **injected fake
transports** only. No external Registrar is contacted anywhere in this phase.

## One item per invocation

The flow is deliberately linear and unrepeatable:

1. validate input;
2. validate runtime configuration and construct the transport;
3. claim **one** due item;
4. prepare **one** submission attempt;
5. invoke the transport **exactly once**;
6. apply the outcome through a guarded write.

No loop, no recursion, no second claim. A step that finds nothing to do returns
early rather than looking for other work.

**Recovery of expired claims is not performed here.** It is a separate caller
responsibility — `recoverExpiredPublicationOutboxClaims`, documented in
[`PRODUCT_PUBLICATION_LEASE_RECOVERY.md`](PRODUCT_PUBLICATION_LEASE_RECOVERY.md).
Folding a sweep into this call would make one invocation mutate items it never
processes, which is exactly the surprise a single-run contract exists to avoid.

## Composition, not reimplementation

Claiming, lease rules, attempt preparation, dispatch guards, and outcome
persistence all live in earlier phases and are **called**, never duplicated. What
is new here is the decision table below, and the boundaries around it.

## No transaction spans the HTTP request

Three separate committed boundaries, with the network call between the second and
the third:

| Boundary | What commits |
| --- | --- |
| 1. Claim | outbox → `PROCESSING`, lease taken |
| 2. Preparation | one immutable `PREPARED` attempt |
| — | **HTTP request — no transaction open** |
| 3. Outcome | guarded update of attempt and outbox |

Holding a transaction open across a call that can hang for the whole timeout
would pin a connection and hold row locks against every other worker. A test
proves the claim is visible as committed *while* the transport is still running.

Because of this split, a failure **before** transport leaves no falsely
dispatched attempt, and a confirmed or ambiguous transmission always preserves
`DISPATCHED`.

## Transport-outcome rules

| Transport outcome | Attempt | Outbox | Run result |
| --- | --- | --- | --- |
| `SUCCESS` | DISPATCHED | PROCESSING | `SENT` |
| `REMOTE_REJECTION` | DISPATCHED | PROCESSING | `REMOTE_REJECTION` |
| `RETRYABLE`, not transmitted | ABANDONED | RETRYABLE | `RETRY_SCHEDULED` |
| `RETRYABLE`, transmitted | DISPATCHED | PROCESSING | `AMBIGUOUS_DELIVERY` |
| `TERMINAL` | ABANDONED (if never sent) | DEAD_LETTER | `DEAD_LETTERED` |
| `AMBIGUOUS_DELIVERY` | DISPATCHED | PROCESSING | `AMBIGUOUS_DELIVERY` |

### SUCCESS is not registration

A 2xx `ACCEPTED` response returns `SENT` and **nothing else changes**: the
publication stays `NOT_SUBMITTED`, the payload is retained, and **no
`RegistrarReceipt` is created**.

Turning a response into authoritative registration requires the full Phase 0E.4
path — naming the exact attempt and reconciling Registrar, Node, capsule, and
hash. A test asserts the receipt count is still zero after a successful send.

### Remote rejection is not receipt rejection

A Registrar answering "no" is a **successful exchange**, not a transport failure,
so it must not dead-letter. The claim and payload are preserved and the attempt
stays `DISPATCHED`.

> An authoritative `REJECTED` state still requires a reconciled receipt naming
> this attempt. A non-receipt HTTP response is evidence, never authority.

This is why a bare HTTP rejection does not park the item: doing so would let an
unauthenticated, unreconciled response decide a governed outcome.

### Retryable means "proven undelivered"

Only a failure that provably preceded transmission is rescheduled. A retryable
classification that **did** transmit — a 5xx, say — is treated as
`AMBIGUOUS_DELIVERY` instead: we cannot prove the Registrar did not process it,
and resending would risk a duplicate registration.

### Terminal failures keep a dispatched attempt

A `DISPATCHED` attempt is left alone even when dead-lettering, because it may
still be answered by a late receipt and abandoning it would discard that
evidence. Only an attempt that provably never left is retired.

An **application configuration** error is never converted into a Registrar
rejection: it surfaces as `TERMINAL_FAILURE` or a thrown configuration error, and
the Registrar is not implicated.

### Ambiguous delivery protects against duplicates

Nothing moves. The attempt stays `DISPATCHED`, the item stays `PROCESSING` under
its lease, nothing is rescheduled, and nothing is dead-lettered.

Resolving an ambiguous attempt is a governed decision
([`PRODUCT_PUBLICATION_REMEDIATION.md`](PRODUCT_PUBLICATION_REMEDIATION.md)) or a
later receipt naming that attempt — never an automatic reflex.

A second invocation while the lease is live simply reports `NO_ELIGIBLE_WORK`, so
an ambiguous attempt cannot be resent by re-running.

## Retry scheduling

The caller supplies `retryAvailableAt` explicitly. There is **no backoff
framework, no jitter, no attempt cap, and no clock read**.

If a retryable failure occurs and no retry time was supplied, the run **throws**
rather than inventing one — choosing a retry instant would be this module reading
a clock and picking a policy, which is precisely the decision the phase leaves
with the caller. The claim remains held and is reclaimed by the normal
lease-expiry sweep.

Repeated-failure escalation (attempt caps, escalating backoff, alerting) is
**deferred**.

## Stale-worker protection

The outcome write is guarded. If the claim is no longer current — recovered by an
expiry sweep, re-claimed, remediated, or its publication settled — the write is
refused with `RunStateConflictError` and the newer state stands.

A test recovers the lease *during* the transport call and asserts the stale run
overwrites nothing.

A `CLOSED` or `RESOLVED` publication is refused before any request is sent.

## Post-transport persistence failure

If the request went out but its consequence could not be recorded, the run
reports `PostTransportPersistenceFailureError`, carrying only whether the request
was transmitted.

**It never resends.** The durable record no longer describes the outside world,
and the Registrar may already hold the registration; that is an operator
investigation, not something to retry blindly.

## Runtime configuration

Only `DISABLED` or `READY` is accepted
([`PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md`](PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md)).

- `DISABLED` returns immediately — **no secret lookup, no query, no mutation**.
  Claiming an item we could never send would lock real work behind a lease for
  nothing.
- `INCOMPLETE` or `INVALID` throws **before** any item is claimed.
- Exact-origin validation happens before the secret is read, inside the Phase
  0E.6.2 factory.
- The orchestrator reads no `process.env`; the environment is injected.

## Result and error safety

The result carries identifiers, state names, a bounded HTTP status, and an
explicit retry time. It never carries the payload, a credential, a lock token, a
token hash, an integrity hash, a response body, a raw network error, or a
database detail. `DISABLED` and `NO_ELIGIBLE_WORK` carry no identifiers at all,
so they reveal nothing about the queue.

Five error classes, each with a real throw site: `InvalidRunInputError`,
`RuntimeNotReadyError`, `RunRetryTimeRequiredError`, `RunStateConflictError`,
`PostTransportPersistenceFailureError`. All reuse the non-enumerable
internal-cause pattern.

Most abnormal endings are **not** errors — a retryable failure, a terminal remote
failure, and an ambiguous delivery are ordinary results, because a caller must
distinguish eight outcomes and act differently on each.

## Operational caller responsibilities

A caller invoking this must decide:

- **when** to invoke, and how often;
- whether to run a **recovery sweep** first;
- the **retry instant** on a retryable failure;
- what to do about `AMBIGUOUS_DELIVERY` (governed remediation, or wait for a
  receipt);
- what to do about `DEAD_LETTERED` and `TERMINAL_FAILURE`;
- how to **ingest receipts**, which nothing in this phase does.

## Deferred

- **The worker loop** — scheduling, polling, concurrency, backoff, escalation.
- **Receipt ingestion** — callbacks, webhooks, or polling that turns a response
  into a reconciled receipt.
- **Monitoring** of outcomes, ambiguity rates, and latency.
- **Production deployment wiring** and live Registrar calls.
- Resolver integration; authentication; Stripe; UI; Storefront, Listing, Offer,
  Review, and Buyer functionality.

## See also

- [`PRODUCT_REGISTRAR_TRANSPORT.md`](PRODUCT_REGISTRAR_TRANSPORT.md) — the single
  send and its five-way classification.
- [`PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md`](PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md)
  — claiming, leases, and outbox transitions.
- [`PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md`](PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md)
  — attempt identity and receipt binding.
- [`PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md`](PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md)
  — configuration, allow-listing, and credentials.
