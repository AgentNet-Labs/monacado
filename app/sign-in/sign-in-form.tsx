"use client";

/**
 * The sign-in form (Phase 1.25) — the repository's first client component.
 *
 * It is deliberately thin. Every rule about what may be sent, what a refusal
 * means, and what a person is told lives in `sign-in-submission.ts`, which is a
 * plain module the node test environment can exercise without a DOM. What is
 * left here is the part that genuinely needs a browser: two inputs, a pending
 * flag, and a navigation.
 *
 * ## Why it is a client component at all
 *
 * Because a password must not be in a page's HTML, a URL, or a server action's
 * serialised arguments on its way anywhere. The existing endpoint already takes
 * a JSON `POST` and answers with `Set-Cookie`; a `fetch` from the browser is the
 * shortest path to it that keeps the credential in exactly one request and the
 * session in exactly one cookie.
 *
 * ## Navigation, and why it is followed by a refresh
 *
 * `replace` rather than `push`: the sign-in page is not somewhere a signed-in
 * person should be able to go Back to, and the server guard on that page would
 * only bounce them off it again.
 *
 * `refresh` after it, because the App Router caches the RSC payload of a route
 * per navigation. `/account` may already be in that cache from a visit made
 * while signed out — when it rendered a redirect — and the cookie that arrived
 * a moment ago does not invalidate it. Without the refresh the destination can
 * render from a cache created before the session existed.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SIGN_IN_DESTINATION, submitSignIn } from "./sign-in-submission";

export function SignInForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    /* Read before the first `await`: React clears `currentTarget` once the
       synthetic event has been handed back. */
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    setPending(true);
    /* The previous refusal is cleared as the next attempt starts, so a stale
       "incorrect" cannot sit above a request that is still in flight. */
    setError(undefined);

    const result = await submitSignIn({ email, password });

    if (result.outcome === "signed-in") {
      /* Left pending on purpose. The navigation is asynchronous, and re-enabling
         the button first offers a second submission of credentials that have
         already succeeded. */
      router.replace(SIGN_IN_DESTINATION);
      router.refresh();
      return;
    }

    setError(result.message);
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit}>
      {error !== undefined ? (
        /* `role="alert"` announces the refusal without moving focus, so a
           screen-reader user hears it and keeps their place in the form. */
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="auth-field">
        <label htmlFor="sign-in-email">Email</label>
        <input
          id="sign-in-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
        />
      </div>

      <div className="auth-field">
        <label htmlFor="sign-in-password">Password</label>
        <input
          id="sign-in-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
        />
      </div>

      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
