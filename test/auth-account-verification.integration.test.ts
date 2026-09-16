/**
 * Phase 1.27 — account email verification, end to end.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 *
 * ## What this suite proves
 *
 * The gate this phase exists to install, and the things that would quietly
 * defeat it:
 *
 *   1. public sign-up creates an account that CANNOT sign in;
 *   2. the verification mail really goes out, through the real outbox and the
 *      real `MailPort`, carrying a link and no identifiers;
 *   3. consuming that link verifies exactly that account, once;
 *   4. and only then does sign-in work.
 *
 * Plus the two failure modes that matter: a token cannot be used twice, and a
 * token cannot verify an account it was not issued for.
 *
 * Not re-proved here: token cryptography in general (the participant verifier's
 * suite covers digest-only storage and single-use for its own table), Argon2id
 * hashing, sign-in credential semantics, or throttle mechanics — which
 * `auth-throttle-domain-separation.test.ts` covers without a database.
 *
 * NO NETWORK. Mail is captured through `createCapturingMailAdapter`.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { handleSignUpRequest } from "../src/server/account/sign-up-route-handler";
import { handleSignInRequest } from "../src/server/account/sign-in-route-handler";
import { handleAccountVerifyEmailRequest } from "../src/server/account/account-verification-route-handler";
import { createAccount } from "../src/server/account/account-service";
import { createCapturingMailAdapter } from "../src/server/notifications/mail-port";
import { CLAIMABLE_DELIVERY_STATUSES } from "../src/contracts/marketplace/outbound-email";
import { createFakeSignInThrottle } from "./support/sign-in-throttle-fake";
import { createFakeSignUpThrottle } from "./support/sign-up-throttle-fake";
import { VERIFY_ACCOUNT_EMAIL_PATH } from "../src/server/account/account-verification-notice";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-10-01T09:00:00.000Z";
const ORIGIN = "https://monacado.test";
const EMAIL_PREFIX = "p127verify";
const PASSWORD = "a-correct-horse-battery";

let seq = 0;
let signInThrottle = createFakeSignInThrottle();
let signUpThrottle = createFakeSignUpThrottle();

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
  await db.accountEntitlement.deleteMany({ where: { accountId: { in: ids } } });
  await db.account.deleteMany({ where: { id: { in: ids } } });
}

const nextEmail = () => {
  seq += 1;
  return `${EMAIL_PREFIX}${seq}@example.com`;
};

/** Register through the real route, capturing the mail instead of sending it. */
async function signUp(
  email: string,
  port = createCapturingMailAdapter(),
  name = "Verify Person",
) {
  const result = await handleSignUpRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      rawBody: JSON.stringify({ name, email, password: PASSWORD }),
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
  return { result, port };
}

const signIn = (email: string, password = PASSWORD) =>
  handleSignInRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      rawBody: JSON.stringify({ email, password }),
    },
    { db, appOrigin: ORIGIN, now: () => NOW, throttle: signInThrottle },
  );

/** Pull the opaque token out of a captured verification link. */
function tokenFrom(text: string): string {
  const match = text.match(/https?:\/\/\S+/);
  expect(match).not.toBeNull();
  const url = new URL(match![0]);
  expect(url.pathname).toBe(VERIFY_ACCOUNT_EMAIL_PATH);
  const token = url.searchParams.get("token");
  expect(token).not.toBeNull();
  return token!;
}

const describeDb = RUN ? describe : describe.skip;

describeDb("1.27 — account email verification", () => {
  beforeEach(async () => {
    signInThrottle = createFakeSignInThrottle();
    signUpThrottle = createFakeSignUpThrottle();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("registers unverified, ADMITS sign-in, and proves the address when the link is used", async () => {
    /* The whole phase in one case, because the value is in the ORDER: each step
       must be false before the previous one happens and true after.

       The correction changes ONE step of this sequence and nothing else. An
       unverified account now signs in — that is the friction being removed. What
       verification still governs is proved separately, at the Storefront gate,
       in `storefront-persistence.integration.test.ts`. */
    const email = nextEmail();
    const { port } = await signUp(email);

    const account = await db.account.findUnique({
      where: { normalizedEmail: email.toLowerCase() },
    });
    expect(account).not.toBeNull();

    /* ACTIVE, but unproved. Status and verification are separate facts — this
       phase deliberately added no third status to mean "unverified". */
    expect(account!.status).toBe("ACTIVE");
    expect(account!.emailVerifiedAt).toBeNull();
    expect(account!.emailVerifiedVia).toBeNull();

    /* NOT a gate any more. The account has proved nothing about its address and
       is admitted anyway, with a real session cookie, because signing in is how
       a Seller reaches the onboarding work that exposes nothing to a buyer.

       This is the assertion the correction inverts: it read 401 /
       INVALID_CREDENTIALS before. */
    const before = await signIn(email);
    expect(before.status).toBe(200);
    expect(before.headers["set-cookie"]).toContain("monacado_session=");

    /* And the admission did not quietly verify anything on the way through. */
    expect(
      (await db.account.findUnique({ where: { id: account!.id } }))!.emailVerifiedAt,
    ).toBeNull();

    /* The mail actually went out, through the real outbox and the real port. */
    expect(port.sent).toHaveLength(1);
    const message = port.sent[0]!;
    expect(message.to).toBe(email);

    /* It names nobody. A person who receives this because a stranger typed their
       address learns only that Monacado exists. */
    expect(message.text).not.toContain(account!.id);
    expect(message.text).not.toContain("Verify Person");
    expect(message.subject).not.toContain(email);

    const token = tokenFrom(message.text);

    /* Only the digest is persisted — the link in the inbox is the only copy of
       the token, and a dump of this table yields nothing that works. */
    const challenge = await db.accountEmailVerificationChallenge.findFirst({
      where: { accountId: account!.id },
    });
    expect(challenge).not.toBeNull();
    expect(challenge!.state).toBe("PENDING");
    expect(challenge!.tokenDigest).not.toBe(token);
    expect(JSON.stringify(challenge)).not.toContain(token);

    /* Consume it. */
    expect(await handleAccountVerifyEmailRequest({ token, at: NOW }, { db })).toEqual({
      outcome: "VERIFIED",
    });

    const verified = await db.account.findUnique({ where: { id: account!.id } });
    expect(verified!.emailVerifiedAt).not.toBeNull();
    /* Provenance records that this was PROVED, not vouched for or grandfathered. */
    expect(verified!.emailVerifiedVia).toBe("SELF_SERVICE_TOKEN");

    /* Single use. The second attempt is distinguished only as ALREADY_USED,
       which discloses nothing to somebody who already held the token. */
    expect(await handleAccountVerifyEmailRequest({ token, at: NOW }, { db })).toEqual({
      outcome: "ALREADY_USED",
    });
    expect(
      (await db.accountEmailVerificationChallenge.findUnique({ where: { id: challenge!.id } }))!
        .state,
    ).toBe("CONSUMED");

    /* Sign-in still works afterwards, and is unchanged by verification — the
       door was never locked, so consuming the link neither opens nor closes it. */
    const after = await signIn(email);
    expect(after.status).toBe(200);
    expect(after.headers["set-cookie"]).toContain("monacado_session=");
  });

  it("still registers when the mail transport refuses, and leaves the message retryable", async () => {
    /* The correction's other half: the immediate send is an OPTIMISATION over a
       durable commitment, so a provider outage must not reach the person who
       just registered.

       `createCapturingMailAdapter` with a REFUSED result is the whole fault
       injection — the route is given a port that behaves exactly as SMTP does
       when Google is unreachable. No transport is stubbed, no timer is faked,
       and no retry framework is exercised. */
    const email = nextEmail();
    const failing = createCapturingMailAdapter({
      result: { outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" },
    });
    const { result } = await signUp(email, failing);

    /* Registration SUCCEEDED, with the byte-identical bounded body a working
       transport produces. Nothing names mail, SMTP, a provider, or a failure. */
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ registered: true });
    expect(JSON.stringify(result.body)).not.toMatch(/mail|smtp|provider|unavailable/i);

    /* The account is real and usable — this is the state that used to be a dead
       end, because an account that could not sign in and whose link never
       arrived had no way forward at all. */
    const account = await db.account.findUnique({
      where: { normalizedEmail: email.toLowerCase() },
    });
    expect(account).not.toBeNull();
    expect(account!.status).toBe("ACTIVE");
    expect(account!.emailVerifiedAt).toBeNull();
    expect((await signIn(email)).status).toBe(200);

    /* The attempt genuinely happened — the port was called — and the durable row
       survived it in a state the EXISTING dispatcher will pick up again. No new
       queue, no new scheduler: `RETRY_PENDING` is a member of the
       `CLAIMABLE_DELIVERY_STATUSES` this repository already had. */
    expect(failing.sent).toHaveLength(1);
    const delivery = await db.outboundEmailDelivery.findFirst({
      where: { subjectRef: account!.id },
    });
    expect(delivery).not.toBeNull();
    expect(CLAIMABLE_DELIVERY_STATUSES).toContain(delivery!.status);
  });

  it("refuses a token that is absent, malformed, expired, superseded, or for another account", async () => {
    /* Every one of these is the SAME answer. Separating "expired" from "never
       existed" would tell a caller which of their guesses was once real. */
    for (const token of [null, "", "short", "!".repeat(43), "a".repeat(42)]) {
      expect(await handleAccountVerifyEmailRequest({ token, at: NOW }, { db })).toEqual({
        outcome: "NOT_VALID",
      });
    }

    /* A well-formed token that was never issued. */
    expect(
      await handleAccountVerifyEmailRequest({ token: "A".repeat(43), at: NOW }, { db }),
    ).toEqual({ outcome: "NOT_VALID" });

    /* Supersession: asking for a second link kills the first. Without this, a
       link somebody abandoned still verifies their account. */
    const email = nextEmail();
    const first = await signUp(email);
    const firstToken = tokenFrom(first.port.sent[0]!.text);

    const second = await signUp(email, createCapturingMailAdapter());
    /* The duplicate branch reissued rather than doing nothing — the resend path
       a person whose mail was lost depends on. */
    expect(second.port.sent).toHaveLength(1);
    const secondToken = tokenFrom(second.port.sent[0]!.text);
    expect(secondToken).not.toBe(firstToken);

    expect(await handleAccountVerifyEmailRequest({ token: firstToken, at: NOW }, { db })).toEqual({
      outcome: "NOT_VALID",
    });
    /* The live one still works, so what died was the old link and not the account. */
    expect(await handleAccountVerifyEmailRequest({ token: secondToken, at: NOW }, { db })).toEqual({
      outcome: "VERIFIED",
    });

    /* Expiry, driven by the clock rather than by editing a row. */
    const other = nextEmail();
    const third = await signUp(other);
    const expiring = tokenFrom(third.port.sent[0]!.text);
    const wayLater = new Date(Date.parse(NOW) + 25 * 60 * 60 * 1000).toISOString();
    expect(
      await handleAccountVerifyEmailRequest({ token: expiring, at: wayLater }, { db }),
    ).toEqual({ outcome: "NOT_VALID" });
    /* And the account it belonged to is still unverified, so an expired link did
       not half-verify anything. */
    expect(
      (await db.account.findUnique({ where: { normalizedEmail: other.toLowerCase() } }))!
        .emailVerifiedAt,
    ).toBeNull();
  });

  it("does not send to an already-verified address, and administrative accounts need no link", async () => {
    /* The reissue path must not become a way to mail somebody who is done. This
       is also what keeps the duplicate branch from being an enumeration signal:
       the route calls the delivery function unconditionally and the RESOLVER
       declines, so the route itself never reads verification state to decide. */
    const email = nextEmail();
    const first = await signUp(email);
    const token = tokenFrom(first.port.sent[0]!.text);
    expect(await handleAccountVerifyEmailRequest({ token, at: NOW }, { db })).toEqual({
      outcome: "VERIFIED",
    });

    const again = await signUp(email, createCapturingMailAdapter());
    /* Same uniform success to the caller… */
    expect(again.result.status).toBe(200);
    expect(again.result.body).toEqual({ registered: true });
    /* …and no mail, because there is nothing left to prove. */
    expect(again.port.sent).toHaveLength(0);

    /* Administrative creation is explicit and needs no challenge: `db:check` and
       every fixture that signs in uses this, and it records that somebody
       vouched rather than that the address was proved. */
    const adminEmail = nextEmail();
    const admin = await createAccount(
      {
        name: "Operator Made",
        email: adminEmail,
        password: PASSWORD,
        createdAt: NOW,
        emailVerification: "ADMINISTRATIVE",
      },
      { db },
    );
    expect(admin.emailVerifiedVia).toBe("ADMINISTRATIVE");
    expect((await signIn(adminEmail)).status).toBe(200);
    expect(
      await db.accountEmailVerificationChallenge.count({ where: { accountId: admin.accountId } }),
    ).toBe(0);
  });
});
