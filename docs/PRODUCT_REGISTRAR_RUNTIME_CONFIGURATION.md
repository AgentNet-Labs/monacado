# Registrar Runtime Configuration (Phase 0E.6.2)

The boundary between deployment configuration and the Phase 0E.6.1 transport:
turning environment variables into a validated, **secret-free** configuration and
a constructed transport.

**No external Registrar is contacted anywhere in this phase.** There are no real
endpoints, Registrar identifiers, or credentials in this repository, and no
production secret file was created.

## What this boundary answers

Three questions, and nothing else:

1. **Is the Registrar enabled?**
2. **Where are we permitted to send?**
3. **Where is the secret kept?** — the *location*, never the value.

## The central property: names, not values

The parsed configuration stores `bearerTokenEnvVar` — the **NAME** of the
variable holding the bearer token. It never stores the token.

This is what makes the object safe to log, serialise, snapshot in a test, or
include in a diagnostic dump *by construction* rather than by discipline. A
future contributor cannot leak a credential by printing the configuration,
because the credential was never in it.

The secret is resolved only inside the credential provider, only when a request
is about to be signed.

## Disabled by default

There are no production defaults for the endpoint, the Registrar identity, or the
allow-list. An unconfigured deployment sends **nothing** rather than guessing —
and because the endpoint has no default, there is no address for it to guess
towards.

## Four load outcomes

They are distinct because each calls for a different operator response:

| State | Meaning | Operator action |
| --- | --- | --- |
| `DISABLED` | Not enabled. The default, and **not a fault**. | None. |
| `INCOMPLETE` | Enabled, but required keys are absent. Names the **keys**. | Finish the configuration. |
| `INVALID` | Values present but wrong. Names the **fields and rules**. | Correct the values. |
| `READY` | A validated, secret-free configuration. | None. |

Collapsing `INCOMPLETE` into `INVALID` would tell an operator "your endpoint is
wrong" when they simply had not set one yet.

An unrecognised value for the enable flag (`"perhaps"`) resolves to **disabled**.
A configuration switch that cannot be understood must fail closed.

## Exact-origin allow-listing

The endpoint must match a configured origin by **string equality of normalised
origins**, where normalisation fills in the effective port and lowercases the
host, so `https://r.example` and `https://r.example:443` compare equal.

Everything else is refused:

| Refused | Why |
| --- | --- |
| Wildcards (`https://*.example`) | An entry matching a family of hosts is not an allow-list. |
| Suffix matching | `endsWith` is exactly how `evil-registrar.example` slips past a rule meant for `registrar.example`. |
| Subdomains | `a.registrar.example` is a different host. |
| Differing ports | `:8443` is a different endpoint. |
| Plain `http:` | Production must be HTTPS. |

Loopback `http:` is permitted **only** when `allowLoopbackHttp` is explicitly
set, which makes local-mock usage a greppable decision rather than an accident of
which host happened to be configured. Non-loopback `http:` is refused even then.

This layers **on top of** the Phase 0E.6.1 shape rules (scheme, embedded
credentials, fragment, host), never instead of them: those prove an endpoint is
*safe to speak to at all*, this proves it is one we were *told* to speak to.

## Re-validation at construction

`createConfiguredRegistrarTransport` **re-applies the allow-list**, rather than
trusting that the configuration object came from the loader.

Configuration may be loaded at boot and a transport built much later, from an
object that could have been assembled by hand. Re-checking costs a URL parse and
eliminates the entire class of "constructed from a configuration that never
passed the allow-list".

The order is deliberate: the allow-list is asserted **before** anything touches
the secret source, so a misconfigured endpoint never causes a credential to be
read at all. A test asserts zero reads of the secret source in that case.

## Credential resolution

`EnvBearerCredentialProvider` reads one named variable from an **injected**
source — an interface, not `process.env`, so a secret manager can be substituted
later without touching this class or the transport.

- **Not cached.** Caching would keep a token in memory across a rotation, so a
  rotated credential would keep failing until restart, and it would widen the
  window in which a heap dump contains it. Resolution costs one property read.
- **Not persisted, not logged**, never returned in an error or result.
- **CRLF and non-printable characters are refused** — a token containing a
  newline could otherwise split the request into extra headers.
- Bounded length.
- Contributes **only** `authorization`; no additional headers.

## What errors may say

Field names, issue codes, and rule names. Nothing else.

Never: a secret value, the full environment, a credential-bearing URL, a request
or response body, an integrity hash, a lock token, or raw Zod/network detail.

**Even the secret variable's NAME is withheld** — a missing-credential error says
that *a* credential is unset, not which variable holds it. Knowing where the
token lives is a small disclosure, and it costs nothing to omit.

All errors reuse the hardened **non-enumerable internal cause** pattern, so
`JSON.stringify(error)` cannot leak a retained cause.

Five codes, each with a real throw site:

`ENDPOINT_NOT_ALLOW_LISTED`, `UNSUPPORTED_CREDENTIAL_MODE`,
`MISSING_CREDENTIAL_SECRET`, `INVALID_CREDENTIAL_SECRET`,
`TRANSPORT_CONSTRUCTION_FAILURE`.

A malformed or incomplete **load** is deliberately not an exception —
`loadRegistrarRuntimeConfiguration` returns `INVALID` / `INCOMPLETE` as states,
because a caller must distinguish four outcomes and act differently on each, and
an exception is a poor carrier for that. Error classes mirroring those two states
were written and then removed as unreachable vocabulary, following the same
cleanup applied to the transport in Phase 0E.6.1.

## Readiness

`validateRegistrarRuntimeReadiness` reports `DISABLED | READY | INVALID` using
codes and field names only, making it safe to log at boot.

It includes a credential **presence** check — presence only, never the value —
because a deployment that is perfectly configured but missing its secret should
discover that at startup, not on its first publication attempt hours later.

> `READY` means the configuration is **coherent**, not that the Registrar
> answered. This phase contacts nothing and deliberately makes no reachability
> claim.

## Server-only boundary

Secret-adjacent modules live under `src/server/` and import a `server-only`
guard that throws if evaluated in a browser. The repository has no `server-only`
package, so this is the narrowest protection needing no new dependency.

The guard is a backstop, not the primary control. The primary control is that
these modules are never re-exported through the browser-facing `src/contracts`
barrel — which a test asserts — and that **no `NEXT_PUBLIC_` Registrar variable
exists**, also asserted.

## Registrar identity is out of scope here

`RegistrarId` remains a **non-empty opaque identifier** (`z.string().min(1)`),
exactly as earlier phases defined it. This phase introduces no new identifier
format and does not tighten the shared contract.

That is deliberate. A Registrar's identifier format is issued by that Registrar,
not chosen by Monacado, and the contract is shared with persistence — narrowing
it from a configuration module would change validation for already-stored rows.
Any formal hardening belongs to a separate cross-phase change.

The loader still refuses a blank identifier: it is one of the required-when-
enabled keys, so an empty value yields `INCOMPLETE`.

## Deviation from the phase specification

The specification listed an optional `allowedOutboundHeaders` configuration
field. **It is deliberately not implemented.**

The credential provider contributes only `authorization`, and the transport
already enforces its own header allow-list and denylist. An optional field with
no consumer is the same unreachable vocabulary removed from the transport in
Phase 0E.6.1. It can be added when a caller genuinely needs to send an extra
header — at which point its shape will be driven by that need rather than
guessed.

## Who loads this configuration

Phase 0E.7.2 composes it. `MONACADO_PUBLICATION_WORKER_*` configures the bounds of
one cycle, and an **enabled worker requires this configuration to be `READY`** — an
enabled worker paired with a disabled Registrar is reported as `INCOMPLETE`,
because the operator asked for a cycle that could never send anything. The worker
command validates readiness (which re-applies the allow-list before the credential
presence check) and then constructs one transport for the whole invocation
([`PRODUCT_PUBLICATION_WORKER_ENTRYPOINT.md`](PRODUCT_PUBLICATION_WORKER_ENTRYPOINT.md)).

`process.env` is read at that executable boundary and nowhere else; this loader
still takes an injected environment.

## Deferred

- **Production secret storage, rotation, and scoping**; real endpoint values.
- **Live Registrar validation** — any reachability or credential-acceptance
  check requires contacting a Registrar.
- Secret managers beyond the injected-source interface; additional credential
  modes; per-Registrar configuration (exactly one is supported).
- Monitoring, UI, authentication, Stripe.

See [`PRODUCT_REGISTRAR_TRANSPORT.md`](PRODUCT_REGISTRAR_TRANSPORT.md) for the
transport this configuration constructs.
