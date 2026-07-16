import { Request, Response } from "express";
import { stripe, supabase, env } from "../../config.js";

/**
 * POST /me/stripe-connect
 *
 * Create (or reuse) a Stripe Connect Express account for the KOL and
 * return a one-time account-link URL for the browser to redirect to.
 *
 * In dev (when STRIPE_SECRET_KEY is missing or starts with
 * PLACEHOLDER), returns a mock URL pointing at /dev/stripe-mock
 * so the front-end flow can be exercised without real Stripe keys.
 *
 * Account creation is idempotent on promoter.stripe_account_id —
 * re-running for an already-onboarded KOL just returns a fresh
 * login link.
 */
export async function postMyStripeConnect(req: Request, res: Response) {
  const promoter = req.promoter;
  if (!promoter) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Missing promoter context" },
    });
    return;
  }

  // Read latest stripe_account_id (auth middleware doesn't include it)
  const { data: p } = await supabase
    .from("affiliate.promoters")
    .select("stripe_account_id, role, agent_level")
    .eq("id", promoter.id)
    .single();
  const existingAccountId = p?.stripe_account_id ?? null;

  // AS-P2-4 fix: dev-mock fallback is now gated on NODE_ENV. The
  // previous condition (missing key OR starts with PLACEHOLDER) would
  // silently activate a /dev/stripe-mock URL in production if the env
  // was misconfigured — a real KOL would click "Onboard with Stripe"
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
    const mockAccountId = existingAccountId || `acct_devmock_${promoter.id.slice(0, 8)}`;
    await supabase
      .from("affiliate.promoters")
      .update({
        stripe_account_id: mockAccountId,
        stripe_onboarding_completed: false,
      })
      .eq("id", promoter.id);
    res.json({
      data: {
        url: `/dev/stripe-mock?account=${mockAccountId}&return=/dashboard/settings/stripe`,
        mode: "dev-mock",
        accountId: mockAccountId,
      },
    });
    return;
  }

  try {
    let accountId = existingAccountId;

    // 1. Create Connect Express account if KOL doesn't have one yet
    if (!accountId) {
      // AS-P2-3: idempotencyKey prevents double-creation when a
      // user double-clicks or two browser tabs race. The key is
      // derived from the immutable promoter.id so retries within the
      // 24h Stripe idempotency window collapse to one account.
      const account = await stripe.accounts.create(
        {
          type: "express",
          country: promoter.country_code || "US",
          email: promoter.email,
          capabilities: {
            transfers: { requested: true },
          },
          business_type: "individual",
          metadata: {
            promoter_id: promoter.id,
            promoter_name: promoter.name || "",
            role: p?.role || "kol",
            agent_level: p?.agent_level || null,
          },
        },
        { idempotencyKey: `promoter-connect-${promoter.id}` },
      );
      accountId = account.id;

      // Persist immediately so subsequent requests see the new id
      await supabase
        .from("affiliate.promoters")
        .update({
          stripe_account_id: accountId,
          stripe_onboarding_completed: false,
        })
        .eq("id", promoter.id);
    }

    // 2. Create one-time account-link for onboarding / login
    const baseUrl =
      env.PORTAL_URL || env.WEB_URL || "https://affiliate.linkchinamed.com";
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${baseUrl}/dashboard/settings/stripe?refresh=true`,
      return_url: `${baseUrl}/dashboard/settings/stripe?return=true`,
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
 * Replaces the stub that always returned connected: false.
 */
export async function getMyStripeStatus(req: Request, res: Response) {
  const promoter = req.promoter;
  if (!promoter) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Missing promoter context" },
    });
    return;
  }

  // Read latest values from DB (don't trust req.promoter cache)
  const { data } = await supabase
    .from("affiliate.promoters")
    .select("stripe_account_id, stripe_onboarding_completed")
    .eq("id", promoter.id)
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