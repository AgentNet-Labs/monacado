# Executable Checkout and Stripe Test Mode — Phase `1.0`

**Status:** implemented. The first **operational** phase, and the one that ends
the pre-operational `0M` numbering.

`0M.9` built the whole buyer transaction as pure domain logic with an interface
where a payment provider should be. `1.0` puts a real provider behind that
interface — in **Stripe test mode**, and only test mode — and changes no
economics doing it.

```
Listing page → POST /api/checkout → Order (PENDING_PAYMENT) → Stripe Checkout
   → buyer pays → Stripe signs a webhook → recordPaymentResult → PAID
                                          → snapshot, obligations, evidence, notices
```

---

## 1. What changed, and what deliberately did not

| | |
| --- | --- |
| **Added** | Stripe's **server** SDK; two concrete adapters; three routes; two pages; two configuration blocks |
| **Unchanged** | every price, policy, retention, proceeds figure, snapshot, obligation, and the entire `0M.9` post-sale write path |

`recordPaymentResult` finalizes the sale exactly as `0M.9` wrote it. **No second
finalization path exists**, and `finalizeConfirmedPayment` calls it once.

### The `0M.9` contract that was extended, and the one that was not

`BuyerPaymentPort` is **untouched**. It is right for a provider that answers in
one call, and widening its result union to carry a third "not an answer yet"
member would have destroyed the property `0M.9` named third: every reader would
have had to handle a non-result, and "succeeded but…" would have become
expressible.

Real card acquiring is two events, so it got two shapes:

```ts
interface BuyerPaymentInitiationPort {
  initiatePayment(request: BuyerPaymentRequest): Promise<BuyerPaymentInitiation>;
}
interface BuyerPaymentConfirmationPort {
  confirmPayment(notification: ProviderNotification): Promise<BuyerPaymentConfirmation | null>;
}
```

Both remain provider-neutral: no payment intent, no client secret, no session, no
event type, no signature scheme. `BuyerPaymentInitiation` has **no outcome
field** — an initiation that could claim success would be a browser-reachable
path to asserting a sale. `BuyerPaymentConfirmation` carries a `BuyerPaymentResult`
**unchanged**, so the existing write path receives exactly what it already
receives.

`BuyerPaymentRequest` is the same request for both, so one charge carries one
idempotency key regardless of which port runs it.

---

## 2. Configuration

All server-side. **None is `NEXT_PUBLIC_`**, and the buyer flow needs no
publishable key at all — Stripe's page is hosted, so no Stripe.js and no card
field ever load on a Monacado origin.

Full annotated template: [`.env.example`](../.env.example).

### Stripe

| Variable | Meaning |
| --- | --- |
| `MONACADO_STRIPE_ENABLED` | Master switch. Anything but `true`/`1`/`yes` means disabled |
| `MONACADO_STRIPE_MODE` | `TEST`. The only permitted value |
| `MONACADO_STRIPE_API_KEY_ENV` | The **name** of the variable holding the secret key |
| `MONACADO_STRIPE_WEBHOOK_SECRET_ENV` | The **name** of the variable holding the signing secret |
| `MONACADO_STRIPE_SUCCESS_URL` / `_CANCEL_URL` | Where Stripe returns the buyer |
| `MONACADO_STRIPE_ALLOW_LOOPBACK_HTTP` | Local only; permits `http:` to a loopback host |

The named secrets themselves — `MONACADO_STRIPE_SECRET_KEY` (`sk_test_…`) and
`MONACADO_STRIPE_WEBHOOK_SECRET` (`whsec_…`) — are supplied out of band and are
**absent from every tracked file**.

### Checkout, which is not Stripe's

| Variable | Meaning |
| --- | --- |
| `MONACADO_CHECKOUT_POLICY_ID` | Which `0M.R1` commercial policy governs checkout |
| `MONACADO_APP_ORIGIN` | The exact origin this deployment answers on |

Filed apart from Stripe on purpose: **which policy governs Monacado's retention
is a Monacado decision**, and putting it under the payment provider is how it
eventually gets read out of one. It is configuration and never a request
parameter — a client that could name the policy could name the retention rate.

### Test mode is structural, not configured

Two independent guards, because either alone is insufficient:

- `STRIPE_MODES` has **one member**. Adding `LIVE` is a source edit, in the open.
- `resolveStripeApiKey` refuses any key not prefixed `sk_test_`, and refuses
  `sk_live_` / `rk_live_` / `pk_live_` explicitly.

Pointing a `MODE=TEST` deployment at a live key is exactly how a "test"
environment charges a real card, and the mode label alone would not have caught
it. **No configuration object ever holds a secret value** — only the *names* of
the variables — so anything that logs or serialises one is safe by construction.

### Local setup

```bash
stripe login                                     # Stripe CLI, test mode
stripe listen --forward-to localhost:3000/api/payments/stripe/webhook
# copy the printed whsec_… into MONACADO_STRIPE_WEBHOOK_SECRET
npm run dev
```

Then visit `/listings/<internalListingId>` and pay with `4242 4242 4242 4242`.

---

## 3. The checkout lifecycle

```
prepareCheckout          ← pure read: price, eligibility, policy, counterparties
placeOrder               ← Order written, PENDING_PAYMENT, DURABLE
initiateOrderPayment     ← Stripe Checkout Session; the only outbound I/O
   … buyer pays on Stripe's page …
webhook → confirmPayment ← verified, translated
finalizeConfirmedPayment → recordPaymentResult → PAID + the whole 0M.9 write
```

**The Order is written before Stripe is contacted**, exactly as `0M.9` designed.
If session creation fails, or the process dies mid-flight, what survives is a
`PENDING_PAYMENT` Order naming precisely what was being bought — recoverable —
rather than a Stripe payment nobody can attach to anything.

### What a client may say

**One field: which Listing.** Enforced by a `strictObject`, so anything else is
refused rather than ignored.

| Fact | Resolved from | Why not the client |
| --- | --- | --- |
| retail price | the bound Listing source version | a client-named price is a client-named sale |
| commercial policy | configuration | naming the policy names Monacado's retention |
| tax / shipping / pass-through | zero, server-side | `0M.T2` owns tax |
| buyer identity | the session cookie, or absent | a body field naming an account impersonates one |
| go-live approval | the governed `ParticipantCommerceApproval` | a client passing `APPROVED` makes a Listing purchasable |
| `placedAt` | the injected clock | a client instant prices a closed sale window |
| **payment outcome** | **nowhere — no such field exists** | this is the whole point |

A cross-site `Origin` is refused. An absent one is permitted, because browsers
omit it on ordinary same-origin form navigations and refusing those would refuse
the actual buyer flow.

---

## 4. Payment confirmation

**The webhook is the only path in the repository that can mark an Order `PAID`.**

1. **Verify the signature over the raw bytes** — before parsing, before reading
   the event type, before touching the database. A signature authenticates bytes;
   anything done first is done on unauthenticated input. The Next.js route uses
   `request.text()` for exactly this reason.
2. **Translate** into Monacado's vocabulary. No Stripe type crosses into the
   service layer.
3. **Hand it to `recordPaymentResult`**, unchanged.

A verification failure returns **400 and nothing else**. Stripe's own message
distinguishes a malformed header from a stale timestamp from a wrong secret, and
an endpoint that reports which is an oracle for forging one.

### Event types, and one conspicuous absence

> **Extended by Phase `1.1`**, which added `checkout.session.expired` — Stripe's
> authoritative statement that a session can no longer complete. See
> [`ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md`](ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md).

| Event | Effect |
| --- | --- |
| `checkout.session.completed` (`payment_status: paid`) | `SUCCEEDED` |
| `checkout.session.async_payment_succeeded` | `SUCCEEDED` |
| `checkout.session.async_payment_failed` | `FAILED`, classified from Stripe's decline code |
| everything else that verifies | acknowledged `200`, acted on in no way |

**`payment_intent.payment_failed` is deliberately not handled**, and this is the
most important decision in the file. During a hosted Checkout Session a declined
card fires that event and the buyer is simply invited to try another card on the
same page. Recording `PAYMENT_FAILED` there would move the Order to a state from
which `PAID` is unreachable — and the buyer's successful retry, moments later,
would be a payment Monacado took and refused to book.

A completed session whose `payment_status` is not `paid` returns `null`: a
delayed-notification method resolves through its own event, and booking a sale
there would book one on funds that may still fail.

### Failure classification

Stripe's code becomes one of `0M.9`'s five `PaymentFailureCode` members. **No
Stripe string, decline message, issuer reason, or network code is returned,
logged, or persisted.** An unrecognised code degrades to `UNSPECIFIED_FAILURE`
rather than being forced into the nearest-looking bucket — a wrong classification
is worse than an honest absence of one. If Stripe cannot be reached to classify,
the *failure* is still recorded; only the *detail* degrades.

### The buyer's return page proves the point

Stripe's success URL is a redirect target a buyer can navigate to by hand. The
page reads the Order from the database and renders what it finds. `PENDING_PAYMENT`
there is ordinary — the redirect frequently beats the webhook — and means *not
yet known*, never *failed*.

---

## 5. Idempotency

**One Order, one payment, structurally.** `0M.9` made the idempotency key the
Order id; `1.0` hands that same key to Stripe's `Idempotency-Key` header, so a
repeated begin-checkout returns the *same* Checkout Session and therefore the
same PaymentIntent.

A repeated Stripe delivery creates no second transaction snapshot, settlement
row, proceeds obligation, purchase evidence, notification obligation, or `PAID`
transition — and **none of that is new machinery**:

| Repeat delivery of | Guarded by |
| --- | --- |
| a success on a `PAID` Order | `0M.9`'s replay branch — same provider reference returns the existing sale, writes nothing |
| a **different** success on a `PAID` Order | `PaymentResultConflictError`. Deliberately not idempotent: the buyer may have been charged twice |
| a failure on a `PAYMENT_FAILED` Order | reported `ALREADY_RECORDED` rather than attempted as an invalid transition |
| a success on a `PAYMENT_FAILED` Order | refused. A retry is a new Order |
| two deliveries racing concurrently | the `UNIQUE` index on `TransactionEconomicSnapshot.orderId`; the loser's whole transaction rolls back, and its retry finds the Order `PAID` and replays |

**No event-processing framework and no processed-event ledger was built.** The
Order's lifecycle and that unique index already answer the question, and a second
store of processed events would be a second answer that can disagree with the
first.

### Status codes, and what Stripe does with them

| Situation | Status | Effect |
| --- | --- | --- |
| recorded, replayed, or ignored | `200` | Stripe stops |
| signature absent or invalid | `400` | Stripe stops; the sender learns nothing else |
| contradicts authoritative state | `409` | Stripe retries, then surfaces a failed webhook — which is where a human should see this |
| Monacado could not write | `500` | Stripe retries; the retry replays idempotently |

A contradiction is never silently accepted. Swallowing one to keep the endpoint
quiet would bury the one fact worth surfacing.

---

## 6. Monacado's economics are Monacado's

**Stripe is handed one number and returns evidence.** The buyer's total, already
derived by `prepareCheckout` from the bound Listing version and the bound
commercial policy. Nothing else crosses.

There is **no `application_fee_amount`, no `transfer_data`, no `on_behalf_of`,
and no destination charge** anywhere in the repository, and a test asserts it.
The retail price, the effective policy, Monacado's retention, seller proceeds,
the promoter's spread, and the transaction snapshot are all computed by
Monacado's own services from bound authoritative versions.

The promoted worked example still lands exactly where `0M.9` put it — $100.00
retail, $50.00 wholesale, 20% commission → $8.50 retained, $40.00 seller,
$51.50 promoter — with an integration test asserting all three through a real
webhook-driven sale.

The provider's reference is **evidence on the settlement row**, never an input to
any figure above.

### One pricing implementation

The Listing page prices through `prepareCheckout`, the same pure read the sale
uses. A page that read `retailPriceMinorUnits` off a row would be a second
pricing implementation, quietly disagreeing the moment a sale window opened. A
test asserts the displayed total equals the amount that reaches the provider.

---

## 7. Guest checkout

**First-class, and unchanged.** No session means a guest Order. No account is
created, no participant is fabricated, and nothing about the buyer is collected —
the route asks for no email, name, or address, and there is no field in which one
could arrive. An integration test counts both tables across a guest purchase and
asserts neither moved.

The Stripe session likewise carries no `customer_email`, `customer`,
`customer_creation`, `shipping_address_collection`, `billing_address_collection`,
or `phone_number_collection`. `NEVER_ON_ORDER` promised there is no column for
any of it; the adapter makes sure there is nothing to put in one.

### The one-time claim code

`0M.9` mints it once, stores only its SHA-256 digest, and cannot re-issue it.
`1.0` returns it in a short-lived cookie — `HttpOnly`, `SameSite=Lax`,
`Path=/checkout`, `Secure` on an https origin — so the return page can display it
once on the buyer's own machine.

**It is never in a URL.** Not the redirect, not the return URL, not the response
body. A query parameter would put a bearer credential into browser history, into
a `Referer` header, and into Stripe's redirect logs. A test asserts its absence
from all three.

---

## 8. Routes and UI

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/checkout` | `POST` | Place an Order and start a payment; `303` to Stripe |
| `/api/payments/stripe/webhook` | `POST` | Stripe's authoritative result |
| `/api/orders/status?orderId=…` | `GET` | The buyer's bounded read |

**Method absence is the enforcement**: Next returns `405` for a method a route
does not export, and no route exports `OPTIONS` — emitting one would begin a CORS
story these routes deliberately do not have. All three are `force-dynamic`,
`revalidate = 0`, and `no-store`. Nothing runs on import: no Stripe client is
constructed and no credential is read until a request arrives.

Each route file is a translation layer only; every rule lives in a framework-free
handler taking headers and a body string, following
`worker-status-route-handler.ts`.

### Buyer pages

`/listings/[internalListingId]` and `/checkout/result`, both server components,
both deliberately unstyled — marketplace design is not this phase's subject, and
a page that looked finished would invite being treated as finished.

**No client JavaScript at all.** The checkout control is an ordinary
`<form method="post">`; the result page is a read. No client component, no
`fetch`, no Stripe.js, no publishable key in any bundle. That is a security
property before it is a simplicity one.

The form's only field is the Listing id. The price is *rendered* but never
*submitted* — a hidden amount input would be an amount the buyer could edit.

### The status projection

Five fields: the Order id the caller already supplied, its lifecycle, the
currency, the buyer's total, and — only in `PAYMENT_FAILED` — the bounded failure
code.

It carries **no** seller, promoter, Storefront, Product, Listing, bound version,
policy, retention, proceeds, settlement standing, or provider reference. A buyer
needs to know whether their payment worked and what they were charged; every
other field would be a marketplace's private commercial position published to
whoever holds an order id.

**Possession of the Order id is the capability**, deliberately: a guest has no
account by design, so requiring one would break guest checkout. The id is 26
Crockford characters of `crypto.randomBytes` and encodes nothing. A wrong id and
an unknown id return the **same** `404`, for the same reason `claimGuestOrder`
makes every refusal identical.

---

## 9. Stripe Connect

`0M.8` declared `PaymentProviderPort` and left it empty. `1.0` supplied
`createStripeConnectReadinessPort` — **without changing one line of
`payment-account.ts`**, which is the evidence the boundary was drawn correctly.

Stripe's requirement model is translated and then **discarded**:
`individual.verification.document` becomes `DOCUMENT_VERIFICATION_REQUIRED`, and
nothing returned carries `charges_enabled`, `currently_due`, `disabled_reason`, a
requirement string, or a provider message. Readiness is decided in a stated
order: terminally rejected → `DISABLED`; something due from the participant →
`DETAILS_REQUIRED`; Stripe reviewing → `PENDING_PROVIDER`; both capabilities live
→ `ENABLED`; previously working, now partly withheld → `RESTRICTED`; nothing yet
→ `NOT_STARTED`.

Test-mode account creation and hosted onboarding links exist as two plain
functions — **not behind a port**, because `0M.8` declared none for account
creation and inventing one to hold a single Stripe call would be a contract
written for one implementation. They return a `ProviderAccountRef`, which is
exactly what the existing `registerParticipantPaymentAccount` accepts. No
participant data is sent: Stripe collects onboarding details on its own hosted
form, which is the arrangement that keeps them off Monacado's disks.

**No payout, transfer, destination charge, or application fee is executed**, and
none is implemented. No `ProceedsObligation` reaches Stripe. Nothing renders the
onboarding functions — the participant-facing surface is unbuilt.

---

## 10. Tests

| File | Covers |
| --- | --- |
| `stripe-checkout-contracts.test.ts` | 44 tests — SDK boundary, test-mode enforcement, adapter translation, **real signature verification and forgery refusal**, failure mapping, Connect mapping, request refusal, status projection |
| `stripe-checkout.integration.test.ts` | 16 tests — guest and authenticated checkout, promoted economics, duplicate-event idempotency, failure leaving no economics, the browser asserting nothing, the routes end to end |

Signature verification is exercised against real HMAC — a correctly signed body
verifies, a wrong secret is refused, and a body altered after signing is refused.
The SDK is never given a URL.

No new absence matrix was built; `0M.8`'s and `0M.9`'s already exist. The one
`0M.8` assertion this phase touched — "no payment-provider SDK is a dependency" —
was **narrowed rather than deleted**: the server SDK now exists, and what still
holds is that no *browser* payment SDK exists and no provider SDK is imported by
any contract.

---

## 11. Before live mode

Everything below is a real gate, not a checklist item.

**Blocking, and not this phase's to decide.**

- **`0M.T2` — tax.** Checkout sends `taxAmountMinorUnits: 0` because nothing
  calculates tax. Charging a real buyer without nexus determination, product tax
  classification, sourcing, and remittance is a compliance failure, not a rough
  edge.
- **`0M.R2` — transaction risk.** No velocity limits, transaction caps, reserves,
  payout holds, or per-transaction policy selection exist.
- **`0M.N2` — notification delivery.** *(Partly addressed by Phase `1.1`.)*
  Buyers, guests included, now receive confirmation, failure, and expiry notices
  through a **supplemental** email channel, and a guest still gets no obligation
  row — `0M.N1` keys recipients on participants by design, and `1.1` did not
  change that. What remains `0M.N2`'s: the **canonical** admin-panel view, the
  `SUPER_OWNER`/`ADMIN` visibility rule, notification preferences, and a
  production mail vendor.
- **Refunds, chargebacks, and reversal accounting.** Unimplemented. A live
  processor will produce all three within days.
- **Payout execution.** Obligations record what is owed. Nothing moves money.

**Blocking, and this phase's to hand over.**

- **Live-mode configuration**, which does not exist: `STRIPE_MODES` has one
  member and `resolveStripeApiKey` refuses non-test keys. Both must be changed
  deliberately, in a reviewed commit.
- **Webhook endpoint registration and secret rotation** for the live account.
- **HTTPS return URLs.** `MONACADO_STRIPE_ALLOW_LOOPBACK_HTTP` must be false.
- ~~**Order expiry.**~~ **Resolved by Phase `1.1`.** `checkout.session.expired`
  now cancels a still-pending Order through `0M.9`'s own `cancelOrder`, creating
  no economics and never downgrading a `PAID` sale. The decision about when
  abandonment is certain was made the only defensible way: Stripe's fact, not a
  Monacado timer.
- **The line-item description.** A buyer sees "Monacado order" on Stripe's page.
  Fixing it needs a decision about what Monacado is willing to disclose to a
  processor, not a default.
- **Webhook delivery monitoring.** A `409` or a run of `500`s should reach a
  human. Nothing watches.
- **Currency.** The checkout route hard-codes `USD`; multi-currency selection is
  undesigned.

**Not blocking, but true.** Two concurrent deliveries of one event resolve
correctly through a rolled-back transaction and a retry, which is safe but noisy
in logs. A conditional update inside `recordCompletedSale` would make it quiet;
it was not added because it would change `0M.9` code for a cosmetic gain.

---

## Reference

- [`BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md`](BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md) — `0M.9`, the flow this phase executes
- [`PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md`](PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md) — `0M.8`, the readiness port implemented here
- [`MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md`](MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md) — `0M.T1`, the snapshot and settlement row
- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) — the economics Stripe never computes
- [`VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md`](VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md) — `0M.R1`, the configured policy
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md) — financial records are relational-first; nothing here is projected
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
- [`.env.example`](../.env.example)
