/**
 * Policy bootstrap and verification-email delivery integration tests (Phase 1.4).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK AND NO MAIL VENDOR.** Every message goes to Phase 1.1's capturing
 * adapter, and the link the test follows is the link the recipient would have —
 * pulled out of the delivered body, never out of the service's return value,
 * because the service deliberately does not return the token.
 *
 * **The shipped policy identity is not touched.** The bootstrap is exercised
 * against this suite's own policy through the `shipped` source seam. Recording,
 * activating, and retiring versions of the real policy would be rewriting the
 * terms every other suite's participants are activated under.
 *
 * **Test isolation.** Every identifier carries the `P14T` prefix, every account
 * address the `p14t-` local part, and every address is `@example.invalid`.
 * Cleanup runs child-to-parent and deletes only what this suite created.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type { PolicyIdProvider } from "../src/server/policy/policy-ids";
import {
  bootstrapMarketplacePolicy,
  type PolicyBootstrapDeps,
} from "../src/server/policy/marketplace-policy-bootstrap";
import {
  activateMarketplacePolicyVersion,
  ensureMarketplacePolicy,
  getActiveMarketplacePolicyVersion,
  getMarketplacePolicyVersion,
  recordMarketplacePolicyVersion,
} from "../src/server/policy/marketplace-policy-service";
import {
  getEmailContact,
  hashVerificationToken,
  upsertEmailContact,
} from "../src/server/policy/email-verification-service";
import { requestEmailContactVerification } from "../src/server/policy/verification-notice-service";
import { main as bootstrapCommand } from "../scripts/bootstrap-marketplace-policy";
import { handleVerifyEmailRequest } from "../src/server/policy/verification-route-handler";
import { resolveSellerSupportContact } from "../src/server/policy/support-contact-service";
import { PolicyError } from "../src/server/policy/policy-errors";
import { VERIFICATION_TOKEN_PARAM } from "../src/server/policy/verification-link";
import {
  createCapturingMailAdapter,
  resolveMailPort,
} from "../src/server/notifications/mail-port";
import { MarketplacePolicyDocument } from "../src/contracts/marketplace/marketplace-policy";
import { MONACADO_MARKETPLACE_POLICY_V1 } from "../src/contracts/marketplace/marketplace-policy-content";
import { VERIFICATION_TOKEN_TTL_SECONDS } from "../src/contracts/marketplace/participant-email-contact";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P14T";
const EMAIL_PREFIX = "p14t-";
const PASSWORD = "correct-horse-battery-staple-p14";
const ORIGIN = "https://monacado.test";

const NOW = "2028-05-01T09:00:00.000Z";
/** Inside the 24h TTL. */
const SOON = "2028-05-01T11:00:00.000Z";
/** One second past it. */
const PAST_EXPIRY = new Date(
  new Date(NOW).getTime() + VERIFICATION_TOKEN_TTL_SECONDS * 1_000 + 1_000,
).toISOString();

let seq = 0;
function pad26(seed: string): string {
  const body = seed.toUpperCase().replace(/[ILOU]/g, "0");
  return (body + "0".repeat(26)).slice(0, 26);
}
function nextSuffix(): string {
  seq += 1;
  return pad26(`${TAG}${seq}`);
}

/** This suite's own policy identity. Never the shipped one. */
const POLICY_ID = `mon:mpol:${pad26(`${TAG}POLICY`)}`;
const V1 = "1.0.0";
const V2 = "2.0.0";
const CONTENT_REF_1 = `marketplace-policy-p14t/${V1}`;

const V1_DOCUMENT = MarketplacePolicyDocument.parse({
  ...MONACADO_MARKETPLACE_POLICY_V1,
  policyId: POLICY_ID,
  policyVersion: V1,
});
const V2_DOCUMENT = MarketplacePolicyDocument.parse({
  ...MONACADO_MARKETPLACE_POLICY_V1,
  policyId: POLICY_ID,
  policyVersion: V2,
  title: "Suite marketplace policy (succession)",
});
/** A V1 whose prose has moved — used to prove drift is refused, not repaired. */
const V1_DRIFTED = MarketplacePolicyDocument.parse({
  ...V1_DOCUMENT,
  title: "Suite marketplace policy (drifted prose)",
});

const DOCUMENTS: ReadonlyMap<string, MarketplacePolicyDocument> = new Map([
  [V1, V1_DOCUMENT],
  [V2, V2_DOCUMENT],
]);

const participantIds: ParticipantIdProvider = {
  nextParticipantId: () => `mon:mpart:${nextSuffix()}`,
  nextRoleAssignmentId: () => `mon:mrole:${nextSuffix()}`,
  nextProfileId: () => `mon:mprof:${nextSuffix()}`,
  nextActivationId: () => `mon:mact:${nextSuffix()}`,
  nextPaymentAccountId: () => `mon:mpay:${nextSuffix()}`,
  nextRestrictionId: () => `mon:prst:${nextSuffix()}`,
  nextObligationId: () => `mon:nobl:${nextSuffix()}`,
};
const policyIds: PolicyIdProvider = {
  nextAcceptanceId: () => `mon:pacc:${nextSuffix()}`,
  nextEmailContactId: () => `mon:pemc:${nextSuffix()}`,
  nextVerificationChallengeId: () => `mon:evch:${nextSuffix()}`,
};

/** The bootstrap, pointed at this suite's policy instead of the shipped one. */
const bdeps = (): PolicyBootstrapDeps => ({
  db,
  documents: DOCUMENTS,
  shipped: { document: V1_DOCUMENT, contentRef: CONTENT_REF_1 },
});
const vdeps = () => ({ db, ids: policyIds, origin: ORIGIN });

let RECORDER = "";

async function cleanup(): Promise<void> {
  const owned = { participantId: { startsWith: `mon:mpart:${TAG}` } };
  await db.emailVerificationChallenge.deleteMany({ where: owned });
  await db.participantEmailContact.deleteMany({ where: owned });
  await db.participantPolicyAcceptance.deleteMany({ where: owned });
  await db.marketplaceRoleAssignment.deleteMany({ where: owned });
  await db.marketplaceParticipant.deleteMany({
    where: { id: { startsWith: `mon:mpart:${TAG}` } },
  });
  await db.marketplacePolicyVersionRow.deleteMany({ where: { policyId: POLICY_ID } });
  await db.marketplacePolicy.deleteMany({ where: { id: POLICY_ID } });
  await db.accountSession.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.account.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function seedAccount(): Promise<{ accountId: string; email: string }> {
  seq += 1;
  const email = `${EMAIL_PREFIX}${seq}@example.invalid`;
  const account = await createAccount(
    { name: "Synthetic Person", email, password: PASSWORD, createdAt: NOW },
    { db },
  );
  return { accountId: account.accountId, email };
}

async function seedSeller(): Promise<{
  participantId: string;
  accountId: string;
  email: string;
}> {
  const { accountId, email } = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: ["SELLER"], now: NOW },
    { db, ids: participantIds },
  );
  return { participantId: snapshot.participant.participantId, accountId, email };
}

/** The token exactly as the recipient would obtain it: out of the delivered link. */
function tokenFromBody(body: string): string {
  const match = body.match(/https:\/\/\S+/);
  if (match === null) throw new Error("no verification link in the delivered message");
  const token = new URL(match[0]).searchParams.get(VERIFICATION_TOKEN_PARAM);
  if (token === null) throw new Error("no token on the verification link");
  return token;
}

const describeIf = RUN ? describe : describe.skip;

describeIf("Phase 1.4 — policy bootstrap", () => {
  beforeEach(async () => {
    await cleanup();
    RECORDER = (await seedAccount()).accountId;
  });
  afterAll(async () => {
    if (RUN) {
      await cleanup();
      await disconnectPrisma();
    }
  });

  it("records the shipped version, with the hash derived from the source", async () => {
    const outcome = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: NOW, activate: false, mode: "APPLY" },
      bdeps(),
    );

    expect(outcome.action).toBe("RECORD_DRAFT");
    expect(outcome.applied).toBe(true);
    expect(outcome.activated).toBe(false);
    expect(outcome.policyId).toBe(POLICY_ID);
    expect(outcome.policyVersion).toBe(V1);
    expect(outcome.contentRef).toBe(CONTENT_REF_1);
    expect(outcome.persistedHash).toBe(outcome.sourceHash);
    expect(outcome.persistedState).toBe("DRAFT");

    const row = await getMarketplacePolicyVersion(POLICY_ID, V1, { db });
    expect(row?.status).toBe("DRAFT");
    expect(row?.contentHash).toBe(outcome.sourceHash);
  });

  it("records and activates in one invocation when activation is asked for", async () => {
    const outcome = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: NOW, activate: true, mode: "APPLY" },
      bdeps(),
    );
    expect(outcome.action).toBe("RECORD_AND_ACTIVATE");
    expect(outcome.activated).toBe(true);

    const active = await getActiveMarketplacePolicyVersion(POLICY_ID, { db });
    expect(active?.policyVersion).toBe(V1);
  });

  it("is idempotent: a repeat reports success, writes nothing, and duplicates nothing", async () => {
    const first = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: NOW, activate: true, mode: "APPLY" },
      bdeps(),
    );
    const before = await getMarketplacePolicyVersion(POLICY_ID, V1, { db });

    const second = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: SOON, activate: true, mode: "APPLY" },
      bdeps(),
    );

    expect(first.activated).toBe(true);
    expect(second.action).toBe("NO_CHANGE_ALREADY_ACTIVE");
    expect(second.applied).toBe(false);
    expect(second.activated).toBe(false);

    const after = await getMarketplacePolicyVersion(POLICY_ID, V1, { db });
    /* Not merely "still active" — byte-identical. A second run must not restamp
       who recorded it or when it was activated. */
    expect(after).toEqual(before);
    const rows = await db.marketplacePolicyVersionRow.count({ where: { policyId: POLICY_ID } });
    expect(rows).toBe(1);
  });

  it("refuses when a different version is ACTIVE, and leaves it standing", async () => {
    await ensureMarketplacePolicy(
      { policyId: POLICY_ID, label: "Suite policy", now: NOW },
      { db },
    );
    await recordMarketplacePolicyVersion(
      {
        policyId: POLICY_ID,
        policyVersion: V2,
        contentRef: `marketplace-policy-p14t/${V2}`,
        requiresReacceptance: true,
        effectiveFrom: NOW,
        recordedByAccountId: RECORDER,
        recordedAt: NOW,
      },
      { db, documents: DOCUMENTS },
    );
    await activateMarketplacePolicyVersion(
      {
        policyId: POLICY_ID,
        policyVersion: V2,
        activatedByAccountId: RECORDER,
        activatedAt: NOW,
      },
      { db, documents: DOCUMENTS },
    );

    const outcome = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: SOON, activate: true, mode: "APPLY" },
      bdeps(),
    );

    expect(outcome.action).toBe("REFUSED");
    expect(outcome.refusal).toBe("CONFLICTING_ACTIVE_VERSION");
    expect(outcome.conflictingActiveVersion).toBe(V2);
    expect(outcome.applied).toBe(false);

    /* Fail closed means the standing version is untouched — not retired, not
       replaced — and the shipped one was not even recorded. */
    const active = await getActiveMarketplacePolicyVersion(POLICY_ID, { db });
    expect(active?.policyVersion).toBe(V2);
    expect(active?.retiredAt).toBeNull();
    expect(await getMarketplacePolicyVersion(POLICY_ID, V1, { db })).toBeNull();
  });

  it("activates an existing DRAFT only when activation is explicitly asked for", async () => {
    await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: NOW, activate: false, mode: "APPLY" },
      bdeps(),
    );

    const withheld = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: SOON, activate: false, mode: "APPLY" },
      bdeps(),
    );
    expect(withheld.action).toBe("NO_CHANGE_ALREADY_DRAFT");
    expect(withheld.activated).toBe(false);
    expect(await getActiveMarketplacePolicyVersion(POLICY_ID, { db })).toBeNull();

    const activated = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: SOON, activate: true, mode: "APPLY" },
      bdeps(),
    );
    expect(activated.action).toBe("ACTIVATE_EXISTING_DRAFT");
    expect(activated.activated).toBe(true);
    expect((await getActiveMarketplacePolicyVersion(POLICY_ID, { db }))?.policyVersion).toBe(V1);
  });

  it("never rewrites a historical version whose prose has moved", async () => {
    await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: NOW, activate: true, mode: "APPLY" },
      bdeps(),
    );
    const before = await getMarketplacePolicyVersion(POLICY_ID, V1, { db });

    /* The same version number, different bytes: exactly the drift the content
       hash exists to catch. */
    const outcome = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: SOON, activate: true, mode: "APPLY" },
      {
        db,
        documents: new Map([[V1, V1_DRIFTED]]),
        shipped: { document: V1_DRIFTED, contentRef: CONTENT_REF_1 },
      },
    );

    expect(outcome.action).toBe("REFUSED");
    expect(outcome.refusal).toBe("CONTENT_HASH_MISMATCH");
    expect(outcome.persistedHash).not.toBe(outcome.sourceHash);

    /* The row is the evidence of the drift. It is left exactly as it was. */
    expect(await getMarketplacePolicyVersion(POLICY_ID, V1, { db })).toEqual(before);
  });

  it("refuses to bring a RETIRED shipped version back", async () => {
    await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: NOW, activate: true, mode: "APPLY" },
      bdeps(),
    );
    await db.marketplacePolicyVersionRow.updateMany({
      where: { policyId: POLICY_ID, policyVersion: V1 },
      data: { status: "RETIRED", retiredAt: new Date(SOON), activeMarker: null },
    });

    const outcome = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: SOON, activate: true, mode: "APPLY" },
      bdeps(),
    );
    expect(outcome.action).toBe("REFUSED");
    expect(outcome.refusal).toBe("SHIPPED_VERSION_RETIRED");
    expect(outcome.persistedState).toBe("RETIRED");
  });

  it("inspects without writing anything", async () => {
    const outcome = await bootstrapMarketplacePolicy(
      { recordedByAccountId: RECORDER, now: NOW, activate: true, mode: "INSPECT" },
      bdeps(),
    );
    expect(outcome.action).toBe("RECORD_AND_ACTIVATE");
    expect(outcome.applied).toBe(false);
    expect(outcome.activated).toBe(false);
    expect(await getMarketplacePolicyVersion(POLICY_ID, V1, { db })).toBeNull();
  });

  it("refuses to record a version under an account that does not exist", async () => {
    const outcome = await bootstrapMarketplacePolicy(
      {
        recordedByAccountId: `mon:acct:${pad26(`${TAG}NOBODY`)}`,
        now: NOW,
        activate: true,
        mode: "APPLY",
      },
      bdeps(),
    );
    expect(outcome.action).toBe("REFUSED");
    expect(outcome.refusal).toBe("RECORDING_ACCOUNT_NOT_FOUND");
    expect(await getMarketplacePolicyVersion(POLICY_ID, V1, { db })).toBeNull();
  });
});

/**
 * The command's production gate, exercised against the disposable database.
 *
 * `NODE_ENV` is passed to `main` as an argument rather than set on the process,
 * so nothing here mutates global state, and the `shipped` seam points the whole
 * command at this suite's own policy identity. **The database is the disposable
 * local MySQL in every case** — the environment is *classified* as production to
 * exercise the gate; no production system is contacted.
 */
describeIf("Phase 1.4 — the bootstrap command's production gate", () => {
  const PROD = (extra: Record<string, string | undefined> = {}) => ({
    NODE_ENV: "production",
    MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID: RECORDER,
    ...extra,
  });
  let printed: string[] = [];
  const out = (line: string) => printed.push(line);

  beforeEach(async () => {
    await cleanup();
    RECORDER = (await seedAccount()).accountId;
    printed = [];
  });
  afterAll(async () => {
    if (RUN) {
      await cleanup();
      await disconnectPrisma();
    }
  });

  it("refuses a production mutation with no confirmation, before touching the database", async () => {
    const code = await bootstrapCommand(["--activate"], PROD(), out, bdeps());

    expect(code).toBe(1);
    expect(printed.join("\n")).toContain("refused: PRODUCTION_CONFIRMATION_REQUIRED");
    /* Nothing was recorded, and no policy identity was even created. */
    expect(await getMarketplacePolicyVersion(POLICY_ID, V1, { db })).toBeNull();
    expect(await db.marketplacePolicy.count({ where: { id: POLICY_ID } })).toBe(0);
  });

  it("shows the operator what they are about to do before refusing", async () => {
    await bootstrapCommand(["--activate"], PROD(), out, bdeps());
    const report = printed.join("\n");

    expect(report).toContain("environment:      PRODUCTION");
    expect(report).toContain("policy id:        ");
    expect(report).toContain("requested action: RECORD_AND_ACTIVATE");
    expect(report).toMatch(/source hash:      sha256:[0-9a-f]{64}/);
  });

  it("permits a production mutation once it is explicitly confirmed", async () => {
    const code = await bootstrapCommand(["--confirm-production"], PROD(), out, bdeps());

    expect(code).toBe(0);
    expect(printed.join("\n")).not.toContain("PRODUCTION_CONFIRMATION_REQUIRED");
    const row = await getMarketplacePolicyVersion(POLICY_ID, V1, { db });
    expect(row?.status).toBe("DRAFT");
  });

  it("confirming a production write does NOT activate anything", async () => {
    /* Two decisions, two words. "Yes, write to production" and "yes, start
       governing live sellers with these terms" must not be one answer. */
    const code = await bootstrapCommand(["--confirm-production"], PROD(), out, bdeps());

    expect(code).toBe(0);
    expect(printed.join("\n")).toContain("activated:        no");
    expect(await getActiveMarketplacePolicyVersion(POLICY_ID, { db })).toBeNull();
  });

  it("a production activation requires both the activation flag and the confirmation", async () => {
    /* --activate alone: refused by the gate, nothing written. */
    expect(await bootstrapCommand(["--activate"], PROD(), out, bdeps())).toBe(1);
    expect(await getActiveMarketplacePolicyVersion(POLICY_ID, { db })).toBeNull();

    /* --confirm-production alone: written, but still not governing. */
    printed = [];
    expect(await bootstrapCommand(["--confirm-production"], PROD(), out, bdeps())).toBe(0);
    expect(await getActiveMarketplacePolicyVersion(POLICY_ID, { db })).toBeNull();

    /* Both: activated. */
    printed = [];
    expect(
      await bootstrapCommand(["--activate", "--confirm-production"], PROD(), out, bdeps()),
    ).toBe(0);
    expect((await getActiveMarketplacePolicyVersion(POLICY_ID, { db }))?.policyVersion).toBe(V1);
  });

  it("inspects a production target without a confirmation, and writes nothing", async () => {
    const code = await bootstrapCommand(["--inspect", "--activate"], PROD(), out, bdeps());

    expect(code).toBe(0);
    const report = printed.join("\n");
    expect(report).not.toContain("PRODUCTION_CONFIRMATION_REQUIRED");
    expect(report).toContain("mode:             INSPECT");
    expect(report).toContain("applied:          no");
    expect(await getMarketplacePolicyVersion(POLICY_ID, V1, { db })).toBeNull();
    expect(await db.marketplacePolicy.count({ where: { id: POLICY_ID } })).toBe(0);
  });

  it("keeps every conflict refusal, confirmation or not", async () => {
    await bootstrapCommand(["--activate", "--confirm-production"], PROD(), out, bdeps());

    /* A confirmed production write still refuses drifted prose, and still leaves
       the row that is the evidence of the drift exactly as it was. */
    printed = [];
    const before = await getMarketplacePolicyVersion(POLICY_ID, V1, { db });
    const code = await bootstrapCommand(["--activate", "--confirm-production"], PROD(), out, {
      db,
      documents: new Map([[V1, V1_DRIFTED]]),
      shipped: { document: V1_DRIFTED, contentRef: CONTENT_REF_1 },
    });

    expect(code).toBe(1);
    expect(printed.join("\n")).toContain("CONTENT_HASH_MISMATCH");
    expect(await getMarketplacePolicyVersion(POLICY_ID, V1, { db })).toEqual(before);
  });

  it("prints no connection string, credential, or environment value", async () => {
    await bootstrapCommand(["--activate", "--confirm-production"], PROD(), out, bdeps());
    const report = printed.join("\n");

    for (const forbidden of ["mysql://", "DATABASE_URL", "127.0.0.1", "3308", "password", "NODE_ENV"]) {
      expect(report).not.toContain(forbidden);
    }
    /* The database URL is real and in the process environment; none of it leaks. */
    expect(report).not.toContain(process.env.DATABASE_URL ?? "mysql://unset");
  });
});

describeIf("Phase 1.4 — verification email delivery", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterAll(async () => {
    if (RUN) {
      await cleanup();
      await disconnectPrisma();
    }
  });

  it("issues a challenge and delivers the link through the Phase 1.1 mail port", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();

    const dispatch = await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    expect(dispatch.delivery.outcome).toBe("ACCEPTED");
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.to).toBe(seller.email);
    expect(port.sent[0]!.text).toContain(`${ORIGIN}/verify-email?`);
    expect(dispatch.challenge.state).toBe("PENDING");

    /* The service returns no token. The recipient's copy of the link is the only
       place one exists. */
    expect(Object.keys(dispatch).sort()).toEqual(["challenge", "delivery"]);
  });

  it("puts the opaque token on the configured public origin, and no identifier", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();
    await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    const link = port.sent[0]!.text.match(/https:\/\/\S+/)![0];
    const url = new URL(link);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/verify-email");
    expect(Array.from(url.searchParams.keys())).toEqual([VERIFICATION_TOKEN_PARAM]);
    expect(link).not.toContain(seller.participantId);
    expect(link).not.toContain(seller.accountId);
    expect(link).not.toContain(seller.email);
  });

  it("persists only the token's digest, never the token", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();
    const dispatch = await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    const token = tokenFromBody(port.sent[0]!.text);
    const row = await db.emailVerificationChallenge.findUnique({
      where: { id: dispatch.challenge.challengeId },
    });
    expect(row).not.toBeNull();
    expect(row!.tokenDigest).toBe(hashVerificationToken(token));
    /* No column anywhere on the row holds the plaintext. */
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("verifies the contact when a valid link is opened", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();
    await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    const token = tokenFromBody(port.sent[0]!.text);
    const result = await handleVerifyEmailRequest({ token, at: SOON }, { db });
    expect(result).toEqual({ outcome: "VERIFIED" });

    const contact = await getEmailContact(seller.participantId, "PRIMARY_PROFILE", { db });
    expect(contact?.state).toBe("VERIFIED");
  });

  it("makes the canonical support resolver see the address, and only then", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();
    await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    const before = await resolveSellerSupportContact(seller.participantId, { db });
    expect(before).toEqual({ available: false, reason: "NO_VERIFIED_ADDRESS" });

    await handleVerifyEmailRequest({ token: tokenFromBody(port.sent[0]!.text), at: SOON }, { db });

    const after = await resolveSellerSupportContact(seller.participantId, { db });
    expect(after).toEqual({
      available: true,
      address: seller.email,
      source: "PRIMARY_PROFILE",
    });
  });

  it("does not activate the seller as a side effect", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();
    await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );
    await handleVerifyEmailRequest({ token: tokenFromBody(port.sent[0]!.text), at: SOON }, { db });

    /* Verification satisfies a PREREQUISITE. Admission is still the governed
       activation flow's decision, and nothing here may pre-empt it. */
    const participant = await db.marketplaceParticipant.findUnique({
      where: { id: seller.participantId },
      select: { status: true },
    });
    expect(participant?.status).toBe("DRAFT");
    expect(await db.participantActivation.count({ where: { participantId: seller.participantId } })).toBe(0);
  });

  it("refuses an expired link", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();
    await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    const result = await handleVerifyEmailRequest(
      { token: tokenFromBody(port.sent[0]!.text), at: PAST_EXPIRY },
      { db },
    );
    expect(result).toEqual({ outcome: "NOT_VALID" });
    expect(
      (await getEmailContact(seller.participantId, "PRIMARY_PROFILE", { db }))?.state,
    ).toBe("UNVERIFIED");
  });

  it("refuses a link that has already been used", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();
    await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    const token = tokenFromBody(port.sent[0]!.text);
    await handleVerifyEmailRequest({ token, at: SOON }, { db });
    expect(await handleVerifyEmailRequest({ token, at: SOON }, { db })).toEqual({
      outcome: "ALREADY_USED",
    });
  });

  it("reissues: a new link is sent, and the previous one is dead", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();
    const first = await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );
    const second = await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: SOON,
      },
      port,
      vdeps(),
    );

    expect(port.sent).toHaveLength(2);
    expect(second.challenge.challengeId).not.toBe(first.challenge.challengeId);

    const supersededToken = tokenFromBody(port.sent[0]!.text);
    const newestToken = tokenFromBody(port.sent[1]!.text);
    expect(newestToken).not.toBe(supersededToken);

    const superseded = await db.emailVerificationChallenge.findUnique({
      where: { id: first.challenge.challengeId },
    });
    expect(superseded?.state).toBe("SUPERSEDED");

    /* Only the newest link may verify — a superseded one is refused with the
       same answer an unknown token gets. */
    expect(await handleVerifyEmailRequest({ token: supersededToken, at: SOON }, { db })).toEqual({
      outcome: "NOT_VALID",
    });
    expect(await handleVerifyEmailRequest({ token: newestToken, at: SOON }, { db })).toEqual({
      outcome: "VERIFIED",
    });
  });

  it("answers an unknown token exactly as it answers a superseded one", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();
    await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    /* A well-formed token that was never issued. Nothing in the answer says
       whether an address, a contact, or a participant exists behind it. */
    const unknown = "0".repeat(43);
    expect(await handleVerifyEmailRequest({ token: unknown, at: SOON }, { db })).toEqual({
      outcome: "NOT_VALID",
    });
  });

  it("refuses a request from an account that does not own the participant", async () => {
    const seller = await seedSeller();
    const stranger = await seedAccount();
    const port = createCapturingMailAdapter();

    await expect(
      requestEmailContactVerification(
        {
          participantId: seller.participantId,
          purpose: "PRIMARY_PROFILE",
          actingAccountId: stranger.accountId,
          now: NOW,
        },
        port,
        vdeps(),
      ),
    ).rejects.toThrow(PolicyError);

    expect(port.sent).toHaveLength(0);
    expect(
      await db.emailVerificationChallenge.count({
        where: { participantId: seller.participantId },
      }),
    ).toBe(0);
  });

  it("verifies a nominated dedicated support address, which then takes precedence", async () => {
    const seller = await seedSeller();
    const dedicated = `${EMAIL_PREFIX}support-${(seq += 1)}@example.invalid`;
    const port = createCapturingMailAdapter();

    await upsertEmailContact(
      {
        participantId: seller.participantId,
        purpose: "DEDICATED_SUPPORT",
        address: dedicated,
        now: NOW,
      },
      { db, ids: policyIds },
    );
    await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "DEDICATED_SUPPORT",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    expect(port.sent[0]!.to).toBe(dedicated);
    await handleVerifyEmailRequest({ token: tokenFromBody(port.sent[0]!.text), at: SOON }, { db });

    expect(await resolveSellerSupportContact(seller.participantId, { db })).toEqual({
      available: true,
      address: dedicated,
      source: "DEDICATED_SUPPORT",
    });
  });

  it("records the refusal — and still issues the challenge — when mail is not configured", async () => {
    const seller = await seedSeller();
    /* The Phase 1.1 posture, unchanged: disabled is a first-class state, and it
       refuses visibly rather than silently pretending to send. */
    const port = resolveMailPort({});

    const dispatch = await requestEmailContactVerification(
      {
        participantId: seller.participantId,
        purpose: "PRIMARY_PROFILE",
        actingAccountId: seller.accountId,
        now: NOW,
      },
      port,
      vdeps(),
    );

    expect(dispatch.delivery).toEqual({
      outcome: "REFUSED",
      failureCode: "CHANNEL_NOT_CONFIGURED",
    });
    expect(dispatch.challenge.state).toBe("PENDING");
  });

  it("refuses before minting a challenge when no public origin is configured", async () => {
    const seller = await seedSeller();
    const port = createCapturingMailAdapter();

    await expect(
      requestEmailContactVerification(
        {
          participantId: seller.participantId,
          purpose: "PRIMARY_PROFILE",
          actingAccountId: seller.accountId,
          now: NOW,
        },
        port,
        { db, ids: policyIds, env: {} },
      ),
    ).rejects.toThrow(PolicyError);

    /* Nothing was minted, so a seller's working link is not superseded by a
       misconfiguration. */
    expect(
      await db.emailVerificationChallenge.count({
        where: { participantId: seller.participantId },
      }),
    ).toBe(0);
    expect(port.sent).toHaveLength(0);
  });
});
