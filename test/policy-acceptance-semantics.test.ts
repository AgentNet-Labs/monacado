/**
 * Marketplace Policy acceptance semantics (Phase 1.14 correction).
 *
 * Pure. No database, no network.
 *
 * Monacado's governing rule has two halves, and the code said only one of them.
 * A participant joining now explicitly accepts the version in force. A
 * participant ALREADY TRADING accepts an updated version by continuing to use
 * Monacado after it takes effect, having had notice. The old
 * `MARKETPLACE_POLICY_REACCEPTANCE` boolean asserted the opposite of the second
 * half — that an existing participant must click Accept again — and while
 * nothing enforced it, a field whose ordinary reading states a rule the business
 * does not have is a rule somebody eventually implements.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ACCEPTANCE_MECHANISMS,
  AcceptanceMechanism,
  POLICY_ACCEPTANCE_MODES,
  acceptanceModesFor,
} from "../src/contracts/marketplace/marketplace-policy";
import {
  MARKETPLACE_POLICY_ONBOARDING_ACCEPTANCE,
  MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_2,
  MONACADO_MARKETPLACE_POLICY_V1_2_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_3,
  MONACADO_MARKETPLACE_POLICY_V1_3_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_HASH,
} from "../src/contracts/marketplace/marketplace-policy-content";
import {
  CONTINUED_USE_EVIDENCE_KINDS,
  NEVER_CONTINUED_USE_EVIDENCE,
} from "../src/server/policy/continued-use-acceptance";

const readCode = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

const changesText = (): string =>
  MONACADO_MARKETPLACE_POLICY_V1_3.sections
    .find((s) => s.key === "POLICY_CHANGES")!
    .paragraphs.join("\n")
    .toLowerCase();

// — 1 · Published versions are untouched —

describe("acceptance correction · earlier versions are byte-identical", () => {
  it("leaves 1.0.0, 1.1.0, and 1.2.0 hashes exactly as published", () => {
    expect(MONACADO_MARKETPLACE_POLICY_V1_HASH).toBe(
      "sha256:e50e87716ca2156eb51afa0fab52d4ab925109e8147199ece3a8e3160443cb85",
    );
    expect(MONACADO_MARKETPLACE_POLICY_V1_1_HASH).toBe(
      "sha256:b0a48644c8c146e2247d20de20140f6e124435401cad1ce096140ca5128e74b6",
    );
    expect(MONACADO_MARKETPLACE_POLICY_V1_2_HASH).toBe(
      "sha256:ab1fea6a75edfb1f204c2656e218c42076ee8311294e6a816b2d12d455649181",
    );
  });

  it("changes only 1.3.0's own POLICY_CHANGES section", () => {
    const before = MONACADO_MARKETPLACE_POLICY_V1_2.sections.find(
      (s) => s.key === "POLICY_CHANGES",
    )!;
    const after = MONACADO_MARKETPLACE_POLICY_V1_3.sections.find(
      (s) => s.key === "POLICY_CHANGES",
    )!;
    /* 1.2.0 keeps its three paragraphs; 1.3.0 states the rule in full. */
    expect(before.paragraphs).toHaveLength(3);
    expect(after.paragraphs.length).toBeGreaterThan(before.paragraphs.length);
    expect(MONACADO_MARKETPLACE_POLICY_V1_3_HASH).not.toBe(MONACADO_MARKETPLACE_POLICY_V1_2_HASH);
  });
});

// — 2 · The policy states the rule —

describe("acceptance correction · 1.3.0 states the continued-use rule", () => {
  it("says Monacado may update, and when an update takes effect", () => {
    const t = changesText();
    expect(t).toContain("monacado may issue new versions of this policy");
    expect(t).toContain("takes effect on the date monacado states");
    expect(t).toContain("gives sellers and promoters notice");
  });

  it("says continued use after the effective date is acceptance", () => {
    const t = changesText();
    expect(t).toContain(
      "continuing to use monacado on or after the date a new version takes effect constitutes acceptance",
    );
    /* And the other half: a participant joining accepts the version in force. */
    expect(t).toContain("a participant joining monacado accepts the version in force");
  });

  it("tells a participant who disagrees what to do, and what still survives", () => {
    const t = changesText();
    expect(t).toContain("should stop the affected marketplace activity before the date");
    expect(t).toContain("stopping does not end what is already owed");
    for (const surviving of [
      "orders already completed must still be fulfilled",
      "refunds eligible under the terms bound to those purchases must still be honoured",
      "dispute evidence must still be supplied",
    ]) {
      expect(t, surviving).toContain(surviving);
    }
  });

  it("introduces no intermediary or facilitator framing", () => {
    const t = changesText();
    for (const forbidden of [
      "on behalf of",
      "forwards funds",
      "pass through",
      "payment facilitator",
      "payfac",
      "processes payments for",
    ]) {
      expect(t, forbidden).not.toContain(forbidden);
    }
  });
});

// — 3 · The metadata says what is true —

describe("acceptance correction · the metadata no longer asserts a rule that does not exist", () => {
  it("states two acceptance modes, one per situation", () => {
    expect([...POLICY_ACCEPTANCE_MODES]).toEqual([
      "EXPLICIT_ONBOARDING",
      "CONTINUED_USE_AFTER_EFFECTIVE_NOTICE",
    ]);
    expect(acceptanceModesFor()).toEqual(POLICY_ACCEPTANCE_MODES);
  });

  it("records continued use as its own acceptance mechanism, not a fake affirmation", () => {
    /* "How did they agree" is the question a dispute turns on. An acceptance
       claiming an onboarding click that never happened would be the worst
       possible answer to it. */
    expect(ACCEPTANCE_MECHANISMS).toContain("CONTINUED_USE_AFTER_NOTICE");
    expect(AcceptanceMechanism.safeParse("CONTINUED_USE_AFTER_NOTICE").success).toBe(true);
    /* Fits the published VARCHAR(32) column, which is why this needed no
       migration. */
    expect("CONTINUED_USE_AFTER_NOTICE".length).toBeLessThanOrEqual(32);
  });

  it("renames the boolean map to the narrow thing it actually means", () => {
    /* Every version is accepted explicitly by a NEW participant at onboarding.
       That is all the published `requiresReacceptance` column ever meant. */
    for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
      expect(MARKETPLACE_POLICY_ONBOARDING_ACCEPTANCE.get(version), version).toBe(true);
    }
    const content = readCode("src/contracts/marketplace/marketplace-policy-content.ts");
    expect(content).not.toContain("MARKETPLACE_POLICY_REACCEPTANCE");
  });

  it("documents the published column as narrower than its name", () => {
    const contract = readCode("src/contracts/marketplace/marketplace-policy.ts");
    expect(contract).toContain("LEGACY, AND NARROWER THAN ITS NAME");
  });
});

// — 4 · No affirmative-reacceptance commerce gate —

describe("acceptance correction · no commerce gate requires accepting again", () => {
  it("is read by no commerce path", () => {
    /* The property that made the old name merely misleading rather than
       actively wrong — and the one this correction must not quietly change. */
    for (const path of [
      "src/server/marketplace/checkout-service.ts",
      "src/server/marketplace/order-service.ts",
      "src/server/payments/executable-checkout-service.ts",
      "src/server/risk/transaction-risk-service.ts",
    ]) {
      const code = readCode(path);
      for (const forbidden of [
        "requiresReacceptance",
        "MARKETPLACE_POLICY_NOT_ACCEPTED",
        "outstandingAcceptanceAudiences",
      ]) {
        expect(code, `${path}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("evidences acceptance without gating it", () => {
    /* The evaluator must never become a precondition: that would reintroduce
       the affirmative-reacceptance gate by the back door. */
    const code = readCode("src/server/policy/continued-use-acceptance.ts");
    for (const forbidden of ["throw new", "deny", "refuse", "block"]) {
      expect(code.toLowerCase(), forbidden).not.toContain(`${forbidden.toLowerCase()} `);
    }
  });
});

// — 5 · Continued-use evidence —

describe("acceptance correction · continued use is proved from existing records", () => {
  it("reuses authoritative records rather than a new activity ledger", () => {
    expect([...CONTINUED_USE_EVIDENCE_KINDS]).toEqual([
      "PAID_ORDER_AS_SELLER",
      "PAID_ORDER_AS_PROMOTER",
      "OFFER_SOURCE_VERSION_AUTHORED",
      "LISTING_SOURCE_VERSION_AUTHORED",
    ]);
    const code = readCode("src/server/policy/continued-use-acceptance.ts");
    /* No table was invented for this. */
    expect(code).not.toContain("participantActivity");
    expect(code).not.toContain(".create(");
  });

  it("refuses another party's conduct as evidence", () => {
    expect(NEVER_CONTINUED_USE_EVIDENCE).toContain("BUYER_PURCHASE");
    expect(NEVER_CONTINUED_USE_EVIDENCE).toContain("ACCOUNT_SESSION");
    /* Participation is the join key, so someone else's activity cannot reach a
       participant's finding even by mistake. */
    const code = readCode("src/server/policy/continued-use-acceptance.ts");
    expect(code).toContain("sellerParticipantId: input.participantId");
    expect(code).toContain("promoterParticipantId: input.participantId");
    expect(code).not.toContain("buyerAccountId");
  });

  it("counts only acts on or after the effective date", () => {
    const code = readCode("src/server/policy/continued-use-acceptance.ts");
    /* `gte: from` on every qualifying query — a participant who traded under the
       old version and stopped has accepted nothing. */
    expect(code.match(/gte: from/g) ?? []).toHaveLength(4);
    expect(code).not.toContain("lte: from");
  });
});
