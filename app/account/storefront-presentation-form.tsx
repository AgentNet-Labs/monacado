"use client";

/**
 * Storefront presentation editor (Phase 1.31).
 *
 * Name, tagline, and summary, prefilled from the current version. The handle is
 * shown and not editable — handle changes wait for the handle-reuse policy. On a
 * save the page is refreshed so the server renders the new current version; the
 * component never holds a copy of what the Storefront says.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { STOREFRONT_HANDLE_FIXED_NOTE, STOREFRONT_OPTIONAL_FIELD_HINT } from "./account-home-copy";
import { submitStorefrontPresentation } from "./storefront-presentation-submission";

export function StorefrontPresentationForm({
  publicHandle,
  displayName: initialName,
  tagline: initialTagline,
  summary: initialSummary,
}: {
  publicHandle: string;
  displayName: string;
  tagline: string | null;
  summary: string | null;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialName);
  const [tagline, setTagline] = useState(initialTagline ?? "");
  const [summary, setSummary] = useState(initialSummary ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    setNotice(undefined);

    const result = await submitStorefrontPresentation(publicHandle, {
      displayName,
      tagline,
      summary,
    });
    if (result.outcome === "saved") {
      router.refresh();
      setNotice("Saved.");
    } else if (result.outcome === "unchanged") {
      setNotice(result.message);
    } else {
      setError(result.message);
    }
    setPending(false);
  }

  const id = (field: string) => `storefront-${publicHandle}-${field}`;

  return (
    <form className="account-storefront-form" onSubmit={onSubmit} noValidate>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice !== undefined ? (
        <p className="auth-status" role="status">
          {notice}
        </p>
      ) : null}
      <div className="auth-field">
        <label htmlFor={id("name")}>Storefront name</label>
        <input
          id={id("name")}
          name="displayName"
          type="text"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
          disabled={pending}
        />
      </div>
      <div className="auth-field">
        <label htmlFor={id("tagline")}>Tagline</label>
        <input
          id={id("tagline")}
          name="tagline"
          type="text"
          aria-describedby={id("optional")}
          value={tagline}
          onChange={(e) => setTagline(e.currentTarget.value)}
          disabled={pending}
        />
      </div>
      <div className="auth-field">
        <label htmlFor={id("summary")}>Summary</label>
        <textarea
          id={id("summary")}
          name="summary"
          rows={4}
          aria-describedby={id("optional")}
          value={summary}
          onChange={(e) => setSummary(e.currentTarget.value)}
          disabled={pending}
        />
        <p id={id("optional")} className="auth-hint">
          {STOREFRONT_OPTIONAL_FIELD_HINT}
        </p>
      </div>
      <p className="auth-hint">
        {`Handle: ${publicHandle}. `}
        {STOREFRONT_HANDLE_FIXED_NOTE}
      </p>
      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
