/**
 * Password reset link, message, and delivery (Phase 1.28) — SERVER ONLY.
 *
 * The same three things `account-verification-notice.ts` holds for verification,
 * for a different link:
 *
 *   - the link is `/reset-password`, built on `MONACADO_APP_ORIGIN` and never on
 *     a request `Host` header (reusing `readAccountVerificationOrigin`, which
 *     refuses rather than defaulting);
 *   - the message names nobody — no account id, no name, no address — and the
 *     token appears exactly once, inside the URL;
 *   - delivery commits a durable `OutboundEmailDelivery` row and attempts an
 *     immediate send, leaving a failure to the existing dispatcher.
 *
 * The challenge is **not** minted here. The message resolver mints it at send
 * time, as for verification, so a dispatcher retry never needs a stored
 * plaintext token: it mints a fresh one, superseding the undelivered one.
 */

import "../server-only";
import { enqueueEmailDelivery, type OutboundEmailDeps } from "../notifications/outbound-email-service";
import { cryptoOutboundEmailIdProvider } from "../notifications/outbound-email-ids";
import { dispatchEmailDeliveriesNow } from "../notifications/email-dispatcher";
import type { MailPort } from "../../contracts/marketplace/notification-delivery";
import { readAccountVerificationOrigin } from "./account-verification-notice";

type Env = Record<string, string | undefined>;

/** The page that completes a PASSWORD RESET. Never the verification page. */
export const RESET_PASSWORD_PATH = "/reset-password";
export const PASSWORD_RESET_TOKEN_PARAM = "token";

/** `${origin}/reset-password?token=…`, and nothing else in the URL. */
export function buildPasswordResetUrl(origin: string, token: string): string {
  const url = new URL(RESET_PASSWORD_PATH, `${origin}/`);
  url.searchParams.set(PASSWORD_RESET_TOKEN_PARAM, token);
  return url.toString();
}

/**
 * Render the message. Plain text, matching verification. Somebody who did not ask
 * is told that nothing changes unless the link is used — which is true, and is
 * what makes ignoring it the safe default.
 */
export function renderPasswordResetMessage(input: {
  resetUrl: string;
  expiresAt: string;
}): { subject: string; body: string } {
  const expires = new Date(input.expiresAt).toISOString();
  return {
    subject: "Reset your Monacado password",
    body: [
      "Someone asked to reset the password for the Monacado account that uses this email address.",
      "",
      "Choose a new password here:",
      "",
      input.resetUrl,
      "",
      `This link expires at ${expires} and can be used once.`,
      "Resetting your password signs you out everywhere.",
      "",
      "If you did not ask for this, you can ignore this message. Your password will not change.",
    ].join("\n"),
  };
}

export interface PasswordResetDeliveryDeps extends OutboundEmailDeps {
  env?: Env;
  origin?: string;
}

/**
 * Commit a reset email for an account, and try to send it now.
 *
 * A fresh `discriminator` per call, so asking again is a new logical message.
 * The send failure is swallowed: the enqueued row is the commitment.
 */
export async function requestAccountPasswordReset(
  input: { accountId: string; now: string },
  port?: MailPort,
  deps: PasswordResetDeliveryDeps = {},
): Promise<{ deliveryId: string }> {
  /* Fail fast, before anything is committed, if links cannot be built at all. */
  if (deps.origin === undefined) readAccountVerificationOrigin(deps.env ?? process.env);

  const { delivery } = await enqueueEmailDelivery(
    {
      purpose: "PASSWORD_RESET",
      audience: "ACCOUNT",
      recipientParticipantId: null,
      obligationId: null,
      subjectKind: "ACCOUNT_PASSWORD_RESET",
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
