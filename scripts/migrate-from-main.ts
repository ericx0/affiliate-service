/**
 * One-time data migration from public.promoters / referral_codes / commissions
 * to affiliate.promoters / affiliate.referral_codes / affiliate.commissions
 *
 * Run AFTER all 7 migrations applied to affiliate schema.
 * Run BEFORE switching main-site to call affiliate-service.
 *
 * Usage: npx tsx scripts/migrate-from-main.ts
 */

import { supabase } from "../src/config.js";
import { logger } from "../src/utils/logger.js";

async function main() {
  console.log("Starting data migration from public to affiliate schema...");

  // 1. Migrate promoters
  console.log("\n[1/4] Migrating promoters...");
  const { data: publicPromoters, error: pErr } = await supabase
    .from("promoters")
    .select("*");

  if (pErr) throw pErr;

  let promoterCount = 0;
  for (const p of publicPromoters || []) {
    const { error: insertErr } = await supabase
      .from("promoters")
      .insert({
        name: p.name,
        email: p.email,
        phone: p.phone,
        brand_name: p.brand_name,
        bio: p.bio,
        commission_rate: p.commission_rate || 5.0,
        commission_type: p.commission_type || "standard",
        status: p.is_approved ? "active" : "suspended",
        stripe_account_id: p.stripe_account_id,
        stripe_onboarding_completed: p.stripe_onboarding_completed,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })
      .select()
      .single();

    if (!insertErr) promoterCount++;
  }
  console.log(`  ✅ Migrated ${promoterCount}/${publicPromoters?.length || 0} promoters`);

  // 2. Migrate referral_codes
  console.log("\n[2/4] Migrating referral_codes...");
  const { data: publicCodes, error: cErr } = await supabase
    .from("referral_codes")
    .select("*");

  if (cErr) throw cErr;

  let codeCount = 0;
  for (const c of publicCodes || []) {
    const { data: newPromoter } = await supabase
      .from("promoters")
      .select("id")
      .eq("email", publicPromoters?.find(p => p.id === c.promoter_id)?.email)
      .single();

    if (!newPromoter) continue;

    const { error: insertErr } = await supabase
      .from("referral_codes")
      .insert({
        promoter_id: newPromoter.id,
        code: c.code,
        type: c.type,
        custom_landing_slug: c.custom_landing_slug,
        custom_landing_enabled: c.custom_landing_enabled,
        is_active: c.is_active,
        created_at: c.created_at,
      });

    if (!insertErr) codeCount++;
  }
  console.log(`  ✅ Migrated ${codeCount}/${publicCodes?.length || 0} codes`);

  // 3. Migrate commissions
  console.log("\n[3/4] Migrating commissions...");
  const { data: publicCommissions, error: cmErr } = await supabase
    .from("commissions")
    .select("*");

  if (cmErr) throw cmErr;

  let commissionCount = 0;
  for (const c of publicCommissions || []) {
    const { data: newPromoter } = await supabase
      .from("promoters")
      .select("id")
      .eq("email", publicPromoters?.find(p => p.id === c.promoter_id)?.email)
      .single();

    if (!newPromoter) continue;

    // Map old status to new
    const statusMap: Record<string, string> = {
      pending: "cooling_down",  // new commissions start in cool-down
      approved: "approved",
      paid: "paid",
      refunded: "refunded",
      none: "cooling_down",
    };

    const { error: insertErr } = await supabase
      .from("commissions")
      .insert({
        promoter_id: newPromoter.id,
        order_id: c.order_id,
        commission_type: c.commission_type || "service",
        order_amount: c.order_amount,
        commission_rate: c.commission_rate,
        commission_amount: c.commission_amount,
        currency: c.currency || "USD",
        status: statusMap[c.commission_status] || "cooling_down",
        paid_at: c.paid_at,
        refunded_at: c.refunded_at,
        created_at: c.created_at,
        updated_at: c.updated_at,
      });

    if (!insertErr) commissionCount++;
  }
  console.log(`  ✅ Migrated ${commissionCount}/${publicCommissions?.length || 0} commissions`);

  // 4. Migrate referral_tracking → referral_clicks
  console.log("\n[4/4] Migrating referral_tracking → referral_clicks...");
  const { data: publicClicks, error: clkErr } = await supabase
    .from("referral_tracking")
    .select("*");

  if (clkErr) throw clkErr;

  let clickCount = 0;
  for (const clk of publicClicks || []) {
    const { data: newPromoter } = await supabase
      .from("promoters")
      .select("id")
      .eq("email", publicPromoters?.find(p => p.id === clk.promoter_id)?.email)
      .single();

    if (!newPromoter) continue;

    const windowEnd = new Date(clk.created_at);
    windowEnd.setDate(windowEnd.getDate() + 30);

    const { error: insertErr } = await supabase
      .from("referral_clicks")
      .insert({
        referral_code: clk.referral_code,
        promoter_id: newPromoter.id,
        visitor_session_id: clk.visitor_session_id || crypto.randomUUID(),
        ip_address: clk.ip_address,
        user_agent: clk.user_agent,
        clicked_at: clk.created_at,
        attribution_window_ends_at: windowEnd.toISOString(),
        converted_order_id: clk.order_id,
        converted_at: clk.converted_at,
      });

    if (!insertErr) clickCount++;
  }
  console.log(`  ✅ Migrated ${clickCount}/${publicClicks?.length || 0} clicks`);

  console.log("\n✅ Migration complete!");
  console.log("\nNext steps:");
  console.log("1. Run scripts/migration-verify.sql to confirm counts");
  console.log("2. Switch main-site linkchinamed-web/src/app/api/orders/create/route.ts to call affiliate-service");
  console.log("3. After 2 weeks of stable operation, DROP public.promoters / referral_codes / commissions / referral_tracking");
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});