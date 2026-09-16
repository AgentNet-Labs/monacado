/**
 * Account verification link, message, and delivery (Phase 1.27) — SERVER ONLY.
 *
 * Three small things that belong together: where the link points, what the email
 * says, and how it is committed for sending.
 *
 * ## The link is its own path
 *
 * `/verify-account-email`, not `/verify-email`. The existing page consumes a
 * **participant contact** token and this one consumes an **account** token; the
 * two token spaces live in different tables and must never be cross-consumable.
 * One shared path would have meant a verifier that tries one table and then the
 * other, and that verifier is exactly the place where "which kind of token is
 * this" gets decided wrongly. Two paths, two verifiers, no ambiguity.
 *
 * The origin comes from `MONACADO_APP_ORIGIN` and never from a request `Host`
 * header — reusing `readVerificationLinkOrigin`, which already refuses rather
 * than defaulting. A link built from an attacker-supplied host is a link that
 * mails Monacado's verification tokens to the attacker.
 *
 * ## The message names nobody
 *
 * No account id, no name, no challenge id, and not even the address it was sent
 * to. Somebody who receives this because a stranger typed their address into the
 * form learns only that Monacado exists and that they can ignore it. The token
 * appears exactly once, inside the URL.
 *
 * NOTE — confirming is no longer what unlocks SIGN-IN. It unlocks taking a
 * Storefront public. The message says so rather than repeating the earlier,
 * stricter promise, because copy that overstates a requirement trains people to
 * disbelieve the ones that are real.
 *
 * ## Delivery reuses the existing outbox, unchanged
 *
 * `enqueueEmailDelivery` commits a durable `OutboundEmailDelivery` row first, then
 * a best-effort immediate send is attempted. A failed send leaves the row
 * `RETRY_PENDING` for the dispatcher rather than losing the message. Nothing here
 * names a transport: the port is whatever the deployment selects — Google
 * Workspace SMTP in staging and production, a capture adapter in tests.
 *
 * The challenge itself is **not** minted here. It is minted by the message
 * resolver at send time, which is how participant verification already works and
 * for the same reason: a retry then needs no stored plaintext token.
 */

import "../server-only";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { enqueueEmailDelivery, type OutboundEmailDeps } from "../notifications/outbound-email-service";
import { cryptoOutboundEmailIdProvider } from "../notifications/outbound-email-ids";
import { dispatchEmailDeliveriesNow } from "../notifications/email-dispatcher";
import type { MailPort } from "../../contracts/marketplace/notification-delivery";

type Env = Record<string, string | undefined>;

/** The page that consumes an ACCOUNT token. Never the participant one. */
export const VERIFY_ACCOUNT_EMAIL_PATH = "/verify-account-email";
export const ACCOUNT_VERIFICATION_TOKEN_PARAM = "token";

/** Raised when the deployment cannot state its own public origin. */
export class AccountVerificationOriginError extends Error {
  constructor() {
    super("public origin is not configured");
    this.name = "AccountVerificationOriginError";
  }
}

/**
 * The origin verification links are built on.
 *
 * Refuses rather than defaulting: a guessed origin produces links that go
 * nowhere, or worse, somewhere else.
 */
export function readAccountVerificationOrigin(env: Env = process.env): string {
  const raw = (env.MONACADO_APP_ORIGIN ?? "").trim();
  if (normalizeOrigin(raw) === undefined) throw new AccountVerificationOriginError();
  return raw.replace(/\/+$/, "");
}

/** `${origin}/verify-account-email?token=…`, and nothing else in the URL. */
export function buildAccountVerificationUrl(origin: string, token: string): string {
  const url = new URL(VERIFY_ACCOUNT_EMAIL_PATH, `${origin}/`);
  url.searchParams.set(ACCOUNT_VERIFICATION_TOKEN_PARAM, token);
  return url.toString();
}

/**
 * Render the message.
 *
 * Plain text, no HTML part, no template engine — matching the participant
 * verification message exactly. An unexpecting recipient is told to ignore it,
 * because for them that is the correct action and saying so is what keeps this
 * from reading like a phishing attempt.
 */
export function renderAccountVerificationMessage(input: {
  verificationUrl: string;
  expiresAt: string;
}): { subject: string; body: string } {
  const expires = new Date(input.expiresAt).toISOString();
  return {
    subject: "Confirm your Monacado email address",
    body: [
      "Someone created a Monacado account with this email address.",
      "",
      "Confirm the address to finish setting up the account:",
      "",
      input.verificationUrl,
      "",
      `This link expires at ${expires} and can be used once.`,
      "",
      "If you did not create a Monacado account, you can ignore this message.",
      "An unconfirmed address cannot be used to open a public storefront.",
    ].join("\n"),
  };
}

export interface AccountVerificationDeliveryDeps extends OutboundEmailDeps {
  env?: Env;
  origin?: string;
}

/**
 * Commit a verification email for an account, and try to send it now.
 *
 * `recipientParticipantId: null` and `audience: "ACCOUNT"` — this message is for
 * somebody who holds no marketplace role, and no participant is fabricated to
 * give it one. `subjectRef` is the account id; the resolver reads the address
 * from the `Account` row at send time, so a corrected address is used by the
 * retry rather than the address that was wrong when it was enqueued.
 *
 * A fresh `discriminator` per call, so asking for a second link is a new logical
 * message rather than a duplicate suppressed by the dedupe key.
 *
 * **The send failure is swallowed on purpose.** The durable commitment is the
 * enqueued row; the immediate attempt is an optimisation. Letting a provider
 * outage fail the caller would turn "your account was created" into an error for
 * somebody whose account genuinely was created.
 */
export async function requestAccountEmailVerification(
  input: { accountId: string; now: string },
  port?: MailPort,
  deps: AccountVerificationDeliveryDeps = {},
): Promise<{ deliveryId: string }> {
  /* Fail fast, before anything is committed, if links cannot be built at all. */
  if (deps.origin === undefined) readAccountVerificationOrigin(deps.env ?? process.env);

  const { delivery } = await enqueueEmailDelivery(
    {
      purpose: "EMAIL_VERIFICATION",
      audience: "ACCOUNT",
      recipientParticipantId: null,
      obligationId: null,
      subjectKind: "ACCOUNT_EMAIL",
      subjectRef: input.accountId,
      discriminator: (deps.ids ?? cryptoOutboundEmailIdProvider).nextMessageDiscriminator(),
      now: input.now,
    },
    deps,
  );

  try {
    await dispatchEmailDeliveriesNow(
      { deliveryIds: [delivery.deliveryId], now: input.now },
      port,
      deps,
    );
  } catch {
    /* The commitment stands; the dispatcher will retry. */
  }

  return { deliveryId: delivery.deliveryId };
}
