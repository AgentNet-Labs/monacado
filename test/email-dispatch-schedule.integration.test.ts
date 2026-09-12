/**
 * Phase 1.27 — the scheduled dispatch trigger.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 *
 * ## What is genuinely new here, and what is deliberately not re-tested
 *
 * Phase 1.5's suite already proves the delivery engine end to end: that a
 * transient refusal schedules a retry at the right instant, that a not-yet-due
 * row is not claimed, that a permanent rejection never retries, that attempts are
 * bounded at five, and that claims are leased. **None of that is repeated.**
 * `outbound-email-contracts.test.ts` likewise already proves the *operator*
 * endpoint's bearer gate.
 *
 * Two things had no coverage because they did not exist until this phase:
 *
 *   1. the scheduled trigger's own gate — a second entry point to the dispatcher,
 *      reachable by `GET`, which must be exactly as closed as the first;
 *   2. that the trigger actually **delegates** rather than reimplementing —
 *      it must retry a delivery that MySQL says is due, and must not touch one
 *      that MySQL says is not.
 *
 * The second is proved on an **account verification** message specifically,
 * because that is the delivery whose failure now costs somebody their ability to
 * sign in. The case runs the whole consequence: transient failure → RETRY_PENDING
 * → trigger → DELIVERED → consume the token → sign in.
 *
 * NO NETWORK. Mail is captured or refused through injected ports.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  MailPort,
  MailResult,
} from "../src/contracts/marketplace/notification-delivery";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import {
  EMAIL_DISPATCH_SCHEDULE_GUIDANCE,
  EMAIL_DISPATCH_SCHEDULED_PATH,
  handleScheduledDispatchRequest,
  isAuthorizedScheduledDispatch,
  SCHEDULER_SECRET_ENV_DEFAULT,
} from "../src/server/notifications/email-dispatch-schedule-route-handler";
import { getEmailDelivery } from "../src/server/notifications/outbound-email-service";
import { createCapturingMailAdapter } from "../src/server/notifications/mail-port";
import { handleSignUpRequest } from "../src/server/account/sign-up-route-handler";
import { handleSignInRequest } from "../src/server/account/sign-in-route-handler";
import { handleAccountVerifyEmailRequest } from "../src/server/account/account-verification-route-handler";
import { createFakeSignInThrottle } from "./support/sign-in-throttle-fake";
import { createFakeSignUpThrottle } from "./support/sign-up-throttle-fake";
import { VERIFY_ACCOUNT_EMAIL_PATH } from "../src/server/account/account-verification-notice";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-11-01T09:00:00.000Z";
const ORIGIN = "https://monacado.test";
const EMAIL_PREFIX = "p127sched";
const PASSWORD = "a-correct-horse-battery";
const SECRET = "a-scheduler-secret-for-tests-only";

const after = (seconds: number) =>
  new Date(Date.parse(NOW) + seconds * 1000).toISOString();

let seq = 0;
let signInThrottle = createFakeSignInThrottle();
let signUpThrottle = createFakeSignUpThrottle();

/** A port that refuses with one bounded code, so a class can be exercised. */
const refusingPort = (): MailPort & { calls: number } => {
  const port = {
    calls: 0,
    async send(): Promise<MailResult> {
      port.calls += 1;
      return { outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" };
    },
  };
  return port;
};

async function cleanup(): Promise<void> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) return;
  await db.accountEmailVerificationChallenge.deleteMany({ where: { accountId: { in: ids } } });
  await db.outboundEmailDelivery.deleteMany({ where: { subjectRef: { in: ids } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: ids } } });
  await db.account.deleteMany({ where: { id: { in: ids } } });
}

const nextEmail = () => {
  seq += 1;
  return `${EMAIL_PREFIX}${seq}@example.com`;
};

/** Register through the real route, with the provider refusing every send. */
async function registerWithFailingMail(email: string, port: MailPort) {
  const result = await handleSignUpRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      rawBody: JSON.stringify({ name: "Scheduled Person", email, password: PASSWORD }),
    },
    {
      db,
      appOrigin: ORIGIN,
      now: () => NOW,
      throttle: signUpThrottle,
      mailPort: port,
      verificationOrigin: ORIGIN,
    },
  );
  expect(result.status).toBe(200);
  const account = await db.account.findUniqueOrThrow({
    where: { normalizedEmail: email.toLowerCase() },
  });
  return account;
}

/** Fire the trigger exactly as the platform would: GET, bearer secret. */
const trigger = (at: string, port?: MailPort, authorization = `Bearer ${SECRET}`) =>
  handleScheduledDispatchRequest(
    { authorizationHeader: authorization, limitParam: null, now: at },
    {
      db,
      origin: ORIGIN,
      providerName: "CAPTURE",
      env: { [SCHEDULER_SECRET_ENV_DEFAULT]: SECRET },
      ...(port !== undefined ? { port } : {}),
    },
  );

const describeDb = RUN ? describe : describe.skip;

describeDb("1.27 — scheduled dispatch trigger", () => {
  beforeEach(async () => {
    signInThrottle = createFakeSignInThrottle();
    signUpThrottle = createFakeSignUpThrottle();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("states the cadence and records that it is committed as a Vercel Cron", () => {
    /* Minute-level Vercel Cron needs a paid plan. That was unknown when this
       phase began and is now settled — Monacado's Vercel account is Pro — so the
       five-minute schedule is declared in `vercel.json`. The file's exact
       contents are pinned in `tax-recording-operations.test.ts`, which is where
       the repository's "which crons exist" assertion already lived.

       Daily would not have been acceptable: a person who hit one transient
       provider error would wait up to a day to be allowed to sign in. */
    expect(EMAIL_DISPATCH_SCHEDULE_GUIDANCE.recommendedCron).toBe("*/5 * * * *");
    expect(EMAIL_DISPATCH_SCHEDULE_GUIDANCE.recommendedIntervalSeconds).toBe(300);
    expect(EMAIL_DISPATCH_SCHEDULE_GUIDANCE.vercelMinuteLevelCronRequiresPlan).toBe(
      "PRO_OR_ENTERPRISE",
    );
    expect(EMAIL_DISPATCH_SCHEDULE_GUIDANCE.dailyCadenceAdequate).toBe(false);
    expect(EMAIL_DISPATCH_SCHEDULE_GUIDANCE.externalSchedulerAcceptable).toBe(true);
    expect(EMAIL_DISPATCH_SCHEDULE_GUIDANCE.committedCronDeclaration).toBe("VERCEL_JSON");
    expect(EMAIL_DISPATCH_SCHEDULE_GUIDANCE.productionPrerequisite).toBe(true);

    /* The path is named once and is the one the route actually serves. */
    expect(EMAIL_DISPATCH_SCHEDULED_PATH).toBe(
      "/api/internal/operations/email-dispatcher/scheduled",
    );
    expect(EMAIL_DISPATCH_SCHEDULE_GUIDANCE.path).toBe(EMAIL_DISPATCH_SCHEDULED_PATH);
  });

  it("refuses every unauthorized invocation, and runs no cycle when it does", async () => {
    /* A second entry point to the dispatcher is a second thing that can be left
       open. It must be exactly as closed as the first, and — the part a pure
       auth-predicate test cannot show — a refusal must not have dispatched
       anything on its way to answering 401. */
    const env = { [SCHEDULER_SECRET_ENV_DEFAULT]: SECRET };

    expect(isAuthorizedScheduledDispatch(`Bearer ${SECRET}`, env)).toBe(true);
    for (const header of [
      null,
      "",
      SECRET /* no scheme */,
      "Bearer",
      "Bearer ",
      "Bearer wrong-secret",
      `Basic ${SECRET}`,
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(0, -1)}`,
    ]) {
      expect(`${JSON.stringify(header)} -> ${isAuthorizedScheduledDispatch(header, env)}`).toBe(
        `${JSON.stringify(header)} -> false`,
      );
    }

    /* Unconfigured is closed, never permissive. This is the deployment mistake
       that must fail shut: a missing variable must not mean "anyone may drain
       the queue". */
    expect(isAuthorizedScheduledDispatch(`Bearer ${SECRET}`, {})).toBe(false);
    expect(isAuthorizedScheduledDispatch("Bearer ", {})).toBe(false);

    /* And the whole route refuses without sending. A delivery that is genuinely
       due sits untouched behind an unauthorized call. */
    const email = nextEmail();
    const failing = refusingPort();
    const account = await registerWithFailingMail(email, failing);
    const before = await db.outboundEmailDelivery.findFirstOrThrow({
      where: { subjectRef: account.id },
    });
    expect(before.status).toBe("RETRY_PENDING");

    const port = createCapturingMailAdapter();
    const refused = await trigger(after(3600), port, "Bearer wrong-secret");
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "UNAUTHORIZED" });
    /* Nothing was sent and nothing was claimed. */
    expect(port.sent).toHaveLength(0);
    const untouched = await db.outboundEmailDelivery.findFirstOrThrow({
      where: { subjectRef: account.id },
    });
    expect(untouched.attemptCount).toBe(before.attemptCount);
    expect(untouched.status).toBe("RETRY_PENDING");
  });

  it("retries a due verification email and lets the account sign in, without forcing an undue one", async () => {
    /* The consequence this phase exists to close. Account verification made mail
       load-bearing for authentication: before this trigger, a verification
       message that hit one transient provider error sat in RETRY_PENDING forever
       and its owner could never sign in, because nothing would ever try again. */
    const email = nextEmail();
    const failing = refusingPort();
    const account = await registerWithFailingMail(email, failing);

    /* The provider refused, so the durable row records a scheduled retry. The
       exact backoff arithmetic is Phase 1.5's and is not re-asserted here. */
    expect(failing.calls).toBe(1);
    const scheduled = await db.outboundEmailDelivery.findFirstOrThrow({
      where: { subjectRef: account.id },
    });
    expect(scheduled.status).toBe("RETRY_PENDING");
    expect(scheduled.attemptCount).toBe(1);
    expect(scheduled.nextAttemptAt).not.toBeNull();

    /* The account is unverified and cannot sign in — the state a person is
       stranded in if nothing retries. */
    expect(account.emailVerifiedAt).toBeNull();

    /* A tick BEFORE the row is due must not send. The trigger supplies an
       instant and nothing else; eligibility is MySQL's decision, read from
       `status` and `nextAttemptAt`. If the route forced a send, this would
       deliver and the backoff would be decorative. */
    const tooSoon = createCapturingMailAdapter();
    const early = await trigger(NOW, tooSoon);
    expect(early.status).toBe(200);
    expect(early.body).toMatchObject({ ran: true, claimed: 0, delivered: 0 });
    expect(tooSoon.sent).toHaveLength(0);
    expect(
      (await db.outboundEmailDelivery.findFirstOrThrow({ where: { subjectRef: account.id } }))
        .status,
    ).toBe("RETRY_PENDING");

    /* A tick AFTER it is due delivers it, through the existing dispatcher. */
    const port = createCapturingMailAdapter();
    const due = await trigger(after(3600), port);
    expect(due.status).toBe(200);
    expect(due.body).toMatchObject({ ran: true, delivered: 1 });

    const delivered = await getEmailDelivery(scheduled.id, { db });
    expect(delivered?.status).toBe("DELIVERED");
    expect(delivered?.attemptCount).toBe(2);

    /* The retry carried a real, usable link — the message is re-rendered and the
       challenge minted at send time, so a retry is not a stale copy of a first
       attempt that never went out. */
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.to).toBe(email);
    const url = new URL(port.sent[0]!.text.match(/https?:\/\/\S+/)![0]);
    expect(url.pathname).toBe(VERIFY_ACCOUNT_EMAIL_PATH);

    /* And the whole point: consuming it verifies the account, and the person can
       now sign in. */
    expect(
      await handleAccountVerifyEmailRequest(
        { token: url.searchParams.get("token"), at: after(3601) },
        { db },
      ),
    ).toEqual({ outcome: "VERIFIED" });

    const signedIn = await handleSignInRequest(
      {
        contentType: "application/json",
        originHeader: ORIGIN,
        rawBody: JSON.stringify({ email, password: PASSWORD }),
      },
      { db, appOrigin: ORIGIN, now: () => after(3601), throttle: signInThrottle },
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers["set-cookie"]).toContain("monacado_session=");

    /* A second tick finds nothing left to do: delivery is terminal, so the
       schedule firing forever costs one empty query rather than a duplicate
       message. */
    const idle = createCapturingMailAdapter();
    const again = await trigger(after(7200), idle);
    expect(again.body).toMatchObject({ claimed: 0, delivered: 0 });
    expect(idle.sent).toHaveLength(0);
  });
});
