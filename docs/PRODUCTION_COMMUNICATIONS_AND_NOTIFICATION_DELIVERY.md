# Production Communications and Notification Delivery — Phase `1.5`

**Status:** implemented. The `0M.N2` delivery gap is closed: Monacado can now send
transactional email through a production provider, retry it when the provider
fails, stop writing to addresses that bounce, and answer what happened to any
message it committed to.

`1.1` built the first concrete channel and recorded its own limitation as a
pre-live gate:

> delivery is at-most-once with no retry, and a guest's address cannot be
> recovered from a digest, so a failed guest receipt cannot be re-sent from
> Monacado's data alone.

Half of that was already retired by `1.2`'s `OrderBuyerSnapshot`. This phase
retires the rest.

```
                       ┌── NotificationObligation ──┐   what Monacado OWES        (0M.N1)
                       │      canonical, in-panel   │   never advanced by delivery
                       └──────────────┬─────────────┘
                                      │ obligationId (NULLABLE)
                                      ▼
  commit ──▶ OutboundEmailDelivery ──▶ dispatcher ──▶ MailPort ──▶ Postmark
              PENDING                   claim/lease    provider-      │
              IN_PROGRESS               re-render      neutral        │
              DELIVERED                 suppress?                     │
              RETRY_PENDING  ◀── bounded backoff ──┘                  │
              PERMANENTLY_FAILED                                      │
                                                                      ▼
              EmailSuppression ◀── ingest ◀── ProviderEmailEvent ◀── webhook
                     │                          (idempotency ledger)
                     └──▶ ParticipantEmailContact degraded ──▶ 1.3 support resolver falls back
```

**Nothing here enables live money.** `STRIPE_MODES` still has one member and
`resolveStripeApiKey` still refuses any key not prefixed `sk_test_`. No payout was
executed, no tax remitted, and no digital-delivery machinery built.

**No production send occurred.** Every test drives a capturing adapter or an
injected `fetch`; the Postmark adapter is never constructed against the real
endpoint, and no credential is in the repository.

---

## 1. Obligation, delivery, attempt — three records, three questions

| Record | Question | Phase |
| --- | --- | --- |
| `NotificationObligation` | what does Monacado **owe** this participant? | `0M.N1` |
| `OutboundEmailDelivery` | did that communication **get out**, and if not, when do we try again? | `1.5` |
| `NotificationDelivery` | what did **one attempt** do? | `1.1` — **legacy, read-only, retained indefinitely** |

**A delivery is never an obligation, and retries never touch one.** A permanently
failed message leaves the obligation exactly as owed as it was; a delivered one
does too, because being emailed is not having seen the notice in the panel.
`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` §3a is unchanged, and a test asserts
that a delivery which exhausts its attempts leaves its obligation `UNREAD` with
`acknowledgedAt` and `resolvedAt` still null.

`obligationId` is **nullable**, and that nullability is why this model exists
rather than an extension of `1.1`'s. A verification link owes nothing and confirms
nothing: it is an account-security credential addressed to a participant about
their own contact record. Forcing it into the obligation vocabulary would have
made "what does Monacado owe?" a harder question to answer for the convenience of
one column.

### `NotificationDelivery` is legacy, and that is permanent

**The writer is gone.** `attemptDelivery` was removed in this phase, along with
the id provider that existed only to mint rows for it. Nothing in the application
can create a `NotificationDelivery` row. `LEGACY_NOTIFICATION_DELIVERY` states it
in code, as a constant rather than only a comment, so the decision is greppable
and asserted by a test:

```ts
export const LEGACY_NOTIFICATION_DELIVERY = {
  status: "LEGACY_READ_ONLY",
  writesPermitted: false,
  supersededBy: "OutboundEmailDelivery",
  retention: "RETAINED_INDEFINITELY_FOR_HISTORICAL_READ",
  plannedDestructiveMigration: "NONE",
} as const;
```

The writer had to go rather than be fixed, because the property that made it
correct is the property that made it unfixable: the `deliveryKey` unique index
enforces **at-most-once**, so a provider outage lost a buyer's receipt permanently
and silently, and the constraint could not be relaxed without losing the duplicate
protection it existed for. `1.5` separated the two ideas it had conflated — a
unique key over the **message**, an attempt counter over the **attempts** — and
that separation needed a different table.

**The table is retained indefinitely.** It is *not* waiting to be dropped, and
there is **no planned destructive cleanup migration**, no scheduled deletion, and
no rename. Rows written before `1.5` are evidence of messages Monacado actually
attempted, and evidence does not become disposable because a better mechanism
arrived.

What remains is a narrow historical read — `listDeliveriesForSubject` and
`countDeliveriesIn` — so a pre-`1.5` row stays legible. **New functionality must
not depend on any of it.** Anything sent after `1.5` is in
`OutboundEmailDelivery`, and that is where a support surface, a report, or a new
feature should look.

The same split applies inside `contracts/marketplace/notification-delivery.ts`,
which is deliberately two halves: the **mail boundary** (`MailPort`,
`MailMessage`, `MailResult`, `DeliveryFailureCode`, `DeliveryAudience`) is
canonical and current — `1.5`'s dispatcher and Postmark adapter are built on it
unchanged — while the **`NotificationDelivery` record** (`DELIVERY_STATUSES`,
`notificationDeliveryKey`, `NotificationDeliveryRecord`) is legacy. Both the file
header and each legacy export say which is which.

---

## 2. The durable delivery record

```
PENDING ──claim──▶ IN_PROGRESS ──accepted──▶ DELIVERED          (terminal)
   ▲                    │
   │                    ├──transient, attempts remain──▶ RETRY_PENDING
   │                    │                                     │
   └───────────due──────┘◀────────────────────────────────────┘
                        │
                        └──permanent, or attempts exhausted──▶ PERMANENTLY_FAILED
```

The row holds: the logical message key, the purpose, an optional obligation, the
audience, an optional participant, a **source reference**, the status, the attempt
count, the next attempt time, the claim, the provider name, the provider message
reference, a destination **digest**, and the last normalised failure and its class.

### No body is stored, and that is load-bearing

A delivery records a *source reference* — an Order id or an email-contact id — and
every attempt re-renders from the authoritative record. Three things follow, and
all three were the point:

1. A retry states what is true **now**, not what was true when the first attempt
   failed four hours ago.
2. The table never becomes a mail archive holding every buyer address, every
   amount, and every rendered receipt.
3. **A verification link can be retried without a plaintext token ever being
   written down** — §7.

### Idempotent commitment, and the correction it embodies

`dedupeKey` is derived from the logical identity of the message and carries a
`UNIQUE` constraint. Two concurrent webhook deliveries of one sale race on it and
exactly one wins; the loser reads back the existing row.

`1.1` conflated *do not send twice* with *do not try twice* and got at-most-once.
Here the unique key governs the **message** and the attempt counter governs the
**attempts**: one receipt, up to five tries. The destination is deliberately not a
key component — the same reasoning `1.1` applied.

`discriminator` separates a message that may legitimately be sent again from one
that may not. An order receipt passes `null`: there is exactly one per order per
audience, forever. A verification request passes a fresh opaque value, because
**asking again is a new message** and superseding the previous challenge is the
documented behaviour rather than a duplicate to suppress.

---

## 3. Retry, claiming, and what a crash costs

The policy is stated **once**, as `EMAIL_RETRY_POLICY`, because "how many times
did we try and how long did that take" is a question about the system and an
answer assembled from four call sites is not an answer.

| Setting | Value |
| --- | --- |
| max attempts | 5 |
| backoff | 60s · 300s · 900s · 3600s · 10800s |
| claim lease | 300s |

Roughly four and a half hours: long enough to ride out an ordinary provider
incident, short enough that a receipt either arrives the same morning or is
visibly, permanently failed rather than sitting in a queue nobody reads.

**Claiming is a guarded `UPDATE`**, the convention `PublicationOutbox` settled and
this reuses rather than reinvents: one `updateMany` re-asserts eligibility and
stamps a lock token, so of two concurrent workers exactly one matches a row.
Resolution re-asserts the same token, so a worker whose lease expired mid-send
cannot write its result over a row somebody else now holds — it raises
`DeliveryClaimConflictError`, which the cycle counts rather than swallows.

**A crash costs an attempt, never the message.** A dead worker leaves
`IN_PROGRESS` with an expired lease; recovery returns it to `RETRY_PENDING` **and
counts the attempt**. That is the honest accounting — the send may well have gone
out, and a recovery that did not count it would retry a delivered receipt for the
full policy. Bounded at-least-once is the trade, and it is the right way round for
transactional mail now that a retry exists at all.

A live claim is never stolen: this is lease *expiry*, not lock stealing.

### `CHANNEL_NOT_CONFIGURED` is transient

An unconfigured deployment is a condition an operator fixes, not a property of the
message — so the commitment survives. It still exhausts its attempts and fails
permanently, so a deployment that never configures mail reports exactly how many
notices it did not send, which is `1.1`'s posture kept. `DESTINATION_SUPPRESSED`
and `RECIPIENT_UNRESOLVABLE` are permanent by construction.

---

## 4. The dispatcher

One bounded cycle: recover what a dead worker left, claim what is due, and for
each row resolve → render → suppression check → send → record.

```
npm run email:dispatch:once [--limit=N]            # the primary operator path
POST /api/internal/operations/email-dispatcher     # for a future scheduler
```

No daemon, no scheduler, no `setInterval`, no self-rescheduling — the shape
`worker:publication:once` established, so deciding to run a second cycle stays
entirely outside and nothing inherits a hidden loop.

**No cron schedule is wired.** There is no deployment configuration file in this
repository to add one to, and inventing one is a deployment decision rather than a
notification phase's. The endpoint exists so that decision is one line.

The endpoint is gated by a bearer shared secret compared in constant time, whose
**variable name** is configuration and whose value is resolved per request. It
answers `401` identically for unconfigured, absent, and wrong — distinguishing
them tells an unauthenticated caller how far they got. It returns **counts only**:
a response that named messages would be a way to enumerate them.

**The suppression check is immediately before the send, never at enqueue.** A
receipt committed on Monday and retried on Tuesday must respect a bounce that
arrived on Monday night.

**One failure never stops the batch.** Every per-delivery failure is caught,
classified, and recorded against that row.

---

## 5. Postmark, behind the unchanged port

`1.1` recorded that choosing a vendor was "a third party, a data-processing
relationship, and a deliverability story" and not a notification phase's decision.
This phase makes it: **Postmark**, in `postmark-mail-adapter.ts`, which is the only
file in the repository that knows what Postmark is. **No caller above `MailPort`
changed** — which is exactly what the seam was built to demonstrate.

**No SDK.** One `fetch` to one documented endpoint. A vendor SDK is a dependency
to keep patched, a second HTTP client in the bundle, and a route through which the
vendor's types spread into application code — the exact coupling the adapter
exists to prevent.

### Normalisation is the whole point

| Postmark | Monacado | Class |
| --- | --- | --- |
| `200` + `ErrorCode: 0` + `MessageID` | accepted | `ACCEPTED` |
| `ErrorCode 406` (inactive recipient) | `DESTINATION_REJECTED` | **permanent** |
| `ErrorCode 300` (invalid request) | `MESSAGE_REJECTED` | **permanent** |
| `ErrorCode 10 / 400 / 401`, HTTP `401` | `CHANNEL_NOT_CONFIGURED` | transient |
| HTTP `429`, `5xx`, `408`, timeout, DNS | `PROVIDER_UNAVAILABLE` | transient |
| anything unrecognised | `UNSPECIFIED_FAILURE` | transient |

An accepted send with no `MessageID` is treated as unavailable: a delivery
Monacado cannot tie a bounce back to is one it cannot act on later, and the send is
cheap to repeat.

**Open and click tracking are off.** A tracking pixel in a receipt reports when
somebody read it and from where; a rewritten link in a verification message routes
a bearer credential through a third party.

### Configuration fails closed

`serverTokenEnvVar` holds the *name* of the variable holding the token — the
construction `stripe-runtime-config.ts` uses, for the same reason: this object is
constructed, passed around, logged in a debugger, and serialised into an error, and
a credential that is never in it cannot leak from it. Selecting `POSTMARK` with no
token, no From address, or an unparseable one raises `MailConfigurationError`
naming the **fields** at fault and never their values. It does **not** fall back to
the log adapter: a deployment that believes it is sending production mail and is
quietly writing to stdout is worse than one that refuses to start.

---

## 6. Bounces, complaints, and suppression

```
POST /api/notifications/email/webhook
   1. authenticate            ← before the body is even parsed
   2. parse and normalise     ← Postmark's vocabulary stops here
   3. ingest idempotently     ← the provider event id is the guard
```

**Postmark does not sign its webhooks.** There is no HMAC to verify. Its documented
mechanisms are HTTP Basic credentials in the webhook URL and a custom header, so a
shared secret compared in constant time is the strongest thing the provider
actually supports. That is recorded rather than left for somebody to discover while
searching for a signature that does not exist. Both forms are accepted.

Authenticating first means an unauthenticated caller cannot make Monacado parse,
allocate for, or reason about a payload it invented.

**Idempotent, because every provider retries.** The ingestion is one transaction
whose first statement inserts the `ProviderEmailEvent` row; a redelivered webhook
violates `UNIQUE(provider, providerEventId)`, the transaction rolls back, and
nothing is suppressed or degraded twice. Suppress-then-record would leave a window
in which a crash produced a suppression nobody could trace to an event.

**Almost everything answers `200`** — an unrecognised record type, a replay, a
successful ingestion. A provider that receives an error for an event retries it,
forever for some, so answering `4xx` to "I do not act on opens" is how an endpoint
acquires a backlog it did not need. `503` is reserved for a persistence failure,
which *should* be retried: a bounce Monacado never ingested is an address it keeps
writing to.

**No raw payload is persisted.** A bounce payload carries the recipient address,
the subject line, and frequently a quoted copy of the message body — which for a
verification message is a live credential. The address is used **in memory** to
find the affected contact and is then reduced to a digest.

### What suppresses, and what deliberately does not

| Event | Suppresses |
| --- | --- |
| `HardBounce`, `BadEmailAddress` | **yes** — `HARD_BOUNCE` |
| spam complaint | **yes** — `SPAM_COMPLAINT` |
| soft bounce, transient, DNS error, **anything unrecognised** | no |
| delivery confirmation | no |

Suppressing on a type Monacado does not understand would silence a real customer
on the strength of a vendor string nobody read, and the retry policy already owns
anything genuinely transient.

### The suppression list holds no addresses

Keyed by SHA-256 of the normalised address — otherwise it is a directory of every
address that ever failed, which is a more attractive table to read than the one it
was protecting. Monacado can still answer the only question it needs to: *may I
write to this address*, for an address it already holds.

Suppression is a **state, not a verdict**. `liftedAt` exists so an address can be
remediated by proving control of it, and the row remains as the evidence of why it
was ever suppressed. Lifting is never automatic and never a consequence of time
passing: nothing about a mailbox becomes true because a month went by.

---

## 7. Seller support-contact degradation, and no suspension

A hard bounce or complaint degrades the matching `ParticipantEmailContact` to
`DELIVERY_FAILED` — `1.3` built those states and declared the posture; this phase
supplies the signal that drives them. `verifiedAt` is kept and `degradedAt` records
when it stopped being trustworthy, so the regression is dateable.

Two shapes, because `0M.5` settled that the primary address lives on `Account`:

- a `DEDICATED_SUPPORT` contact **holds** the address and is matched directly;
- a `PRIMARY_PROFILE` contact holds none, so the `Account` carrying the normalised
  address is found first and its participant's contact degraded.

**The `1.3` resolver then does the rest, unchanged:**

```
verified dedicated → verified primary → unavailable
```

| After | Result |
| --- | --- |
| dedicated bounces, primary verified | customers keep a route through the primary |
| both bounce | `hasUsableSupportContactIn` is false → `SELLER_SUPPORT_CONTACT_UNAVAILABLE` at checkout |

That second row is `1.3`'s runtime check, untouched: `executable-checkout-service.ts`
consults the same predicate before creating an Order, so no new commerce happens for
a seller nobody can reach.

**The seller is never suspended.** `0M.1`'s admission lifecycle is a governed
decision about a participant; an address failing is a fact about a mailbox. A test
asserts the participant's status is unchanged after both of its addresses bounce.

---

## 8. Verification email on the durable path

`1.4` minted a challenge and attempted exactly one send, so a provider blip
stranded the seller with a link nobody received and no retry path.

**Issuing the challenge and scheduling its email are now one operation**, and the
way they are made one is that neither happens at request time: the request commits
a durable delivery naming the *contact*, and the dispatcher mints the challenge and
renders the link on each attempt. The two cannot diverge, because there is no state
in which one exists without the other.

### Retrying without ever storing a plaintext token

`1.3`'s token is returned once and only its digest is stored, so a retry cannot
resend the first link — there is nothing to resend from. The obvious workarounds
are all worse: storing the plaintext makes a table read a set of working
takeovers, and storing it encrypted makes it a key plus a table read.

A retry instead **mints a fresh challenge**, which supersedes its predecessor
exactly as `1.3` already specified for reissue. Nothing about the token model is
weakened:

| Property | State |
| --- | --- |
| entropy | 256 bits, unchanged |
| opaque | unchanged |
| storage | SHA-256 digest only, unchanged |
| TTL | 24h, from the attempt that minted it |
| single-use | unchanged |
| supersedes | unchanged — and now this is also the retry mechanism |

The superseded link **was never delivered** — that is *why* there is a retry — so
nothing usable is invalidated. Tests assert two attempts produce two challenges,
the first `SUPERSEDED` and the second `PENDING`, the delivered token absent from
every row, and the fresh link working.

The one visible consequence, recorded rather than hidden: if an attempt is
ambiguous (the provider accepted it but Monacado recorded a timeout), the recipient
may hold a link the next attempt supersedes. They receive a second message whose
link works — the standard behaviour of every verification email anybody has used,
and strictly better than `1.4`'s alternative of no second message at all.

The request path still checks the public origin eagerly, so a misconfigured
deployment tells the *seller* immediately rather than committing a message that
will fail four times first.

---

## 9. Buyer and guest email

Buyer email is first-class and unchanged in intent. The dispatcher resolves the
recipient from the durable `OrderBuyerSnapshot` — `1.2`'s private transactional
record — on **every attempt**.

**No `Account` or `Participant` is fabricated for a guest.** `0M.9` promised guest
checkout creates none, `1.1` kept it, and this keeps it: a guest delivery carries
`recipientParticipantId: null` and `obligationId: null`, and the `1.1` suite
asserts the account and participant counts are unchanged after a guest receipt.

No buyer address enters a capsule, and none is stored on the delivery row — only a
digest, once the address has been resolved.

An Order whose snapshot cannot be read yields `RECIPIENT_UNRESOLVABLE`, which is
permanent: no number of retries conjures an address that was never recorded. That
replaces `1.1`'s silent `skippedForNoAddress`, where a recipient with no readable
address at that instant was dropped and never mentioned again.

---

## 10. Delivery evidence and receipt

`listEmailDeliveriesForSubject`, `getEmailDelivery`, and `summarizeEmailDeliveries`
answer, for one Order or one contact:

| Question | Field |
| --- | --- |
| was it scheduled? | the row exists |
| delivered? | `status: DELIVERED`, `sentAt` |
| retrying? | `status: RETRY_PENDING`, `attemptCount`, `nextAttemptAt` |
| permanently failed? | `status: PERMANENTLY_FAILED`, `finalizedAt` |
| provider reference? | `providerMessageRef` |
| latest normalised reason? | `lastFailureCode`, `lastFailureClass` |

**No admin UI was built** — that is `0M.N2`'s remaining half. The reads return no
address and no body, because neither is stored: a support agent learns that a
message to the buyer's recorded address permanently failed without being handed
the address to read.

---

## 11. Privacy and logging

| Never persisted | Never logged |
| --- | --- |
| provider token, webhook secret, dispatcher secret | any of them |
| verification plaintext token | the token, or a link containing it |
| rendered subject or body | the body |
| recipient address (only a digest) | a full address — the log adapter redacts to `a***@domain` |
| raw webhook or provider response payloads | provider response text |

Every catch block that handles a provider or port failure **deliberately does not
inspect the thrown value**: a `fetch` error can carry the full request, and the
request carries the token and the message body.

Customer-facing support-address disclosure remains governed by `1.3`'s canonical
resolver, which this phase does not touch.

---

## 12. Migration

**One additive migration.** Three `CREATE TABLE` — `OutboundEmailDelivery`,
`EmailSuppression`, `ProviderEmailEvent` — and one `ADD FOREIGN KEY` from delivery
to obligation (`RESTRICT`: evidence that Monacado tried to send a notice must not
vanish with the obligation it accompanied). **No `ALTER` on any existing table, no
drop, no rewrite, and no committed migration modified.**

**`NotificationDelivery` was not touched.** Not dropped, not renamed, not
truncated, not altered. Retiring its writer is a code change; the table, its
columns, and its indexes are exactly as `1.1` created them, and there is no
migration planned that changes that.

Two additive members were added to `1.1`'s `DELIVERY_FAILURE_CODES` —
`DESTINATION_SUPPRESSED` and `RECIPIENT_UNRESOLVABLE` — which the vocabulary was
explicitly designed to take and which need no schema change.

---

## 13. Remaining production configuration

Nothing below is code. Each is a deployment act, and none has been performed.

| Step | Where |
| --- | --- |
| Create a Postmark server and **verify the sender signature** for `MONACADO_MAIL_FROM_ADDRESS` | Postmark |
| Set `MONACADO_POSTMARK_SERVER_TOKEN` as a secret | deployment environment |
| Set `MONACADO_MAIL_ENABLED=true` and `MONACADO_MAIL_TRANSPORT=POSTMARK` | deployment environment |
| Publish SPF, DKIM, and a DMARC record for the sending domain | DNS |
| Point Postmark's **Bounce** and **SpamComplaint** webhooks at `/api/notifications/email/webhook`, with the shared secret | Postmark |
| Set `MONACADO_POSTMARK_WEBHOOK_SECRET` | deployment environment |
| Set `MONACADO_EMAIL_DISPATCHER_SECRET` and schedule `POST /api/internal/operations/email-dispatcher` | deployment environment + scheduler |

**Still unbuilt, and named rather than left to be discovered:**

| Gap | Owner |
| --- | --- |
| **The canonical admin-panel view** — obligations, the `SUPER_OWNER`/`ADMIN` visibility rule, notification preferences | `0M.N2`'s remaining half |
| **No rate limiting** on verification requests | future operational control |
| **A suppressed address cannot be re-verified by email** — see §14 | recorded |
| No per-recipient send throttling or domain reputation monitoring | future operational control |
| No `SMS` or `PUSH` channel | §3a names them as future supplemental channels |

**Not on that list, deliberately:** removing `NotificationDelivery`. It is
retained indefinitely, has no planned destructive cleanup migration, and is not
outstanding work.

---

## 14. An architectural consequence worth stating plainly

**A hard-bounced address cannot receive a new verification email.** The dispatcher
checks suppression before every send, so the message that would let a seller prove
control of the address is itself suppressed.

That is the correct behaviour, not a bug: writing to an address the provider has
told Monacado is dead is what suppression exists to prevent. It means the remedy
for a bounced contact is the one `1.3` already documented —
`BOUNCE_POSTURE.onDegradation = "SELLER_SUPPLIES_AND_VERIFIES_REPLACEMENT"`: the
seller supplies a **different** address and verifies that.

One path does re-verify a suppressed address, and a test covers it: a link
delivered *before* the bounce still works, and consuming it lifts the suppression.
Direct proof of control supersedes a provider's signal about reachability. An
operator-initiated lift would be the other, and is not built.
