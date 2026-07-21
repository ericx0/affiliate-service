import { describe, it, expect, vi, beforeEach } from "vitest";

const mockState = vi.hoisted(() => ({
  orderUserInfo: null as Record<string, unknown> | null,
  promoterContact: null as { email?: string; phone?: string | null } | null,
  insertedFlags: [] as Array<Record<string, unknown>>,
}));

function chainable(resolver: () => Promise<unknown>) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.in = self;
  chain.gte = self;
  chain.limit = self;
  chain.maybeSingle = resolver;
  return chain;
}

vi.mock("../../config.js", () => ({
  supabase: {
    schema: () => ({
      from: () => chainable(async () => ({
        data: mockState.orderUserInfo ? { user_info: mockState.orderUserInfo } : null,
        error: null,
      })),
    }),
    from: (table: string) => {
      if (table === "affiliate.promoters") {
        return chainable(async () => ({ data: mockState.promoterContact, error: null }));
      }
      if (table === "affiliate.fraud_flags") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
          insert: async (row: Record<string, unknown>) => {
            mockState.insertedFlags.push(row);
            return { error: null };
          },
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { checkSelfReferral } from "./fraud.service.js";

beforeEach(() => {
  mockState.orderUserInfo = null;
  mockState.promoterContact = null;
  mockState.insertedFlags = [];
});

describe("checkSelfReferral (L1)", () => {
  it("flags when promoter email == customer email", async () => {
    mockState.orderUserInfo = { email: "kol@example.com", phone: "+1 555 000 1111" };
    mockState.promoterContact = { email: "KOL@example.com", phone: null };
    const result = await checkSelfReferral("p1", "o1");
    expect(result.flagged).toBe(true);
    expect(result.flagType).toBe("self_referral_email");
    expect(mockState.insertedFlags).toHaveLength(1);
    expect(mockState.insertedFlags[0].flag_type).toBe("self_referral_email");
    expect(mockState.insertedFlags[0].commission_id).toBeNull();
  });

  it("flags when promoter phone == customer phone (normalized)", async () => {
    mockState.orderUserInfo = { email: "customer@example.com", phone: "+86 138-0000-1111" };
    mockState.promoterContact = { email: "kol@example.com", phone: "13800001111" };
    const result = await checkSelfReferral("p1", "o1");
    expect(result.flagged).toBe(true);
    expect(result.flagType).toBe("self_referral_phone");
  });

  it("does not flag a normal referral", async () => {
    mockState.orderUserInfo = { email: "customer@example.com", phone: "+1 555 000 2222" };
    mockState.promoterContact = { email: "kol@example.com", phone: "+1 555 000 3333" };
    const result = await checkSelfReferral("p1", "o1");
    expect(result.flagged).toBe(false);
    expect(mockState.insertedFlags).toHaveLength(0);
  });

  it("does not flag when the order carries no contact info", async () => {
    mockState.orderUserInfo = {};
    mockState.promoterContact = { email: "kol@example.com" };
    const result = await checkSelfReferral("p1", "o1");
    expect(result.flagged).toBe(false);
  });

  it("does not flag when the order is missing", async () => {
    mockState.orderUserInfo = null;
    mockState.promoterContact = { email: "kol@example.com" };
    const result = await checkSelfReferral("p1", "o1");
    expect(result.flagged).toBe(false);
  });
});
