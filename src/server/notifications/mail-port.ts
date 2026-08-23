/**
 * The mail boundary and its local adapter (Phase 1.1) — SERVER ONLY.
 *
 * `MailPort` is declared in the contracts, provider-neutral. This module supplies
 * the local implementations and resolves which transport a deployment uses:
 *
 *   - `createLogMailAdapter` — writes a redacted line and accepts. The default
 *     for local development, and what `stripe listen` pairs with.
 *   - `createCapturingMailAdapter` — keeps messages in memory for a test.
 *   - `createDisabledMailAdapter` — refuses, visibly. The default.
 *
 * ## The vendor, added in Phase 1.5
 *
 * `1.1` recorded that choosing a provider was "a third party, a data-processing
 * relationship, and a deliverability story" and not a notification phase's
 * decision. `1.5` makes it: **Postmark**, in `postmark-mail-adapter.ts`, behind
 * this same unchanged interface. That file is the only one in the repository that
 * knows what Postmark is, and **no caller above the port changed** to accommodate
 * it — which is exactly what the seam was built to demonstrate.
 *
 * ## Disabled is a first-class state
 *
 * With `MONACADO_MAIL_ENABLED` unset, `resolveMailPort` returns a port that
 * refuses every message with `CHANNEL_NOT_CONFIGURED`. It does **not** throw and
 * does **not** silently pretend to send: a delivery row is still written, marked
 * `FAILED` with that bounded code, so an operator can see exactly how many
 * notices an unconfigured deployment did not send. Silence would have been the
 * one outcome nobody could audit.
 *
 * ## What never crosses this boundary
 *
 * No credential, no endpoint, no template id, no HTML, no tracking pixel, and no
 * attachment. `MailMessage` has no field for any of them.
 */

import "../server-only";
import {
  MailMessage,
  type MailPort,
  type MailResult,
} from "../../contracts/marketplace/notification-delivery";
import { createPostmarkMailAdapter } from "./postmark-mail-adapter";
import {
  isMailEnabled,
  selectedMailTransport,
  MAIL_TRANSPORTS,
  type Env,
  type MailProvider,
  type MailTransport,
} from "./mail-runtime-config";

/* Re-exported so `1.1`'s callers keep their import site. The definitions moved
   to `mail-runtime-config.ts` when a vendor arrived and configuration became
   more than one boolean — two copies of "is mail on" is two answers. */
export { isMailEnabled, MAIL_TRANSPORTS };
export type { Env, MailProvider, MailTransport };

/**
 * Redact an address for a log line: first character, then the domain.
 *
 * `alice@example.com` → `a***@example.com`. Enough for an operator to recognise
 * an address they already know, not enough to harvest one they do not. It is
 * **never persisted** — only logged, and only by the local adapter.
 */
export function redactAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

/**
 * The local adapter: record that a message would have been sent, and accept.
 *
 * It logs the **redacted** destination and the subject, and never the body —
 * a transactional body carries an order id, an amount, and whatever a template
 * grows into, and a development log is not the place for it.
 *
 * The returned reference is marked `local-` so nothing downstream can mistake it
 * for a real provider id during reconciliation.
 */
export function createLogMailAdapter(
  options: { sink?: (line: string) => void; refs?: () => string } = {},
): MailPort {
  const sink = options.sink ?? ((line: string) => console.info(line));
  let counter = 0;
  const nextRef = options.refs ?? (() => `local-${(counter += 1)}`);
  return {
    async send(rawMessage): Promise<MailResult> {
      const message = MailMessage.parse(rawMessage);
      sink(
        `[mail] to=${redactAddress(message.to)} subject=${JSON.stringify(message.subject)}`,
      );
      return { outcome: "ACCEPTED", providerMessageRef: nextRef() };
    },
  };
}

/** In-memory adapter for a test. Keeps whole messages so assertions can read them. */
export function createCapturingMailAdapter(
  options: { result?: MailResult } = {},
): MailPort & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  let counter = 0;
  return {
    sent,
    async send(rawMessage): Promise<MailResult> {
      const message = MailMessage.parse(rawMessage);
      sent.push(message);
      return (
        options.result ?? { outcome: "ACCEPTED", providerMessageRef: `capture-${(counter += 1)}` }
      );
    },
  };
}

/**
 * A port that refuses everything, with the reason an operator needs.
 *
 * Used when mail is not configured. Refusing rather than throwing keeps the
 * delivery record honest: the attempt is written, the failure is bounded, and
 * nothing pretends a message went out.
 */
export function createDisabledMailAdapter(): MailPort {
  return {
    async send(): Promise<MailResult> {
      return { outcome: "REFUSED", failureCode: "CHANNEL_NOT_CONFIGURED" };
    },
  };
}

/**
 * The port this deployment should use.
 *
 * Nothing is read at import time, and there is no production default: an
 * unconfigured deployment refuses visibly rather than guessing at a transport.
 */
export function resolveMailPort(env: Env = process.env): MailPort {
  if (!isMailEnabled(env)) return createDisabledMailAdapter();
  const transport = selectedMailTransport(env);
  if (transport === "LOG") return createLogMailAdapter();
  if (transport === "POSTMARK") return createPostmarkMailAdapter({ env });
  /* An unrecognised transport is a misconfiguration, not a licence to fall back
     to something that silently accepts. */
  return createDisabledMailAdapter();
}

/**
 * Which provider a delivery row should record as having answered.
 *
 * Derived from the same two variables `resolveMailPort` reads, so the name
 * written down is always the adapter that actually ran. Never a credential and
 * never an endpoint.
 */
export function resolvedMailProvider(env: Env = process.env): MailProvider {
  if (!isMailEnabled(env)) return "DISABLED";
  const transport = selectedMailTransport(env);
  if (transport === "LOG") return "LOG";
  if (transport === "POSTMARK") return "POSTMARK";
  return "DISABLED";
}
