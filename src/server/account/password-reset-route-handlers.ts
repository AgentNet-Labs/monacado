/**
 * Password reset route handlers (Phase 1.28) — SERVER ONLY.
 *
 * Two endpoints, expressed without Next.js as sign-up's is:
 *
 *   - `POST /api/auth/password-reset/request` — `{ email }` in, `{ requested: true }`
 *     out, whatever the address is;
 *   - `POST /api/auth/password-reset/complete` — `{ token, password }` in,
 *     `{ reset: true }` or a bounded refusal out.
 *
 * ## The request answer carries no fact about the address
 *
 * A known address, an unknown one, a disabled account, and a mail outage all get
 * the same 200 and the same body. The attempt budget is charged against the
 * *submitted* address before anything is looked up, so the limiter answers
 * identically too.
 *
 * Equal bodies are not enough on their own: a known address triggers a lookup, a
 * durable write, and an SMTP conversation that can take a second, and a response
 * that waited for all of that would announce which addresses have accounts by
 * how long it took. So the route hands that work to `defer` — Next's `after()` —
 * and answers first. What runs after the response is ordinary committed work: the
 * outbox row is durable and the existing dispatcher retries a failed send.
 *
 * ## Completing a reset
 *
 * Every reason a link cannot be used — never existed, expired, superseded,
 * already used, account disabled, address changed — is one answer,
 * `PASSWORD_RESET_LINK_INVALID`. A too-short password is its own answer because
 * it describes the submission, not the account, and the person can fix it.
 * Success issues no session and no cookie.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { MAX_EMAIL_LENGTH, normalizeEmail } from "../../contracts/account/account";
import type { MailPort } from "../../contracts/marketplace/notification-delivery";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";
import { InvalidAccountInputError } from "./account-errors";
import {
  AccountPasswordResetRefusedError,
  completeAccountPasswordReset,
} from "./account-password-reset-service";
import { requestAccountPasswordReset } from "./account-password-reset-notice";
import {
  defaultPasswordResetThrottle,
  type PasswordResetThrottle,
} from "./password-reset-abuse-protection";

type Db = ReturnType<typeof getPrisma>;

export const PASSWORD_RESET_ERROR_CODES = {
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_PASSWORD_RESET_REQUEST",
  tooManyAttempts: "TOO_MANY_ATTEMPTS",
  invalidPassword: "INVALID_PASSWORD",
  linkInvalid: "PASSWORD_RESET_LINK_INVALID",
  unavailable: "PASSWORD_RESET_UNAVAILABLE",
} as const;

export const PASSWORD_RESET_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

/** The one request answer, for every address. */
export const PASSWORD_RESET_REQUESTED_BODY: Readonly<Record<string, unknown>> = Object.freeze({
  requested: true,
});

export const PASSWORD_RESET_COMPLETED_BODY: Readonly<Record<string, unknown>> = Object.freeze({
  reset: true,
});

export interface PasswordResetRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface PasswordResetRouteRequest {
  contentType: string | null;
  originHeader: string | null;
  rawBody: string;
}

export const PasswordResetRequestBody = z.strictObject({
  email: z.string().min(1).max(MAX_EMAIL_LENGTH),
});

export const PasswordResetCompleteBody = z.strictObject({
  token: z.string(),
  /* Bounded by `AccountPassword` one layer down, so the rule lives in one place. */
  password: z.string(),
});

/** A 32-byte base64url token, exactly. Anything else is not one of ours. */
const RESET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function answer(status: number, body: Record<string, unknown>): PasswordResetRouteResult {
  return { status, body, headers: { ...PASSWORD_RESET_HEADERS } };
}

const refuse = (status: number, code: string) => answer(status, { error: code });

/** A present origin must match; a missing one is permitted, as on sign-in. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

/** Transport checks shared by both endpoints: origin, then a JSON body. */
function readJson(
  request: PasswordResetRouteRequest,
  appOrigin: string | undefined,
): { ok: true; value: unknown } | { ok: false; result: PasswordResetRouteResult } {
  const codes = PASSWORD_RESET_ERROR_CODES;
  if (!originAcceptable(request.originHeader, appOrigin)) {
    return { ok: false, result: refuse(403, codes.crossOrigin) };
  }
  const type = (request.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return { ok: false, result: refuse(400, codes.invalidRequest) };
  try {
    return { ok: true, value: JSON.parse(request.rawBody) };
  } catch {
    return { ok: false, result: refuse(400, codes.invalidRequest) };
  }
}

export interface PasswordResetRequestDeps {
  db?: Db | Prisma.TransactionClient;
  now?: () => string;
  appOrigin?: string | undefined;
  throttle?: PasswordResetThrottle;
  mailPort?: MailPort;
  resetOrigin?: string;
  /**
   * Run the lookup-and-mail work after the response. The route passes Next's
   * `after`; when absent (tests, scripts) the work is awaited before answering.
   */
  defer?: (task: () => Promise<void>) => void;
}

export async function handlePasswordResetRequest(
  request: PasswordResetRouteRequest,
  deps: PasswordResetRequestDeps = {},
): Promise<PasswordResetRouteResult> {
  const codes = PASSWORD_RESET_ERROR_CODES;
  const read = readJson(request, deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN);
  if (!read.ok) return read.result;

  const parsed = PasswordResetRequestBody.safeParse(read.value);
  if (!parsed.success) return refuse(400, codes.invalidRequest);
  const submitted = parsed.data.email;

  let decision;
  try {
    decision = await (deps.throttle ?? defaultPasswordResetThrottle()).admitAttempt(submitted);
  } catch {
    /* Monacado cannot count requests, so it sends no mail. Fail closed. */
    return refuse(503, codes.unavailable);
  }
  if (decision.throttled) {
    const result = refuse(429, codes.tooManyAttempts);
    if (decision.retryAfterSeconds !== undefined) {
      result.headers["retry-after"] = String(decision.retryAfterSeconds);
    }
    return result;
  }

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const db = deps.db as Db | undefined;

  const work = async (): Promise<void> => {
    try {
      const account = await (db ?? getPrisma()).account.findUnique({
        where: { normalizedEmail: normalizeEmail(submitted) },
        select: { id: true, status: true },
      });
      /* Unknown and disabled addresses get nothing. Unverified accounts are
         eligible: recovering a password does not verify the address. */
      if (account === null || account.status !== "ACTIVE") return;
      await requestAccountPasswordReset({ accountId: account.id, now }, deps.mailPort, {
        ...(db !== undefined ? { db } : {}),
        ...(deps.resetOrigin !== undefined ? { origin: deps.resetOrigin } : {}),
      });
    } catch {
      /* Nothing about a lookup or mail fault may reach the caller. */
    }
  };

  if (deps.defer !== undefined) deps.defer(work);
  else await work();

  return answer(200, { ...PASSWORD_RESET_REQUESTED_BODY });
}

export interface PasswordResetCompleteDeps {
  db?: Db | Prisma.TransactionClient;
  now?: () => string;
  appOrigin?: string | undefined;
}

export async function handlePasswordResetComplete(
  request: PasswordResetRouteRequest,
  deps: PasswordResetCompleteDeps = {},
): Promise<PasswordResetRouteResult> {
  const codes = PASSWORD_RESET_ERROR_CODES;
  const read = readJson(request, deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN);
  if (!read.ok) return read.result;

  const parsed = PasswordResetCompleteBody.safeParse(read.value);
  if (!parsed.success) return refuse(400, codes.invalidRequest);
  if (!RESET_TOKEN_RE.test(parsed.data.token)) return refuse(400, codes.linkInvalid);

  const at = (deps.now ?? (() => new Date().toISOString()))();
  try {
    await completeAccountPasswordReset(
      { token: parsed.data.token, password: parsed.data.password, at },
      { ...(deps.db !== undefined ? { db: deps.db } : {}) },
    );
    return answer(200, { ...PASSWORD_RESET_COMPLETED_BODY });
  } catch (error) {
    if (error instanceof InvalidAccountInputError) return refuse(400, codes.invalidPassword);
    if (error instanceof AccountPasswordResetRefusedError) return refuse(400, codes.linkInvalid);
    return refuse(500, codes.unavailable);
  }
}
