/**
 * Verification message delivery (Phase 1.4) — SERVER ONLY.
 *
 * Phase 1.3 built the whole proof-of-control mechanism and stopped one step
 * short: `issueVerificationChallenge` returns a raw token to its caller and
 * nothing puts it in front of the person who has to click it. This is that step,
 * and it is only that step.
 *
 * ## Phase 1.5: one durable commitment, not one inline send
 *
 * `1.4` minted a challenge and attempted exactly one send. A provider blip
 * therefore stranded the seller with a link nobody received and no retry path.
 *
 * Now **issuing the challenge and scheduling its email are one operation**, and
 * the way they are made one is that neither happens at request time: this commits
 * a durable `OutboundEmailDelivery` naming the *contact*, and the dispatcher mints
 * the challenge and renders the link on each attempt. The two cannot diverge
 * because there is no state in which one exists without the other — no challenge
 * is issued that nothing was going to send, and no send is scheduled that has no
 * challenge behind it.
 *
 * ## Retrying without ever storing a plaintext token
 *
 * `1.3`'s token is returned once and only its digest is stored, so a retry cannot
 * resend the first link. Storing the plaintext would make a table read a set of
 * working takeovers; storing it encrypted would make it a key plus a table read.
 *
 * A retry instead **mints a fresh challenge**, which supersedes its predecessor
 * exactly as `1.3` already specified for reissue. Nothing about the token model
 * is weakened: still 256 bits, still opaque, still digest-only, still 24h, still
 * single-use, still superseding. The superseded link was never delivered — that
 * is *why* there is a retry — so nothing usable is invalidated. The full argument
 * is in `email-message-resolver.ts`, where the minting happens.
 *
 * ## Through `1.1`'s seam, and no second one
 *
 * Everything reaches the recipient through `MailPort`. This file introduces no
 * SMTP client, no vendor SDK, no template engine, and no HTML part; `1.5`'s
 * Postmark adapter sits behind the same interface and changed nothing here.
 *
 * ## No `NotificationObligation`, deliberately
 *
 * A verification link owes nothing and confirms nothing: it is an
 * account-security credential addressed to a participant about their own contact
 * record. `OutboundEmailDelivery.obligationId` is `null` for it, and that
 * nullability is exactly why `1.5` built a delivery model rather than extending
 * `0M.N1`'s obligation vocabulary to cover mail that is owed to nobody.
 *
 * ## The token is never returned, and now never even exists here
 *
 * `1.4` held the raw token in this scope for the length of one send. It no longer
 * does: minting happens in the dispatcher's resolver, so there is no variable in
 * this file a credential could occupy.
 */

import "../server-only";
import type { EmailContactPurpose } from "../../contracts/marketplace/participant-email-contact";
import type { MailPort } from "../../contracts/marketplace/notification-delivery";
import type { OutboundEmailDeliveryRecord } from "../../contracts/marketplace/outbound-email";
import { getPrisma } from "../db/client";
import { dispatchEmailDeliveriesNow } from "../notifications/email-dispatcher";
import {
  cryptoOutboundEmailIdProvider,
  type OutboundEmailIdProvider,
} from "../notifications/outbound-email-ids";
import { outboundDeliveryRowToRecord } from "../notifications/outbound-email-mapper";
import { enqueueEmailDelivery } from "../notifications/outbound-email-service";
import { upsertEmailContact, type VerificationDeps } from "./email-verification-service";
import { PolicyError } from "./policy-errors";
import { readVerificationLinkOrigin, type Env } from "./verification-link";

type Db = ReturnType<typeof getPrisma>;

export interface VerificationNoticeDeps extends VerificationDeps {
  env?: Env;
  /** Injected so a test can assert a link without setting a global variable. */
  origin?: string;
  /** Identity for the durable delivery row and its message discriminator. */
  outboundIds?: OutboundEmailIdProvider;
}

/**
 * What one verification request produced.
 *
 * The durable commitment, and nothing else. There is no `challenge` field any
 * more and no `token` field ever: the challenge is minted at send time, so at
 * this point one does not yet exist to return — which is the same property that
 * makes a retry possible without storing a credential.
 */
export interface VerificationDispatch {
  delivery: OutboundEmailDeliveryRecord;
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
 * Commit to verifying one email contact, and try to send the link now.
 *
 * **This is also the reissue path.** Calling it again commits a new message, and
 * the challenge that message mints supersedes whatever stood before — `1.3`'s
 * rule, unchanged, so only the newest link can ever verify the contact. A seller
 * who lost the first email asks again; the first link is dead from that moment,
 * which is the safe direction to fail in.
 *
 * Each request is a distinct logical message and carries its own discriminator,
 * so asking twice commits twice. That is deliberate and is what separates a
 * reissue from a duplicate: an order receipt has exactly one logical message
 * forever, and a verification request is a new one every time somebody asks.
 *
 * ## Who may ask
 *
 * The acting account must **own the participant**. `MarketplaceParticipant` holds
 * one participant per account, so ownership is a single comparison, and there is
 * no public surface here at all: nothing routes to this without an authenticated
 * principal. That is what stops it being an endpoint that mails arbitrary
 * addresses on request.
 *
 * Rate limiting is **not** implemented — see `VERIFICATION_OPERATIONAL_GAPS`. It
 * is safe to omit only because the sole destination is an address Monacado
 * already holds for that participant, so a caller cannot aim the traffic.
 *
 * ## Why the origin is still checked here
 *
 * The dispatcher checks it too, and would classify a missing one as transient.
 * Checking it at request time as well makes a misconfigured deployment tell the
 * *seller* immediately rather than committing a message that will fail four
 * times first.
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
  const outboundIds = deps.outboundIds ?? cryptoOutboundEmailIdProvider;

  const participant = await db.marketplaceParticipant.findUnique({
    where: { id: input.participantId },
    select: { accountId: true },
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

  /* Fail fast for the seller rather than committing a message that cannot be
     rendered. The dispatcher checks this again on every attempt. */
  if (deps.origin === undefined) readVerificationLinkOrigin(deps.env ?? process.env);

  let contactId: string;
  if (input.purpose === "PRIMARY_PROFILE") {
    /* The primary contact records the STATE of the address on `Account`; it
       stores no copy. Creating it here is idempotent, and an existing row is
       returned untouched — `upsertEmailContact` only resets state when the
       address changes, and a primary contact's address is always `null`. */
    const contact = await upsertEmailContact(
      { participantId: input.participantId, purpose: "PRIMARY_PROFILE", now: input.now },
      deps,
    );
    contactId = contact.contactId;
  } else {
    const contact = await db.participantEmailContact.findUnique({
      where: {
        participantId_purpose: {
          participantId: input.participantId,
          purpose: "DEDICATED_SUPPORT",
        },
      },
      select: { id: true, address: true },
    });
    if (contact === null || contact.address === null) {
      /* Nominating the address is a separate, deliberate act — `upsertEmailContact`
         — and doing it implicitly here would let one call both choose a support
         address and mail it. */
      throw new PolicyError("EMAIL_CONTACT_NOT_FOUND", "No such email contact");
    }
    contactId = contact.id;
  }

  const { delivery } = await enqueueEmailDelivery(
    {
      purpose: "EMAIL_VERIFICATION",
      audience: "SELLER",
      recipientParticipantId: input.participantId,
      /* Owed to nobody. This is the nullability the whole 1.5 delivery model
         exists for — see the note at the top of this file. */
      obligationId: null,
      subjectKind: "EMAIL_CONTACT",
      subjectRef: contactId,
      /* A fresh discriminator per request: asking again IS a new message. */
      discriminator: outboundIds.nextMessageDiscriminator(),
      now: input.now,
    },
    { ...deps, ids: outboundIds },
  );

  /* Best effort, and after the commitment is durable. A seller should not wait
     for a scheduler; a provider blip now schedules a retry rather than stranding
     them, which is precisely what `1.4` could not do. */
  try {
    await dispatchEmailDeliveriesNow(
      { deliveryIds: [delivery.deliveryId], now: input.now },
      port,
      { ...deps, ids: outboundIds, policyIds: deps.ids },
    );
  } catch {
    /* The commitment stands and the dispatcher will pick it up. */
  }

  /* Re-read so the caller sees the outcome of the immediate attempt rather than
     the PENDING row it was committed as. */
  const settled = await db.outboundEmailDelivery.findUnique({
    where: { id: delivery.deliveryId },
  });
  return { delivery: settled === null ? delivery : outboundDeliveryRowToRecord(settled) };
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
