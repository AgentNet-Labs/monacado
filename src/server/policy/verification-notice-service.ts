/**
 * Verification message delivery (Phase 1.4) — SERVER ONLY.
 *
 * Phase 1.3 built the whole proof-of-control mechanism and stopped one step
 * short: `issueVerificationChallenge` returns a raw token to its caller and
 * nothing puts it in front of the person who has to click it. This is that step,
 * and it is only that step.
 *
 * ## Through `1.1`'s seam, and no second one
 *
 * The message goes to `MailPort` — the provider-neutral boundary Phase 1.1
 * declared — resolved by `resolveMailPort`. No SMTP client, no vendor SDK, no
 * template engine, and no HTML part is introduced here. A disabled deployment
 * refuses the message with `CHANNEL_NOT_CONFIGURED` rather than pretending, which
 * is exactly what a `1.1` adapter already does for every other notice.
 *
 * ## No `NotificationDelivery` row, deliberately
 *
 * `1.1`'s delivery table is evidence about **notices that accompany marketplace
 * obligations** — an order, a sale, a payment — and its three vocabularies
 * (`DeliveryAudience`, `NotificationCategory`, `NotificationSubjectKind`) are
 * `0M.N1`'s obligation vocabularies, reused. A verification link is none of those
 * things: it is an account-security credential addressed to a participant about
 * their own contact record, owing nothing and confirming nothing. Widening three
 * obligation vocabularies to make it fit would have made "what does Monacado
 * owe?" a harder question to answer for the benefit of one row.
 *
 * The `EmailVerificationChallenge` row already records that a proof was issued and
 * what became of it. What is genuinely missing is whether the *message* was
 * accepted, and that is returned to the caller rather than stored — recorded
 * delivery evidence for non-obligation mail belongs with `0M.N2`, which owns the
 * feedback loop that would make such a row worth keeping.
 *
 * ## The token is never returned
 *
 * `issueVerificationChallenge` hands the raw token back once; it goes straight
 * into the link and is not passed on. A caller of this module cannot obtain it,
 * so no route, page, log line, or test fixture can accidentally surface a working
 * credential. The digest is all that was ever written down.
 *
 * ## Ordering
 *
 * The origin is resolved **before** a challenge is minted. A misconfigured
 * deployment therefore refuses without having superseded the seller's working
 * link — the alternative burns a live challenge to discover that no link could
 * have been built from it.
 */

import "../server-only";
import type {
  EmailContactPurpose,
  EmailVerificationChallengeRecord,
} from "../../contracts/marketplace/participant-email-contact";
import type { MailPort, MailResult } from "../../contracts/marketplace/notification-delivery";
import { getPrisma } from "../db/client";
import { resolveMailPort } from "../notifications/mail-port";
import {
  issueVerificationChallenge,
  upsertEmailContact,
  type VerificationDeps,
} from "./email-verification-service";
import { PolicyError } from "./policy-errors";
import {
  buildVerificationUrl,
  readVerificationLinkOrigin,
  type Env,
} from "./verification-link";

type Db = ReturnType<typeof getPrisma>;

export interface VerificationNoticeDeps extends VerificationDeps {
  env?: Env;
  /** Injected so a test can assert a link without setting a global variable. */
  origin?: string;
}

/** What one verification request produced. The token is deliberately absent. */
export interface VerificationDispatch {
  challenge: EmailVerificationChallengeRecord;
  /** What the mail port answered. Never an inbox-delivery claim. */
  delivery: MailResult;
}

// — Rendering —

/**
 * The message, in full.
 *
 * Six things and no seventh: who it is from, why it arrived, the link, when the
 * link dies, what to do if it was unexpected, and a signature.
 *
 * **It carries no identifier.** No participant id, no contact id, no challenge
 * id, no account id, no seller display name, and no marketplace state. A
 * verification email routinely reaches a shared support mailbox, a forwarding
 * alias, or the wrong address entirely — it is the one message Monacado sends to
 * an address it does *not yet* believe in, so it says the least of any of them.
 *
 * It also does not name the address it is verifying. The recipient is holding it;
 * repeating it back would only add a line for a mis-delivered copy to disclose.
 */
export function renderVerificationMessage(input: {
  verificationUrl: string;
  /** ISO instant the challenge stops being usable. */
  expiresAt: string;
}): { subject: string; body: string } {
  return {
    subject: "Verify your Monacado email address",
    body: [
      "Monacado — email verification",
      "",
      "This address was given to Monacado as the customer support contact for a",
      "seller profile on the Monacado marketplace. Monacado needs to confirm that",
      "somebody reading this address asked for that.",
      "",
      "Verify this address:",
      input.verificationUrl,
      "",
      `This link can be used once and stops working at ${new Date(input.expiresAt).toUTCString()}.`,
      "",
      "If you were not expecting this, ignore this message. Nothing changes unless",
      "the link above is opened, and Monacado will not write to you again about it.",
      "",
      "— Monacado",
    ].join("\n"),
  };
}

// — Dispatch —

/**
 * Issue a verification challenge and deliver the link.
 *
 * **This is also the reissue path.** Calling it again supersedes the outstanding
 * challenge and sends a new link — that is `issueVerificationChallenge`'s
 * existing rule, unchanged, and it means only the newest link can ever verify the
 * contact. A seller who lost the first email asks again; the first link is dead
 * from that moment, which is the safe direction to fail in.
 *
 * ## Who may ask
 *
 * The acting account must **own the participant**. `MarketplaceParticipant`
 * holds one participant per account, so ownership is a single comparison and
 * there is no public surface here at all: nothing routes to this without an
 * authenticated principal. That is what stops it being an endpoint that mails
 * arbitrary addresses on request.
 *
 * Rate limiting is **not** implemented — see `VERIFICATION_OPERATIONAL_GAPS`. It
 * is safe to omit only because the sole destination is an address Monacado
 * already holds for that participant, so a caller cannot aim the traffic.
 */
export async function requestEmailContactVerification(
  input: {
    participantId: string;
    purpose: EmailContactPurpose;
    /** The authenticated account asking. Must own the participant. */
    actingAccountId: string;
    now: string;
  },
  port?: MailPort,
  deps: VerificationNoticeDeps = {},
): Promise<VerificationDispatch> {
  const db: Db = deps.db ?? getPrisma();

  const participant = await db.marketplaceParticipant.findUnique({
    where: { id: input.participantId },
    select: { accountId: true, account: { select: { email: true } } },
  });
  if (participant === null) {
    throw new PolicyError("PARTICIPANT_NOT_FOUND", "No such marketplace participant");
  }
  if (participant.accountId !== input.actingAccountId) {
    /* Deliberately the same shape for "not yours" as for a participant that does
       not exist would be if it reached here: the caller learns nothing about
       another account's participants either way. */
    throw new PolicyError(
      "VERIFICATION_NOT_AUTHORIZED",
      "That account may not request verification for this participant",
    );
  }

  /* Resolved first, so a deployment with no configured origin refuses BEFORE a
     challenge is minted and the seller's current link superseded. */
  const origin = deps.origin ?? readVerificationLinkOrigin(deps.env ?? process.env);

  let address: string;
  if (input.purpose === "PRIMARY_PROFILE") {
    address = participant.account.email;
    /* The primary contact records the STATE of the address on `Account`; it
       stores no copy. Creating it here is idempotent, and an existing row is
       returned untouched — `upsertEmailContact` only resets state when the
       address changes, and a primary contact's address is always `null`. */
    await upsertEmailContact(
      { participantId: input.participantId, purpose: "PRIMARY_PROFILE", now: input.now },
      deps,
    );
  } else {
    const contact = await db.participantEmailContact.findUnique({
      where: {
        participantId_purpose: {
          participantId: input.participantId,
          purpose: "DEDICATED_SUPPORT",
        },
      },
      select: { address: true },
    });
    if (contact === null || contact.address === null) {
      /* Nominating the address is a separate, deliberate act — `upsertEmailContact`
         — and doing it implicitly here would let one call both choose a support
         address and mail it. */
      throw new PolicyError("EMAIL_CONTACT_NOT_FOUND", "No such email contact");
    }
    address = contact.address;
  }

  const { challenge, token } = await issueVerificationChallenge(
    {
      participantId: input.participantId,
      purpose: input.purpose,
      address,
      issuedAt: input.now,
    },
    deps,
  );

  const { subject, body } = renderVerificationMessage({
    verificationUrl: buildVerificationUrl(origin, token),
    expiresAt: challenge.expiresAt,
  });

  const mail = port ?? resolveMailPort(deps.env ?? process.env);
  let delivery: MailResult;
  try {
    delivery = await mail.send({ to: address, subject, text: body });
  } catch {
    /* A port that throws is a port misbehaving — `MailPort` says an ordinary
       refusal is a result. The thrown value is deliberately NOT inspected: this
       message body contains a live credential, and an exception is the most
       likely place for a copy of it to be hiding. */
    delivery = { outcome: "REFUSED", failureCode: "UNSPECIFIED_FAILURE" };
  }

  return { challenge, delivery };
}

/**
 * What this phase did not build, named rather than left to be discovered.
 *
 * Each is an operational control, not a design gap: the mechanism is correct
 * without them and less safe to run at volume.
 */
export const VERIFICATION_OPERATIONAL_GAPS = {
  /**
   * No limit on how often a participant may request a link. Bounded in effect —
   * the destination is always an address Monacado already holds for that
   * participant, so it cannot be aimed at a third party — but a seller who holds
   * the button down still sends themselves unbounded mail from Monacado's domain,
   * which is a reputation cost Monacado pays.
   */
  rateLimiting: "NOT_IMPLEMENTED",
  /** No bounce, complaint, or suppression handling. `0M.N2` owns the feedback loop. */
  bounceHandling: "NOT_IMPLEMENTED_SEE_0M_N2",
  /** No production mail vendor is selected or configured. */
  productionMailVendor: "NOT_SELECTED",
  /**
   * The link is consumed by an ordinary `GET`, so a mail scanner or link
   * prefetcher that follows it consumes the challenge before the recipient does.
   * The contact still ends up verified — the correct outcome — but the person
   * clicking sees "already used". A confirmation step would fix it and is a
   * deliberate deferral, not an oversight.
   */
  scannerConsumesLink: "ACCEPTED_IN_THIS_PHASE",
} as const;
