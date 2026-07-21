import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";

/**
 * KOL self-referral / affiliate fraud detection.
 *
 * Enforces Promoter Code of Conduct §3 (no self-referrals, no fake
 * conversions) and Commission Rules §6 (self-referrals void + manual
 * review) — previously unenforceable policy.
 *
 * Layers:
 *   L1 checkSelfReferral — runs synchronously at order attach: promoter
 *     email/phone == customer email/phone → attach blocked, flag raised.
 *   L2 scanRecentCommissions — nightly job: for already-attached
 *     commissions, matches order submission IP / customer contact against
 *     promoter contact + promoter registration IP (documents.signings).
 *
 * Flags land in affiliate.fraud_flags (status 'open'); commissions with
 * an open flag are excluded from payouts (payCommissions) until an admin
 * resolves the flag (dismiss → payable again; confirm → voided).
 */

export type FraudFlagType =
  | "self_referral_email"
  | "self_referral_phone"
  | "ip_match"
  | "manual";

export interface FraudCheckResult {
  flagged: boolean;
  flagType?: FraudFlagType;
  detail?: string;
}

/** Phone comparison on the trailing 11 digits (absorbs country-code and
 *  formatting differences); short numbers never match. */
function normalizePhone(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const digits = p.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-11) : null;
}

function normalizeEmail(e: unknown): string | null {
  if (typeof e !== "string") return null;
  const email = e.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

async function insertFlag(flag: {
  promoter_id: string;
  commission_id?: string | null;
  order_id?: string | null;
  flag_type: FraudFlagType;
  details?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from("affiliate.fraud_flags").insert({
    promoter_id: flag.promoter_id,
    commission_id: flag.commission_id ?? null,
    order_id: flag.order_id ?? null,
    flag_type: flag.flag_type,
    details: flag.details ?? {},
  });
  // 23505 = identical open flag already exists (detectors are idempotent).
  if (error && error.code !== "23505") {
    logger.error({ err: error, flag }, "failed to insert fraud flag");
  }
}

/** L1: promoter buying through their own referral link/code. */
export async function checkSelfReferral(
  promoterId: string,
  orderId: string,
): Promise<FraudCheckResult> {
  // public.orders carries the customer contact snapshot in user_info.
  const { data: orderRow, error: orderErr } = await supabase
    .schema("public")
    .from("orders")
    .select("user_info")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) {
    // Fail open (no flag) but log loudly — a broken detector must not
    // silently disable the control.
    logger.error({ err: orderErr, orderId }, "self-referral check: order lookup failed");
    return { flagged: false };
  }
  const userInfo = (orderRow?.user_info ?? {}) as Record<string, unknown>;
  const customerEmail = normalizeEmail(userInfo.email);
  const customerPhone = normalizePhone(userInfo.phone);
  if (!customerEmail && !customerPhone) return { flagged: false };

  const { data: promoter } = await supabase
    .from("affiliate.promoters")
    .select("email, phone")
    .eq("id", promoterId)
    .maybeSingle();
  if (!promoter) return { flagged: false };

  const promoterEmail = normalizeEmail(promoter.email);
  const promoterPhone = normalizePhone(promoter.phone);

  if (customerEmail && promoterEmail && customerEmail === promoterEmail) {
    await insertFlag({
      promoter_id: promoterId,
      order_id: orderId,
      flag_type: "self_referral_email",
      details: { matched: "email" },
    });
    logger.warn({ promoterId, orderId }, "self-referral blocked: promoter email == customer email");
    return { flagged: true, flagType: "self_referral_email", detail: "email" };
  }
  if (customerPhone && promoterPhone && customerPhone === promoterPhone) {
    await insertFlag({
      promoter_id: promoterId,
      order_id: orderId,
      flag_type: "self_referral_phone",
      details: { matched: "phone" },
    });
    logger.warn({ promoterId, orderId }, "self-referral blocked: promoter phone == customer phone");
    return { flagged: true, flagType: "self_referral_phone", detail: "phone" };
  }
  return { flagged: false };
}

/** Commission ids that currently have an OPEN fraud flag. */
export async function getOpenFlaggedCommissionIds(commissionIds: string[]): Promise<Set<string>> {
  if (commissionIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("affiliate.fraud_flags")
    .select("commission_id")
    .in("commission_id", commissionIds)
    .eq("status", "open");
  if (error) {
    // Fail CLOSED for payouts: if the flag store is unreadable, block the
    // batch rather than pay potentially fraudulent commissions.
    logger.error({ err: error }, "fraud flag lookup failed");
    return new Set(commissionIds);
  }
  return new Set((data ?? []).map((r) => r.commission_id as string));
}

interface ScanCommissionRow {
  id: string;
  promoter_id: string;
  order_id: string;
}

/**
 * L2: nightly scan of recent non-terminal commissions. Detects what L1
 * cannot (attaches that happened before L1 shipped, or cross-account
 * self-dealing via shared IP / registration IP).
 */
export async function scanRecentCommissions(daysBack = 90): Promise<number> {
  const since = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();
  const { data: commissions, error } = await supabase
    .from("commissions")
    .select("id, promoter_id, order_id")
    .in("status", ["pending", "cooling_down", "approved"])
    .gte("created_at", since)
    .limit(2000);
  if (error) {
    logger.error({ err: error }, "fraud scan: commission fetch failed");
    return 0;
  }
  let flagged = 0;

  for (const c of (commissions ?? []) as ScanCommissionRow[]) {
    // Skip commissions that already have an open flag (dedupe cheaply).
    const { data: existing } = await supabase
      .from("affiliate.fraud_flags")
      .select("id")
      .eq("commission_id", c.id)
      .eq("status", "open")
      .limit(1);
    if (existing && existing.length > 0) continue;

    const { data: orderRow } = await supabase
      .schema("public")
      .from("orders")
      .select("user_info, submission_ip")
      .eq("id", c.order_id)
      .maybeSingle();
    if (!orderRow) continue;
    const userInfo = (orderRow.user_info ?? {}) as Record<string, unknown>;
    const customerEmail = normalizeEmail(userInfo.email);
    const customerPhone = normalizePhone(userInfo.phone);
    const orderIp = typeof orderRow.submission_ip === "string" ? orderRow.submission_ip : null;

    const { data: promoter } = await supabase
      .from("affiliate.promoters")
      .select("email, phone")
      .eq("id", c.promoter_id)
      .maybeSingle();
    if (!promoter) continue;
    const promoterEmail = normalizeEmail(promoter.email);
    const promoterPhone = normalizePhone(promoter.phone);

    if (customerEmail && promoterEmail && customerEmail === promoterEmail) {
      await insertFlag({ promoter_id: c.promoter_id, commission_id: c.id, order_id: c.order_id, flag_type: "self_referral_email", details: { matched: "email", source: "nightly_scan" } });
      flagged++;
      continue;
    }
    if (customerPhone && promoterPhone && customerPhone === promoterPhone) {
      await insertFlag({ promoter_id: c.promoter_id, commission_id: c.id, order_id: c.order_id, flag_type: "self_referral_phone", details: { matched: "phone", source: "nightly_scan" } });
      flagged++;
      continue;
    }

    // IP match: order submitted from the same IP the promoter used at
    // registration (e-signature evidence IP in documents.signings).
    if (orderIp) {
      const { data: signings } = await supabase
        .schema("documents")
        .from("signings")
        .select("signed_ip")
        .eq("promoter_id", c.promoter_id)
        .eq("signed_ip", orderIp)
        .limit(1);
      if (signings && signings.length > 0) {
        await insertFlag({ promoter_id: c.promoter_id, commission_id: c.id, order_id: c.order_id, flag_type: "ip_match", details: { ip: orderIp, basis: "registration_signing_ip", source: "nightly_scan" } });
        flagged++;
      }
    }
  }

  if (flagged > 0) {
    logger.warn({ flagged, scanned: commissions?.length ?? 0 }, "fraud scan completed with new flags");
  } else {
    logger.info({ scanned: commissions?.length ?? 0 }, "fraud scan completed clean");
  }
  return flagged;
}
