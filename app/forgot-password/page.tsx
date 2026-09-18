/**
 * `/forgot-password` — ask for a password reset link (Phase 1.28).
 *
 * Deliberately not guarded by a session redirect: somebody signed in on one
 * device may be here precisely because they cannot sign in on another.
 */

import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-password-form";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function ForgotPasswordPage() {
  return (
    <main className="auth-main">
      <div className="auth-card">
        <h1>Monacado</h1>
        <p className="auth-lede">Reset your password.</p>
        <ForgotPasswordForm />
        <p className="auth-alt">
          Remembered it? <Link href="/sign-in">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
