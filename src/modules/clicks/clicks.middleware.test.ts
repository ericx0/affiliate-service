import { describe, it, expect } from "vitest";
import { generateVisitorSessionId, extractReferralCode } from "./clicks.middleware.js";

describe("generateVisitorSessionId", () => {
  it("returns a UUID v4", () => {
    const sid = generateVisitorSessionId();
    expect(sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns different IDs each call", () => {
    const a = generateVisitorSessionId();
    const b = generateVisitorSessionId();
    expect(a).not.toBe(b);
  });
});

describe("extractReferralCode", () => {
  it("extracts from query string", () => {
    const url = new URL("https://example.com/?ref=ABC123");
    expect(extractReferralCode(url, null)).toBe("ABC123");
  });

  it("extracts from cookie when no query param", () => {
    const url = new URL("https://example.com/");
    expect(extractReferralCode(url, "XYZ789")).toBe("XYZ789");
  });

  it("prefers query param over cookie", () => {
    const url = new URL("https://example.com/?ref=NEWVAL");
    expect(extractReferralCode(url, "OLDVAL")).toBe("NEWVAL");
  });

  it("returns null when neither present", () => {
    const url = new URL("https://example.com/");
    expect(extractReferralCode(url, null)).toBeNull();
  });

  it("rejects invalid format", () => {
    const url = new URL("https://example.com/?ref=ab");  // too short
    expect(extractReferralCode(url, null)).toBeNull();
  });
});