/**
 * Phase 1.27 — public account registration, end to end.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 *
 * ## What this suite is for
 *
 * Three guarantees that did not exist before this phase and that nothing else
 * proves:
 *
 *   1. the loop closes — an address that has never been seen can register here
 *      and then sign in through Phase 1.22 with the password it chose;
 *   2. registering an address that already has an account is **indistinguishable**
 *      from registering a fresh one, and leaves the existing account untouched;
 *   3. registration creates an Account and nothing else — no session, and nothing
 *      marketplace-shaped.
 *
 * Not re-proved here: Argon2id hashing and the `normalizedEmail` unique index
 * (`account-identity`), sign-in credential semantics (Phase 1.22), the attempt
 * budget (Phase 1.23), sign-out (Phase 1.24), or page-guard resolution
 * (Phase 1.25). This suite asserts only that registration inherits them.
 *
 * NO NETWORK. The route handlers take plain header values.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { handleSignUpRequest } from "../src/server/account/sign-up-route-handler";
import { handleSignInRequest } from "../src/server/account/sign-in-route-handler";
import { handleAccountVerifyEmailRequest } from "../src/server/account/account-verification-route-handler";
import { resolvePageSession } from "../src/server/account/page-session";
import { createCapturingMailAdapter } from "../src/server/notifications/mail-port";
import { createFakeSignInThrottle } from "./support/sign-in-throttle-fake";
import { createFakeSignUpThrottle } from "./support/sign-up-throttle-fake";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-09-01T09:00:00.000Z";
const ORIGIN = "https://monacado.test";
const EMAIL_PREFIX = "p127signup";
const PASSWORD = "a-correct-horse-battery";

let seq = 0;
let throttle = createFakeSignInThrottle();
let signUpThrottle = createFakeSignUpThrottle();
/* Phase 1.27: registration now sends mail, so every call captures it rather
   than letting the route resolve a real transport. */
let mailPort = createCapturingMailAdapter();

async function cleanup(): Promise<void> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return;
  await db.accountEmailVerificationChallenge.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  await db.outboundEmailDelivery.deleteMany({ where: { subjectRef: { in: accountIds } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

const nextEmail = () => {
  seq += 1;
  return `${EMAIL_PREFIX}${seq}@example.com`;
};

/** Register exactly as the browser does: JSON body, matching origin. */
const signUp = (body: unknown, origin: string | null = ORIGIN) =>
  handleSignUpRequest(
    {
      contentType: "application/json",
      originHeader: origin,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    {
      db,
      appOrigin: ORIGIN,
      now: () => NOW,
      throttle: signUpThrottle,
      mailPort,
      verificationOrigin: ORIGIN,
    },
  );

const signIn = (email: string, password: string) =>
  handleSignInRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      rawBody: JSON.stringify({ email, password }),
    },
    { db, appOrigin: ORIGIN, now: () => NOW, throttle },
  );

const describeDb = RUN ? describe : describe.skip;

describeDb("1.27 — account sign-up", () => {
  beforeEach(async () => {
    throttle = createFakeSignInThrottle();
    signUpThrottle = createFakeSignUpThrottle();
    mailPort = createCapturingMailAdapter();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("registers a new account that can then sign in and hold a session", async () => {
    /* The phase's actual outcome, with nothing simulated: a person who did not
       exist a moment ago registers, signs in with the password they just chose,
       and the cookie they are handed resolves for a page. Before this phase the
       only way to reach that state was a test fixture or `scripts/db-check.ts`. */
    const email = nextEmail();

    const registered = await signUp({ name: "New Person", email, password: PASSWORD });
    expect(registered.status).toBe(200);
    expect(registered.body).toEqual({ registered: true });

    /* Registration does NOT sign anybody in. No cookie on the way out, on
       purpose — a session is minted by `/api/auth/sign-in` and nowhere else. */
    expect(registered.headers["set-cookie"]).toBeUndefined();

    /* `ACTIVE` but UNPROVED (Phase 1.27). Status and verification are separate
       facts: no third status was added to mean "unverified", because "disabled by
       an operator" and "has not clicked a link yet" are different things with
       different lifecycles. */
    const row = await db.account.findUnique({ where: { normalizedEmail: email.toLowerCase() } });
    expect(row?.status).toBe("ACTIVE");
    expect(row?.emailVerifiedAt).toBeNull();
    /* The password is stored as an Argon2id hash and never in the clear. */
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain(PASSWORD);

    /* And it CAN sign in already. The correction removed the sign-in gate this
       phase originally installed: an unproved address costs public storefront
       reachability, not access to your own onboarding. */
    expect((await signIn(email, PASSWORD)).status).toBe(200);

    /* Consume the link that registration sent, through the real verifier. */
    const link = mailPort.sent.at(-1)!.text.match(/https?:\/\/\S+/)![0];
    const token = new URL(link).searchParams.get("token")!;
    expect(await handleAccountVerifyEmailRequest({ token, at: NOW }, { db })).toEqual({
      outcome: "VERIFIED",
    });

    const signedIn = await signIn(email, PASSWORD);
    expect(signedIn.status).toBe(200);

    const cookieHeader = signedIn.headers["set-cookie"]!.split(";")[0]!;
    expect(await resolvePageSession(cookieHeader, { db, now: () => NOW })).toEqual({
      accountId: row!.id,
    });
  });

  it("answers an address that already has an account exactly as it answers a new one", async () => {
    /* THE security guarantee of this phase.

       `account-errors.ts` set the rule down before the route existed:
       `DuplicateAccountEmailError` "must not surface this code to the caller for
       the enumeration reason above". A registration endpoint that answered
       differently for a taken address would be an account-existence oracle worth
       exactly as much to an attacker as one on sign-in — and `authenticateAccount`
       already goes to the trouble of a timing decoy to avoid being that. */
    const email = nextEmail();
    const first = await signUp({ name: "First Person", email, password: PASSWORD });
    expect(first.status).toBe(200);

    /* A second registration for the same address, with a DIFFERENT name and a
       DIFFERENT password. */
    const second = await signUp({
      name: "Impostor",
      email,
      password: "a-completely-different-password",
    });

    /* Byte-identical: same status, same body, same headers, no cookie on either.
       Compared as serialised wholes so a field added to one branch later fails
       here rather than quietly becoming a signal. */
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    /* And the existing account is untouched. This is what makes answering
       uniformly *safe* rather than merely quiet: a stranger cannot overwrite a
       name, cannot change a password, and cannot take an account over by
       re-registering its address. */
    const rows = await db.account.findMany({ where: { normalizedEmail: email.toLowerCase() } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("First Person");

    /* The original password still works and the impostor's does not — proof the
       stored hash was never rewritten by the second registration. Verified first,
       because an unproved account is refused whatever password it is given, and
       that would make this assertion prove nothing. */
    const firstLink = mailPort.sent[0]!.text.match(/https?:\/\/\S+/)![0];
    const firstToken = new URL(firstLink).searchParams.get("token")!;
    expect(
      (await handleAccountVerifyEmailRequest({ token: firstToken, at: NOW }, { db })).outcome,
    ).not.toBe("VERIFIED");
    /* The FIRST link is dead: the duplicate registration reissued, superseding
       it. The live one is the most recent. */
    const liveLink = mailPort.sent.at(-1)!.text.match(/https?:\/\/\S+/)![0];
    const liveToken = new URL(liveLink).searchParams.get("token")!;
    expect(await handleAccountVerifyEmailRequest({ token: liveToken, at: NOW }, { db })).toEqual({
      outcome: "VERIFIED",
    });

    expect((await signIn(email, PASSWORD)).status).toBe(200);
    expect((await signIn(email, "a-completely-different-password")).status).toBe(401);

    /* Normalised uniqueness holds through the route, so a differently-cased
       address is the same account and gets the same uniform answer. */
    const cased = await signUp({
      name: "Case Variant",
      email: email.toUpperCase(),
      password: PASSWORD,
    });
    expect(JSON.stringify(cased)).toBe(JSON.stringify(first));
    expect(await db.account.count({ where: { normalizedEmail: email.toLowerCase() } })).toBe(1);
  });

  it("creates an Account and nothing marketplace-shaped", async () => {
    /* Registering is not joining the marketplace. The schema keeps admission on
       a separate record precisely so that "has a login" and "may sell" are
       different facts, and a signup route that quietly created the second would
       collapse the distinction the separation exists to hold.

       Counted across the whole table rather than filtered by the new account,
       because the failure being guarded against is a route that creates a
       participant at all — which would not necessarily key off this account. */
    const before = {
      participants: await db.marketplaceParticipant.count(),
      roles: await db.marketplaceRoleAssignment.count(),
      storefronts: await db.storefront.count(),
      offers: await db.offer.count(),
      listings: await db.listing.count(),
      contacts: await db.participantEmailContact.count(),
      challenges: await db.emailVerificationChallenge.count(),
      sessions: await db.accountSession.count(),
      entitlements: await db.accountEntitlement.count(),
    };

    const email = nextEmail();
    expect((await signUp({ name: "Solo Account", email, password: PASSWORD })).status).toBe(200);

    expect({
      participants: await db.marketplaceParticipant.count(),
      roles: await db.marketplaceRoleAssignment.count(),
      storefronts: await db.storefront.count(),
      offers: await db.offer.count(),
      listings: await db.listing.count(),
      contacts: await db.participantEmailContact.count(),
      challenges: await db.emailVerificationChallenge.count(),
      sessions: await db.accountSession.count(),
      entitlements: await db.accountEntitlement.count(),
    }).toEqual(before);

    /* `contacts` and `challenges` above are the PARTICIPANT verification tables,
       and both staying at zero is the load-bearing part of this case: Phase 1.27
       verifies an account's address WITHOUT creating a `ParticipantEmailContact`
       or a participant-scoped challenge, which is exactly what the architecture
       ruling forbade. Account verification uses its own table. */
    expect(
      await db.accountEmailVerificationChallenge.count({ where: { account: { email } } }),
    ).toBe(1);

    /* One outbound email — the verification message — and it is addressed to no
       participant at all. A route that fabricated one to have somebody to send
       to would show up here. */
    const delivered = await db.outboundEmailDelivery.findMany({
      where: { subjectRef: { in: [(await db.account.findUniqueOrThrow({ where: { normalizedEmail: email.toLowerCase() } })).id] } },
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.audience).toBe("ACCOUNT");
    expect(delivered[0]!.subjectKind).toBe("ACCOUNT_EMAIL");
    expect(delivered[0]!.recipientParticipantId).toBeNull();
    expect(delivered[0]!.obligationId).toBeNull();

    /* Exactly one new account row. */
    expect(await db.account.count({ where: { normalizedEmail: email.toLowerCase() } })).toBe(1);
  });

  it("throttles registrations per address, independently of the sign-in budget", async () => {
    /* Phase 1.27 FIX NOW. The abuse this bounds is not account creation — an
       attacker with many addresses gets many budgets, and nothing keyed on the
       address can stop that. It is **verification-email bombing**: without a
       limit, this endpoint is a free mailer aimed at anybody whose address
       somebody knows. Five per address per hour caps that inbox. */
    const email = nextEmail();
    const body = { name: "Repeat Caller", email, password: PASSWORD };

    for (let i = 1; i <= 5; i += 1) {
      expect(`attempt ${i} -> ${(await signUp(body)).status}`).toBe(`attempt ${i} -> 200`);
    }

    /* The sixth is refused, and says only that — not the count, not the
       threshold, and not whether the address names an account. */
    const refused = await signUp(body);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: "TOO_MANY_ATTEMPTS" });
    expect(refused.headers["retry-after"]).toBeDefined();

    /* A DIFFERENT address is unaffected — the budget is per identifier. */
    expect((await signUp({ name: "Other", email: nextEmail(), password: PASSWORD })).status).toBe(
      200,
    );

    /* And the sign-in budget for the SAME address is untouched: separate key
       namespace, separate HMAC domain, separate policy. If the two limiters
       shared a counter, five registrations would have eaten into sign-in's eight
       and this would read 5 rather than 0. */
    expect(throttle.countFor(email)).toBe(0);
    expect(signUpThrottle.countFor(email)).toBeGreaterThanOrEqual(5);

    /* The window is fixed, not sliding: it reopens an hour after the FIRST
       attempt, however many were made after it. */
    signUpThrottle.advanceSeconds(3601);
    expect((await signUp(body)).status).toBe(200);
  });

  it("fails closed when the registration limiter cannot answer", async () => {
    /* There is no in-memory fallback anywhere in `src/`, deliberately: a limiter
       that degrades to a process-local Map is not a limiter on a platform with
       more than one instance. If Redis cannot answer, Monacado declines to create
       accounts and send mail unprotected rather than doing it uncounted. */
    const before = await db.account.count();
    signUpThrottle.breakBackend();

    const out = await signUp({ name: "Blocked", email: nextEmail(), password: PASSWORD });
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "SIGN_UP_UNAVAILABLE" });

    /* Nothing was written and nothing was mailed — the refusal is before both. */
    expect(await db.account.count()).toBe(before);
    expect(mailPort.sent).toHaveLength(0);
  });

  it("refuses a cross-origin post, a bad shape, and an authority-shaped key — writing nothing", async () => {
    /* Everything a caller can get wrong about transport is answered before any
       password is hashed and before the database is touched at all. The count
       assertion is the real content: a refusal that had already written a row
       would be a refusal in name only. */
    const before = await db.account.count();
    const email = nextEmail();
    const valid = { name: "Someone", email, password: PASSWORD };

    /* A present origin must match. Phase 1.26 proved this live against
       staging.monacado.com for sign-in and sign-out; this is the same rule on the
       new endpoint, and it fails closed when no origin is configured. */
    expect((await signUp(valid, "https://evil.example.com")).status).toBe(403);
    expect((await signUp(valid, "https://evil.example.com")).body).toEqual({
      error: "CROSS_ORIGIN_REQUEST_REFUSED",
    });
    /* A missing origin is permitted, exactly as on sign-in — so this one must
       succeed, which also proves the refusals above were about the origin and
       not about the body. */
    expect((await signUp(valid, null)).status).toBe(200);

    /* Unparseable JSON, and a body that is not an object. */
    expect((await signUp("{not json", ORIGIN)).status).toBe(400);
    expect((await signUp(["array"], ORIGIN)).status).toBe(400);

    /* A short password is a bounded 400 that names no field — the contract's
       `InvalidAccountInputError` carries field paths and they are deliberately
       not forwarded. */
    const short = await signUp({ name: "S", email: nextEmail(), password: "short" });
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: "INVALID_SIGN_UP_REQUEST" });
    expect(JSON.stringify(short.body)).not.toContain("password");

    /* An empty name and an implausible address, same bounded answer. */
    expect((await signUp({ name: "", email: nextEmail(), password: PASSWORD })).status).toBe(400);
    expect((await signUp({ name: "X", email: "not-an-address", password: PASSWORD })).status).toBe(
      400,
    );

    /* Authority-shaped keys. `strictObject` refuses the request outright rather
       than dropping the key, so a caller cannot choose their own account status,
       hand themselves a role, or name an account id. */
    for (const extra of [
      { status: "DISABLED" },
      { role: "SELLER" },
      { accountId: "mon:acct:CHOSEN" },
      { createdAt: "1999-01-01T00:00:00.000Z" },
      { verified: true },
    ]) {
      const smuggled = await signUp({ ...valid, email: nextEmail(), ...extra });
      expect(`${JSON.stringify(extra)} -> ${smuggled.status}`).toBe(
        `${JSON.stringify(extra)} -> 400`,
      );
    }

    /* One row was created across all of the above: the deliberate no-origin
       success. Every refusal wrote nothing. */
    expect(await db.account.count()).toBe(before + 1);
  });
});
