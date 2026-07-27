import { describe, it, expect, vi, beforeEach } from "vitest";

// Attach idempotency tests: the main-site will soon do "lazy attach"
// (attach before emitting an event when the order has a referral_code but
// no commission yet), so the same orderId may be attached more than once.
// attachToOrder is keyed on UNIQUE(order_id, commission_type) — a repeat
// attach must return the existing rows without inserting duplicates.

const { state } = vi.hoisted(() => ({
  state: {
    promoter: {
      id: "p-kol",
      commission_rate: 5,
      status: "active",
      recruited_by_agent_id: "00000000-0000-0000-0000-0000000000a9",
    } as Record<string, any> | null,
    agent: {
      commission_rate: 10,
      status: "active",
    } as Record<string, any> | null,
    // Existing commissions keyed by commission_type (the dedupe store).
    commissions: new Map<string, Record<string, any>>(),
    inserts: [] as Array<Record<string, any>>,
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
  },
  supabase: {},
  affiliateSupabase: {
    from: (table: string) => {
      if (table === "promoters") {
        const node: any = {
          eq: () => node,
          // KOL lookup ends in .single(); agent lookup in .maybeSingle().
          single: async () => ({ data: state.promoter, error: null }),
          maybeSingle: async () => ({ data: state.agent, error: null }),
        };
        return { select: () => node };
      }
      if (table === "commissions") {
        return {
          select: () => {
            const filters: Record<string, string> = {};
            const node: any = {
              eq: (col: string, val: string) => {
                filters[col] = val;
                return node;
              },
              single: async () => {
                const row = state.commissions.get(filters.commission_type);
                return row
                  ? { data: row, error: null }
                  : { data: null, error: { code: "PGRST116", message: "no rows" } };
              },
            };
            return node;
          },
          insert: (row: Record<string, any>) => {
            state.inserts.push(row);
            const stored = { id: `c-${row.commission_type}`, ...row };
            state.commissions.set(row.commission_type, stored);
            return {
              select: () => ({
                single: async () => ({ data: stored, error: null }),
              }),
            };
          },
        };
      }
      throw new Error("unmocked table " + table);
    },
    rpc: async (fn: string) => {
      if (fn === "compute_agent_tier") return { data: [{ rate: 8 }], error: null };
      throw new Error("unmocked rpc " + fn);
    },
  },
  stripe: {},
}));

vi.mock("../fraud/fraud.service.js", () => ({
  checkSelfReferral: async () => ({ flagged: false }),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { attach } from "./orders.controller.js";

const ORDER_ID = "00000000-0000-0000-0000-0000000000aa";
const KOL_ID = "00000000-0000-0000-0000-0000000000b1";
const AGENT_ID = "00000000-0000-0000-0000-0000000000a9";

function makeReqRes() {
  const req: any = {
    body: {
      orderId: ORDER_ID,
      promoterId: KOL_ID,
      orderAmount: 20000,
      commissionType: "service",
      currency: "USD",
    },
  };
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

beforeEach(() => {
  state.promoter = {
    id: KOL_ID,
    commission_rate: 5,
    status: "active",
    recruited_by_agent_id: AGENT_ID,
  };
  state.agent = { commission_rate: 10, status: "active" };
  state.commissions = new Map();
  state.inserts = [];
});

describe("attach — lazy-attach idempotency", () => {
  it("first attach creates KOL + agent override commissions", async () => {
    const { req, res } = makeReqRes();
    await attach(req, res);
    expect(res.body.success).toBe(true);
    expect(state.inserts).toHaveLength(2);
    expect(state.inserts.map((i) => i.commission_type).sort()).toEqual(["agent_service", "service"]);
  });

  it("repeat attach of the same order returns existing rows, inserts nothing", async () => {
    // First attach — creates the rows.
    const first = makeReqRes();
    await attach(first.req, first.res);
    expect(first.res.body.success).toBe(true);
    expect(state.inserts).toHaveLength(2);
    const firstCommission = first.res.body.commission;
    const firstAgentCommission = first.res.body.agentCommission;

    // Repeat attach (lazy-attach fired again for the same orderId):
    // must be a 200 idempotent replay — same rows, zero new inserts.
    const second = makeReqRes();
    await attach(second.req, second.res);
    expect(second.res.statusCode).toBe(0); // no error status set; plain res.json
    expect(second.res.body.success).toBe(true);
    expect(second.res.body.commission.id).toBe(firstCommission.id);
    expect(second.res.body.agentCommission.id).toBe(firstAgentCommission.id);
    expect(state.inserts).toHaveLength(2); // unchanged — no duplicate rows
  });
});
