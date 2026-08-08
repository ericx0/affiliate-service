import { describe, it, expect, vi, beforeEach } from "vitest";

const { state, mocks } = vi.hoisted(() => ({
  state: {
    agentRow: null as null | { id: string; name: string; email: string; agent_invite_code: string; preferred_locale: string; role: string },
    // claim rpc result: array (length 1 = success, 0 = debounce hit) or null on error.
    claimResult: null as null | Array<{ id: string; created_at: string }>,
    claimError: null as null | { message: string },
    claimCallCount: 0,
    generateLinkResult: { data: { properties: { action_link: "https://auth.example/recovery?token=abc" } }, error: null } as any,
    fetchResult: { ok: true, status: 200 } as { ok: boolean; status: number },
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
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: state.agentRow, error: null }),
              }),
            }),
          }),
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

import { resendAgentInvite } from "./notifications.service.js";

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