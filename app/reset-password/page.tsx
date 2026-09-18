/**
 * `/reset-password` — choose a new password from an emailed link (Phase 1.28).
 *
 * ## Rendering this page consumes nothing
 *
 * Unlike `/verify-account-email`, the token is only spent by the POST the form
 * makes. Mail scanners and link prefetchers open links; if opening this one used
 * it, the person would arrive to find their link already gone.
 *
 * It also does not look the token up. Telling a visitor "this link is valid"
 * before they submit would make the page an oracle for token state; a malformed
 * token is refused on sight, and everything else is decided by the POST.
 *
 * ## The token must not leak onward
 *
 * It sits in this page's URL, so the page sends no `Referer`: following any link
 * away from here must not carry the token to the next request.
 */

import type { Metadata } from "next";
import { InvalidResetLink, ResetPasswordForm } from "./reset-password-form";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = { referrer: "no-referrer" };

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" && TOKEN_RE.test(raw) ? raw : null;

  return (
    <main className="auth-main">
      <div className="auth-card">
        <h1>Monacado</h1>
        <p className="auth-lede">Choose a new password.</p>
        {token === null ? <InvalidResetLink /> : <ResetPasswordForm token={token} />}
      </div>
    </main>
  );
}
