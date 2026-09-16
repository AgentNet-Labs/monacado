/**
 * Sign-up route handler (Phase 1.27) — SERVER ONLY.
 *
 * **The account-creation half that was deliberately left unbuilt.**
 * `account-service.ts` has been able to create an account since 0E.7.4.2A and
 * says so in as many words — "administrative in this phase: there is no public
 * signup route, and none is added". Every caller until now was a test fixture or
 * `scripts/db-check.ts`. This is that route, and it is only that route.
 *
 * ## It creates an Account and nothing else
 *
 * No `MarketplaceParticipant`, no role assignment, no `Storefront`, no policy
 * acceptance, no payment onboarding. `IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md`
 * keeps admission state on a separate record precisely so that "someone has a
 * login" and "someone may sell" are different facts, and a signup route that
 * quietly created the second would collapse the distinction the schema exists to
 * hold apart. Registering is not joining the marketplace.
 *
 * ## It verifies nothing itself
 *
 * `createAccount` owns every creation rule — the normalised-email uniqueness that
 * is enforced by the database's unique index rather than a read-then-write check,
 * the Argon2id hash taken before any transaction opens, and the `CreateAccountInput`
 * contract that bounds the name, the address, and the password length. Restating
 * any of it here would be a second answer able to disagree with the first.
 *
 * ## The response is uniform, and that is the entire point
 *
 * `account-errors.ts` wrote this phase's instruction down years before this phase
 * existed: `DuplicateAccountEmailError` is "reachable only from account creation
 * ... **if a public signup is ever added, it must not surface this code to the
 * caller for the enumeration reason above**". So it does not. A fresh address and
 * an address that already has an account produce **byte-identical** answers — the
 * same 200, the same body, no `Set-Cookie` on either — because any difference
 * between them is an account-existence oracle, and an oracle on registration is
 * worth exactly as much to an attacker as one on sign-in. `authenticateAccount`
 * already refuses to be that oracle; this refuses to be the one beside it.
 *
 * The timing matches too, and not by accident. `createAccount` hashes the
 * password **before** it touches the database, so the duplicate path pays for the
 * same Argon2id verification as the successful one and differs only by a failed
 * insert. The decoy hash that `password.ts` uses to flatten sign-in is not needed
 * here because the real work already happens on both branches.
 *
 * ## No session is issued
 *
 * Registering does not sign anybody in. The response carries no cookie and no
 * account id: a caller learns that the request was well-formed and accepted, and
 * nothing else. Signing in is `/api/auth/sign-in`, with the password they just
 * chose, through the endpoint that already knows how to charge an attempt budget
 * and mint a session. Returning an id here would additionally break the uniform
 * answer above, since the duplicate branch has no id it could honestly return.
 *
 * ## What this route does NOT have, and why it is named rather than hidden
 *
 * **There is no attempt budget on this endpoint.** Phase 1.23's throttle is not a
 * rate limiter and says so: "no route key, no policy table, no bucket registry,
 * and no way to apply it to a second endpoint ... a generic limiter is a different
 * phase with a different ruling, and building one here would quietly extend a
 * narrowly-granted Redis authorisation into a platform." Reusing it would be
 * exactly that extension. So this route is unthrottled, that is a real exposure
 * for automated account creation, and it is reported as an operational
 * prerequisite rather than papered over with a limiter nobody reviewed.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { createAccount } from "./account-service";
import { DuplicateAccountEmailError, InvalidAccountInputError } from "./account-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { normalizeEmail } from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { defaultSignUpThrottle, type SignUpThrottle } from "./sign-up-abuse-protection";
import { requestAccountEmailVerification } from "./account-verification-notice";
import type { MailPort } from "../../contracts/marketplace/notification-delivery";

type Db = ReturnType<typeof getPrisma>;

/**
 * Bounded response codes.
 *
 * Note what is absent: there is no `EMAIL_ALREADY_REGISTERED`, no
 * `DUPLICATE_ACCOUNT_EMAIL`, and no code of any kind that depends on whether the
 * submitted address already names an account. The vocabulary is deliberately
 * incapable of expressing that fact.
 */
export const SIGN_UP_ERROR_CODES = {
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_SIGN_UP_REQUEST",
  /**
   * Phase 1.27. This address has spent its registration budget for the current
   * window. It says that and nothing else — not the count, not the threshold, and
   * above all not whether the address names an account, because the budget is
   * charged before anything knows.
   */
  tooManyAttempts: "TOO_MANY_ATTEMPTS",
  unavailable: "SIGN_UP_UNAVAILABLE",
} as const;

export const SIGN_UP_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

/**
 * The one success body, returned for a created account and an already-taken
 * address alike. It is a constant rather than a built object so that the two
 * branches cannot drift into returning subtly different shapes.
 */
export const SIGN_UP_ACCEPTED_BODY: Readonly<Record<string, unknown>> = Object.freeze({
  registered: true,
});

export interface SignUpRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface SignUpRouteRequest {
  contentType: string | null;
  originHeader: string | null;
  rawBody: string;
}

export interface SignUpRouteDeps {
  db?: Db | Prisma.TransactionClient;
  now?: () => string;
  appOrigin?: string | undefined;
  /**
   * Phase 1.27 abuse protection. Injected so a test can drive the limiter
   * without a Redis endpoint; production takes `defaultSignUpThrottle`, which has
   * no in-memory fallback and refuses when Redis is unconfigured.
   */
  throttle?: SignUpThrottle;
  /** Injected so a test captures the verification mail instead of sending it. */
  mailPort?: MailPort;
  /** Injected so a test can pin the verification link's origin. */
  verificationOrigin?: string;
}

function refuseWith(
  status: number,
  code: string,
  extraHeaders: Record<string, string>,
): SignUpRouteResult {
  return { status, body: { error: code }, headers: { ...SIGN_UP_HEADERS, ...extraHeaders } };
}

/**
 * What a caller may state.
 *
 * Three members, all plain strings, and `strictObject` makes a fourth a refusal.
 * `status` in particular is not here: `CreateAccountInput` accepts one so a test
 * can seed a `DISABLED` account, and a registration route that forwarded it would
 * let a caller choose their own account state. `createdAt` is not here either —
 * the server clock decides when an account was made, not the browser that asked.
 *
 * The *values* are bounded by `CreateAccountInput` one layer down rather than
 * here. That keeps the password rule in exactly one place: this module never
 * states a minimum length, so it cannot come to disagree with the contract that
 * enforces one.
 */
export const SignUpRequest = z.strictObject({
  name: z.string(),
  email: z.string(),
  password: z.string(),
});
export type SignUpRequest = z.infer<typeof SignUpRequest>;

/**
 * Names that must never appear on a sign-up request.
 *
 * The schema is strict, so an unknown key already fails. This states the intent
 * and gives a test something to enumerate — the same belt-and-braces shape
 * `NEVER_ON_SIGN_IN_REQUEST` uses, and equally not the control.
 */
export const NEVER_ON_SIGN_UP_REQUEST = [
  "accountId",
  "participantId",
  "sessionId",
  "token",
  "sessionToken",
  "role",
  "capabilities",
  "internalCapabilities",
  "status",
  "createdAt",
  "verified",
  "verifiedAt",
] as const;

function refuse(status: number, code: string): SignUpRouteResult {
  return { status, body: { error: code }, headers: { ...SIGN_UP_HEADERS } };
}

/** A present origin must match; a missing one is permitted, as on sign-in. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

/**
 * Register an account, and say as little as possible about what happened.
 *
 * Order: origin, then request shape, then creation. The same order sign-in uses,
 * minus the attempt budget it has and this does not — everything a caller can get
 * wrong about *transport* is still answered before any password is hashed.
 */
export async function handleSignUpRequest(
  request: SignUpRouteRequest,
  deps: SignUpRouteDeps = {},
): Promise<SignUpRouteResult> {
  const codes = SIGN_UP_ERROR_CODES;
  const appOrigin = deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN;
  if (!originAcceptable(request.originHeader, appOrigin)) {
    return refuse(403, codes.crossOrigin);
  }

  const type = (request.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return refuse(400, codes.invalidRequest);

  let candidate: unknown;
  try {
    candidate = JSON.parse(request.rawBody);
  } catch {
    return refuse(400, codes.invalidRequest);
  }
  const parsed = SignUpRequest.safeParse(candidate);
  if (!parsed.success) return refuse(400, codes.invalidRequest);

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const db = deps.db as Db | undefined;

  /* Phase 1.27. The attempt is charged BEFORE an account is created and before
     any mail is committed, so a caller already over budget cannot use this
     endpoint to put another message in somebody's inbox. Everything a caller can
     get wrong about transport is still answered above and still costs nothing.

     `clear()` is deliberately NOT called on success, unlike sign-in. There, a
     correct password proves the attempt was legitimate and releasing the budget
     keeps a real user from being locked out. Here there is no such proof — a
     successful registration is exactly what an inbox-bombing attacker is doing,
     so success spends budget like everything else. */
  let throttle: SignUpThrottle;
  let decision;
  try {
    throttle = deps.throttle ?? defaultSignUpThrottle();
    decision = await throttle.admitAttempt(parsed.data.email);
  } catch {
    /* Configuration invalid, or the backend did not answer. Monacado cannot
       count registrations, so it does not accept one. Fail closed. */
    return refuse(503, codes.unavailable);
  }
  if (decision.throttled) {
    return refuseWith(
      429,
      codes.tooManyAttempts,
      decision.retryAfterSeconds !== undefined
        ? { "retry-after": String(decision.retryAfterSeconds) }
        : {},
    );
  }

  try {
    const account = await createAccount(
      {
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
        createdAt: now,
        /* Explicit, not inherited from the default. Public registration proves
           nothing about the address, so the account it creates starts unproved.
           It may sign in and begin onboarding; what it cannot do until a
           challenge is consumed is take a Storefront public. */
        emailVerification: "UNVERIFIED",
      },
      { ...(db !== undefined ? { db } : {}) },
    );

    /* The verification mail. Committed to the durable outbox and attempted
       immediately; a provider outage leaves the row for the dispatcher rather
       than failing a registration that genuinely succeeded. The challenge itself
       is minted by the message resolver at send time. */
    try {
      await requestAccountEmailVerification(
        { accountId: account.accountId, now },
        deps.mailPort,
        {
          ...(db !== undefined ? { db: db as Db } : {}),
          ...(deps.verificationOrigin !== undefined ? { origin: deps.verificationOrigin } : {}),
        },
      );
    } catch {
      /* The account exists and the address is unproved, which is a recoverable
         state: the person can register again and receive a fresh link. Turning a
         mail fault into a 500 here would tell a caller that *this* address
         behaved differently from another one, which is the enumeration signal
         this route spends its whole length avoiding. */
    }

    /* No id, no cookie, no session, no verification state. See the module header. */
    return { status: 200, body: { ...SIGN_UP_ACCEPTED_BODY }, headers: { ...SIGN_UP_HEADERS } };
  } catch (error) {
    /* The address already has an account. The caller is told exactly what a
       caller with a brand-new address is told, because the difference is the
       oracle. Nothing is written, nothing is mailed, and the existing account is
       not touched in any way — in particular its password is unchanged, which is
       why answering uniformly is safe rather than merely quiet. */
    if (error instanceof DuplicateAccountEmailError) {
      /* Phase 1.27 — the safe reissue.
       *
       * Without this, somebody whose verification mail was lost had no way back:
       * registering again answered 200 and did nothing, so the account stayed
       * unverified and unusable forever. That is a real dead end, and it is the
       * reason this branch does work at all rather than returning immediately.
       *
       * It is safe on both counts the ruling names:
       *
       *   - **No takeover.** Nothing about the existing account is touched — not
       *     the name, not the password, not its status. The submitted password is
       *     discarded here, having already been hashed and thrown away by the
       *     failed insert. A stranger who guesses an address gains nothing; the
       *     mail goes to the address's owner, not to whoever typed it.
       *   - **No enumeration.** The response is byte-identical to the created
       *     case, and the *work* is deliberately the same shape too: this calls
       *     the same delivery function unconditionally, and
       *     `resolveAccountVerificationMessage` — not this route — decides that an
       *     already-verified account gets no message. So the branch here does not
       *     read verification state to decide whether to act, and an observer
       *     cannot separate "new address" from "existing unverified address" at
       *     all.
       *
       * The throttle above is what stops this from being a resend amplifier: five
       * per address per hour bounds it whether the account existed or not. */
      try {
        const existing = await (db ?? getPrisma()).account.findUnique({
          where: { normalizedEmail: normalizeEmail(parsed.data.email) },
          select: { id: true },
        });
        if (existing !== null) {
          await requestAccountEmailVerification(
            { accountId: existing.id, now },
            deps.mailPort,
            {
              ...(db !== undefined ? { db: db as Db } : {}),
              ...(deps.verificationOrigin !== undefined
                ? { origin: deps.verificationOrigin }
                : {}),
            },
          );
        }
      } catch {
        /* Same reasoning as the created branch: a mail fault must not make this
           address answer differently from any other. */
      }
      return { status: 200, body: { ...SIGN_UP_ACCEPTED_BODY }, headers: { ...SIGN_UP_HEADERS } };
    }

    /* A name that is empty, an address that is not plausible, a password under
       the contract's minimum. These describe the *submission* and are safe to
       report as a shape failure — none of them depends on whether the address
       already names an account. The field paths `InvalidAccountInputError`
       carries are deliberately NOT forwarded: they would name `password` on a
       short password, which is more than the bounded vocabulary promises. */
    if (error instanceof InvalidAccountInputError) return refuse(400, codes.invalidRequest);

    /* Persistence fault, or anything unforeseen. Nothing about the database
       reaches the caller. */
    return refuse(500, codes.unavailable);
  }
}
