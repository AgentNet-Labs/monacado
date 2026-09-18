"use client";

/**
 * Seller/Promoter setup control (Phase 1.29).
 *
 * One checkbox per role the account can still start, and one button. On success
 * the page is refreshed so the server — not this component — renders the new
 * state; the component never holds a copy of what the account owns.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SelfServiceOnboardingRole } from "../../src/contracts/marketplace/participant-record";
import { ROLE_LABELS } from "./account-home-copy";
import { submitOnboarding } from "./onboarding-submission";

export function OnboardingForm({
  available,
  submitLabel,
}: {
  available: readonly SelfServiceOnboardingRole[];
  submitLabel: string;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<SelfServiceOnboardingRole[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function toggle(role: SelfServiceOnboardingRole, on: boolean) {
    setChosen((current) =>
      on ? available.filter((r) => r === role || current.includes(r)) : current.filter((r) => r !== role),
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);

    const result = await submitOnboarding(chosen);
    if (result.outcome === "started") {
      router.refresh();
      setChosen([]);
      setPending(false);
      return;
    }
    setError(result.message);
    setPending(false);
  }

  return (
    <form className="account-onboarding" onSubmit={onSubmit} noValidate>
      {error !== undefined ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <fieldset className="account-roles-choice">
        <legend>Set up as</legend>
        {available.map((role) => (
          <label key={role} className="account-checkbox">
            <input
              type="checkbox"
              name="roles"
              value={role}
              checked={chosen.includes(role)}
              onChange={(e) => toggle(role, e.currentTarget.checked)}
              disabled={pending}
            />
            {ROLE_LABELS[role]}
          </label>
        ))}
      </fieldset>
      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? "Starting…" : submitLabel}
      </button>
    </form>
  );
}
