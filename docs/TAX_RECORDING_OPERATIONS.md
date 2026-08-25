# Tax Recording Operations and Recovery (Phase 1.8)

Phase 1.7 made tax recording **durable**. This makes it **dependable** — the
difference between work that survives a crash and work that actually runs.

The invariant this phase owns:

> **A paid Order requiring provider Tax Transaction recording creates durable
> work that remains observable and recoverable until recorded or explicitly
> terminal.**

`1.7` delivered the first half of that sentence and shipped `tax:record:once`
with nothing to run it. Durable work nobody processes is recoverable in principle
and unrecovered in fact.

Nothing here implements refunds, tax reversals, filing or remittance, live
Stripe, payouts, or AgentNet publication.

---

## 1. The operational lifecycle

```
commit paid sale + durable tax work        ← 1.7, inside the sale's transaction
  → best-effort immediate attempt          ← 1.8, fast path, never load-bearing
  → scheduled dispatcher (~5 min, §4)      ← 1.8, THE GUARANTEE once deployed
  → backlog visibility + governed requeue  ← 1.8, when neither worked
```

**No second retry engine.** The claim lease, attempt counting, backoff, and
terminal states remain exactly `1.7`'s; the dispatcher invokes `1.7`'s cycle
rather than reimplementing it. The only state transition this phase adds is an
operator-invoked requeue.

---

## 2. Immediate attempt vs scheduled recovery

The Stripe webhook, after `finalizeConfirmedPayment` returns `SALE_RECORDED`,
runs one bounded cycle with `limit: 1`. Three properties make that safe:

- it is **outside** the sale's transaction — no provider call is ever held inside
  a database lock;
- it **cannot roll back a completed payment**. The sale is already committed and
  the attempt catches everything;
- it claims through `1.7`'s own claim/lease/idempotency machinery, so it races
  the scheduler safely and cannot produce a second provider transaction.

A failure there is not a failure: the row stays durable and due, and the
scheduled dispatcher recovers it. The webhook still returns `200` — telling
Stripe to retry a booked sale because a tax report was slow would be strictly
worse.

**The port is supplied in the route module, not the handler.** A handler that
constructed a provider client itself would make every test of that route a test
that could reach the network. A handler with no port skips the fast path and
relies on the scheduler, which is the guarantee regardless.

---

## 3. The dispatcher endpoint

`/api/internal/operations/tax-recorder`

**Gate.** A dedicated shared secret, `MONACADO_TAX_RECORDER_SECRET`, presented as
`Authorization: Bearer …` and compared in constant time over SHA-256 digests —
digested first so the comparison is over fixed-length buffers, since
`timingSafeEqual` throws on a length mismatch and the throw would itself leak the
expected length.

`401` is returned identically for **unconfigured, absent, wrong scheme, and wrong
secret**, with a body of `{"error":"UNAUTHORIZED"}` that names no variable, no
condition, and nothing about whether tax is configured at all.

**A dedicated secret, not the email dispatcher's.** One operational secret
driving two unrelated subsystems is one rotation away from an outage in the one
nobody was thinking about.

**Both `GET` and `POST` are accepted, and that is a deliberate departure from
`1.5`.** The email dispatcher is `POST`-only, reasoning that "a `GET` that sent
Monacado's queue would be a queue an image tag could drain". That holds for an
*unauthenticated* GET and not here: every request without an `Authorization`
header is refused, and a browser cannot attach one cross-origin from an `<img>`,
a `<script>`, or a link. It is accepted because **Vercel Cron invokes with `GET`
and cannot be configured otherwise** — a `POST`-only endpoint would be a
scheduler that could never fire, which is precisely the gap this phase closes.
Both verbs funnel through one helper, so the gate cannot be bypassed by choosing
one.

**Bounded.** 25 rows by default, 100 maximum; a request is not a drain. A cycle
failure answers `503`, not `500`: the work is durable and still due, so the
honest answer to a scheduler is "try again".

**Response carries counts only** — claimed, recorded, retry-scheduled,
permanently failed, stale claims recovered, claim conflicts. No Order id, buyer
field, amount, provider reference, or secret.

---

## 4. Scheduler and deployment posture

**Recommended production cadence: about every five minutes** — `*/5 * * * *`.
Often enough that an ordinary sale is reported promptly even when the immediate
attempt failed, rare enough that an idle deployment is not doing work for
nothing.

### No cron is committed, and that is deliberate

A `vercel.json` carrying that schedule was written for this phase and **removed
before commit**.

Vercel limits **Hobby** projects to cron running **once per day**; minute-level
schedules require **Pro or Enterprise**. The repository holds no authoritative
statement of which plan Monacado production runs on — the only mention of Vercel
anywhere is a deferred "Vercel wiring" item in
[`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md), and there is no project link,
no dependency, and no plan declaration. Committing a minute-level schedule would
have meant committing a deployment configuration that **fails at deploy time** on
a plan nobody has ruled out.

**Downgrading to daily to fit Hobby is explicitly not the answer.** Once a day is
not a tax-recording cadence: calculations expire, and a sale reported a day late
is a sale that spent a day invisible to reconciliation for no reason.

So the endpoint ships production-ready, the cadence is stated, and the deployment
decision is made deliberately rather than inherited from a file. The guidance is
`TAX_RECORDER_SCHEDULE_GUIDANCE` in `tax-recorder-route-handler.ts`, and a test
asserts no `vercel.json` exists.

### The scheduler need not be Vercel

Any controlled scheduler that can issue an authenticated request on this cadence
satisfies the requirement — a platform cron, a CI schedule, a job runner, an
uptime service. Readiness asks whether **a** scheduler is configured, not whose.

### Deployment steps an operator must take

1. **Set `MONACADO_TAX_RECORDER_SECRET`** to a strong random value.
2. **Choose a scheduler** and confirm it supports roughly five-minute execution.
   For Vercel Cron that means **Pro or Enterprise**; on Hobby, use an external
   scheduler instead.
3. **Add the schedule.** For Vercel, create `vercel.json` with:

   ```json
   {
     "crons": [
       { "path": "/api/internal/operations/tax-recorder", "schedule": "*/5 * * * *" }
     ]
   }
   ```

   For any other scheduler, issue `GET` or `POST` to that path with
   `Authorization: Bearer <MONACADO_TAX_RECORDER_SECRET>`.
4. **Arrange for the bearer value to match.** Vercel authenticates its cron
   invocations by sending `Authorization: Bearer $CRON_SECRET`; Monacado validates
   its own dedicated `MONACADO_TAX_RECORDER_SECRET`. When Vercel Cron is used, the
   deployment must set `CRON_SECRET` to the **same value** so the invocation gets
   past the gate.

   The endpoint deliberately does **not** read `CRON_SECRET` directly: an
   application endpoint gated by a platform-owned variable name is one platform
   change away from an authentication model nobody chose, and would not work at
   all for a non-Vercel scheduler.
5. **Set `MONACADO_TAX_RECORDER_SCHEDULE`** to a short description of what invokes
   it (e.g. `vercel-cron:*/5 * * * *` or `github-actions:every-5m`). Monacado
   cannot see its own deployment's scheduler, so readiness treats this as an
   **operator statement** — the same rule registration posture follows. Nothing is
   inferred, and **the presence of a deployment file is never taken as proof**.

**Scheduler deployment remains a production prerequisite**, and readiness stays
blocked until step 5 is done. **No external call was made in this phase.**

---

## 5. Status and backlog tooling

```
npm run tax:record:status                   # backlog + what needs an operator
npm run tax:record:status -- --json         # machine-readable only
npm run tax:record:status -- --all          # include work merely in flight
npm run tax:record:status -- --requeue=<id> # governed requeue of ONE terminal row
```

Reports pending · retry-pending · in-progress (claimed) · recorded ·
permanently-failed · due-now · expired claims · oldest unresolved age · paid
Orders lacking a tax transaction · calculation-expired.

**No provider call**, ever: every fact is already persisted, which is what `1.7`'s
audit-efficient record was for. A status command that had to reach Stripe would
stop working at the moment a credential problem made it most useful.

**No buyer PII.** The summary carries counts and ages and **no identifiers at
all** — it is rendered on operations screens and pasted into chat, and one that
enumerated sales would be a way to enumerate customers. The per-row inspection
carries Order and tax-transaction ids plus the provider's own object references,
which identify a transaction rather than a person, and no name, email, address,
or amount.

Exit code is non-zero when an operator has something to do.

---

## 6. Readiness

Readiness now separates three things that were one:

| Question | Where |
| --- | --- |
| can it calculate? | `calculationConfigured` — configuration |
| can it record? | `taxTransactionRecordingAvailable` — configuration |
| **will anything run the recorder?** | `recorderOperations.operationallyInvocable` — configuration |
| **is it keeping up?** | `evaluateTaxOperationsReadiness` — **rows** |

`taxLifecycleReady` now requires all three configuration answers. A deployment
that can price and report a sale with nothing that invokes the recorder is **not**
ready: it collects tax whose report nobody sends.

New blockers: `TAX_RECORDER_DISPATCHER_NOT_CONFIGURED`,
`TAX_RECORDER_SCHEDULE_NOT_DECLARED`, and the new headline state
`TAX_RECORDER_OPERATIONS_REQUIRED`.

`evaluateTaxOperationsReadiness` is the database-backed half — still **no
provider call** — and blocks on:

- `TAX_RECORDING_PERMANENT_FAILURES` — every one is a return line that will be
  missing, and no timer will fix it;
- `PAID_ORDERS_MISSING_TAX_TRANSACTION` — a different failure with a different
  cause, and not something a cycle will ever fix;
- `TAX_RECORDING_OVERDUE` — the oldest unresolved row is past 36 hours. The
  threshold sits **past `1.7`'s retry tail** (so ordinary backoff never trips it)
  and **well short of calculation expiry** (so a stopped scheduler always does).

`evaluateLiveCommerceReadiness` gains `TAX_RECORDER_NOT_OPERATIONAL` and
`TAX_RECORDING_BACKLOG_UNHEALTHY`.

Readiness still performs **no Stripe call**, and a test asserts the module imports
no provider client.

---

## 7. Permanent failures and the governed requeue

A requeue is **not an undo**. It does not erase the failure, does not alter a
sale-time fact, does not contact a provider, and states only that a human changed
something outside Monacado.

**Requeueable** — the cause is outside the record, and an operator can fix it:
`PROVIDER_UNAVAILABLE` (an outage longer than the ~22-hour backoff tail),
`PROVIDER_NOT_CONFIGURED`, `PROVIDER_REJECTED`, `PROVIDER_MODE_NOT_PERMITTED`,
`UNSPECIFIED_FAILURE`.

**Not requeueable**, with the real remediation named instead of a button that
does nothing:

| Failure | What is actually required |
| --- | --- |
| `CALCULATION_EXPIRED` | `OPERATOR_TAX_ADJUSTMENT_REQUIRED` — see §8 |
| `DUPLICATE_REFERENCE` | `RECONCILE_PROVIDER_TRANSACTION` — the provider already has one |
| `EVIDENCE_INCONSISTENT` | `INVESTIGATE_RECORD_DIVERGENCE` — Monacado's own records disagree |

What a requeue changes: status → `RETRY_PENDING`, `nextAttemptAt` → now,
`attemptCount` → 0, `finalizedAt` → null, plus requeue evidence.

What it leaves alone: every sale-time fact, the calculation reference, the
lifecycle state, and **`lastFailureCode`** — deliberately retained, because the
row should still say what went wrong last time.

`operatorActionFor` derives the next action from status and last failure alone, so
the status command, readiness, and tests all get the same answer from the same
inputs rather than agreeing by accident.

---

## 8. Calculation expiry

`CALCULATION_EXPIRED` is permanent, and this phase makes the consequence explicit
rather than merely classified.

**Monacado does not silently re-price a historical sale.** Calculating tax again
would produce a *new* calculation at *today's* rates for a sale priced months ago,
and report it as though it were what the buyer was charged — a fabricated tax
record indistinguishable from a correct one.

So the row stays terminal, visible, and named, surfacing three facts:

- **a paid Order exists**;
- **tax transaction recording remains incomplete**;
- **operator remediation is required**.

`CALCULATION_EXPIRY_REMEDIATION` states it as a value, the status command prints
it whenever the count is non-zero, and the calculation reference survives for the
adjustment to name. Its owner is the later adjustment and reconciliation
workflow, which needs its own governed design.

---

## 9. Zero tax

Zero-tax transactions are **not special-cased out of anything** — not scheduling,
not status, not reconciliation, not recovery. A zero-tax sale is committed as
`PENDING`, becomes due, is claimed, is reported, and appears in every count like
any other. A jurisdiction where Monacado collected nothing is a return line, not
an absence.

---

## 10. Observability

A `TaxRecordingMonitor` interface with three bounded event names, **injected and
silent by default**, following `worker-monitoring.ts`: no logging framework, no
`console`, no new monitoring vendor.

Emitted: event name and counts — claimed, recorded, retry-scheduled, permanently
failed, stale claims recovered, claim conflicts. **Allow-list, not deny-list**:
every field is named, so a field added to a contract later cannot appear by
accident.

Never emitted: buyer name, email, or address; a Stripe credential or the name of
one; a raw provider error; a full provider payload; an amount; a lock token.

A monitor that throws is contained — monitoring must never change an outcome, and
a line written after a provider was contacted cannot un-contact it.

---

## 11. Private capsule

Unchanged and untouched. The projection remains `PRIVATE`, deterministic, and
**publication-free**; it reflects whatever lifecycle state the authoritative row
holds — `PENDING`, `RETRY_PENDING`, `RECORDED`, `FAILED_PERMANENT` — because
those are already part of its contract.

**Capsules are not an input to anything here.** The recorder, the dispatcher, the
backlog, and the requeue all read and write the database. No capsule is consulted
to decide what to record, and none is published.

---

## 12. Migration

One additive migration:
`20260824190000_add_tax_recording_requeue_evidence` — two `ADD COLUMN` on the
table `1.7` created, with a default so no backfill is needed.

`requeueCount` and `lastRequeuedAt` are **genuinely required**, not convenient. A
requeue resets `attemptCount` so the bounded schedule starts again instead of
immediately re-terminating; that reset would otherwise erase the evidence that the
work had already been tried eight times and abandoned. `attemptCount` now says how
far the current round has got; `requeueCount` says how many rounds a human
authorised.

Nothing dropped, renamed, or narrowed; no committed migration modified.

---

## 13. Remaining work

1. **Deploy the schedule** — §4's five steps, including choosing a scheduler that
   supports a five-minute cadence. Readiness stays blocked until it is declared.
2. **Refunds and tax reversals.** `createReversal`, the accounting rules for whose
   money comes back, and the relation between a tax reversal and an Order refund.
3. **The adjustment workflow** that owns calculation-expired rows (§8).
4. **Filing and remittance.** Still `NOT_IMPLEMENTED`; recording transactions is
   not filing readiness.
5. **Live Stripe.** `STRIPE_MODES` still has one member.
6. **A cron for the email dispatcher.** `1.5` left it deliberately unwired, and
   this phase commits no deployment file either — whichever scheduler is chosen
   for the tax recorder is the natural place for it too.
7. **Provider-side audit**, multi-line tax records, and private-capsule serving —
   unchanged from `1.7`.

---

## Reference

- [`TAX_TRANSACTION_RECORDING_AND_PRIVATE_CAPSULE.md`](TAX_TRANSACTION_RECORDING_AND_PRIVATE_CAPSULE.md) — Phase 1.7
- [`PRODUCTION_TAX_INTEGRATION.md`](PRODUCTION_TAX_INTEGRATION.md) — Phase 1.6
- [`PRODUCTION_COMMUNICATIONS_AND_NOTIFICATION_DELIVERY.md`](PRODUCTION_COMMUNICATIONS_AND_NOTIFICATION_DELIVERY.md) — the dispatcher pattern this reuses
