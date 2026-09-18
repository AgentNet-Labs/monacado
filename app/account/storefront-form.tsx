"use client";

/**
 * Draft Storefront control (Phase 1.30).
 *
 * Two fields — the only two the domain requires at creation — and one button.
 * On success the page is refreshed so the server renders the new draft; the
 * component never holds a copy of what the account owns.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { STOREFRONT_HANDLE_HINT } from "./account-home-copy";
import { submitDraftStorefront } from "./storefront-submission";

export function StorefrontForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [publicHandle, setPublicHandle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);

    const result = await submitDraftStorefront({ displayName, publicHandle });
    if (result.outcome === "created") {
      router.refresh();
      setPending(false);
      return;
    }
    setError(result.message);
    setPending(false);
  }

  return (
    <form className="account-storefront-form" onSubmit={onSubmit} noValidate>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="auth-field">
        <label htmlFor="storefront-name">Storefront name</label>
        <input
          id="storefront-name"
          name="displayName"
          type="text"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
          disabled={pending}
        />
      </div>
      <div className="auth-field">
        <label htmlFor="storefront-handle">Handle</label>
        <input
          id="storefront-handle"
          name="publicHandle"
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          aria-describedby="storefront-handle-hint"
          value={publicHandle}
          onChange={(e) => setPublicHandle(e.currentTarget.value)}
          disabled={pending}
        />
        <p id="storefront-handle-hint" className="auth-hint">
          {STOREFRONT_HANDLE_HINT}
        </p>
      </div>
      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create draft storefront"}
      </button>
    </form>
  );
}
