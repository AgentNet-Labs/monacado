/**
 * `/` — the interim public homepage.
 *
 * NO DATABASE, NO NETWORK. The page is static, so it is rendered to markup and
 * read as text. What is proved: the Phase 0A placeholder is gone, the two entry
 * points go where the auth pages live, the heading outline is one `h1` with the
 * roles beneath it, and the copy makes none of the claims the product cannot
 * yet back (live selling, purchasing, payouts, fees).
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/* Vitest compiles JSX to `React.createElement` against a global `React`; see
   `account-page.test.tsx`. */
(globalThis as { React?: typeof React }).React = React;

const { default: HomePage } = await import("../app/page");
const { metadata } = await import("../app/layout");

const html = renderToStaticMarkup(<HomePage />);
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("homepage", () => {
  it("no longer renders the repository-foundation placeholder", () => {
    expect(text).not.toMatch(/Repository foundation/i);
    expect(text).not.toMatch(/Phase 0B/i);
    expect(String(metadata.description)).not.toMatch(/Repository foundation/i);
  });

  it("states the headline as the page's only h1", () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(
      /<h1[^>]*>A marketplace built for makers and promoters\.<\/h1>/,
    );
  });

  it("explains Makers, Promoters and Buyers under one h2", () => {
    expect(html.match(/<h2[\s>]/g)).toHaveLength(1);
    const roles = [...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(roles).toEqual(["Makers", "Promoters", "Buyers"]);
  });

  it("links to sign-up as the primary action and sign-in as the secondary", () => {
    const signUp = html.indexOf('href="/sign-up"');
    const signIn = html.indexOf('href="/sign-in"');
    expect(signUp).toBeGreaterThan(-1);
    expect(signIn).toBeGreaterThan(signUp);
    const anchor = (href: string) =>
      html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))?.[0] ?? "";
    expect(anchor("/sign-up")).toContain("home-cta-primary");
    expect(anchor("/sign-in")).toContain("home-cta-secondary");
  });

  it("makes no claim the product cannot yet back", () => {
    expect(text).not.toMatch(/%|\$|fee|payout|stripe|testimonial|coming soon/i);
    expect(text).not.toMatch(/buy now|shop now|browse/i);
  });
});
