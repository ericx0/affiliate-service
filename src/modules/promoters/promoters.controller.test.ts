import { describe, it, expect, vi, beforeEach } from "vitest";

// createAgent: auth-user creation, email-exists degradation, promoter RPC,
// agent_invite_code readback, recovery link generation, welcome email.

const { state, mocks } = vi.hoisted(() => ({
  state: {
    createUserResult: { data: { user: { id: "u-new" } }, error: null } as any,
    listUsersResult: { data: { users: [] as Array<{ id: string; email?: string }> }, error: null } as any,
    rpcResult: { data: { id: "ag-1", code: "REFCODE1" }, error: null } as any,
    inviteCodeRow: { agent_invite_code: "AB12CD34EF56" } as any,
    generateLinkResult: {
      data: { properties: { action_link: "https://auth.linkchinamed.com/recovery?token=abc" } },
      error: null,
    } as any,
  },
  mocks: {
    createUser: vi.fn(),
    listUsers: vi.fn(),
    deleteUser: vi.fn(),
    generateLink: vi.fn(),
    rpc: vi.fn(),
    notifyAgentWelcome: vi.fn(async (_payload: any) => {}),
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
  },
  supabase: {
    auth: {
      admin: {
        createUser: (...args: any[]) => mocks.createUser(...args),
        listUsers: (...args: any[]) => mocks.listUsers(...args),
        deleteUser: (...args: any[]) => mocks.deleteUser(...args),
        generateLink: (...args: any[]) => mocks.generateLink(...args),
      },
    },
    rpc: (fn: string, params?: Record<string, any>) => mocks.rpc(fn, params),
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (table !== "promoters") throw new Error("unmocked table " + table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.inviteCodeRow, error: null }),
          }),
        }),
      };
    },
  },
}));

vi.mock("../notifications/notifications.service.js", () => ({
  notifyAgentWelcome: (payload: any) => mocks.notifyAgentWelcome(payload),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { createAgent } from "./promoters.controller.js";

function makeReqRes(body: Record<string, any> = {}) {
  const req: any = {
    body: {
      name: "Agent Li",
      email: "agent@example.com",
      password: "Sup3rSecret!",
      agent_level: "senior",
      ...body,
    },
  };
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.createUserResult = { data: { user: { id: "u-new" } }, error: null };
  state.listUsersResult = { data: { users: [] }, error: null };
  state.rpcResult = { data: { id: "ag-1", code: "REFCODE1" }, error: null };
  state.inviteCodeRow = { agent_invite_code: "AB12CD34EF56" };
  state.generateLinkResult = {
    data: { properties: { action_link: "https://auth.linkchinamed.com/recovery?token=abc" } },
    error: null,
  };
  mocks.createUser.mockImplementation(async () => state.createUserResult);
  mocks.listUsers.mockImplementation(async () => state.listUsersResult);
  mocks.deleteUser.mockImplementation(async () => ({ error: null }));
  mocks.generateLink.mockImplementation(async () => state.generateLinkResult);
  mocks.rpc.mockImplementation(async () => state.rpcResult);
});

describe("createAgent", () => {
  it("new email: creates auth user + promoter, sends welcome email with invite code + password link", async () => {
    const { req, res } = makeReqRes();
    await createAgent(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.auth_user_id).toBe("u-new");
    expect(res.body.agent_level).toBe("senior");
    expect(res.body.commission_rate).toBe(8.0);

    // Promoter RPC bound to the new auth user.
    expect(mocks.rpc).toHaveBeenCalledWith(
      "affiliate_create_promoter",
      expect.objectContaining({ p_auth_user_id: "u-new", p_role: "agent", p_agent_level: "senior" }),
    );

    // Recovery link generated (no plaintext password anywhere in the email payload).
    expect(mocks.generateLink).toHaveBeenCalledWith({ type: "recovery", email: "agent@example.com" });
    expect(mocks.notifyAgentWelcome).toHaveBeenCalledWith({
      name: "Agent Li",
      email: "agent@example.com",
      inviteCode: "AB12CD34EF56",
      actionLink: "https://auth.linkchinamed.com/recovery?token=abc",
    });
    const emailPayload = JSON.stringify(mocks.notifyAgentWelcome.mock.calls[0][0]);
    expect(emailPayload).not.toContain("Sup3rSecret!");

    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it("email already registered: reuses the existing auth user and still returns 201", async () => {
    state.createUserResult = { data: { user: null }, error: { code: "email_exists", message: "User already registered" } };
    state.listUsersResult = { data: { users: [{ id: "u-existing", email: "agent@example.com" }] }, error: null };

    const { req, res } = makeReqRes();
    await createAgent(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.auth_user_id).toBe("u-existing");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "affiliate_create_promoter",
      expect.objectContaining({ p_auth_user_id: "u-existing" }),
    );
    expect(mocks.notifyAgentWelcome).toHaveBeenCalledTimes(1);
  });

  it("promoter already exists (email reused): returns 409 AGENT_EXISTS, never deletes the pre-existing auth user", async () => {
    state.createUserResult = { data: { user: null }, error: { code: "email_exists", message: "User already registered" } };
    state.listUsersResult = { data: { users: [{ id: "u-existing", email: "agent@example.com" }] }, error: null };
    state.rpcResult = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };

    const { req, res } = makeReqRes();
    await createAgent(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("AGENT_EXISTS");
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.notifyAgentWelcome).not.toHaveBeenCalled();
  });

  it("generateLink failure: welcome email still sent without the password link (degraded copy)", async () => {
    state.generateLinkResult = { data: null, error: { message: "smtp not configured" } };

    const { req, res } = makeReqRes();
    await createAgent(req, res);

    expect(res.statusCode).toBe(201);
    expect(mocks.notifyAgentWelcome).toHaveBeenCalledWith(
      expect.objectContaining({ actionLink: null, inviteCode: "AB12CD34EF56" }),
    );
  });
});
