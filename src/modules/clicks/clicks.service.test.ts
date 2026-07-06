import { describe, it, expect } from "vitest";
import { isWithinAttributionWindow, ATTRIBUTION_WINDOW_DAYS } from "./clicks.service.js";

describe("isWithinAttributionWindow", () => {
  it("returns true when now is before window end", () => {
    const clickedAt = new Date();
    const result = isWithinAttributionWindow(clickedAt.toISOString());
    expect(result).toBe(true);
  });

  it("returns false when 31 days have passed", () => {
    const clickedAt = new Date();
    clickedAt.setDate(clickedAt.getDate() - 31);
    const result = isWithinAttributionWindow(clickedAt.toISOString());
    expect(result).toBe(false);
  });

  it("returns true at exactly 30 days", () => {
    const clickedAt = new Date();
    clickedAt.setDate(clickedAt.getDate() - 30);
    const result = isWithinAttributionWindow(clickedAt.toISOString());
    expect(result).toBe(true); // boundary inclusive
  });
});

describe("ATTRIBUTION_WINDOW_DAYS", () => {
  it("is 30", () => {
    expect(ATTRIBUTION_WINDOW_DAYS).toBe(30);
  });
});