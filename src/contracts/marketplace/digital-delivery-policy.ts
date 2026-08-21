/**
 * Digital delivery policy (Phase 1.2 correction).
 *
 * **The rules, and deliberately not the system.** This module declares what
 * Monacado's digital delivery *means* — what a buyer is owed, what a credential
 * is, who bears exceptional support — so that the transaction can be completed
 * correctly now and the delivery machinery can be built later against a stated
 * policy rather than an invented one.
 *
 * No entitlement is issued here, no token is minted, no artifact is stored, and
 * no endpoint is served. Those are a delivery phase's; see
 * `RESERVED_DELIVERY_MODELS`.
 *
 * ## The distinction the whole policy rests on
 *
 * ```
 * ENTITLEMENT  — the durable RIGHT to access what was bought.
 *                Created by a completed purchase. Survives everything below.
 * TOKEN        — a temporary CREDENTIAL for exercising that right once.
 *                Short-lived, opaque, revocable, replaceable, disposable.
 * ```
 *
 * A token is **never** the entitlement. Conflating them is the classic mistake in
 * digital delivery, and it fails in both directions: a lost token would mean a
 * lost purchase, and a leaked token would mean a transferable one. Keeping them
 * separate is what lets a buyer re-download freely without Monacado ever
 * re-deciding whether they bought the thing.
 *
 * ## What "5 downloads" is and is not
 *
 * It is a **self-service allowance**, not a limit on the right. The entitlement
 * does not expire when the allowance does; what expires is the buyer's ability to
 * get further credentials *without anyone being asked*. Beyond it, access needs
 * seller authorization — which is a routing decision, not a refusal.
 *
 * **Only successful downloads count.** A connection that dropped at 90% is not a
 * delivery, and charging a buyer's allowance for their own bad wifi is the single
 * most common way this kind of policy becomes hostile.
 *
 * Pure types and pure decisions. No I/O, no clock, no storage.
 */

import { z } from "zod";

// — The allowance —

/**
 * Successful downloads a buyer may take per digital product, self-service.
 *
 * Five: enough to cover a new laptop, a phone, a re-install, and a mistake, and
 * small enough that unlimited redistribution is not the default. It is a
 * **policy default**, so a future per-product or per-seller override changes a
 * number rather than a design.
 */
export const DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE = 5 as const;

/**
 * Whether an attempt consumes allowance.
 *
 * **Only a completed delivery does.** Interrupted, failed, and abandoned attempts
 * do not, because the buyer received nothing — and a policy that charged them for
 * a dropped connection would punish the exact people least able to avoid it.
 */
export const ALLOWANCE_CONSUMED_BY = "SUCCESSFUL_DOWNLOAD_ONLY" as const;

// — Where the bytes live —

/**
 * Who hosts the artifact.
 *
 * Both are first-class. The difference is **where the file is**, never whether
 * Monacado decides who may have it: entitlement verification is Monacado's in
 * both cases, because the right to access is a fact about a purchase and only
 * Monacado holds purchases.
 */
export const DELIVERY_HOST_TYPES = [
  /** Monacado stores the artifact and serves it against an entitlement. */
  "MONACADO_HOSTED",
  /** The seller stores it; access is still gated by Monacado's entitlement. */
  "EXTERNAL_HOSTED",
] as const;
export const DeliveryHostType = z.enum(DELIVERY_HOST_TYPES);
export type DeliveryHostType = z.infer<typeof DeliveryHostType>;

/**
 * **An externally hosted product may not rely on a permanent reusable secret URL.**
 *
 * A "secret link" is a bearer credential with no expiry, no scope, no revocation,
 * and no record of use. Once shared it is indistinguishable from publishing the
 * file, and the seller cannot withdraw it without breaking every legitimate
 * buyer. It is not delivery control; it is the appearance of it.
 *
 * External delivery must therefore go through **Monacado entitlement
 * verification**, or a **Monacado-issued short-lived delivery credential** — so
 * the same rules (expiry, scope, revocation, allowance) apply wherever the bytes
 * happen to sit.
 *
 * The verification endpoint is **not built in this phase**; this records the rule
 * it must satisfy.
 */
export const EXTERNAL_DELIVERY_RULE = {
  permanentSecretUrl: "PROHIBITED",
  permitted: ["MONACADO_ENTITLEMENT_VERIFICATION", "MONACADO_ISSUED_SHORT_LIVED_CREDENTIAL"],
} as const;

// — Tokens —

/**
 * What a delivery token must be, as a checkable list rather than a paragraph.
 *
 * Every property exists because its absence is a specific failure:
 *
 *   - **high-entropy, opaque** — a guessable or meaningful token is an access
 *     control anybody can enumerate, and one that leaks what was bought;
 *   - **short-lived** — the window in which a leaked credential is worth
 *     anything is the window it is valid for;
 *   - **scoped** — to one entitlement and one artifact, so a token for one
 *     purchase cannot fetch another;
 *   - **single-use or tightly usage-limited** — an unlimited token is a permanent
 *     secret URL wearing a different name;
 *   - **revocable** — a right that cannot be withdrawn is not governed;
 *   - **replaceable** — the buyer's remedy for a lost or expired token is a fresh
 *     one, never a support ticket;
 *   - **never persisted in plaintext** — a token table readable by anyone with
 *     database access is a table of working credentials. Only a digest is stored,
 *     the same construction `0M.9` uses for a guest claim code and `1.1` for a
 *     delivery destination.
 */
export const DELIVERY_TOKEN_PROPERTIES = [
  "HIGH_ENTROPY",
  "OPAQUE",
  "SHORT_LIVED",
  "SCOPED_TO_ENTITLEMENT_AND_ARTIFACT",
  "USAGE_LIMITED",
  "REVOCABLE",
  "REPLACEABLE",
  "NEVER_PERSISTED_IN_PLAINTEXT",
] as const;
export const DeliveryTokenProperty = z.enum(DELIVERY_TOKEN_PROPERTIES);
export type DeliveryTokenProperty = z.infer<typeof DeliveryTokenProperty>;

/**
 * Named as never-persistable when delivery is built.
 *
 * Recorded now because the pressure to store a token "just for debugging" arrives
 * with the first support request, and a list written before the pressure is worth
 * more than one written after. A test asserts no column of any of these names
 * exists on the Product, Order, or buyer-snapshot tables today.
 */
export const NEVER_PERSISTED_FOR_DELIVERY = [
  "downloadToken",
  "deliveryToken",
  "tokenPlaintext",
  "downloadUrl",
  "signedUrl",
  "secretUrl",
  "accessKey",
] as const;

// — Re-download —

/**
 * What happens when a buyer wants the file again.
 *
 * Self-service **while the entitlement stands and allowance remains**. Each
 * request mints a **fresh** credential; the previous one is never recovered,
 * reused, or extended — recovering a token would mean it had been stored in a
 * form that could be handed back, which is precisely what is forbidden.
 *
 * Past the allowance the request is **routed, not refused**: Monacado asks the
 * seller. That division is deliberate — Monacado provides the entitlement and
 * token infrastructure, and the **seller bears exceptional access and delivery
 * support** for their own product, because they are the only party who can judge
 * whether a tenth download is a re-install or redistribution.
 */
export const REDOWNLOAD_POLICY = {
  withinAllowance: "SELF_SERVICE",
  credentialOnReissue: "FRESH_TOKEN_ONLY",
  originalTokenReuse: "NEVER",
  beyondAllowance: "REQUIRES_SELLER_AUTHORIZATION",
  exceptionalSupportOwner: "SELLER",
  infrastructureAndRoutingOwner: "MONACADO",
} as const;

// — Guest purchases —

/**
 * How a guest reaches what they bought.
 *
 * The entitlement is anchored to the **purchase**, not to an identity: `0M.9`'s
 * `PurchaseEvidence` already names the Order, the Product, and the seller, and
 * `1.2`'s buyer snapshot holds the verified checkout email. Between them a guest
 * is reachable without ever having been made into somebody.
 *
 * **No `Account` and no `MarketplaceParticipant` is created for delivery.** That
 * is the same promise `0M.9` made about buying and `1.1` about being notified,
 * and inventing an identity to hand somebody a file would break it for the
 * convenience of a foreign key.
 *
 * If the buyer later claims the purchase into an account, **the entitlement does
 * not change** — `0M.9`'s `claimGuestOrder` attaches an account to the Order and
 * leaves `buyerKind` as `GUEST_BUYER` forever, because the sale was made by a
 * guest. The right to the file was created by the purchase and is unaffected by
 * who later logs in to look at it.
 */
export const GUEST_DELIVERY_RECOVERY = {
  anchoredTo: "PURCHASE_EVIDENCE_AND_ORDER",
  recoveryFactors: ["ORDER_REFERENCE", "VERIFIED_CHECKOUT_EMAIL"],
  createsAccount: false,
  createsParticipant: false,
  entitlementChangesOnClaim: false,
} as const;

// — Reserved architecture —

/**
 * The models a delivery phase will add, named now so this correction does not
 * have to guess at them and a later phase does not have to renegotiate them.
 *
 * **None is created here**, and none is needed yet: a completed sale already
 * records everything an entitlement must anchor to — `PurchaseEvidence` names the
 * Order, the Product, and the seller; the Product's source version names its
 * `deliveryMode`; the buyer snapshot names the verified email. So entitlements
 * can be issued later **without rewriting Order or Product semantics**, which is
 * the only thing this correction had to protect.
 */
export const RESERVED_DELIVERY_MODELS = [
  /** The durable right, one per purchased digital Product. Anchors the allowance. */
  "DigitalDeliveryEntitlement",
  /** The thing delivered — a file version, hosted by Monacado or the seller. */
  "DigitalDeliveryArtifact",
  /** One authorization to fetch: which entitlement, which artifact, why. */
  "DigitalDeliveryGrant",
  /** The transient credential. Digest only; never plaintext. */
  "DigitalDeliveryToken",
] as const;

/**
 * What this phase deliberately did not build.
 *
 * Recorded so "digital delivery is done" is never mistaken for true.
 */
export const DEFERRED_DELIVERY_IMPLEMENTATION = [
  "entitlement issuance on a completed sale",
  "artifact storage and versioning",
  "token minting, verification, and revocation",
  "the download endpoint",
  "external-host entitlement verification endpoint",
  "seller authorization workflow and UI",
  "guest recovery flow",
  "allowance accounting and reporting",
] as const;
