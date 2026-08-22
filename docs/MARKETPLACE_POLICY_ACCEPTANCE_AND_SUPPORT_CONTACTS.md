# Marketplace Policy, Acceptance, Support Contacts, and Email Verification — Phase `1.3`

**Status:** implemented. The marketplace can now state what it is, what each party
owes, and who a buyer reaches when something goes wrong.

`1.0` made a purchase executable, `1.1` made its outcome communicable, and `1.2`
built the controls live money requires. All three left the same gap: Monacado
took payment as merchant of record without ever having written down what that
means, and activated sellers with no verified way for a buyer to reach them.

```
policy source (versioned, hashed)
    │
    ├── audience projection ─── SELLER · PROMOTER · BUYER
    │
    ├── acceptance evidence ─── participant × exact version × audience
    │        └── activation prerequisite
    │
    └── Order binding ────────  the version that governed one purchase
             └── REQUIRED: no ACTIVE version, no new Order

support contact:  verified dedicated → verified primary → UNAVAILABLE
                  ├── activation prerequisite
                  └── checked again at every transaction
```

**Nothing here enables live money.** `STRIPE_MODES` still has one member and
`resolveStripeApiKey` still refuses any key not prefixed `sk_test_`. No mail
vendor was wired, no payout executed, no tax remitted, and no digital-delivery
machinery built.

---

## 1. One policy source, many renderings

The policy is a **structured document**, not a page of HTML: a `policyId`, a
`policyVersion`, a title, and an ordered list of sections. Each section names the
audiences it is shown to.

```ts
selectSectionsForAudience(document, "SELLER")   // the only projection
selectSection(document, "DIGITAL_DELIVERY")     // one section, for narrow surfaces
```

| Audience | Sections shown |
| --- | --- |
| `SELLER` | Monacado's role · seller responsibilities · digital delivery · checkout information · commercial terms · policy changes |
| `PROMOTER` | Monacado's role · promoter responsibilities · commercial terms · policy changes |
| `BUYER` | Monacado's role · digital delivery · checkout information · policy changes |

**Monacado's role is shared, not triplicated.** Three copies of one fact would be
three things to keep identical, and the copy that drifts is always the one
somebody reads.

**Order is the document's**, never re-sorted per audience — a policy read in a
different order is a different policy. A test asserts each audience view is the
document order filtered, not a reordering.

**No markup in the content.** Paragraphs are plain strings, so an onboarding page,
a printable document, and a receipt disclosure all render from the same source
rather than from three files that agree today.

### What the policy will not say

`NEVER_ON_MARKETPLACE_POLICY` bans three kinds of field by construction, and the
schema is a `strictObject` so an unlisted field is refused rather than ignored:

- **secrets** — this content is rendered publicly; a verification token or signing
  secret reaching a policy page is a credential on a billboard
- **legal conclusions** — `governingLaw`, `jurisdiction`, `warrantyDisclaimer`,
  `liabilityCap`, `arbitrationClause`. Those are counsel's, not a contract
  module's. The prose states **operating rules**: who does what, and what happens
  when they do not.
- **mutable commercial figures** — the retained percentage, the fixed retained
  amount, and commission rates. `0M.R1` owns them.

The policy therefore *references* the commercial policy rather than restating it.
A copied rate is a second authority capable of disagreeing with the one that
actually priced a sale.

---

## 2. Versioning, and the hash that makes it mean something

`MarketplacePolicyVersionRow` mirrors `0M.R1`'s `CommercialPolicyVersionRow`
exactly — same lifecycle, same `activeMarker` unique-index trick, same reasoning.

```
DRAFT ──activate──▶ ACTIVE ──superseded──▶ RETIRED
                      ▲                        │
                      └──────── never ─────────┘
```

- **`recordMarketplacePolicyVersion` has no `status` parameter.** A version is
  created `DRAFT` and nothing else, so a caller cannot record a version as
  already governing somebody.
- **Activation is one transaction** that retires the standing version and
  activates the new one, so there is never an instant with two or none.
- **A retired version does not come back.** Reactivating one would make "which
  terms applied when" unanswerable.
- **At most one `ACTIVE`,** enforced by a unique index on a nullable marker
  column, because MySQL has no partial indexes.

### The content hash

Every version carries `contentHash` — `sha256:` over the canonical JSON of its
source document, **derived, never supplied**. A caller-provided hash could name
content that does not exist, which is exactly the binding this prevents.

`readMarketplacePolicy` recomputes it on every read and throws
`PolicyContentMismatchError` when it disagrees. That check is the point: a
governance row asserting a version is worthless if the prose behind it can move.
The failure it catches — prose edited without a version bump — is silent
otherwise, and it is the failure that makes every acceptance record a lie.

**Rendered output is never authoritative.** A page, a PDF, an email body: all are
projections of `(policyId, policyVersion)`. The stored version and its verified
source are the record.

---

## 3. Acceptance is evidence, and evidence is not rewritten

`ParticipantPolicyAcceptance` records one participant undertaking **one exact
version** as **one audience**, with the mechanism, the accepting account, and both
the accepted and recorded instants.

| Field | Why |
| --- | --- |
| `policyVersion` | "they accepted the terms" is worthless without "which terms" |
| `contentHash` | copied from the verified version, so the exact bytes are pinned |
| `audience` | a seller promises fulfilment and support; a promoter promises truthful promotion. One acceptance standing in for the other would record an agreement nobody made |
| `mechanism` | `ONBOARDING_AFFIRMATION` or `OPERATOR_RECORDED` |

**There is no status, note, or `withdrawnAt` field.** The record has no mutable
half — a test asserts each of those is refused by the schema.

**A newer version does not touch an older acceptance.** Re-acceptance is a **new
row**, and both remain queryable. An integration test accepts `1.0.0`, activates
`2.0.0`, and asserts the first acceptance is unchanged, does **not** satisfy the
new version, and coexists with the second.

**Buyers accept nothing.** `BUYER_ACCEPTANCE_MODEL` is
`DISCLOSURE_NOT_ACCEPTANCE`: gating a purchase behind a click-through adds
friction to the one flow that must not have it, and a guest has no durable
identity to record an acceptance against. Buyer-facing sections are **disclosed**
at checkout and on the receipt instead. The acceptance record refuses a `BUYER`
audience outright.

**Re-acceptance is a flag, not an engine.** `requiresReacceptance` sits on the
version; whether an audience is outstanding is a query against the active
version. No scheduler, no campaign, no reminder machinery — none of it is needed
yet, and each piece would be a thing to maintain before it is a thing to use.

---

## 4. Activation now requires acceptance and a support contact

`evaluateActivationApproval` gained two refusal codes and two inputs. Both are
**read** in `assertApprovable` and **supplied** to the evaluator, which stays pure.

| Code | Means |
| --- | --- |
| `MARKETPLACE_POLICY_NOT_ACCEPTED` | an activatable role has not accepted the current version |
| `NO_VERIFIED_SUPPORT_CONTACT` | no address resolves as the effective support contact |

They are distinct codes because they have different remedies — agreeing to
something, and fixing a mailbox — and a reviewer is told both at once rather than
one per attempt.

**The requirement is derived from the roles held.** A seller-only participant is
never asked to undertake promoter obligations. A participant with neither role
owes no acceptance; activation refuses them for the absence of a role, which is
the more accurate complaint.

**It fails closed.** With no `ACTIVE` policy, every required audience is treated as
outstanding. An unconfigured control that permits activation is not a control.

> **Operational consequence.** A deployment must record and activate the shipped
> policy version before any participant can be activated. Suites that activate
> participants call `ensureShippedMarketplacePolicyActive` for exactly this
> reason; a production deployment needs the equivalent one-time step.

---

## 5. Seller support contacts

Every activated seller must be reachable. The precedence is:

```
1. verified DEDICATED_SUPPORT address
2. verified PRIMARY_PROFILE address (the seller's Account.email)
3. unavailable — NO_VERIFIED_ADDRESS | VERIFIED_ADDRESS_REQUIRES_REVERIFICATION
```

- **No `support@` local part is required.** A seller who runs their business from
  one mailbox is not forced to invent a second one.
- **An unverified dedicated address never displaces a working primary.**
  Switching optimistically would make every typo an outage on the one channel a
  buyer uses to complain about it.
- **A degraded dedicated address falls back** rather than failing, for the same
  reason.
- **The two unavailable reasons are distinct** so an operator knows whether to
  chase onboarding or an outage.

### One resolver, called by everyone

`resolveEffectiveSupportContact` is a pure function; `resolveSellerSupportContactIn`
supplies it with persisted state. Checkout, receipts, delivery support routing,
and seller-facing surfaces all go through it. Four copies of a fallback rule is
four chances to disclose the wrong address — and the wrong address means a
buyer's complaint reaches nobody. A test greps the checkout, notification, and
order-view services and asserts none of them mentions `DEDICATED_SUPPORT`.

### Where each address lives

| Purpose | Address read from |
| --- | --- |
| `PRIMARY_PROFILE` | the participant's `Account.email` — **never copied** into the contact row |
| `DEDICATED_SUPPORT` | the contact row, the only place it exists |

That asymmetry is `0M.5`'s rule kept: the primary address already lives on
`Account`, and a second copy would be a second thing to leak. Supplying an address
for a `PRIMARY_PROFILE` contact is **refused**, not silently dropped.

### Privacy

A seller's primary address is operational private data. It becomes
customer-facing only by resolving as the effective support contact — which is an
explicit disclosure the seller makes by activating without nominating an
alternative. Nothing publishes it into a capsule.

---

## 6. Email verification

### What it proves, and what it does not

`VERIFICATION_METHOD` states the posture in the contract itself:

| Aspect | Position |
| --- | --- |
| syntax | required |
| domain routing | best-effort advisory |
| ownership | signed single-use link |
| SMTP mailbox probing | **not used** |
| proves | control at **one instant** |

`VRFY` and dial-up probes are unreliable — catch-all domains accept everything,
greylisting rejects everything on first contact — widely treated as abuse, and
prove nothing about who controls a mailbox even when they answer.

### The token never touches storage

`issueVerificationChallenge` returns the raw token **once**; only its SHA-256
digest is written. Same construction as `0M.9`'s guest claim code and `1.1`'s
delivery destination.

A plaintext token column is a table of working account takeovers, and it is the
kind of column that gets added "just for debugging" and never removed. A test
greps the whole Prisma schema for one.

| Property | How |
| --- | --- |
| high entropy | 256 bits, base64url |
| expiring | 24h TTL, checked on consumption |
| single-use | consumed inside the same transaction that verifies the contact |
| hashed | hex SHA-256, compared with `timingSafeEqual` |
| scoped | bound to one contact, with a digest of the address being proved |

**Issuing supersedes.** Any outstanding challenge for the contact is `SUPERSEDED`
first, so exactly one token is live and an abandoned attempt cannot be completed
later by whoever finds the email.

**Replacing an address un-verifies it.** A seller who mistypes an address and
retypes it cannot accidentally verify the first.

**Every refusal looks the same.** `VerificationRefusedError` carries a bounded
reason and no detail. Distinguishing "expired" from "never existed" would make
this an oracle for probing which tokens exist — the same reasoning `claimGuestOrder`
applies. The one exception is `ALREADY_CONSUMED`, which tells a legitimate user
who clicked twice something useful and tells an attacker nothing they did not
already have.

### Nothing about the person

The challenge records that a proof was issued and what became of it. No IP
address, no user agent, no attempt counter, no bounce score — `NEVER_ON_EMAIL_CONTACT`
refuses each by construction.

### No mail vendor

The token is returned to the caller; delivering it is the caller's problem.
`1.1`'s provider-neutral mail interface remains the seam, and **no production
vendor is wired**. Per `AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` §3/§3a, the
admin panel remains the canonical notification channel and email is supplemental.

---

## 7. Reachability and bounces

Four states, with exactly one usable:

| State | Meaning |
| --- | --- |
| `UNVERIFIED` | setup not finished |
| `VERIFIED` | the only usable state |
| `REVERIFY_REQUIRED` | was good, needs proving again |
| `DELIVERY_FAILED` | was good, delivery is failing |

`REVERIFY_REQUIRED` is deliberately not `UNVERIFIED`: the distinction records that
the address **was** once good, which tells an operator this is a regression rather
than unfinished setup.

`BOUNCE_POSTURE` states the honest position: the states exist, **nothing
transitions into them automatically in this phase**, the future signal source is
`0M.N2` provider feedback, and the remedy on degradation is that the seller
supplies and verifies a replacement.

Degrading keeps `verifiedAt` and sets `degradedAt`, so an address can stop being
trustworthy **without** rewriting the record of when it was trusted.

---

## 8. Every new transaction is bound to a governing policy version

`Order` gained two nullable columns, `marketplacePolicyId` and
`marketplacePolicyVersion`, bound to the version row by composite key.

**Checkout resolves the `ACTIVE` version before an Order exists, and binds it.**
There is no path that creates a Phase-1.3-era Order without a governing version.

**A missing `ACTIVE` policy is a commerce-readiness failure**, not a documentation
gap: `MarketplacePolicyUnavailableError` / `MARKETPLACE_POLICY_UNAVAILABLE`,
raised **before** `placeOrder`, so a refused transaction leaves no Order, no
payment attempt, and no evidence behind — the same rule the risk gate and the tax
boundary follow.

Monacado is merchant of record. Selling under terms it cannot afterwards name is
worse than not selling, because the resulting Order is an *unanswerable* question
rather than a missing one. This is also what closes the lifecycle hole: retiring a
version with nothing to replace it stops new commerce rather than letting it
continue silently ungoverned. It is an **operator/configuration failure, not a
buyer fault** — the route answers `503`, repaired by activating a version.

The columns stay nullable **only** for backward compatibility with pre-1.3 Orders.
Nothing backfills them, and no historical Order is given a policy it never had.

### Transaction-time seller reachability

Activation already requires a verified support contact — but a mailbox can stop
working the day after, and the harm lands per transaction: a buyer with a problem
and no destination for it. So checkout asks again, before the Order exists.

`SellerSupportContactUnavailableError` / `SELLER_SUPPORT_CONTACT_UNAVAILABLE`,
answered `409` rather than `503`: the marketplace is working, this one seller is
not currently sellable — the same shape of answer as `LISTING_NOT_PURCHASABLE`.
The error carries **no address and no reason detail**.

Checkout asks the **canonical resolver** a yes/no question through
`hasUsableSupportContactIn` and never learns the address. The precedence is not
restated there — a test greps the checkout service and asserts it mentions neither
purpose constant nor the resolver's own name. So a seller whose dedicated address
degrades keeps selling on their verified primary, and a seller with neither stops
until one is restored.

**These supplement the activation gates; they do not replace them.** Both
prerequisites remain in `evaluateActivationApproval`.

### Receipt semantics: two different clocks, deliberately

| | Time semantics | Why |
| --- | --- | --- |
| **governing policy** | the version **stored on the Order** — a historical snapshot | a receipt opened next year must show the disclosures that applied when the purchase was made |
| **seller support destination** | the **current** effective contact, resolved at read time | support must route to a mailbox that works now; sending a buyer to the address that worked at checkout would send them nowhere |

`readOrderPolicyView` therefore reads the Order's exact `policyVersion` and never
substitutes today's, while resolving the support contact fresh on every call.
**No support-address snapshot is added to `Order`** in this phase: a frozen
address is a wrong address the moment the seller changes mailbox.

`readOrderPolicyView` answers the four questions a receipt needs:

1. which policy version governed this purchase
2. its buyer-facing sections
3. the seller's effective support contact
4. the commercial policy the sale was priced under, **as a reference**

**No prose is copied onto the Order.** The version is authoritative; a copied
paragraph would be a second answer able to disagree with it.

**Orders predating the binding return `policyVersion: null`** rather than falling
back to the current version. Showing a buyer today's terms for a purchase made
under yesterday's would be worse than showing none, because it would look
authoritative. A pre-1.3 Order is therefore readable as **historical and
unbound**, with its commercial-policy binding untouched.

This is not a receipt engine — no rendering, no template, no PDF, no delivery. It
answers the questions a future receipt will ask, so that building one is a
presentation problem rather than a policy-archaeology problem.

---

## 9. Digital delivery — who owes what

The policy states the split `1.2` declared, for the parties it binds:

| Monacado | Seller |
| --- | --- |
| entitlement and credential infrastructure | the product, and keeping it available |
| issuing short-lived scoped credentials | authorising access beyond the allowance |
| routing exceptional requests to the seller | product-delivery support |

The default allowance of **5 successful downloads** is interpolated from
`DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE`, not typed into the prose — a test asserts
both the constant and its appearance in the policy text, so the number cannot
drift between the code and what sellers were told.

**No delivery machinery was built in this phase.** The entitlement, artifact,
grant, and token architecture remains reserved as `1.2` left it.

---

## 10. Tests

Two suites, 60 cases.

**`test/marketplace-policy-contracts.test.ts`** (33) — no network, no mail, no
database. Audience projection and document order; the closed audience and section
key sets; the allowance and the durable-entitlement-versus-credential distinction
in the prose; references instead of copied figures; banned fields and banned legal
conclusions; no markup; content-hash determinism, key-order independence, and
single-character sensitivity; acceptance shape including the refused `BUYER`
audience and the absent mutable fields; the full resolver precedence table; the
one usable state; that no other service reimplements the fallback; contact-record
invariants; the verification posture and token properties; that the schema has no
plaintext token column; and both new activation refusals, including that they stay
distinct from profile completeness.

**`test/pre-live-commerce-controls.integration.test.ts`** gained a
*transaction-time commerce readiness* section (6) — it already owns the Product,
Storefront, Listing, commercial-policy, risk-policy, and tax fixtures a checkout
needs. Covers: the exact `ACTIVE` version bound to the Order; refusal with no
`ACTIVE` version leaving no Order behind; refusal when the seller's contact
degrades to unusable; a verified dedicated address selling, and still selling
after it degrades because the primary remains; that checkout mentions neither
purpose constant nor the resolver's internals; and a pre-1.3 Order reading as
historical and unbound with its commercial-policy binding intact.

**`test/marketplace-policy.integration.test.ts`** (27) — against disposable MySQL
at `127.0.0.1:3308`, self-skipping unless `RUN_DB_TESTS=1`. Version lifecycle
including retirement, the one-active invariant, refused reactivation, and the
drift refusal; acceptance persistence, idempotence, role separation, and history
retention across a version change; the verification flow end to end — digest-only
storage, TTL, consumption, replay refusal, expiry, supersession, and re-typed
address; support-contact resolution over real rows including degradation; and the
activation refusals for an unaccepted policy, a missing support contact, and both
at once.

The suite uses its **own policy identity**, never the shipped one: a suite that
activated and retired versions of the real policy would be rewriting the terms
every other suite's participants activated under.

### Two existing suites changed

`0M.8` and `0M.R1` activate participants, so the new prerequisites are now real
for them. Their fixtures **satisfy** the prerequisites through the real flows —
`test/support/marketplace-policy-fixture.ts` records the acceptance and carries a
verification token through issue and consume — rather than routing around them. A
fixture that wrote `state: "VERIFIED"` directly would be asserting the very thing
verification exists to establish.

One assertion in `test/storefront-record.test.ts` was **narrowed**, not removed:
its "no CASCADE" slice ran from `model Storefront {` to end-of-file, so it
silently policed every model any later phase appended. That was never what it
asserted — three `onDelete: Cascade` relations already sat *before* Storefront on
subordinate rows (`AccountSession`, `ParticipantProfile`,
`ParticipantPaymentRequirementRow`), which is the established treatment for a row
with no meaning apart from its parent. It is now bounded to the three tables it
names, and still requires at least six `RESTRICT` keys among them.

---

## 11. Migration

One additive migration,
`20260821235120_add_marketplace_policy_acceptance_and_email_contacts`:

- five new tables — `MarketplacePolicy`, `MarketplacePolicyVersionRow`,
  `ParticipantPolicyAcceptance`, `ParticipantEmailContact`,
  `EmailVerificationChallenge`
- two **nullable** columns on `Order`
- seven foreign keys

No column dropped, no table dropped, no data rewritten. Applied to disposable
MySQL only. `migrate diff --from-migrations --to-schema-datamodel` reports no
difference against the schema.

`ParticipantPolicyAcceptance` holds a `RESTRICT` key to the participant — evidence
does not vanish because a row above it did. Contacts and challenges cascade, being
subordinate state with no meaning apart from their parent.

---

## 12. What this phase did not do

- **no live Stripe** — test mode only, unchanged
- **no payouts, no tax remittance**
- **no digital-delivery execution** — the architecture stays reserved
- **no mail vendor**, no bounce processing, no automatic state transitions
- **no receipt rendering** — the data a receipt needs, not the receipt
- **no support-address snapshot on `Order`** — support routes to the current
  mailbox, deliberately
- **no re-acceptance engine** — a flag and a query, nothing scheduled
- **no storefront work**

---

## Reference

| Concern | Module |
| --- | --- |
| policy contract and projection | `src/contracts/marketplace/marketplace-policy.ts` |
| the policy text and its hash | `src/contracts/marketplace/marketplace-policy-content.ts` |
| contacts, states, resolver, verification posture | `src/contracts/marketplace/participant-email-contact.ts` |
| version lifecycle and verified reads | `src/server/policy/marketplace-policy-service.ts` |
| acceptance evidence | `src/server/policy/policy-acceptance-service.ts` |
| contacts and challenges | `src/server/policy/email-verification-service.ts` |
| the canonical support-address resolution | `src/server/policy/support-contact-service.ts` |
| receipt/checkout policy view | `src/server/policy/order-policy-view-service.ts` |
| activation prerequisites | `src/contracts/marketplace/activation-review.ts`, `src/server/marketplace/activation-service.ts` |
| transaction-time gates | `src/server/payments/executable-checkout-service.ts` |
| refusal codes and HTTP mapping | `src/server/marketplace/order-errors.ts`, `src/server/payments/checkout-route-handler.ts` |

Related: [`PRE_LIVE_COMMERCE_CONTROLS.md`](PRE_LIVE_COMMERCE_CONTROLS.md) ·
[`PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md`](PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md) ·
[`ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md`](ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md)
