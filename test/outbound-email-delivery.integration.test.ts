/**
 * Durable outbound email delivery integration tests (Phase 1.5).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK AND NO PRODUCTION SEND.** Every port here is `1.1`'s capturing or
 * disabled adapter, or a local double. The Postmark adapter is never constructed,
 * so no request can leave this process.
 *
 * **Test isolation.** Every identifier carries the `P15T` prefix, every account
 * address the `p15t-` local part, and every address is `@example.invalid`.
 * Suppression and provider-event rows are keyed by digest, so cleanup targets the
 * digests this suite produced rather than deleting the tables.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type { PolicyIdProvider } from "../src/server/policy/policy-ids";
import type { MailPort, MailResult } from "../src/contracts/marketplace/notification-delivery";
import { createCapturingMailAdapter } from "../src/server/notifications/mail-port";
import type { OutboundEmailIdProvider } from "../src/server/notifications/outbound-email-ids";
import {
  claimDueEmailDeliveries,
  enqueueEmailDelivery,
  getEmailDelivery,
  listEmailDeliveriesForSubject,
  recoverStaleEmailClaims,
  summarizeEmailDeliveries,
} from "../src/server/notifications/outbound-email-service";
import {
  dispatchEmailDeliveriesNow,
  runEmailDispatchCycle,
} from "../src/server/notifications/email-dispatcher";
import {
  emailAddressDigest,
  getEmailSuppression,
  isAddressSuppressed,
} from "../src/server/notifications/email-suppression-service";
import { ingestProviderEmailEvent } from "../src/server/notifications/email-event-ingestion-service";
import { normalizePostmarkEvent } from "../src/server/notifications/postmark-webhook";
import { handleProviderEmailWebhookRequest } from "../src/server/notifications/email-webhook-route-handler";
import {
  consumeVerificationChallenge,
  getEmailContact,
  upsertEmailContact,
} from "../src/server/policy/email-verification-service";
import { requestEmailContactVerification } from "../src/server/policy/verification-notice-service";
import {
  hasUsableSupportContactIn,
  resolveSellerSupportContact,
} from "../src/server/policy/support-contact-service";
import { createNotificationObligation } from "../src/server/marketplace/notification-obligation-service";
import {
  countDeliveriesIn,
  destinationDigest,
  listDeliveriesForSubject,
  LEGACY_NOTIFICATION_DELIVERY,
} from "../src/server/notifications/notification-delivery-service";
import { EMAIL_RETRY_POLICY } from "../src/contracts/marketplace/outbound-email";
import { VERIFICATION_TOKEN_PARAM } from "../src/server/policy/verification-link";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P15T";
const EMAIL_PREFIX = "p15t-";
const PASSWORD = "correct-horse-battery-staple-p15";
const ORIGIN = "https://monacado.test";
const NOW = "2028-07-01T09:00:00.000Z";

/** Later than `NOW` by more than the given seconds. */
const after = (seconds: number, from: string = NOW): string =>
  new Date(new Date(from).getTime() + (seconds + 1) * 1_000).toISOString();

let seq = 0;
function pad26(seed: string): string {
  const body = seed.toUpperCase().replace(/[ILOU]/g, "0");
  return (body + "0".repeat(26)).slice(0, 26);
}
const nextSuffix = () => pad26(`${TAG}${(seq += 1)}`);

const participantIds: ParticipantIdProvider = {
  nextParticipantId: () => `mon:mpart:${nextSuffix()}`,
  nextRoleAssignmentId: () => `mon:mrole:${nextSuffix()}`,
  nextProfileId: () => `mon:mprof:${nextSuffix()}`,
  nextActivationId: () => `mon:mact:${nextSuffix()}`,
  nextPaymentAccountId: () => `mon:mpay:${nextSuffix()}`,
  nextRestrictionId: () => `mon:prst:${nextSuffix()}`,
  nextObligationId: () => `mon:nobl:${nextSuffix()}`,
};
const policyIds: PolicyIdProvider = {
  nextAcceptanceId: () => `mon:pacc:${nextSuffix()}`,
  nextEmailContactId: () => `mon:pemc:${nextSuffix()}`,
  nextVerificationChallengeId: () => `mon:evch:${nextSuffix()}`,
};
const outboundIds: OutboundEmailIdProvider = {
  nextOutboundDeliveryId: () => `mon:oeml:${nextSuffix()}`,
  nextSuppressionId: () => `mon:esup:${nextSuffix()}`,
  nextProviderEventId: () => `mon:pevt:${nextSuffix()}`,
  nextMessageDiscriminator: () => nextSuffix(),
  nextLockToken: () => `lock-${nextSuffix()}`,
};

/** The dispatcher, pointed at this suite's identities and a fixed origin. */
const ddeps = () => ({
  db,
  ids: outboundIds,
  policyIds,
  origin: ORIGIN,
  providerName: "CAPTURE",
});

/** A port that refuses with one bounded code, so a class can be exercised. */
const refusingPort = (
  failureCode: "PROVIDER_UNAVAILABLE" | "DESTINATION_REJECTED" | "CHANNEL_NOT_CONFIGURED",
): MailPort & { calls: number } => {
  const port = {
    calls: 0,
    async send(): Promise<MailResult> {
      port.calls += 1;
      return { outcome: "REFUSED", failureCode };
    },
  };
  return port;
};

const suiteDigests: string[] = [];
const digestOf = (address: string): string => {
  const digest = emailAddressDigest(address);
  if (!suiteDigests.includes(digest)) suiteDigests.push(digest);
  return digest;
};

async function cleanup(): Promise<void> {
  const owned = { participantId: { startsWith: `mon:mpart:${TAG}` } };
  await db.outboundEmailDelivery.deleteMany({
    where: { OR: [{ id: { startsWith: `mon:oeml:${TAG}` } }, { subjectRef: { startsWith: `mon:pemc:${TAG}` } }] },
  });
  await db.notificationDelivery.deleteMany({
    where: { subjectRef: { startsWith: `mon:order:${TAG}` } },
  });
  await db.notificationObligation.deleteMany({
    where: { recipientParticipantId: { startsWith: `mon:mpart:${TAG}` } },
  });
  await db.emailVerificationChallenge.deleteMany({ where: owned });
  await db.participantEmailContact.deleteMany({ where: owned });
  await db.marketplaceRoleAssignment.deleteMany({ where: owned });
  await db.marketplaceParticipant.deleteMany({
    where: { id: { startsWith: `mon:mpart:${TAG}` } },
  });
  /* Digest-keyed tables: only the digests this suite produced. */
  if (suiteDigests.length > 0) {
    await db.emailSuppression.deleteMany({ where: { addressDigest: { in: suiteDigests } } });
    await db.providerEmailEvent.deleteMany({ where: { addressDigest: { in: suiteDigests } } });
  }
  await db.accountSession.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.account.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function seedAccount(): Promise<{ accountId: string; email: string }> {
  seq += 1;
  const email = `${EMAIL_PREFIX}${seq}@example.invalid`;
  const account = await createAccount(
    { name: "Synthetic Person", email, password: PASSWORD, createdAt: NOW },
    { db },
  );
  digestOf(email);
  return { accountId: account.accountId, email };
}

async function seedSeller(): Promise<{
  participantId: string;
  accountId: string;
  email: string;
}> {
  const { accountId, email } = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: ["SELLER"], now: NOW },
    { db, ids: participantIds },
  );
  return { participantId: snapshot.participant.participantId, accountId, email };
}

/** Send a primary-contact verification and return the delivered token. */
async function issuePrimaryToken(seller: {
  participantId: string;
  accountId: string;
}): Promise<string> {
  const port = createCapturingMailAdapter();
  await requestEmailContactVerification(
    {
      participantId: seller.participantId,
      purpose: "PRIMARY_PROFILE",
      actingAccountId: seller.accountId,
      now: NOW,
    },
    port,
    { ...ddeps(), outboundIds, ids: policyIds },
  );
  return tokenFrom(port.sent[0]!.text);
}

/** Register a primary contact and carry a real token through to VERIFIED. */
async function verifyPrimary(seller: { participantId: string; accountId: string }): Promise<void> {
  await consumeVerificationChallenge({ token: await issuePrimaryToken(seller), at: NOW }, { db });
}

/** Nominate and verify a dedicated support address. */
async function verifyDedicated(
  seller: { participantId: string; accountId: string },
  address: string,
): Promise<void> {
  await upsertEmailContact(
    { participantId: seller.participantId, purpose: "DEDICATED_SUPPORT", address, now: NOW },
    { db, ids: policyIds },
  );
  const port = createCapturingMailAdapter();
  await requestEmailContactVerification(
    {
      participantId: seller.participantId,
      purpose: "DEDICATED_SUPPORT",
      actingAccountId: seller.accountId,
      now: NOW,
    },
    port,
    { ...ddeps(), outboundIds, ids: policyIds },
  );
  await consumeVerificationChallenge({ token: tokenFrom(port.sent[0]!.text), at: NOW }, { db });
  digestOf(address);
}

/** The token exactly as a recipient obtains it: out of the delivered link. */
function tokenFrom(body: string): string {
  const link = body.match(/https:\/\/\S+/);
  if (link === null) throw new Error("no verification link in the delivered message");
  const token = new URL(link[0]).searchParams.get(VERIFICATION_TOKEN_PARAM);
  if (token === null) throw new Error("no token on the verification link");
  return token;
}

/** Commit one verification message without sending it. */
async function enqueueVerification(seller: { participantId: string }): Promise<string> {
  const contact = await upsertEmailContact(
    { participantId: seller.participantId, purpose: "PRIMARY_PROFILE", now: NOW },
    { db, ids: policyIds },
  );
  const { delivery } = await enqueueEmailDelivery(
    {
      purpose: "EMAIL_VERIFICATION",
      audience: "SELLER",
      recipientParticipantId: seller.participantId,
      obligationId: null,
      subjectKind: "EMAIL_CONTACT",
      subjectRef: contact.contactId,
      discriminator: outboundIds.nextMessageDiscriminator(),
      now: NOW,
    },
    { db, ids: outboundIds },
  );
  return delivery.deliveryId;
}

const describeIf = RUN ? describe : describe.skip;

// ── 1 · the delivery lifecycle ──────────────────────────────────────────────

describeIf("1.5 — durable delivery lifecycle", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterAll(async () => {
    if (RUN) {
      await cleanup();
      await disconnectPrisma();
    }
  });

  it("commits one row per logical message, however many callers commit to it", async () => {
    const seller = await seedSeller();
    const contact = await upsertEmailContact(
      { participantId: seller.participantId, purpose: "PRIMARY_PROFILE", now: NOW },
      { db, ids: policyIds },
    );
    const input = {
      purpose: "SALE_RECORDED" as const,
      audience: "SELLER" as const,
      recipientParticipantId: seller.participantId,
      obligationId: null,
      subjectKind: "EMAIL_CONTACT" as const,
      subjectRef: contact.contactId,
      discriminator: null,
      now: NOW,
    };

    const first = await enqueueEmailDelivery(input, { db, ids: outboundIds });
    const second = await enqueueEmailDelivery(input, { db, ids: outboundIds });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.delivery.deliveryId).toBe(first.delivery.deliveryId);
    expect(
      await db.outboundEmailDelivery.count({ where: { subjectRef: contact.contactId } }),
    ).toBe(1);
  });

  it("a successful send is terminal", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);
    const port = createCapturingMailAdapter();

    const cycle = await runEmailDispatchCycle({ now: NOW }, port, ddeps());

    expect(cycle.delivered).toBe(1);
    const delivery = await getEmailDelivery(deliveryId, { db });
    expect(delivery?.status).toBe("DELIVERED");
    expect(delivery?.attemptCount).toBe(1);
    expect(delivery?.nextAttemptAt).toBeNull();
    expect(delivery?.sentAt).toBe(NOW);
    expect(delivery?.finalizedAt).toBe(NOW);
    expect(delivery?.providerMessageRef).not.toBeNull();
    expect(delivery?.destinationDigest).toBe(digestOf(seller.email));
    expect(port.sent).toHaveLength(1);
  });

  it("a transient failure schedules a retry, and the retry succeeds", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);

    const failing = refusingPort("PROVIDER_UNAVAILABLE");
    const first = await runEmailDispatchCycle({ now: NOW }, failing, ddeps());
    expect(first.retryScheduled).toBe(1);

    const scheduled = await getEmailDelivery(deliveryId, { db });
    expect(scheduled?.status).toBe("RETRY_PENDING");
    expect(scheduled?.attemptCount).toBe(1);
    expect(scheduled?.lastFailureCode).toBe("PROVIDER_UNAVAILABLE");
    expect(scheduled?.lastFailureClass).toBe("TRANSIENT");
    expect(scheduled?.nextAttemptAt).toBe(
      new Date(new Date(NOW).getTime() + 60_000).toISOString(),
    );

    /* Not yet due: a backoff that can be ignored is not a backoff. */
    const tooSoon = await runEmailDispatchCycle({ now: NOW }, createCapturingMailAdapter(), ddeps());
    expect(tooSoon.claimed).toBe(0);

    const port = createCapturingMailAdapter();
    const second = await runEmailDispatchCycle({ now: after(60) }, port, ddeps());
    expect(second.delivered).toBe(1);

    const delivered = await getEmailDelivery(deliveryId, { db });
    expect(delivered?.status).toBe("DELIVERED");
    expect(delivered?.attemptCount).toBe(2);
    expect(delivered?.lastFailureCode).toBeNull();
    expect(port.sent).toHaveLength(1);
  });

  it("exhausting the bounded policy is permanent, and stops trying", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);
    const port = refusingPort("PROVIDER_UNAVAILABLE");

    let now = NOW;
    for (let attempt = 1; attempt <= EMAIL_RETRY_POLICY.maxAttempts; attempt += 1) {
      await runEmailDispatchCycle({ now }, port, ddeps());
      const state = await getEmailDelivery(deliveryId, { db });
      expect(state?.attemptCount).toBe(attempt);
      now = state?.nextAttemptAt === null ? now : after(0, state!.nextAttemptAt!);
    }

    const failed = await getEmailDelivery(deliveryId, { db });
    expect(failed?.status).toBe("PERMANENTLY_FAILED");
    expect(failed?.attemptCount).toBe(EMAIL_RETRY_POLICY.maxAttempts);
    expect(failed?.nextAttemptAt).toBeNull();
    expect(failed?.finalizedAt).not.toBeNull();
    expect(port.calls).toBe(EMAIL_RETRY_POLICY.maxAttempts);

    /* And nothing picks it up again, ever. */
    const after_ = await runEmailDispatchCycle({ now: after(100_000) }, port, ddeps());
    expect(after_.claimed).toBe(0);
    expect(port.calls).toBe(EMAIL_RETRY_POLICY.maxAttempts);
  });

  it("a permanent rejection never schedules a retry, whatever the counter says", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);
    const port = refusingPort("DESTINATION_REJECTED");

    await runEmailDispatchCycle({ now: NOW }, port, ddeps());

    const delivery = await getEmailDelivery(deliveryId, { db });
    expect(delivery?.status).toBe("PERMANENTLY_FAILED");
    expect(delivery?.attemptCount).toBe(1);
    expect(delivery?.lastFailureClass).toBe("PERMANENT");
    expect(port.calls).toBe(1);
  });

  it("two workers never claim the same row", async () => {
    const seller = await seedSeller();
    await enqueueVerification(seller);

    const [a, b] = await Promise.all([
      claimDueEmailDeliveries({ now: NOW, limit: 10 }, { db, ids: outboundIds }),
      claimDueEmailDeliveries({ now: NOW, limit: 10 }, { db, ids: outboundIds }),
    ]);
    expect(a.length + b.length).toBe(1);

    /* And a third worker arriving afterwards finds a claimed row, not a due one. */
    const third = await claimDueEmailDeliveries({ now: NOW, limit: 10 }, { db, ids: outboundIds });
    expect(third).toHaveLength(0);
  });

  it("a dead worker costs an attempt, never the message", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);

    /* Claimed and then abandoned — the process died between claiming and
       resolving, which is the state a lease exists to survive. */
    await claimDueEmailDeliveries({ now: NOW, limit: 1 }, { db, ids: outboundIds });
    expect((await getEmailDelivery(deliveryId, { db }))?.status).toBe("IN_PROGRESS");

    /* A live claim is never stolen. */
    expect(await recoverStaleEmailClaims({ now: NOW, limit: 10 }, { db })).toBe(0);

    const later = after(EMAIL_RETRY_POLICY.claimLeaseSeconds);
    expect(await recoverStaleEmailClaims({ now: later, limit: 10 }, { db })).toBe(1);

    const recovered = await getEmailDelivery(deliveryId, { db });
    expect(recovered?.status).toBe("RETRY_PENDING");
    /* Counted: the send may well have gone out, and a recovery that did not count
       it would retry a delivered message for the full policy. */
    expect(recovered?.attemptCount).toBe(1);
  });

  it("an unconfigured channel fails closed without losing the message", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);
    const port = refusingPort("CHANNEL_NOT_CONFIGURED");

    await runEmailDispatchCycle({ now: NOW }, port, ddeps());

    const delivery = await getEmailDelivery(deliveryId, { db });
    expect(delivery?.status).toBe("RETRY_PENDING");
    expect(delivery?.lastFailureCode).toBe("CHANNEL_NOT_CONFIGURED");
    expect(delivery?.sentAt).toBeNull();
    expect(delivery?.providerMessageRef).toBeNull();
  });

  it("answers the questions a support surface has to answer", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);
    await runEmailDispatchCycle({ now: NOW }, createCapturingMailAdapter(), ddeps());

    const contactId = (await getEmailDelivery(deliveryId, { db }))!.subjectRef;
    const [record] = await listEmailDeliveriesForSubject(
      { kind: "EMAIL_CONTACT", ref: contactId },
      { db },
    );
    expect(record?.status).toBe("DELIVERED");
    expect(record?.providerMessageRef).not.toBeNull();
    expect(record?.attemptCount).toBe(1);
    /* No address and no body: a support agent learns what happened without being
       handed the address to read. */
    expect(JSON.stringify(record)).not.toContain(seller.email);
    expect(JSON.stringify(record)).not.toContain("Verify your Monacado");

    const summary = await summarizeEmailDeliveries({ db });
    expect(summary.DELIVERED).toBeGreaterThanOrEqual(1);
  });
});

// ── 2 · verification on the durable path ────────────────────────────────────

describeIf("1.5 — verification email on the durable path", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterAll(async () => {
    if (RUN) {
      await cleanup();
      await disconnectPrisma();
    }
  });

  it("mints no challenge until the message is actually rendered", async () => {
    const seller = await seedSeller();
    await enqueueVerification(seller);

    /* Committed, and nothing issued: the challenge and the send are produced by
       one act, so neither can exist without the other. */
    expect(
      await db.emailVerificationChallenge.count({
        where: { participantId: seller.participantId },
      }),
    ).toBe(0);

    await runEmailDispatchCycle({ now: NOW }, createCapturingMailAdapter(), ddeps());
    expect(
      await db.emailVerificationChallenge.count({
        where: { participantId: seller.participantId },
      }),
    ).toBe(1);
  });

  it("retries by minting a fresh challenge, storing no plaintext token", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);

    /* Attempt 1 fails transiently. */
    await runEmailDispatchCycle({ now: NOW }, refusingPort("PROVIDER_UNAVAILABLE"), ddeps());

    const port = createCapturingMailAdapter();
    await runEmailDispatchCycle({ now: after(60) }, port, ddeps());

    expect((await getEmailDelivery(deliveryId, { db }))?.status).toBe("DELIVERED");
    expect(port.sent).toHaveLength(1);

    const challenges = await db.emailVerificationChallenge.findMany({
      where: { participantId: seller.participantId },
      orderBy: { issuedAt: "asc" },
    });
    /* One per attempt, and only the newest may verify — `1.3`'s supersession
       rule used as the retry mechanism. The superseded one was never delivered,
       so nothing usable was invalidated. */
    expect(challenges).toHaveLength(2);
    expect(challenges[0]!.state).toBe("SUPERSEDED");
    expect(challenges[1]!.state).toBe("PENDING");

    /* The token model is not weakened to permit any of this. */
    const token = tokenFrom(port.sent[0]!.text);
    expect(token).toHaveLength(43);
    expect(JSON.stringify(challenges)).not.toContain(token);
    const delivery = await db.outboundEmailDelivery.findUnique({ where: { id: deliveryId } });
    expect(JSON.stringify(delivery)).not.toContain(token);

    /* And the freshly minted link works. */
    const contact = await consumeVerificationChallenge({ token, at: after(120) }, { db });
    expect(contact.state).toBe("VERIFIED");
  });

  it("fabricates no obligation for mail that is owed to nobody", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);
    await runEmailDispatchCycle({ now: NOW }, createCapturingMailAdapter(), ddeps());

    expect((await getEmailDelivery(deliveryId, { db }))?.obligationId).toBeNull();
    expect(
      await db.notificationObligation.count({
        where: { recipientParticipantId: seller.participantId },
      }),
    ).toBe(0);
  });

  it("keeps an obligation-backed delivery pointing at its obligation, untouched", async () => {
    const seller = await seedSeller();
    const orderRef = `mon:order:${nextSuffix()}`;
    const obligation = await createNotificationObligation(
      {
        recipientParticipantId: seller.participantId,
        category: "SALE_RECORDED",
        subject: { kind: "ORDER", ref: orderRef, versionRef: null },
        contextCode: null,
        createdAt: NOW,
      },
      { db, ids: participantIds },
    );

    const { delivery } = await enqueueEmailDelivery(
      {
        purpose: "SALE_RECORDED",
        audience: "SELLER",
        recipientParticipantId: seller.participantId,
        obligationId: obligation.obligationId,
        subjectKind: "ORDER",
        subjectRef: orderRef,
        discriminator: null,
        now: NOW,
      },
      { db, ids: outboundIds },
    );

    /* No such Order exists, so the send permanently fails — which is exactly the
       case that matters: the link must survive a failure. */
    await runEmailDispatchCycle({ now: NOW }, createCapturingMailAdapter(), ddeps());

    const settled = await getEmailDelivery(delivery.deliveryId, { db });
    expect(settled?.status).toBe("PERMANENTLY_FAILED");
    expect(settled?.lastFailureCode).toBe("RECIPIENT_UNRESOLVABLE");
    expect(settled?.obligationId).toBe(obligation.obligationId);

    /* §3a — the admin panel is canonical. Five attempts leave the obligation
       exactly as owed as one did. */
    const row = await db.notificationObligation.findUniqueOrThrow({
      where: { id: obligation.obligationId },
    });
    expect(row.status).toBe("UNREAD");
    expect(row.acknowledgedAt).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });
});

// ── 3 · bounces, complaints, suppression, and seller reachability ───────────

describeIf("1.5 — bounces, suppression, and seller reachability", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterAll(async () => {
    if (RUN) {
      await cleanup();
      await disconnectPrisma();
    }
  });

  const hardBounce = (address: string, id: number) =>
    normalizePostmarkEvent(
      {
        RecordType: "Bounce",
        Type: "HardBounce",
        ID: id,
        Email: address,
        MessageID: `pm-${id}`,
        BouncedAt: NOW,
      },
      NOW,
    )!;

  it("a hard bounce suppresses the address and stops future delivery", async () => {
    const seller = await seedSeller();
    await ingestProviderEmailEvent(hardBounce(seller.email, 1), NOW, { db, ids: outboundIds });

    expect(await isAddressSuppressed(seller.email, { db })).toBe(true);
    expect((await getEmailSuppression(seller.email, { db }))?.reason).toBe("HARD_BOUNCE");

    /* A message committed AFTER the bounce is never sent. */
    const deliveryId = await enqueueVerification(seller);
    const port = createCapturingMailAdapter();
    const cycle = await runEmailDispatchCycle({ now: after(10) }, port, ddeps());

    expect(cycle.suppressed).toBe(1);
    expect(port.sent).toHaveLength(0);
    const delivery = await getEmailDelivery(deliveryId, { db });
    expect(delivery?.status).toBe("PERMANENTLY_FAILED");
    expect(delivery?.lastFailureCode).toBe("DESTINATION_SUPPRESSED");
  });

  it("suppression is checked before every attempt, not once at commit", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);

    /* Committed while the address was fine; bounced before the first attempt. */
    await ingestProviderEmailEvent(hardBounce(seller.email, 2), after(1), { db, ids: outboundIds });

    const port = createCapturingMailAdapter();
    await runEmailDispatchCycle({ now: after(10) }, port, ddeps());

    expect(port.sent).toHaveLength(0);
    expect((await getEmailDelivery(deliveryId, { db }))?.lastFailureCode).toBe(
      "DESTINATION_SUPPRESSED",
    );
  });

  it("a complaint is a permanent suppression, and a soft bounce is not", async () => {
    const complained = await seedAccount();
    const soft = await seedAccount();

    await ingestProviderEmailEvent(
      normalizePostmarkEvent(
        { RecordType: "SpamComplaint", ID: 11, Email: complained.email, MessageID: "pm-11" },
        NOW,
      )!,
      NOW,
      { db, ids: outboundIds },
    );
    await ingestProviderEmailEvent(
      normalizePostmarkEvent(
        { RecordType: "Bounce", Type: "SoftBounce", ID: 12, Email: soft.email },
        NOW,
      )!,
      NOW,
      { db, ids: outboundIds },
    );

    expect((await getEmailSuppression(complained.email, { db }))?.reason).toBe("SPAM_COMPLAINT");
    /* The retry policy owns transient conditions. */
    expect(await isAddressSuppressed(soft.email, { db })).toBe(false);
  });

  it("a replayed webhook changes nothing a second time", async () => {
    const seller = await seedSeller();
    const body = JSON.stringify({
      RecordType: "Bounce",
      Type: "HardBounce",
      ID: 99,
      Email: seller.email,
      MessageID: "pm-99",
      BouncedAt: NOW,
    });
    const request = {
      authorizationHeader: null,
      secretHeader: "p15t-webhook-secret",
      rawBody: body,
      receivedAt: NOW,
    };
    const env = {
      MONACADO_MAIL_FROM_ADDRESS: "notifications@monacado.test",
      MONACADO_POSTMARK_WEBHOOK_SECRET: "p15t-webhook-secret",
    };

    const first = await handleProviderEmailWebhookRequest(request, {
      db,
      ids: outboundIds,
      env,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ handled: true, duplicate: false, suppressed: true });

    for (const _ of [1, 2]) {
      const replay = await handleProviderEmailWebhookRequest(request, { db, ids: outboundIds, env });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ duplicate: true, suppressed: false });
    }

    expect(
      await db.providerEmailEvent.count({ where: { providerEventId: "Bounce:99" } }),
    ).toBe(1);
    expect(
      await db.emailSuppression.count({ where: { addressDigest: digestOf(seller.email) } }),
    ).toBe(1);
  });

  it("refuses an unauthenticated webhook without parsing it", async () => {
    const result = await handleProviderEmailWebhookRequest(
      {
        authorizationHeader: null,
        secretHeader: "wrong",
        rawBody: "{}",
        receivedAt: NOW,
      },
      {
        db,
        env: {
          MONACADO_MAIL_FROM_ADDRESS: "notifications@monacado.test",
          MONACADO_POSTMARK_WEBHOOK_SECRET: "p15t-webhook-secret",
        },
      },
    );
    expect(result).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } });
  });

  it("a bounced dedicated support address falls back to the verified primary", async () => {
    const seller = await seedSeller();
    await verifyPrimary(seller);
    const dedicated = `${EMAIL_PREFIX}support-${(seq += 1)}@example.invalid`;
    await verifyDedicated(seller, dedicated);

    expect(await resolveSellerSupportContact(seller.participantId, { db })).toMatchObject({
      available: true,
      source: "DEDICATED_SUPPORT",
    });

    await ingestProviderEmailEvent(hardBounce(dedicated, 21), after(10), { db, ids: outboundIds });

    /* Degraded, not deleted: `verifiedAt` is kept so the regression is dateable. */
    const contact = await getEmailContact(seller.participantId, "DEDICATED_SUPPORT", { db });
    expect(contact?.state).toBe("DELIVERY_FAILED");
    expect(contact?.verifiedAt).not.toBeNull();
    expect(contact?.degradedAt).not.toBeNull();

    /* Customers keep a route through. */
    expect(await resolveSellerSupportContact(seller.participantId, { db })).toMatchObject({
      available: true,
      address: seller.email,
      source: "PRIMARY_PROFILE",
    });

    /* And the seller is NOT suspended: an address failing is a fact about a
       mailbox, not a governed decision about a participant. */
    const participant = await db.marketplaceParticipant.findUniqueOrThrow({
      where: { id: seller.participantId },
    });
    expect(participant.status).toBe("DRAFT");
  });

  it("losing every usable contact makes the seller transaction-ineligible", async () => {
    const seller = await seedSeller();
    await verifyPrimary(seller);
    const dedicated = `${EMAIL_PREFIX}support-${(seq += 1)}@example.invalid`;
    await verifyDedicated(seller, dedicated);

    await ingestProviderEmailEvent(hardBounce(dedicated, 31), after(10), { db, ids: outboundIds });
    await ingestProviderEmailEvent(hardBounce(seller.email, 32), after(20), {
      db,
      ids: outboundIds,
    });

    expect(await resolveSellerSupportContact(seller.participantId, { db })).toEqual({
      available: false,
      reason: "VERIFIED_ADDRESS_REQUIRES_REVERIFICATION",
    });

    /* The exact predicate `executable-checkout-service.ts` consults before
       creating an Order — a false here is SELLER_SUPPORT_CONTACT_UNAVAILABLE and
       no new commerce. Phase 1.3's rule, unchanged; 1.5 only supplies the signal
       that turns it. */
    expect(await hasUsableSupportContactIn(db, seller.participantId)).toBe(false);

    /* Still not suspended. Restoring a contact is the remedy. */
    expect(
      (await db.marketplaceParticipant.findUniqueOrThrow({ where: { id: seller.participantId } }))
        .status,
    ).toBe("DRAFT");
  });

  it("proving control of an address again lifts its suppression", async () => {
    const seller = await seedSeller();

    /* A link that was delivered BEFORE the bounce. That ordering is the only way
       a suppressed address is ever re-verified by email, and it is deliberate:
       once an address is suppressed nothing new is sent to it, so the documented
       remedy for a bounced contact is supplying a DIFFERENT address — `1.3`'s
       `SELLER_SUPPLIES_AND_VERIFIES_REPLACEMENT`. Direct proof of control that
       arrives anyway supersedes the provider's signal. */
    const token = await issuePrimaryToken(seller);
    await ingestProviderEmailEvent(hardBounce(seller.email, 41), after(1), {
      db,
      ids: outboundIds,
    });
    expect(await isAddressSuppressed(seller.email, { db })).toBe(true);

    /* Remediation is proving control, never the passage of time. */
    await consumeVerificationChallenge({ token, at: after(10) }, { db });

    expect(await isAddressSuppressed(seller.email, { db })).toBe(false);
    /* The row survives as the evidence of why it was ever suppressed. */
    expect((await getEmailSuppression(seller.email, { db }))?.liftedAt).not.toBeNull();
    expect(await resolveSellerSupportContact(seller.participantId, { db })).toMatchObject({
      available: true,
      source: "PRIMARY_PROFILE",
    });
  });
});

// ── 4 · the legacy Phase 1.1 delivery model ────────────────────────────────

/**
 * `NotificationDelivery` is **legacy and read-only**: superseded by
 * `OutboundEmailDelivery`, retained indefinitely for historical readability, and
 * written by nothing. These are behavioural guards — every one of them observes
 * what a real path actually persists, rather than scanning source for a name.
 */
describeIf("1.5 — the legacy Phase 1.1 delivery model", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterAll(async () => {
    if (RUN) {
      await cleanup();
      await disconnectPrisma();
    }
  });

  const legacyRowsFor = (ref: string) =>
    db.notificationDelivery.count({ where: { subjectRef: ref } });

  it("declares itself legacy, read-only, and retained", () => {
    /* A constant rather than a comment, so the decision cannot be quietly
       reversed by somebody adding a writer back without noticing. */
    expect(LEGACY_NOTIFICATION_DELIVERY).toEqual({
      status: "LEGACY_READ_ONLY",
      writesPermitted: false,
      supersededBy: "OutboundEmailDelivery",
      retention: "RETAINED_INDEFINITELY_FOR_HISTORICAL_READ",
      plannedDestructiveMigration: "NONE",
    });
  });

  it("an obligation-backed email writes the outbound model and no legacy row", async () => {
    const seller = await seedSeller();
    const orderRef = `mon:order:${nextSuffix()}`;
    const obligation = await createNotificationObligation(
      {
        recipientParticipantId: seller.participantId,
        category: "SALE_RECORDED",
        subject: { kind: "ORDER", ref: orderRef, versionRef: null },
        contextCode: null,
        createdAt: NOW,
      },
      { db, ids: participantIds },
    );

    await enqueueEmailDelivery(
      {
        purpose: "SALE_RECORDED",
        audience: "SELLER",
        recipientParticipantId: seller.participantId,
        obligationId: obligation.obligationId,
        subjectKind: "ORDER",
        subjectRef: orderRef,
        discriminator: null,
        now: NOW,
      },
      { db, ids: outboundIds },
    );
    await runEmailDispatchCycle({ now: NOW }, createCapturingMailAdapter(), ddeps());

    expect(
      await db.outboundEmailDelivery.count({ where: { subjectRef: orderRef } }),
    ).toBe(1);
    expect(await legacyRowsFor(orderRef)).toBe(0);
  });

  it("a verification email writes the outbound model and no legacy row", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);
    await runEmailDispatchCycle({ now: NOW }, createCapturingMailAdapter(), ddeps());

    const delivery = await getEmailDelivery(deliveryId, { db });
    expect(delivery?.status).toBe("DELIVERED");
    expect(await legacyRowsFor(delivery!.subjectRef)).toBe(0);
    expect(
      await db.notificationDelivery.count({
        where: { recipientParticipantId: seller.participantId },
      }),
    ).toBe(0);
  });

  it("a retry updates the outbound row and still writes no legacy row", async () => {
    const seller = await seedSeller();
    const deliveryId = await enqueueVerification(seller);
    const contactRef = (await getEmailDelivery(deliveryId, { db }))!.subjectRef;

    await runEmailDispatchCycle({ now: NOW }, refusingPort("PROVIDER_UNAVAILABLE"), ddeps());
    await runEmailDispatchCycle({ now: after(60) }, createCapturingMailAdapter(), ddeps());

    const delivery = await getEmailDelivery(deliveryId, { db });
    expect(delivery?.status).toBe("DELIVERED");
    expect(delivery?.attemptCount).toBe(2);
    /* Two attempts, one outbound row, and still nothing legacy. */
    expect(
      await db.outboundEmailDelivery.count({ where: { subjectRef: contactRef } }),
    ).toBe(1);
    expect(await legacyRowsFor(contactRef)).toBe(0);
  });

  it("keeps a pre-1.5 row readable", async () => {
    /* Planted directly, because there is no writer any more — which is the point.
       The read must still reconstruct a historical row into a valid record. */
    const orderRef = `mon:order:${nextSuffix()}`;
    await db.notificationDelivery.create({
      data: {
        id: `mon:ndlv:${nextSuffix()}`,
        obligationId: null,
        audience: "BUYER",
        recipientParticipantId: null,
        category: "ORDER_CONFIRMATION",
        subjectKind: "ORDER",
        subjectRef: orderRef,
        channel: "EMAIL",
        destinationDigest: destinationDigest("historical@example.invalid"),
        status: "ACCEPTED",
        providerMessageRef: "legacy-1",
        attemptedAt: new Date(NOW),
        acceptedAt: new Date(NOW),
        deliveryKey: `BUYER|~|ORDER_CONFIRMATION|ORDER|${orderRef}|EMAIL`,
      },
    });

    const [record] = await listDeliveriesForSubject({ kind: "ORDER", ref: orderRef }, { db });
    expect(record?.status).toBe("ACCEPTED");
    expect(record?.category).toBe("ORDER_CONFIRMATION");
    expect(record?.providerMessageRef).toBe("legacy-1");
    expect(await countDeliveriesIn(db, { kind: "ORDER", ref: orderRef })).toBe(1);

    /* And it stays where it is: nothing migrates, rewrites, or removes it. */
    expect(await legacyRowsFor(orderRef)).toBe(1);
  });
});
