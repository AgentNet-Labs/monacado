/**
 * Marketplace refund governance and the receipt contract (Phase 1.10) — pure.
 *
 * No database, no network, no clock. Everything here is decidable from the
 * shipped documents and the pure projections over them.
 *
 * What these hold to account:
 *
 *   - version 1.1.0 states the refund rules `1.9` settled and recorded as owed;
 *   - version 1.0.0 is **byte-identical** to what it always was — a new version
 *     that moved the old one's hash would have silently changed what every
 *     participant who accepted it is recorded as having accepted;
 *   - each audience's rendering derives from the one document, and says the
 *     things that audience actually needs;
 *   - nothing anywhere describes Monacado as refunding whole Orders only;
 *   - the receipt renderer states the historical terms and never substitutes.
 */

import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_POLICY_CONTENT_REFS,
  MARKETPLACE_POLICY_DOCUMENTS,
  MARKETPLACE_POLICY_REACCEPTANCE,
  MARKETPLACE_POLICY_VERSION_1,
  MARKETPLACE_POLICY_VERSION_1_1,
  MONACADO_MARKETPLACE_POLICY_ID,
  MONACADO_MARKETPLACE_POLICY_V1,
  MONACADO_MARKETPLACE_POLICY_V1_1,
  MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_HASH,
  LATEST_MARKETPLACE_POLICY_VERSION,
  marketplacePolicyContentHash,
  marketplacePolicyDocument,
} from "../src/contracts/marketplace/marketplace-policy-content";
import {
  MarketplacePolicyDocument,
  POLICY_AUDIENCES,
  POLICY_SECTION_KEYS,
  REFUND_GOVERNANCE_SECTION_KEYS,
  selectRefundGovernanceSections,
  selectSection,
  selectSectionsForAudience,
  type PolicyAudience,
  type PolicySection,
} from "../src/contracts/marketplace/marketplace-policy";
import {
  NEVER_ON_RECEIPT,
  OrderReceiptView,
  PROMOTER_ON_BUYER_RECEIPT,
  RECEIPT_CONTRACT,
  RECEIPT_LINE_DESCRIPTION_GAP,
  SELLER_DISPLAY_NAME_GAP,
} from "../src/contracts/marketplace/order-receipt";
import { RECEIPT_SURFACE } from "../src/contracts/marketplace/refund-disclosure";
import { REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION } from "../src/contracts/marketplace/seller-refund-policy";
import {
  RECEIPT_EMAIL_RENDERING,
  renderBuyerConfirmation,
} from "../src/server/notifications/transactional-notice-service";
import type { OrderRecord } from "../src/contracts/marketplace/order";
import { parseCommandOptions, BootstrapUsageError } from "../scripts/bootstrap-marketplace-policy";

/** A valid Crockford opaque body: 26 chars, and I/L/O/U are not in the alphabet. */
const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

/** Every paragraph of one audience's rendering, lowercased, as one haystack. */
const proseFor = (document: MarketplacePolicyDocument, audience: PolicyAudience): string =>
  selectSectionsForAudience(document, audience)
    .flatMap((s) => [s.heading, ...s.paragraphs])
    .join("\n")
    .toLowerCase();

const V1_1 = MONACADO_MARKETPLACE_POLICY_V1_1;

// — 1 · The new version exists and is governed like every other —

describe("1.10 · Marketplace Policy 1.1.0", () => {
  it("is a distinct version of the same policy, with its own hash", () => {
    expect(V1_1.policyId).toBe(MONACADO_MARKETPLACE_POLICY_ID);
    expect(V1_1.policyVersion).toBe("1.1.0");
    expect(V1_1.policyVersion).not.toBe(MONACADO_MARKETPLACE_POLICY_V1.policyVersion);
    expect(MONACADO_MARKETPLACE_POLICY_V1_1_HASH).not.toBe(MONACADO_MARKETPLACE_POLICY_V1_HASH);
    expect(MONACADO_MARKETPLACE_POLICY_V1_1_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is the newest shipped version, and both versions stay resolvable", () => {
    expect(LATEST_MARKETPLACE_POLICY_VERSION).toBe(MARKETPLACE_POLICY_VERSION_1_1);
    /* A superseded version must stay readable: every receipt for every sale made
       under it resolves through this map. */
    expect(marketplacePolicyDocument(MARKETPLACE_POLICY_VERSION_1)).not.toBeNull();
    expect(marketplacePolicyDocument(MARKETPLACE_POLICY_VERSION_1_1)).not.toBeNull();
    expect(marketplacePolicyDocument("9.9.9")).toBeNull();
  });

  it("carries a content ref and a reacceptance decision for every shipped version", () => {
    for (const version of MARKETPLACE_POLICY_DOCUMENTS.keys()) {
      expect(MARKETPLACE_POLICY_CONTENT_REFS.get(version)).toBe(`marketplace-policy/${version}`);
      /* Both shipped versions require it: 1.0.0 because nothing preceded it,
         1.1.0 because it adds obligations a seller did not previously carry. */
      expect(MARKETPLACE_POLICY_REACCEPTANCE.get(version)).toBe(true);
    }
  });

  it("hashes deterministically, and a moved byte disagrees", () => {
    const roundTripped = JSON.parse(JSON.stringify(V1_1));
    expect(marketplacePolicyContentHash(roundTripped)).toBe(MONACADO_MARKETPLACE_POLICY_V1_1_HASH);

    const tampered = JSON.parse(JSON.stringify(V1_1));
    tampered.sections[0].paragraphs[0] += " ";
    expect(marketplacePolicyContentHash(tampered)).not.toBe(MONACADO_MARKETPLACE_POLICY_V1_1_HASH);
  });

  it("validates, uses only known section keys, and carries no markup", () => {
    expect(() => MarketplacePolicyDocument.parse(V1_1)).not.toThrow();
    for (const section of V1_1.sections) {
      expect(POLICY_SECTION_KEYS).toContain(section.key);
      for (const paragraph of section.paragraphs) {
        expect(paragraph).not.toMatch(/<[a-z/]/i);
        expect(paragraph).not.toContain("**");
      }
    }
  });
});

// — 2 · The previous version is untouched —

describe("1.10 · version 1.0.0 remains immutable", () => {
  it("keeps the hash it had, derived from its own bytes", () => {
    /* The load-bearing assertion of the whole phase. A shared paragraph constant
       between the two versions would have made this fail the moment 1.1.0's
       prose was edited — and would have changed what participants who accepted
       1.0.0 are recorded as having accepted. */
    expect(marketplacePolicyContentHash(MONACADO_MARKETPLACE_POLICY_V1)).toBe(
      MONACADO_MARKETPLACE_POLICY_V1_HASH,
    );
    expect(MONACADO_MARKETPLACE_POLICY_V1_HASH).toBe(
      "sha256:e50e87716ca2156eb51afa0fab52d4ab925109e8147199ece3a8e3160443cb85",
    );
  });

  it("states no refund governance, and is shown as stating none", () => {
    for (const key of REFUND_GOVERNANCE_SECTION_KEYS) {
      expect(selectSection(MONACADO_MARKETPLACE_POLICY_V1, key)).toBeNull();
    }
    for (const audience of POLICY_AUDIENCES) {
      /* Empty is the honest answer for a version that does not cover this. It is
         never filled in from 1.1.0. */
      expect(selectRefundGovernanceSections(MONACADO_MARKETPLACE_POLICY_V1, audience)).toEqual([]);
    }
  });

  it("shares no section object with 1.1.0", () => {
    for (const older of MONACADO_MARKETPLACE_POLICY_V1.sections) {
      for (const newer of V1_1.sections) {
        expect(older).not.toBe(newer);
      }
    }
  });

  it("closes the requirement 1.9 recorded rather than applied", () => {
    expect(REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION.mutateActiveVersion).toBe("REFUSED");
    for (const key of REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION.sectionsRequiringNewText) {
      /* 1.9 named REFUNDS_AND_CANCELLATION and SELLER_OBLIGATIONS. The first is a
         new section; the second is this document's existing seller-obligations
         section, which 1.1.0 extends rather than duplicating under a second key. */
      const resolved = key === "SELLER_OBLIGATIONS" ? "SELLER_RESPONSIBILITIES" : key;
      expect(selectSection(V1_1, resolved as PolicySection["key"])).not.toBeNull();
    }
  });
});

// — 3 · The settled refund rules —

describe("1.10 · the marketplace refund rules", () => {
  const refunds = selectSection(V1_1, "REFUNDS_AND_CANCELLATION");
  const prose = (refunds?.paragraphs ?? []).join("\n").toLowerCase();

  it("says the seller declares the policy and Monacado enforces the bound version", () => {
    expect(refunds).not.toBeNull();
    expect(prose).toContain("declared refund policy");
    expect(prose).toContain("bound to the order at checkout");
    expect(prose).toContain("does not change the terms of a purchase already completed");
  });

  it("requires the seller policy to state every disclosable term", () => {
    for (const term of [
      "whether refunds are available",
      "conditions under which one may be claimed",
      "period within which a refund must be requested",
      "shipping charge is treated",
      "procedure for requesting a refund",
      "support contact",
    ]) {
      expect(prose).toContain(term);
    }
  });

  it("permits a refund of complete lines that is partial against the order", () => {
    expect(prose).toContain("one or more complete lines");
    expect(prose).toContain("lines that are not included are unaffected");
    expect(prose).toContain("partial with respect to an order");
  });

  it("refuses an arbitrary partial-dollar refund of a single line", () => {
    expect(prose).toContain("arbitrary amount against one purchased item");
    expect(prose).toContain("is not supported under this policy");
  });

  it("names the single-line Order as a limitation, never as the policy", () => {
    expect(prose).toContain("consequence of how orders are currently composed");
    expect(prose).toContain("not a rule that a refund must cover an entire order");
  });

  it("never describes Monacado as refunding whole Orders only", () => {
    /* Checked across EVERY audience's rendering, not just this section: a
       sentence elsewhere saying the opposite would be the one somebody reads. */
    for (const audience of POLICY_AUDIENCES) {
      const text = proseFor(V1_1, audience);
      for (const forbidden of [
        "only the entire order",
        "entire order only",
        "whole orders only",
        "must cover the entire order",
        "refunds are all-or-nothing",
      ]) {
        expect(text, `${audience} :: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("makes shipping the seller policy's answer, never an automatic one", () => {
    expect(prose).toContain("governed by the seller refund policy applicable to the purchase");
    expect(prose).toContain("does not return all shipping charges as a matter of course");
    expect(prose).toContain("does not retain all shipping charges as a matter of course");
    expect(prose).toContain("does not apportion a shipping charge across part of an order");
  });

  it("requires a governed answer before a shared-shipping subset refund", () => {
    expect(prose).toContain("commercial question rather than an arithmetic one");
    expect(prose).toContain("before executing such a refund");
    expect(prose).toContain("apportionment rule that has not been adopted");
  });

  it("corrects tax without promising a jurisdiction-specific outcome", () => {
    expect(prose).toContain("corrected or reversed through monacado's tax process");
    expect(prose).toContain("no representation about the treatment of any particular tax");
  });

  it("preserves statutory rights and Monacado's merchant-of-record authority", () => {
    expect(prose).toContain("not displaced by a seller's declared refund terms");
    expect(prose).toContain("merchant of record");
    expect(prose).toContain("execute or decline a refund consistent with");
    expect(prose).toContain("correct its own payment, tax, and accounting records");
  });
});

// — 4 · Legal posture —

describe("1.10 · legal posture across the whole document", () => {
  const everything = V1_1.sections
    .flatMap((s) => [s.heading, ...s.paragraphs])
    .join("\n")
    .toLowerCase();

  it("asserts no jurisdiction-specific consumer-law guarantee", () => {
    for (const forbidden of [
      "consumer rights act",
      "distance selling",
      "14 days under",
      "eu law",
      "under california law",
      "governing law",
      "arbitration",
      "class action",
    ]) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
  });

  it("names no payment or tax provider in buyer-facing prose", () => {
    for (const forbidden of ["stripe", "paypal", "adyen", "payment_intent", "webhook"]) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
  });

  it("names no internal accounting record or table", () => {
    for (const forbidden of [
      "proceedsobligation",
      "proceedsrecoveryexception",
      "transactionreversal",
      "orderrefund",
      "economic snapshot",
      "orderline",
    ]) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
  });

  it("copies no commercial figure it does not own", () => {
    expect(everything).not.toMatch(/\b\d+(\.\d+)?\s?%/);
    expect(everything).not.toMatch(/basis points/);
  });
});

// — 5 · Audience transformations —

describe("1.10 · audience renderings derive from the one document", () => {
  it("gives every audience a rendering that is a subset, in document order", () => {
    const order = V1_1.sections.map((s) => s.key);
    for (const audience of POLICY_AUDIENCES) {
      const selected = selectSectionsForAudience(V1_1, audience);
      expect(selected.length).toBeGreaterThan(0);
      for (const section of selected) {
        expect(V1_1.sections).toContain(section);
        expect(section.audiences).toContain(audience);
      }
      const keys = selected.map((s) => s.key);
      expect(keys).toEqual(order.filter((k) => keys.includes(k)));
    }
  });

  it("narrows the refund view without ever widening it", () => {
    for (const audience of POLICY_AUDIENCES) {
      const all = selectSectionsForAudience(V1_1, audience);
      const refund = selectRefundGovernanceSections(V1_1, audience);
      /* A section a party may not see in full cannot appear in the narrow view.
         There is still exactly one audience projection. */
      for (const section of refund) expect(all).toContain(section);
      for (const section of refund) {
        expect(REFUND_GOVERNANCE_SECTION_KEYS).toContain(section.key);
      }
    }
  });

  it("shows every audience the core refund rules", () => {
    for (const audience of POLICY_AUDIENCES) {
      expect(
        selectRefundGovernanceSections(V1_1, audience).map((s) => s.key),
      ).toContain("REFUNDS_AND_CANCELLATION");
    }
  });
});

// — 6 · Seller-facing output —

describe("1.10 · the seller's rendering", () => {
  const prose = proseFor(V1_1, "SELLER");

  it("states the obligation to maintain and disclose a refund policy", () => {
    expect(prose).toContain("must maintain a declared refund policy");
    expect(prose).toContain("available for disclosure to a buyer before the buyer completes");
    expect(prose).toContain("no refund policy in force is not sold");
  });

  it("states the support-contact obligation and what a receipt keeps showing", () => {
    expect(prose).toContain("must answer refund requests at the support contact disclosed");
    expect(prose).toContain("continues to appear on that purchase's receipt");
  });

  it("states that the bound version governs, including against tighter new terms", () => {
    expect(prose).toContain("bound to the purchase");
    expect(prose).toContain("publishing tighter terms does not tighten them");
  });

  it("states that shipping treatment follows the seller's own declared policy", () => {
    expect(prose).toContain("follows the seller's own declared policy");
    expect(prose).toContain("does not intend to return shipping charges must say so");
  });

  it("states the consequence for proceeds and Monacado's corrections", () => {
    expect(prose).toContain("affects the proceeds attributable to it");
    expect(prose).toContain("payment, tax, and accounting records");
    expect(prose).toContain("cease to be payable");
    expect(prose).toContain("may be recovered, set off against amounts owed in future");
  });
});

// — 7 · Promoter-facing output —

describe("1.10 · the promoter's rendering", () => {
  const prose = proseFor(V1_1, "PROMOTER");

  it("states that commission is conditional on the sale remaining valid", () => {
    expect(prose).toContain("conditional on that sale remaining economically valid");
    expect(prose).toContain("commission attributable to that merchandise is reversed");
  });

  it("states that unpaid commission ceases to be payable", () => {
    expect(prose).toContain("not yet been paid cease to be payable");
  });

  it("states that paid commission may be recovered or offset", () => {
    expect(prose).toContain("may be recovered, set off against amounts owed in future");
    expect(prose).toContain("adjustment to the participant's account balance");
  });

  it("keeps historical payment evidence intact", () => {
    expect(prose).toContain("does not erase a payment that was made");
    expect(prose).toContain("remain recorded as they stand");
  });

  it("does not make the promoter responsible for the seller's refund decisions", () => {
    expect(prose).toContain("does not set the refund terms");
    expect(prose).toContain("not responsible for the seller's refund decisions");
    expect(prose).toContain("neither sets those terms nor decides a refund");
  });
});

// — 8 · Buyer-facing output —

describe("1.10 · the buyer's rendering", () => {
  const prose = proseFor(V1_1, "BUYER");

  it("states that eligibility follows the seller's disclosed policy, under law", () => {
    expect(prose).toContain("governed by the refund policy the seller declared");
    expect(prose).toContain("subject to this policy and to applicable law");
  });

  it("states that the receipt carries the governing terms and how to act on them", () => {
    expect(prose).toContain("appear on the purchase receipt");
    expect(prose).toContain("the seller refund policy that governed the purchase");
    expect(prose).toContain("how to request a refund");
  });

  it("states that no account is needed to request a refund", () => {
    expect(prose).toContain("account is not required in order to request a refund");
    expect(prose).toContain("may be refunded without one");
    expect(prose).toContain("does not require a buyer to create an account after a purchase");
  });

  it("states that shipping refundability follows the seller's disclosed policy", () => {
    expect(prose).toContain("governed by the seller refund policy applicable to the purchase");
  });

  it("states that tax is adjusted through Monacado's process", () => {
    expect(prose).toContain("corrected or reversed through monacado's tax process");
  });

  it("states that a future basket may return selected complete lines", () => {
    expect(prose).toContain("one or more complete lines");
    expect(prose).toContain("partial with respect to an order");
  });

  it("promises nothing outside the applicable policy or law", () => {
    for (const forbidden of [
      "always refunded",
      "guaranteed refund",
      "no questions asked",
      "unconditional refund",
    ]) {
      expect(prose, forbidden).not.toContain(forbidden);
    }
  });

  it("tells the buyer a receipt reproduces after the seller changes or disappears", () => {
    expect(prose).toContain("not replaced by a seller's current terms or current contact");
    expect(prose).toContain("ceases to trade");
  });
});

// — 9 · The receipt contract —

describe("1.10 · the receipt contract", () => {
  it("records the renderer and delivery as built", () => {
    expect(RECEIPT_SURFACE.readContract).toBe("IMPLEMENTED");
    expect(RECEIPT_SURFACE.renderer).toBe("IMPLEMENTED");
    expect(RECEIPT_SURFACE.delivery).toBe("IMPLEMENTED");
  });

  it("requires the historical terms, the version, the procedure, and the contact", () => {
    for (const required of [
      "EXACT_SELLER_REFUND_POLICY_VERSION_REFERENCE",
      "COMPLETE_APPLICABLE_SELLER_REFUND_POLICY",
      "REFUND_INITIATION_PROCEDURE",
      "PURCHASE_TIME_REFUND_SUPPORT_CONTACT",
      "MONETARY_SUMMARY",
      "SHIPPING_TREATMENT",
      "TAX_CHARGED",
      "MARKETPLACE_REFUND_RULES_AS_BOUND",
    ]) {
      expect(RECEIPT_CONTRACT.mustInclude).toContain(required);
    }
  });

  it("forbids substitution, an account requirement, a promoter, and economics", () => {
    for (const forbidden of [
      "SUBSTITUTE_CURRENT_POLICY_FOR_A_HISTORICAL_ORDER",
      "SUBSTITUTE_CURRENT_SUPPORT_CONTACT_FOR_THE_ONE_DISCLOSED",
      "REQUIRE_A_BUYER_ACCOUNT_TO_REQUEST_A_REFUND",
      "NAME_A_PROMOTER",
      "STATE_ANY_PARTY_ECONOMICS",
      "APPORTION_A_SHIPPING_CHARGE",
    ]) {
      expect(RECEIPT_CONTRACT.mustNever).toContain(forbidden);
    }
    expect(PROMOTER_ON_BUYER_RECEIPT).toBe("NOT_INCLUDED");
  });

  it("refuses every field a receipt must never carry", () => {
    for (const field of NEVER_ON_RECEIPT) {
      expect(() =>
        OrderReceiptView.parse({ ...RECEIPT_FIXTURE, [field]: "anything" }),
      ).toThrow();
    }
  });

  it("records the two identity gaps rather than papering over them", () => {
    expect(SELLER_DISPLAY_NAME_GAP.authoritativeSellerDisplayName).toBe("DOES_NOT_EXIST");
    expect(SELLER_DISPLAY_NAME_GAP.storefrontNameSubstitution).toContain("REFUSED");
    expect(RECEIPT_LINE_DESCRIPTION_GAP.notBound).toBe("PRODUCT_SOURCE_RECORD_VERSION");
    expect(RECEIPT_LINE_DESCRIPTION_GAP.liveReadSubstitution).toBe("REFUSED");
  });

  it("derives the total from its parts and never stores one", () => {
    const parsed = OrderReceiptView.parse(RECEIPT_FIXTURE);
    expect(parsed.money.totalMinorUnits).toBe(
      parsed.money.merchandiseMinorUnits +
        parsed.money.taxMinorUnits +
        parsed.money.shippingMinorUnits +
        parsed.money.otherPassThroughMinorUnits,
    );
  });

  it("can never require a buyer account", () => {
    expect(
      () =>
        OrderReceiptView.parse({
          ...RECEIPT_FIXTURE,
          refundInitiation: { ...RECEIPT_FIXTURE.refundInitiation, requiresBuyerAccount: true },
        }),
    ).toThrow();
  });
});

// — 10 · The rendered receipt —

describe("1.10 · the buyer's rendered receipt", () => {
  const receipt = OrderReceiptView.parse(RECEIPT_FIXTURE);
  const rendered = renderBuyerConfirmation(ORDER_FIXTURE, receipt);
  const body = rendered.body;

  it("states the exact historical policy version reference", () => {
    expect(body).toContain(SELLER_REFUND_POLICY_ID);
    expect(body).toContain("version 2");
  });

  it("renders the complete governing policy, not a summary", () => {
    for (const section of receipt.refund.policyVersion!.document.sections) {
      expect(body).toContain(section.heading);
      expect(body).toContain(section.body);
    }
  });

  it("states the procedure and the contact the buyer was actually shown", () => {
    expect(body).toContain("Quote your order reference when you write to us.");
    expect(body).toContain("disclosed-at-purchase@seller.test");
    expect(body).toContain("support contact that was in effect when you bought");
  });

  it("shows the seller's current contact beside the historical one, never instead", () => {
    expect(body).toContain("today@seller.test");
    const disclosedAt = body.indexOf("disclosed-at-purchase@seller.test");
    const currentAt = body.indexOf("today@seller.test");
    expect(disclosedAt).toBeGreaterThan(-1);
    expect(currentAt).toBeGreaterThan(disclosedAt);
    expect(body).toContain("shown in addition to the one above");
  });

  it("does not print the current contact twice when it has not changed", () => {
    const unchanged = OrderReceiptView.parse({
      ...RECEIPT_FIXTURE,
      refund: {
        ...RECEIPT_FIXTURE.refund,
        currentSellerSupportContact: "disclosed-at-purchase@seller.test",
      },
    });
    const text = renderBuyerConfirmation(ORDER_FIXTURE, unchanged).body;
    expect(text).not.toContain("shown in addition to the one above");
  });

  it("renders an old receipt for a seller with no usable contact today", () => {
    const goneDark = OrderReceiptView.parse({
      ...RECEIPT_FIXTURE,
      refund: { ...RECEIPT_FIXTURE.refund, currentSellerSupportContact: null },
    });
    const text = renderBuyerConfirmation(ORDER_FIXTURE, goneDark).body;
    expect(text).toContain("disclosed-at-purchase@seller.test");
    expect(text).not.toContain("today@seller.test");
  });

  it("tells the buyer no account is needed", () => {
    expect(body).toContain("You do not need a Monacado account to request a refund.");
  });

  it("states the money, including tax at zero", () => {
    expect(body).toContain("$90.00");
    expect(body).toContain("$5.00");
    expect(body).toContain("$100.00");
    const zeroTax = OrderReceiptView.parse({
      ...RECEIPT_FIXTURE,
      money: { ...RECEIPT_FIXTURE.money, taxMinorUnits: 0, totalMinorUnits: 9_500 },
    });
    /* Stated at zero. Silence is ambiguous between "none was charged" and "we
       did not say", and only one of those is a disclosure. */
    expect(renderBuyerConfirmation(ORDER_FIXTURE, zeroTax).body).toContain("Tax:");
  });

  it("states the declared shipping treatment in the buyer's words", () => {
    expect(body).toContain("not refunded under this policy");
  });

  it("names no promoter, no participant, no economics, and no provider reference", () => {
    for (const leak of [
      "mon:mpart:",
      "mon:cpol:",
      ORDER_FIXTURE.sellerParticipantId,
      ORDER_FIXTURE.policyId,
      ORDER_FIXTURE.storefrontId,
      "promoter",
      "retained",
      "proceeds",
      "commission",
      "pi_",
      "re_",
    ]) {
      expect(body, leak).not.toContain(leak);
    }
  });

  it("renders without a receipt view exactly as 1.1 did", () => {
    const thin = renderBuyerConfirmation(ORDER_FIXTURE).body;
    expect(thin).toContain(ORDER_FIXTURE.orderId);
    expect(thin).toContain("$100.00");
    /* A receipt that could not be assembled still confirms the purchase. */
    expect(thin).not.toContain("REFUNDS");
  });

  it("shows no refund section, and substitutes nothing, when no policy is bound", () => {
    const unbound = OrderReceiptView.parse({
      ...RECEIPT_FIXTURE,
      refund: {
        orderId: RECEIPT_FIXTURE.orderId,
        policyVersion: null,
        policyRef: null,
        procedure: null,
        currentSellerSupportContact: "today@seller.test",
        unavailableReason: "POLICY_NOT_BOUND",
        evaluatedAt: RECEIPT_FIXTURE.evaluatedAt,
      },
      shipping: { ...RECEIPT_FIXTURE.shipping, refundability: null },
      marketplacePolicy: null,
    });
    const text = renderBuyerConfirmation(ORDER_FIXTURE, unbound).body;
    expect(text).not.toContain("REFUNDS");
    expect(text).not.toContain("today@seller.test");
  });

  it("records what this rendering carries and what it refers to", () => {
    expect(RECEIPT_EMAIL_RENDERING.sellerRefundPolicy).toBe("COMPLETE");
    expect(RECEIPT_EMAIL_RENDERING.marketplacePolicyRefundSections).toBe(
      "REFERENCED_BY_BOUND_VERSION",
    );
    expect(RECEIPT_EMAIL_RENDERING.promoterIdentity).toBe("NEVER");
    expect(RECEIPT_EMAIL_RENDERING.partyEconomics).toBe("NEVER");
    /* The bound marketplace version IS named, so a reader can produce the rules
       that governed their purchase even though they are not inlined. */
    expect(body).toContain("version 1.1.0");
  });
});

// — 11 · The operator command —

describe("1.10 · the bootstrap command selects a shipped version", () => {
  const ACCOUNT = "acct_1";
  const env = { MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID: ACCOUNT };

  it("defaults to the newest shipped version", () => {
    expect(parseCommandOptions([], env).policyVersion).toBe(LATEST_MARKETPLACE_POLICY_VERSION);
  });

  it("accepts any version this deployment ships", () => {
    expect(parseCommandOptions(["--version=1.0.0"], env).policyVersion).toBe("1.0.0");
    expect(parseCommandOptions(["--version=1.1.0"], env).policyVersion).toBe("1.1.0");
  });

  it("refuses a version it does not ship rather than defaulting to one", () => {
    /* A mistyped version is a mistake about which terms are being published.
       Publishing different ones instead is the worst reading of it. */
    expect(() => parseCommandOptions(["--version=1.2.0"], env)).toThrow(BootstrapUsageError);
    expect(() => parseCommandOptions(["--version="], env)).toThrow(BootstrapUsageError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ORDER_ID = `mon:order:${pad26("P110TORD")}`;
const SELLER_REFUND_POLICY_ID = `mon:srpol:${pad26("P110TSRPOL")}`;

const ORDER_FIXTURE: OrderRecord = {
  orderId: ORDER_ID,
  buyer: { buyerKind: "GUEST_BUYER", guestClaimCodeDigest: "a".repeat(64) },
  guestClaim: { claimedByAccountId: null, claimedAt: null },
  internalListingId: `mon:listing:${pad26("P110TLSTNG")}`,
  listingSourceRecordId: `mon:srec:${pad26("P110TLSREC")}`,
  listingSourceRecordVersion: "1",
  policyId: `mon:cpol:${pad26("P110TCPOL")}`,
  policyVersion: "1",
  storefrontId: `mon:storefront:${pad26("P110TSTORE")}`,
  internalProductId: `mon:product:${pad26("P110TPROD")}`,
  transactionType: "SELLER_DIRECT",
  sellerParticipantId: `mon:mpart:${pad26("P110TSELLER")}`,
  promoterParticipantId: null,
  quote: {
    currency: "USD",
    quotedCommercialRetailAmountMinorUnits: 9_000,
    quotedTaxAmountMinorUnits: 500,
    quotedShippingAmountMinorUnits: 500,
    quotedOtherPassThroughAmountMinorUnits: 0,
  },
  lifecycle: "PAID",
  paymentFailureCode: null,
  placedAt: "2028-09-05T12:00:00.000Z",
  paidAt: "2028-09-05T12:00:05.000Z",
  failedAt: null,
  cancelledAt: null,
  createdAt: "2028-09-05T12:00:00.000Z",
  updatedAt: "2028-09-05T12:00:05.000Z",
};

/**
 * A receipt for an Order sold under seller policy version 2, whose seller has
 * since published version 3 and moved their support address.
 *
 * Constructed rather than read, so the pure suite proves the *rendering* rule
 * without a database. The integration suite proves the *reading* rule.
 */
const RECEIPT_FIXTURE = {
  orderId: ORDER_ID,
  lifecycle: "PAID",
  placedAt: "2028-09-05T12:00:00.000Z",
  paidAt: "2028-09-05T12:00:05.000Z",
  seller: { participantId: ORDER_FIXTURE.sellerParticipantId, displayName: null },
  lines: [
    {
      internalListingId: ORDER_FIXTURE.internalListingId,
      listingSourceRecordVersion: "1",
      internalProductId: ORDER_FIXTURE.internalProductId,
      description: null,
      merchandiseMinorUnits: 9_000,
    },
  ],
  money: {
    currency: "USD",
    merchandiseMinorUnits: 9_000,
    taxMinorUnits: 500,
    shippingMinorUnits: 500,
    otherPassThroughMinorUnits: 0,
    totalMinorUnits: 10_000,
  },
  shipping: {
    chargedMinorUnits: 500,
    refundability: "NEVER_REFUNDED",
    apportionment: "NOT_APPORTIONED",
  },
  refund: {
    orderId: ORDER_ID,
    policyVersion: {
      policyId: SELLER_REFUND_POLICY_ID,
      policyVersion: "2",
      sellerParticipantId: ORDER_FIXTURE.sellerParticipantId,
      status: "RETIRED",
      terms: {
        refundsAllowed: true,
        eligibilityConditions: ["ANY_REASON"],
        refundWindowDays: 30,
        shippingRefundability: "NEVER_REFUNDED",
        procedureKind: "CONTACT_SELLER_SUPPORT",
      },
      document: {
        title: "Returns and refunds",
        sections: [
          { key: "SUMMARY", heading: "Summary", body: "We accept returns for any reason." },
          {
            key: "WINDOW",
            heading: "Time limit",
            body: "Refunds may be requested within 30 days of purchase.",
          },
          {
            key: "SHIPPING",
            heading: "Shipping charges",
            body: "Shipping charges are not refunded.",
          },
          {
            key: "PROCEDURE",
            heading: "How to request a refund",
            body: "Quote your order reference when you write to us.",
          },
        ],
      },
      contentHash: `sha256:${"c".repeat(64)}`,
      effectiveFrom: "2028-08-01T00:00:00.000Z",
      recordedByAccountId: "acct_seller",
      recordedAt: "2028-08-01T00:00:00.000Z",
      activatedAt: "2028-08-01T00:00:00.000Z",
      retiredAt: "2028-09-20T00:00:00.000Z",
    },
    policyRef: {
      policyId: SELLER_REFUND_POLICY_ID,
      policyVersion: "2",
      contentHash: `sha256:${"c".repeat(64)}`,
    },
    procedure: {
      kind: "CONTACT_SELLER_SUPPORT",
      instructions: "Quote your order reference when you write to us.",
      purchaseTimeRefundContact: {
        address: "disclosed-at-purchase@seller.test",
        source: "DEDICATED_SUPPORT",
        state: "VERIFIED",
        capturedAt: "2028-09-05T12:00:00.000Z",
      },
      requiresBuyerAccount: false,
    },
    currentSellerSupportContact: "today@seller.test",
    unavailableReason: null,
    evaluatedAt: "2028-10-01T00:00:00.000Z",
  },
  marketplacePolicy: {
    policyId: MONACADO_MARKETPLACE_POLICY_ID,
    policyVersion: MARKETPLACE_POLICY_VERSION_1_1,
    contentHash: MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
    refundSections: selectRefundGovernanceSections(V1_1, "BUYER"),
  },
  refundInitiation: {
    requiresBuyerAccount: false,
    guestVerification: "ORDER_REFERENCE_AND_PURCHASE_CONFIRMATION",
    accountCreationAfterPurchase: "NEVER_REQUIRED",
  },
  unavailableReason: null,
  evaluatedAt: "2028-10-01T00:00:00.000Z",
} as const;
