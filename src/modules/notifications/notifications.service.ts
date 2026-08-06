import { env } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { supabase } from "../../config.js";

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

async function notifyAdmin(subject: string, html: string): Promise<void> {
  if (!env.ADMIN_NOTIFY_EMAIL) return;
  await sendEmail({ to: env.ADMIN_NOTIFY_EMAIL, subject, html });
}

async function notifyKol(
  email: string,
  subject: string,
  html: string,
): Promise<void> {
  if (!email) return;
  await sendEmail({ to: email, subject, html });
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

export async function notifyKolCommissionPaid(kol: {
  email: string;
  amount: number;
  currency: string;
  promoterId?: string;
}): Promise<void> {
  const locale: SupportedLocale = await resolvePromoterLocale(kol.promoterId ?? null);
  const { subject, body } = commissionPaidCopy(locale, kol.currency, kol.amount);
  await notifyKol(kol.email, subject, body);
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
 * Inline copy table. Keep small + explicit: only locales we actually
 * intend to ship. When the broader notification_templates system grows
 * (separate table) we delete this and look up by (trigger, locale).
 */
function commissionPaidCopy(
  locale: SupportedLocale,
  currency: string,
  amount: number,
): { subject: string; body: string } {
  const amountStr = `${currency} ${amount.toFixed(2)}`;
  const dashboardUrl = "https://affiliate.linkchinamed.com/dashboard";
  switch (locale) {
    case "zh":
      return {
        subject: "您的 LinkChinaMed 佣金已支付",
        body: `<p>您好,</p>
           <p>您的佣金 <b>${amountStr}</b> 已支付至您的 Stripe 账户。</p>
           <p>请到 <a href="${dashboardUrl}">控制台</a> 查看详情。</p>`,
      };
    case "ar":
      return {
        subject: "تم دفع عمولة LinkChinaMed الخاصة بك",
        body: `<p>مرحبًا,</p>
           <p>تم دفع عمولتك البالغة <b>${amountStr}</b> إلى حساب Stripe الخاص بك.</p>
           <p>عرض التفاصيل على <a href="${dashboardUrl}">لوحة التحكم</a>.</p>`,
      };
    case "ru":
      return {
        subject: "Ваша комиссия LinkChinaMed выплачена",
        body: `<p>Здравствуйте,</p>
           <p>Ваша комиссия <b>${amountStr}</b> переведена на ваш Stripe-аккаунт.</p>
           <p>Подробности на <a href="${dashboardUrl}">панели управления</a>.</p>`,
      };
    case "es":
      return {
        subject: "Tu comisión de LinkChinaMed ha sido pagada",
        body: `<p>Hola,</p>
           <p>Tu comisión de <b>${amountStr}</b> ha sido transferida a tu cuenta de Stripe.</p>
           <p>Ver detalles en <a href="${dashboardUrl}">tu panel</a>.</p>`,
      };
    case "en":
    default:
      return {
        subject: "Your LinkChinaMed commission has been paid",
        body: `<p>Hi,</p>
           <p>Your commission of <b>${amountStr}</b> has been paid out to your Stripe account.</p>
           <p>View details at <a href="${dashboardUrl}">your dashboard</a>.</p>`,
      };
  }
}

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
}): Promise<void> {
  const setPasswordBlock = agent.actionLink
    ? `<p><a href="${escapeHtml(agent.actionLink)}" style="display:inline-block;padding:10px 18px;background:#0b5fff;color:#ffffff;text-decoration:none;border-radius:6px;">Set your password / 设置密码</a></p>
       <p style="color:#666;font-size:13px;">This link expires in 24 hours. If it expires, ask your admin to send a new one.<br/>该链接 24 小时内有效。如已过期，请联系管理员重新发送。</p>`
    : `<p style="color:#666;font-size:13px;">Password setup link is temporarily unavailable — please ask your admin to reset your password.<br/>密码设置链接暂时不可用，请联系管理员为您重置密码。</p>`;

  await notifyKol(
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
