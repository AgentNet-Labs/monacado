"use client";

/**
 * The sign-out control (Phase 1.25).
 *
 * A button, not a link. `GET`-ing a logout is what `sign-out/route.ts` refuses
 * to support, and for the reason it gives: any `<img>` on any page in the world
 * could fire it, and every prefetcher that followed a link would sign the user
 * out. A `<button>` posting through `fetch` is the shape that matches the
 * endpoint.
 *
 * No confirmation dialog. The repository has no modal convention to follow, and
 * sign-out is cheap to undo — the person signs back in on the page they land on.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SIGN_OUT_DESTINATION, submitSignOut } from "./sign-out-submission";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onClick() {
    if (pending) return;
    setPending(true);
    setError(undefined);

    const result = await submitSignOut();

    if (result.outcome === "signed-out") {
      /* `replace`, so Back does not return to a page whose content is gone; the
         server guard there would redirect anyway, and this avoids the flicker.
         `refresh` for the same reason sign-in refreshes: the cached RSC payload
         of `/sign-in` may date from before this session existed. */
      router.replace(SIGN_OUT_DESTINATION);
      router.refresh();
      return;
    }

    /* The session may still be live. The button comes back so it can be pressed
       again, and nothing pretends the sign-out happened. */
    setError(result.message);
    setPending(false);
  }

  return (
    <>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="auth-button" type="button" onClick={onClick} disabled={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </>
  );
}
