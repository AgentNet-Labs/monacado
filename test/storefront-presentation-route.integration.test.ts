/**
 * Phase 1.31 — editing a draft Storefront's presentation, against a real database.
 *
 * Proves the route and `editStorefrontPresentation` together: each material edit
 * mints exactly the next immutable version and advances the pointer, earlier
 * versions are untouched, a no-op mints nothing, `null` clears an optional
 * field, handle / lifecycle / visibility / governance never move, the domain's
 * presentation authority decides who may edit (SUPER_OWNER and ADMIN yes; an
 * unrelated account, an ungoverned owner, or anyone on a CLOSED Storefront no),
 * concurrent edits never overwrite each other silently, and nothing past a draft
 * is written.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  assignStorefrontGovernance,
  createDraftStorefront,
  createStorefrontSourceVersion,
  nextStorefrontSourceRecordVersion,
  openOwnedDraftStorefront,
} from "../src/server/marketplace/storefront-service";
import {
  STOREFRONT_PRESENTATION_ROUTE_ERROR_CODES as CODES,
  handleEditStorefrontPresentationRequest,
} from "../src/server/marketplace/storefront-presentation-route-handler";
import type { MarketplaceRole } from "../src/contracts/marketplace/participant";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-06-01T09:00:00.000Z";
const LATER = "2028-06-02T09:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const EMAIL_PREFIX = "p131edit";
const HANDLE_PREFIX = "p131-shop";
const ORIGIN = "https://monacado.test";

let seq = 0;

async function cleanup(): Promise<void> {
  const accountIds = (
    await db.account.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } })
  ).map((a) => a.id);
  if (accountIds.length === 0) return;
  const participantIds = (
    await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    })
  ).map((p) => p.id);
  if (participantIds.length > 0) {
    const storefrontIds = (
      await db.storefront.findMany({
        where: { ownerParticipantId: { in: participantIds } },
        select: { internalStorefrontId: true },
      })
    ).map((s) => s.internalStorefrontId);
    await db.storefrontGovernanceAssignment.deleteMany({
      where: {
        OR: [
          { participantId: { in: participantIds } },
          { internalStorefrontId: { in: storefrontIds } },
        ],
      },
    });
    await db.storefrontSourceRecordVersionRow.deleteMany({
      where: { internalStorefrontId: { in: storefrontIds } },
    });
    await db.storefront.deleteMany({ where: { internalStorefrontId: { in: storefrontIds } } });
    await db.marketplaceRoleAssignment.deleteMany({ where: { participantId: { in: participantIds } } });
    await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  }
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

/** A real UNVERIFIED account and session, with a DRAFT participant holding `roles` — or none. */
async function signIn(roles: MarketplaceRole[] | null) {
  seq += 1;
  const account = await createAccount(
    { name: "Editor", email: `${EMAIL_PREFIX}${seq}@example.com`, password: PASSWORD, createdAt: NOW },
    { db },
  );
  const participant =
    roles === null
      ? null
      : await createDraftParticipant({ accountId: account.accountId, initialRoles: roles, now: NOW }, { db });
  const { token } = await createAccountSession(
    { accountId: account.accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 },
    { db },
  );
  return {
    accountId: account.accountId,
    participantId: participant?.participant.participantId ?? null,
    cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
  };
}

/** A Seller with an included draft Storefront, opened exactly as Phase 1.30 does. */
async function ownerWithStorefront() {
  const owner = await signIn(["SELLER"]);
  const publicHandle = `${HANDLE_PREFIX}-${seq}`;
  const opened = await openOwnedDraftStorefront(
    {
      publicHandle,
      presentation: { displayName: "Original", tagline: "First tagline", summary: null },
      actingAccountId: owner.accountId,
      now: NOW,
    },
    { db },
  );
  return { owner, publicHandle, internalStorefrontId: opened.storefront.record.internalStorefrontId };
}

function edit(
  cookieHeader: string | null,
  publicHandle: string,
  body: unknown,
  overrides: { originHeader?: string | null } = {},
) {
  return handleEditStorefrontPresentationRequest(
    {
      publicHandle,
      contentType: "application/json",
      originHeader: overrides.originHeader === undefined ? ORIGIN : overrides.originHeader,
      cookieHeader,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, now: () => LATER, appOrigin: ORIGIN },
  );
}

const versionsOf = (internalStorefrontId: string) =>
  db.storefrontSourceRecordVersionRow.findMany({ where: { internalStorefrontId }, orderBy: { seq: "asc" } });

const describeDb = RUN ? describe : describe.skip;

describe("next version label", () => {
  it("counts up from positive integers and refuses anything else", () => {
    expect(nextStorefrontSourceRecordVersion("1")).toBe("2");
    expect(nextStorefrontSourceRecordVersion("41")).toBe("42");
    for (const label of ["0", "01", "v1", "1.0", "", "-1"]) {
      expect(nextStorefrontSourceRecordVersion(label)).toBeUndefined();
    }
  });
});

describeDb("1.31 — edit draft Storefront presentation", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanup();
    await disconnectPrisma();
  });

  it("mints v2 then v3 from the SUPER_OWNER's edits, leaving earlier versions and everything else untouched", async () => {
    const { owner, publicHandle, internalStorefrontId } = await ownerWithStorefront();
    const [v1Before] = await versionsOf(internalStorefrontId);
    const governanceBefore = await db.storefrontGovernanceAssignment.findMany({ where: { internalStorefrontId } });

    const first = await edit(owner.cookieHeader, publicHandle, {
      displayName: "Renamed",
      tagline: "Better tagline",
      summary: "Hand-made goods.",
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      publicHandle,
      displayName: "Renamed",
      tagline: "Better tagline",
      summary: "Hand-made goods.",
      lifecycle: "DRAFT",
      visibility: "PRIVATE",
    });
    expect(JSON.stringify(first.body)).not.toMatch(/mon:/);

    /* `null` clears. */
    const second = await edit(owner.cookieHeader, publicHandle, {
      displayName: "Renamed",
      tagline: null,
      summary: "Hand-made goods.",
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ tagline: null, summary: "Hand-made goods." });

    const versions = await versionsOf(internalStorefrontId);
    expect(
      versions.map((v) => [
        v.sourceRecordVersion,
        v.supersedesSourceRecordVersion,
        v.presentationDisplayName,
        v.presentationTagline,
        v.presentationSummary,
        v.publicHandle,
        v.lifecycle,
        v.visibility,
        v.authorizedByActorId,
      ]),
    ).toEqual([
      ["1", null, "Original", "First tagline", null, publicHandle, "DRAFT", "PRIVATE", owner.accountId],
      ["2", "1", "Renamed", "Better tagline", "Hand-made goods.", publicHandle, "DRAFT", "PRIVATE", owner.accountId],
      ["3", "2", "Renamed", null, "Hand-made goods.", publicHandle, "DRAFT", "PRIVATE", owner.accountId],
    ]);
    /* Version 1 is the very row it was, byte for byte. */
    expect(versions[0]).toEqual(v1Before);

    const stable = await db.storefront.findUnique({ where: { internalStorefrontId } });
    expect([stable!.currentSourceRecordVersion, stable!.publicHandle, stable!.lifecycle, stable!.visibility]).toEqual([
      "3",
      publicHandle,
      "DRAFT",
      "PRIVATE",
    ]);
    expect(stable!.ownerParticipantId).toBe(owner.participantId);
    expect(await db.storefrontGovernanceAssignment.findMany({ where: { internalStorefrontId } })).toEqual(
      governanceBefore,
    );

    /* A draft and nothing more. */
    const participantId = owner.participantId!;
    expect((await db.marketplaceParticipant.findUnique({ where: { id: participantId } }))!.status).toBe("DRAFT");
    expect(await db.participantActivation.count({ where: { participantId } })).toBe(0);
    expect(await db.participantPaymentAccount.count({ where: { participantId } })).toBe(0);
    expect(await db.participantCommerceApproval.count({ where: { participantId } })).toBe(0);
    expect((await db.account.findUnique({ where: { id: owner.accountId } }))!.emailVerifiedAt).toBeNull();
  });

  it("refuses a no-op, including one that differs only in surrounding whitespace, and mints nothing", async () => {
    const { owner, publicHandle, internalStorefrontId } = await ownerWithStorefront();

    for (const body of [
      { displayName: "Original", tagline: "First tagline", summary: null },
      { displayName: "  Original ", tagline: " First tagline", summary: null },
    ]) {
      expect(await edit(owner.cookieHeader, publicHandle, body)).toMatchObject({
        status: 409,
        body: { error: CODES.unchanged },
      });
    }
    expect((await versionsOf(internalStorefrontId)).map((v) => v.sourceRecordVersion)).toEqual(["1"]);
    expect((await db.storefront.findUnique({ where: { internalStorefrontId } }))!.currentSourceRecordVersion).toBe("1");
  });

  it("lets an ADMIN appointed by the SUPER_OWNER edit, recorded as the ADMIN's act", async () => {
    const { owner, publicHandle, internalStorefrontId } = await ownerWithStorefront();
    const admin = await signIn(["PROMOTER"]);
    await assignStorefrontGovernance(
      { internalStorefrontId, participantId: admin.participantId!, role: "ADMIN", actingAccountId: owner.accountId, now: NOW },
      { db },
    );

    const result = await edit(admin.cookieHeader, publicHandle, {
      displayName: "Admin copy",
      tagline: null,
      summary: null,
    });

    expect(result.status).toBe(200);
    const latest = (await versionsOf(internalStorefrontId)).at(-1)!;
    expect([latest.sourceRecordVersion, latest.authorizedByActorId, latest.authorizedByParticipantId]).toEqual([
      "2",
      admin.accountId,
      admin.participantId,
    ]);
    expect(latest.ownerParticipantId).toBe(owner.participantId);
  });

  it("gives the same 404 for a missing Storefront and for one the caller has no authority over", async () => {
    const { publicHandle, internalStorefrontId } = await ownerWithStorefront();
    const stranger = await signIn(["SELLER"]);
    const bare = await signIn(null);
    const body = { displayName: "Hijack", tagline: null, summary: null };

    for (const [cookie, handle] of [
      [stranger.cookieHeader, publicHandle],
      [bare.cookieHeader, publicHandle],
      [stranger.cookieHeader, `${HANDLE_PREFIX}-does-not-exist`],
      [stranger.cookieHeader, "Not A Handle"],
    ] as const) {
      expect(await edit(cookie, handle, body)).toMatchObject({ status: 404, body: { error: CODES.notFound } });
    }
    expect((await versionsOf(internalStorefrontId)).map((v) => v.sourceRecordVersion)).toEqual(["1"]);
  });

  it("refuses an owner with no governance assignment: ownership alone is not presentation authority", async () => {
    const owner = await signIn(["SELLER"]);
    const publicHandle = `${HANDLE_PREFIX}-ungoverned-${seq}`;
    const created = await createDraftStorefront(
      {
        ownerParticipantId: owner.participantId!,
        publicHandle,
        presentation: { displayName: "Ungoverned", tagline: null, summary: null },
        actingAccountId: owner.accountId,
        now: NOW,
      },
      { db },
    );

    expect(
      await edit(owner.cookieHeader, publicHandle, { displayName: "Nope", tagline: null, summary: null }),
    ).toMatchObject({ status: 404 });
    expect((await versionsOf(created.record.internalStorefrontId)).length).toBe(1);
    expect((await readAccountHome(owner.accountId, { db }))!.storefronts[0]!.canEditPresentation).toBe(false);
  });

  it("refuses edits to a CLOSED Storefront, and the page stops offering them", async () => {
    const { owner, publicHandle, internalStorefrontId } = await ownerWithStorefront();
    await createStorefrontSourceVersion(
      { internalStorefrontId, sourceRecordVersion: "2", lifecycle: "CLOSED", actingAccountId: owner.accountId, now: NOW },
      { db },
    );

    expect(
      await edit(owner.cookieHeader, publicHandle, { displayName: "Too late", tagline: null, summary: null }),
    ).toMatchObject({ status: 403, body: { error: CODES.notEditable } });
    expect((await versionsOf(internalStorefrontId)).map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
    expect((await readAccountHome(owner.accountId, { db }))!.storefronts[0]!.canEditPresentation).toBe(false);
  });

  it("refuses bodies outside the strict presentation shape, and anything that would move more than it", async () => {
    const { owner, publicHandle, internalStorefrontId } = await ownerWithStorefront();
    const good = { displayName: "Fine", tagline: null, summary: null };
    const bodies: unknown[] = [
      { ...good, publicHandle: "p131-elsewhere" },
      { ...good, lifecycle: "ACTIVE" },
      { ...good, visibility: "PUBLIC" },
      { ...good, actingAccountId: owner.accountId },
      { ...good, ownerParticipantId: owner.participantId },
      { ...good, sourceRecordVersion: "9" },
      { displayName: "   ", tagline: null, summary: null },
      { displayName: "Fine", tagline: "", summary: null },
      { displayName: "Fine", summary: null },
      { displayName: "Fine", tagline: "x".repeat(201), summary: null },
      "not json",
    ];
    for (const body of bodies) {
      expect((await edit(owner.cookieHeader, publicHandle, body)).status).toBe(400);
    }
    expect((await versionsOf(internalStorefrontId)).map((v) => v.sourceRecordVersion)).toEqual(["1"]);
  });

  it("refuses the unauthenticated and the cross-origin before any write", async () => {
    const { owner, publicHandle, internalStorefrontId } = await ownerWithStorefront();
    const body = { displayName: "Nope", tagline: null, summary: null };

    expect(await edit(null, publicHandle, body)).toMatchObject({ status: 401 });
    expect(await edit(owner.cookieHeader, publicHandle, body, { originHeader: "https://evil.example" })).toMatchObject({
      status: 403,
      body: { error: CODES.crossOrigin },
    });
    expect((await versionsOf(internalStorefrontId)).length).toBe(1);
  });

  it("never loses a concurrent edit silently: each lands as its own version or is refused as a conflict", async () => {
    const { owner, publicHandle, internalStorefrontId } = await ownerWithStorefront();

    const results = await Promise.all(
      ["Alpha", "Beta"].map((name) =>
        edit(owner.cookieHeader, publicHandle, { displayName: name, tagline: null, summary: null }),
      ),
    );

    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status !== 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of refused) expect(r).toMatchObject({ status: 409, body: { error: CODES.conflict } });

    const versions = await versionsOf(internalStorefrontId);
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(
      Array.from({ length: 1 + ok.length }, (_, i) => String(i + 1)),
    );
    const current = (await db.storefront.findUnique({ where: { internalStorefrontId } }))!.currentSourceRecordVersion;
    expect(current).toBe(String(1 + ok.length));
  });

  it("projects the current presentation and the editor flag on the account home, without identifiers", async () => {
    const { owner, publicHandle } = await ownerWithStorefront();
    await edit(owner.cookieHeader, publicHandle, { displayName: "Shown", tagline: null, summary: "About us." });

    const home = await readAccountHome(owner.accountId, { db });
    expect(home!.storefronts).toEqual([
      {
        displayName: "Shown",
        tagline: null,
        summary: "About us.",
        publicHandle,
        lifecycle: "DRAFT",
        visibility: "PRIVATE",
        canEditPresentation: true,
        canPlaceProduct: true,
      },
    ]);
    expect(JSON.stringify(home)).not.toMatch(/mon:/);
  });
});
