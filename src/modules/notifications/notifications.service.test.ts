import { describe, it, expect, vi, beforeEach } from "vitest";

const { state, mocks } = vi.hoisted(() => ({
  state: {
    agentRow: null as null | { id: string; name: string; email: string; agent_invite_code: string; preferred_locale: string; role: string },
    lastSendRow: null as null | { created_at: string },
    generateLinkResult: { data: { properties: { action_link: "https://auth.example/recovery?token=abc" } }, error: null } as any,
    insertedRows: [] as Array<Record<string, unknown>>,
    fetchResult: { ok: true, status: 200 } as { ok: boolean; status: number },
  },
  mocks: {
    generateLink: vi.fn(),
    notifyAgentWelcome: vi.fn(async (_payload: any) => {}),
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
      if (table === "affiliate_email_sends") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: state.lastSendRow, error: null }),
                  }),
                }),
              }),
            }),
          }),
          insert: (row: any) => {
            state.insertedRows.push(row);
            return Promise.resolve({ error: null });
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
  },
}));

vi.mock("../admin/audit.service.js", () => ({
  writeAuditLog: async () => true,
}));

// notifyAgentWelcome is not mocked here — we exercise it directly. It
// only depends on fetch (stubbed) + env (RESEND_API_KEY set). The spy
// below verifies it was called with the expected payload by wrapping
// global fetch and inspecting the request.
const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { resendAgentInvite } from "./notifications.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.agentRow = null;
  state.lastSendRow = null;
  state.insertedRows = [];
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
  it("rejects when no recent send within 60s (RESEND_TOO_SOON)", async () => {
    state.agentRow = {
      id: "agent-1",
      name: "X",
      email: "x@e.com",
      agent_invite_code: "AB12",
      preferred_locale: "en",
      role: "agent",
    };
    state.lastSendRow = { created_at: new Date(Date.now() - 30_000).toISOString() };

    await expect(
      resendAgentInvite({ promoterId: "agent-1", actorId: "admin-1" }),
    ).rejects.toMatchObject({ code: "RESEND_TOO_SOON" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends email + writes affiliate_email_sends + audit on success", async () => {
    state.agentRow = {
      id: "agent-1",
      name: "X",
      email: "x@e.com",
      agent_invite_code: "AB12",
      preferred_locale: "en",
      role: "agent",
    };
    state.lastSendRow = null;

    const result = await resendAgentInvite({ promoterId: "agent-1", actorId: "admin-1" });

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = fetchBody();
    expect(body).toContain("x@e.com");
    expect(body).toContain("AB12");
    expect(state.insertedRows).toHaveLength(1);
    expect(state.insertedRows[0]).toMatchObject({
      promoter_id: "agent-1",
      template_id: null,
      to_email: "x@e.com",
      category: "agent_invite",
    });
  });

  it("throws AGENT_NOT_FOUND when promoter row missing", async () => {
    state.agentRow = null;

    await expect(
      resendAgentInvite({ promoterId: "missing", actorId: "admin-1" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.insertedRows).toHaveLength(0);
  });

  it("propagates error when generateLink throws (non-fatal: still sends with null actionLink)", async () => {
    state.agentRow = {
      id: "agent-1",
      name: "X",
      email: "x@e.com",
      agent_invite_code: "AB12",
      preferred_locale: "en",
      role: "agent",
    };
    state.lastSendRow = null;

    // generateLink rejection is swallowed in resendAgentInvite (best-effort);
    // we should still call notifyAgentWelcome (which calls fetch) with
    // actionLink=null and write the audit row.
    mocks.generateLink.mockImplementation(async () => {
      throw new Error("supabase down");
    });

    const result = await resendAgentInvite({ promoterId: "agent-1", actorId: "admin-1" });

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Action link should NOT appear in the email body when generateLink failed.
    const body = fetchBody();
    expect(body).not.toContain("https://auth.example/recovery");
    expect(state.insertedRows).toHaveLength(1);
  });
});