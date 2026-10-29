/**
 * Phase 1.43 — `/promote` and `/promote/{productRef}` presentation.
 *
 * The read service is mocked: what is tested here is what the pages render
 * from it — the card's fields and wording, the Seller as its mName, commission
 * as the Offer states it, the filter form, load-more, the detail terms, and
 * Request to Promote — and what they never render.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PromotableCatalogCard,
  PromotableCatalogDetail,
} from "../src/server/marketplace/promotable-catalog-read-service";

(globalThis as { React?: typeof React }).React = React;

const resolvePageSession = vi.fn();
const resolvePromotableCatalogAccess = vi.fn();
const readPromotableCatalogPage = vi.fn();
const readPromotableCatalogDetail = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});
const notFound = vi.fn(() => {
  throw new Error("notFound");
});

vi.mock("../src/server/account/page-session", () => ({ resolvePageSession }));
vi.mock("../src/server/db/client", () => ({ getPrisma: () => ({}) }));
vi.mock("../src/server/marketplace/promotable-catalog-read-service", () => ({
  resolvePromotableCatalogAccess,
  readPromotableCatalogPage,
  readPromotableCatalogDetail,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "monacado_session=opaque" }) }));
vi.mock("next/navigation", () => ({
  redirect,
  notFound,
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

const { default: PromotePage } = await import("../app/promote/page");
const { default: PromoteDetailPage } = await import("../app/promote/[productRef]/page");

const REF = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REF2 = "ZYXWVTSRQPNMKJHGFEDCBA9876543210";
const ALLOWED = { outcome: "ALLOWED", viewerParticipantId: "mon:mpart:VIEWER", canRequest: true, requestRefusals: [] };

const STANDARD = {
  wholesalePriceMinorUnits: 4000,
  currency: "USD",
  commission: { method: "PERCENT_OF_WHOLESALE" as const, commissionBasisPoints: 1000 },
  calculatedCommissionMinorUnits: 400,
};

const card = (over: Partial<PromotableCatalogCard> = {}): PromotableCatalogCard => {
  const base: PromotableCatalogCard = {
    productRef: REF,
    name: "Hand-thrown Stoneware Mug",
    sellerMName: "m7kx",
    summary: "14 oz artisan ceramic mug",
    deliveryMode: "PHYSICAL",
    terms: STANDARD,
    termsInForce: "STANDING",
    standardTerms: STANDARD,
    promotion: null,
    authorization: "NONE",
  };
  /* A card whose only terms are given as `terms` shows them as its standard terms. */
  return { ...base, ...(over.terms !== undefined && over.standardTerms === undefined ? { standardTerms: over.terms } : {}), ...over };
};

const text = (html: string) => html.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

async function renderList(search: Record<string, string> = {}) {
  return renderToStaticMarkup(await PromotePage({ searchParams: Promise.resolve(search) }));
}
async function renderDetail(productRef = REF) {
  return renderToStaticMarkup(await PromoteDetailPage({ params: Promise.resolve({ productRef }) }));
}

beforeEach(() => {
  for (const m of [resolvePageSession, resolvePromotableCatalogAccess, readPromotableCatalogPage, readPromotableCatalogDetail]) {
    m.mockReset();
  }
  redirect.mockClear();
  notFound.mockClear();
  resolvePageSession.mockResolvedValue({ accountId: "mon:acct:VIEWER" });
  resolvePromotableCatalogAccess.mockResolvedValue(ALLOWED);
});

describe("/promote", () => {
  it("redirects a signed-out visitor before reading anything", async () => {
    resolvePageSession.mockResolvedValue(undefined);
    await expect(renderList()).rejects.toThrow("redirect:/sign-in");
    expect(resolvePromotableCatalogAccess).not.toHaveBeenCalled();
  });

  it("tells an account that may not browse how to start, and reads no catalog", async () => {
    resolvePromotableCatalogAccess.mockResolvedValue({ outcome: "NOT_PROMOTER", requestRefusals: ["PROMOTER_ROLE_NOT_HELD"] });
    const t = text(await renderList());
    expect(t).toContain("The promotable catalog is for promoters");
    expect(readPromotableCatalogPage).not.toHaveBeenCalled();
  });

  it("renders each card: name (linked), Seller mName, one-line description, wholesale, actual commission — nothing else", async () => {
    readPromotableCatalogPage.mockResolvedValue({
      cards: [
        card(),
        card({
          productRef: REF2,
          name: "Pattern pack",
          sellerMName: "q4zz",
          summary: null,
          deliveryMode: "DIGITAL",
          terms: {
            wholesalePriceMinorUnits: 2500,
            currency: "USD",
            commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 500 },
            calculatedCommissionMinorUnits: 500,
          },
          authorization: "REQUESTED",
        }),
      ],
      nextCursor: null,
      cursorIgnored: false,
    });
    const html = await renderList();
    const t = text(html);
    expect(html).toContain(`href="/promote/${REF}"`);
    expect(t).toContain("Hand-thrown Stoneware Mug m7kx 14 oz artisan ceramic mug Wholesale $40.00 · Commission 10%");
    expect(t).toContain("Pattern pack q4zz Wholesale $25.00 · Commission $5.00 Request pending");
    expect(t).not.toMatch(/Commission \d+(\.\d+)?% \(|retail/i);
    expect(html).not.toContain("mon:");
    expect(t).not.toContain("Load more");
  });

  it("passes the parsed query to the reader, keeps the filters in the form, and offers load-more with the same query", async () => {
    readPromotableCatalogPage.mockResolvedValue({ cards: [card()], nextCursor: "abc_DEF-123", cursorIgnored: false });
    const html = await renderList({ q: "mug", delivery: "physical", wholesaleMax: "50", seller: "M7KX", sort: "COMMISSION_HIGH" });
    expect(readPromotableCatalogPage.mock.calls[0]![2]).toMatchObject({
      q: "mug",
      deliveryMode: "PHYSICAL",
      wholesaleMax: 5000,
      seller: "m7kx",
      sort: "COMMISSION_HIGH",
      cursor: null,
    });
    expect(html).toContain('value="mug"');
    expect(html).toContain('value="M7KX"');
    expect(html).toContain('<option value="COMMISSION_HIGH" selected="">Commission: highest</option>');
    expect(text(html)).toContain("Load more");
  });

  it("says when a filter was not understood, and shows the empty state", async () => {
    readPromotableCatalogPage.mockResolvedValue({ cards: [], nextCursor: null, cursorIgnored: false });
    const t = text(await renderList({ sort: "RANDOM" }));
    expect(t).toContain("Some filters weren&#x27;t understood");
    expect(t).toContain("No products match.");
  });
});

describe("/promote/{productRef}", () => {
  const detail = (over: Partial<PromotableCatalogDetail> = {}): PromotableCatalogDetail => ({
    ...card(),
    description: "14 oz artisan ceramic mug\nKiln-fired.",
    offerEffectiveUntil: null,
    termsAcceptance: null,
    ...over,
  });

  it("is a 404 for a malformed reference or a Product not in the catalog for this viewer", async () => {
    await expect(renderDetail("mon:product:X")).rejects.toThrow("notFound");
    readPromotableCatalogDetail.mockResolvedValue(null);
    await expect(renderDetail()).rejects.toThrow("notFound");
  });

  it("shows the Seller's mName with More from this seller by mName, the terms with commission as stated, and Request to Promote", async () => {
    readPromotableCatalogDetail.mockResolvedValue(detail());
    const html = await renderDetail();
    const t = text(html);
    expect(html).toContain('href="/promote?seller=m7kx"');
    expect(t).toContain("Seller: m7kx · More from this seller");
    expect(t).toContain("Wholesale $40.00 Commission per sale 10% ($4.00)");
    expect(t).toContain("Request to promote");
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain("mon:");
  });

  it("always shows the standard terms; a running promotion beside them, marked in force with its window; an upcoming one with its window", async () => {
    const standard = { ...STANDARD, wholesalePriceMinorUnits: 5000, calculatedCommissionMinorUnits: 500 };
    readPromotableCatalogDetail.mockResolvedValue(
      detail({
        termsInForce: "SCHEDULED_PROMOTION",
        terms: STANDARD,
        standardTerms: standard,
        promotion: { ...STANDARD, effectiveFrom: "2029-08-01T00:00:00.000Z", effectiveUntil: "2029-08-05T00:00:00.000Z", inForce: true },
      }),
    );
    const running = text(await renderDetail());
    expect(running).toContain("Standard terms Wholesale $50.00 Commission per sale 10% ($5.00)");
    expect(running).toContain("Promotional terms — in force now, Aug 1, 2029 to Aug 5, 2029 Wholesale $40.00 Commission per sale 10% ($4.00)");
    expect(running).toContain("The standard terms apply again when the promotion ends.");

    readPromotableCatalogDetail.mockResolvedValue(
      detail({
        promotion: {
          ...STANDARD,
          wholesalePriceMinorUnits: 3000,
          calculatedCommissionMinorUnits: 300,
          effectiveFrom: "2029-09-01T00:00:00.000Z",
          effectiveUntil: "2029-09-08T00:00:00.000Z",
          inForce: false,
        },
        offerEffectiveUntil: "2029-12-31T00:00:00.000Z",
      }),
    );
    const upcoming = text(await renderDetail());
    expect(upcoming).toContain("Standard terms Wholesale $40.00");
    expect(upcoming).toContain("Upcoming promotional terms — Sep 1, 2029 to Sep 8, 2029 Wholesale $30.00 Commission per sale 10% ($3.00)");
    expect(upcoming).toContain("This offer ends Dec 31, 2029.");
    // The terms are presented, never characterized.
    for (const word of [/better/i, /worse/i, /favou?rable/i, /improve/i, /concession/i, /deal\b/i, /save/i]) {
      expect(running).not.toMatch(word);
      expect(upcoming).not.toMatch(word);
    }
  });

  it("says why a Promoter cannot request yet, with the button disabled; an open request shows its state instead", async () => {
    resolvePromotableCatalogAccess.mockResolvedValue({
      ...ALLOWED,
      canRequest: false,
      requestRefusals: ["EMAIL_UNVERIFIED"],
    });
    readPromotableCatalogDetail.mockResolvedValue(detail());
    const html = await renderDetail();
    expect(text(html)).toContain("Before you can ask to promote products: verify your email address.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Request to promote<\/button>/);

    resolvePromotableCatalogAccess.mockResolvedValue(ALLOWED);
    readPromotableCatalogDetail.mockResolvedValue(detail({ authorization: "APPROVED" }));
    const approved = await renderDetail();
    expect(text(approved)).toContain("Approved to promote");
    expect(approved).not.toContain("<button");
  });

  it("1.44 — an APPROVED Promoter sees the exact package and ONE accept button: standard only, or standard + promotional", async () => {
    const ACC_REF = "ACCAUTHREF0000000000000000000000";
    const plain = (html: string) => text(html).replaceAll("&#x27;", "'");
    const standing = { ...STANDARD, version: "3", commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1" as const };
    const view = {
      authorizationRef: ACC_REF,
      offerRef: REF2,
      standing,
      promotion: null,
      acceptedAt: null,
      hadEarlierAcceptance: false,
      inForceCovered: false,
    };
    readPromotableCatalogDetail.mockResolvedValue(detail({ authorization: "APPROVED", termsAcceptance: view }));
    const standardOnly = await renderDetail();
    expect(plain(standardOnly)).toContain("Accept the seller's terms");
    expect(plain(standardOnly)).toContain("You haven't accepted these terms yet.");
    expect(plain(standardOnly)).toContain("Terms version 3");
    expect(standardOnly.match(/<button/g)).toHaveLength(1);
    expect(standardOnly).toMatch(/<button[^>]*>Accept standard terms<\/button>/);

    const promotion = {
      ...standing,
      version: "4",
      wholesalePriceMinorUnits: 3000,
      calculatedCommissionMinorUnits: 300,
      effectiveFrom: "2029-09-01T00:00:00.000Z",
      effectiveUntil: "2029-09-08T00:00:00.000Z",
      inForce: false,
    };
    readPromotableCatalogDetail.mockResolvedValue(
      detail({ authorization: "APPROVED", termsAcceptance: { ...view, promotion, inForceCovered: true } }),
    );
    const pkg = await renderDetail();
    const t = plain(pkg);
    expect(pkg.match(/<button/g)).toHaveLength(1);
    expect(pkg).toMatch(/<button[^>]*>Accept standard \+ promotional terms<\/button>/);
    expect(pkg).not.toMatch(/>Accept standard terms</);
    expect(t).toContain("Terms version 3");
    expect(t).toContain("Terms version 4");
    expect(t).toContain("need your acceptance, together with the standard terms");
    for (const word of [/better/i, /worse/i, /favou?rable/i, /improve/i, /concession/i]) expect(t).not.toMatch(word);
    // The cycle reference is an action value, never rendered; no seller proceeds or retail price.
    expect(pkg).not.toContain(ACC_REF);
    expect(t).not.toMatch(/proceeds/i);
    expect(t).not.toMatch(/\$\d[^ ]* retail/i);

    readPromotableCatalogDetail.mockResolvedValue(
      detail({ authorization: "APPROVED", termsAcceptance: { ...view, promotion, acceptedAt: "2029-08-20T00:00:00.000Z" } }),
    );
    const accepted = await renderDetail();
    expect(plain(accepted)).toContain("You accepted the standard + promotional terms on Aug 20, 2029. The promotional terms start Sep 1, 2029.");
    expect(accepted).not.toContain("<button");

    // The promotion ended: S resumes, covered by the {S, P} acceptance — no "changed", no button.
    readPromotableCatalogDetail.mockResolvedValue(
      detail({ authorization: "APPROVED", termsAcceptance: { ...view, hadEarlierAcceptance: true, inForceCovered: true } }),
    );
    const resumed = await renderDetail();
    expect(plain(resumed)).toContain("your acceptance of the standard + promotional terms included them. No new acceptance is needed.");
    expect(plain(resumed)).not.toContain("terms have changed");
    expect(resumed).not.toContain("<button");

    // A genuinely new standing version is not covered: it still asks.
    readPromotableCatalogDetail.mockResolvedValue(
      detail({ authorization: "APPROVED", termsAcceptance: { ...view, hadEarlierAcceptance: true, inForceCovered: false } }),
    );
    const changed = await renderDetail();
    expect(plain(changed)).toContain("The seller's terms have changed. The new terms need your acceptance.");
    expect(changed).toMatch(/<button[^>]*>Accept standard terms<\/button>/);
  });
});
