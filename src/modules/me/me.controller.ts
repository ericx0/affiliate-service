import { Request, Response } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { supabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";

/**
 * GET /me/stats — 5 stat cards for the dashboard overview.
 */
export async function getMyStats(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_my_stats", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json(data ?? { totalPaid: 0, totalPending: 0, totalApproved: 0, totalClicks: 0, activeCodes: 0 });
}

/**
 * GET /me/earnings — paginated list of commission earnings with timeline.
 */
export async function getMyEarnings(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_my_earnings", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? [] });
}

/**
 * GET /me/codes — list of referral codes with computed click counts.
 */
export async function getMyCodes(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_my_codes", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? [] });
}

/**
 * GET /me/payouts — Stripe transfer history grouped by stripe_transfer_id.
 */
export async function getMyPayouts(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_my_payouts", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? [] });
}

/**
 * GET /me — promoter profile subset (name, email, country, platform).
 */
export async function getMe(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_me", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? null });
}

// Fields a KOL may update on their own profile. Email is deliberately
// excluded: kol-auth matches identity by auth_user_id / email — changing
// it would orphan the account (or hijack another promoter's row).
const UpdateMeSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    countryCode: z.string().min(2).max(10).optional(),
    primaryPlatform: z.string().min(1).max(50).optional(),
    primaryPlatformUrl: z.string().url().max(500).optional().or(z.literal("")),
  })
  .strict();

/**
 * PATCH /me (mounted as PATCH /api/affiliate/me) — update own profile.
 */
export async function updateMe(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const parsed = UpdateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: "Invalid profile fields" } });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.countryCode !== undefined) updates.country_code = parsed.data.countryCode;
  if (parsed.data.primaryPlatform !== undefined) updates.primary_platform = parsed.data.primaryPlatform;
  if (parsed.data.primaryPlatformUrl !== undefined) {
    updates.primary_platform_url = parsed.data.primaryPlatformUrl || null;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: { code: "NO_FIELDS", message: "No updatable fields provided" } });
    return;
  }

  const { data, error } = await supabase
    .from("affiliate.promoters")
    .update(updates)
    .eq("id", promoterId)
    .select("id, name, email, country_code, primary_platform, primary_platform_url")
    .single();
  if (error) {
    internalError(res, "UPDATE_FAILED", error);
    return;
  }

  res.json({
    data: {
      name: data.name,
      email: data.email,
      countryCode: data.country_code,
      primaryPlatform: data.primary_platform,
      primaryPlatformUrl: data.primary_platform_url,
    },
  });
}

// Cap on simultaneously active codes per promoter (anti-sprawl).
const MAX_ACTIVE_CODES = 10;

/**
 * POST /me/codes — generate a new referral code for the authenticated KOL.
 * Mirrors the code-generation loop in affiliate_self_register_promoter
 * (8 hex chars, retry on the UNIQUE(code) race).
 */
export async function createMyCode(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { count, error: countErr } = await supabase
    .from("affiliate.referral_codes")
    .select("id", { count: "exact", head: true })
    .eq("promoter_id", promoterId)
    .eq("is_active", true);
  if (countErr) {
    internalError(res, "QUERY_FAILED", countErr);
    return;
  }
  if ((count ?? 0) >= MAX_ACTIVE_CODES) {
    res.status(400).json({
      error: { code: "CODE_LIMIT", message: `Maximum ${MAX_ACTIVE_CODES} active codes reached` },
    });
    return;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    const { data, error } = await supabase
      .from("affiliate.referral_codes")
      .insert({ promoter_id: promoterId, code })
      .select("id, code, is_active, created_at")
      .single();
    if (!error && data) {
      // Same shape as affiliate_get_my_codes entries.
      res.status(201).json({
        data: {
          id: data.id,
          code: data.code,
          uses: 0,
          active: data.is_active,
          createdAt: data.created_at,
        },
      });
      return;
    }
    if (error && error.code !== "23505") {
      internalError(res, "INSERT_FAILED", error);
      return;
    }
  }
  internalError(res, "CODE_GEN_FAILED", new Error("could not generate a unique code after 10 attempts"));
}

const SubmitTaxFormSchema = z.object({
  form_type: z.enum(["W9", "W8BEN"]),
  signer_name: z.string().min(1).max(200),
  file_path: z.string().min(1).max(500),
});

/**
 * POST /me/tax-form - submit/upsert the KOL's tax form (W-9/W-8BEN) for
 * IRS compliance. The signed PDF is uploaded by the portal directly to
 * the private `tax-forms` storage bucket (RLS-scoped to the KOL's
 * auth_uid folder); this endpoint records the metadata in
 * affiliate.tax_forms. file_path must be in the caller's own folder
 * (prevents recording someone else's file). One row per promoter
 * (UNIQUE(promoter_id) + upsert = replace on re-submit).
 */
export async function submitMyTaxForm(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  const authUid = req.kolUser?.id;
  if (!promoterId || !authUid) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }
  const parsed = SubmitTaxFormSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
    return;
  }
  const { form_type, signer_name, file_path } = parsed.data;
  const ownPrefix = `${authUid}/`;
  if (!file_path.startsWith(ownPrefix) || file_path.includes("..")) {
    res.status(403).json({ error: { code: "FORBIDDEN_PATH", message: "file_path must be in your own storage folder" } });
    return;
  }

  // Verify the object actually exists in the private bucket. Without this,
  // a KOL could register a phantom path and pass the IRS payout gate
  // (payouts.service assertTaxFormSubmitted) with no real form on file.
  const lastSlash = file_path.lastIndexOf("/");
  const folder = file_path.slice(0, lastSlash);
  const fileName = file_path.slice(lastSlash + 1);
  const { data: objects, error: listErr } = await supabase.storage
    .from("tax-forms")
    .list(folder, { search: fileName });
  if (listErr) {
    internalError(res, "STORAGE_CHECK_FAILED", listErr);
    return;
  }
  if (!(objects ?? []).some((o) => o.name === fileName)) {
    res.status(400).json({
      error: { code: "FILE_NOT_FOUND", message: "Tax form file not found in storage. Upload the signed PDF first." },
    });
    return;
  }

  const { data, error } = await supabase
    .from("affiliate.tax_forms")
    .upsert(
      {
        promoter_id: promoterId,
        form_type,
        signer_name,
        file_path,
        status: "submitted",
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "promoter_id" },
    )
    .select("id, form_type, signer_name, status, submitted_at")
    .single();
  if (error) {
    internalError(res, "TAX_FORM_UPSERT_FAILED", error);
    return;
  }
  res.status(201).json({ data });
}

/**
 * GET /me/tax-form - the KOL's current tax form (or null if none submitted).
 */
export async function getMyTaxForm(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }
  const { data, error } = await supabase
    .from("affiliate.tax_forms")
    .select("id, form_type, signer_name, status, submitted_at, updated_at")
    .eq("promoter_id", promoterId)
    .maybeSingle();
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.status(200).json({ data: data ?? null });
}
