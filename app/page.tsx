/**
 * `/` — the interim public homepage.
 *
 * Replaces the Phase 0A repository-foundation placeholder. It says what
 * Monacado is and where to begin, and nothing more: public commerce is still
 * being built, so the copy describes what a person can do today (create an
 * account, prepare a storefront and products, request to promote) and states
 * the buyer side conditionally rather than as a live capability.
 *
 * Static on purpose. It reads no session and no database, so it prerenders, and
 * a signed-in visitor who follows "Sign in" is redirected to `/account` by that
 * page's own guard rather than by anything here.
 */

import Link from "next/link";

export default function HomePage() {
  return (
    <main className="home-main">
      <header className="home-header">
        <p className="home-brand">Monacado</p>
      </header>

      <section className="home-hero" aria-labelledby="home-headline">
        <h1 id="home-headline">A marketplace built for makers and promoters.</h1>
        <p className="home-lede">
          Makers create the products. Promoters bring them to the people who
          will want them. Monacado keeps that relationship clear for everyone,
          including the buyer.
        </p>
        <p className="home-lede">
          We are opening in stages. Makers and promoters can create an account
          and start getting set up today.
        </p>
        <div className="home-actions">
          <Link href="/sign-up" className="home-cta home-cta-primary">
            Create an account
          </Link>
          <Link href="/sign-in" className="home-cta home-cta-secondary">
            Sign in
          </Link>
        </div>
      </section>

      <section className="home-roles" aria-labelledby="home-roles-heading">
        <h2 id="home-roles-heading">How Monacado works</h2>
        <ul className="home-role-list">
          <li className="home-role">
            <h3>Makers</h3>
            <p>
              Create an account, set up a storefront, and prepare your products
              before they go live.
            </p>
          </li>
          <li className="home-role">
            <h3>Promoters</h3>
            <p>
              Create an account and ask makers for permission to promote the
              products you believe in.
            </p>
          </li>
          <li className="home-role">
            <h3>Buyers</h3>
            <p>
              When products go on sale, you will be able to buy them without
              creating an account.
            </p>
          </li>
        </ul>
      </section>
    </main>
  );
}
