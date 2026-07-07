import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";

const CreatePromoterSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  country_code: z.string().optional(),
  primary_platform: z.string().optional(),
  primary_platform_url: z.string().url().optional(),
  brand_name: z.string().optional(),
  phone: z.string().optional(),
  bio: z.string().optional(),
});

export async function createPromoter(req: Request, res: Response) {
  const input = CreatePromoterSchema.parse(req.body);

  const { data, error } = await supabase.rpc("affiliate_create_promoter", {
    p_name: input.name,
    p_email: input.email,
    p_country_code: input.country_code || null,
    p_primary_platform: input.primary_platform || null,
    p_primary_platform_url: input.primary_platform_url || null,
    p_brand_name: input.brand_name || null,
    p_phone: input.phone || null,
    p_bio: input.bio || null,
  });

  if (error) {
    logger.error({ err: error }, "createPromoter failed");
    return res.status(500).json({ error: { code: "CREATE_FAILED", message: error.message } });
  }

  logger.info({ promoterId: data?.id, code: data?.code }, "promoter created");
  res.status(201).json(data);
}
