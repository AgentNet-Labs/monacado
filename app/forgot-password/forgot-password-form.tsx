"use client";

/**
 * The forgot-password form (Phase 1.28). One field, and one success state that
 * says the same thing whether or not the address has an account.
 */

import Link from "next/link";
import { useState } from "react";
import { submitPasswordResetRequest } from "./forgot-password-submission";

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const email = String(new FormData(event.currentTarget).get("email") ?? "");

    setPending(true);
    setError(undefined);
    const result = await submitPasswordResetRequest(email);

    if (result.outcome === "requested") {
      setRequested(true);
      return;
    }
    setError(result.message);
    setPending(false);
  }

  if (requested) {
    return (
      <div>
        <p className="auth-signed-in" role="status">
          Check your email
        </p>
        <p className="auth-status">
          If an account uses that address, a password reset link is on its way. The link
          expires in one hour and can be used once.
        </p>
        <Link className="auth-button auth-button-link" href="/sign-in">
          Back to sign in
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
        <label htmlFor="forgot-password-email">Email</label>
        <input
          id="forgot-password-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
        />
      </div>

      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
