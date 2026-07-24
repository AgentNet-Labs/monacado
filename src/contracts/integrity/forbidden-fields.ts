/**
 * Cross-authority / privacy field guard.
 *
 * The creator-authoritative Product capsule must not carry another authority's
 * assertions or any private/payment data — anywhere in the public capsule,
 * including open containers such as `specifications` and `metadata`.
 *
 * This is a denylist scan applied in addition to per-level strict object
 * schemas. It is intentionally NOT a broad claim-key vocabulary (ADR §2, and
 * this phase's "do not create a broad custom claim-key vocabulary"): it only
 * rejects the specific foreign-authority and sensitive concepts that must never
 * appear in a creator Product capsule.
 *
 * TEMPORARY (ADR §10.5): the substring-based matching below is a Phase 0B
 * safeguard, acceptable for the current narrow synthetic Product shape. Before
 * real, extensible `specifications`/`metadata` are accepted, it must be replaced
 * or supplemented by explicit allowlisted schemas or namespace-aware validation
 * to avoid false positives (e.g. a legitimate key containing "price") and
 * semantic ambiguity. Do not expand it during Phase 0B.
 */

/** Exact keys (normalized to lowercase) that must never appear. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  // commercial terms → Offer capsule
  "price",
  "pricecurrency",
  "currency",
  "discount",
  "discountrate",
  "validityStart".toLowerCase(),
  "validityEnd".toLowerCase(),
  "territory",
  // promoter authority → Listing capsule
  "promotercommissionrate",
  "commission",
  "commissionrate",
  "commissioneligibility",
  "promotercommentary",
  "curation",
  // Monacado authority → MarketplaceVerification capsule
  "verifiedby",
  "marketplaceactivationstatus",
  "agentnetpublicationstatus",
  "marketplaceverification",
  // buyer authority → Review capsule
  "review",
  "reviews",
  "rating",
  "ratings",
  // payment / private identity
  "stripe",
  "stripeaccountid",
  "payment",
  "paymentmethod",
  "cardnumber",
  "bankaccount",
  "iban",
  "routingnumber",
  "ssn",
  "taxid",
  "taxidentification",
  "dateofbirth",
  "residentialaddress",
]);

/**
 * Substring tokens that flag a forbidden concept regardless of surrounding
 * text (catches nested variants like `unitPrice`, `stripeCustomerId`). Kept
 * short and specific to avoid false positives on legitimate spec keys.
 */
const FORBIDDEN_TOKENS: readonly string[] = [
  "price",
  "commission",
  "stripe",
  "payment",
  "discount",
  "cardnumber",
  "bankaccount",
];

export interface ForbiddenFinding {
  /** Dotted path to the offending key. */
  path: string;
  key: string;
  reason: "forbidden-key" | "forbidden-token";
}

function keyIsForbidden(key: string): ForbiddenFinding["reason"] | null {
  const norm = key.toLowerCase();
  if (FORBIDDEN_KEYS.has(norm)) return "forbidden-key";
  if (FORBIDDEN_TOKENS.some((tok) => norm.includes(tok))) return "forbidden-token";
  return null;
}

/** Recursively collect every forbidden key anywhere in the value. */
export function findForbiddenFields(value: unknown, basePath = ""): ForbiddenFinding[] {
  const findings: ForbiddenFinding[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      // JSON-LD keywords (@context/@type/@id) are structural, never scanned.
      if (!key.startsWith("@")) {
        const reason = keyIsForbidden(key);
        if (reason) {
          findings.push({ path: path ? `${path}.${key}` : key, key, reason });
        }
      }
      walk(child, path ? `${path}.${key}` : key);
    }
  };

  walk(value, basePath);
  return findings;
}
