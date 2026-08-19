import { describe, it, expect, vi, beforeEach } from "vitest";

// The controller gates dev-mock on process.env.NODE_ENV === "development"
// (NOT env.NODE_ENV from the config mock). Vitest defaults to "test",
// so we set it explicitly here.
process.env.NODE_ENV = "development";

// Shared mutable state.
const { state } = vi.hoisted(() => ({
  state: {
    stripeAccountCreates: [] as Array<Record<string, any>>,
    stripeAccountLinkCreates: [] as Array<Record<string, any>>,
    // promoter row returned by .select().single() inside the controller
    promoterRow: null as null | Record<string, any>,
    // promoter row updates captured from .update().eq()
    promoterUpdates: [] as Array<Record<string, any>>,
    nextAccountId: "acct_test_001",
    // dev-mock toggle — must start with "PLACEHOLDER" so controller's
    // `env.STRIPE_SECRET_KEY.startsWith("PLACEHOLDER")` check triggers
    // in dev-mock tests.
    stripeKey: "PLACEHOLDER",
  },
}));

vi.mock("../../config.js", () => {
  // env object with a getter for STRIPE_SECRET_KEY so tests can toggle
  // between dev-mock ("PLACEHOLDER") and live ("sk_test_real_key") via
  // state.stripeKey without reloading the mock factory.
  const env: any = {
    NODE_ENV: "development",
    PORTAL_URL: "https://affiliate.linkchinamed.com",
    AGENT_PORTAL_URL: "https://agent.linkchinamed.com",
  };
  Object.defineProperty(env, "STRIPE_SECRET_KEY", {
    get: () => state.stripeKey,
  });
  return {
    env,
    affiliateSupabase: {
      from: (table: string) => {
        if (table !== "promoters") throw new Error("unmocked table " + table);
        const chain: any = {};
        chain.select = () => chain;
        chain.update = (row: Record<string, any>) => {
          state.promoterUpdates.push(row);
          return { eq: () => chain };
        };
        chain.eq = () => chain;
        chain.single = async () => ({ data: state.promoterRow, error: null });
        return chain;
      },
    },
    stripe: {
      accounts: {
        create: async (params: Record<string, any>, opts: Record<string, any>) => {
          state.stripeAccountCreates.push({ params, opts });
          return { id: state.nextAccountId };
        },
      },
      accountLinks: {
        create: async (params: Record<string, any>) => {
          state.stripeAccountLinkCreates.push(params);
          return { url: `https://stripe.test/account-link/${state.nextAccountId}` };
        },
      },
    },
  };
});

vi.mock("../portal-urls.js", () => ({
  settingsStripeReturnUrl: (role: string) =>
    role === "agent"
      ? "https://agent.linkchinamed.com/dashboard/settings/stripe"
      : "https://affiliate.linkchinamed.com/dashboard/settings/stripe",
}));

import { postMyStripeConnect, getMyStripeStatus } from "./stripe-connect.controller.js";

function makeReqRes() {
  const req: any = {};
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      // Express defaults status to 200 when json() is called without
      // an explicit res.status(). Mirror that.
      if (this.statusCode === 0) this.statusCode = 200;
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

beforeEach(() => {
  state.stripeAccountCreates = [];
  state.stripeAccountLinkCreates = [];
  state.promoterRow = null;
  state.promoterUpdates = [];
  state.nextAccountId = "acct_test_001";
  state.stripeKey = "PLACEHOLDER";
});

describe("postMyStripeConnect with kolOrAgentAuthMiddleware", () => {
  it("rejects 401 when req.subject missing (no auth ran)", async () => {
    const { req, res } = makeReqRes();
    await postMyStripeConnect(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("handles role='kol' — dev-mock creates acct and persists stripe_account_id", async () => {
    const { req, res } = makeReqRes();
    req.subject = {
      id: "k1",
      email: "kol@example.com",
      name: "KOL One",
      status: "active",
      role: "kol",
      country_code: "US",
    };
    state.promoterRow = {
      id: "k1",
      role: "kol",
      agent_level: null,
      stripe_account_id: null,
    };
    await postMyStripeConnect(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.mode).toBe("dev-mock");
    expect(res.body.data.accountId).toContain("acct_devmock_");
    expect(state.promoterUpdates).toHaveLength(1);
    expect(state.promoterUpdates[0].stripe_account_id).toContain("acct_devmock_");
    // return URL uses kol portal
    expect(res.body.data.url).toContain("affiliate.linkchinamed.com");
  });

  it("handles role='agent' — dev-mock creates acct with agent return URL (the gap)", async () => {
    const { req, res } = makeReqRes();
    req.subject = {
      id: "a1",
      email: "agent@example.com",
      name: "Agent One",
      status: "active",
      role: "agent",
      country_code: "CN",
    };
    state.promoterRow = {
      id: "a1",
      role: "agent",
      agent_level: 1,
      stripe_account_id: null,
    };
    await postMyStripeConnect(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.mode).toBe("dev-mock");
    expect(state.promoterUpdates).toHaveLength(1);
    expect(state.promoterUpdates[0].stripe_account_id).toContain("acct_devmock_");
    // return URL uses agent portal — not kol
    expect(res.body.data.url).toContain("agent.linkchinamed.com");
    expect(res.body.data.url).not.toContain("affiliate.linkchinamed.com");
  });

  it("handles role='agent' with existing stripe_account_id — reuses account", async () => {
    const { req, res } = makeReqRes();
    req.subject = {
      id: "a2",
      email: "agent2@example.com",
      name: "Agent Two",
      status: "active",
      role: "agent",
      country_code: "US",
    };
    state.promoterRow = {
      id: "a2",
      role: "agent",
      agent_level: 2,
      stripe_account_id: "acct_existing_abc",
    };
    await postMyStripeConnect(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.accountId).toBe("acct_existing_abc");
    // Dev-mock writes stripe_account_id even when one exists (writes
    // the same value — idempotent). Live mode skips the write when
    // existing; covered by the next test.
    expect(state.promoterUpdates).toHaveLength(1);
    expect(state.promoterUpdates[0].stripe_account_id).toBe("acct_existing_abc");
    // No Stripe API calls in dev-mock mode
    expect(state.stripeAccountCreates).toHaveLength(0);
    expect(state.stripeAccountLinkCreates).toHaveLength(0);
  });

  it("live mode — role='agent' creates Stripe Express account and accountLink", async () => {
    state.stripeKey = "sk_test_real_key";
    const { req, res } = makeReqRes();
    req.subject = {
      id: "a3",
      email: "agent3@example.com",
      name: "Agent Three",
      status: "active",
      role: "agent",
      country_code: "CN",
    };
    state.promoterRow = {
      id: "a3",
      role: "agent",
      agent_level: 1,
      stripe_account_id: null,
    };
    await postMyStripeConnect(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.mode).toBe("live");
    expect(res.body.data.accountId).toBe("acct_test_001");
    // stripe.accounts.create was called with role=agent in metadata
    expect(state.stripeAccountCreates).toHaveLength(1);
    expect(state.stripeAccountCreates[0].params.metadata.role).toBe("agent");
    expect(state.stripeAccountCreates[0].params.metadata.agent_level).toBe(1);
    expect(state.stripeAccountCreates[0].params.metadata.promoter_id).toBe("a3");
    // idempotencyKey derived from promoter.id
    expect(state.stripeAccountCreates[0].opts.idempotencyKey).toBe("promoter-connect-a3");
    // accountLink uses agent portal
    expect(state.stripeAccountLinkCreates).toHaveLength(1);
    expect(state.stripeAccountLinkCreates[0].account).toBe("acct_test_001");
    expect(state.stripeAccountLinkCreates[0].refresh_url).toContain("agent.linkchinamed.com");
    expect(state.stripeAccountLinkCreates[0].return_url).toContain("agent.linkchinamed.com");
  });
});

describe("getMyStripeStatus with kolOrAgentAuthMiddleware", () => {
  it("rejects 401 when req.subject missing", async () => {
    const { req, res } = makeReqRes();
    await getMyStripeStatus(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns connected=true for role='agent' who already onboarded", async () => {
    const { req, res } = makeReqRes();
    req.subject = {
      id: "a4",
      email: "agent4@example.com",
      name: "Agent Four",
      status: "active",
      role: "agent",
      country_code: "US",
    };
    state.promoterRow = {
      stripe_account_id: "acct_done_xyz",
      stripe_onboarding_completed: true,
    };
    await getMyStripeStatus(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.connected).toBe(true);
    expect(res.body.data.accountId).toBe("acct_done_xyz");
    expect(res.body.data.payoutsEnabled).toBe(true);
  });

  it("returns connected=false for role='agent' not yet onboarded", async () => {
    const { req, res } = makeReqRes();
    req.subject = {
      id: "a5",
      email: "agent5@example.com",
      name: "Agent Five",
      status: "active",
      role: "agent",
      country_code: "US",
    };
    state.promoterRow = {
      stripe_account_id: null,
      stripe_onboarding_completed: false,
    };
    await getMyStripeStatus(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.connected).toBe(false);
    expect(res.body.data.accountId).toBeNull();
    expect(res.body.data.payoutsEnabled).toBe(false);
  });
});