import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupCommissionsByPromoter, MINIMUM_PAYOUT_AMOUNT, exceedsMinimum } from "./payouts.helpers.js";

// Mock the supabase and stripe imports so we can drive payPromoterGroup
// without hitting real services. We use vi.hoisted to expose shared state.
const mockState = vi.hoisted(() => ({
  stripeTransfersCreate: vi.fn(),
  stripeTransfersCreateReversal: vi.fn(),
  promoterById: new Map<string, any>(),
  transitionResult: { success: true, commission: { id: "x" } as any },
  transitions: [] as Array<{ id: string; to: string; metadata: any }>,
  taxFormStatus: "submitted" as string | null,
  affiliateFromCalls: [] as string[],
  // Task 3 (gate 6): mock state for the `commissions` table.
  commissionsById: new Map<string, any>(),
  commissionUpdates: [] as Array<{ id: string; payload: any }>,
  // Task 3 (resolveDispute): captured audit log calls.
  auditLogs: [] as Array<{ action: string; actorId: string; actorEmail: string; targetId: string; afterState?: any; reason?: string }>,
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
  },
  stripe: {
    transfers: {
      create: (...args: any[]) => mockState.stripeTransfersCreate(...args),
      createReversal: (...args: any[]) => mockState.stripeTransfersCreateReversal(...args),
    },
  },
  // The public-schema client must NOT be used for affiliate.* tables.
  // Any accidental regression to `supabase.from(...)` throws here.
  supabase: {
    from: (table: string) => {
      throw new Error("public client must not query affiliate tables: " + table);
    },
  },
  // payouts.service.ts queries affiliate.* tables (promoters, tax_forms,
  // commissions) via this schema-scoped client with unprefixed table names.
  affiliateSupabase: {
    from: (table: string) => {
      mockState.affiliateFromCalls.push(table);
      if (table === "promoters") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              single: async () => {
                const p = mockState.promoterById.get(val);
                if (!p) return { data: null, error: { message: "not found" } };
                return { data: p, error: null };
              },
            }),
          }),
        };
      }
      if (table === "tax_forms") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                mockState.taxFormStatus
                  ? { data: { status: mockState.taxFormStatus }, error: null }
                  : { data: null, error: null },
            }),
          }),
        };
      }
      if (table === "commissions") {
        return {
          select: () => ({
            // payCommissions: .select(...).in("id", commissionIds)
            // payPromoterGroup race-defense re-fetch: .select("id, status").in("id", commissionIds)
            // (both share the same chain shape: select().in(...))
            in: async (_col: string, vals: string[]) => {
              const rows = vals.map((id) => {
                const seeded = mockState.commissionsById.get(id);
                if (seeded) return seeded;
                // Default: a fully-populated approved commission matching
                // the existing test fixtures (p1, USD, 100 cents).
                return {
                  id,
                  promoter_id: "p1",
                  commission_amount: 100,
                  currency: "USD",
                  status: "approved",
                  promoters: { stripe_account_id: "acct_1", stripe_onboarding_completed: true },
                };
              });
              return { data: rows, error: null };
            },
            // resolveDispute: .select("id, status, dispute_id").eq("id", commissionId).maybeSingle()
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => {
                const row = mockState.commissionsById.get(val);
                return { data: row ?? null, error: null };
              },
            }),
          }),
          // resolveDispute: .update({...}).eq("id", commissionId)
          update: (payload: any) => ({
            eq: async (_col: string, val: string) => {
              mockState.commissionUpdates.push({ id: val, payload });
              return { error: null };
            },
          }),
        };
      }
      if (table === "fraud_flags") {
        // getOpenFlaggedCommissionIds: .select("commission_id").in("commission_id", ids).eq("status", "open")
        return {
          select: () => ({
            in: (_col: string, _vals: string[]) => ({
              eq: async (_col2: string, _val: string) => ({ data: [], error: null }),
            }),
          }),
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../commissions/commissions.service.js", () => ({
  transition: async (id: string, to: string, metadata: any) => {
    mockState.transitions.push({ id, to, metadata });
    return mockState.transitionResult;
  },
}));

vi.mock("../admin/audit.service.js", () => ({
  writeAuditLog: async (input: any) => {
    mockState.auditLogs.push(input);
    return true;
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { payPromoterGroup, payCommissions, resolveDispute } from "./payouts.service.js";

beforeEach(() => {
  mockState.stripeTransfersCreate.mockReset();
  mockState.stripeTransfersCreateReversal.mockReset();
  mockState.promoterById.clear();
  mockState.transitions = [];
  mockState.taxFormStatus = "submitted";
  mockState.affiliateFromCalls = [];
  mockState.commissionsById.clear();
  mockState.commissionUpdates = [];
  mockState.auditLogs = [];
  mockState.promoterById.set("p1", {
    stripe_account_id: "acct_1",
    stripe_onboarding_completed: true,
  });
  mockState.stripeTransfersCreate.mockResolvedValue({ id: "tr_123" });
});

describe("payPromoterGroup — schema client regression", () => {
  it("queries promoters via the affiliate-schema client, not the public one", async () => {
    // Regression: payPromoterGroup previously used the public-schema
    // `supabase` client for affiliate.promoters — in prod that table does
    // not exist in `public`, so the monthly batch would find no rows.
    // The public client's from() throws in this mock, and we assert the
    // lookup actually went through affiliateSupabase.
    const result = await payPromoterGroup("p1", "USD", ["c1"], 4000);
    expect(result.success).toBe(true);
    expect(mockState.affiliateFromCalls).toContain("promoters");
  });
});

describe("payPromoterGroup — F29 regression", () => {
  it("creates ONE transfer for the group total (not per commission)", async () => {
    const result = await payPromoterGroup(
      "p1",
      "USD",
      ["c1", "c2", "c3"],
      24000, // group total in cents
    );
    expect(result.success).toBe(true);
    expect(mockState.stripeTransfersCreate).toHaveBeenCalledTimes(1);
    const [args, opts] = mockState.stripeTransfersCreate.mock.calls[0];
    expect(args.amount).toBe(24000); // cents (no *100)
    expect(args.destination).toBe("acct_1");
    expect(args.metadata.commissionIds).toBe("c1,c2,c3");
    expect(args.metadata.promoterId).toBe("p1");
    expect(opts.idempotencyKey).toContain("group-payout-p1-USD-");
  });

  it("transitions EVERY commission in the group to paid", async () => {
    await payPromoterGroup("p1", "USD", ["c1", "c2", "c3"], 24000);
    expect(mockState.transitions.length).toBe(3);
    expect(mockState.transitions.map((t) => t.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(mockState.transitions.every((t) => t.to === "paid")).toBe(true);
  });

  it("uses the same transfer id on all commission transitions", async () => {
    await payPromoterGroup("p1", "USD", ["c1", "c2"], 8000);
    const transferIds = new Set(mockState.transitions.map((t) => t.metadata.stripe_transfer_id));
    expect(transferIds.size).toBe(1);
    expect(transferIds.has("tr_123")).toBe(true);
  });

  it("is idempotent: same commission set => same idempotency key", async () => {
    await payPromoterGroup("p1", "USD", ["c2", "c1"], 8000);
    const key1 = mockState.stripeTransfersCreate.mock.calls[0][1].idempotencyKey;
    mockState.stripeTransfersCreate.mockClear();
    await payPromoterGroup("p1", "USD", ["c1", "c2"], 8000);
    const key2 = mockState.stripeTransfersCreate.mock.calls[0][1].idempotencyKey;
    expect(key1).toBe(key2);
  });

  it("different commission set => different idempotency key", async () => {
    await payPromoterGroup("p1", "USD", ["c1"], 4000);
    const key1 = mockState.stripeTransfersCreate.mock.calls[0][1].idempotencyKey;
    mockState.stripeTransfersCreate.mockClear();
    await payPromoterGroup("p1", "USD", ["c1", "c2"], 8000);
    const key2 = mockState.stripeTransfersCreate.mock.calls[0][1].idempotencyKey;
    expect(key1).not.toBe(key2);
  });

  it("refuses promoter without Stripe Connect setup", async () => {
    mockState.promoterById.set("p2", {
      stripe_account_id: null,
      stripe_onboarding_completed: false,
    });
    const result = await payPromoterGroup("p2", "USD", ["c1"], 4000);
    expect(result.success).toBe(false);
    expect(mockState.stripeTransfersCreate).not.toHaveBeenCalled();
  });

  it("refuses promoter without a submitted tax form (IRS gate)", async () => {
    mockState.taxFormStatus = null;
    const result = await payPromoterGroup("p1", "USD", ["c1"], 8000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/tax form/i);
    expect(mockState.stripeTransfersCreate).not.toHaveBeenCalled();
  });

  it("passes integer cents through unchanged", async () => {
    await payPromoterGroup("p1", "USD", ["c1", "c2"], 10000);
    expect(mockState.stripeTransfersCreate.mock.calls[0][0].amount).toBe(10000);
  });
});

describe("groupCommissionsByPromoter", () => {
  it("groups approved commissions by promoter_id + currency (amounts in cents)", () => {
    const commissions = [
      { id: "c1", promoter_id: "p1", commission_amount: 5000, currency: "USD" },
      { id: "c2", promoter_id: "p1", commission_amount: 3000, currency: "USD" },
      { id: "c3", promoter_id: "p2", commission_amount: 10000, currency: "USD" },
    ];
    const groups = groupCommissionsByPromoter(commissions as any);
    expect(groups.size).toBe(2);
    expect(groups.get("p1:USD")?.total).toBe(8000);
    expect(groups.get("p2:USD")?.total).toBe(10000);
    expect(groups.get("p1:USD")?.commissionIds).toEqual(["c1", "c2"]);
  });

  it("handles different currencies separately", () => {
    const commissions = [
      { id: "c1", promoter_id: "p1", commission_amount: 5000, currency: "USD" },
      { id: "c2", promoter_id: "p1", commission_amount: 3000, currency: "EUR" },
    ];
    const groups = groupCommissionsByPromoter(commissions as any);
    // Separate groups per currency — the EUR amount must NOT be folded into
    // the USD transfer (that was the pre-fix bug).
    expect(groups.size).toBe(2);
    expect(groups.get("p1:USD")?.total).toBe(5000);
    expect(groups.get("p1:EUR")?.total).toBe(3000);
  });
});

describe("exceedsMinimum", () => {
  it("USD $50 threshold (amounts in cents)", () => {
    expect(exceedsMinimum(5000, "USD")).toBe(true);
    expect(exceedsMinimum(4999, "USD")).toBe(false);
  });
  it("non-USD uses approximate $50 equivalents (policy: $50 or equivalent)", () => {
    expect(exceedsMinimum(4600, "EUR")).toBe(true);
    expect(exceedsMinimum(4599, "EUR")).toBe(false);
    expect(exceedsMinimum(4000, "GBP")).toBe(true);
    expect(exceedsMinimum(7500, "JPY")).toBe(true);
    expect(exceedsMinimum(1, "EUR")).toBe(false);
  });
  it("unknown currency conservatively requires 5000 minor units", () => {
    expect(exceedsMinimum(5000, "CHF")).toBe(true);
    expect(exceedsMinimum(4999, "CHF")).toBe(false);
  });
});

describe("MINIMUM_PAYOUT_AMOUNT", () => {
  it("is $50 in cents", () => {
    expect(MINIMUM_PAYOUT_AMOUNT).toBe(5000);
  });
});

// ============================================================
// Task 3 — Gate 6: payCommissions / payPromoterGroup must NEVER
// pay disputed commissions. Two layers of defense:
//   Layer A: SELECT-all + JS-side filter in payCommissions (already-
//            disputed rows → reported as error).
//   Layer B: re-fetch inside payPromoterGroup right before the Stripe
//            transfer → race-condition defense (webhook flipped status
//            between SELECT and transfer).
// ============================================================

describe("payCommissions — gate 6 (Task 3) Layer A: already-disputed rows", () => {
  it("reports disputed commissions as errors with a 'dispute' message and never includes them in the payout", async () => {
    // Need to flip commission_amounts so the approved row is above the
    // $50 minimum and gets paid; the disputed row should be reported
    // separately regardless of amount.
    mockState.commissionsById = new Map<string, any>([
      ["c_ok", {
        id: "c_ok", promoter_id: "p1", commission_amount: 5000, currency: "USD",
        status: "approved",
        promoters: { stripe_account_id: "acct_1", stripe_onboarding_completed: true },
      }],
      ["c_dp", {
        id: "c_dp", promoter_id: "p1", commission_amount: 200, currency: "USD",
        status: "disputed",
        promoters: { stripe_account_id: "acct_1", stripe_onboarding_completed: true },
      }],
    ]);

    const result = await payCommissions(["c_ok", "c_dp"]);

    const okResult = result.find((r) => r.commissionIds?.includes("c_ok"));
    const dpResult = result.find((r) => r.commissionIds?.includes("c_dp"));

    // c_ok is approved → paid successfully (single Stripe transfer).
    expect(okResult?.success).toBe(true);
    // c_dp is disputed → reported as a withheld error mentioning "dispute".
    expect(dpResult).toBeDefined();
    expect(dpResult?.success).toBe(false);
    expect(dpResult?.error).toMatch(/dispute/i);
    // Only ONE Stripe transfer for the approved group; the disputed row
    // never made it into any transfer.
    expect(mockState.stripeTransfersCreate).toHaveBeenCalledTimes(1);
    // The transition() mock saw exactly one transition (for c_ok).
    expect(mockState.transitions.map((t) => t.id)).toEqual(["c_ok"]);
  });
});

describe("payPromoterGroup — gate 6 (Task 3) Layer B: race-condition defense", () => {
  it("skips the entire group if a commission became disputed after the SELECT (no transfer made)", async () => {
    // Simulates the race: SELECT in payCommissions saw c1 as approved,
    // but by the time payPromoterGroup re-fetches, charge.dispute.created
    // has flipped c1 to status='disputed'. The re-fetch must catch this
    // and refuse to make the Stripe transfer.
    mockState.commissionsById = new Map<string, any>([
      ["c1", {
        id: "c1", promoter_id: "p1", commission_amount: 5000, currency: "USD",
        status: "disputed",
      }],
    ]);

    const result = await payPromoterGroup("p1", "USD", ["c1"], 5000);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/dispute/i);
    // No Stripe transfer was attempted.
    expect(mockState.stripeTransfersCreate).not.toHaveBeenCalled();
    // No transition() calls — the dispute guard fired before any DB writes.
    expect(mockState.transitions).toHaveLength(0);
  });
});

// ============================================================
// Task 3 — resolveDispute(): admin manual dispute resolution.
// Admin path is BINARY: won → approved, lost → voided.
// Stripe transfer reversal is the webhook's job (lost + wasPaid path),
// NOT this endpoint. Admin endpoint is for STUCK / OVERRIDE cases.
// ============================================================

describe("resolveDispute — admin manual resolution (Task 3)", () => {
  it("admin 'won' transitions disputed → approved, sets dispute_status='won', and writes audit log", async () => {
    mockState.commissionsById = new Map<string, any>([
      ["c1", { id: "c1", status: "disputed", dispute_id: "dp_1" }],
    ]);

    const result = await resolveDispute("c1", "won", "evidence accepted", "admin_1", "ops@example.com");

    expect(result.success).toBe(true);
    // Verify the UPDATE payload.
    const update = mockState.commissionUpdates.find((u) => u.id === "c1");
    expect(update?.payload.status).toBe("approved");
    expect(update?.payload.dispute_status).toBe("won");
    expect(update?.payload.dispute_closed_at).toEqual(expect.any(String));
    // disney: when won, disputed_at is left as-is (historical record)
    // (matches the webhook's won-path in stripe-webhook.controller.ts).
    // Verify audit log.
    const audit = mockState.auditLogs.find((l) => l.action === "commission_dispute_resolve");
    expect(audit).toBeDefined();
    expect(audit?.actorId).toBe("admin_1");
    expect(audit?.actorEmail).toBe("ops@example.com");
    expect(audit?.targetId).toBe("c1");
    expect(audit?.reason).toMatch(/evidence accepted/);
  });

  it("admin 'lost' transitions disputed → voided (NOT reversed, even if paid_at was set)", async () => {
    // Critical: admin path must NOT call stripe.transfers.createReversal.
    // The webhook handles lost + wasPaid; admin endpoint is for stuck
    // disputes. Reverse path would be a separate bug.
    mockState.commissionsById = new Map<string, any>([
      ["c1", { id: "c1", status: "disputed", dispute_id: "dp_1", paid_at: "2026-08-01T00:00:00Z" }],
    ]);

    const result = await resolveDispute("c1", "lost", undefined, "admin_1", "ops@example.com");

    expect(result.success).toBe(true);
    const update = mockState.commissionUpdates.find((u) => u.id === "c1");
    expect(update?.payload.status).toBe("voided");
    expect(update?.payload.dispute_status).toBe("lost");
    // NO Stripe transfer reversal call from admin endpoint.
    expect(mockState.stripeTransfersCreateReversal).not.toHaveBeenCalled();
    // Note: disputed_at is cleared on lost (finalized).
    expect(update?.payload.disputed_at).toBeNull();
  });

  it("returns COMMISSION_NOT_DISPUTED when current status !== 'disputed'", async () => {
    mockState.commissionsById = new Map<string, any>([
      ["c1", { id: "c1", status: "approved", dispute_id: null }],
    ]);

    const result = await resolveDispute("c1", "won", undefined, "admin_1", "ops@example.com");

    expect(result.success).toBe(false);
    expect(result.error).toBe("COMMISSION_NOT_DISPUTED");
    // No UPDATE was issued.
    expect(mockState.commissionUpdates).toHaveLength(0);
  });

  it("returns COMMISSION_NOT_FOUND when the commission id does not exist", async () => {
    // Empty commissionsById → resolveDispute's maybeSingle returns null.
    const result = await resolveDispute("missing", "won", undefined, "admin_1", "ops@example.com");

    expect(result.success).toBe(false);
    expect(result.error).toBe("COMMISSION_NOT_FOUND");
  });
});
