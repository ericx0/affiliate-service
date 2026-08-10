import { describe, it, expect } from "vitest";
import { settingsStripeReturnUrl, dashboardUrlFor } from "./portal-urls.js";

describe("portal-urls helpers", () => {
  describe("settingsStripeReturnUrl", () => {
    it("returns KOL settings URL for role='kol'", () => {
      expect(settingsStripeReturnUrl("kol"))
        .toBe("https://affiliate.linkchinamed.com/dashboard/settings/stripe");
    });

    it("returns Agent settings URL on agent portal for role='agent'", () => {
      expect(settingsStripeReturnUrl("agent"))
        .toBe("https://agent.linkchinamed.com/dashboard/settings/stripe");
    });
  });

  describe("dashboardUrlFor", () => {
    it("returns KOL dashboard URL for role='kol'", () => {
      expect(dashboardUrlFor("kol"))
        .toBe("https://affiliate.linkchinamed.com/dashboard");
    });

    it("returns Agent dashboard URL on agent portal for role='agent'", () => {
      expect(dashboardUrlFor("agent"))
        .toBe("https://agent.linkchinamed.com/dashboard");
    });
  });
});