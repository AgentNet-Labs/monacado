/**
 * `/account` presentation and the browser half of Seller/Promoter setup.
 *
 * NO DATABASE, NO NETWORK. The session resolver, the account-home reader,
 * request headers, and router are replaced so the page renders as it would for a
 * live session; what those readers return from real rows is proved by
 * `participant-onboarding.integration.test.ts`, and sign-out submission by
 * `auth-ui-submission.test.ts`.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountHome } from "../src/server/account/account-home";

/* Vitest compiles JSX (the page's included) to `React.createElement` against a
   global `React`, where Next uses the automatic runtime. Provide it here rather
   than change the transform for every test. */
(globalThis as { React?: typeof React }).React = React;

const ACCOUNT_ID = "mon:acct:01TESTACCOUNTIDENTIFIER00";

const resolvePageSession = vi.fn();
const readAccountHome = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});

vi.mock("../src/server/account/page-session", () => ({ resolvePageSession }));
vi.mock("../src/server/account/account-home", () => ({ readAccountHome }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "monacado_session=opaque" }),
}));
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

const { default: AccountPage } = await import("../app/account/page");
const {
  ONBOARDING_CLOSED,
  ONBOARDING_ENDPOINT,
  ONBOARDING_FAILURE,
  ONBOARDING_NO_ROLE_CHOSEN,
  ONBOARDING_SIGNED_OUT,
  submitOnboarding,
} = await import("../app/account/onboarding-submission");
const {
  STOREFRONT_ENDPOINT,
  STOREFRONT_FAILURE,
  STOREFRONT_HANDLE_TAKEN,
  STOREFRONT_INVALID,
  STOREFRONT_UPGRADE_REQUIRED,
  STOREFRONT_NOT_ELIGIBLE,
  STOREFRONT_SIGNED_OUT,
  submitDraftStorefront,
} = await import("../app/account/storefront-submission");
const {
  PRESENTATION_CONFLICT,
  PRESENTATION_FAILURE,
  PRESENTATION_INVALID,
  PRESENTATION_NOT_EDITABLE,
  PRESENTATION_SIGNED_OUT,
  PRESENTATION_UNCHANGED,
  storefrontPresentationEndpoint,
  submitStorefrontPresentation,
} = await import("../app/account/storefront-presentation-submission");
const {
  PRODUCT_ENDPOINT,
  PRODUCT_FAILURE,
  PRODUCT_INVALID,
  PRODUCT_NOT_ELIGIBLE,
  PRODUCT_SIGNED_OUT,
  PRODUCT_UPGRADE_REQUIRED,
  submitDraftProduct,
} = await import("../app/account/product-submission");

const DRAFT_SELLER: AccountHome["marketplace"] = {
  status: "DRAFT",
  roles: [{ role: "SELLER", status: "DRAFT" }],
  onboardingOpen: true,
};

function home(overrides: Partial<AccountHome> = {}): AccountHome {
  return {
    name: "Ada Seller",
    email: "ada@example.com",
    emailVerified: true,
    marketplace: null,
    setupRolesAvailable: ["SELLER", "PROMOTER"],
    storefronts: [],
    canCreateStorefront: false,
    storefrontUpgradeRequired: false,
    products: [],
    canCreateProduct: false,
    productUpgradeRequired: false,
    ...overrides,
  };
}

async function renderSignedIn(value: AccountHome): Promise<string> {
  resolvePageSession.mockResolvedValue({ accountId: ACCOUNT_ID });
  readAccountHome.mockResolvedValue(value);
  return renderToStaticMarkup(await AccountPage());
}

describe("/account presentation", () => {
  beforeEach(() => {
    resolvePageSession.mockReset();
    readAccountHome.mockReset();
    redirect.mockClear();
  });

  it("shows name, email, and verified status, reads the home by the session's account, and hides the id", async () => {
    const html = await renderSignedIn(home());

    expect(readAccountHome).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(html).toContain("<h1>Monacado</h1>");
    expect(html).toContain("You are signed in.");
    expect(html).toContain("<dd>Ada Seller</dd>");
    expect(html).toContain("<dd>ada@example.com</dd>");
    expect(html).toContain("<dd>Verified</dd>");
    expect(html).not.toContain("Email not verified");
    expect(html).toContain("Sign out");
    expect(html).not.toContain(ACCOUNT_ID);
    expect(html).not.toContain("mon:acct:");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("shows an unverified address plainly and still offers setup", async () => {
    const html = await renderSignedIn(home({ emailVerified: false }));

    expect(html).toContain("<dd>Email not verified</dd>");
    expect(html).toContain("must be verified before anything you set up can go live");
    expect(html).toContain("Start setup");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("offers Seller and Promoter setup to an account that has not started", async () => {
    const html = await renderSignedIn(home());

    expect(html).toContain("Sell or promote on Monacado");
    expect(html).toContain('value="SELLER"');
    expect(html).toContain('value="PROMOTER"');
    expect(html).not.toContain('value="BUYER"');
    expect(html).toContain("Start setup");
  });

  it("shows setup in progress and offers only the role not yet started", async () => {
    const html = await renderSignedIn(
      home({
        marketplace: {
          status: "DRAFT",
          roles: [{ role: "SELLER", status: "DRAFT" }],
          onboardingOpen: true,
        },
        setupRolesAvailable: ["PROMOTER"],
      }),
    );

    expect(html).toContain("Marketplace status: Setup in progress");
    expect(html).toContain("Seller — Setup in progress");
    expect(html).not.toContain('value="SELLER"');
    expect(html).toContain('value="PROMOTER"');
    expect(html).toContain("Add to setup");
  });

  it("offers no setup control once the participant is out of drafting", async () => {
    const html = await renderSignedIn(
      home({
        marketplace: {
          status: "UNDER_REVIEW",
          roles: [{ role: "SELLER", status: "PENDING_ACTIVATION" }],
          onboardingOpen: false,
        },
        setupRolesAvailable: [],
      }),
    );

    expect(html).toContain("Marketplace status: Under review");
    expect(html).toContain("Seller — Awaiting approval");
    expect(html).not.toContain('value="PROMOTER"');
    expect(html).not.toContain("Add to setup");
    expect(html).toContain("Sign out");
  });

  it("offers a draft storefront to an eligible participant that has none", async () => {
    const html = await renderSignedIn(
      home({ marketplace: DRAFT_SELLER, setupRolesAvailable: ["PROMOTER"], canCreateStorefront: true }),
    );

    expect(html).toContain("<h2 id=\"account-storefront-heading\">Storefront</h2>");
    expect(html).toContain("Create a private draft storefront");
    expect(html).toContain('name="displayName"');
    expect(html).toContain('name="publicHandle"');
    expect(html).toContain("Create draft storefront");
  });

  it("shows the included draft by name, state, and handle, then says more need an upgrade", async () => {
    const html = await renderSignedIn(
      home({
        marketplace: DRAFT_SELLER,
        setupRolesAvailable: ["PROMOTER"],
        canCreateStorefront: false,
        storefrontUpgradeRequired: true,
        storefronts: [
          {
            displayName: "Ada's Workshop",
            tagline: "Small-batch ceramics",
            summary: "Made by hand in Leeds.",
            publicHandle: "ada-workshop",
            lifecycle: "DRAFT",
            visibility: "PRIVATE",
            canEditPresentation: true,
          },
        ],
      }),
    );
    const text = html.replaceAll("<!-- -->", "");

    expect(text).toContain("Ada&#x27;s Workshop");
    expect(text).toContain(" — Draft · Private");
    expect(text).toContain("Handle: ada-workshop");
    expect(html).not.toContain('name="publicHandle"');
    expect(html).toContain("Additional storefronts require an upgrade.");
    expect(html).not.toContain("mon:");
  });

  it("shows tagline and summary, and an editor for name, tagline, and summary — never the handle", async () => {
    const html = await renderSignedIn(
      home({
        marketplace: DRAFT_SELLER,
        storefrontUpgradeRequired: true,
        storefronts: [
          {
            displayName: "Ada's Workshop",
            tagline: "Small-batch ceramics",
            summary: "Made by hand in Leeds.",
            publicHandle: "ada-workshop",
            lifecycle: "DRAFT",
            visibility: "PRIVATE",
            canEditPresentation: true,
          },
        ],
      }),
    );
    const text = html.replaceAll("<!-- -->", "");

    expect(text).toContain("Small-batch ceramics");
    expect(text).toContain("Made by hand in Leeds.");
    expect(text).toContain("Edit storefront details");
    /* Prefilled from the current version. */
    expect(html).toMatch(/name="displayName"[^>]*value="Ada&#x27;s Workshop"/);
    expect(html).toMatch(/name="tagline"[^>]*value="Small-batch ceramics"/);
    expect(html).toContain('name="summary"');
    expect(text).toContain("Made by hand in Leeds.</textarea>");
    /* The handle is shown, and there is no field for it. */
    expect(text).toContain("Handle: ada-workshop. The handle can&#x27;t be changed yet.");
    expect(html).not.toContain('name="publicHandle"');
    expect(text).toContain("Leave one blank to remove it.");
    expect(html).not.toContain("mon:");
  });

  it("offers no editor when the page may not edit the Storefront", async () => {
    const html = await renderSignedIn(
      home({
        marketplace: DRAFT_SELLER,
        storefrontUpgradeRequired: true,
        storefronts: [
          {
            displayName: "Closed Shop",
            tagline: null,
            summary: null,
            publicHandle: "closed-shop",
            lifecycle: "CLOSED",
            visibility: "PRIVATE",
            canEditPresentation: false,
          },
        ],
      }),
    );

    expect(html).toContain("Closed Shop");
    expect(html).not.toContain("Edit storefront details");
    expect(html).not.toContain('name="tagline"');
  });

  it("shows no storefront section to an account that cannot draft one and has none", async () => {
    const html = await renderSignedIn(home());

    expect(html).not.toContain("account-storefront-heading");
    expect(html).not.toContain("Create draft storefront");
  });

  it("offers a Seller a draft Product form with only the creator's facts", async () => {
    const html = await renderSignedIn(home({ marketplace: DRAFT_SELLER, canCreateProduct: true }));

    expect(html).toContain('<h2 id="account-product-heading">Products</h2>');
    expect(html).toContain("Drafts are not listed and not for sale.");
    for (const field of ['name="name"', 'name="description"', 'name="deliveryMode"', 'name="generalAvailabilityState"', 'name="promotable"']) {
      expect(html).toContain(field);
    }
    expect(html).toContain('value="DIGITAL"');
    expect(html).toContain('value="PHYSICAL"');
    /* No commercial or placement field, and no delivery chosen for the creator. */
    for (const absent of ["price", "commission", "discount", 'name="storefront"', "checked=\"\" value=\"DIGITAL\"", "checked=\"\" value=\"PHYSICAL\""]) {
      expect(html).not.toContain(absent);
    }
    expect(html).toContain("Add draft product");
  });

  it("lists draft Products as not for sale, with no identifiers", async () => {
    const html = await renderSignedIn(
      home({
        marketplace: DRAFT_SELLER,
        canCreateProduct: true,
        products: [
          {
            name: "Hand-thrown mug",
            description: "Stoneware, 350 ml.",
            promotable: true,
            generalAvailabilityState: "available",
            deliveryMode: "PHYSICAL",
            recordStatus: "draft",
          },
        ],
      }),
    );
    const text = html.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, "");

    expect(text).toContain("Hand-thrown mug — Draft · Not listed for sale");
    expect(text).toContain("Physical (shipped) · Available · Promoters may feature it");
    expect(text).toContain("Stoneware, 350 ml.");
    expect(html).not.toContain("mon:");
  });

  it("keeps the Products listed but offers no form once the free plan's Products are used", async () => {
    const draft = {
      description: null,
      promotable: false,
      generalAvailabilityState: "available" as const,
      deliveryMode: "DIGITAL" as const,
      recordStatus: "draft" as const,
    };
    const html = await renderSignedIn(
      home({
        marketplace: DRAFT_SELLER,
        canCreateProduct: false,
        productUpgradeRequired: true,
        products: [1, 2, 3, 4, 5].map((n) => ({ ...draft, name: `Product ${n}` })),
      }),
    );

    expect(html).toContain("Product 5");
    expect(html).toContain("Additional products require an upgrade.");
    expect(html).not.toContain("Add draft product");
    expect(html).not.toContain('name="deliveryMode"');
    expect(html).not.toContain("mon:");
  });

  it("offers the form, and no upgrade note, below the allowance", async () => {
    const html = await renderSignedIn(home({ marketplace: DRAFT_SELLER, canCreateProduct: true }));
    expect(html).toContain("Add draft product");
    expect(html).not.toContain("Additional products require an upgrade.");
  });

  it("gives a Promoter-only account no Product section", async () => {
    const html = await renderSignedIn(
      home({
        marketplace: { status: "DRAFT", roles: [{ role: "PROMOTER", status: "DRAFT" }], onboardingOpen: true },
        setupRolesAvailable: ["SELLER"],
        canCreateStorefront: true,
        canCreateProduct: false,
      }),
    );

    expect(html).not.toContain("account-product-heading");
    expect(html).not.toContain("Add draft product");
    /* The Storefront and onboarding sections are untouched. */
    expect(html).toContain("account-storefront-heading");
    expect(html).toContain("Sell or promote on Monacado");
  });

  it("still sends a visitor without a session to sign-in", async () => {
    resolvePageSession.mockResolvedValue(undefined);

    await expect(AccountPage()).rejects.toThrow("redirect:/sign-in");
    expect(readAccountHome).not.toHaveBeenCalled();
  });

  it("treats a session whose account has since gone as signed out", async () => {
    resolvePageSession.mockResolvedValue({ accountId: ACCOUNT_ID });
    readAccountHome.mockResolvedValue(undefined);

    await expect(AccountPage()).rejects.toThrow("redirect:/sign-in");
  });
});

describe("Seller/Promoter setup submission", () => {
  function captureFetch(reply: Response | (() => never)) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      if (typeof reply === "function") reply();
      return reply;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends exactly the chosen roles and nothing else", async () => {
    const { calls, fetchImpl } = captureFetch(json(200, { status: "DRAFT", roles: [] }));

    expect(await submitOnboarding(["SELLER", "PROMOTER"], { fetchImpl })).toEqual({
      outcome: "started",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ONBOARDING_ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ roles: ["SELLER", "PROMOTER"] });
  });

  it("asks for a choice before sending anything", async () => {
    const { calls, fetchImpl } = captureFetch(json(200, {}));

    expect(await submitOnboarding([], { fetchImpl })).toEqual({
      outcome: "failed",
      message: ONBOARDING_NO_ROLE_CHOSEN,
    });
    expect(calls).toHaveLength(0);
  });

  it("maps every refusal onto bounded copy", async () => {
    const cases: Array<[Response | (() => never), string]> = [
      [json(409, { error: "PARTICIPANT_ONBOARDING_CLOSED" }), ONBOARDING_CLOSED],
      [json(401, { error: "UNAUTHENTICATED" }), ONBOARDING_SIGNED_OUT],
      [json(409, { error: "PARTICIPANT_ONBOARDING_CONFLICT" }), ONBOARDING_FAILURE],
      [json(500, { error: "anything the server says" }), ONBOARDING_FAILURE],
      [new Response("not json", { status: 502 }), ONBOARDING_FAILURE],
      [
        () => {
          throw new TypeError("network");
        },
        ONBOARDING_FAILURE,
      ],
    ];
    for (const [reply, message] of cases) {
      const { fetchImpl } = captureFetch(reply);
      expect(await submitOnboarding(["SELLER"], { fetchImpl })).toEqual({
        outcome: "failed",
        message,
      });
    }
  });
});

describe("draft storefront submission", () => {
  function captureFetch(reply: Response | (() => never)) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      if (typeof reply === "function") reply();
      return reply;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends exactly the name and handle typed, unaltered", async () => {
    const { calls, fetchImpl } = captureFetch(json(201, {}));

    expect(
      await submitDraftStorefront({ displayName: " Ada's ", publicHandle: "Ada-Shop" }, { fetchImpl }),
    ).toEqual({ outcome: "created" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(STOREFRONT_ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      displayName: " Ada's ",
      publicHandle: "Ada-Shop",
    });
  });

  it("maps every refusal onto bounded copy", async () => {
    const cases: Array<[Response | (() => never), string]> = [
      [json(400, { error: "INVALID_STOREFRONT_REQUEST" }), STOREFRONT_INVALID],
      [json(409, { error: "STOREFRONT_HANDLE_UNAVAILABLE" }), STOREFRONT_HANDLE_TAKEN],
      [json(403, { error: "STOREFRONT_NOT_ELIGIBLE" }), STOREFRONT_NOT_ELIGIBLE],
      [json(409, { error: "STOREFRONT_UPGRADE_REQUIRED" }), STOREFRONT_UPGRADE_REQUIRED],
      [json(401, { error: "UNAUTHENTICATED" }), STOREFRONT_SIGNED_OUT],
      [json(403, { error: "CROSS_ORIGIN_REQUEST_REFUSED" }), STOREFRONT_FAILURE],
      [json(500, { error: "anything the server says" }), STOREFRONT_FAILURE],
      [new Response("not json", { status: 502 }), STOREFRONT_FAILURE],
      [
        () => {
          throw new TypeError("network");
        },
        STOREFRONT_FAILURE,
      ],
    ];
    for (const [reply, message] of cases) {
      const { fetchImpl } = captureFetch(reply);
      expect(
        await submitDraftStorefront({ displayName: "Shop", publicHandle: "shop" }, { fetchImpl }),
      ).toEqual({ outcome: "failed", message });
    }
  });
});

describe("storefront presentation submission", () => {
  function captureFetch(reply: Response | (() => never)) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      if (typeof reply === "function") reply();
      return reply;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the complete presentation to the handle's endpoint, blank optional fields as null", async () => {
    const { calls, fetchImpl } = captureFetch(json(200, {}));

    expect(
      await submitStorefrontPresentation(
        "ada-workshop",
        { displayName: "Ada's", tagline: "   ", summary: "About." },
        { fetchImpl },
      ),
    ).toEqual({ outcome: "saved" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/storefronts/ada-workshop/presentation");
    expect(storefrontPresentationEndpoint("a b")).toBe("/api/storefronts/a%20b/presentation");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      displayName: "Ada's",
      tagline: null,
      summary: "About.",
    });
  });

  it("reports a no-op as unchanged, and every refusal as bounded copy", async () => {
    const unchanged = captureFetch(json(409, { error: "STOREFRONT_PRESENTATION_UNCHANGED" }));
    expect(
      await submitStorefrontPresentation("shop", { displayName: "A", tagline: "", summary: "" }, {
        fetchImpl: unchanged.fetchImpl,
      }),
    ).toEqual({ outcome: "unchanged", message: PRESENTATION_UNCHANGED });

    const cases: Array<[Response | (() => never), string]> = [
      [json(400, { error: "INVALID_STOREFRONT_PRESENTATION_REQUEST" }), PRESENTATION_INVALID],
      [json(409, { error: "STOREFRONT_EDIT_CONFLICT" }), PRESENTATION_CONFLICT],
      [json(403, { error: "STOREFRONT_NOT_EDITABLE" }), PRESENTATION_NOT_EDITABLE],
      [json(404, { error: "STOREFRONT_NOT_FOUND" }), PRESENTATION_NOT_EDITABLE],
      [json(401, { error: "UNAUTHENTICATED" }), PRESENTATION_SIGNED_OUT],
      [json(403, { error: "CROSS_ORIGIN_REQUEST_REFUSED" }), PRESENTATION_FAILURE],
      [json(500, { error: "anything" }), PRESENTATION_FAILURE],
      [new Response("not json", { status: 502 }), PRESENTATION_FAILURE],
      [
        () => {
          throw new TypeError("network");
        },
        PRESENTATION_FAILURE,
      ],
    ];
    for (const [reply, message] of cases) {
      const { fetchImpl } = captureFetch(reply);
      expect(
        await submitStorefrontPresentation("shop", { displayName: "A", tagline: "", summary: "" }, { fetchImpl }),
      ).toEqual({ outcome: "failed", message });
    }
  });
});

describe("draft Product submission", () => {
  function captureFetch(reply: Response | (() => never)) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      if (typeof reply === "function") reply();
      return reply;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fields = {
    name: "Mug",
    description: "   ",
    promotable: false,
    generalAvailabilityState: "available" as const,
    deliveryMode: "PHYSICAL" as const,
  };

  it("sends exactly the creator's facts, a blank description as null", async () => {
    const { calls, fetchImpl } = captureFetch(json(201, {}));

    expect(await submitDraftProduct(fields, { fetchImpl })).toEqual({ outcome: "created" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(PRODUCT_ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      name: "Mug",
      description: null,
      promotable: false,
      generalAvailabilityState: "available",
      deliveryMode: "PHYSICAL",
    });
  });

  it("asks for a delivery type before sending anything", async () => {
    const { calls, fetchImpl } = captureFetch(json(201, {}));
    expect(await submitDraftProduct({ ...fields, deliveryMode: null }, { fetchImpl })).toEqual({
      outcome: "failed",
      message: PRODUCT_INVALID,
    });
    expect(calls).toHaveLength(0);
  });

  it("maps every refusal onto bounded copy", async () => {
    const cases: Array<[Response | (() => never), string]> = [
      [json(400, { error: "INVALID_PRODUCT_REQUEST" }), PRODUCT_INVALID],
      [json(403, { error: "PRODUCT_NOT_ELIGIBLE" }), PRODUCT_NOT_ELIGIBLE],
      [json(409, { error: "PRODUCT_UPGRADE_REQUIRED" }), PRODUCT_UPGRADE_REQUIRED],
      [json(401, { error: "UNAUTHENTICATED" }), PRODUCT_SIGNED_OUT],
      [json(403, { error: "CROSS_ORIGIN_REQUEST_REFUSED" }), PRODUCT_FAILURE],
      [json(409, { error: "PRODUCT_CREATE_CONFLICT" }), PRODUCT_FAILURE],
      [new Response("not json", { status: 502 }), PRODUCT_FAILURE],
      [
        () => {
          throw new TypeError("network");
        },
        PRODUCT_FAILURE,
      ],
    ];
    for (const [reply, message] of cases) {
      const { fetchImpl } = captureFetch(reply);
      expect(await submitDraftProduct(fields, { fetchImpl })).toEqual({ outcome: "failed", message });
    }
  });
});
