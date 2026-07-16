import { describe, it, expect } from "vitest";
import { canTransition } from "./commissions.types.js";
import { agentCommissionType } from "./commissions.service.js";

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

describe("agentCommissionType", () => {
  it("maps 'service' to 'agent_service'", () => {
    expect(agentCommissionType("service")).toBe("agent_service");
  });

  it("maps 'subscription' to 'agent_subscription'", () => {
    expect(agentCommissionType("subscription")).toBe("agent_subscription");
  });

  it("returns null for agent_* (no override-of-override, two-tier only)", () => {
    expect(agentCommissionType("agent_service")).toBeNull();
    expect(agentCommissionType("agent_subscription")).toBeNull();
  });
});