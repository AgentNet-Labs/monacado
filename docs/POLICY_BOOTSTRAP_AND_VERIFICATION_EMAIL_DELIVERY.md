# Policy Bootstrap and Verification Email Delivery — Phase `1.4`

**Status:** implemented. The two prerequisites `1.3` created can now actually be
satisfied.

`1.3` did the governance work and stopped one step short of usable in two places,
both of them the same shape — a control that is correct and unreachable:

| `1.3` built | What was missing |
| --- | --- |
| an `ACTIVE` marketplace policy gates activation *and* every checkout | nothing outside a test fixture could put a version there. A fresh deployment refuses every activation and every sale, correctly, forever |
| a verified support contact gates activation *and* every checkout | `issueVerificationChallenge` returned a raw token to its caller and nothing put it in front of the person who has to click it |

This phase is **operational, not architectural**. No `1.3` semantic changed, no
prerequisite was relaxed, no checkout behaviour moved, and nothing was
auto-approved. It supplies an operator path and a seller path to the two states
`1.3` requires.

```
operator ── npm run policy:bootstrap:activate ──▶ MarketplacePolicyVersionRow (ACTIVE)
                                                        └── activation + checkout prerequisite satisfied

seller ──── requestEmailContactVerification ────▶ EmailVerificationChallenge (PENDING)
                    │                                   │
                    └── MailPort (Phase 1.1) ───────────┘
                              │
                       link ──┴──▶ GET /verify-email?token=… ──▶ contact VERIFIED
                                                                      └── support resolver sees it
```

**Nothing here enables live money.** `STRIPE_MODES` still has one member,
`resolveStripeApiKey` still refuses any key not prefixed `sk_test_`, no mail
vendor was selected, no payout executed, no tax remitted, and no
digital-delivery machinery built.

**No migration.** `1.3`'s five tables carry everything this phase needs.

---

## 1. Policy bootstrap

```
npm run policy:bootstrap           # record the shipped version as DRAFT
npm run policy:bootstrap:activate  # record if needed, then ACTIVATE it
npm run policy:bootstrap:inspect   # read and report; write nothing
```

The command reads `MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID` (or `--recorded-by=`)
for the internal `Account` id recorded as having recorded the version. It is
**required**: a governance row records *who* recorded a version, and a command
that invented a recorder would manufacture the one fact the row exists to hold.

The decision logic is `bootstrapMarketplacePolicy`; the script is a translation
layer that parses arguments, prints a bounded report, and sets an exit code —
the same separation `checkout-route-handler.ts` and `run-publication-worker.ts`
already use, so every rule is testable without running a command.

### Activation is a separate word

Recording a version governs nobody. Activating one starts governing live
participants and live sales. So `policy:bootstrap` records and
`policy:bootstrap:activate` activates, rather than one command doing the
consequential half as a side effect of "initialise the database".

### The six outcomes

| Action | When | Writes |
| --- | --- | --- |
| `RECORD_DRAFT` | nothing existed; activation not asked for | policy identity + one `DRAFT` version |
| `RECORD_AND_ACTIVATE` | nothing existed; activation asked for | the above, then `DRAFT → ACTIVE` |
| `ACTIVATE_EXISTING_DRAFT` | the shipped version exists as `DRAFT` | `DRAFT → ACTIVE` on that same row |
| `NO_CHANGE_ALREADY_ACTIVE` | the exact shipped version is already `ACTIVE` | **nothing** |
| `NO_CHANGE_ALREADY_DRAFT` | it exists as `DRAFT`, activation not asked for | **nothing** |
| `REFUSED` | see below | **nothing** |

### Idempotency by observation, not by upsert

The state is read first and the action chosen from it, so a second run reports
`NO_CHANGE_ALREADY_ACTIVE` and writes nothing — not "the same row again", but no
statement at all. An upsert would have been shorter and would have quietly
restamped `recordedAt`, `recordedByAccountId`, and `activatedAt` on exactly the
row the table exists to keep immutable. The test asserts the row is
**byte-identical** across two runs, not merely still active.

### The four refusals, and why none is repaired

| Refusal | Situation | Why it is somebody else's decision |
| --- | --- | --- |
| `CONFLICTING_ACTIVE_VERSION` | a **different** version is `ACTIVE` | replacing it would retire terms participants are live under, silently. The standing version is left `ACTIVE` with `retiredAt` still null, and the shipped version is not even recorded |
| `CONTENT_HASH_MISMATCH` | the persisted hash and the source document disagree | the prose moved without a version bump. The row is the **only evidence** that happened; rewriting it would destroy it |
| `SHIPPED_VERSION_RETIRED` | the shipped version is `RETIRED` | `0M.R1`'s rule, kept — a retired version never returns, because reactivation makes "which terms applied when" unanswerable |
| `RECORDING_ACCOUNT_NOT_FOUND` | the named recorder does not exist | governance records who recorded a version, and a fabricated recorder is worse than an unrecorded one |

**No historical version is ever written to.** The only writes are: create the
policy identity if absent, create the shipped version as `DRAFT` if absent, and
move that same row `DRAFT → ACTIVE`. There is no path here that retires anything
— `activateMarketplacePolicyVersion` retires a standing version, so the bootstrap
refuses *before* reaching it whenever one exists.

### The report

```
Monacado — marketplace policy bootstrap
  mode:             APPLY
  policy id:        mon:mpol:M0NACAD0MARKETP0ACEP000CY0
  policy version:   1.0.0
  content ref:      marketplace-policy/1.0.0
  source hash:      sha256:e50e877…
  persisted hash:   sha256:e50e877…
  persisted state:  ACTIVE
  action:           ACTIVATE_EXISTING_DRAFT
  applied:          yes
  activated:        yes
```

followed by the same object as one line of JSON, for a script. The report is an
**allow-list built from the outcome and from nothing else**, so there is no path
by which an environment value could reach it: no `DATABASE_URL`, no other
variable, no account email, and no policy prose. A test asserts each of those
absences.

The source hash is **derived from the source module on every run**, never read
from a stored constant. The whole binding is worthless if the hash can be stale.

### Production writes are gated, not forbidden

This command is eventually the way a production deployment gets its governing
policy, so refusing production permanently would be refusing the job. A
**mutating** run against a target classified production requires the argv flag
`--confirm-production`; without it, it refuses **before the database client is
constructed and before any write**:

```
$ NODE_ENV=production npm run policy:bootstrap:activate

Monacado — marketplace policy bootstrap (preflight)
  environment:      PRODUCTION
  mode:             APPLY
  policy id:        mon:mpol:M0NACAD0MARKETP0ACEP000CY0
  policy version:   1.0.0
  content ref:      marketplace-policy/1.0.0
  source hash:      sha256:e50e877…
  requested action: RECORD_AND_ACTIVATE
refused: PRODUCTION_CONFIRMATION_REQUIRED
a mutating bootstrap against a production target requires --confirm-production
```

The preflight block is printed **before any production-capable mutation** —
permitted or refused — so an operator can check what they are about to do against
what they meant to do. Everything in it comes from the source module and the
invocation, so it needs no database read and can be shown before a client exists.

| Rule | Why |
| --- | --- |
| the confirmation is an **argv flag**, never an environment variable | a variable is set once in a deployment and then silently authorises every later invocation, which is exactly the accidental supply this gate prevents. It has to be typed, each time, by the person doing it |
| `NODE_ENV` **classifies**, it never authorises | a classification decides whether a confirmation is *demanded*; it can never decide that one was *given* |
| nothing is inferred from `DATABASE_URL`, a CI variable, or a hostname | those are guesses, and a guess that says "this looks like production" is one word away from a guess that says "…so this must be authorised". A test asserts each of them classifies `NON_PRODUCTION` |
| `--inspect` never needs it | it writes nothing, in any environment, so there is nothing to confirm |

### Two confirmations, because they are two decisions

`--confirm-production` authorises **writing**. It does not authorise
**activating**. A production activation therefore needs both words:

| Invocation against a production target | Result |
| --- | --- |
| `policy:bootstrap:activate` | refused — no confirmation, nothing written |
| `policy:bootstrap --confirm-production` | version recorded `DRAFT`; **nothing activated** |
| `policy:bootstrap:activate --confirm-production` | recorded and activated |

"Yes, write to production" and "yes, start governing live sellers and live sales
with these terms" are different answers, and must not be given by one word. The
gate function takes no `activate` input at all, so the two cannot be conflated.

Every conflict refusal — conflicting `ACTIVE` version, hash mismatch, retired
shipped version, missing recorder — applies unchanged whether or not the write
was confirmed, and no automatic retirement or replacement was added.

**No production execution has occurred.** Every run of this command so far, and
every test of the gate, has been against the disposable local database; the
production path is exercised only by classifying the *environment*, never by
contacting a production system.

Exit codes: `0` success or no-change, `1` refusal, `2` usage error, `75`
(`EX_TEMPFAIL`) a failure worth retrying against a working database.
`process.exit` is never called.

---

## 2. Verification email delivery

`requestEmailContactVerification` is the whole flow:

```
1. resolve the participant, and check the acting account owns it
2. resolve the public origin           ← before anything is minted
3. resolve the address being proved
4. issueVerificationChallenge          ← 1.3, unchanged: supersedes, digests, returns the token once
5. build the link, render the message
6. MailPort.send                       ← 1.1's seam, unchanged
```

### Through `1.1`'s seam, and no second one

The message goes to `MailPort` — the provider-neutral boundary Phase 1.1
declared — resolved by `resolveMailPort`. **No SMTP client, no vendor SDK, no
template engine, and no HTML part** was introduced. A disabled deployment refuses
the message with `CHANNEL_NOT_CONFIGURED` exactly as it does for every other
notice, the challenge is still issued, and nothing pretends a message went out.

### Ordering is a safety property

The public origin is resolved **before** a challenge is minted. A misconfigured
deployment therefore refuses without having superseded the seller's working link
— the alternative burns a live challenge to discover that no link could have been
built from it. A test asserts zero challenges exist after such a refusal.

### The token is never returned

`issueVerificationChallenge` hands the raw token back once; it goes straight into
the link and is not passed on. `VerificationDispatch` has exactly two fields —
`challenge` and `delivery` — so no route, page, log line, or test fixture can
surface a working credential. The tests obtain the token the way a recipient does:
by reading it out of the delivered message body.

Only the hex SHA-256 digest is written, which is `1.3`'s rule, unchanged.

### No `NotificationDelivery` row, deliberately

`1.1`'s delivery table is evidence about **notices that accompany marketplace
obligations** — an order, a sale, a payment — and its three vocabularies
(`DeliveryAudience`, `NotificationCategory`, `NotificationSubjectKind`) are
`0M.N1`'s *obligation* vocabularies, reused. A verification link is none of those
things: it is an account-security credential addressed to a participant about
their own contact record, owing nothing and confirming nothing. Fitting it in
would have required widening all three, and making "what does Monacado owe?" a
harder question to answer for the benefit of one row.

The `EmailVerificationChallenge` row already records that a proof was issued and
what became of it. What is genuinely missing is whether the *message* was
accepted; that is returned to the caller rather than stored. **Recorded delivery
evidence for non-obligation mail is `0M.N2`'s**, which owns the feedback loop
that would make such a row worth keeping.

### The message

Six things and no seventh: who it is from, why it arrived, the link, when the
link dies, what to do if it was unexpected, and a signature.

It carries **no identifier at all** — no participant id, no contact id, no
challenge id, no account id, no seller name, and no marketplace state. It does
not even name the address it is verifying: the recipient is holding it, and
repeating it back only adds a line for a mis-delivered copy to disclose. This is
the one message Monacado sends to an address it does *not yet* believe in, so it
says the least of any of them.

---

## 3. The verification URL

Built in one place, from the origin this deployment already declares:

| Part | Source |
| --- | --- |
| origin | `MONACADO_APP_ORIGIN` — the same variable `checkout-runtime-config.ts` reads, validated by the same `normalizeOrigin`, **imported rather than restated** |
| path | `/verify-email` |
| query | `token=<opaque>` — and nothing else |

**Never derived from a request.** A `Host` header is attacker-controlled, and an
origin taken from one turns every verification email into a link to whatever host
asked for it — a working credential-harvesting page sent from Monacado's own
domain.

**No participant id, contact id, challenge id, or address is in the URL.** The
token is already a 256-bit single-use credential; it is sufficient on its own,
and every additional identifier is one more internal fact deposited in browser
history, `Referer` headers, and any proxy log between the recipient and Monacado.

`readVerificationLinkOrigin` **throws rather than defaulting**. A default here is
a link to `localhost` arriving in somebody's inbox, or a link to a host this
deployment does not control.

---

## 4. The consumption endpoint

`GET /verify-email?token=…` — a server component with no client JavaScript, no
form, and nothing to retry. All behaviour is in `handleVerifyEmailRequest`, which
takes a token and returns a bounded outcome, so it is testable without
constructing a framework request.

| Outcome | When | Page says |
| --- | --- | --- |
| `VERIFIED` | a pending, unexpired challenge matched | "Email address verified" |
| `ALREADY_USED` | the challenge matched and had already been consumed | "This link has already been used" |
| `NOT_VALID` | unknown, malformed, expired, or superseded | "This link is not valid" |

Expired, superseded, and unknown collapse into **one** answer. That is `1.3`'s
rule, not a new one: distinguishing "no such token" from "that token expired"
turns the page into a probe for which tokens exist. `ALREADY_USED` is safe to
separate because reaching it requires holding a token that was genuinely issued —
it tells the holder about their own link and nobody about anybody else's. A test
asserts that a never-issued token and a superseded one produce the identical
result.

**Nothing identifying comes back.** The result is one field. No address, no
participant, no contact, no challenge id, and no account — the page is reachable
by anyone with a URL, and that URL is exactly what somebody guessing tokens
would have.

A token that does not match the 43-character base64url shape is refused **without
a database lookup**, so a flood of junk in the query string is not a flood of
queries. A persistence failure is reported as `NOT_VALID` rather than surfacing a
stack trace to a stranger; the real cause is read from the logs.

---

## 5. Reissue and supersession

`requestEmailContactVerification` **is** the reissue path. Calling it again
supersedes the outstanding challenge and sends a new link — `1.3`'s existing
rule, unchanged — so **only the newest link can ever verify the contact**. A
seller who lost the first email asks again; the first link is dead from that
moment, which is the safe direction to fail in.

### There is no public reissue endpoint

The acting account must **own the participant**. `MarketplaceParticipant` holds
one participant per account, so ownership is a single comparison, and nothing
routes to this without an authenticated principal — there is no HTTP surface at
all. That is what stops it being an endpoint that mails arbitrary addresses on
request.

The destination is never chosen by the caller. It is read from `Account.email`
for a `PRIMARY_PROFILE` contact, and from the contact row for a
`DEDICATED_SUPPORT` one. Nominating a dedicated address is a separate, deliberate
act — `upsertEmailContact` — because doing it implicitly here would let one call
both choose a support address and mail it.

**Rate limiting is not implemented.** It is safe to omit only because a caller
cannot aim the traffic: the sole destination is an address Monacado already holds
for that participant. A seller who holds the button down still sends themselves
unbounded mail from Monacado's domain, which is a reputation cost Monacado pays —
recorded in `VERIFICATION_OPERATIONAL_GAPS` as a future operational control.

---

## 6. What this does *not* change

| Guarantee | State |
| --- | --- |
| `1.3` activation semantics | **unchanged**. Both prerequisites still apply and still fail closed |
| `1.3` checkout semantics | **unchanged**. `MARKETPLACE_POLICY_UNAVAILABLE` and `SELLER_SUPPORT_CONTACT_UNAVAILABLE` still refuse a sale before `placeOrder` |
| participant admission | **not touched**. Verification satisfies a *prerequisite*; admission remains the governed activation flow's decision |
| Stripe mode | test only |

**Verification does not activate a seller.** A test asserts the participant is
still `DRAFT` and holds zero `ParticipantActivation` rows after a successful
verification. What changes is only that `resolveSellerSupportContact` — the one
canonical resolver — now returns the address, so the seller *can* satisfy the
prerequisite when the governed flow evaluates it.

Likewise, bootstrapping the policy satisfies the `ACTIVE`-policy prerequisite and
activates nobody.

---

## 7. Mail provider posture

**Unchanged from `1.1`, and deliberately so.** The repository still identifies no
mail vendor: nothing in `package.json`, `.env.example`, or any governing document
names one, and selecting one is choosing a third party, a data-processing
relationship, and a deliverability story on Monacado's behalf. That is a reviewed
decision, not a phase's incidental one.

| Adapter | Purpose |
| --- | --- |
| `createLogMailAdapter` | local development. Logs a **redacted** destination and the subject; never the body |
| `createCapturingMailAdapter` | tests. Keeps whole messages so assertions can read the delivered link |
| `createDisabledMailAdapter` | the default. Refuses with `CHANNEL_NOT_CONFIGURED` |

The verification flow is proved end-to-end in tests through the capturing
adapter: message sent, address correct, link correct, token digest matching,
contact verified. Adding SES, Postmark, or Resend later is a new adapter beside
these three and **no change to any caller** — including this one.

---

## 8. Recorded for future operational work

`VERIFICATION_OPERATIONAL_GAPS` names each of these in code rather than leaving
them to be discovered. Each is an operational control: the mechanism is correct
without them and less safe to run at volume.

| Gap | Owner |
| --- | --- |
| **No rate limiting** on verification requests | future operational control |
| **No bounce, complaint, or suppression handling.** `REVERIFY_REQUIRED` and `DELIVERY_FAILED` exist and nothing transitions into them automatically | `0M.N2` — it owns the provider feedback loop |
| **No production mail vendor** selected or configured | a deliberate, reviewed decision |
| **No delivery-evidence row** for non-obligation mail | `0M.N2` |
| **A mail scanner or link prefetcher that follows the link consumes the challenge** before the recipient does. The contact still ends up verified — the correct outcome — but the person clicking sees "already used". A confirmation step would fix it | accepted in this phase; recorded, not papered over |
| **No seller-facing UI.** Nomination and reissue are service calls behind an ownership check; nothing renders them | the participant-facing surface `0M.8` deferred |

---

## 9. Files

| File | Role |
| --- | --- |
| `src/server/policy/marketplace-policy-bootstrap.ts` | the bootstrap decision, refusals, and idempotency |
| `scripts/bootstrap-marketplace-policy.ts` | the operator command: arguments, environment classification, production write gate, preflight, report, exit codes |
| `src/server/policy/verification-link.ts` | the public origin and the one place a verification URL is built |
| `src/server/policy/verification-notice-service.ts` | issue → link → render → `MailPort`; the reissue path and its ownership check |
| `src/server/policy/verification-route-handler.ts` | consumption, expressed without Next.js |
| `app/verify-email/page.tsx` | the minimal success/failure page |
| `test/policy-bootstrap-and-verification-contracts.test.ts` | offline: link, message, handler shape, command report |
| `test/policy-bootstrap-and-verification-email.integration.test.ts` | against the disposable local database |

The integration suite exercises the bootstrap against **its own** policy identity
through a `shipped` source seam — recording, activating, and retiring versions of
the real policy would rewrite the terms every other suite's participants are
activated under. The seam is a *source* seam, not a content seam: whatever
document is supplied, the hash is still derived from it and still checked against
what is persisted.
