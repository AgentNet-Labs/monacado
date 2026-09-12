"use client";

/**
 * The sign-up form (Phase 1.27).
 *
 * Thin, exactly as `SignInForm` is thin. Every rule about what may be sent, what
 * a refusal means, and what a person is told lives in `sign-up-submission.ts`,
 * which the node test environment exercises without a DOM. What is left here is
 * the part that genuinely needs a browser: three inputs, a pending flag, and the
 * two states a submission can land in.
 *
 * ## Why it is a client component
 *
 * The same reason sign-in is: a password must not travel in a page's HTML, a URL,
 * or a server action's serialised arguments. A `fetch` to the JSON endpoint keeps
 * the credential in exactly one request.
 *
 * ## Why success renders in place instead of navigating
 *
 * A registration that redirected straight to `/sign-in` would look, to the person
 * who just filled the form, indistinguishable from a form that silently cleared
 * itself. They need to be told the account exists before being asked to sign in
 * to it. So the card is replaced by a confirmation that says what happened and
 * offers the link onward — a navigation they take deliberately, not one that
 * happens to them.
 *
 * **It does not sign anybody in.** The endpoint issues no cookie, on purpose, and
 * there is nothing here that could pretend otherwise: no session state, no
 * redirect to `/account`, and no second request with the password still in hand.
 *
 * ## The confirmation is deliberately incurious about which branch it is
 *
 * The server answers a brand-new address and an already-registered one
 * identically, so this component cannot tell them apart and must not appear to
 * try. The copy is therefore conditional — "**if** that address can receive
 * mail" — and true on every branch: a new address is sent a link, an existing
 * unverified one is sent a fresh link, and an already-verified one is sent
 * nothing because its owner can already sign in. Wording that promised "we have
 * sent you an email" would be a lie on the third branch, and a lie a probing
 * caller could detect by owning a verified address and reading the page.
 *
 * It also does not say an account was *created*, for the same reason.
 */

import Link from "next/link";
import { useState } from "react";
import {
  MIN_PASSWORD_LENGTH,
  SIGN_UP_DESTINATION,
  submitSignUp,
} from "./sign-up-submission";

export function SignUpForm() {
  const [pending, setPending] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    /* Read before the first `await`: React clears `currentTarget` once the
       synthetic event has been handed back. */
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "");
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    setPending(true);
    /* The previous refusal is cleared as the next attempt starts, so a stale
       message cannot sit above a request that is still in flight. */
    setError(undefined);

    const result = await submitSignUp({ name, email, password });

    if (result.outcome === "registered") {
      /* Left pending on purpose: the form is about to be replaced, and
         re-enabling the button first offers a second submission of a password
         that has already been accepted. */
      setRegistered(true);
      return;
    }

    setError(result.message);
    setPending(false);
  }

  if (registered) {
    return (
      <div>
        {/* `role="status"` announces the outcome to a screen reader without
            stealing focus, matching how `auth-error` announces a refusal. */}
        <p className="auth-signed-in" role="status">
          Check your email
        </p>
        <p className="auth-status">
          If that address can receive mail, a confirmation link is on its way.
          Open it to finish setting up the account — you will not be able to sign
          in until the address is confirmed. The link expires in 24 hours.
        </p>
        <Link className="auth-button auth-button-link" href={SIGN_UP_DESTINATION}>
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="auth-field">
        <label htmlFor="sign-up-name">Name</label>
        <input
          id="sign-up-name"
          name="name"
          type="text"
          autoComplete="name"
          required
          disabled={pending}
        />
      </div>

      <div className="auth-field">
        <label htmlFor="sign-up-email">Email</label>
        <input
          id="sign-up-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
        />
      </div>

      <div className="auth-field">
        <label htmlFor="sign-up-password">Password</label>
        <input
          id="sign-up-password"
          name="password"
          type="password"
          /* `new-password`, not `current-password`: it tells a password manager
             to offer generation here rather than to autofill the credential it
             holds for the sign-in form. */
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          disabled={pending}
          /* Points at the hint below, so a screen reader reads the requirement
             as part of the field rather than as loose text after it. */
          aria-describedby="sign-up-password-hint"
        />
        {/* The one rule a person cannot guess and will otherwise trip. It is the
            contract's own constant, so it cannot drift from what the server
            enforces. No strength meter, no scoring, no complexity rules — none
            of that is in the contract and none is invented here. */}
        <p className="auth-hint" id="sign-up-password-hint">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>

      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
