/**
 * Monacado Marketplace Policy — version 1.0.0 source content (Phase 1.3).
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

/**
 * Every published policy document, by version.
 *
 * A map rather than a single export, because a retired version must stay
 * readable: a participant who accepted 1.0.0 is entitled to see 1.0.0.
 */
export const MARKETPLACE_POLICY_DOCUMENTS: ReadonlyMap<string, MarketplacePolicyDocument> =
  new Map([[MARKETPLACE_POLICY_VERSION_1, MONACADO_MARKETPLACE_POLICY_V1]]);

export function marketplacePolicyDocument(
  policyVersion: string,
): MarketplacePolicyDocument | null {
  return MARKETPLACE_POLICY_DOCUMENTS.get(policyVersion) ?? null;
}
