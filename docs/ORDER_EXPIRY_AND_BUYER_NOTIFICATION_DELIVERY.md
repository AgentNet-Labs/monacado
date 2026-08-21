# Order Expiry and Buyer Notification Delivery — Phase `1.1`

**Status:** implemented. The second operational phase.

`1.0` made a purchase executable. It left two things a real marketplace cannot
run without: an abandoned checkout sat `PENDING_PAYMENT` forever, and **no buyer
was ever told anything**. This closes both.

```
checkout.session.expired  → cancelOrder            → CANCELLED, no economics
sale recorded             → buyer + seller + promoter notices
authoritative failure     → buyer notice
```

---

## 1. Order expiry

### Stripe's fact, not Monacado's timer

The trigger is Stripe's own `checkout.session.expired`. There is **no sweeper, no
cron, no `expiresAt` column, and no `setTimeout`** anywhere in the payment path,
and a test strips comments and greps for each.

That is not laziness. Only Stripe knows whether a hosted session is still
payable — it holds the session, the PaymentIntent, and the buyer's in-flight
authentication. A Monacado clock guessing at it would eventually cancel an Order
a buyer was midway through paying, and the buyer would then pay into a cancelled
order.

### Abandonment is not failure

`BuyerPaymentConfirmation` became a discriminated union:

```ts
{ disposition: "PAYMENT_RESULT", result: BuyerPaymentResult, … }
{ disposition: "ABANDONED",      /* no result field at all */ … }
```

`ABANDONED` is deliberately **not** a `FAILED` result with a new failure code.
`0M.9` reserves `PAYMENT_FAILED` for "the provider reported failure" and
`CANCELLED` for "abandoned before payment succeeded". Nobody declined an expired
checkout, so routing it through a failure code would put the Order in the wrong
state **and invent a decline that never happened**. The union has no `result`
field on the abandoned arm, so "abandoned but succeeded" is not expressible.

### What happens, and what cannot

`finalizeConfirmedPayment` routes `ABANDONED` to `0M.9`'s existing `cancelOrder`,
which writes **one lifecycle column** and has no path to a transaction snapshot,
a settlement row, a proceeds obligation, purchase evidence, or a review
authority. A test asserts all five stay at zero.

| Order state when an expiry arrives | Result | Why |
| --- | --- | --- |
| `PENDING_PAYMENT` | → `CANCELLED` | the only case that acts |
| `PAID` | `ALREADY_RECORDED`, untouched | `PAID` is terminal in `0M.9`'s transition table; **a sale is never downgraded** |
| `CANCELLED` | `ALREADY_RECORDED` | Stripe delivers at least once; a redelivery is not an invalid transition |
| `PAYMENT_FAILED` | `ALREADY_RECORDED`, untouched | "a provider declined this" is a stronger fact than "the buyer wandered off", and overwriting would lose it |

Idempotency needs no new machinery: the pre-check reads the lifecycle, and the
lifecycle is authoritative. A test delivers the same expiry three times and
asserts `cancelledAt` never moves and exactly one notice is sent.

---

## 2. Notification delivery

### Delivery never becomes the system of record

`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` §3a is binding:

> **The canonical channel is the Monacado admin panel.** Email, SMS, and push may
> be added later and are supplemental — they may accompany the notice and can
> never replace it. A channel outside Monacado's control cannot be the system of
> record for an obligation.

So a `NotificationDelivery` row is **evidence of an attempt, never an
obligation**. Nothing in the delivery path writes to `NotificationObligation` — a
test greps both modules for every write method and asserts their absence. A
delivery does not satisfy, close, or advance an obligation; a failed one leaves it
exactly as owed, and a successful one does too, because being emailed is not the
same as having seen the notice in the panel. An integration test sends a seller
notice and asserts the accompanying obligation is still `UNREAD`.

**This is not a conflict with the instruction to use email.** §3a governs
*participant* notices and explicitly permits email as supplemental. A buyer has no
admin panel and often no participant at all, so for them email replaces nothing —
it is the only channel there has ever been.

### Two recipients, one mechanism

| Recipient | Obligation? | Address from |
| --- | --- | --- |
| seller / promoter | **yes** — `0M.9` wrote it in the sale transaction | the participant's `Account.email` |
| buyer (account **or** guest) | **no** | the contact the provider collected at checkout |

`obligationId` is nullable, and that carries the phase's central decision.
`0M.N1` keys obligations on participants **by design** — "keying an obligation on
[an address] would hand a promoter's notices to whoever holds the address next".
This phase does **not** redesign that. It adds a delivery record that can stand
alone.

### Triggering

Driven by **what the write path authoritatively did**, never by the event type:

| `finalizeConfirmedPayment` returned | Notices |
| --- | --- |
| `SALE_RECORDED` | buyer receipt, seller notice, promoter notice |
| `FAILURE_RECORDED` | buyer failure notice |
| `ORDER_EXPIRED` | buyer expiry notice |
| `ALREADY_RECORDED` | **none** |

That last row is the duplicate guard, and it sits *above* the delivery layer's own
unique key: a replayed webhook finalizes to `ALREADY_RECORDED`, so nothing newly
became true and nobody is newly owed a message. A test replays a success twice and
asserts zero further sends.

Delivery **never changes the webhook response**. A mail outage returns `200`,
because telling Stripe a booked sale failed would earn a retry of a sale already
recorded.

### The categories

`ORDER_CANCELLED` was added to `0M.N1`'s vocabulary — the additive change that
vocabulary was explicitly built to take ("a new member, no new table, no new
column"). Reusing `PAYMENT_FAILED` would assert a decline nobody issued; reusing
`ORDER_CONFIRMATION` would share a deduplication key with the receipt, making the
two indistinguishable in the evidence table and letting one suppress the other.

This phase creates **deliveries** of that category and no **obligations**, so
`IMPLEMENTED_NOTIFICATION_CATEGORIES` is unchanged.

---

## 3. Guest delivery

**A guest receives their receipt and no `MarketplaceParticipant` is created.** An
integration test counts `Account` and `MarketplaceParticipant` across a guest
purchase-and-notify and asserts neither moved.

This closes the gap `0M.9` recorded explicitly:

> Buyer-facing notice for guests needs an addressing model that does not exist
> yet. It belongs with `0M.N2`, which owns delivery and addressing, and is
> recorded here rather than solved by inventing a guest recipient.

The addressing model is the smallest one that works: Stripe's hosted page
collects an address because a checkout must, the adapter reads it back **inward
only**, and it travels transiently on the confirmation to the mail port.

A buyer who gave no address gets no notice, and that is an ordinary outcome — the
sale still completed, and `skippedForNoAddress` counts it.

### The address is not stored

Only a **SHA-256 digest** of the normalised address is persisted — the same
construction, and the same reasoning, as `0M.9`'s guest claim code. Normalisation
goes through `0M.1`'s own `normalizeEmail`, reused rather than restated, so casing
cannot fork one recipient into two.

Monacado therefore keeps the ability to prove *that* it wrote to a given address,
to deduplicate, and to answer a support question — without becoming a store of
buyer email addresses. `NEVER_ON_ORDER` promised no buyer-address column and a
test greps the whole Prisma schema to confirm carrying one transiently did not
quietly create one.

**The operational cost is real and accepted:** an operator cannot read an address
out of the database. They can confirm a digest, and the mail provider holds the
delivery log. That trade was made deliberately.

---

## 4. Delivery evidence

One table, `NotificationDelivery`:

| Column | Notes |
| --- | --- |
| `obligationId` | nullable — present only when accompanying a `0M.N1` obligation |
| `audience` | `BUYER` / `SELLER` / `PROMOTER` |
| `recipientParticipantId` | nullable — a buyer need not be one |
| `category`, `subjectKind`, `subjectRef` | `0M.N1`'s axes, reused |
| `channel` | `EMAIL` |
| `destinationDigest` | hex SHA-256; **there is no address column** |
| `status` | `ATTEMPTED` / `ACCEPTED` / `FAILED` |
| `failureCode` | bounded; never provider text |
| `providerMessageRef` | correlation only |
| `attemptedAt`, `acceptedAt` | |

`ACCEPTED` means **the provider took responsibility** — not that an inbox received
it, which is the provider's to know and Monacado's to guess.

### Claim, then send

```
1. INSERT the row (ATTEMPTED) — unique on deliveryKey
     └─ duplicate ⇒ already attempted. Send NOTHING.
2. call the mail port
3. UPDATE to ACCEPTED (+ ref) or FAILED (+ bounded code)
```

The order is the design. Claiming before sending makes the send **at-most-once**:
two concurrent deliveries race on the unique index and one loses. Send-then-record
would be at-least-once, and for transactional mail a duplicate receipt is worse
than a missing one — a second "your payment succeeded" reads as a second charge.

A process that dies between 1 and 3 leaves a row at `ATTEMPTED`. That is a
visible, queryable state, and the honest answer to "did this send?" is *we don't
know*.

The deduplication key is
`(audience, participant, category, subjectKind, subjectRef, channel)`. **The
destination is deliberately not in it**: keying on the address would send a second
receipt to a buyer who corrected their email, and would let anyone able to
influence the address manufacture a duplicate send.

### Retry

Deliberately absent — no `nextAttemptAt`, no backoff, no scheduler, no sweeper.
Re-attempting needs a decision about how many duplicate receipts are acceptable in
exchange for how much reliability, and that belongs with `0M.N2`'s delivery policy
rather than being assumed here. A `FAILED` row is visible and countable.

---

## 5. The email-provider boundary

**No email vendor is installed or configured**, and a test asserts none of
`nodemailer`, `@sendgrid/mail`, `resend`, `postmark`, `mailgun.js`, or
`@aws-sdk/client-ses` is a dependency.

The repository identifies none, so choosing one here would be choosing a third
party, a data-processing relationship, and a deliverability story on Monacado's
behalf in a phase about notifications. What exists instead:

- **`MailPort`** — provider-neutral. `MailMessage` is plain text with `to`,
  `subject`, `text` and no field for HTML, a template id, an attachment, a
  tracking pixel, or a credential.
- **`MailResult`** — a discriminated union on the same principle as
  `BuyerPaymentResult`: accepted carries a reference and no code, refused carries
  a bounded code and no reference. **An ordinary refusal is a result, not an
  exception**, so evidence is recorded rather than lost in a stack trace.
- **`createLogMailAdapter`** — local development. Logs a **redacted** destination
  (`a***@example.com`) and the subject, **never the body**.
- **`createCapturingMailAdapter`** — in-memory, for tests.
- **`createDisabledMailAdapter`** — refuses with `CHANNEL_NOT_CONFIGURED`.

Adding a real vendor is one new file implementing `MailPort` and **no change to
any caller**.

### Disabled is a first-class state

With `MONACADO_MAIL_ENABLED` unset every message is refused and a delivery row is
**still written**, marked `FAILED` with the bounded code. An unconfigured
deployment reports exactly how many notices it did not send. Silence would have
been the one outcome nobody could audit.

### What a message never contains

No participant id, policy id, provider transaction reference, Listing source
version, claim code, Monacado retention, seller proceeds, or promoter spread. A
buyer's receipt says the order reference and what they were charged. A
participant's says a sale was recorded and to look in the admin panel — it carries
**no proceeds figure at all**, because publishing a commercial position to whoever
holds a mailbox is exactly what a private marketplace record is not for. A test
greps every rendered message for each.

---

## 6. Buyer-visible result

`/checkout/result` now distinguishes four states, and two distinctions carry the
weight:

| Lifecycle | Headline | Terminal? |
| --- | --- | --- |
| `PENDING_PAYMENT` | Payment pending | no — says it will update |
| `PAID` | Payment received | yes |
| `PAYMENT_FAILED` | Payment failed | yes |
| `CANCELLED` | Checkout expired | yes |

**Pending must never read as failure.** The redirect routinely beats the webhook,
and a buyer told "failed" who was in fact charged a second later will pay twice
trying to fix it. Pending says so explicitly and invites a reload; terminal states
do not.

**Failed and cancelled stay apart.** A decline and an expiry are different events
with different next steps, and `0M.9`'s lifecycle already keeps them separate —
merging them in the UI would throw that away.

A `PAID` result also tells the buyer a confirmation was emailed, because a guest
has no account to check and would otherwise not know to look.

---

## 7. What remains deferred

**`0M.N2` proper** — the admin-panel view itself, the `SUPER_OWNER`/`ADMIN`
visibility rule, rendering for the canonical channel, notification preferences,
and unsubscribe handling. This phase built a *supplemental* channel; the canonical
one is still unbuilt.

**A production email vendor**, DKIM/SPF/DMARC alignment, bounce and complaint
ingestion, and suppression lists. None exists.

### Pre-live operational item: undelivered notices are not recoverable

**Recorded here as a known gate, and deliberately not solved in `1.1`.**

Two limitations compound, and together they mean a notice that fails is a notice
that is gone:

1. **Delivery is at-most-once with no retry.** A `FAILED` row — a provider
   outage, an unconfigured channel, a refused message — is never re-attempted.
   Nothing sweeps, and the deduplication key would refuse a second attempt even
   if something did.
2. **A guest's address cannot be recovered.** Only its digest is persisted, and a
   digest is one-way by design. For a participant an operator can re-derive the
   address from `Account.email`; **for a guest there is nowhere left to read it
   from** except Stripe's own record of the session.

So a guest whose receipt failed to send cannot be re-sent one from Monacado's
data alone. That is the accepted cost of not storing buyer addresses, and it is
tolerable in test mode where every failure is a developer's own.

**Before live payments it is not tolerable**, and the fix is a real decision
rather than a patch. The plausible options, none chosen here:

| Option | Cost |
| --- | --- |
| Bounded retry with a `FAILED → ATTEMPTED` path and an attempt counter | needs a scheduler, and a policy on how many duplicate receipts are acceptable |
| Re-read the address from Stripe when re-sending | ties recovery to one provider and to Stripe's own retention window |
| Store the address encrypted, with a short retention window | reverses this phase's central privacy decision, and should be reversed explicitly if at all |

Whichever is chosen belongs with `0M.N2`'s delivery policy, alongside bounce and
complaint ingestion — because a retry policy without bounce handling retries into
a mailbox that already rejected the message.

**Retry and dead-lettering** — see §4.

**Other channels** — SMS and push are named by §3a and are deliberately absent
from `DELIVERY_CHANNELS` rather than declared-and-unimplemented.

**Localisation** — every message is English, and there is no locale field.

**`0M.T2` / `0M.R2`** — unchanged and still the production gates. **No tax,
refund, chargeback, payout, reserve, or risk-control work was begun in this
phase.**

---

## Reference

- [`BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md`](BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md) — `0M.9`, the Order lifecycle and the guest-notice gap this closes
- [`NOTIFICATION_OBLIGATION_RECORDS.md`](NOTIFICATION_OBLIGATION_RECORDS.md) — `0M.N1`, the obligation half
- [`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) — §3a, the canonical-channel rule this obeys
- [`EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md`](EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md) — `1.0`, the checkout this extends
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
- [`.env.example`](../.env.example)
