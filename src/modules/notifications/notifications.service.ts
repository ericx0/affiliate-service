import { env } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { supabase, affiliateSupabase } from "../../config.js";
import { writeAuditLog } from "../admin/audit.service.js";
import { dashboardUrlFor } from "../portal-urls.js";

type SupportedLocale = "en" | "zh" | "ar" | "ru" | "es";

/**
 * Email notifications via Resend (REST API, no SDK dependency).
 *
 * If RESEND_API_KEY is unset, all notifications silently skip (the service
 * still runs). Set RESEND_API_KEY + ADMIN_NOTIFY_EMAIL in the Vercel env to
 * enable. Never throws - notifications are best-effort (must not block the
 * business flow that triggered them).
 */

const FROM =
  env.MAIL_FROM || "LinkChinaMed Affiliate <noreply@linkchinamed.com>";

async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    logger.debug({ to: opts.to }, "RESEND_API_KEY not set; skipping email");
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      logger.error(
        { status: res.status, body: await res.text().catch(() => "") },
        "Resend email failed",
      );
      return false;
    }
    return true;
  } catch (e) {
    logger.error({ error: (e as Error).message }, "sendEmail threw");
    return false;
  }
}

// 3 attempts with 4^n × 1000ms backoff (1s, 4s, 16s).
// ponytail: no backoff lib — the helper is a 10-line for-loop. Upgrade
// to a real jittered backoff if traffic ever makes a thundering-herd
// retry burst observable.
async function sendEmailWithRetry(
  opts: { to: string; subject: string; html: string },
  maxAttempts = 3,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await sendEmail(opts)) return true;
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, Math.pow(4, attempt - 1) * 1000));
    }
  }
  return false;
}

async function notifyAdmin(subject: string, html: string): Promise<void> {
  if (!env.ADMIN_NOTIFY_EMAIL) return;
  await sendEmail({ to: env.ADMIN_NOTIFY_EMAIL, subject, html });
}

async function notifyKol(
  email: string,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!email) return false;
  return sendEmail({ to: email, subject, html });
}

// ---- Templated notifications (business events) ----

export async function notifyAdminNewKol(kol: {
  name: string;
  email: string;
  code: string;
}): Promise<void> {
  await notifyAdmin(
    `[Affiliate] New KOL registration: ${kol.name}`,
    `<h2>New KOL registered</h2>
     <ul>
       <li><b>Name:</b> ${escapeHtml(kol.name)}</li>
       <li><b>Email:</b> ${escapeHtml(kol.email)}</li>
       <li><b>Referral code:</b> ${escapeHtml(kol.code)}</li>
     </ul>
     <p>Review at <a href="https://affiliate.linkchinamed.com/admin">affiliate.linkchinamed.com/admin</a></p>`,
  );
}

/**
 * Read a published template row from affiliate.email_templates. Returns
 * null on any failure (network, missing row, RLS hiccup) so callers can
 * fall back gracefully — notifications are best-effort by design.
 */
async function fetchTemplate(
  category: string,
  language: SupportedLocale,
): Promise<{ id: string; subject: string; body: string } | null> {
  const { data } = await affiliateSupabase
    .from("email_templates" as never)
    .select("id, subject, body")
    .eq("category", category)
    .eq("language", language)
    .eq("is_published", true)
    .maybeSingle();
  return (data as { id: string; subject: string; body: string } | null) ?? null;
}

/**
 * Replace `{{key}}` placeholders. Unknown keys are left as `{{key}}` so
 * copy reviewers spot gaps immediately instead of silently rendering "".
 */
function substitute(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (_m, key: string) =>
    ctx[key] !== undefined ? ctx[key] : `{{${key}}}`,
  );
}

type TemplatedCategory =
  | "commission_pending"
  | "commission_reversed"
  | "commission_paid"
  | "commission_disputed"
  | "payout_sent"
  | "payout_failed"
  | "new_referral";

interface TemplatedCtx {
  email: string;
  name?: string;
  promoterId?: string;
  // R1 final review Fix 1: accept either number (cents or already-converted
  // dollars from older callers) or pre-formatted USD string from the webhook
  // boundary. Number(...).toFixed(2) normalizes both to a 2-decimal string.
  amount?: number | string;
  currency?: string;
  orderId?: string;
  reason?: string;
  // Task 4: commission_disputed placeholders. {{commission_id}} shortens
  // to first 8 chars at template level; {{dispute_reason}} is the raw
  // Stripe dispute.reason string (e.g. "fraudulent").
  commissionId?: string;
  disputeReason?: string;
  // F-NEW-11: role drives {{dashboard_url}} substitution. Defaults to
  // "kol" so older callers that don't pass it still get a working URL.
  role?: "kol" | "agent";
}

/**
 * Shared send path for the db-templated KOL notifications. Reads the
 * per-promoter notification_prefs opt-out map; if the category key is
 * explicitly `false`, returns {sent: false, skipped: 'opt_out'}. Looks
 * up the published template for the promoter's preferred_locale,
 * substitutes {{key}} placeholders, retries the Resend call up to 3
 * times, and records the outcome in affiliate_email_sends + audit_logs.
 *
 * Best-effort end-to-end: every failure is swallowed (logged + recorded
 * in affiliate_email_sends.last_error) so the calling business flow
 * (commission transition / payout / referral signup) is never blocked.
 *
 * ponytail: 1 helper for 5 wrappers. fetchTemplate is intentionally not
 * cached — admin-published template edits should take effect immediately.
 */
async function sendKolTemplatedNotification(
  category: TemplatedCategory,
  ctx: TemplatedCtx,
): Promise<{ sent: boolean; skipped?: "opt_out" | "no_template" }> {
  if (!ctx.email) return { sent: false, skipped: "no_template" };

  // Opt-out check (only when promoterId known).
  if (ctx.promoterId) {
    const { data: prefRow } = await affiliateSupabase
      .from("promoters" as never)
      .select("notification_prefs")
      .eq("id", ctx.promoterId)
      .maybeSingle();
    const prefs = (prefRow as { notification_prefs?: Record<string, boolean> } | null)?.notification_prefs;
    if (prefs && prefs[category] === false) {
      logger.debug({ category, promoterId: ctx.promoterId }, "notification skipped (opt-out)");
      return { sent: false, skipped: "opt_out" };
    }
  }

  const locale = await resolvePromoterLocale(ctx.promoterId ?? null);
  const tmpl = await fetchTemplate(category, locale);
  if (!tmpl) {
    logger.warn({ category, locale, promoterId: ctx.promoterId }, "no template found");
    return { sent: false, skipped: "no_template" };
  }

  const subCtx: Record<string, string> = {
    // R1 final review Fix 2: HTML-escape user/Stripe-controlled values
    // before substitution. {{name}} is KOL-controlled (promoters.name
    // edited in the KOL portal), {{dispute_reason}} is Stripe-supplied
    // free-text, and {{commission_id}} is a UUID (safe today, but escape
    // anyway for defense in depth).
    name: escapeHtml(ctx.name ?? ""),
    amount: ctx.amount !== undefined ? Number(ctx.amount).toFixed(2) : "",
    currency: ctx.currency ?? "",
    order_id: ctx.orderId ?? "",
    reason: ctx.reason ?? "",
    // Task 4: commission_disputed template placeholders.
    commission_id: escapeHtml(ctx.commissionId ? ctx.commissionId.slice(0, 8) : ""),
    dispute_reason: escapeHtml(ctx.disputeReason ?? ""),
    // F-NEW-11: substitute {{dashboard_url}} per role. Portal-URL helper
    // already returns /kol/dashboard or /agent/dashboard based on role.
    dashboard_url: dashboardUrlFor(ctx.role ?? "kol"),
  };
  const subject = substitute(tmpl.subject, subCtx);
  const body = substitute(tmpl.body, subCtx);

  const ok = await sendEmailWithRetry({ to: ctx.email, subject, html: body });

  // Log row + audit (best-effort; never throws).
  const { error: logErr } = await affiliateSupabase
    .from("affiliate_email_sends" as never)
    .insert({
      promoter_id: ctx.promoterId ?? null,
      template_id: tmpl.id,
      to_email: ctx.email,
      category,
      sent_at: ok ? new Date().toISOString() : null,
      last_error: ok ? null : "send failed after 3 attempts",
    } as never);
  if (logErr) {
    logger.error({ err: logErr, category }, "affiliate_email_sends insert failed");
  }
  await writeAuditLog({
    actorId: "system",
    actorEmail: "system@notifications",
    action: `notification_${category}`,
    targetType: "promoter",
    targetId: ctx.promoterId ?? "00000000-0000-0000-0000-000000000000",
    afterState: { email: ctx.email, ok },
    reason: "templated notification",
  });

  return { sent: ok };
}

export async function notifyKolCommissionPaid(kol: {
  email: string;
  name?: string;
  amount?: number;
  currency?: string;
  promoterId?: string;
  role?: "kol" | "agent";
}): Promise<void> {
  await sendKolTemplatedNotification("commission_paid", {
    email: kol.email,
    name: kol.name ?? "",
    promoterId: kol.promoterId,
    amount: kol.amount,
    currency: kol.currency,
    // F-NEW-11: forward role so {{dashboard_url}} resolves to the
    // correct portal URL (was accepted but ignored prior to this fix).
    role: kol.role,
  });
}

export async function notifyKolCommissionPending(args: {
  email: string;
  name?: string;
  amount?: number;
  currency?: string;
  orderId?: string;
  promoterId?: string;
}): Promise<void> {
  await sendKolTemplatedNotification("commission_pending", args);
}

export async function notifyKolCommissionReversed(args: {
  email: string;
  name?: string;
  amount?: number;
  currency?: string;
  orderId?: string;
  reason?: string;
  promoterId?: string;
}): Promise<void> {
  await sendKolTemplatedNotification("commission_reversed", args);
}

export async function notifyKolPayoutSent(args: {
  email: string;
  name?: string;
  amount?: number;
  currency?: string;
  promoterId?: string;
}): Promise<void> {
  await sendKolTemplatedNotification("payout_sent", args);
}

export async function notifyKolPayoutFailed(args: {
  email: string;
  name?: string;
  amount?: number;
  currency?: string;
  reason?: string;
  promoterId?: string;
}): Promise<void> {
  await sendKolTemplatedNotification("payout_failed", args);
}

export async function notifyKolNewReferral(args: {
  email: string;
  name?: string;
  promoterId?: string;
}): Promise<void> {
  await sendKolTemplatedNotification("new_referral", args);
}

/**
 * Read preferred_locale for the promoter (i18n Task #7). Falls back to
 * 'en' on any error so a missing column or RLS hiccup never blocks a
 * notification — notifications are best-effort by design (see top of
 * this file). Returning the narrow SupportedLocale union keeps
 * downstream switch statements exhaustive.
 */
async function resolvePromoterLocale(promoterId: string | null): Promise<SupportedLocale> {
  if (!promoterId) return "en";
  try {
    const { data, error } = await supabase
      .from("affiliate.promoters" as never)
      .select("preferred_locale")
      .eq("id", promoterId)
      .maybeSingle();
    if (error || !data) return "en";
    const v = (data as { preferred_locale?: string }).preferred_locale;
    if (v === "en" || v === "zh" || v === "ar" || v === "ru" || v === "es") return v;
    return "en";
  } catch {
    return "en";
  }
}

/**
 * Inline copy table was removed in Task 3.2 — commission_paid (and the
 * 4 other categories) now read from affiliate.email_templates via
 * fetchTemplate + substitute. See sendKolTemplatedNotification.
 */

export async function notifyAdminPayoutFailure(details: {
  promoterId: string;
  commissionId?: string;
  error: string;
}): Promise<void> {
  await notifyAdmin(
    `[Affiliate] Payout FAILED - ${details.promoterId}`,
    `<h2>Payout failure</h2>
     <ul>
       <li><b>Promoter:</b> ${details.promoterId}</li>
       ${details.commissionId ? `<li><b>Commission:</b> ${details.commissionId}</li>` : ""}
       <li><b>Error:</b> ${escapeHtml(details.error)}</li>
     </ul>
     <p>Investigate at <a href="https://affiliate.linkchinamed.com/admin">affiliate.linkchinamed.com/admin</a></p>`,
  );
}

export async function notifyAdminDispute(details: {
  commissionId: string;
  reason: string;
}): Promise<void> {
  await notifyAdmin(
    `[Affiliate] Stripe dispute - ${details.commissionId}`,
    `<h2>Stripe dispute</h2>
     <ul>
       <li><b>Commission:</b> ${details.commissionId}</li>
       <li><b>Reason:</b> ${escapeHtml(details.reason)}</li>
     </ul>
     <p>Review the dispute in the Stripe dashboard + affiliate admin.</p>`,
  );
}

// Task 4: send the charge.dispute.created email to the KOL via the
// shared sendKolTemplatedNotification helper. The helper handles the
// opt-out check (notification_prefs.commission_disputed), locale
// resolution (promoter.preferred_locale), template fetch by category
// + locale, {{key}} substitution, 3-attempt retry, the
// affiliate_email_sends log row, and the audit log. We only fetch the
// promoter record to get email + display name.
//
// ponytail: reuses sendKolTemplatedNotification — no parallel send
// path. Currency is hardcoded "USD" because the webhook's SELECT
// doesn't yet fetch commissions.currency; pulling it requires a
// wider diff touching the stripe-webhook test mock and is out of
// scope for the notification template task.
//
// R1 final review Fix 1: `amount` is now a pre-formatted USD string
// (e.g. "50.00") passed by the webhook call site after cents → USD
// conversion. The helper stays display-naive (no /100 knowledge).
export async function notifyKolDisputed(details: {
  promoterId: string;
  commissionId: string;
  amount: string;
  disputeReason: string;
}): Promise<void> {
  if (!details.promoterId) {
    logger.warn(
      { commissionId: details.commissionId },
      "notifyKolDisputed: missing promoterId",
    );
    return;
  }
  const { data: kol } = await affiliateSupabase
    .from("promoters")
    .select("email, name")
    .eq("id", details.promoterId)
    .maybeSingle();
  if (!kol?.email) {
    logger.warn(
      { promoterId: details.promoterId },
      "notifyKolDisputed: promoter has no email",
    );
    return;
  }
  await sendKolTemplatedNotification("commission_disputed", {
    email: kol.email,
    name: kol.name ?? "",
    promoterId: details.promoterId,
    amount: details.amount,
    currency: "USD", // TODO: webhook SELECT to fetch commissions.currency
    commissionId: details.commissionId,
    disputeReason: details.disputeReason,
    role: "kol",
  });
}

// Task 4: dispute outcome (won/lost) admin email. Admin has no
// opt-out prefs, so this bypasses the template helper and inlines a
// small HTML body via notifyAdmin + escapeHtml.
export async function notifyAdminDisputeResolved(details: {
  commissionId: string;
  action: "won" | "lost";
  note: string;
}): Promise<void> {
  await notifyAdmin(
    `[Affiliate] Dispute resolved: ${details.commissionId.slice(0, 8)} (${details.action})`,
    `<h2>Dispute resolved</h2>
     <ul>
       <li><b>Commission:</b> <code>${escapeHtml(details.commissionId)}</code></li>
       <li><b>Outcome:</b> <strong>${escapeHtml(details.action)}</strong></li>
       <li><b>Note:</b> ${escapeHtml(details.note)}</li>
     </ul>
     <p>Review at <a href="https://affiliate.linkchinamed.com/admin">affiliate.linkchinamed.com/admin</a></p>`,
  );
}

// R1 final review Fix 3: alert ops when Stripe refuses a transfer
// reversal (dispute.lost + alreadyPaid path). The webhook leaves the
// commission in 'disputed' state and writes a reversal_failed audit
// row, then calls this so a human can manually claw back via Stripe
// dashboard + update the commission.
export async function notifyAdminDisputeReversalFailed(details: {
  commissionId: string;
  transferId: string;
  error: string;
}): Promise<void> {
  await notifyAdmin(
    `[Affiliate] STRIPE REVERSAL FAILED — ${details.commissionId.slice(0, 8)}`,
    `<h2>Stripe transfer reversal failed</h2>
     <ul>
       <li><b>Commission:</b> <code>${escapeHtml(details.commissionId)}</code></li>
       <li><b>Transfer:</b> <code>${escapeHtml(details.transferId)}</code></li>
       <li><b>Status:</b> Commission left in <code>disputed</code> state pending manual intervention.</li>
       <li><b>Error:</b> <pre>${escapeHtml(details.error)}</pre></li>
     </ul>
     <p>Manual ops follow-up required. Review at <a href="https://affiliate.linkchinamed.com/admin">affiliate.linkchinamed.com/admin</a></p>`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PORTAL_LOGIN_URL = "https://affiliate.linkchinamed.com/login";

/**
 * Agent onboarding welcome email (bilingual EN + 中文 in one message).
 * Sent after an admin creates an agent. NEVER contains a plaintext
 * password — the agent sets their own password via the recovery
 * action link. If actionLink is null (generateLink failed), the copy
 * falls back to "ask your admin to reset your password".
 */
export async function notifyAgentWelcome(agent: {
  name: string;
  email: string;
  inviteCode: string;
  actionLink: string | null;
}): Promise<boolean> {
  const setPasswordBlock = agent.actionLink
    ? `<p><a href="${escapeHtml(agent.actionLink)}" style="display:inline-block;padding:10px 18px;background:#0b5fff;color:#ffffff;text-decoration:none;border-radius:6px;">Set your password / 设置密码</a></p>
       <p style="color:#666;font-size:13px;">This link expires in 24 hours. If it expires, ask your admin to send a new one.<br/>该链接 24 小时内有效。如已过期，请联系管理员重新发送。</p>`
    : `<p style="color:#666;font-size:13px;">Password setup link is temporarily unavailable — please ask your admin to reset your password.<br/>密码设置链接暂时不可用，请联系管理员为您重置密码。</p>`;

  return notifyKol(
    agent.email,
    "Welcome to LinkChinaMed Partner Program / 欢迎加入 LinkChinaMed 合作伙伴计划",
    `<h2>Welcome aboard, ${escapeHtml(agent.name)}!</h2>
     <p>Your LinkChinaMed <b>agent</b> account is ready. Your agent invite code is:</p>
     <p style="font-size:22px;font-weight:bold;letter-spacing:2px;background:#f4f6f8;padding:12px 16px;border-radius:6px;display:inline-block;">${escapeHtml(agent.inviteCode)}</p>
     ${setPasswordBlock}
     <p>Portal login: <a href="${PORTAL_LOGIN_URL}">${PORTAL_LOGIN_URL}</a></p>
     <p><b>Get started in 3 steps:</b></p>
     <ol>
       <li>Log in to the partner portal.</li>
       <li>Copy your invite link / invite code from the dashboard.</li>
       <li>Share it to recruit KOLs — they bind to you at registration.</li>
     </ol>
     <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;"/>
     <h2>欢迎加入，${escapeHtml(agent.name)}！</h2>
     <p>您的 LinkChinaMed <b>代理</b>账号已开通。您的代理邀请码为：</p>
     <p style="font-size:22px;font-weight:bold;letter-spacing:2px;background:#f4f6f8;padding:12px 16px;border-radius:6px;display:inline-block;">${escapeHtml(agent.inviteCode)}</p>
     <p>门户登录地址：<a href="${PORTAL_LOGIN_URL}">${PORTAL_LOGIN_URL}</a></p>
     <p><b>三步上手：</b></p>
     <ol>
       <li>登录合作伙伴门户。</li>
       <li>在控制台复制您的专属邀请链接 / 邀请码。</li>
       <li>分享给 KOL，他们在注册时即绑定到您名下。</li>
     </ol>`,
  );
}

// ---- Admin-triggered resend (Task 1.4) ----

// COUPLED: RESEND_DEBOUNCE_MS MUST match the SQL `interval '60 seconds'`
// in supabase/migrations/20260813000005_claim_agent_invite_send.sql. If
// you change one, change the other — otherwise the app will claim a
// slot that the SQL already released (or vice versa).
const RESEND_DEBOUNCE_MS = 60_000;

/**
 * Errors thrown by resendAgentInvite carry a `code` field so the route
 * layer can map them to HTTP status codes without leaking the message
 * to the client in the 5xx path.
 */
export class ResendError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Admin-triggered manual resend of the agent welcome email.
 *
 * Race-safe debounce: the affiliate_email_sends INSERT is the gating
 * operation, not a preceding SELECT. We use an atomic
 * `INSERT ... WHERE NOT EXISTS (recent send)` so two concurrent calls
 * cannot both claim the slot — the second sees the first's row inside
 * the same statement and inserts nothing, returning 429. This eliminates
 * the SELECT→INSERT race that the previous implementation exposed.
 *
 * emailSent reflects the actual Resend outcome (notifyAgentWelcome now
 * returns the sendEmail boolean). On Resend 4xx/5xx, emailSent is false
 * but the affiliate_email_sends + audit_log rows are still written
 * because they record the operator's intent (best-effort by design).
 */
export async function resendAgentInvite(args: {
  promoterId: string;
  actorId: string;
  actorEmail?: string;
}): Promise<{ ok: true; emailSent: boolean }> {
  // 1. Lookup agent.
  const { data: agent, error: agentErr } = await affiliateSupabase
    .from("promoters")
    .select("id, name, email, agent_invite_code, preferred_locale, role")
    .eq("id", args.promoterId)
    .eq("role", "agent")
    .maybeSingle();
  if (agentErr) {
    logger.error({ err: agentErr, promoterId: args.promoterId }, "resendAgentInvite: agent lookup failed");
    throw new ResendError("AGENT_LOOKUP_FAILED", "Agent lookup failed", 500);
  }
  if (!agent) {
    throw new ResendError("AGENT_NOT_FOUND", `Agent ${args.promoterId} not found`, 404);
  }

  // 2. Atomic debounce gate via SECURITY DEFINER RPC. Single SQL
  //    statement: INSERT ... WHERE NOT EXISTS (recent row). Two
  //    concurrent calls cannot both claim the slot — Postgres
  //    serializes the statement. Returns 0 rows → debounce hit.
  const { data: claimed, error: claimErr } = await affiliateSupabase.rpc(
    "claim_agent_invite_send",
    { p_promoter_id: agent.id, p_to_email: agent.email },
  );
  if (claimErr) {
    logger.error(
      { err: claimErr, promoterId: agent.id },
      "resendAgentInvite: claim rpc failed",
    );
    throw new ResendError("RESEND_CLAIM_FAILED", "Could not claim resend slot", 500);
  }
  // rpc() must return an array (PostgREST contract for set-returning RPCs).
  if (!Array.isArray(claimed)) {
    logger.error(
      { promoterId: agent.id, claimed },
      "resendAgentInvite: claim rpc returned non-array response",
    );
    throw new ResendError("RESEND_CLAIM_MALFORMED", "Claim RPC returned malformed response", 500);
  }
  if (claimed.length === 0) {
    throw new ResendError(
      "RESEND_TOO_SOON",
      `Last send within ${RESEND_DEBOUNCE_MS / 1000}s debounce window`,
      429,
    );
  }

  // 3. Generate recovery action link (best-effort).
  let actionLink: string | null = null;
  try {
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email: agent.email,
    });
    if (!linkErr && linkData?.properties?.action_link) {
      actionLink = linkData.properties.action_link;
    }
  } catch (e) {
    logger.error(
      { error: (e as Error).message, email: agent.email },
      "resendAgentInvite: generateLink threw; sending without action link",
    );
  }

  // 4. Send welcome email. notifyAgentWelcome returns the actual
  //    sendEmail boolean — propagate as emailSent so the API contract
  //    reflects real delivery, not env presence.
  const emailSent = await notifyAgentWelcome({
    name: agent.name,
    email: agent.email,
    inviteCode: agent.agent_invite_code ?? "",
    actionLink,
  });

  // 5. Operator audit log (best-effort; writeAuditLog swallows its own failures).
  await writeAuditLog({
    actorId: args.actorId,
    actorEmail: args.actorEmail ?? "admin@resend-invite",
    action: "agent_invite_resent",
    targetType: "promoter",
    targetId: agent.id,
    afterState: {
      email: agent.email,
      debounce_ms: RESEND_DEBOUNCE_MS,
      had_action_link: !!actionLink,
      email_sent: emailSent,
    },
    reason: "admin manual resend",
  });

  return { ok: true, emailSent };
}
