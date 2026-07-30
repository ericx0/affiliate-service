import { Request, Response } from "express";
import { z } from "zod";
import { affiliateSupabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";
import { getOpenAIClient, env } from "../../config.js";
import { logger } from "../../utils/logger.js";

/**
 * GET /api/affiliate/clients?status=&q=
 *
 * Lists every client owned by the authenticated KOL. The portal uses
 * this to render the "My Clients" table; status / free-text search
 * filters match the same fields the schema exposes.
 */
const ListQuerySchema = z.object({
  status: z.enum(["lead", "engaged", "qualified", "converted", "inactive"]).optional(),
  q: z.string().min(1).max(100).optional(),
});

export async function listMyClients(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
    return;
  }

  let query = affiliateSupabase
    .from("clients")
    .select("id, display_name, contact_channel, contact_handle, status, country_code, age_range, health_concerns, family_history, budget_bracket, last_contact_at, next_follow_up_at, created_at")
    .eq("promoter_id", promoterId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (parsed.data.status) query = query.eq("status", parsed.data.status);
  if (parsed.data.q) query = query.ilike("display_name", `%${parsed.data.q}%`);

  const { data, error } = await query;
  if (error) {
    internalError(res, "CLIENTS_LIST_FAILED", error);
    return;
  }
  res.json({ data: (data ?? []).map(toClientDTO) });
}

/**
 * POST /api/affiliate/clients
 *
 * Creates a client for the authenticated KOL. The four SOP followup
 * tasks (Day 0/1/3/7) are auto-created by the trigger installed in
 * migration 017.
 *
 * `consent_verified` MUST be true — the KOL confirms the customer has
 * given explicit consent to be tracked in this system. Storing a
 * record without consent would violate GDPR / CCPA.
 */
const CreateClientSchema = z.object({
  display_name: z.string().min(1).max(120),
  contact_channel: z.string().min(1).max(40).optional(),
  contact_handle: z.string().min(1).max(200).optional(),
  country_code: z.string().min(2).max(10).optional(),
  age_range: z.enum(["0-17", "18-29", "30-44", "45-59", "60-74", "75+", "undisclosed"]).optional(),
  health_concerns: z.array(z.string().min(1).max(60)).max(20).optional(),
  family_history: z.string().max(500).optional(),
  budget_bracket: z.enum(["under_10k", "10k_25k", "25k_50k", "50k_100k", "over_100k", "undisclosed"]).optional(),
  consent_verified: z.literal(true),
}).strict();

export async function createMyClient(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }
  const parsed = CreateClientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
    return;
  }
  const row = parsed.data;
  const insertRow = {
    promoter_id: promoterId,
    display_name: row.display_name,
    contact_channel: row.contact_channel ?? null,
    contact_handle: row.contact_handle ?? null,
    country_code: row.country_code ?? null,
    age_range: row.age_range ?? null,
    health_concerns: row.health_concerns ?? [],
    family_history: row.family_history ?? null,
    budget_bracket: row.budget_bracket ?? null,
    status: "lead",
    next_follow_up_at: new Date(Date.now() + 86400 * 1000).toISOString(),
  };

  const { data, error } = await affiliateSupabase
    .from("clients")
    .insert(insertRow)
    .select("id, display_name, contact_channel, contact_handle, status, country_code, age_range, health_concerns, family_history, budget_bracket, last_contact_at, next_follow_up_at, created_at")
    .single();
  if (error) {
    internalError(res, "CLIENT_INSERT_FAILED", error);
    return;
  }

  // The trigger (migration 017) created 4 followup_tasks for this
  // client. Confirm by reading them back so the portal can show the
  // schedule summary inline. If the trigger failed silently the count
  // would be 0 — surface that as a soft warning, not an error.
  const { count: taskCount } = await affiliateSupabase
    .from("followup_tasks")
    .select("id", { count: "exact", head: true })
    .eq("client_id", data.id);

  res.status(201).json({
    data: toClientDTO(data),
    followup_tasks_created: taskCount ?? 0,
  });
}

/**
 * GET /api/affiliate/clients/:id
 * PATCH /api/affiliate/clients/:id
 *
 * Single-client read/update. The promoter_id filter on every query
 * enforces "KOL can only see/modify their own clients" — without it
 * the portal could leak by guessing UUIDs.
 */
const PatchClientSchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  contact_channel: z.string().min(1).max(40).optional(),
  contact_handle: z.string().min(1).max(200).optional(),
  country_code: z.string().min(2).max(10).optional(),
  age_range: z.enum(["0-17", "18-29", "30-44", "45-59", "60-74", "75+", "undisclosed"]).optional(),
  health_concerns: z.array(z.string().min(1).max(60)).max(20).optional(),
  family_history: z.string().max(500).optional(),
  budget_bracket: z.enum(["under_10k", "10k_25k", "25k_50k", "50k_100k", "over_100k", "undisclosed"]).optional(),
  status: z.enum(["lead", "engaged", "qualified", "converted", "inactive"]).optional(),
  notes: z.string().max(2000).optional(),
  next_follow_up_at: z.string().datetime().optional(),
}).strict();

export async function getMyClient(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }
  const { id } = req.params;
  if (!isUuid(id)) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid client id" } });
    return;
  }
  const { data, error } = await affiliateSupabase
    .from("clients")
    .select("id, display_name, contact_channel, contact_handle, status, country_code, age_range, health_concerns, family_history, budget_bracket, last_contact_at, next_follow_up_at, created_at, notes")
    .eq("id", id)
    .eq("promoter_id", promoterId)
    .maybeSingle();
  if (error) {
    internalError(res, "CLIENT_GET_FAILED", error);
    return;
  }
  if (!data) {
    // 404 for both "doesn't exist" and "exists but belongs to another
    // KOL" — we never leak the distinction (info disclosure).
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Client not found" } });
    return;
  }
  res.json({ data: toClientDTO(data) });
}

export async function patchMyClient(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }
  const { id } = req.params;
  if (!isUuid(id)) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid client id" } });
    return;
  }
  const parsed = PatchClientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: { code: "NO_FIELDS", message: "No updatable fields provided" } });
    return;
  }

  // Map camelCase -> snake_case for the partial update.
  const updates: Record<string, unknown> = {};
  const d = parsed.data;
  if (d.display_name !== undefined) updates.display_name = d.display_name;
  if (d.contact_channel !== undefined) updates.contact_channel = d.contact_channel;
  if (d.contact_handle !== undefined) updates.contact_handle = d.contact_handle;
  if (d.country_code !== undefined) updates.country_code = d.country_code;
  if (d.age_range !== undefined) updates.age_range = d.age_range;
  if (d.health_concerns !== undefined) updates.health_concerns = d.health_concerns;
  if (d.family_history !== undefined) updates.family_history = d.family_history;
  if (d.budget_bracket !== undefined) updates.budget_bracket = d.budget_bracket;
  if (d.status !== undefined) updates.status = d.status;
  if (d.notes !== undefined) updates.notes = d.notes;
  if (d.next_follow_up_at !== undefined) updates.next_follow_up_at = d.next_follow_up_at;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await affiliateSupabase
    .from("clients")
    .update(updates)
    .eq("id", id)
    .eq("promoter_id", promoterId)
    .select("id, display_name, contact_channel, contact_handle, status, country_code, age_range, health_concerns, family_history, budget_bracket, last_contact_at, next_follow_up_at, created_at, notes")
    .maybeSingle();
  if (error) {
    internalError(res, "CLIENT_UPDATE_FAILED", error);
    return;
  }
  if (!data) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Client not found" } });
    return;
  }
  res.json({ data: toClientDTO(data) });
}

const ContactSchema = z.object({
  channel: z.enum(["wechat", "whatsapp", "phone", "email", "sms", "in_person", "other"]),
  direction: z.enum(["outbound", "inbound"]),
  summary: z.string().min(1).max(500),
  script_id: z.string().uuid().optional(),
}).strict();

/**
 * POST /api/affiliate/clients/:id/contacts
 *
 * Records a contact touch between the KOL and a client, then asks
 * OpenAI (gpt-4o-mini) for a one-line next-step suggestion. If the
 * OpenAI key is missing or the call fails, we still persist the log —
 * `suggestions: null` is the documented graceful-degradation shape.
 */
export async function logMyContact(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }
  const { id } = req.params;
  if (!isUuid(id)) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid client id" } });
    return;
  }
  const parsed = ContactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
    return;
  }

  // Ownership check before INSERT — without this, a KOL could log a
  // contact against another KOL's client by guessing the UUID.
  const { data: owner, error: ownerErr } = await affiliateSupabase
    .from("clients")
    .select("id, display_name, status, promoter_id")
    .eq("id", id)
    .eq("promoter_id", promoterId)
    .maybeSingle();
  if (ownerErr) {
    internalError(res, "CLIENT_LOOKUP_FAILED", ownerErr);
    return;
  }
  if (!owner) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Client not found" } });
    return;
  }

  const now = new Date().toISOString();
  const { data: log, error: logErr } = await affiliateSupabase
    .from("contact_log")
    .insert({
      client_id: id,
      promoter_id: promoterId,
      channel: parsed.data.channel,
      direction: parsed.data.direction,
      summary: parsed.data.summary,
      script_id: parsed.data.script_id ?? null,
      occurred_at: now,
    })
    .select("id, channel, direction, summary, script_id, occurred_at, created_at")
    .single();
  if (logErr) {
    internalError(res, "CONTACT_LOG_INSERT_FAILED", logErr);
    return;
  }

  // Side effects (best-effort, never fail the request):
  //   - bump clients.last_contact_at
  //   - call OpenAI for next-step suggestion
  await affiliateSupabase
    .from("clients")
    .update({ last_contact_at: now, updated_at: now })
    .eq("id", id);

  const suggestions = await generateContactSuggestions({
    clientName: owner.display_name,
    channel: parsed.data.channel,
    direction: parsed.data.direction,
    summary: parsed.data.summary,
  });

  res.status(201).json({ data: { ...log, suggestions } });
}

interface ContactSuggestion { summary: string; next_step: string; rationale: string }

async function generateContactSuggestions(input: {
  clientName: string;
  channel: string;
  direction: string;
  summary: string;
}): Promise<ContactSuggestion[] | null> {
  const client = getOpenAIClient();
  if (!client) return null;
  try {
    const resp = await client.chat.completions.create({
      model: env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You are a coaching assistant for a healthcare KOL's customer relationship workflow. " +
            "Given a contact summary, suggest 1-3 next-step actions as compact JSON.",
        },
        {
          role: "user",
          content:
            `Client: ${input.clientName}\n` +
            `Channel: ${input.channel}\n` +
            `Direction: ${input.direction}\n` +
            `Summary: ${input.summary}\n\n` +
            `Return JSON: { "suggestions": [{ "summary": string, "next_step": string, "rationale": string }] }`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const content = resp.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { suggestions?: ContactSuggestion[] };
    return Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : null;
  } catch (err) {
    // Graceful degradation — never block the contact log on OpenAI.
    logger.warn({ err: (err as Error).message }, "openai contact-suggestions failed");
    return null;
  }
}

/* ----------------------------- helpers ----------------------------- */

interface ClientRow {
  id: string;
  display_name: string;
  contact_channel: string | null;
  contact_handle: string | null;
  status: string;
  country_code: string | null;
  age_range: string | null;
  health_concerns: string[] | null;
  family_history?: string | null;
  budget_bracket: string | null;
  last_contact_at: string | null;
  next_follow_up_at: string | null;
  created_at: string;
  notes?: string | null;
}

function toClientDTO(row: ClientRow) {
  return {
    id: row.id,
    display_name: row.display_name,
    contact_channel: row.contact_channel,
    contact_handle: row.contact_handle,
    status: row.status,
    country_code: row.country_code,
    age_range: row.age_range,
    health_concerns: row.health_concerns ?? [],
    family_history: row.family_history ?? null,
    budget_bracket: row.budget_bracket,
    next_follow_up_at: row.next_follow_up_at,
    last_contact_at: row.last_contact_at,
    created_at: row.created_at,
    notes: row.notes ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}