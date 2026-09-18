/**
 * The browser half of Seller/Promoter setup (Phase 1.29) — pure, `fetch` injected.
 *
 * Sends exactly the roles the person chose and nothing else: no account id, no
 * participant id, no status, no instant. Who is asking is the session cookie's
 * answer, and the endpoint's strict schema refuses anything more.
 *
 * A refusal reaches the person as one bounded sentence, never as whatever the
 * server said.
 */

import type { SelfServiceOnboardingRole } from "../../src/contracts/marketplace/participant-record";

export const ONBOARDING_ENDPOINT = "/api/participant/onboarding";

export const ONBOARDING_NO_ROLE_CHOSEN = "Choose Seller, Promoter, or both.";
export const ONBOARDING_CLOSED =
  "Setup can't be changed here while your account is being reviewed or after a decision has been made.";
export const ONBOARDING_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const ONBOARDING_FAILURE = "Unable to start setup. Please try again.";

export type OnboardingOutcome = { outcome: "started" } | { outcome: "failed"; message: string };

export interface OnboardingSubmissionDeps {
  fetchImpl?: typeof fetch;
}

export async function submitOnboarding(
  roles: readonly SelfServiceOnboardingRole[],
  deps: OnboardingSubmissionDeps = {},
): Promise<OnboardingOutcome> {
  if (roles.length === 0) return { outcome: "failed", message: ONBOARDING_NO_ROLE_CHOSEN };

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(ONBOARDING_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles }),
    });
  } catch {
    return { outcome: "failed", message: ONBOARDING_FAILURE };
  }

  if (response.ok) return { outcome: "started" };
  if (response.status === 401) return { outcome: "failed", message: ONBOARDING_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  return {
    outcome: "failed",
    message: code === "PARTICIPANT_ONBOARDING_CLOSED" ? ONBOARDING_CLOSED : ONBOARDING_FAILURE,
  };
}
