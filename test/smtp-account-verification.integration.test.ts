/**
 * Phase 1.27 correction — account verification through Google Workspace SMTP's
 * adapter, end to end, against a loopback SMTP server.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 *
 * ## What is new here
 *
 * `email-dispatch-schedule.integration.test.ts` already proves the consequence
 * chain — transient refusal → RETRY_PENDING → scheduled trigger → DELIVERED →
 * verify → sign in — with injected ports. **None of its assertions about the
 * trigger or the retry policy are repeated.** What this suite adds is that the
 * same chain holds when the port is the real one a deployment resolves:
 * `MONACADO_MAIL_TRANSPORT=SMTP`, the real Nodemailer client, real SMTP AUTH, a
 * real `421` on the wire, and the scheduled trigger resolving the SMTP adapter
 * and its provider name from configuration alone.
 *
 * NO NETWORK beyond 127.0.0.1. The SMTP server is in-process and relays nothing;
 * no message can reach Google or any inbox.
 */

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { handleSignUpRequest } from "../src/server/account/sign-up-route-handler";
import { handleSignInRequest } from "../src/server/account/sign-in-route-handler";
import { handleSignOutRequest } from "../src/server/account/sign-out-route-handler";
import { handleAccountVerifyEmailRequest } from "../src/server/account/account-verification-route-handler";
import { VERIFY_ACCOUNT_EMAIL_PATH } from "../src/server/account/account-verification-notice";
import {
  handleScheduledDispatchRequest,
  SCHEDULER_SECRET_ENV_DEFAULT,
} from "../src/server/notifications/email-dispatch-schedule-route-handler";
import { resolveMailPort } from "../src/server/notifications/mail-port";
import { createFakeSignInThrottle } from "./support/sign-in-throttle-fake";
import { createFakeSignUpThrottle } from "./support/sign-up-throttle-fake";
import {
  smtpHeader,
  smtpTextBody,
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "./support/fake-smtp-server";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-12-01T09:00:00.000Z";
const ORIGIN = "https://monacado.test";
const EMAIL_PREFIX = "p127smtp";
const PASSWORD = "a-correct-horse-battery";
const SMTP_USERNAME = "notifications@monacado.test";
const SMTP_PASSWORD = "loopback-smtp-password-not-real";
const SCHEDULER_SECRET = "a-scheduler-secret-for-tests-only";

const after = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

let server: FakeSmtpServer;

/** Configuration exactly as a deployment states it — only the host is loopback. */
const deploymentEnv = (): Record<string, string> => ({
  MONACADO_MAIL_ENABLED: "true",
  MONACADO_MAIL_TRANSPORT: "SMTP",
  MONACADO_SMTP_HOST: server.host,
  MONACADO_SMTP_PORT: String(server.port),
  MONACADO_SMTP_REQUIRE_TLS: "false",
  MONACADO_SMTP_USERNAME: SMTP_USERNAME,
  MONACADO_SMTP_PASSWORD: SMTP_PASSWORD,
  MONACADO_MAIL_FROM_ADDRESS: SMTP_USERNAME,
  MONACADO_MAIL_FROM_NAME: "Monacado",
  MONACADO_MAIL_REPLY_TO: "support@monacado.test",
  MONACADO_SMTP_CONNECTION_TIMEOUT_MS: "5000",
  MONACADO_SMTP_SOCKET_TIMEOUT_MS: "5000",
  MONACADO_SMTP_SEND_TIMEOUT_MS: "5000",
  [SCHEDULER_SECRET_ENV_DEFAULT]: SCHEDULER_SECRET,
});

async function probeAccountIds(): Promise<string[]> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  return accounts.map((a) => a.id);
}

async function cleanup(): Promise<void> {
  const ids = await probeAccountIds();
  if (ids.length === 0) return;
  await db.accountEmailVerificationChallenge.deleteMany({ where: { accountId: { in: ids } } });
  await db.outboundEmailDelivery.deleteMany({ where: { subjectRef: { in: ids } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: ids } } });
  await db.accountEntitlement.deleteMany({ where: { accountId: { in: ids } } });
  await db.account.deleteMany({ where: { id: { in: ids } } });
}

const describeDb = RUN ? describe : describe.skip;

describeDb("1.27 correction — verification mail through the SMTP adapter", () => {
  beforeAll(async () => {
    server = await startFakeSmtpServer({ username: SMTP_USERNAME, password: SMTP_PASSWORD });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    expect(await probeAccountIds()).toEqual([]);
    await server?.close();
    await disconnectPrisma();
  });

  it("registers, survives a transient SMTP failure, retries on schedule, verifies, signs in and out", async () => {
    const env = deploymentEnv();
    const email = `${EMAIL_PREFIX}1@example.com`;
    const signInThrottle = createFakeSignInThrottle();

    /* The provider is briefly unavailable: Google answers MAIL FROM with a 421. */
    server.failNext("MAIL", "421 4.7.0 Temporary System Problem. Try again later.");

    // 1. Self-service registration, through the real route, with the port a
    //    deployment configured for SMTP resolves.
    const signedUp = await handleSignUpRequest(
      {
        contentType: "application/json",
        originHeader: ORIGIN,
        rawBody: JSON.stringify({ name: "Smtp Person", email, password: PASSWORD }),
      },
      {
        db,
        appOrigin: ORIGIN,
        now: () => NOW,
        throttle: createFakeSignUpThrottle(),
        mailPort: resolveMailPort(env),
        verificationOrigin: ORIGIN,
      },
    );
    expect(signedUp.status).toBe(200);
    const account = await db.account.findUniqueOrThrow({ where: { normalizedEmail: email } });
    expect(account.emailVerifiedAt).toBeNull();

    // 2–4. The email was enqueued, the adapter really authenticated and spoke
    //      SMTP, the 421 refused it, and MySQL holds a scheduled retry.
    expect(server.authentications.accepted).toBe(1);
    expect(server.messages).toHaveLength(0);
    const pending = await db.outboundEmailDelivery.findFirstOrThrow({
      where: { subjectRef: account.id },
    });
    expect(pending).toMatchObject({
      subjectKind: "ACCOUNT_EMAIL",
      audience: "ACCOUNT",
      status: "RETRY_PENDING",
      attemptCount: 1,
      lastFailureCode: "PROVIDER_UNAVAILABLE",
      lastFailureClass: "TRANSIENT",
    });
    expect(pending.nextAttemptAt).not.toBeNull();

    /* Unverified signs in anyway — and this is the case that shows WHY the
       correction matters. The transport just failed, so the link is not in
       anybody's inbox yet; under the original rule this person was locked out of
       an account that genuinely exists, through no fault of their own, until a
       retry succeeded. */
    const admitted = await handleSignInRequest(
      {
        contentType: "application/json",
        originHeader: ORIGIN,
        rawBody: JSON.stringify({ email, password: PASSWORD }),
      },
      { db, appOrigin: ORIGIN, now: () => NOW, throttle: signInThrottle },
    );
    expect(admitted.status).toBe(200);

    // 5–6. The scheduled trigger, given configuration and no port, resolves the
    //      SMTP adapter itself and delivers the now-due row.
    const tick = await handleScheduledDispatchRequest(
      {
        authorizationHeader: `Bearer ${SCHEDULER_SECRET}`,
        limitParam: null,
        now: after(3600),
      },
      { db, origin: ORIGIN, env },
    );
    expect(tick.status).toBe(200);
    expect(tick.body).toMatchObject({ ran: true, claimed: 1, delivered: 1 });

    const delivered = await db.outboundEmailDelivery.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(delivered).toMatchObject({ status: "DELIVERED", attemptCount: 2, provider: "SMTP" });
    expect(delivered.providerMessageRef).toMatch(/^<.+@monacado\.test>$/);

    /* What reached the SMTP server: one authenticated plain-text submission to
       exactly this address, from the configured sender. */
    expect(server.authentications.accepted).toBe(2);
    expect(server.messages).toHaveLength(1);
    const [submitted] = server.messages;
    expect(submitted!.rcptTo).toEqual([`<${email}>`]);
    expect(smtpHeader(submitted!.data, "From")).toBe(`Monacado <${SMTP_USERNAME}>`);
    expect(smtpHeader(submitted!.data, "Reply-To")).toBe("support@monacado.test");
    expect(smtpHeader(submitted!.data, "Content-Type")).toMatch(/^text\/plain/);

    // 7. The link in the message that actually went out verifies the account.
    const link = smtpTextBody(submitted!.data).match(/https?:\/\/\S+/);
    expect(link).not.toBeNull();
    const url = new URL(link![0]);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(VERIFY_ACCOUNT_EMAIL_PATH);
    expect(
      await handleAccountVerifyEmailRequest(
        { token: url.searchParams.get("token"), at: after(3601) },
        { db },
      ),
    ).toEqual({ outcome: "VERIFIED" });
    expect(
      (await db.account.findUniqueOrThrow({ where: { id: account.id } })).emailVerifiedAt,
    ).not.toBeNull();

    // 8. The account signs in.
    const signedIn = await handleSignInRequest(
      {
        contentType: "application/json",
        originHeader: ORIGIN,
        rawBody: JSON.stringify({ email, password: PASSWORD }),
      },
      { db, appOrigin: ORIGIN, now: () => after(3602), throttle: signInThrottle },
    );
    expect(signedIn.status).toBe(200);
    const cookie = /monacado_session=[^;]+/.exec(signedIn.headers["set-cookie"] ?? "");
    expect(cookie).not.toBeNull();

    // 9. And signs out: the session is revoked and the cookie cleared.
    const signedOut = await handleSignOutRequest(
      { originHeader: ORIGIN, cookieHeader: cookie![0] },
      { db, appOrigin: ORIGIN, now: () => after(3603) },
    );
    expect(signedOut.status).toBe(200);
    expect(signedOut.body).toEqual({ signedOut: true });
    /* TWO sessions exist, not one: the pre-verification sign-in at step 4 is now
       admitted and issues a real session, which is the point of the correction.
       Sign-out revokes the session whose cookie was presented and leaves the
       other alone — revoking every session of an account because one of them
       signed out would be a different, wrong behaviour. */
    const sessions = await db.accountSession.findMany({ where: { accountId: account.id } });
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((row) => row.revokedAt !== null)).toHaveLength(1);

    /* A later tick has nothing left to send. */
    const idle = await handleScheduledDispatchRequest(
      { authorizationHeader: `Bearer ${SCHEDULER_SECRET}`, limitParam: null, now: after(7200) },
      { db, origin: ORIGIN, env },
    );
    expect(idle.body).toMatchObject({ claimed: 0, delivered: 0 });
    expect(server.messages).toHaveLength(1);

    // 10. Probe data is removed in afterAll, and its absence asserted there.
  });
});
