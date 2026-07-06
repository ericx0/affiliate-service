import { describe, it, expect, beforeEach } from "vitest";
import { supabase } from "../../src/config.js";
import {
  attachToOrder,
  transition,
  approveExpiredCooldowns,
} from "../../src/modules/commissions/commissions.service.js";

/**
 * Integration test: full commission lifecycle against a live Supabase instance.
 *
 * REQUIRES:
 *   - Live Supabase project with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
 *   - All 8 migrations applied (001..008 — see src/db/migrations/).
 *
 * Skipped automatically when SUPABASE_URL is the placeholder set in vitest.config.ts.
 */

const PLACEHOLDER_SUPABASE_HOST = "placeholder.supabase.co";

const isLiveSupabase = !process.env.SUPABASE_URL?.includes(PLACEHOLDER_SUPABASE_HOST);

const describeIntegration = isLiveSupabase ? describe : describe.skip;

describeIntegration("commission lifecycle (integration)", () => {
  let testPromoterId: string;
  const testOrderId = "11111111-1111-1111-1111-111111111111";

  beforeEach(async () => {
    // Clean up previous test data
    await supabase.from("commissions").delete().eq("order_id", testOrderId);
    await supabase.from("promoters").delete().like("email", "lifecycle-test-%");

    // Create test promoter
    const { data } = await supabase
      .from("promoters")
      .insert({
        name: "Lifecycle Test",
        email: `lifecycle-test-${Date.now()}@example.com`,
        commission_rate: 5.0,
        status: "active",
      })
      .select()
      .single();
    testPromoterId = data!.id;
  });

  it("full happy path: attach -> paid -> completed -> cool-down -> approved", async () => {
    // 1. Attach
    const attachResult = await attachToOrder({
      promoterId: testPromoterId,
      orderId: testOrderId,
      commissionType: "service",
      orderAmount: 1000,
      commissionRate: 5,
    });
    expect(attachResult.success).toBe(true);
    expect(attachResult.commission!.status).toBe("pending");
    expect(attachResult.commission!.commission_amount).toBe(50);

    // 2. Mark order paid (raw update; transition() doesn't have pending->paid in the state machine)
    await supabase
      .from("commissions")
      .update({ order_paid_at: new Date().toISOString() })
      .eq("id", attachResult.commission!.id);

    // 3. Mark order completed (transitions to cooling_down with 7d timer)
    const completedResult = await transition(attachResult.commission!.id, "cooling_down", {
      service_completed_at: new Date().toISOString(),
    });
    expect(completedResult.success).toBe(true);
    expect(completedResult.commission!.status).toBe("cooling_down");
    expect(completedResult.commission!.cool_down_until).toBeTruthy();

    // 4. Force cool-down to expire (simulate 7 days passing)
    await supabase
      .from("commissions")
      .update({ cool_down_until: new Date(Date.now() - 1000).toISOString() })
      .eq("id", attachResult.commission!.id);

    // 5. Run approval job
    const approved = await approveExpiredCooldowns();
    expect(approved).toBeGreaterThan(0);

    // 6. Verify status is now approved
    const { data: final } = await supabase
      .from("commissions")
      .select("status, approved_at")
      .eq("id", attachResult.commission!.id)
      .single();
    expect(final!.status).toBe("approved");
    expect(final!.approved_at).toBeTruthy();
  });

  it("refund during cool-down transitions to refunded", async () => {
    const attachResult = await attachToOrder({
      promoterId: testPromoterId,
      orderId: testOrderId,
      commissionType: "service",
      orderAmount: 500,
      commissionRate: 5,
    });

    await transition(attachResult.commission!.id, "cooling_down", {
      service_completed_at: new Date().toISOString(),
    });

    // Refund
    const refundResult = await transition(attachResult.commission!.id, "refunded", {
      refund_reason: "Customer changed mind",
    });
    expect(refundResult.success).toBe(true);
    expect(refundResult.commission!.status).toBe("refunded");
  });

  it("rejects invalid state transitions", async () => {
    const attachResult = await attachToOrder({
      promoterId: testPromoterId,
      orderId: testOrderId,
      commissionType: "service",
      orderAmount: 100,
      commissionRate: 5,
    });

    // pending -> paid is INVALID (must go through cooling_down -> approved)
    const invalidResult = await transition(attachResult.commission!.id, "paid");
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.error).toContain("Cannot transition");
  });
});