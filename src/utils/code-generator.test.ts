import { describe, it, expect } from "vitest";
import { generatePromoCode, isValidCodeFormat } from "./code-generator.js";

describe("generatePromoCode", () => {
  it("returns 8-character string", () => {
    const code = generatePromoCode();
    expect(code).toHaveLength(8);
  });

  it("uses only uppercase alphanumeric characters", () => {
    for (let i = 0; i < 100; i++) {
      const code = generatePromoCode();
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
    }
  });

  it("generates different codes on repeated calls", () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generatePromoCode()));
    // With 36^8 combinations, collisions in 1000 samples are extremely unlikely
    expect(codes.size).toBeGreaterThan(990);
  });
});

describe("isValidCodeFormat", () => {
  it("accepts 4-32 char alphanumeric + hyphens", () => {
    expect(isValidCodeFormat("ABC123")).toBe(true);
    expect(isValidCodeFormat("dr-smith-2026")).toBe(true);
  });

  it("rejects too short", () => {
    expect(isValidCodeFormat("AB")).toBe(false);
  });

  it("rejects too long", () => {
    expect(isValidCodeFormat("A".repeat(33))).toBe(false);
  });

  it("rejects special characters", () => {
    expect(isValidCodeFormat("ABC_123")).toBe(false);
    expect(isValidCodeFormat("ABC 123")).toBe(false);
    expect(isValidCodeFormat("ABC.123")).toBe(false);
  });
});