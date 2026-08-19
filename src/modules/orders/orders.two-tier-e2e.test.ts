/**
 * Phase 1.5 end-to-end test: prove the two-tier Agent/KOL split
 * produces TWO Stripe transfers per order (not one).
 *
 * Flow under test:
 *   1. Agent recruits KOL (recruited_by_agent_id)
 *   2. KOL drives a C-end customer order
 *   3. orders.controller.attach() creates two commission rows:
 *      - commission_type='service'      → promoter_id=KOL
 *      - commission_type='agent_service' → promoter_id=Agent
 *   4. 30-day cool-down elapses (state machine already tested separately)
 *   5. payouts.service.payCommissions() groups the two rows
 *      (different promoter_ids → 2 groups) and calls payPromoterGroup
 *      twice → 2 separate Stripe transfers
 *
 * This is the proof that "全切自动 开 Phase 1.5" actually wires end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    promoterRows: new Map<string, Record<string, any>>(),
    commissions: new Map<string, Record<string, any>>(),
    commissionInserts: [] as Array<Record<string, any>>,
    stripeTransfers: [] as Array<{ params: any; opts: any }>,
    commissionUpdates: [] as Array<{ id: string; payload: any }>,
    rpcResults: new Map<string, any>(),
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
    PORTAL_URL: "https://affiliate.linkchinamed.com",
    AGENT_PORTAL_URL: "https://agent.linkchinamed.com",
  },
  stripe: {
    transfers: {
      create: async (params: any, opts: any) => {
        state.stripeTransfers.push({ params, opts });
        return { id: `tr_test_${state.stripeTransfers.length}` };
      },
      createReversal: async () => ({ id: "rev_test" }),
    },
    accounts: { create: async () => ({ id: "acct_test" }) },
    accountLinks: { create: async () => ({ url: "https://stripe.test/x" }) },
  },
  supabase: {
    rpc: async () => ({ data: [], error: null }),
  },
  affiliateSupabase: {
    rpc: async (fn: string, _args: any) => {
      if (fn === "compute_agent_tier") {
        return { data: state.rpcResults.get("tier") ?? [{ rate: 5 }], error: null };
      }
      throw new Error("unmocked rpc " + fn);
    },
    from: (table: string) => {
      if (table === "promoters") {
        // Track all .eq() values so the terminal .maybeSingle()/.single()
        // can apply all filters. The controller's KOL lookup does
        //   .select().eq("id", promoterId).single()
        // and the Agent lookup does
        //   .select().eq("id", agentId).eq("role", "agent").maybeSingle()
        const node: any = { _filters: {} as Record<string, string> };
        node.select = () => node;
        node.eq = (col: string, val: string) => {
          node._filters[col] = val;
          return node;
        };
        node.maybeSingle = async () => {
          for (const [, row] of state.promoterRows.entries()) {
            const match = Object.entries(node._filters).every(([k, v]) => (row as any)[k] === v);
            if (match) return { data: row, error: null };
          }
          return { data: null, error: null };
        };
        node.single = async () => {
          for (const [, row] of state.promoterRows.entries()) {
            const match = Object.entries(node._filters).every(([k, v]) => (row as any)[k] === v);
            if (match) return { data: row, error: null };
          }
          return { data: null, error: null };
        };
        return node;
      }
      if (table === "commissions") {
        // Chainable select node. attachToOrder does .select().eq().eq().single()
        // (looking for existing commission by order_id + commission_type).
        // payCommissions does .select(...).in("id", ids).
        const selectNode: any = {};
        selectNode.in = async (_col: string, ids: string[]) => {
          const rows = ids
            .map((id) => state.commissions.get(id))
            .filter(Boolean);
          return { data: rows, error: null };
        };
        selectNode.eq = (_col: string, _val: string) => selectNode;
        selectNode.maybeSingle = async () => ({ data: null, error: null });
        selectNode.single = async () => ({ data: null, error: null });
        selectNode.is = (_col: string, _val: any) => selectNode;
        return {
          select: () => selectNode,
          // attachToOrder insert path
          insert: (row: Record<string, any>) => {
            state.commissionInserts.push(row);
            const id = `c_${state.commissionInserts.length}`;
            const stored = { id, ...row };
            state.commissions.set(id, stored);
            return {
              select: () => ({
                single: async () => ({ data: stored, error: null }),
              }),
            };
          },
          // Existing-commission check: attachToOrder does .select().eq().eq().single()
          update: (payload: any) => {
            // supabase-js chainable: every method returns a chain, only
            // .single() / .maybeSingle() return a Promise. async wrappers
            // on .in()/.eq() would yield a Promise where the consumer
            // expects a chain.
            const updateNode: any = {};
            updateNode.eq = (_col: string, val: string) => {
              const eqNode: any = {};
              eqNode.in = (_col2: string, _statuses: string[]) => {
                state.commissionUpdates.push({ id: val, payload });
                const chain: any = {};
                chain.select = () => chain;
                chain.single = async () => {
                  const c = state.commissions.get(val);
                  return { data: c ? { ...c, ...payload } : null, error: null };
                };
                return chain;
              };
              eqNode.is = () => ({ data: null, error: null });
              eqNode.select = () => ({
                single: async () => {
                  const c = state.commissions.get(val);
                  return { data: c ? { ...c, ...payload } : null, error: null };
                },
              });
              return eqNode;
            };
            return updateNode;
          },
        };
      }
      if (table === "tax_forms") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { status: "submitted" }, error: null }),
            }),
          }),
        };
      }
      if (table === "fraud_flags") {
        // No open fraud flags in this e2e test.
        const n: any = {};
        n.in = async () => ({ data: [], error: null });
        n.eq = () => n;
        return { select: () => n };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../notifications/notifications.service.js", () => ({
  notifyKolCommissionPending: async () => {},
  notifyKolCommissionReversed: async () => {},
  notifyKolDisputed: async () => {},
  notifyAdminDispute: async () => {},
  notifyAdminDisputeResolved: async () => {},
  notifyAdminDisputeReversalFailed: async () => {},
  notifyKolPayoutSent: async () => {},
  notifyKolPayoutFailed: async () => {},
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock("../fraud/fraud.service.js", () => ({
  checkSelfReferral: async () => ({ flagged: false }),
  getOpenFlaggedCommissionIds: async () => new Set(),
  scanRecentCommissions: async () => 0,
}));

import { attach } from "./orders.controller.js";
import { payCommissions } from "../payouts/payouts.service.js";

beforeEach(() => {
  state.promoterRows.clear();
  state.commissions.clear();
  state.commissionInserts = [];
  state.stripeTransfers = [];
  state.commissionUpdates = [];
  state.rpcResults.clear();
});

describe("Phase 1.5: Agent recruits KOL → KOL drives order → 2 payouts", () => {
  it("end-to-end: attach() creates 2 commission rows, payCommissions() makes 2 Stripe transfers", async () => {
    // Seed: Agent + KOL. KOL has recruited_by_agent_id pointing to Agent.
    state.promoterRows.set("agent-1", {
      id: "eaa8bd01-0000-4000-8000-00000000a001",
      email: "agent@example.com",
      name: "Agent One",
      role: "agent",
      status: "active",
      commission_rate: 5,
      stripe_account_id: "acct_agent",
      stripe_onboarding_completed: true,
    });
    state.promoterRows.set("kol-1", {
      id: "eaa8bd01-0000-4000-8000-00000000b001",
      email: "kol@example.com",
      name: "KOL One",
      role: "kol",
      status: "active",
      commission_rate: 10,
      recruited_by_agent_id: "eaa8bd01-0000-4000-8000-00000000a001",
      stripe_account_id: "acct_kol",
      stripe_onboarding_completed: true,
    });
    // compute_agent_tier returns 8% (Agent has ≥3 KOLs)
    state.rpcResults.set("tier", [{ rate: 8 }]);

    // --- Step 1: attach the order to the KOL ---
    const attachReq = {
      body: {
        orderId: "eaa8bd01-0000-4000-8000-000000000001",
        promoterId: "eaa8bd01-0000-4000-8000-00000000b001",
        commissionType: "service" as const,
        orderAmount: 100000, // $1000 — above $50 minimum payout threshold
        currency: "USD",
      },
    } as any;
    const attachRes = { status: () => attachRes, json: (x: any) => x } as any;
    await attach(attachReq, attachRes);

    // Assert: 2 commission rows inserted
    expect(state.commissionInserts).toHaveLength(2);

    const kolRow = state.commissionInserts.find(
      (r) => r.commission_type === "service",
    );
    const agentRow = state.commissionInserts.find(
      (r) => r.commission_type === "agent_service",
    );

    expect(kolRow).toMatchObject({
      promoter_id: "eaa8bd01-0000-4000-8000-00000000b001",
      commission_type: "service",
      order_amount: 100000,
      commission_rate: 10, // KOL's own rate
      currency: "USD",
      status: "pending",
    });
    // 100000 * 10% = 10000 cents
    expect(kolRow?.commission_amount).toBe(10000);

    expect(agentRow).toMatchObject({
      promoter_id: "eaa8bd01-0000-4000-8000-00000000a001", // DIFFERENT promoter_id (the Agent)
      commission_type: "agent_service",
      order_amount: 100000,
      commission_rate: 8, // tier rate from RPC, not stored 5
      currency: "USD",
      status: "pending",
    });
    expect(agentRow?.commission_amount).toBe(8000); // 100000 * 8% = 8000

    // --- Step 2: time passes; cool-down completes; commissions move to approved ---
    for (const row of state.commissions.values()) {
      row.status = "approved";
    }

    // --- Step 3: payCommissions processes both ---
    const commissionIds = Array.from(state.commissions.keys());
    const payoutResults = await payCommissions(commissionIds);

    // Assert: 2 successful payouts (one per promoter group)
    const successful = payoutResults.filter((r) => r.success);
    expect(successful).toHaveLength(2);

    // Assert: 2 separate Stripe transfers (not 1 combined)
    expect(state.stripeTransfers).toHaveLength(2);

    // Each transfer has its own idempotency key (different promoter)
    const idempotencyKeys = state.stripeTransfers.map((t) => t.opts.idempotencyKey);
    expect(new Set(idempotencyKeys).size).toBe(2);

    // Each transfer targets the correct Stripe Connect account
    const accounts = state.stripeTransfers.map((t) => t.params.destination);
    expect(accounts).toContain("acct_kol");
    expect(accounts).toContain("acct_agent");

    // Each transfer is the correct amount (KOL got $100, Agent got $80)
    const amounts = state.stripeTransfers
      .map((t) => t.params.amount)
      .sort((a, b) => a - b);
    expect(amounts).toEqual([8000, 10000]);
  });

  it("when KOL has no recruited_by_agent_id, only KOL commission is created (single payout)", async () => {
    // Seed: KOL only, no agent linkage
    state.promoterRows.set("kol-solo", {
      id: "eaa8bd02-0000-4000-8000-00000000b002",
      email: "kolsolo@example.com",
      name: "Solo KOL",
      role: "kol",
      status: "active",
      commission_rate: 10,
      recruited_by_agent_id: null,
      stripe_account_id: "acct_solo_kol",
      stripe_onboarding_completed: true,
    });

    const attachReq = {
      body: {
        orderId: "eaa8bd02-0000-4000-8000-000000000002",
        promoterId: "eaa8bd02-0000-4000-8000-00000000b002",
        commissionType: "service" as const,
        orderAmount: 100000, // $1000 → 10% = $100 above $50 min
        currency: "USD",
      },
    } as any;
    const attachRes = { status: () => attachRes, json: (x: any) => x } as any;
    await attach(attachReq, attachRes);

    // Only 1 commission row
    expect(state.commissionInserts).toHaveLength(1);
    expect(state.commissionInserts[0].commission_type).toBe("service");
    expect(state.commissionInserts[0].promoter_id).toBe("eaa8bd02-0000-4000-8000-00000000b002");

    // Approve and pay
    for (const row of state.commissions.values()) {
      row.status = "approved";
    }
    await payCommissions(Array.from(state.commissions.keys()));

    // 1 Stripe transfer
    expect(state.stripeTransfers).toHaveLength(1);
    expect(state.stripeTransfers[0].params.destination).toBe("acct_solo_kol");
  });
});