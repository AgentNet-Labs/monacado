/**
 * Monacado Marketplace Policy — shipped source content (Phase 1.3, extended 1.10).
 *
 * **The authoritative content**, held once and rendered many ways. Every channel
 * — seller onboarding, promoter onboarding, the public terms page, a checkout
 * disclosure, a receipt, a printable document — projects *this*, through
 * `selectSectionsForAudience`. There is no second copy to keep in step.
 *
 * ## Why the content is a source module
 *
 * Because it must be **immutable once activated**, and a database text column is
 * editable in place. Here a change is a diff, in a commit, under review, and the
 * governance row's `contentHash` will disagree if the bytes move without a new
 * version — which is precisely the failure a policy model exists to prevent.
 *
 * ## What it states, and what it does not
 *
 * It states **operating rules**: what each party undertakes to do. It states no
 * legal conclusion — no governing law, no warranty language, no liability cap, no
 * arbitration clause. Those are counsel's, and writing them here would be
 * inventing legal advice inside a type definition.
 *
 * It also copies **no mutable figure it does not own**. Monacado's retention rate
 * lives in `0M.R1`'s versioned commercial policy and is *referenced*; the download
 * allowance lives in `1.2`'s delivery policy and is *referenced*. A copied number
 * is a second authority, and the copy is always the one somebody reads.
 */

import { createHash } from "node:crypto";
import { canonicalJsonString } from "../integrity/canonical-json";
import {
  MarketplacePolicyDocument,
  type PolicyContentHash,
} from "./marketplace-policy";
import { DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE } from "./digital-delivery-policy";

/**
 * Stable identity of the Monacado Marketplace Policy. Never reissued.
 *
 * A fixed constant rather than a minted id: there is exactly one marketplace
 * policy, every deployment must agree on which one it is, and an id generated per
 * environment would make an acceptance recorded in one unreadable in another.
 * The opaque body is Crockford — `I`, `L`, `O`, and `U` are not in the alphabet,
 * so the mnemonic is folded rather than spelled.
 */
export const MONACADO_MARKETPLACE_POLICY_ID = "mon:mpol:M0NACAD0MARKETP0ACEP000CY0" as const;

export const MARKETPLACE_POLICY_VERSION_1 = "1.0.0" as const;
export const MARKETPLACE_POLICY_CONTENT_REF_1 = "marketplace-policy/1.0.0" as const;

/**
 * The deterministic hash of one policy document.
 *
 * Canonical JSON first — the same canonicaliser the capsule pipeline uses — so
 * the hash depends on the *content* and not on key order or formatting. Two
 * serialisations of one policy must hash identically, or the binding it exists to
 * provide is worthless.
 */
export function marketplacePolicyContentHash(
  document: MarketplacePolicyDocument,
): PolicyContentHash {
  const canonical = canonicalJsonString(MarketplacePolicyDocument.parse(document));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Monacado Marketplace Policy, version 1.0.0.
 *
 * Every rule below is one Monacado has **already committed to elsewhere in this
 * repository** — the merchant-of-record model, the proceeds split, the digital
 * delivery policy, the checkout information requirements. This states them to the
 * people they bind, in one place, rather than introducing anything new.
 */
export const MONACADO_MARKETPLACE_POLICY_V1: MarketplacePolicyDocument =
  MarketplacePolicyDocument.parse({
    policyId: MONACADO_MARKETPLACE_POLICY_ID,
    policyVersion: MARKETPLACE_POLICY_VERSION_1,
    title: "Monacado Marketplace Policy",
    sections: [
      {
        key: "MONACADO_ROLE",
        heading: "Monacado's role",
        /* All three audiences: each party needs to know who they are transacting
           with, and three copies of one fact would be three things to keep
           identical. */
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Monacado is the merchant of record for purchases made through the marketplace. Monacado contracts with the buyer, takes payment, and is the party shown on the buyer's payment statement.",
          "Monacado operates the marketplace infrastructure: listings, checkout, payment processing, transaction records, proceeds accounting, and the notification and delivery infrastructure that supports them.",
          "Monacado is not the producer of the products sold through the marketplace. Product accuracy, fulfilment, and product support are the seller's responsibilities, and this policy distinguishes the two throughout so that a buyer, a seller, and a promoter can each tell which party owes what.",
          "Monacado retains an amount from each sale under its commercial policy. The retained amount, the seller's proceeds, and any promoter's proceeds are recorded on an immutable per-sale economic record at the moment the sale completes.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "The retained percentage and fixed amount are governed by the commercial policy version bound to each Order, not by this document.",
          },
        ],
      },
      {
        key: "SELLER_RESPONSIBILITIES",
        heading: "Seller responsibilities",
        audiences: ["SELLER"],
        paragraphs: [
          "Product information must be accurate. A seller is responsible for the descriptions, specifications, images, availability, and delivery mode recorded against their products, and for correcting them when they cease to be accurate.",
          "A seller must declare how each product is delivered. A product marked for physical delivery requires a delivery address at checkout; a product marked for digital delivery does not. A product that does not declare a delivery mode cannot be sold.",
          "A seller is responsible for fulfilling completed orders. For physical products this means dispatching the goods to the delivery address recorded with the order. For digital products this means that the artifact the buyer is entitled to remains available for the duration of the entitlement.",
          "A seller is responsible for product support and for customer questions about the product itself. Monacado handles questions about payment, the transaction record, and the marketplace platform.",
          "A seller is responsible for exceptional digital-delivery support. Where a buyer has exhausted the automated download allowance and requires further access, the decision to authorise it is the seller's, because only the seller can judge whether the request is a legitimate re-install or an attempt at redistribution.",
          "Where a seller hosts a digital product externally, the seller is responsible for keeping that artifact available and reachable for the duration of the entitlement. Access must be gated by Monacado entitlement verification or a Monacado-issued short-lived credential; a permanent reusable secret link is not an acceptable access control.",
          "Every activated seller must maintain a reachable customer support email address, verified by Monacado. A seller may nominate a dedicated support address; if none is nominated, the seller's verified primary account address is used. A seller whose support address becomes unreachable must supply and verify a replacement.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "DIGITAL_DELIVERY",
            note: "The digital delivery entitlement, allowance, and credential rules in full.",
          },
        ],
      },
      {
        key: "PROMOTER_RESPONSIBILITIES",
        heading: "Promoter responsibilities",
        audiences: ["PROMOTER"],
        paragraphs: [
          "Promotion must be truthful. A promoter must not describe a product in terms the seller's own product information does not support, and must not represent a product's origin, capability, availability, or endorsement inaccurately.",
          "A promoter must promote a product on the terms of the exact offer version they accepted. Where a seller changes the commercial terms of an offer, the promoter is notified and the previously accepted version continues to govern any listing until the promoter acts on the change.",
          "A promoter must not misrepresent their relationship to the seller or to Monacado. A promoter sells through their own storefront as an independent participant; they are not an agent of the seller and not an agent of Monacado.",
          "A promoter sets the retail price of the products they promote, within the terms of the accepted offer. The promoter's proceeds are the difference between what Monacado acquires the product for and the seller's contracted wholesale price, plus any seller-funded commission the offer provides for.",
          "A promoter must not present a product as available where the underlying offer or product is no longer commercially available.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "Commission methods and rates are governed by the accepted offer version and the commercial policy bound to each Order.",
          },
        ],
      },
      {
        key: "DIGITAL_DELIVERY",
        heading: "Digital delivery",
        /* Sellers owe the support; buyers need to know what they are owed. */
        audiences: ["SELLER", "BUYER"],
        paragraphs: [
          "A completed purchase of a digital product creates a durable entitlement: the buyer's continuing right to access what they bought. The entitlement is created by the completed purchase and is not dependent on any email, link, or credential remaining valid.",
          "A download link or token is a temporary credential for exercising that right on one occasion. It is not the entitlement. Losing a link does not lose the purchase, and possessing a link is not by itself evidence of a purchase.",
          `Monacado's default allowance is ${DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE} successful downloads per digital product while the entitlement stands.`,
          "Downloads that fail, are interrupted, or do not complete do not normally consume the allowance. The allowance counts deliveries the buyer actually received.",
          "While the entitlement stands and allowance remains, a buyer may obtain fresh download credentials themselves without contacting anyone. A fresh credential is issued each time; a previously issued credential is never recovered, reissued, or extended.",
          "Download credentials are short-lived, opaque, scoped to a single entitlement and artifact, usage-limited, and revocable. Monacado does not retain them in a form from which the original credential could be reproduced.",
          "Where a product is hosted outside Monacado, access must still be gated by Monacado entitlement verification or a Monacado-issued short-lived credential. A permanent reusable secret link is not an acceptable access control, because it cannot be expired, scoped, or withdrawn without breaking every legitimate buyer.",
          "Once the automated allowance is exhausted, further access requires the seller's authorisation. Monacado routes the request to the seller; the seller decides.",
          "Monacado provides the entitlement and credential infrastructure and routes exceptional requests. The seller provides the product, keeps it available, and owns exceptional access and product-delivery support.",
        ],
        references: [
          {
            kind: "DIGITAL_DELIVERY_POLICY",
            ref: "DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE",
            note: "The allowance and credential rules are defined in Monacado's digital delivery policy and are stated here for the parties they bind.",
          },
        ],
      },
      {
        key: "BUYER_CHECKOUT_INFORMATION",
        heading: "Information collected at checkout",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "Completing a purchase requires a name, an email address, and a billing address. Monacado uses them to authorise payment, determine the applicable tax jurisdiction, send transaction notices, and answer support questions about the order.",
          "A delivery address is required only when the purchase includes a product that requires physical delivery. A purchase of digital products alone is not asked for a delivery address, and none is retained for it.",
          "A Monacado account is not required in order to buy. A purchase may be completed as a guest, and completing one does not create an account or a marketplace participant record.",
          "Payment card details are entered with Monacado's payment provider and are never held by Monacado.",
          "Disclosures that apply to a purchase may be presented at checkout, on the receipt, or both. The policy version in force at the time of the purchase is the one that applies to it.",
        ],
        references: [],
      },
      {
        key: "COMMERCIAL_POLICY_REFERENCE",
        heading: "Commercial terms",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "The amount Monacado retains from a sale is set by Monacado's versioned commercial policy. Each order records the exact commercial policy version under which it was priced, so the terms that applied to a completed sale remain determinable afterwards.",
          "This document does not restate the retained percentage, the fixed retained amount, or any commission rate. Those figures are governed by the commercial policy and offer versions bound to each transaction, and a copy here would be a second answer capable of disagreeing with the one that actually applied.",
          "Proceeds are recorded as obligations when a sale completes. A recorded obligation is an accounting claim; it is not itself a payment, and the timing and execution of payouts are governed separately.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "The authoritative source of retention and commission figures for any given transaction.",
          },
        ],
      },
      {
        key: "POLICY_CHANGES",
        heading: "Changes to this policy",
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Monacado may issue new versions of this policy. Each version is recorded separately and the version in force at any moment is identified; earlier versions remain available so that a past acceptance or a past transaction can still be read against the terms that applied to it.",
          "Where a new version makes a material change to what a seller or promoter undertakes, Monacado may require that participants accept the new version. A participant's previous acceptances are not altered or withdrawn by a later version being issued.",
          "A purchase is governed by the policy version in force when the purchase was completed.",
        ],
        references: [],
      },
    ],
  });

/** The content hash of version 1.0.0, derived rather than written down. */
export const MONACADO_MARKETPLACE_POLICY_V1_HASH: PolicyContentHash =
  marketplacePolicyContentHash(MONACADO_MARKETPLACE_POLICY_V1);

// ─────────────────────────────────────────────────────────────────────────────
// Version 1.1.0 — refund governance (Phase 1.10)
// ─────────────────────────────────────────────────────────────────────────────

export const MARKETPLACE_POLICY_VERSION_1_1 = "1.1.0" as const;
export const MARKETPLACE_POLICY_CONTENT_REF_1_1 = "marketplace-policy/1.1.0" as const;

/**
 * Monacado Marketplace Policy, version 1.1.0.
 *
 * **A complete document, written out in full, and not composed from 1.0.0.**
 *
 * Sharing section constants between two versions would have been shorter and is
 * exactly wrong: an edit to a shared paragraph would silently change 1.0.0's
 * bytes, and therefore 1.0.0's derived hash, and therefore what every participant
 * who accepted 1.0.0 is recorded as having accepted. A version is a document, not
 * a diff, and the duplication below is the property that makes 1.0.0 immutable in
 * practice rather than merely in principle.
 *
 * ## What changed, and why a new version rather than an edit
 *
 * `1.9` shipped seller-declared, version-bound refund governance and deliberately
 * did **not** state it here — 1.0.0 was `ACTIVE` and already accepted, and editing
 * it would have changed terms people had agreed to. The requirement was recorded
 * in `REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION` instead. This is that version.
 *
 * | Section | Disposition |
 * | --- | --- |
 * | `REFUNDS_AND_CANCELLATION` | new — the marketplace-level refund rules |
 * | `REFUND_REQUESTS` | new — how a refund is asked for, without an account |
 * | `PURCHASE_RECEIPTS` | new — what a receipt states, and what it never substitutes |
 * | `REFUND_EFFECT_ON_PROCEEDS` | new — proceeds and commission after a refund |
 * | `SELLER_RESPONSIBILITIES` | extended — refund policy, contact, and honouring |
 * | `PROMOTER_RESPONSIBILITIES` | extended — commission is conditional |
 * | `BUYER_CHECKOUT_INFORMATION` | extended — the policy is disclosed before purchase |
 * | everything else | verbatim from 1.0.0 |
 *
 * ## What it still does not do
 *
 * It states no jurisdiction-specific consumer-law guarantee, names no provider,
 * describes no provider mechanism, and copies no commercial figure. The seller's
 * terms are *referenced*, never restated — a marketplace document that repeated
 * one seller's returns window would be a second authority able to disagree with
 * the version actually bound to the sale.
 */
export const MONACADO_MARKETPLACE_POLICY_V1_1: MarketplacePolicyDocument =
  MarketplacePolicyDocument.parse({
    policyId: MONACADO_MARKETPLACE_POLICY_ID,
    policyVersion: MARKETPLACE_POLICY_VERSION_1_1,
    title: "Monacado Marketplace Policy",
    sections: [
      {
        key: "MONACADO_ROLE",
        heading: "Monacado's role",
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Monacado is the merchant of record for purchases made through the marketplace. Monacado contracts with the buyer, takes payment, and is the party shown on the buyer's payment statement.",
          "Monacado operates the marketplace infrastructure: listings, checkout, payment processing, transaction records, proceeds accounting, and the notification and delivery infrastructure that supports them.",
          "Monacado is not the producer of the products sold through the marketplace. Product accuracy, fulfilment, and product support are the seller's responsibilities, and this policy distinguishes the two throughout so that a buyer, a seller, and a promoter can each tell which party owes what.",
          "Monacado retains an amount from each sale under its commercial policy. The retained amount, the seller's proceeds, and any promoter's proceeds are recorded on an immutable per-sale economic record at the moment the sale completes.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "The retained percentage and fixed amount are governed by the commercial policy version bound to each Order, not by this document.",
          },
        ],
      },
      {
        key: "SELLER_RESPONSIBILITIES",
        heading: "Seller responsibilities",
        audiences: ["SELLER"],
        paragraphs: [
          "Product information must be accurate. A seller is responsible for the descriptions, specifications, images, availability, and delivery mode recorded against their products, and for correcting them when they cease to be accurate.",
          "A seller must declare how each product is delivered. A product marked for physical delivery requires a delivery address at checkout; a product marked for digital delivery does not. A product that does not declare a delivery mode cannot be sold.",
          "A seller is responsible for fulfilling completed orders. For physical products this means dispatching the goods to the delivery address recorded with the order. For digital products this means that the artifact the buyer is entitled to remains available for the duration of the entitlement.",
          "A seller is responsible for product support and for customer questions about the product itself. Monacado handles questions about payment, the transaction record, and the marketplace platform.",
          "A seller is responsible for exceptional digital-delivery support. Where a buyer has exhausted the automated download allowance and requires further access, the decision to authorise it is the seller's, because only the seller can judge whether the request is a legitimate re-install or an attempt at redistribution.",
          "Where a seller hosts a digital product externally, the seller is responsible for keeping that artifact available and reachable for the duration of the entitlement. Access must be gated by Monacado entitlement verification or a Monacado-issued short-lived credential; a permanent reusable secret link is not an acceptable access control.",
          "Every activated seller must maintain a reachable customer support email address, verified by Monacado. A seller may nominate a dedicated support address; if none is nominated, the seller's verified primary account address is used. A seller whose support address becomes unreachable must supply and verify a replacement.",
          "A seller must maintain a declared refund policy covering the products they sell through the marketplace, must keep it accurate, and must have it available for disclosure to a buyer before the buyer completes a purchase. A product whose seller has no refund policy in force is not sold.",
          "A seller's refund policy must state whether refunds are available, the conditions under which one may be claimed, any period within which a refund must be requested, how the buyer's shipping charge is treated, the procedure for requesting a refund, and the support contact at which the seller will receive refund requests.",
          "A seller must answer refund requests at the support contact disclosed with the purchase. That contact is recorded with the purchase and continues to appear on that purchase's receipt, so a seller who changes their support arrangements must keep the change from stranding buyers who hold an earlier receipt.",
          "A seller must honour refund requests that are eligible under the version of their refund policy that was bound to the purchase, including where the seller's current terms differ from it. Publishing tighter terms does not tighten them for a purchase already made.",
          "How a buyer's shipping charge is treated on a refund follows the seller's own declared policy. A seller who does not intend to return shipping charges must say so in the policy they disclose before the sale.",
          "A refunded sale affects the proceeds attributable to it, and Monacado may correct the payment, tax, and accounting records for that sale to the extent this policy and applicable law require.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "DIGITAL_DELIVERY",
            note: "The digital delivery entitlement, allowance, and credential rules in full.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUNDS_AND_CANCELLATION",
            note: "The marketplace-level refund rules a seller's declared policy operates within.",
          },
        ],
      },
      {
        key: "PROMOTER_RESPONSIBILITIES",
        heading: "Promoter responsibilities",
        audiences: ["PROMOTER"],
        paragraphs: [
          "Promotion must be truthful. A promoter must not describe a product in terms the seller's own product information does not support, and must not represent a product's origin, capability, availability, or endorsement inaccurately.",
          "A promoter must promote a product on the terms of the exact offer version they accepted. Where a seller changes the commercial terms of an offer, the promoter is notified and the previously accepted version continues to govern any listing until the promoter acts on the change.",
          "A promoter must not misrepresent their relationship to the seller or to Monacado. A promoter sells through their own storefront as an independent participant; they are not an agent of the seller and not an agent of Monacado.",
          "A promoter sets the retail price of the products they promote, within the terms of the accepted offer. The promoter's proceeds are the difference between what Monacado acquires the product for and the seller's contracted wholesale price, plus any seller-funded commission the offer provides for.",
          "A promoter must not present a product as available where the underlying offer or product is no longer commercially available.",
          "A promoter does not set the refund terms for the products they promote and is not responsible for the seller's refund decisions. A promoter must not represent a product's refund terms as anything other than what the seller has declared for it.",
          "A promoter's commission on a sale is conditional on that sale remaining economically valid. Where promoted merchandise is refunded, the commission attributable to that merchandise is reversed.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "Commission methods and rates are governed by the accepted offer version and the commercial policy bound to each Order.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUND_EFFECT_ON_PROCEEDS",
            note: "What happens to a commission when promoted merchandise is refunded.",
          },
        ],
      },
      {
        key: "DIGITAL_DELIVERY",
        heading: "Digital delivery",
        audiences: ["SELLER", "BUYER"],
        paragraphs: [
          "A completed purchase of a digital product creates a durable entitlement: the buyer's continuing right to access what they bought. The entitlement is created by the completed purchase and is not dependent on any email, link, or credential remaining valid.",
          "A download link or token is a temporary credential for exercising that right on one occasion. It is not the entitlement. Losing a link does not lose the purchase, and possessing a link is not by itself evidence of a purchase.",
          `Monacado's default allowance is ${DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE} successful downloads per digital product while the entitlement stands.`,
          "Downloads that fail, are interrupted, or do not complete do not normally consume the allowance. The allowance counts deliveries the buyer actually received.",
          "While the entitlement stands and allowance remains, a buyer may obtain fresh download credentials themselves without contacting anyone. A fresh credential is issued each time; a previously issued credential is never recovered, reissued, or extended.",
          "Download credentials are short-lived, opaque, scoped to a single entitlement and artifact, usage-limited, and revocable. Monacado does not retain them in a form from which the original credential could be reproduced.",
          "Where a product is hosted outside Monacado, access must still be gated by Monacado entitlement verification or a Monacado-issued short-lived credential. A permanent reusable secret link is not an acceptable access control, because it cannot be expired, scoped, or withdrawn without breaking every legitimate buyer.",
          "Once the automated allowance is exhausted, further access requires the seller's authorisation. Monacado routes the request to the seller; the seller decides.",
          "Monacado provides the entitlement and credential infrastructure and routes exceptional requests. The seller provides the product, keeps it available, and owns exceptional access and product-delivery support.",
        ],
        references: [
          {
            kind: "DIGITAL_DELIVERY_POLICY",
            ref: "DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE",
            note: "The allowance and credential rules are defined in Monacado's digital delivery policy and are stated here for the parties they bind.",
          },
        ],
      },
      {
        key: "BUYER_CHECKOUT_INFORMATION",
        heading: "Information collected at checkout",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "Completing a purchase requires a name, an email address, and a billing address. Monacado uses them to authorise payment, determine the applicable tax jurisdiction, send transaction notices, and answer support questions about the order.",
          "A delivery address is required only when the purchase includes a product that requires physical delivery. A purchase of digital products alone is not asked for a delivery address, and none is retained for it.",
          "A Monacado account is not required in order to buy. A purchase may be completed as a guest, and completing one does not create an account or a marketplace participant record.",
          "Payment card details are entered with Monacado's payment provider and are never held by Monacado.",
          "Disclosures that apply to a purchase may be presented at checkout, on the receipt, or both. The policy version in force at the time of the purchase is the one that applies to it.",
          "The seller's refund policy applicable to the purchase is available to the buyer before the purchase is completed, and the exact version disclosed is the version the order binds.",
        ],
        references: [],
      },
      {
        key: "COMMERCIAL_POLICY_REFERENCE",
        heading: "Commercial terms",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "The amount Monacado retains from a sale is set by Monacado's versioned commercial policy. Each order records the exact commercial policy version under which it was priced, so the terms that applied to a completed sale remain determinable afterwards.",
          "This document does not restate the retained percentage, the fixed retained amount, or any commission rate. Those figures are governed by the commercial policy and offer versions bound to each transaction, and a copy here would be a second answer capable of disagreeing with the one that actually applied.",
          "Proceeds are recorded as obligations when a sale completes. A recorded obligation is an accounting claim; it is not itself a payment, and the timing and execution of payouts are governed separately.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "The authoritative source of retention and commission figures for any given transaction.",
          },
        ],
      },
      {
        key: "REFUNDS_AND_CANCELLATION",
        heading: "Refunds",
        /* All three. A buyer needs to know what governs their money, a seller
           needs to know what they must declare and honour, and a promoter needs
           to know that a refund reaches their commission. Three copies of one
           rule would be three things to keep identical. */
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Refund eligibility for a purchase is governed by the refund policy the seller declared for it, subject to this policy and to applicable law. Monacado does not author a seller's refund terms.",
          "Every seller must maintain a declared refund policy. It must state whether refunds are available, the conditions under which one may be claimed, any period within which a refund must be requested, how the buyer's shipping charge is treated, the procedure for requesting a refund, and the seller support contact for refund requests.",
          "A purchase is governed by the exact version of the seller's refund policy that was bound to the order at checkout. A seller who publishes different terms afterwards does not change the terms of a purchase already completed, and the receipt for that purchase continues to show the terms that governed it.",
          "A refund returns one or more complete lines of an order. Every line included in a refund is returned in full, and lines that are not included are unaffected — so a refund may be partial with respect to an order while being complete with respect to every line it covers.",
          "Refunding part of the value of a single line — an arbitrary amount against one purchased item — is not supported under this policy. Where an order presently contains a single line, refunding that line is also a refund of the whole order; that is a consequence of how orders are currently composed, and not a rule that a refund must cover an entire order.",
          "Whether a buyer's shipping charge is returned is governed by the seller refund policy applicable to the purchase. Monacado does not return all shipping charges as a matter of course, does not retain all shipping charges as a matter of course, and does not apportion a shipping charge across part of an order.",
          "Where a refund would cover only some lines of an order whose shipping was charged once for a single delivery, how much of that charge belongs to the returned lines is a commercial question rather than an arithmetic one. Monacado may require that question to be settled under this policy before executing such a refund, rather than applying an apportionment rule that has not been adopted.",
          "Tax charged on refunded merchandise is corrected or reversed through Monacado's tax process and through the mechanisms its tax provider makes available, to the extent a correction applies. This policy makes no representation about the treatment of any particular tax in any particular place.",
          "Monacado is the merchant of record and retains the authority to execute or decline a refund consistent with the applicable refund policy, applicable law, and the requirements of its payment and tax providers. A seller's declared terms disclose what the seller offers; they are not a limit on what Monacado may do where law or a provider requirement obliges it to act.",
          "Rights a buyer has under applicable law are not displaced by a seller's declared refund terms. This policy does not state what those rights are in any particular place.",
          "Monacado may correct its own payment, tax, and accounting records for a sale where a refund requires it.",
        ],
        references: [
          {
            kind: "SELLER_REFUND_POLICY",
            ref: "seller declared refund policy, version bound at checkout",
            note: "The eligibility conditions, refund window, and shipping treatment for a purchase are the seller's declared terms in the version bound to that order, not figures restated here.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUND_REQUESTS",
            note: "How a buyer asks for a refund, and what is required of them to do so.",
          },
        ],
      },
      {
        key: "REFUND_REQUESTS",
        heading: "Requesting a refund",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "A buyer requests a refund by following the procedure stated in the refund policy that governed their purchase. That procedure, and the support contact to use, appear on the purchase receipt.",
          "A Monacado account is not required in order to request a refund. A purchase made as a guest may be refunded without one: the buyer identifies the purchase using the order reference and the purchase confirmation issued to them at checkout, and Monacado verifies that evidence before acting on the request.",
          "Monacado does not require a buyer to create an account after a purchase in order to ask for their money back.",
          "A request is assessed against the refund terms bound to the purchase. Making a request does not widen what those terms allow, and a seller changing their terms afterwards does not narrow what a completed purchase was sold under.",
          "A seller must receive refund requests at the support contact disclosed with the purchase and must honour requests that are eligible under the terms that governed it.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "PURCHASE_RECEIPTS",
            note: "What the receipt states, including the governing terms and the contact to use.",
          },
        ],
      },
      {
        key: "PURCHASE_RECEIPTS",
        heading: "Purchase receipts",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "Monacado issues a receipt for every completed purchase. A receipt records the purchase as it was made.",
          "A receipt states the order reference, what was purchased, what was charged including any tax and any shipping charge, the seller refund policy that governed the purchase and the exact version of it that was bound, how to request a refund, and the seller support contact that was in effect when the purchase was made.",
          "The refund terms and the support contact shown on a receipt are the ones disclosed to that buyer at the time of purchase. They are not replaced by a seller's current terms or current contact when the receipt is produced again later.",
          "Where a seller's present support contact is also shown, it is identified as such and appears in addition to — never instead of — the contact that was disclosed at purchase.",
          "A receipt remains reproducible after the seller changes their terms, changes their support contact, or ceases to trade.",
        ],
        references: [],
      },
      {
        key: "REFUND_EFFECT_ON_PROCEEDS",
        heading: "Refunds, proceeds, and commissions",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "Proceeds arise from a sale that stands. Where merchandise is refunded, the proceeds attributable to that merchandise are no longer earned.",
          "Amounts attributable to refunded merchandise that have not yet been paid cease to be payable. This applies to a seller's proceeds and to a promoter's commission alike.",
          "Amounts attributable to refunded merchandise that have already been paid, or that have already become payable, may be recovered, set off against amounts owed in future, or reflected as an adjustment to the participant's account balance, under Monacado's settlement rules.",
          "A refund does not erase a payment that was made. What was earned and what was paid remain recorded as they stand, and a refund is recorded as a further fact about the sale rather than as a correction of the earlier record.",
          "A promoter's commission is conditional on the underlying sale remaining economically valid. Whether a refund occurs is a matter between the buyer, the seller's declared terms, and Monacado; a promoter neither sets those terms nor decides a refund.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "What each party earned on a sale is governed by the commercial policy and offer versions bound to it, not restated here.",
          },
        ],
      },
      {
        key: "POLICY_CHANGES",
        heading: "Changes to this policy",
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Monacado may issue new versions of this policy. Each version is recorded separately and the version in force at any moment is identified; earlier versions remain available so that a past acceptance or a past transaction can still be read against the terms that applied to it.",
          "Where a new version makes a material change to what a seller or promoter undertakes, Monacado may require that participants accept the new version. A participant's previous acceptances are not altered or withdrawn by a later version being issued.",
          "A purchase is governed by the policy version in force when the purchase was completed.",
        ],
        references: [],
      },
    ],
  });

/** The content hash of version 1.1.0, derived rather than written down. */
export const MONACADO_MARKETPLACE_POLICY_V1_1_HASH: PolicyContentHash =
  marketplacePolicyContentHash(MONACADO_MARKETPLACE_POLICY_V1_1);


// — Version 1.2.0 —

export const MARKETPLACE_POLICY_VERSION_1_2 = "1.2.0" as const;
export const MARKETPLACE_POLICY_CONTENT_REF_1_2 = "marketplace-policy/1.2.0" as const;

/**
 * Monacado Marketplace Policy, version 1.2.0.
 *
 * **A complete document, written out in full, and not composed from 1.1.0.** The
 * duplication below is the property that keeps 1.0.0 and 1.1.0 immutable in
 * practice rather than merely in principle: both may already be recorded and
 * hashed wherever a bootstrap has run, and a shared paragraph constant would move
 * their bytes — and therefore their content hashes, and therefore what
 * participants are recorded as having accepted — the moment this version's prose
 * was edited.
 *
 * ## What changed, and why a new version rather than an edit
 *
 * Phase 1.11 shipped the dispute and chargeback lifecycle and deliberately did
 * **not** state it here. The gap it recorded was narrow and concrete: 1.1.0's
 * `PROMOTER_RESPONSIBILITIES` and `REFUND_EFFECT_ON_PROCEEDS` are written
 * entirely in terms of merchandise being *refunded*, and this repository draws a
 * deliberate distinction between a refund and a chargeback. So on its own words
 * the governing text did not reverse a promoter's commission on a charged-back
 * sale, stated no evidence-cooperation duty, and gave no right to hold proceeds
 * while a dispute is open.
 *
 * | Section | Disposition |
 * | --- | --- |
 * | `DISPUTES_AND_CHARGEBACKS` | new — what a dispute is, who is party to it, whose rights survive |
 * | `DISPUTE_EVIDENCE_AND_COOPERATION` | new — what a seller owes, to whom, and by when |
 * | `DISPUTE_EFFECT_ON_PROCEEDS` | new — holds, reversal, and recovery |
 * | `MONACADO_ROLE` | extended — the only party to a payment dispute; risk authority |
 * | `SELLER_RESPONSIBILITIES` | extended — cooperation, fulfilment facts, what refund terms do not limit |
 * | `PROMOTER_RESPONSIBILITIES` | extended — commission is conditional however the sale is undone |
 * | `REFUNDS_AND_CANCELLATION` | extended by one reference; **no paragraph changed** |
 * | everything else | verbatim from 1.1.0 |
 *
 * ## What it still does not do
 *
 * It states no jurisdiction-specific right and names no payment network, bank, or
 * provider.
 *
 * It **does** now state a seller consequence it previously left open. The §I
 * ruling is resolved: Monacado always represents, the seller is heard but does
 * not represent, and a finalized loss carries a stated fee. A version that went
 * on saying the question was reserved would be describing a hold that no longer
 * exists.
 *
 * The period a seller has to answer is expressed as *the date the request
 * states, which follows the network's deadline* rather than as a number of days.
 * A day count here would be a second authority arguing with the real per-dispute
 * deadline the provider supplies, and the wrong one would be believed.
 */
export const MONACADO_MARKETPLACE_POLICY_V1_2: MarketplacePolicyDocument =
  MarketplacePolicyDocument.parse({
    policyId: MONACADO_MARKETPLACE_POLICY_ID,
    policyVersion: MARKETPLACE_POLICY_VERSION_1_2,
    title: "Monacado Marketplace Policy",
    sections: [
      {
        key: "MONACADO_ROLE",
        heading: "Monacado's role",
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Monacado is the merchant of record for purchases made through the marketplace. Monacado contracts with the buyer, takes payment, and is the party shown on the buyer's payment statement.",
          "Monacado operates the marketplace infrastructure: listings, checkout, payment processing, transaction records, proceeds accounting, and the notification and delivery infrastructure that supports them.",
          "Monacado is not the producer of the products sold through the marketplace. Product accuracy, fulfilment, and product support are the seller's responsibilities, and this policy distinguishes the two throughout so that a buyer, a seller, and a promoter can each tell which party owes what.",
          "Monacado retains an amount from each sale under its commercial policy. The retained amount, the seller's proceeds, and any promoter's proceeds are recorded on an immutable per-sale economic record at the moment the sale completes.",
          "Monacado is the party to the buyer's payment relationship, and is therefore the only party to a payment dispute raised against a purchase. Where a buyer asks their bank or card issuer to reverse a payment, that dispute is conducted between the buyer's payment provider and Monacado. A seller and a promoter are not parties to it and must not address the payment network about it.",
          "Monacado may act to protect the integrity of the marketplace and of its payment relationships, including declining, holding, or reversing a transaction on fraud or risk grounds, without the agreement of the seller or promoter concerned. The classifications and the evidence behind such a decision are private operational records; they are not disclosed to other participants and are not published.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "The retained percentage and fixed amount are governed by the commercial policy version bound to each Order, not by this document.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTES_AND_CHARGEBACKS",
            note:
              "What a payment dispute is, who conducts it, and whose rights it does not displace.",
          },
        ],
      },
      {
        key: "SELLER_RESPONSIBILITIES",
        heading: "Seller responsibilities",
        audiences: ["SELLER"],
        paragraphs: [
          "Product information must be accurate. A seller is responsible for the descriptions, specifications, images, availability, and delivery mode recorded against their products, and for correcting them when they cease to be accurate.",
          "A seller must declare how each product is delivered. A product marked for physical delivery requires a delivery address at checkout; a product marked for digital delivery does not. A product that does not declare a delivery mode cannot be sold.",
          "A seller is responsible for fulfilling completed orders. For physical products this means dispatching the goods to the delivery address recorded with the order. For digital products this means that the artifact the buyer is entitled to remains available for the duration of the entitlement.",
          "A seller is responsible for product support and for customer questions about the product itself. Monacado handles questions about payment, the transaction record, and the marketplace platform.",
          "A seller is responsible for exceptional digital-delivery support. Where a buyer has exhausted the automated download allowance and requires further access, the decision to authorise it is the seller's, because only the seller can judge whether the request is a legitimate re-install or an attempt at redistribution.",
          "Where a seller hosts a digital product externally, the seller is responsible for keeping that artifact available and reachable for the duration of the entitlement. Access must be gated by Monacado entitlement verification or a Monacado-issued short-lived credential; a permanent reusable secret link is not an acceptable access control.",
          "Every activated seller must maintain a reachable customer support email address, verified by Monacado. A seller may nominate a dedicated support address; if none is nominated, the seller's verified primary account address is used. A seller whose support address becomes unreachable must supply and verify a replacement.",
          "A seller must maintain a declared refund policy covering the products they sell through the marketplace, must keep it accurate, and must have it available for disclosure to a buyer before the buyer completes a purchase. A product whose seller has no refund policy in force is not sold.",
          "A seller's refund policy must state whether refunds are available, the conditions under which one may be claimed, any period within which a refund must be requested, how the buyer's shipping charge is treated, the procedure for requesting a refund, and the support contact at which the seller will receive refund requests.",
          "A seller must answer refund requests at the support contact disclosed with the purchase. That contact is recorded with the purchase and continues to appear on that purchase's receipt, so a seller who changes their support arrangements must keep the change from stranding buyers who hold an earlier receipt.",
          "A seller must honour refund requests that are eligible under the version of their refund policy that was bound to the purchase, including where the seller's current terms differ from it. Publishing tighter terms does not tighten them for a purchase already made.",
          "How a buyer's shipping charge is treated on a refund follows the seller's own declared policy. A seller who does not intend to return shipping charges must say so in the policy they disclose before the sale.",
          "A refunded sale affects the proceeds attributable to it, and Monacado may correct the payment, tax, and accounting records for that sale to the extent this policy and applicable law require.",
          "A seller must cooperate with a legitimate request for dispute evidence. Where a payment for one of the seller's sales is disputed, Monacado may ask the seller for the facts of that sale which only the seller holds \u2014 what was supplied, when, how it was made available, and what support or correspondence followed \u2014 and the seller must supply them by the date the request states.",
          "The date a request states follows the deadline the payment network imposes on Monacado. It is shorter than an ordinary support enquiry allows for, it cannot be extended by Monacado, and it passes whether or not the seller has answered.",
          "Dispute evidence is supplied to Monacado and to nobody else. A seller must not contact the buyer's bank, the buyer's card issuer, or a payment network about a dispute, because Monacado is the only party to it and a second account of the same sale reaching the network is worse than none.",
          "A seller remains responsible for the facts of fulfilment underlying a disputed sale. A dispute does not move responsibility for what was described, what was delivered, and when; nor does a seller's inability to evidence those facts make them Monacado's.",
          "A seller's declared refund policy does not limit a buyer's rights under the rules of a payment network or under applicable law. Terms stating that a sale is final describe what the seller offers; they do not prevent a buyer's payment provider reversing a payment, and they are not a reason for Monacado to decline to respond to a dispute.",
          "A dispute that is lost, or that is left unresolved, affects the proceeds attributable to that sale, and may create an obligation to return amounts already paid to the seller.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "DIGITAL_DELIVERY",
            note: "The digital delivery entitlement, allowance, and credential rules in full.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUNDS_AND_CANCELLATION",
            note: "The marketplace-level refund rules a seller's declared policy operates within.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTE_EVIDENCE_AND_COOPERATION",
            note:
              "What Monacado may ask a seller for when a payment is disputed, and by when.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTE_EFFECT_ON_PROCEEDS",
            note:
              "What an open, won, or lost dispute does to the proceeds attributable to a sale.",
          },
        ],
      },
      {
        key: "PROMOTER_RESPONSIBILITIES",
        heading: "Promoter responsibilities",
        audiences: ["PROMOTER"],
        paragraphs: [
          "Promotion must be truthful. A promoter must not describe a product in terms the seller's own product information does not support, and must not represent a product's origin, capability, availability, or endorsement inaccurately.",
          "A promoter must promote a product on the terms of the exact offer version they accepted. Where a seller changes the commercial terms of an offer, the promoter is notified and the previously accepted version continues to govern any listing until the promoter acts on the change.",
          "A promoter must not misrepresent their relationship to the seller or to Monacado. A promoter sells through their own storefront as an independent participant; they are not an agent of the seller and not an agent of Monacado.",
          "A promoter sets the retail price of the products they promote, within the terms of the accepted offer. The promoter's proceeds are the difference between what Monacado acquires the product for and the seller's contracted wholesale price, plus any seller-funded commission the offer provides for.",
          "A promoter must not present a product as available where the underlying offer or product is no longer commercially available.",
          "A promoter does not set the refund terms for the products they promote and is not responsible for the seller's refund decisions. A promoter must not represent a product's refund terms as anything other than what the seller has declared for it.",
          "A promoter's commission on a sale is conditional on that sale remaining economically valid. Where promoted merchandise is refunded, the commission attributable to that merchandise is reversed.",
          "A promoter's commission is conditional on the underlying sale remaining economically valid, however that validity is undone. A sale whose payment is reversed through a dispute has the same effect on the commission attributable to it as a sale that is refunded.",
          "A promoter is not a party to a payment dispute, does not conduct one, and does not decide its outcome. Whether a dispute is contested, accepted, won, or lost is a matter between the buyer's payment provider and Monacado.",
          "A promoter is not responsible for the seller's evidence. Where a dispute turns on a fact within the promoter's own authority \u2014 what the promoter published, offered, or represented about a product \u2014 the promoter must supply that fact to Monacado on request.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "Commission methods and rates are governed by the accepted offer version and the commercial policy bound to each Order.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUND_EFFECT_ON_PROCEEDS",
            note: "What happens to a commission when promoted merchandise is refunded.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTE_EFFECT_ON_PROCEEDS",
            note:
              "What happens to a commission when the payment for promoted merchandise is reversed.",
          },
        ],
      },
      {
        key: "DIGITAL_DELIVERY",
        heading: "Digital delivery",
        audiences: ["SELLER", "BUYER"],
        paragraphs: [
          "A completed purchase of a digital product creates a durable entitlement: the buyer's continuing right to access what they bought. The entitlement is created by the completed purchase and is not dependent on any email, link, or credential remaining valid.",
          "A download link or token is a temporary credential for exercising that right on one occasion. It is not the entitlement. Losing a link does not lose the purchase, and possessing a link is not by itself evidence of a purchase.",
          `Monacado's default allowance is ${DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE} successful downloads per digital product while the entitlement stands.`,
          "Downloads that fail, are interrupted, or do not complete do not normally consume the allowance. The allowance counts deliveries the buyer actually received.",
          "While the entitlement stands and allowance remains, a buyer may obtain fresh download credentials themselves without contacting anyone. A fresh credential is issued each time; a previously issued credential is never recovered, reissued, or extended.",
          "Download credentials are short-lived, opaque, scoped to a single entitlement and artifact, usage-limited, and revocable. Monacado does not retain them in a form from which the original credential could be reproduced.",
          "Where a product is hosted outside Monacado, access must still be gated by Monacado entitlement verification or a Monacado-issued short-lived credential. A permanent reusable secret link is not an acceptable access control, because it cannot be expired, scoped, or withdrawn without breaking every legitimate buyer.",
          "Once the automated allowance is exhausted, further access requires the seller's authorisation. Monacado routes the request to the seller; the seller decides.",
          "Monacado provides the entitlement and credential infrastructure and routes exceptional requests. The seller provides the product, keeps it available, and owns exceptional access and product-delivery support.",
        ],
        references: [
          {
            kind: "DIGITAL_DELIVERY_POLICY",
            ref: "DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE",
            note: "The allowance and credential rules are defined in Monacado's digital delivery policy and are stated here for the parties they bind.",
          },
        ],
      },
      {
        key: "BUYER_CHECKOUT_INFORMATION",
        heading: "Information collected at checkout",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "Completing a purchase requires a name, an email address, and a billing address. Monacado uses them to authorise payment, determine the applicable tax jurisdiction, send transaction notices, and answer support questions about the order.",
          "A delivery address is required only when the purchase includes a product that requires physical delivery. A purchase of digital products alone is not asked for a delivery address, and none is retained for it.",
          "A Monacado account is not required in order to buy. A purchase may be completed as a guest, and completing one does not create an account or a marketplace participant record.",
          "Payment card details are entered with Monacado's payment provider and are never held by Monacado.",
          "Disclosures that apply to a purchase may be presented at checkout, on the receipt, or both. The policy version in force at the time of the purchase is the one that applies to it.",
          "The seller's refund policy applicable to the purchase is available to the buyer before the purchase is completed, and the exact version disclosed is the version the order binds.",
        ],
        references: [],
      },
      {
        key: "COMMERCIAL_POLICY_REFERENCE",
        heading: "Commercial terms",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "The amount Monacado retains from a sale is set by Monacado's versioned commercial policy. Each order records the exact commercial policy version under which it was priced, so the terms that applied to a completed sale remain determinable afterwards.",
          "This document does not restate the retained percentage, the fixed retained amount, or any commission rate. Those figures are governed by the commercial policy and offer versions bound to each transaction, and a copy here would be a second answer capable of disagreeing with the one that actually applied.",
          "Proceeds are recorded as obligations when a sale completes. A recorded obligation is an accounting claim; it is not itself a payment, and the timing and execution of payouts are governed separately.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "The authoritative source of retention and commission figures for any given transaction.",
          },
        ],
      },
      {
        key: "REFUNDS_AND_CANCELLATION",
        heading: "Refunds",
        /* All three. A buyer needs to know what governs their money, a seller
           needs to know what they must declare and honour, and a promoter needs
           to know that a refund reaches their commission. Three copies of one
           rule would be three things to keep identical. */
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Refund eligibility for a purchase is governed by the refund policy the seller declared for it, subject to this policy and to applicable law. Monacado does not author a seller's refund terms.",
          "Every seller must maintain a declared refund policy. It must state whether refunds are available, the conditions under which one may be claimed, any period within which a refund must be requested, how the buyer's shipping charge is treated, the procedure for requesting a refund, and the seller support contact for refund requests.",
          "A purchase is governed by the exact version of the seller's refund policy that was bound to the order at checkout. A seller who publishes different terms afterwards does not change the terms of a purchase already completed, and the receipt for that purchase continues to show the terms that governed it.",
          "A refund returns one or more complete lines of an order. Every line included in a refund is returned in full, and lines that are not included are unaffected — so a refund may be partial with respect to an order while being complete with respect to every line it covers.",
          "Refunding part of the value of a single line — an arbitrary amount against one purchased item — is not supported under this policy. Where an order presently contains a single line, refunding that line is also a refund of the whole order; that is a consequence of how orders are currently composed, and not a rule that a refund must cover an entire order.",
          "Whether a buyer's shipping charge is returned is governed by the seller refund policy applicable to the purchase. Monacado does not return all shipping charges as a matter of course, does not retain all shipping charges as a matter of course, and does not apportion a shipping charge across part of an order.",
          "Where a refund would cover only some lines of an order whose shipping was charged once for a single delivery, how much of that charge belongs to the returned lines is a commercial question rather than an arithmetic one. Monacado may require that question to be settled under this policy before executing such a refund, rather than applying an apportionment rule that has not been adopted.",
          "Tax charged on refunded merchandise is corrected or reversed through Monacado's tax process and through the mechanisms its tax provider makes available, to the extent a correction applies. This policy makes no representation about the treatment of any particular tax in any particular place.",
          "Monacado is the merchant of record and retains the authority to execute or decline a refund consistent with the applicable refund policy, applicable law, and the requirements of its payment and tax providers. A seller's declared terms disclose what the seller offers; they are not a limit on what Monacado may do where law or a provider requirement obliges it to act.",
          "Rights a buyer has under applicable law are not displaced by a seller's declared refund terms. This policy does not state what those rights are in any particular place.",
          "Monacado may correct its own payment, tax, and accounting records for a sale where a refund requires it.",
        ],
        references: [
          {
            kind: "SELLER_REFUND_POLICY",
            ref: "seller declared refund policy, version bound at checkout",
            note: "The eligibility conditions, refund window, and shipping treatment for a purchase are the seller's declared terms in the version bound to that order, not figures restated here.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUND_REQUESTS",
            note: "How a buyer asks for a refund, and what is required of them to do so.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTES_AND_CHARGEBACKS",
            note:
              "A payment dispute is a different route, raised with a different party and decided by one. It is not a refund and does not replace a refund request.",
          },
        ],
      },
      {
        key: "REFUND_REQUESTS",
        heading: "Requesting a refund",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "A buyer requests a refund by following the procedure stated in the refund policy that governed their purchase. That procedure, and the support contact to use, appear on the purchase receipt.",
          "A Monacado account is not required in order to request a refund. A purchase made as a guest may be refunded without one: the buyer identifies the purchase using the order reference and the purchase confirmation issued to them at checkout, and Monacado verifies that evidence before acting on the request.",
          "Monacado does not require a buyer to create an account after a purchase in order to ask for their money back.",
          "A request is assessed against the refund terms bound to the purchase. Making a request does not widen what those terms allow, and a seller changing their terms afterwards does not narrow what a completed purchase was sold under.",
          "A seller must receive refund requests at the support contact disclosed with the purchase and must honour requests that are eligible under the terms that governed it.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "PURCHASE_RECEIPTS",
            note: "What the receipt states, including the governing terms and the contact to use.",
          },
        ],
      },
      {
        key: "PURCHASE_RECEIPTS",
        heading: "Purchase receipts",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "Monacado issues a receipt for every completed purchase. A receipt records the purchase as it was made.",
          "A receipt states the order reference, what was purchased, what was charged including any tax and any shipping charge, the seller refund policy that governed the purchase and the exact version of it that was bound, how to request a refund, and the seller support contact that was in effect when the purchase was made.",
          "The refund terms and the support contact shown on a receipt are the ones disclosed to that buyer at the time of purchase. They are not replaced by a seller's current terms or current contact when the receipt is produced again later.",
          "Where a seller's present support contact is also shown, it is identified as such and appears in addition to — never instead of — the contact that was disclosed at purchase.",
          "A receipt remains reproducible after the seller changes their terms, changes their support contact, or ceases to trade.",
        ],
        references: [],
      },
      {
        key: "REFUND_EFFECT_ON_PROCEEDS",
        heading: "Refunds, proceeds, and commissions",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "Proceeds arise from a sale that stands. Where merchandise is refunded, the proceeds attributable to that merchandise are no longer earned.",
          "Amounts attributable to refunded merchandise that have not yet been paid cease to be payable. This applies to a seller's proceeds and to a promoter's commission alike.",
          "Amounts attributable to refunded merchandise that have already been paid, or that have already become payable, may be recovered, set off against amounts owed in future, or reflected as an adjustment to the participant's account balance, under Monacado's settlement rules.",
          "A refund does not erase a payment that was made. What was earned and what was paid remain recorded as they stand, and a refund is recorded as a further fact about the sale rather than as a correction of the earlier record.",
          "A promoter's commission is conditional on the underlying sale remaining economically valid. Whether a refund occurs is a matter between the buyer, the seller's declared terms, and Monacado; a promoter neither sets those terms nor decides a refund.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "What each party earned on a sale is governed by the commercial policy and offer versions bound to it, not restated here.",
          },
        ],
      },
      {
        /* All three audiences. A buyer needs to know which rights survive this
           document, a seller needs to know what a dispute does to a sale they
           fulfilled, and a promoter needs to know that it reaches their
           commission. Three copies of one rule would be three things to keep
           identical. */
        key: "DISPUTES_AND_CHARGEBACKS",
        heading: "Payment disputes and chargebacks",
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "A payment dispute, commonly called a chargeback, is a buyer asking their bank or card issuer to reverse a payment. It is not a refund. A refund is money Monacado returns under the terms that governed the purchase; a dispute is a reversal decided by the buyer's payment provider under the rules of a payment network. Both can happen to the same sale.",
          "Monacado is the merchant of record and is the only party to a payment dispute. Monacado may respond to a dispute, may submit the evidence it holds, and may accept a dispute rather than contest it. A seller and a promoter are not parties, cannot address the payment network, and do not decide the outcome.",
          "Monacado is always responsible for responding to a payment dispute raised against a Monacado transaction. Monacado notifies the seller, gives the seller a bounded opportunity to provide a defence and supporting evidence, considers that evidence alongside its own records, and then determines and submits the response. Providing evidence does not transfer that responsibility to the seller: the seller is heard, and Monacado decides.",
          "A buyer's rights under the rules of a payment network, and under applicable law, are separate from a seller's declared refund terms and are not limited by this policy or by those terms. This policy does not state what those rights are in any particular place.",
          "A buyer may request a refund under the terms that governed their purchase, and the receipt for that purchase states how. Nothing in this policy requires a buyer to do so before exercising a right they hold with their payment provider, and nothing in it directs a buyer to a payment dispute in place of a refund request.",
          "Monacado may respond to a dispute using the records it holds about the transaction: what was purchased, what was charged, the terms disclosed and bound at purchase, what Monacado communicated to the buyer, and the fulfilment and support facts the seller supplies. No representation is made about what a payment provider or a payment network will decide, and Monacado does not promise that any response will succeed.",
          "A dispute does not erase the record of the sale or of the payment. What was sold, what was charged, and what was paid remain recorded as they stand, and the outcome of a dispute is recorded as a further fact about the sale rather than as a correction of the earlier record.",
          "Monacado may correct its own payment, tax, and accounting records for a sale according to the outcome of a dispute, to the extent this policy and applicable law require.",
          "Contesting a dispute, or accepting one rather than contesting it, does not waive any amount Monacado is entitled to recover under this policy.",
          "Where the rules of a payment network or applicable law govern a matter this section addresses, those rules apply. This policy does not displace them and does not restate them.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "REFUNDS_AND_CANCELLATION",
            note:
              "The refund route, which is decided under the seller's bound terms and is separate from a payment dispute.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTE_EFFECT_ON_PROCEEDS",
            note:
              "What an open, won, or lost dispute does to a seller's proceeds and a promoter's commission.",
          },
          {
            kind: "SELLER_REFUND_POLICY",
            ref: "seller declared refund policy, version bound at checkout",
            note:
              "The terms under which a refund may be claimed. They govern what the seller offers and do not limit a buyer's payment-network or statutory rights.",
          },
        ],
      },
      {
        /* Sellers owe the facts; promoters owe only their own. A buyer is not
           asked for evidence, and a section addressed to a buyer describing what
           Monacado assembles about their purchase would be disclosure without a
           purpose. */
        key: "DISPUTE_EVIDENCE_AND_COOPERATION",
        heading: "Dispute evidence and cooperation",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "Where a payment is disputed, Monacado may request from the seller the facts of the sale that only the seller holds: what was supplied, when, how it was made available to the buyer, and what support or correspondence followed.",
          "A request states the date by which the facts are needed. That date follows the deadline the payment network imposes on Monacado; it is not set for Monacado's convenience and cannot be extended by Monacado. Facts supplied after it may be of no use, and the dispute may be decided without them.",
          "Evidence is supplied to Monacado. A seller and a promoter must not contact the buyer's bank, the buyer's card issuer, or a payment network about a dispute.",
          "Monacado may use the records it already holds when responding, without asking: the transaction record, the receipt issued for the purchase, the notices Monacado sent about it, the marketplace policy version and the seller refund policy version bound to the purchase, and the seller support contact disclosed with it.",
          "Monacado decides what to submit, what to withhold, and whether to contest a dispute at all. That decision belongs to Monacado as the party to it, and a seller's or a promoter's preference does not bind it.",
          "A promoter is not responsible for the seller's evidence. A promoter must supply facts within their own authority \u2014 what they published, offered, or represented about a product \u2014 where a dispute turns on them.",
          "Information about a buyer is used only so far as responding to the dispute requires. A dispute is not a route to a buyer's personal information, and Monacado does not pass a buyer's details to a seller or a promoter because a dispute exists.",
          "A seller's failure to supply requested facts by the stated date does not prevent Monacado responding, accepting the dispute, or applying this policy's consequences for the proceeds attributable to the sale.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTES_AND_CHARGEBACKS",
            note:
              "Who is party to a dispute, and what a response can and cannot promise.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "SELLER_RESPONSIBILITIES",
            note:
              "The fulfilment and support obligations the requested facts are evidence of.",
          },
        ],
      },
      {
        key: "DISPUTE_EFFECT_ON_PROCEEDS",
        heading: "Disputes, proceeds, and commissions",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "Proceeds arise from a sale that stands. While a payment dispute on a sale is open, the amounts attributable to that sale may be held and are not payable, because a sale whose payment a bank may still reverse is not yet a sale that stands.",
          "A hold applies to the amounts attributable to the disputed sale. It is not a suspension of a participant's other proceeds, and it ends when the dispute does.",
          "Where a dispute is decided in the sale's favour, or is closed without the payment being reversed, the amounts held cease to be held and are treated as they would have been had no dispute arisen.",
          "Where a payment is reversed, the proceeds attributable to that sale are no longer earned. Amounts not yet paid cease to be payable, and this applies to a seller's proceeds and to a promoter's commission alike.",
          "Amounts attributable to a reversed sale that have already been paid, or that have already become payable, may be recovered, set off against amounts owed in future, or reflected as an adjustment to the participant's account balance, under Monacado's settlement rules.",
          "A finalized chargeback attributable to the seller incurs a $30 chargeback fee. The fee is charged once for each dispute that is finally decided against the sale. It reflects the cost of handling and losing the dispute and is separate from the reversed payment itself.",
          "Opening a dispute does not incur the fee, and a dispute decided in the sale's favour does not incur it. A seller who successfully defends a sale is not charged for having been disputed.",
          "The fee is recorded as a separate obligation. It does not alter what was earned or paid on the original sale, and the record of that sale is not rewritten to account for it.",
          "The amount of the chargeback fee is set by Monacado and may change. A change applies to chargebacks finalized after it takes effect; the fee for a chargeback is the amount in force when that chargeback is finally decided, and a later change does not alter a fee already charged.",
          "A promoter's commission is conditional on the underlying sale remaining economically valid, and a sale undone by a payment dispute is as undone as one that is refunded. A promoter neither conducts a dispute nor decides its outcome.",
          "A dispute does not erase a payment that was made. What was earned and what was paid remain recorded as they stand, and the effect of a dispute is recorded as a further fact about the sale rather than as a correction of the earlier record.",
          "A sale that is both refunded and reversed through a payment dispute has been returned to the buyer twice in fact. Recovering the second return is a matter between Monacado, the payment network, and the buyer; it does not reduce the seller's or the promoter's proceeds for that sale a second time.",
          "Where a dispute affects the tax recorded on a sale, any correction is made through Monacado's tax process and through the mechanisms its tax provider makes available, to the extent a correction applies. This policy makes no representation about the treatment of any particular tax in any particular place.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note:
              "What each party earned on a sale is governed by the commercial policy and offer versions bound to it, not restated here.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUND_EFFECT_ON_PROCEEDS",
            note:
              "The equivalent rules where a sale is refunded rather than reversed through a payment dispute.",
          },
        ],
      },
      {
        key: "POLICY_CHANGES",
        heading: "Changes to this policy",
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Monacado may issue new versions of this policy. Each version is recorded separately and the version in force at any moment is identified; earlier versions remain available so that a past acceptance or a past transaction can still be read against the terms that applied to it.",
          "Where a new version makes a material change to what a seller or promoter undertakes, Monacado may require that participants accept the new version. A participant's previous acceptances are not altered or withdrawn by a later version being issued.",
          "A purchase is governed by the policy version in force when the purchase was completed.",
        ],
        references: [],
      },
    ],
  });

/** The content hash of version 1.2.0, derived rather than written down. */
export const MONACADO_MARKETPLACE_POLICY_V1_2_HASH: PolicyContentHash =
  marketplacePolicyContentHash(MONACADO_MARKETPLACE_POLICY_V1_2);

// ─────────────────────────────────────────────────────────────────────────────
// Version 1.3.0 — participant-level risk monitoring, restriction, and suspension
// ─────────────────────────────────────────────────────────────────────────────

export const MARKETPLACE_POLICY_VERSION_1_3 = "1.3.0" as const;
export const MARKETPLACE_POLICY_CONTENT_REF_1_3 = "marketplace-policy/1.3.0" as const;

/**
 * Monacado Marketplace Policy, version 1.3.0.
 *
 * **A complete document, written out in full, and not composed from 1.2.0** —
 * for the reason 1.2.0 itself gives: 1.0.0, 1.1.0, and 1.2.0 may already be
 * recorded and hashed wherever a bootstrap has run, and a shared paragraph
 * constant would move their bytes, and therefore their content hashes, and
 * therefore what participants are recorded as having accepted.
 *
 * ## What changed, and why a new version rather than an edit
 *
 * Phase 1.13 shipped risk analytics and a Staff review record, and recorded in
 * source that it could go no further: 1.2.0 authorises declining, holding, or
 * reversing **a transaction** on risk grounds, and says nothing about monitoring
 * a participant over time, placing one under review, or withholding what they
 * may do next. `DISPUTE_EFFECT_ON_PROCEEDS` narrowed it further still, stating
 * that a per-sale hold "is not a suspension of a participant's other proceeds".
 * So the analytics existed with nothing lawfully to do about them.
 *
 * | Section | Disposition |
 * | --- | --- |
 * | `MARKETPLACE_INTEGRITY_AND_RISK_REVIEW` | new — what is monitored, what a signal is not, and who decides |
 * | `PARTICIPANT_RESTRICTIONS_AND_SUSPENSION` | new — what may be withheld, notice, reconsideration, lifting, and what survives |
 * | `MONACADO_ROLE` | extended — participant-level authority; a completed purchase is unaffected |
 * | `SELLER_RESPONSIBILITIES` | extended — information, remediation, activity attributable to own products, duties that survive |
 * | `PROMOTER_RESPONSIBILITIES` | extended — information, independent accountability, duties that survive |
 * | `DISPUTE_EFFECT_ON_PROCEEDS` | extended by one reference; **no paragraph changed** |
 * | everything else | verbatim from 1.2.0 |
 *
 * ## The text is a ceiling, not a wish list
 *
 * Every capability this document claims is one Phase 1.14 actually built, and
 * every claim is bounded by what the implementation can deliver. It says a
 * notice is **recorded and made available**, not that one arrives in advance,
 * because the obligation is written in the same transaction as the decision and
 * there is no pre-notification path. It says **reconsideration**, once, by
 * Monacado staff — not appeal, not arbitration, not independent review, none of
 * which exists. It sets **no period** for a determination, because nothing
 * measures one. It says neither a restriction nor a suspension **expires**,
 * because there is no expiry column and a decision that lapsed on its own would
 * be a policy nobody wrote.
 *
 * ## What it still does not do
 *
 * It states no jurisdiction-specific right, names no payment network, bank, or
 * provider, and describes no automated decision. It does not say a threshold
 * causes an outcome, because none does: the arithmetic asks a person to look,
 * and a person decides.
 *
 * ## Seller and promoter are not merged
 *
 * A seller answers for activity attributable to their own products however the
 * sale was made, including through a promoter. A promoter answers for their own
 * conduct. The pair analytics identify **where** a pattern sits and are
 * explicitly denied the power to move responsibility between the two — which is
 * the same separation the implementation enforces by requiring a decision about a
 * promoter to be taken on the promoter's own record.
 */
export const MONACADO_MARKETPLACE_POLICY_V1_3: MarketplacePolicyDocument =
  MarketplacePolicyDocument.parse({
    policyId: MONACADO_MARKETPLACE_POLICY_ID,
    policyVersion: MARKETPLACE_POLICY_VERSION_1_3,
    title: "Monacado Marketplace Policy",
    sections: [
      {
        key: "MONACADO_ROLE",
        heading: "Monacado's role",
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Monacado is the merchant of record for purchases made through the marketplace. Monacado contracts with the buyer, takes payment, and is the party shown on the buyer's payment statement.",
          "Monacado operates the marketplace infrastructure: listings, checkout, payment processing, transaction records, proceeds accounting, and the notification and delivery infrastructure that supports them.",
          "Monacado is not the producer of the products sold through the marketplace. Product accuracy, fulfilment, and product support are the seller's responsibilities, and this policy distinguishes the two throughout so that a buyer, a seller, and a promoter can each tell which party owes what.",
          "Monacado retains an amount from each sale under its commercial policy. The retained amount, the seller's proceeds, and any promoter's proceeds are recorded on an immutable per-sale economic record at the moment the sale completes.",
          "Monacado is the party to the buyer's payment relationship, and is therefore the only party to a payment dispute raised against a purchase. Where a buyer asks their bank or card issuer to reverse a payment, that dispute is conducted between the buyer's payment provider and Monacado. A seller and a promoter are not parties to it and must not address the payment network about it.",
          "Monacado may act to protect the integrity of the marketplace and of its payment relationships, including declining, holding, or reversing a transaction on fraud or risk grounds, without the agreement of the seller or promoter concerned. The classifications and the evidence behind such a decision are private operational records; they are not disclosed to other participants and are not published.",
          "Monacado's authority to protect the marketplace is not confined to a single transaction. Monacado monitors the activity conducted through the marketplace, may place a participant under review, and may withhold a participant's ability to trade through it. Those are decisions about a participant's standing in Monacado's marketplace. They are made by Monacado, they are recorded, and they are not published.",
          "Action taken against a seller or a promoter does not change what Monacado owes a buyer. Monacado is the merchant of record for every purchase already completed, and a purchase completed before a participant was restricted or suspended stands: the receipt stands, a digital entitlement stands, and a refund due under the terms bound to that purchase remains due. Fulfilment and product support remain the seller's, and being restricted or suspended does not release a seller from them.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "The retained percentage and fixed amount are governed by the commercial policy version bound to each Order, not by this document.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTES_AND_CHARGEBACKS",
            note:
              "What a payment dispute is, who conducts it, and whose rights it does not displace.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "MARKETPLACE_INTEGRITY_AND_RISK_REVIEW",
            note:
              "What Monacado monitors, how a signal is used, and who decides what follows from one.",
          },
        ],
      },
      {
        key: "SELLER_RESPONSIBILITIES",
        heading: "Seller responsibilities",
        audiences: ["SELLER"],
        paragraphs: [
          "Product information must be accurate. A seller is responsible for the descriptions, specifications, images, availability, and delivery mode recorded against their products, and for correcting them when they cease to be accurate.",
          "A seller must declare how each product is delivered. A product marked for physical delivery requires a delivery address at checkout; a product marked for digital delivery does not. A product that does not declare a delivery mode cannot be sold.",
          "A seller is responsible for fulfilling completed orders. For physical products this means dispatching the goods to the delivery address recorded with the order. For digital products this means that the artifact the buyer is entitled to remains available for the duration of the entitlement.",
          "A seller is responsible for product support and for customer questions about the product itself. Monacado handles questions about payment, the transaction record, and the marketplace platform.",
          "A seller is responsible for exceptional digital-delivery support. Where a buyer has exhausted the automated download allowance and requires further access, the decision to authorise it is the seller's, because only the seller can judge whether the request is a legitimate re-install or an attempt at redistribution.",
          "Where a seller hosts a digital product externally, the seller is responsible for keeping that artifact available and reachable for the duration of the entitlement. Access must be gated by Monacado entitlement verification or a Monacado-issued short-lived credential; a permanent reusable secret link is not an acceptable access control.",
          "Every activated seller must maintain a reachable customer support email address, verified by Monacado. A seller may nominate a dedicated support address; if none is nominated, the seller's verified primary account address is used. A seller whose support address becomes unreachable must supply and verify a replacement.",
          "A seller must maintain a declared refund policy covering the products they sell through the marketplace, must keep it accurate, and must have it available for disclosure to a buyer before the buyer completes a purchase. A product whose seller has no refund policy in force is not sold.",
          "A seller's refund policy must state whether refunds are available, the conditions under which one may be claimed, any period within which a refund must be requested, how the buyer's shipping charge is treated, the procedure for requesting a refund, and the support contact at which the seller will receive refund requests.",
          "A seller must answer refund requests at the support contact disclosed with the purchase. That contact is recorded with the purchase and continues to appear on that purchase's receipt, so a seller who changes their support arrangements must keep the change from stranding buyers who hold an earlier receipt.",
          "A seller must honour refund requests that are eligible under the version of their refund policy that was bound to the purchase, including where the seller's current terms differ from it. Publishing tighter terms does not tighten them for a purchase already made.",
          "How a buyer's shipping charge is treated on a refund follows the seller's own declared policy. A seller who does not intend to return shipping charges must say so in the policy they disclose before the sale.",
          "A refunded sale affects the proceeds attributable to it, and Monacado may correct the payment, tax, and accounting records for that sale to the extent this policy and applicable law require.",
          "A seller must cooperate with a legitimate request for dispute evidence. Where a payment for one of the seller's sales is disputed, Monacado may ask the seller for the facts of that sale which only the seller holds \u2014 what was supplied, when, how it was made available, and what support or correspondence followed \u2014 and the seller must supply them by the date the request states.",
          "The date a request states follows the deadline the payment network imposes on Monacado. It is shorter than an ordinary support enquiry allows for, it cannot be extended by Monacado, and it passes whether or not the seller has answered.",
          "Dispute evidence is supplied to Monacado and to nobody else. A seller must not contact the buyer's bank, the buyer's card issuer, or a payment network about a dispute, because Monacado is the only party to it and a second account of the same sale reaching the network is worse than none.",
          "A seller remains responsible for the facts of fulfilment underlying a disputed sale. A dispute does not move responsibility for what was described, what was delivered, and when; nor does a seller's inability to evidence those facts make them Monacado's.",
          "A seller's declared refund policy does not limit a buyer's rights under the rules of a payment network or under applicable law. Terms stating that a sale is final describe what the seller offers; they do not prevent a buyer's payment provider reversing a payment, and they are not a reason for Monacado to decline to respond to a dispute.",
          "A dispute that is lost, or that is left unresolved, affects the proceeds attributable to that sale, and may create an obligation to return amounts already paid to the seller.",
          "A seller must answer a Monacado request for information about their marketplace activity. Monacado may ask a seller to account for a pattern in their sales, refunds, or payment disputes, to evidence how products were described, delivered, and supported, or to describe how their listings are being promoted. A request states what is wanted and by when.",
          "A seller must complete remediation Monacado requires as a condition of continuing to trade. Where Monacado identifies a problem in how a seller describes, delivers, or supports what they sell, the seller must correct it, and a seller who does not may be restricted.",
          "A seller is responsible for the marketplace activity attributable to their own products, listings, and offers, whether the sales were made directly or through a promoter. A seller who cannot account for what is being sold under their products is responsible to Monacado for the consequences of that activity to buyers and to the marketplace.",
          "A promoter remains independently accountable for their own conduct. A seller is not answerable for what a promoter published, offered, or represented on the promoter's own authority, and Monacado does not treat a promoter's conduct as a seller's merely because the two appear together in the same sales.",
          "A seller's obligations to buyers survive a restriction and a suspension. A restricted or suspended seller must still fulfil completed orders, must still keep digital artifacts available for the duration of an entitlement, must still answer refund requests at the support contact disclosed with the purchase, must still honour refunds eligible under the terms bound to those purchases, and must still supply dispute evidence when Monacado asks for it. Withholding what a seller may do next does not withhold what a seller already owes.",
          "A seller must not evade a restriction or a suspension. Opening or operating another participant record, storefront, or account in order to keep trading while restricted or suspended is itself a ground for restricting or suspending it.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "DIGITAL_DELIVERY",
            note: "The digital delivery entitlement, allowance, and credential rules in full.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUNDS_AND_CANCELLATION",
            note: "The marketplace-level refund rules a seller's declared policy operates within.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTE_EVIDENCE_AND_COOPERATION",
            note:
              "What Monacado may ask a seller for when a payment is disputed, and by when.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTE_EFFECT_ON_PROCEEDS",
            note:
              "What an open, won, or lost dispute does to the proceeds attributable to a sale.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "PARTICIPANT_RESTRICTIONS_AND_SUSPENSION",
            note:
              "What a restriction and a suspension withhold, and what a seller continues to owe under one.",
          },
        ],
      },
      {
        key: "PROMOTER_RESPONSIBILITIES",
        heading: "Promoter responsibilities",
        audiences: ["PROMOTER"],
        paragraphs: [
          "Promotion must be truthful. A promoter must not describe a product in terms the seller's own product information does not support, and must not represent a product's origin, capability, availability, or endorsement inaccurately.",
          "A promoter must promote a product on the terms of the exact offer version they accepted. Where a seller changes the commercial terms of an offer, the promoter is notified and the previously accepted version continues to govern any listing until the promoter acts on the change.",
          "A promoter must not misrepresent their relationship to the seller or to Monacado. A promoter sells through their own storefront as an independent participant; they are not an agent of the seller and not an agent of Monacado.",
          "A promoter sets the retail price of the products they promote, within the terms of the accepted offer. The promoter's proceeds are the difference between what Monacado acquires the product for and the seller's contracted wholesale price, plus any seller-funded commission the offer provides for.",
          "A promoter must not present a product as available where the underlying offer or product is no longer commercially available.",
          "A promoter does not set the refund terms for the products they promote and is not responsible for the seller's refund decisions. A promoter must not represent a product's refund terms as anything other than what the seller has declared for it.",
          "A promoter's commission on a sale is conditional on that sale remaining economically valid. Where promoted merchandise is refunded, the commission attributable to that merchandise is reversed.",
          "A promoter's commission is conditional on the underlying sale remaining economically valid, however that validity is undone. A sale whose payment is reversed through a dispute has the same effect on the commission attributable to it as a sale that is refunded.",
          "A promoter is not a party to a payment dispute, does not conduct one, and does not decide its outcome. Whether a dispute is contested, accepted, won, or lost is a matter between the buyer's payment provider and Monacado.",
          "A promoter is not responsible for the seller's evidence. Where a dispute turns on a fact within the promoter's own authority \u2014 what the promoter published, offered, or represented about a product \u2014 the promoter must supply that fact to Monacado on request.",
          "A promoter must answer a Monacado request for information about their own promotional activity: what they published, what they offered, how they represented a product, and how buyers were brought to it. A request states what is wanted and by when.",
          "A promoter answers for their own conduct and does not answer for a seller's. Where a pattern of refunds or payment disputes is attributable to how a product was promoted, the promoter answers for it; where it is attributable to what was sold, the seller does. Monacado does not move responsibility from one to the other because the sales are the same sales.",
          "A promoter may be placed under review, restricted, or suspended on the same grounds and by the same process as a seller. A decision about a seller is not a decision about the promoters who carried that seller's products, and Monacado takes a decision about a promoter on that promoter's own facts.",
          "A promoter's obligations survive a restriction and a suspension. A promoter must still correct or withdraw promotional material that has ceased to be accurate, must still supply facts within their own authority when Monacado asks for them, and remains bound by the terms of the offer versions they accepted.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "Commission methods and rates are governed by the accepted offer version and the commercial policy bound to each Order.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUND_EFFECT_ON_PROCEEDS",
            note: "What happens to a commission when promoted merchandise is refunded.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTE_EFFECT_ON_PROCEEDS",
            note:
              "What happens to a commission when the payment for promoted merchandise is reversed.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "PARTICIPANT_RESTRICTIONS_AND_SUSPENSION",
            note:
              "What a restriction and a suspension withhold, and what a promoter continues to owe under one.",
          },
        ],
      },
      {
        key: "DIGITAL_DELIVERY",
        heading: "Digital delivery",
        audiences: ["SELLER", "BUYER"],
        paragraphs: [
          "A completed purchase of a digital product creates a durable entitlement: the buyer's continuing right to access what they bought. The entitlement is created by the completed purchase and is not dependent on any email, link, or credential remaining valid.",
          "A download link or token is a temporary credential for exercising that right on one occasion. It is not the entitlement. Losing a link does not lose the purchase, and possessing a link is not by itself evidence of a purchase.",
          `Monacado's default allowance is ${DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE} successful downloads per digital product while the entitlement stands.`,
          "Downloads that fail, are interrupted, or do not complete do not normally consume the allowance. The allowance counts deliveries the buyer actually received.",
          "While the entitlement stands and allowance remains, a buyer may obtain fresh download credentials themselves without contacting anyone. A fresh credential is issued each time; a previously issued credential is never recovered, reissued, or extended.",
          "Download credentials are short-lived, opaque, scoped to a single entitlement and artifact, usage-limited, and revocable. Monacado does not retain them in a form from which the original credential could be reproduced.",
          "Where a product is hosted outside Monacado, access must still be gated by Monacado entitlement verification or a Monacado-issued short-lived credential. A permanent reusable secret link is not an acceptable access control, because it cannot be expired, scoped, or withdrawn without breaking every legitimate buyer.",
          "Once the automated allowance is exhausted, further access requires the seller's authorisation. Monacado routes the request to the seller; the seller decides.",
          "Monacado provides the entitlement and credential infrastructure and routes exceptional requests. The seller provides the product, keeps it available, and owns exceptional access and product-delivery support.",
        ],
        references: [
          {
            kind: "DIGITAL_DELIVERY_POLICY",
            ref: "DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE",
            note: "The allowance and credential rules are defined in Monacado's digital delivery policy and are stated here for the parties they bind.",
          },
        ],
      },
      {
        key: "BUYER_CHECKOUT_INFORMATION",
        heading: "Information collected at checkout",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "Completing a purchase requires a name, an email address, and a billing address. Monacado uses them to authorise payment, determine the applicable tax jurisdiction, send transaction notices, and answer support questions about the order.",
          "A delivery address is required only when the purchase includes a product that requires physical delivery. A purchase of digital products alone is not asked for a delivery address, and none is retained for it.",
          "A Monacado account is not required in order to buy. A purchase may be completed as a guest, and completing one does not create an account or a marketplace participant record.",
          "Payment card details are entered with Monacado's payment provider and are never held by Monacado.",
          "Disclosures that apply to a purchase may be presented at checkout, on the receipt, or both. The policy version in force at the time of the purchase is the one that applies to it.",
          "The seller's refund policy applicable to the purchase is available to the buyer before the purchase is completed, and the exact version disclosed is the version the order binds.",
        ],
        references: [],
      },
      {
        key: "COMMERCIAL_POLICY_REFERENCE",
        heading: "Commercial terms",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "The amount Monacado retains from a sale is set by Monacado's versioned commercial policy. Each order records the exact commercial policy version under which it was priced, so the terms that applied to a completed sale remain determinable afterwards.",
          "This document does not restate the retained percentage, the fixed retained amount, or any commission rate. Those figures are governed by the commercial policy and offer versions bound to each transaction, and a copy here would be a second answer capable of disagreeing with the one that actually applied.",
          "Proceeds are recorded as obligations when a sale completes. A recorded obligation is an accounting claim; it is not itself a payment, and the timing and execution of payouts are governed separately.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "The authoritative source of retention and commission figures for any given transaction.",
          },
        ],
      },
      {
        key: "REFUNDS_AND_CANCELLATION",
        heading: "Refunds",
        /* All three. A buyer needs to know what governs their money, a seller
           needs to know what they must declare and honour, and a promoter needs
           to know that a refund reaches their commission. Three copies of one
           rule would be three things to keep identical. */
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Refund eligibility for a purchase is governed by the refund policy the seller declared for it, subject to this policy and to applicable law. Monacado does not author a seller's refund terms.",
          "Every seller must maintain a declared refund policy. It must state whether refunds are available, the conditions under which one may be claimed, any period within which a refund must be requested, how the buyer's shipping charge is treated, the procedure for requesting a refund, and the seller support contact for refund requests.",
          "A purchase is governed by the exact version of the seller's refund policy that was bound to the order at checkout. A seller who publishes different terms afterwards does not change the terms of a purchase already completed, and the receipt for that purchase continues to show the terms that governed it.",
          "A refund returns one or more complete lines of an order. Every line included in a refund is returned in full, and lines that are not included are unaffected — so a refund may be partial with respect to an order while being complete with respect to every line it covers.",
          "Refunding part of the value of a single line — an arbitrary amount against one purchased item — is not supported under this policy. Where an order presently contains a single line, refunding that line is also a refund of the whole order; that is a consequence of how orders are currently composed, and not a rule that a refund must cover an entire order.",
          "Whether a buyer's shipping charge is returned is governed by the seller refund policy applicable to the purchase. Monacado does not return all shipping charges as a matter of course, does not retain all shipping charges as a matter of course, and does not apportion a shipping charge across part of an order.",
          "Where a refund would cover only some lines of an order whose shipping was charged once for a single delivery, how much of that charge belongs to the returned lines is a commercial question rather than an arithmetic one. Monacado may require that question to be settled under this policy before executing such a refund, rather than applying an apportionment rule that has not been adopted.",
          "Tax charged on refunded merchandise is corrected or reversed through Monacado's tax process and through the mechanisms its tax provider makes available, to the extent a correction applies. This policy makes no representation about the treatment of any particular tax in any particular place.",
          "Monacado is the merchant of record and retains the authority to execute or decline a refund consistent with the applicable refund policy, applicable law, and the requirements of its payment and tax providers. A seller's declared terms disclose what the seller offers; they are not a limit on what Monacado may do where law or a provider requirement obliges it to act.",
          "Rights a buyer has under applicable law are not displaced by a seller's declared refund terms. This policy does not state what those rights are in any particular place.",
          "Monacado may correct its own payment, tax, and accounting records for a sale where a refund requires it.",
        ],
        references: [
          {
            kind: "SELLER_REFUND_POLICY",
            ref: "seller declared refund policy, version bound at checkout",
            note: "The eligibility conditions, refund window, and shipping treatment for a purchase are the seller's declared terms in the version bound to that order, not figures restated here.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUND_REQUESTS",
            note: "How a buyer asks for a refund, and what is required of them to do so.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTES_AND_CHARGEBACKS",
            note:
              "A payment dispute is a different route, raised with a different party and decided by one. It is not a refund and does not replace a refund request.",
          },
        ],
      },
      {
        key: "REFUND_REQUESTS",
        heading: "Requesting a refund",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "A buyer requests a refund by following the procedure stated in the refund policy that governed their purchase. That procedure, and the support contact to use, appear on the purchase receipt.",
          "A Monacado account is not required in order to request a refund. A purchase made as a guest may be refunded without one: the buyer identifies the purchase using the order reference and the purchase confirmation issued to them at checkout, and Monacado verifies that evidence before acting on the request.",
          "Monacado does not require a buyer to create an account after a purchase in order to ask for their money back.",
          "A request is assessed against the refund terms bound to the purchase. Making a request does not widen what those terms allow, and a seller changing their terms afterwards does not narrow what a completed purchase was sold under.",
          "A seller must receive refund requests at the support contact disclosed with the purchase and must honour requests that are eligible under the terms that governed it.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "PURCHASE_RECEIPTS",
            note: "What the receipt states, including the governing terms and the contact to use.",
          },
        ],
      },
      {
        key: "PURCHASE_RECEIPTS",
        heading: "Purchase receipts",
        audiences: ["BUYER", "SELLER"],
        paragraphs: [
          "Monacado issues a receipt for every completed purchase. A receipt records the purchase as it was made.",
          "A receipt states the order reference, what was purchased, what was charged including any tax and any shipping charge, the seller refund policy that governed the purchase and the exact version of it that was bound, how to request a refund, and the seller support contact that was in effect when the purchase was made.",
          "The refund terms and the support contact shown on a receipt are the ones disclosed to that buyer at the time of purchase. They are not replaced by a seller's current terms or current contact when the receipt is produced again later.",
          "Where a seller's present support contact is also shown, it is identified as such and appears in addition to — never instead of — the contact that was disclosed at purchase.",
          "A receipt remains reproducible after the seller changes their terms, changes their support contact, or ceases to trade.",
        ],
        references: [],
      },
      {
        key: "REFUND_EFFECT_ON_PROCEEDS",
        heading: "Refunds, proceeds, and commissions",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "Proceeds arise from a sale that stands. Where merchandise is refunded, the proceeds attributable to that merchandise are no longer earned.",
          "Amounts attributable to refunded merchandise that have not yet been paid cease to be payable. This applies to a seller's proceeds and to a promoter's commission alike.",
          "Amounts attributable to refunded merchandise that have already been paid, or that have already become payable, may be recovered, set off against amounts owed in future, or reflected as an adjustment to the participant's account balance, under Monacado's settlement rules.",
          "A refund does not erase a payment that was made. What was earned and what was paid remain recorded as they stand, and a refund is recorded as a further fact about the sale rather than as a correction of the earlier record.",
          "A promoter's commission is conditional on the underlying sale remaining economically valid. Whether a refund occurs is a matter between the buyer, the seller's declared terms, and Monacado; a promoter neither sets those terms nor decides a refund.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note: "What each party earned on a sale is governed by the commercial policy and offer versions bound to it, not restated here.",
          },
        ],
      },
      {
        /* All three audiences. A buyer needs to know which rights survive this
           document, a seller needs to know what a dispute does to a sale they
           fulfilled, and a promoter needs to know that it reaches their
           commission. Three copies of one rule would be three things to keep
           identical. */
        key: "DISPUTES_AND_CHARGEBACKS",
        heading: "Payment disputes and chargebacks",
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "A payment dispute, commonly called a chargeback, is a buyer asking their bank or card issuer to reverse a payment. It is not a refund. A refund is money Monacado returns under the terms that governed the purchase; a dispute is a reversal decided by the buyer's payment provider under the rules of a payment network. Both can happen to the same sale.",
          "Monacado is the merchant of record and is the only party to a payment dispute. Monacado may respond to a dispute, may submit the evidence it holds, and may accept a dispute rather than contest it. A seller and a promoter are not parties, cannot address the payment network, and do not decide the outcome.",
          "Monacado is always responsible for responding to a payment dispute raised against a Monacado transaction. Monacado notifies the seller, gives the seller a bounded opportunity to provide a defence and supporting evidence, considers that evidence alongside its own records, and then determines and submits the response. Providing evidence does not transfer that responsibility to the seller: the seller is heard, and Monacado decides.",
          "A buyer's rights under the rules of a payment network, and under applicable law, are separate from a seller's declared refund terms and are not limited by this policy or by those terms. This policy does not state what those rights are in any particular place.",
          "A buyer may request a refund under the terms that governed their purchase, and the receipt for that purchase states how. Nothing in this policy requires a buyer to do so before exercising a right they hold with their payment provider, and nothing in it directs a buyer to a payment dispute in place of a refund request.",
          "Monacado may respond to a dispute using the records it holds about the transaction: what was purchased, what was charged, the terms disclosed and bound at purchase, what Monacado communicated to the buyer, and the fulfilment and support facts the seller supplies. No representation is made about what a payment provider or a payment network will decide, and Monacado does not promise that any response will succeed.",
          "A dispute does not erase the record of the sale or of the payment. What was sold, what was charged, and what was paid remain recorded as they stand, and the outcome of a dispute is recorded as a further fact about the sale rather than as a correction of the earlier record.",
          "Monacado may correct its own payment, tax, and accounting records for a sale according to the outcome of a dispute, to the extent this policy and applicable law require.",
          "Contesting a dispute, or accepting one rather than contesting it, does not waive any amount Monacado is entitled to recover under this policy.",
          "Where the rules of a payment network or applicable law govern a matter this section addresses, those rules apply. This policy does not displace them and does not restate them.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "REFUNDS_AND_CANCELLATION",
            note:
              "The refund route, which is decided under the seller's bound terms and is separate from a payment dispute.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTE_EFFECT_ON_PROCEEDS",
            note:
              "What an open, won, or lost dispute does to a seller's proceeds and a promoter's commission.",
          },
          {
            kind: "SELLER_REFUND_POLICY",
            ref: "seller declared refund policy, version bound at checkout",
            note:
              "The terms under which a refund may be claimed. They govern what the seller offers and do not limit a buyer's payment-network or statutory rights.",
          },
        ],
      },
      {
        /* Sellers owe the facts; promoters owe only their own. A buyer is not
           asked for evidence, and a section addressed to a buyer describing what
           Monacado assembles about their purchase would be disclosure without a
           purpose. */
        key: "DISPUTE_EVIDENCE_AND_COOPERATION",
        heading: "Dispute evidence and cooperation",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "Where a payment is disputed, Monacado may request from the seller the facts of the sale that only the seller holds: what was supplied, when, how it was made available to the buyer, and what support or correspondence followed.",
          "A request states the date by which the facts are needed. That date follows the deadline the payment network imposes on Monacado; it is not set for Monacado's convenience and cannot be extended by Monacado. Facts supplied after it may be of no use, and the dispute may be decided without them.",
          "Evidence is supplied to Monacado. A seller and a promoter must not contact the buyer's bank, the buyer's card issuer, or a payment network about a dispute.",
          "Monacado may use the records it already holds when responding, without asking: the transaction record, the receipt issued for the purchase, the notices Monacado sent about it, the marketplace policy version and the seller refund policy version bound to the purchase, and the seller support contact disclosed with it.",
          "Monacado decides what to submit, what to withhold, and whether to contest a dispute at all. That decision belongs to Monacado as the party to it, and a seller's or a promoter's preference does not bind it.",
          "A promoter is not responsible for the seller's evidence. A promoter must supply facts within their own authority \u2014 what they published, offered, or represented about a product \u2014 where a dispute turns on them.",
          "Information about a buyer is used only so far as responding to the dispute requires. A dispute is not a route to a buyer's personal information, and Monacado does not pass a buyer's details to a seller or a promoter because a dispute exists.",
          "A seller's failure to supply requested facts by the stated date does not prevent Monacado responding, accepting the dispute, or applying this policy's consequences for the proceeds attributable to the sale.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "DISPUTES_AND_CHARGEBACKS",
            note:
              "Who is party to a dispute, and what a response can and cannot promise.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "SELLER_RESPONSIBILITIES",
            note:
              "The fulfilment and support obligations the requested facts are evidence of.",
          },
        ],
      },
      {
        key: "DISPUTE_EFFECT_ON_PROCEEDS",
        heading: "Disputes, proceeds, and commissions",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "Proceeds arise from a sale that stands. While a payment dispute on a sale is open, the amounts attributable to that sale may be held and are not payable, because a sale whose payment a bank may still reverse is not yet a sale that stands.",
          "A hold applies to the amounts attributable to the disputed sale. It is not a suspension of a participant's other proceeds, and it ends when the dispute does.",
          "Where a dispute is decided in the sale's favour, or is closed without the payment being reversed, the amounts held cease to be held and are treated as they would have been had no dispute arisen.",
          "Where a payment is reversed, the proceeds attributable to that sale are no longer earned. Amounts not yet paid cease to be payable, and this applies to a seller's proceeds and to a promoter's commission alike.",
          "Amounts attributable to a reversed sale that have already been paid, or that have already become payable, may be recovered, set off against amounts owed in future, or reflected as an adjustment to the participant's account balance, under Monacado's settlement rules.",
          "A finalized chargeback attributable to the seller incurs a $30 chargeback fee. The fee is charged once for each dispute that is finally decided against the sale. It reflects the cost of handling and losing the dispute and is separate from the reversed payment itself.",
          "Opening a dispute does not incur the fee, and a dispute decided in the sale's favour does not incur it. A seller who successfully defends a sale is not charged for having been disputed.",
          "The fee is recorded as a separate obligation. It does not alter what was earned or paid on the original sale, and the record of that sale is not rewritten to account for it.",
          "The amount of the chargeback fee is set by Monacado and may change. A change applies to chargebacks finalized after it takes effect; the fee for a chargeback is the amount in force when that chargeback is finally decided, and a later change does not alter a fee already charged.",
          "A promoter's commission is conditional on the underlying sale remaining economically valid, and a sale undone by a payment dispute is as undone as one that is refunded. A promoter neither conducts a dispute nor decides its outcome.",
          "A dispute does not erase a payment that was made. What was earned and what was paid remain recorded as they stand, and the effect of a dispute is recorded as a further fact about the sale rather than as a correction of the earlier record.",
          "A sale that is both refunded and reversed through a payment dispute has been returned to the buyer twice in fact. Recovering the second return is a matter between Monacado, the payment network, and the buyer; it does not reduce the seller's or the promoter's proceeds for that sale a second time.",
          "Where a dispute affects the tax recorded on a sale, any correction is made through Monacado's tax process and through the mechanisms its tax provider makes available, to the extent a correction applies. This policy makes no representation about the treatment of any particular tax in any particular place.",
        ],
        references: [
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note:
              "What each party earned on a sale is governed by the commercial policy and offer versions bound to it, not restated here.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "REFUND_EFFECT_ON_PROCEEDS",
            note:
              "The equivalent rules where a sale is refunded rather than reversed through a payment dispute.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "PARTICIPANT_RESTRICTIONS_AND_SUSPENSION",
            note:
              "Withholding a participant's payouts generally is a separate decision under separate terms; a hold on one disputed sale is not one and does not become one.",
          },
        ],
      },
      {
        key: "MARKETPLACE_INTEGRITY_AND_RISK_REVIEW",
        heading: "Marketplace integrity and risk review",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "Monacado monitors marketplace activity to protect buyers, sellers, promoters, and its own payment relationships. Monitoring covers the activity conducted through the marketplace \u2014 orders, refunds, payment disputes \u2014 and the patterns those form over time.",
          "What Monacado measures is bounded. It includes the rate at which a participant's sales are refunded, the rate at which they are charged back, the ratio between the two, sales that are both refunded and charged back, changes in order volume and order value against the participant's own recent history, the concentration or the spread of the places a participant sells into, and the concentration of a participant's sales in a single promoter relationship.",
          "A signal is a measurement, not a finding. An elevated rate is as consistent with a seller being defrauded, with a product that photographs better than it arrives, or with a promotional channel that converts badly, as it is with anything a participant did wrong. Monacado does not treat a signal as evidence of misconduct and does not describe a participant as having done anything wrong on the strength of one.",
          "Signals decide nothing by themselves. A measurement puts a participant in front of a member of Monacado staff. A person sees what was measured, what it was compared against, and how many sales it was computed on, and a person decides what if anything follows. Monacado does not restrict, suspend, or otherwise act against a participant on the output of a calculation alone.",
          "A review may be opened by that monitoring or by a member of Monacado staff. Opening a review is not a penalty and is not a consequence. It records that a person is looking.",
          "Monacado may ask a participant for information during a review, and may require remediation. A request states what is wanted and by when. A participant who does not answer does not thereby stop the review, and Monacado may decide it on the records it already holds.",
          "Monacado may analyse a seller's and a promoter's activity together. A pattern that appears in one seller-and-promoter relationship and not in that seller's other sales is evidence about the relationship rather than about the seller, which is what the analysis exists to distinguish. It identifies where a pattern sits. It does not by itself make either party responsible for the other's conduct.",
          "A seller is responsible for the activity attributable to their own products, listings, and offers, and may be restricted or suspended over it whether the sales were made directly or through a promoter. Separately, a promoter whose own conduct caused harm may be restricted or suspended for that conduct. Neither outcome follows automatically from the other, and Monacado decides each on its own facts and under its own record.",
          "The measurements, the classifications, and the reviews behind a decision are private operational records. They are not published, are not disclosed to other participants, and are not shown to buyers. A participant is told the kind of problem a decision about them concerns; a participant is not given Monacado's monitoring of anybody else.",
          "Monacado does not represent that monitoring detects everything, and nothing in this section is a promise that it will.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "PARTICIPANT_RESTRICTIONS_AND_SUSPENSION",
            note:
              "What Monacado may do at the end of a review, and what a participant continues to owe under one.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "MONACADO_ROLE",
            note:
              "Monacado's authority over a single transaction, which is separate from and unchanged by this section.",
          },
        ],
      },
      {
        key: "PARTICIPANT_RESTRICTIONS_AND_SUSPENSION",
        heading: "Restrictions and suspension",
        audiences: ["SELLER", "PROMOTER"],
        paragraphs: [
          "Monacado may restrict a participant. A restriction withholds a named commercial capability \u2014 taking a storefront live, publishing an offer, accruing commission, receiving a payout, or submitting reviews \u2014 while everything else the participant may do continues.",
          "A restriction never withholds the ability to fix the problem or to answer the restriction. A restricted participant may still create and correct drafts of storefronts, products, and listings, and may still submit their account for review. A restriction that stopped a participant responding to it would be a suspension under another name.",
          "Monacado may suspend a participant. A suspension withdraws admission to the marketplace pending a cure: no commerce runs, and unlike a restriction it also withholds the ability to draft and to submit for review. It is a heavier step than a restriction and is used where a restriction would not be enough.",
          "Every restriction and every suspension is a decision Monacado makes: a named Monacado account, at a recorded moment, against a recorded classification of the problem, under a recorded version of this policy. A report, a rate, a score, or a payment provider's own state does not create one on its own, and no threshold causes one automatically.",
          "A restriction and a suspension record the kind of problem they concern, drawn from a bounded set of classifications rather than written as free text. The classification names a category of problem. It is not an account of what a participant did, and it is not an allegation.",
          "Monacado records a notice to the participant when it restricts or suspends them, stating what was withheld, when it took effect, and the classification recorded for it. The notice is made available in the participant's Monacado account. Nothing in this policy promises notice in advance of a decision, and Monacado may act first where waiting would expose buyers, other participants, Monacado, or Monacado's payment relationships to loss.",
          "A participant may ask Monacado to reconsider a restriction or a suspension, once, selecting from the grounds and the remediation categories Monacado provides. Monacado considers what is submitted and records a determination. Monacado is not obliged to reverse a decision, this policy sets no period within which a reconsideration is completed, and a person may not decide a matter concerning their own participant account.",
          "This is a reconsideration by Monacado staff. It is not an appeal to anybody outside Monacado, it is not arbitration, and this policy creates no external or independent review of a decision.",
          "A restriction or a suspension ends when Monacado lifts it. Lifting is a recorded decision with its own moment, its own acting account, and its own classification. It is not automatic, it has no fixed term, and neither a restriction nor a suspension expires on its own.",
          "A participant whose suspension is lifted returns to the standing they held before it, except that any restrictions still standing against them continue to apply. Restricting or suspending a participant again afterwards is a new decision recorded as its own event; Monacado does not reopen an earlier one, and a new decision carries its own reconsideration.",
          "A restriction and a suspension withhold what a participant may do next. They do not release a participant from what they already owe. Completed orders must still be fulfilled, digital artifacts must remain available for the duration of the entitlement, refund requests must still be answered at the support contact disclosed with the purchase, refunds eligible under the terms bound to a purchase must still be honoured, and dispute evidence must still be supplied when Monacado asks for it.",
          "Monacado remains the merchant of record for every purchase already completed. A buyer's receipt, a buyer's entitlement, and a buyer's refund rights under the terms bound to their purchase are unaffected by a restriction or a suspension of the seller or promoter involved.",
          "Where a restriction withholds a payout or the accrual of commission, the amounts concerned remain recorded as they stand. Withholding a payout is not a forfeiture and does not by itself extinguish what a completed sale earned; what is owed on that sale continues to be governed by this policy and by the commercial policy version bound to it. Monacado's rights to recover amounts under this policy are unaffected.",
          "A restriction or a suspension changes what a participant may do. It does not remove their participant record, their roles, their completed orders, their receipts, or Monacado's record of any of it.",
          "Monacado does not publish that a participant is restricted or suspended, does not tell other participants, and does not state a reason to a buyer. A storefront, a listing, or an offer may stop being publicly available as a consequence of a decision; its absence is not a statement about the participant.",
          "A restriction or a suspension is a decision about a participant's standing in Monacado's marketplace. It is not a finding of fraud, of dishonesty, or of any legal wrong, and this policy does not state one.",
        ],
        references: [
          {
            kind: "POLICY_SECTION",
            ref: "MARKETPLACE_INTEGRITY_AND_RISK_REVIEW",
            note:
              "What Monacado monitors, and the review a person conducts before any of this follows.",
          },
          {
            kind: "POLICY_SECTION",
            ref: "SELLER_RESPONSIBILITIES",
            note:
              "The obligations a restricted or suspended seller continues to owe on sales already made.",
          },
          {
            kind: "COMMERCIAL_POLICY",
            ref: "0M.R1 versioned commercial policy",
            note:
              "What a completed sale earned is governed by the commercial policy version bound to it, not restated here.",
          },
        ],
      },
      {
        key: "POLICY_CHANGES",
        heading: "Changes to this policy",
        audiences: ["SELLER", "PROMOTER", "BUYER"],
        paragraphs: [
          "Monacado may issue new versions of this policy. Each version is recorded separately and the version in force at any moment is identified; earlier versions remain available so that a past acceptance or a past transaction can still be read against the terms that applied to it.",
          "A new version takes effect on the date Monacado states when it issues it. Monacado gives sellers and promoters notice of a new version and of the date it takes effect.",
          "A participant joining Monacado accepts the version in force when they join. For a participant already trading, continuing to use Monacado on or after the date a new version takes effect constitutes acceptance of that version. A participant's previous acceptances are not altered or withdrawn by a later version being issued.",
          "A participant who does not agree to a new version should stop the affected marketplace activity before the date it takes effect. Stopping does not end what is already owed: orders already completed must still be fulfilled, digital artifacts must remain available for the duration of the entitlement, refunds eligible under the terms bound to those purchases must still be honoured, and dispute evidence must still be supplied when Monacado asks for it.",
          "A purchase is governed by the policy version in force when the purchase was completed.",
        ],
        references: [],
      },
    ],
  });

/**
 * The 1.3.0 content hash, derived rather than written.
 *
 * As with every earlier version: a literal here would be a second answer able to
 * disagree with the document, and the derived value is what an acceptance record
 * is checked against.
 */
export const MONACADO_MARKETPLACE_POLICY_V1_3_HASH: PolicyContentHash =
  marketplacePolicyContentHash(MONACADO_MARKETPLACE_POLICY_V1_3);

/**
 * Every published policy document, by version.
 *
 * A map rather than a single export, because a retired version must stay
 * readable: a participant who accepted 1.0.0 is entitled to see 1.0.0.
 *
 * **Every version ever shipped stays here.** `readMarketplacePolicy` resolves an
 * Order's bound version through this map and refuses when it is absent, so
 * removing a superseded entry would break every receipt for every sale made under
 * it — which is the failure the whole binding exists to prevent.
 */
export const MARKETPLACE_POLICY_DOCUMENTS: ReadonlyMap<string, MarketplacePolicyDocument> =
  new Map([
    [MARKETPLACE_POLICY_VERSION_1, MONACADO_MARKETPLACE_POLICY_V1],
    [MARKETPLACE_POLICY_VERSION_1_1, MONACADO_MARKETPLACE_POLICY_V1_1],
    [MARKETPLACE_POLICY_VERSION_1_2, MONACADO_MARKETPLACE_POLICY_V1_2],
    [MARKETPLACE_POLICY_VERSION_1_3, MONACADO_MARKETPLACE_POLICY_V1_3],
  ]);

export function marketplacePolicyDocument(
  policyVersion: string,
): MarketplacePolicyDocument | null {
  return MARKETPLACE_POLICY_DOCUMENTS.get(policyVersion) ?? null;
}

/**
 * The newest version this deployment ships.
 *
 * What a bootstrap records by default, and **not** an assertion that it governs
 * anything: the version in force is whichever the database says is `ACTIVE`, and
 * shipping a newer one does not activate it. Those are different facts and this
 * constant answers only the first.
 */
export const LATEST_MARKETPLACE_POLICY_VERSION = MARKETPLACE_POLICY_VERSION_1_3;

/**
 * The content ref for one shipped version.
 *
 * A lookup rather than a constructed string: a ref is an identifier recorded on a
 * governance row, and deriving one by concatenation would mint refs for versions
 * that do not exist.
 */
export const MARKETPLACE_POLICY_CONTENT_REFS: ReadonlyMap<string, string> = new Map([
  [MARKETPLACE_POLICY_VERSION_1, MARKETPLACE_POLICY_CONTENT_REF_1],
  [MARKETPLACE_POLICY_VERSION_1_1, MARKETPLACE_POLICY_CONTENT_REF_1_1],
  [MARKETPLACE_POLICY_VERSION_1_2, MARKETPLACE_POLICY_CONTENT_REF_1_2],
  [MARKETPLACE_POLICY_VERSION_1_3, MARKETPLACE_POLICY_CONTENT_REF_1_3],
]);

/**
 * Whether a NEW participant must explicitly accept this version at onboarding.
 *
 * RENAMED AND RESTATED, because the old name asserted a rule Monacado does not
 * have. "Reacceptance" reads as: an already-active participant must click Accept
 * again before they may keep trading. That was never the rule, and no code path
 * ever enforced it — no commerce gate, no checkout branch, and no activation
 * check for an already-activated participant reads this value.
 *
 * Monacado's actual rule has two halves, and they are stated as modes in
 * `POLICY_ACCEPTANCE_MODES`:
 *
 *   - a participant joining now explicitly accepts the version in force;
 *   - a participant already trading accepts an updated version by continuing to
 *     use Monacado after it takes effect, having been given notice.
 *
 * This map is the first half, per version, and it feeds the published
 * `requiresReacceptance` column whose name it can no longer change. Every
 * version is `true` and always has been: a new participant is always asked to
 * accept the terms in force. It is kept per-version rather than collapsed to a
 * constant so a future version that genuinely differs has somewhere to say so.
 */
export const MARKETPLACE_POLICY_ONBOARDING_ACCEPTANCE: ReadonlyMap<string, boolean> = new Map([
  [MARKETPLACE_POLICY_VERSION_1, true],
  [MARKETPLACE_POLICY_VERSION_1_1, true],
  /* 1.2.0 requires it on the same test 1.1.0 met, three times over: a new
     affirmative seller duty to supply evidence by a network-driven date, a new
     economic consequence in proceeds being HELD while a dispute is open, and the
     reversal of a promoter's commission on a charged-back sale — which the
     standing text, written only about refunds, does not do. */
  [MARKETPLACE_POLICY_VERSION_1_2, true],
  /* 1.3.0, like every version before it, is accepted explicitly by a participant
     joining under it. For a participant already trading it takes effect on the
     stated date after notice, and continued use from that date is the
     acceptance — which is what its own POLICY_CHANGES section now says. Nothing
     here obliges an existing participant to accept again before trading, and
     nothing gates their commerce on having done so. */
  [MARKETPLACE_POLICY_VERSION_1_3, true],
]);
