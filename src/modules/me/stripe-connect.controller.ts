import { Request, Response } from "express";
import { stripe, affiliateSupabase, env } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { settingsStripeReturnUrl } from "../portal-urls.js";

/**
 * POST /me/stripe-connect
 *
 * Create (or reuse) a Stripe Connect Express account for the
 * authenticated subject (KOL or Agent — both earn commissions and
 * need Connect onboarding to receive payouts) and return a one-time
 * account-link URL for the browser to redirect to.
 *
 * In dev (when STRIPE_SECRET_KEY is missing or starts with
 * PLACEHOLDER), returns a mock URL pointing at /dev/stripe-mock
 * so the front-end flow can be exercised without real Stripe keys.
 *
 * Account creation is idempotent on promoter.stripe_account_id —
 * re-running for an already-onboarded subject just returns a fresh
 * login link.
 */
export async function postMyStripeConnect(req: Request, res: Response) {
  const subject = req.subject;
  if (!subject) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Missing subject context" },
    });
    return;
  }

  // Read latest stripe_account_id (auth middleware doesn't include it)
  const { data: p } = await affiliateSupabase.from("promoters")
    .select("stripe_account_id, role, agent_level")
    .eq("id", subject.id)
    .single();
  const existingAccountId = p?.stripe_account_id ?? null;
  const role = (p?.role || subject.role) as "kol" | "agent";

  // AS-P2-4 fix: dev-mock fallback is now gated on NODE_ENV. The
  // previous condition (missing key OR starts with PLACEHOLDER) would
  // silently activate a /dev/stripe-mock URL in production if the env
  // was misconfigured — a real subject would click "Onboard with Stripe"
  // and land on a local placeholder page, never reaching Stripe.
  //
  // Now: only return mock when NODE_ENV === 'development' AND the
  // key is missing/placeholder. In production or staging with a
  // missing key we fail loudly with 500 so ops notices.
  const isDevMock =
    process.env.NODE_ENV === "development" &&
    (!env.STRIPE_SECRET_KEY ||
      env.STRIPE_SECRET_KEY.startsWith("PLACEHOLDER") ||
      env.STRIPE_SECRET_KEY === "sk_test_PLACEHOLDER");
  if (isDevMock) {
    const mockAccountId = existingAccountId || `acct_devmock_${subject.id.slice(0, 8)}`;
    await affiliateSupabase.from("promoters")
      .update({
        stripe_account_id: mockAccountId,
        stripe_onboarding_completed: false,
      })
      .eq("id", subject.id);
    res.json({
      data: {
        url: `/dev/stripe-mock?account=${mockAccountId}&return=${encodeURIComponent(settingsStripeReturnUrl(role))}`,
        mode: "dev-mock",
        accountId: mockAccountId,
      },
    });
    return;
  }

  try {
    let accountId = existingAccountId;

    // 1. Create Connect Express account if subject doesn't have one yet
    if (!accountId) {
      // AS-P2-3: idempotencyKey prevents double-creation when a
      // user double-clicks or two browser tabs race. The key is
      // derived from the immutable subject.id so retries within the
      // 24h Stripe idempotency window collapse to one account.
      const account = await stripe.accounts.create(
        {
          type: "express",
          country: subject.country_code || "US",
          email: subject.email,
          capabilities: {
            transfers: { requested: true },
          },
          business_type: "individual",
          metadata: {
            promoter_id: subject.id,
            promoter_name: subject.name || "",
            role,
            agent_level: p?.agent_level || null,
          },
        },
        { idempotencyKey: `promoter-connect-${subject.id}` },
      );
      accountId = account.id;

      // F-AFF-STRIPE-3: persist immediately so subsequent requests see
      // the new id. If the DB write fails (RLS, network, transient
      // outage) the Stripe Express account is now an orphan — without
      // cleanup, the next request would see no stripe_account_id and
      // create another. Best-effort delete the orphan; if THAT also
      // fails, log and surface the original DB error so ops can
      // reconcile manually.
      try {
        await affiliateSupabase.from("promoters")
          .update({
            stripe_account_id: accountId,
            stripe_onboarding_completed: false,
          })
          .eq("id", subject.id);
      } catch (dbErr) {
        logger.error(
          { err: (dbErr as Error).message, accountId, promoterId: subject.id },
          "failed to persist stripe_account_id — cleaning up orphan Stripe account",
        );
        try {
          await stripe.accounts.del(accountId);
        } catch (delErr) {
          logger.error(
            { err: (delErr as Error).message, accountId },
            "stripe.accounts.del failed during orphan cleanup — manual reconciliation required",
          );
        }
        throw dbErr;
      }
    }

    // 2. Create one-time account-link for onboarding / login
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${settingsStripeReturnUrl(role)}?refresh=true`,
      return_url: `${settingsStripeReturnUrl(role)}?return=true`,
      type: "account_onboarding",
    });

    res.json({
      data: {
        url: link.url,
        mode: "live",
        accountId,
      },
    });
  } catch (err: any) {
    console.error("[stripe-connect] error:", err);
    res.status(500).json({
      error: { code: "STRIPE_ERROR", message: err?.message || "Stripe error" },
    });
  }
}

/**
 * GET /me/stripe-status
 *
 * Returns current Connect onboarding status from the promoter row.
 * Replaces the stub that always returned connected: false. Works
 * for both KOL and Agent subjects.
 */
export async function getMyStripeStatus(req: Request, res: Response) {
  const subject = req.subject;
  if (!subject) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Missing subject context" },
    });
    return;
  }

  // Read latest values from DB (don't trust req.subject cache)
  const { data } = await affiliateSupabase.from("promoters")
    .select("stripe_account_id, stripe_onboarding_completed")
    .eq("id", subject.id)
    .single();

  const accountId = data?.stripe_account_id ?? null;
  const onboardingCompleted = !!data?.stripe_onboarding_completed;

  // AS-P2-4 fix: dev-mock fallback gated on NODE_ENV (see postMyStripeConnect).
  const isDevMock =
    process.env.NODE_ENV === "development" &&
    (!env.STRIPE_SECRET_KEY ||
      env.STRIPE_SECRET_KEY.startsWith("PLACEHOLDER") ||
      env.STRIPE_SECRET_KEY === "sk_test_PLACEHOLDER");

  res.json({
    data: {
      connected: !!accountId,
      accountId,
      payoutsEnabled: onboardingCompleted,
      mode: isDevMock ? "dev-mock" : "live",
      // Helpful debug info for the UI in dev
      ...(isDevMock && accountId
        ? { devMockNote: "Dev mock — set STRIPE_SECRET_KEY for real Stripe" }
        : {}),
    },
  });
}