import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { state, mocks } = vi.hoisted(() => ({
  state: {
    agentRow: null as null | { id: string; name: string; email: string; agent_invite_code: string; preferred_locale: string; role: string },
    // claim rpc result: array (length 1 = success, 0 = debounce hit) or null on error.
    claimResult: null as null | Array<{ id: string; created_at: string }>,
    claimError: null as null | { message: string },
    claimCallCount: 0,
    generateLinkResult: { data: { properties: { action_link: "https://auth.example/recovery?token=abc" } }, error: null } as any,
    fetchResult: { ok: true, status: 200 } as { ok: boolean; status: number },
    // Task 3.2: notification_prefs opt-out map (per promoter)
    notificationPrefs: null as null | Record<string, boolean>,
    // Task 3.2: email_templates row lookups by (category, language)
    templateRow: null as null | { id: string; subject: string; body: string },
    // Task 3.2: inserts into affiliate_email_sends are recorded
    emailSendInserts: [] as Array<Record<string, unknown>>,
    // KOL snapshot for post-fire helper calls (only used by templated path)
    promoterSnapshot: null as null | { id: string; email: string; name: string; preferred_locale?: string },
  },
  mocks: {
    generateLink: vi.fn(),
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
    RESEND_API_KEY: "test-key",
    MAIL_FROM: "test@example.com",
    ADMIN_NOTIFY_EMAIL: "admin@example.com",
    PORTAL_URL: "https://portal.example.com",
  },
  supabase: {
    auth: {
      admin: {
        generateLink: (...args: any[]) => mocks.generateLink(...args),
      },
    },
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (table === "promoters") {
        return {
          select: (cols?: string) => {
            // The resendAgentInvite path uses chained .eq().eq().maybeSingle()
            // and the templated path uses .eq().maybeSingle() (single eq).
            // We dispatch on call shape via state. The notification_prefs
            // helper does .eq("id").maybeSingle(); agent resend does
            // .eq("id").eq("role").maybeSingle().
            const eqChain = (...eqArgs: unknown[]) => {
              const lastEqArgs = eqArgs as Array<[string, unknown]>;
              const lastIsRole = lastEqArgs.length === 2 && lastEqArgs[1][0] === "role";
              return {
                eq: () => ({
                  maybeSingle: async () => ({ data: state.agentRow, error: null }),
                }),
                maybeSingle: async () => {
                  // notification_prefs opt-out lookup OR generic snapshot
                  if (cols === "notification_prefs") {
                    return { data: { notification_prefs: state.notificationPrefs }, error: null };
                  }
                  if (cols === "email, name") {
                    return { data: state.promoterSnapshot, error: null };
                  }
                  if (lastIsRole) {
                    return { data: state.agentRow, error: null };
                  }
                  return { data: state.promoterSnapshot, error: null };
                },
              };
            };
            return { eq: eqChain };
          },
        };
      }
      if (table === "email_templates") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: state.templateRow, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "affiliate_email_sends") {
        return {
          insert: async (row: Record<string, unknown>) => {
            state.emailSendInserts.push(row);
            return { error: null };
          },
        };
      }
      if (table === "audit_logs") {
        return {
          insert: async () => ({ error: null }),
        };
      }
      throw new Error("unmocked table " + table);
    },
    rpc: (fn: string) => {
      if (fn === "claim_agent_invite_send") {
        state.claimCallCount += 1;
        return Promise.resolve({ data: state.claimResult, error: state.claimError });
      }
      throw new Error("unmocked rpc " + fn);
    },
  },
}));

vi.mock("../admin/audit.service.js", () => ({
  writeAuditLog: async () => true,
}));

// notifyAgentWelcome is not mocked here — we exercise it directly. It
// only depends on fetch (stubbed) + env (RESEND_API_KEY set).
const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import {
  resendAgentInvite,
  notifyKolCommissionPaid,
  notifyKolCommissionPending,
  notifyKolDisputed,
  notifyKolPayoutSent,
  notifyKolNewReferral,
} from "./notifications.service.js";

function makeAgent(overrides: Partial<{ id: string; name: string; email: string; agent_invite_code: string; preferred_locale: string; role: string }> = {}) {
  return {
    id: "agent-1",
    name: "X",
    email: "x@e.com",
    agent_invite_code: "AB12",
    preferred_locale: "en",
    role: "agent",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.agentRow = null;
  // Default: claim succeeds (one row returned).
  state.claimResult = [{ id: "send-1", created_at: new Date().toISOString() }];
  state.claimError = null;
  state.claimCallCount = 0;
  state.fetchResult = { ok: true, status: 200 };
  state.generateLinkResult = {
    data: { properties: { action_link: "https://auth.example/recovery?token=abc" } },
    error: null,
  };
  // Task 3.2 defaults
  state.notificationPrefs = null;
  state.templateRow = {
    id: "tmpl-1",
    subject: "Hi {{name}} — {{amount}} {{currency}}",
    body: "<p>Hi {{name}}, you earned {{amount}} {{currency}} for order {{order_id}}.</p>",
  };
  state.emailSendInserts = [];
  state.promoterSnapshot = { id: "p-1", email: "kol@example.com", name: "K", preferred_locale: "en" };
  mocks.generateLink.mockImplementation(async () => state.generateLinkResult);
  fetchSpy.mockImplementation(async () => ({
    ok: state.fetchResult.ok,
    status: state.fetchResult.status,
    text: async () => "ok",
  }));
  vi.stubGlobal("fetch", fetchSpy);
});

function fetchBody(): string | null {
  const calls = fetchSpy.mock.calls;
  if (calls.length === 0) return null;
  const firstCall = calls[0] as unknown as [unknown, { body?: unknown } | undefined];
  const body = firstCall[1]?.body;
  return typeof body === "string" ? body : null;
}

describe("resendAgentInvite", () => {
  it("rejects when claim returns 0 rows (debounce hit)", async () => {
    state.agentRow = makeAgent();
    state.claimResult = []; // debounce: another send within 60s

    await expect(
      resendAgentInvite({ promoterId: "agent-1", actorId: "admin-1" }),
    ).rejects.toMatchObject({ code: "RESEND_TOO_SOON" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends email + writes audit on success (claim succeeded)", async () => {
    state.agentRow = makeAgent();

    const result = await resendAgentInvite({ promoterId: "agent-1", actorId: "admin-1" });

    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = fetchBody();
    expect(body).toContain("x@e.com");
    expect(body).toContain("AB12");
  });

  it("throws AGENT_NOT_FOUND when promoter row missing", async () => {
    state.agentRow = null;

    await expect(
      resendAgentInvite({ promoterId: "missing", actorId: "admin-1" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws RESEND_CLAIM_MALFORMED when RPC returns a non-array (500, not 429)", async () => {
    state.agentRow = makeAgent();
    state.claimResult = null as unknown as Array<{ id: string; created_at: string }>;
    state.claimError = null;

    await expect(
      resendAgentInvite({ promoterId: "agent-1", actorId: "admin-1" }),
    ).rejects.toMatchObject({ code: "RESEND_CLAIM_MALFORMED" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("propagates error when generateLink throws (non-fatal: still sends with null actionLink)", async () => {
    state.agentRow = makeAgent();

    mocks.generateLink.mockImplementation(async () => {
      throw new Error("supabase down");
    });

    const result = await resendAgentInvite({ promoterId: "agent-1", actorId: "admin-1" });

    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = fetchBody();
    expect(body).not.toContain("https://auth.example/recovery");
  });

  it("returns emailSent:false when Resend returns 5xx (audit row still claimed)", async () => {
    state.agentRow = makeAgent();
    state.fetchResult = { ok: false, status: 500 };

    const result = await resendAgentInvite({ promoterId: "agent-1", actorId: "admin-1" });

    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(false);
    // The claim INSERT was made (we got past the debounce gate); the
    // audit log still records the operator's intent.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("concurrent calls: only one claims the slot, the others get RESEND_TOO_SOON", async () => {
    state.agentRow = makeAgent();
    // Simulate the atomic claim: first call returns 1 row, all
    // subsequent calls within the same window return 0 rows. (The real
    // Postgres RPC guarantees this at the SQL layer; we model the
    // contract here by branching on the invocation counter.)
    state.claimResult = null; // initial — overridden below per call
    state.claimError = null;
    const realRpc = (await import("../../config.js")).affiliateSupabase.rpc;
    (await import("../../config.js")).affiliateSupabase.rpc = ((fn: string) => {
      if (fn !== "claim_agent_invite_send") return realRpc(fn as never);
      state.claimCallCount += 1;
      if (state.claimCallCount === 1) {
        return Promise.resolve({
          data: [{ id: "send-1", created_at: new Date().toISOString() }],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    }) as typeof realRpc;

    try {
      const results = await Promise.allSettled([
        resendAgentInvite({ promoterId: "agent-1", actorId: "admin-A" }),
        resendAgentInvite({ promoterId: "agent-1", actorId: "admin-B" }),
        resendAgentInvite({ promoterId: "agent-1", actorId: "admin-C" }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(2);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "RESEND_TOO_SOON" });
      }
      // Only the winning call should have invoked fetch (the Resend send).
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      (await import("../../config.js")).affiliateSupabase.rpc = realRpc;
    }
  });
});

// ---- Task 3.2: templated notifications ----
//
// Tests for the db-driven notifyKol* flow. The shared mock provides a
// default template row + promoter snapshot; we override the per-test
// state to exercise the opt-out path, the missing-template path, and
// the retry path.

describe("notifyKolCommissionPending (templated)", () => {
  it("sends email + writes affiliate_email_sends row on success", async () => {
    await notifyKolCommissionPending({
      email: "kol@example.com",
      name: "K",
      amount: 25.5,
      currency: "USD",
      orderId: "order-1",
      promoterId: "p-1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = fetchBody();
    expect(body).toContain("kol@example.com");
    expect(body).toContain("25.50 USD");
    expect(body).toContain("order-1");

    expect(state.emailSendInserts).toHaveLength(1);
    const row = state.emailSendInserts[0];
    expect(row.category).toBe("commission_pending");
    expect(row.template_id).toBe("tmpl-1");
    expect(row.to_email).toBe("kol@example.com");
    expect(row.promoter_id).toBe("p-1");
    expect(row.sent_at).toBeTruthy();
    expect(row.last_error).toBeNull();
  });

  it("skips when notification_prefs[commission_pending] === false", async () => {
    state.notificationPrefs = { commission_pending: false };

    await notifyKolCommissionPending({
      email: "kol@example.com",
      name: "K",
      amount: 25.5,
      currency: "USD",
      orderId: "order-1",
      promoterId: "p-1",
    });

    // No Resend call, no log row.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.emailSendInserts).toHaveLength(0);
  });

  it("returns false (no log) when template row is missing", async () => {
    state.templateRow = null;

    await notifyKolCommissionPending({
      email: "kol@example.com",
      name: "K",
      amount: 25.5,
      currency: "USD",
      orderId: "order-1",
      promoterId: "p-1",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.emailSendInserts).toHaveLength(0);
  });
});

describe("notifyKolPayoutSent (templated)", () => {
  it("writes last_error when all 3 Resend attempts fail", async () => {
    // sendEmailWithRetry waits 1s + 4s between 3 attempts; vi.useFakeTimers
    // collapses both setTimeout waits to microtasks so the test stays
    // sub-second. The retry count + outcome are what we're asserting.
    vi.useFakeTimers();
    state.fetchResult = { ok: false, status: 502 };

    const pending = notifyKolPayoutSent({
      email: "kol@example.com",
      name: "K",
      amount: 100,
      currency: "USD",
      promoterId: "p-1",
    });
    // Drain microtasks + scheduled timers in order.
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();

    expect(fetchSpy).toHaveBeenCalledTimes(3); // 3 attempts
    expect(state.emailSendInserts).toHaveLength(1);
    const row = state.emailSendInserts[0];
    expect(row.category).toBe("payout_sent");
    expect(row.sent_at).toBeNull();
    expect(row.last_error).toBe("send failed after 3 attempts");
  });
});

describe("notifyKolNewReferral (templated)", () => {
  it("renders template with no amount/order placeholders", async () => {
    state.templateRow = {
      id: "tmpl-ref",
      subject: "New referral signup",
      body: "<p>Hi {{name}}, someone signed up via your link.</p>",
    };

    await notifyKolNewReferral({ email: "kol@example.com", name: "K", promoterId: "p-1" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = fetchBody();
    expect(body).toContain("Hi K, someone signed up via your link.");
    expect(state.emailSendInserts).toHaveLength(1);
    expect(state.emailSendInserts[0].category).toBe("new_referral");
  });
});

// R1 final review Fix 2: {{name}} and {{dispute_reason}} in the KOL email
// are user/Stripe-controlled (promoters.name is KOL-edited; dispute.reason
// is Stripe-supplied free-text). The substitution helper must HTML-escape
// them BEFORE rendering into the email body, otherwise an attacker KOL
// can inject <script> via their profile name and phish other admins
// (the email is sent to the KOL themselves; not auto-forwarded to others,
// but still bad form — and the admin's html_safety net only protects
// admin-notify paths).
describe("notifyKolDisputed — R1 XSS escape for {{name}} and {{dispute_reason}} (Fix 2)", () => {
  it("HTML-escapes attacker-controlled name + Stripe dispute_reason before substitution", async () => {
    state.templateRow = {
      id: "tmpl-disputed",
      subject: "Dispute for {{name}} — {{amount}} {{currency}}",
      body: '<p>Hi {{name}}, your commission {{commission_id}} is disputed: {{dispute_reason}}.</p>',
    };
    state.promoterSnapshot = {
      id: "p-xss",
      email: "kol@example.com",
      // Attacker-controlled value (KOL edits their profile name).
      name: "<script>alert(1)</script>",
      preferred_locale: "en",
    };

    await notifyKolDisputed({
      promoterId: "p-xss",
      commissionId: "cm-xss-payload-12345678",
      amount: "50.00", // R1 Fix 1: now a pre-formatted USD string
      disputeReason: "fraudulent\" onerror=alert(2) <img src=x>",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = fetchBody();
    // The raw attacker payload must NOT appear in the rendered body.
    expect(body).not.toContain("<script>alert(1)</script>");
    // It must appear as escaped HTML entities.
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Stripe-supplied dispute_reason: < > " are escaped.
    expect(body).toContain("&lt;img src=x&gt;");
    expect(body).not.toContain('onerror=alert(2) <img');
  });
});

// F-NEW-11: commission_paid template body now has {{dashboard_url}} which
// must be substituted per role (audit found the role param was accepted
// but never forwarded into the substitution context).
describe("notifyKolCommissionPaid (templated) — F-NEW-11 dashboard_url", () => {
  it("substitutes /kol/dashboard when role='kol'", async () => {
    state.templateRow = {
      id: "tmpl-paid",
      subject: "Commission paid",
      body: '<p>Hi {{name}}, <a href="{{dashboard_url}}">view your dashboard</a>.</p>',
    };

    await notifyKolCommissionPaid({
      email: "kol@example.com",
      name: "K",
      amount: 42,
      currency: "USD",
      promoterId: "p-1",
      role: "kol",
    });

    const body = fetchBody();
    expect(body).toContain("https://portal.example.com/kol/dashboard");
    expect(body).not.toContain("{{dashboard_url}}");
    expect(state.emailSendInserts).toHaveLength(1);
    expect(state.emailSendInserts[0].category).toBe("commission_paid");
  });

  it("substitutes /agent/dashboard when role='agent'", async () => {
    state.templateRow = {
      id: "tmpl-paid",
      subject: "Commission paid",
      body: '<p>Hi {{name}}, <a href="{{dashboard_url}}">view your dashboard</a>.</p>',
    };

    await notifyKolCommissionPaid({
      email: "agent@example.com",
      name: "A",
      amount: 100,
      currency: "USD",
      promoterId: "p-2",
      role: "agent",
    });

    const body = fetchBody();
    expect(body).toContain("https://portal.example.com/agent/dashboard");
    expect(body).not.toContain("{{dashboard_url}}");
  });

  it("defaults to /kol/dashboard when role is omitted (back-compat)", async () => {
    state.templateRow = {
      id: "tmpl-paid",
      subject: "Commission paid",
      body: '<p><a href="{{dashboard_url}}">view</a></p>',
    };

    await notifyKolCommissionPaid({
      email: "kol@example.com",
      name: "K",
      amount: 10,
      promoterId: "p-1",
      // role intentionally omitted
    });

    const body = fetchBody();
    expect(body).toContain("https://portal.example.com/kol/dashboard");
  });
});

// ---- Sanity check on the SQL source ----
//
// The race fix lives at the SQL boundary. We mock the RPC in the tests
// above (no local Postgres in this environment), but we MUST ensure the
// real migration still carries the per-key advisory lock — otherwise
// the test above silently passes against an unguarded RPC. This is a
// cheap string check; a real integration test would require a Supabase
// local instance.
describe("claim_agent_invite_send migration SQL", () => {
  const sqlPath = resolve(
    __dirname,
    "../../../../supabase/migrations/20260813000005_claim_agent_invite_send.sql",
  );

  it("contains pg_advisory_xact_lock (race fix must not regress)", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toMatch(/pg_advisory_xact_lock/);
  });

  it("uses xact-scoped advisory lock (not session-scoped which leaks)", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    expect(sql).not.toMatch(/pg_advisory_lock\b(?!_)/); // session-scoped lock forbidden
  });
});