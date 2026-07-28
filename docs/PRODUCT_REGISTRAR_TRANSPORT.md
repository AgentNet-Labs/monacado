# Registrar REGISTER Transport (Phase 0E.6.1)

The outbound HTTP boundary: sending one already-prepared Product REGISTER
submission attempt to a Registrar, and reporting precisely what happened.

Validated **only against a local loopback mock server**. No external host is
contacted anywhere in this phase, and there are no production credentials or
endpoint values in the repository.

## The transport boundary

Everything durable was decided before this point. Phase 0E.5.3 produced a
`PREPARED` submission attempt that already fixed the Node, capsule, expected
content hash, and payload hash. This phase only puts that on the wire.

What the adapter deliberately does **not** do:

- read the database — it is handed a built request;
- read environment variables or files — credentials are **injected**;
- retry — one call is one attempt;
- follow redirects — a response must not be able to steer our egress;
- log request or response bodies.

## The three concerns, kept apart

This is the distinction the whole phase exists to preserve:

| | Meaning |
| --- | --- |
| **Transport failure** | We could not complete an exchange with the Registrar. |
| **Registrar rejection** | The Registrar answered, and its answer was "no". The exchange worked perfectly. |
| **Receipt reconciliation** | Whether that answer actually describes the attempt we sent — a **Phase 0E.4** question, settled elsewhere. |

Conflating the first two loses the difference between "try again" and "stop".
Conflating the second and third would let a Registrar's word be taken without
checking it names our attempt.

## Request and response contracts

The request envelope carries **protocol identifiers and the capsule, nothing
else**:

`protocol`, `version`, `operation`, `submissionAttemptId`, `publicationId`,
`outboxId`, `idempotencyKey`, `registrarId`, `nodeId`, `capsuleId`,
`publishedContentHash`, `capsule`.

Deliberately absent: internal row ids, the raw `lockToken`, the `claimTokenHash`,
source-record internals, internal error detail, and **any credential** —
authentication travels in headers, never in the body.

Identifiers come from the attempt's immutable record, so what we send is provably
what the attempt committed to. The capsule is carried through **verbatim**; it is
never regenerated, because `payloadHash` is a promise about those exact bytes.
The builder is pure and deterministic: identical inputs serialise to byte-equal
canonical JSON.

The response envelope is a `strictObject` that **rejects unknown keys**. An
unrecognised field means we are talking to something we do not understand, which
is terminal rather than something to shrug off. It is **not a receipt** — it is
evidence a later ingestion step may turn into one.

## Credential injection

The adapter asks an injected `RegistrarCredentialProvider` for outbound material
and nothing else. That keeps secret sourcing a composition-root decision and
makes it trivial to prove in tests that nothing real is used.

- No credential is persisted, logged, or returned in any result or error.
- `Content-Type` is set by the adapter and cannot be overridden.
- Additional headers pass **two barriers**: a tiny allow-list
  (`x-registrar-client`, `x-registrar-key-id`, `x-request-id`) *and* an explicit
  denylist of framing, forwarding, and ambient-auth headers (`host`,
  `content-length`, `connection`, `cookie`, `x-forwarded-*`, `proxy-*`, …). The
  denylist is a backstop should the allow-list ever be widened carelessly.
- Header names must be RFC 7230 tokens and values single-line printable ASCII, so
  a CRLF cannot be smuggled in to split the request.

A refused header reports `ForbiddenTransportHeaderError` — not "missing
credentials", which would misdescribe the fault.

## SSRF and endpoint safety

The endpoint is supplied **explicitly by the caller**, never derived from capsule
or Registrar-supplied data, so content can never steer where we connect.

| Rule | Refuses |
| --- | --- |
| `scheme` | anything but `https:` / `http:` — no `file:`, `ftp:`, `data:` |
| `insecure-scheme` | plain `http:` to a non-loopback host |
| `embedded-credentials` | `https://user:pass@host/…` |
| `fragment` | a `#fragment`, which is never sent and signals a pasted browser URL |
| `host` | a URL naming no host |

Redirects are **disabled** (`redirect: "manual"`); a 3xx is reported as terminal
rather than followed. Endpoint issues name the failing **rule**, never the URL —
an endpoint can carry a host or path that should not be echoed into logs.

> **Production endpoint allow-listing is still required before deployment.** This
> module proves an endpoint is *shaped* safely; it cannot know which hosts are
> legitimate Registrars. That list belongs to deployment configuration and is
> deliberately absent from this phase.

## Timeouts and response bounds

Every request carries an explicit deadline enforced through `AbortController`,
bounded to 100 ms … 120 s — a zero timeout would abort before the request could
leave, and an unbounded one would let a hung connection occupy a claim for its
whole lease.

The response body is read through a bounded reader (default 64 KiB, max 1 MiB),
checking `content-length` first and then counting bytes as they arrive. A
Registrar that streams more is either broken or hostile; either way we stop
rather than buffer it.

## Failure classification

| Outcome | When | `transmitted` |
| --- | --- | --- |
| `SUCCESS` | valid 2xx envelope with `status: ACCEPTED` | true |
| `REMOTE_REJECTION` | valid 2xx envelope with `status: REJECTED` | true |
| `RETRYABLE_TRANSPORT_FAILURE` | DNS/connect failure before transmission; 408, 425, 429; any 5xx | false / true |
| `TERMINAL_TRANSPORT_FAILURE` | other 4xx (protocol, auth, config); 3xx redirect; unparsable or unknown-key response; oversized response; TLS misconfiguration | varies |
| `AMBIGUOUS_DELIVERY` | timeout, or an exchange interrupted after the request left | true |

**`transmitted` is the field that matters downstream.** It means "the request may
have reached the Registrar", and is `false` **only** when we can prove otherwise
— a connection that was never established. Everything unclassifiable is treated
as possibly-delivered, because guessing "not delivered" and being wrong causes a
duplicate registration, while the reverse merely costs a governed retry.

## Ambiguous delivery

A timeout is not a failure to send; it is a failure to *hear back*. The request
may well have been processed. So ambiguity resolves conservatively:

- the attempt is marked **DISPATCHED**;
- the outcome returned is `AMBIGUOUS_DELIVERY`;
- **nothing is resent automatically.**

Resolving an ambiguous attempt is a governed decision (Phase 0E.5.2 remediation)
or a later receipt naming that attempt — never an automatic reflex here.

## Attempt dispatch semantics

`sendPreparedPublicationAttempt` orchestrates exactly one send:

1. load the `PREPARED` attempt, its publication, and its work item;
2. refuse a `CLOSED` or `RESOLVED` publication;
3. verify the claim is still `PROCESSING`, owned by the presented `lockToken`,
   with an **unexpired lease** judged against the explicitly supplied `now`;
4. build the request from the immutable attempt and the retained payload;
5. invoke the transport **once**;
6. mark the attempt `DISPATCHED` **iff** `transmitted` — otherwise it stays
   `PREPARED` and remains reusable by the same claim.

Every guard runs *before* the transport call, so a wrong token, an expired lease,
a settled publication, or a payload-hash mismatch costs no network traffic at all.

## No automatic retries

`RETRYABLE_TRANSPORT_FAILURE` means "retrying is *permitted*", not "retrying
happened". The adapter never retries, and the dispatch service never retries.
Only a layer that can see attempt history can decide that safely — retrying
blindly after an ambiguous send is exactly how duplicates occur.

## Separation from receipt reconciliation

**No `RegistrarReceipt` row is created in this phase.** An immediate acceptance
is returned as `registrarResponse` and nothing more: the publication stays
`NOT_SUBMITTED`, no payload is disposed, and nothing is registered.

Turning that response into a receipt requires the full Phase 0E.4 path — naming
the exact attempt, reconciling Registrar/Node/capsule/hash, and updating state
transactionally. A test asserts precisely this: after a successful send, the
receipt count is zero and resolution still requires
`recordRegistrarReceipt`. See
[`PRODUCT_REGISTRAR_RECEIPTS.md`](PRODUCT_REGISTRAR_RECEIPTS.md) and
[`PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md`](PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md).

## Error model

Exceptions are reserved for **preconditions that stop a send from being attempted
at all**:

`InvalidRegistrarEndpointError`, `ForbiddenTransportHeaderError`,
`MissingRegistrarCredentialsError`, `RegisterRequestContractFailureError`,
`DispatchStateConflictError` (plus the shared `ValidationError` for malformed
input).

Everything that can happen *during* an exchange — timeout, connection failure,
oversized body, malformed response, ambiguous delivery — is deliberately **not**
an exception. Those are `TransportResult` values with an `outcome` and a bounded
`failure` detail, because a caller must distinguish five outcomes and act
differently on each; an exception is a poor carrier for that. Do not write
`catch` blocks expecting a timeout or a rejection — inspect the result.

All errors reuse the hardened **non-enumerable internal cause** pattern. None
expose credentials, the request payload, the response body, integrity hash
values, a raw `lockToken`, a `claimTokenHash`, an endpoint URL, or a raw
network-library error. What is surfaced: stable codes, rule names, and bounded
HTTP status numbers.

## Local mock-server validation

Every network test starts a `node:http` server bound to `127.0.0.1` on an
ephemeral port and tears it down afterwards. Timeouts, redirects, oversized
bodies, malformed envelopes, and pre-connect failures are all exercised against
it. The suite was run repeatedly to confirm the timing-sensitive cases are
stable.

## Deferred

- **Production endpoint allow-listing** and real Registrar endpoint values.
- **Production credentials** and their storage, rotation, and scoping.
- **Worker orchestration** — a process that claims, prepares, sends, and resolves;
  scheduling; polling; automatic retry with backoff.
- **Monitoring** of transport outcomes, ambiguity rates, and latency.
- **Receipt ingestion** — turning a response (or a later callback/webhook) into a
  reconciled `RegistrarReceipt`.
- Resolver integration; production DB wiring; authentication; Stripe; UI.
