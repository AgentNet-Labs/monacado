"use client";

/**
 * The reset-password form (Phase 1.28): new password, confirmation, and three
 * end states — reset, invalid link, or a correctable refusal shown above the form.
 */

import Link from "next/link";
import { useState } from "react";
import { MIN_PASSWORD_LENGTH, submitPasswordReset } from "./reset-password-submission";

export function InvalidResetLink() {
  return (
    <div>
      <p className="auth-error" role="alert">
        This link is not valid
      </p>
      <p className="auth-status">
        This password reset link is not valid, has expired, or has already been used. Links
        expire one hour after they are sent, and asking for a new one replaces any earlier link.
      </p>
      <Link className="auth-button auth-button-link" href="/forgot-password">
        Request a new link
      </Link>
    </div>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<"form" | "reset" | "link-invalid">("form");
  const [error, setError] = useState<string | undefined>(undefined);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");

    setPending(true);
    setError(undefined);
    const result = await submitPasswordReset({ token, password, confirmation });

    if (result.outcome === "refused") {
      setError(result.message);
      setPending(false);
      return;
    }
    setState(result.outcome);
  }

  if (state === "link-invalid") return <InvalidResetLink />;

  if (state === "reset") {
    return (
      <div>
        <p className="auth-signed-in" role="status">
          Password reset
        </p>
        <p className="auth-status">
          Your password has been changed and you have been signed out everywhere. Sign in with
          your new password.
        </p>
        <Link className="auth-button auth-button-link" href="/sign-in">
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
        <label htmlFor="reset-password-password">New password</label>
        <input
          id="reset-password-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          disabled={pending}
          aria-describedby="reset-password-hint"
        />
        <p className="auth-hint" id="reset-password-hint">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>

      <div className="auth-field">
        <label htmlFor="reset-password-confirmation">Confirm new password</label>
        <input
          id="reset-password-confirmation"
          name="confirmation"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          disabled={pending}
        />
      </div>

      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}
