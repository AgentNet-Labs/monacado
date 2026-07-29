# Registrar Receipt Ingestion (Phase 0E.6.4)

`ingestRegistrarReceipt` is the one narrow door through which a Registrar receipt
obtained **outside this system** enters it.

No polling, webhook, worker, or scheduler exists in this phase. A receipt arrives
as data, supplied by a caller. **Nothing is fetched** — the ingestion path makes
no network call, reads no credential, and looks up no endpoint.

## Trusted-caller boundary

> **Callers are assumed already trusted.** Authentication, authorisation, and
> webhook signature verification are **not implemented**. This boundary must not
> be exposed to an untrusted caller as it stands.

Actor authorisation remains deferred. The `source` field records *how* a receipt
reached us — `MANUAL`, `TRANSPORT_RESPONSE`, or `TEST_ADAPTER` — but it is a
label, not a credential, and nothing verifies it.

`WEBHOOK` and `POLLER` are deliberately absent from that enum: a source value
naming a mechanism that does not exist would let a caller claim a provenance
nothing can check.

## It owns no domain rules

Ingestion validates the envelope, checks one thing, and **delegates**.
Reconciliation, state transitions, remediation, payload disposal, and idempotency
all live in `recordRegistrarReceipt`
([`PRODUCT_REGISTRAR_RECEIPTS.md`](PRODUCT_REGISTRAR_RECEIPTS.md)) and are invoked
**exactly once**.

This module writes to no table. It never touches `ProductPublication`,
`PublicationOutbox`, `PublicationSubmissionAttempt`, `RegistrarReceipt`, or
`PublicationRemediation` directly — every authoritative mutation stays inside the
existing receipt service's transaction.

The reason is worth stating plainly: two doors into the same state, each with its
own opinion about what is true, is the worst bug available in this area. There is
one implementation of these rules, and ingestion is a caller of it.

Consequently the attempt guards this phase requires — the attempt exists, is
`DISPATCHED`, is not `ABANDONED`, has no conflicting authoritative receipt, and
binds to the named publication and outbox — are **enforced by the delegate and
not repeated here**. They are covered by tests through this boundary.

## The receipt envelope

Required: `receiptId`, `submissionAttemptId`, `publicationId`, `registrarId`,
`nodeId`, `capsuleId`, `registeredContentHash`, `receiptStatus`, `registeredAt`,
and bounded `receiptDetails`. `registrarRegistrationId` is required for an
`ACCEPTED` receipt — a rejection may have registered nothing.

`receivedAt` is supplied explicitly by the caller. No clock is read.

**Unknown keys fail.** The envelope is a `strictObject`, so these are refused
structurally rather than stripped:

| Refused | Why |
| --- | --- |
| `lockToken`, `claimTokenHash` | internal claim ownership is never supplied from outside |
| `payload` | the capsule is ours; a receipt asserts *about* it |
| row ids (`id`) | database internals are not part of any protocol |
| credentials | authentication never travels in a body |
| arbitrary metadata | `receiptDetails` is closed, not a bag |

Refusing rather than stripping matters: a caller attempting to smuggle a lock
token gets a loud failure instead of a silent discard that looks like success.

## Submission-attempt binding

A receipt answers **one exact outbound attempt**
([`PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md`](PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md)).
Reconciliation compares it against the attempt's **immutable** expectation
captured at preparation — not against whatever the publication says now.

### The expected-Registrar check

The one check ingestion performs itself. A caller holding trusted runtime context
may pass `expectedRegistrarId`; it is compared against the **attempt's immutable
`registrarId`**.

Comparing it against the envelope would be worthless — it would prove only that
the envelope agrees with itself, which a forged envelope also does.

A missing attempt is not diagnosed here; the receipt service reports it precisely.

## Result mapping

| Receipt status | Reconciliation | Outcome |
| --- | --- | --- |
| ACCEPTED | MATCHED | `ACCEPTED_MATCHED` |
| ACCEPTED | MISMATCH | `ACCEPTED_MISMATCH` |
| REJECTED | MATCHED | `REJECTED_MATCHED` |
| REJECTED | MISMATCH | `REJECTED_MISMATCH` |
| — | (already recorded) | `IDEMPOTENT_REPLAY` |

Acceptance and match are crossed because they are genuinely independent: a
Registrar can accept something while describing a different Node, and that is
neither a clean acceptance nor a rejection.

An idempotent replay wins over everything. Reporting `ACCEPTED_MATCHED` for a
replay would tell a caller its call caused a transition when the state was
already there.

### Matching acceptance

Attempt `RECEIPT_RECORDED`; registration `ACCEPTED`; reconciliation `MATCHED`;
remediation `RESOLVED`; outbox `COMPLETED`; **payload disposed**. Retained:
`payloadHash`, `publishedContentHash`, source-record pointers, mapping metadata,
and the immutable receipt.

### Mismatched acceptance

Evidence recorded; reconciliation `MISMATCH`; remediation `REQUIRED`; **payload
preserved**; registration is **not** marked `ACCEPTED`.

A Registrar accepting *something else* is not evidence that our publication was
registered, and treating it as such would resolve a publication on a claim about
a different object.

### Matching rejection

Evidence recorded; registration `REJECTED`; reconciliation `MATCHED`; remediation
`REQUIRED`; payload preserved.

### Mismatched rejection

Evidence recorded; reconciliation `MISMATCH`; remediation `REQUIRED`; outbox and
payload preserved under the existing rules.

## Payload-disposal boundary

The transient capsule payload is disposed **only** on a matched acceptance —
proven by `db:check`, which asserts the payload is present immediately before
ingestion and absent immediately after, and present after every other outcome.

Everything else keeps it, because every other outcome may still need a retry.

## Idempotency and conflicts

Delegated unchanged: an identical replay returns the existing result and creates
no second row; a conflicting `receiptId` fails; a conflicting registration
identifier fails; one authoritative receipt per attempt; an answered attempt
cannot receive another conflicting receipt. A refused conflict mutates nothing.

## Transport response versus authoritative receipt

`mapRegistrarTransportResponseToReceiptEnvelope` is pure and total: same input,
same output or same refusal.

> **A transport response is usually NOT a receipt.** It echoes an attempt and
> states a verdict; an authoritative receipt additionally asserts *what was
> registered, under which identifier, and when*. `RegisterResponseEnvelope` marks
> those fields optional precisely because a Registrar may acknowledge without
> registering.

So the mapper's real job is to say **no**, naming the missing fields. It never
invents a `receiptId`, registration identifier, `registeredAt`, content hash, or
Registrar identity — fabricating any of them would manufacture authority the
Registrar never granted, and the resulting "receipt" would resolve a publication
on a value this system made up.

`receiptId` is supplied by the caller rather than minted, which keeps the
promotion of a response to a receipt an explicit decision.

**The single-run orchestrator does not ingest its own response.** It still returns
`SENT` and leaves the attempt `DISPATCHED`
([`PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md`](PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md)).
See also [`PRODUCT_REGISTRAR_TRANSPORT.md`](PRODUCT_REGISTRAR_TRANSPORT.md).

## Result and error safety

The result carries identifiers, state names, `mismatchedFields`, and
`payloadDisposed`. It never carries a hash **value** — naming *which* fields
disagreed is what an operator needs, without disclosing what either side said —
nor the payload, receipt body, credentials, tokens, or database detail.

Two error classes, each with a real throw site: `InvalidReceiptEnvelopeError`
(paths only, never the offending value — an envelope rejected for smuggling a
payload is exactly where echoing it would write the smuggled material into a log)
and `ExpectedRegistrarMismatchError` (neither identifier echoed). Both use the
non-enumerable internal-cause pattern.

Everything else — attempt not found, not dispatched, abandoned, already answered,
binding mismatch, replay conflict — surfaces under the **existing** receipt and
attempt error names rather than being re-raised under new ones.

## Deferred

- **Caller authentication and authorisation**; actor identity on ingestion.
- **Webhook endpoint and signature verification.**
- **Registrar polling** and automatic receipt retrieval.
- **Automatic ingestion from the single-run orchestrator.**
- Persistent worker, scheduler, cron; monitoring; production deployment and
  database wiring; Resolver integration; Stripe; UI; Storefront, Listing, Offer,
  Review, and Buyer functionality.
