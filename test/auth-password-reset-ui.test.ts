/**
 * Phase 1.28 — the password-reset page submissions. Pure: NO DATABASE, NO NETWORK.
 *
 * Only what the pages decide for themselves: the confirmation never leaves the
 * browser, a mismatch never reaches the endpoint, and each bounded refusal lands
 * in the right state.
 */

import { describe, expect, it } from "vitest";
import {
  GENERIC_PASSWORD_RESET_REQUEST_FAILURE,
  submitPasswordResetRequest,
} from "../app/forgot-password/forgot-password-submission";
import {
  INVALID_PASSWORD_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_RESET_COMPLETE_ENDPOINT,
  submitPasswordReset,
} from "../app/reset-password/reset-password-submission";

const TOKEN = "A".repeat(43);

function recordingFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("1.28 — reset password submission", () => {
  it("sends exactly token and password, never the confirmation", async () => {
    const { calls, fetchImpl } = recordingFetch(200, { reset: true });
    const result = await submitPasswordReset(
      { token: TOKEN, password: "long-enough-password", confirmation: "long-enough-password" },
      { fetchImpl },
    );
    expect(result).toEqual({ outcome: "reset" });
    expect(calls).toEqual([
      {
        url: PASSWORD_RESET_COMPLETE_ENDPOINT,
        body: { token: TOKEN, password: "long-enough-password" },
      },
    ]);
  });

  it("refuses a mismatch or a short password without calling the endpoint", async () => {
    const { calls, fetchImpl } = recordingFetch(200, { reset: true });
    expect(
      await submitPasswordReset(
        { token: TOKEN, password: "long-enough-password", confirmation: "different-password" },
        { fetchImpl },
      ),
    ).toEqual({ outcome: "refused", message: PASSWORD_MISMATCH_MESSAGE });
    expect(
      await submitPasswordReset({ token: TOKEN, password: "short", confirmation: "short" }, { fetchImpl }),
    ).toEqual({ outcome: "refused", message: INVALID_PASSWORD_MESSAGE });
    expect(calls).toHaveLength(0);
  });

  it("maps an unusable link to its own state", async () => {
    const { fetchImpl } = recordingFetch(400, { error: "PASSWORD_RESET_LINK_INVALID" });
    expect(
      await submitPasswordReset(
        { token: TOKEN, password: "long-enough-password", confirmation: "long-enough-password" },
        { fetchImpl },
      ),
    ).toEqual({ outcome: "link-invalid" });
  });

  it("shows only the generic message for an unavailable request endpoint", async () => {
    const { fetchImpl } = recordingFetch(503, { error: "PASSWORD_RESET_UNAVAILABLE" });
    expect(await submitPasswordResetRequest("person@example.com", { fetchImpl })).toEqual({
      outcome: "refused",
      message: GENERIC_PASSWORD_RESET_REQUEST_FAILURE,
    });
  });
});
