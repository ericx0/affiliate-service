import { describe, it, expect } from "vitest";
import { canTransition } from "./commissions.types.js";

describe("commission state machine", () => {
  it("cooling_down → approved is valid", () => {
    expect(canTransition("cooling_down", "approved")).toBe(true);
  });

  it("cooling_down → refunded is valid", () => {
    expect(canTransition("cooling_down", "refunded")).toBe(true);
  });

  it("approved → paid is valid", () => {
    expect(canTransition("approved", "paid")).toBe(true);
  });

  it("paid → reversed is valid", () => {
    expect(canTransition("paid", "reversed")).toBe(true);
  });

  it("pending → cooling_down is valid (after order paid)", () => {
    expect(canTransition("pending", "cooling_down")).toBe(true);
  });

  it("refunded → paid is INVALID (terminal state)", () => {
    expect(canTransition("refunded", "paid")).toBe(false);
  });

  it("paid → cooling_down is INVALID (no going back)", () => {
    expect(canTransition("paid", "cooling_down")).toBe(false);
  });

  it("approved → cooling_down is INVALID", () => {
    expect(canTransition("approved", "cooling_down")).toBe(false);
  });
});