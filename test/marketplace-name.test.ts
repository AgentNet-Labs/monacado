/**
 * Phase 1.43 — mName: the alphabet, shape, staged length, lookup, and the
 * crypto draw. Pure; no database (the issuance itself is proven in
 * `marketplace-name.integration.test.ts`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_NAME_ALPHABET,
  MARKETPLACE_NAME_DIGITS,
  MARKETPLACE_NAME_LETTERS,
  MARKETPLACE_NAME_MAX_LENGTH,
  MARKETPLACE_NAME_MIN_LENGTH,
  MARKETPLACE_NAME_RE,
  MARKETPLACE_NAME_STAGE_OCCUPANCY,
  isMarketplaceName,
  marketplaceNameCapacity,
  marketplaceNameStageLength,
  parseMarketplaceNameLookup,
} from "../src/contracts/marketplace/marketplace-name";
import { cryptoMarketplaceNameProvider } from "../src/server/marketplace/marketplace-name-service";
import { findParticipantPrivacyViolations } from "../src/contracts/marketplace/participant-record";

describe("1.43 — mName alphabet and shape", () => {
  it("is 30 lowercase characters with no visually ambiguous member", () => {
    expect(MARKETPLACE_NAME_ALPHABET).toBe("23456789abcdefghjkmnpqrstvwxyz");
    expect(new Set(MARKETPLACE_NAME_ALPHABET).size).toBe(30);
    for (const ambiguous of ["0", "1", "o", "i", "l", "u", "O", "I", "L", "U"]) {
      expect(MARKETPLACE_NAME_ALPHABET).not.toContain(ambiguous);
    }
    expect(MARKETPLACE_NAME_ALPHABET).toBe(MARKETPLACE_NAME_ALPHABET.toLowerCase());
    expect(MARKETPLACE_NAME_DIGITS.length + MARKETPLACE_NAME_LETTERS.length).toBe(30);
  });

  it("accepts only the issued shape: alphabet only, 4–16 long, at least one letter and one digit", () => {
    for (const ok of ["m7kx", "2abc", "zzz9", "4h7q2", "a2".repeat(8)]) expect(isMarketplaceName(ok), ok).toBe(true);
    for (const bad of [
      "abcd", // all letters — could spell a word
      "2345", // all digits — reads as a number
      "m7k", // too short
      "a2".repeat(8) + "x", // too long
      "M7KX", // uppercase is never stored
      "m0kx", // 0 excluded
      "m1kx", // 1 excluded
      "m7ko", // o excluded
      "m7kl", // l excluded
      "m7ki", // i excluded
      "m7ku", // u excluded
      "m7k-",
      " m7kx",
      "m7kx ",
      "",
    ]) {
      expect(isMarketplaceName(bad), bad).toBe(false);
    }
    expect(MARKETPLACE_NAME_RE.test("m7kx")).toBe(true);
  });
});

describe("1.43 — namespace capacity and staged length", () => {
  it("capacity at length L is 30^L less the all-letter and all-digit strings", () => {
    expect(marketplaceNameCapacity(4)).toBe(810_000 - 234_256 - 4_096); // 571 648
    expect(marketplaceNameCapacity(5)).toBe(24_300_000 - 5_153_632 - 32_768); // 19 113 600
    expect(marketplaceNameCapacity(6)).toBe(729_000_000 - 113_379_904 - 262_144); // 615 357 952
    expect(marketplaceNameCapacity(4)).toBe(571_648);
  });

  it("starts at 4 and moves up a length only once a quarter of the current one is issued", () => {
    expect(MARKETPLACE_NAME_MIN_LENGTH).toBe(4);
    expect(MARKETPLACE_NAME_STAGE_OCCUPANCY).toBe(0.25);
    const quarter4 = marketplaceNameCapacity(4) * 0.25; // 142 912
    expect(marketplaceNameStageLength(0)).toBe(4);
    expect(marketplaceNameStageLength(quarter4 - 1)).toBe(4);
    expect(marketplaceNameStageLength(quarter4)).toBe(5);
    const quarter5 = marketplaceNameCapacity(5) * 0.25; // 4 778 400
    expect(marketplaceNameStageLength(quarter5 - 1)).toBe(5);
    expect(marketplaceNameStageLength(quarter5)).toBe(6);
    const huge = marketplaceNameStageLength(Number.MAX_SAFE_INTEGER);
    expect(huge).toBeGreaterThan(6);
    expect(huge).toBeLessThanOrEqual(MARKETPLACE_NAME_MAX_LENGTH);
  });

  it("never moves backwards as the issued count grows", () => {
    let previous = 0;
    for (let issued = 0; issued < 10_000_000; issued += 9_973) {
      const length = marketplaceNameStageLength(issued);
      expect(length).toBeGreaterThanOrEqual(previous);
      previous = length;
    }
  });
});

describe("1.43 — mName lookup", () => {
  it("trims and lowercases a typed mName and refuses anything that cannot be one", () => {
    expect(parseMarketplaceNameLookup("  M7KX ")).toBe("m7kx");
    expect(parseMarketplaceNameLookup("m7kx")).toBe("m7kx");
    expect(parseMarketplaceNameLookup("m0kx")).toBeNull(); // never "corrected" to a near miss
    expect(parseMarketplaceNameLookup("Sam Seller")).toBeNull();
    expect(parseMarketplaceNameLookup("")).toBeNull();
    expect(parseMarketplaceNameLookup(null)).toBeNull();
    expect(parseMarketplaceNameLookup(undefined)).toBeNull();
  });
});

describe("1.43 — the crypto draw", () => {
  it("draws only issued-shape candidates of exactly the requested length", () => {
    for (const length of [4, 5, 6, 16]) {
      for (let i = 0; i < 2_000; i += 1) {
        const candidate = cryptoMarketplaceNameProvider.nextCandidate(length);
        expect(candidate).toHaveLength(length);
        expect(isMarketplaceName(candidate), candidate).toBe(true);
      }
    }
  });

  it("takes nothing but a length — no account, participant, name, or email can reach it", () => {
    expect(cryptoMarketplaceNameProvider.nextCandidate.length).toBe(1);
  });

  it("uses every alphabet character, roughly evenly, and repeats rarely", () => {
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    const draws = 30_000;
    for (let i = 0; i < draws; i += 1) {
      const c = cryptoMarketplaceNameProvider.nextCandidate(4);
      seen.add(c);
      for (const ch of c) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect([...counts.keys()].sort().join("")).toBe([...MARKETPLACE_NAME_ALPHABET].sort().join(""));
    // Shape rejection skews per-character frequency a little toward digits;
    // a biased modulo or a dropped character would be far outside this band.
    const mean = (draws * 4) / 30;
    for (const [ch, n] of counts) {
      expect(n, ch).toBeGreaterThan(mean * 0.7);
      expect(n, ch).toBeLessThan(mean * 1.6);
    }
    // 30 000 draws over 571 648 names: a birthday-bound of ~790 repeats.
    expect(draws - seen.size).toBeLessThan(1_000);
  });
});

describe("1.43 — mName is issued at creation and written nowhere else", () => {
  /** Every TypeScript source under src/ and app/. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("every MarketplaceParticipant create sets it from the allocator; no update, upsert, or raw SQL ever writes it", () => {
    const creates: string[] = [];
    const offenders: string[] = [];
    for (const path of [...sources("src"), ...sources("app")]) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/marketplaceParticipant\.(create|createMany|update|updateMany|upsert)\(/g)) {
        const call = text.slice(m.index, text.indexOf("});", m.index));
        if (m[1] === "create") {
          creates.push(path);
          if (!call.includes("marketplaceName: await allocateMarketplaceNameIn(tx, mNames)")) offenders.push(`${path}: create without mName`);
        } else if (call.includes("marketplaceName")) {
          offenders.push(`${path}: ${m[1]} writes mName`);
        }
      }
      if (/(UPDATE|INSERT INTO)\s+`?MarketplaceParticipant`?[^;]*marketplaceName/i.test(text)) offenders.push(`${path}: raw SQL`);
    }
    expect(offenders).toEqual([]);
    expect(creates).toEqual([
      "src/server/marketplace/participant-service.ts",
      "src/server/marketplace/participant-service.ts",
    ]);
  });

  it("declared-name keys are refused by the participant privacy guard", () => {
    expect(
      findParticipantPrivacyViolations({ promoter: { firstName: "x", lastName: "y", declaredName: "z", mName: "m7kx" } }).map(
        (f) => f.key,
      ),
    ).toEqual(["firstName", "lastName", "declaredName"]);
  });
});
