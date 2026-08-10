import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockResponse = {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
};

const { state } = vi.hoisted(() => ({
  state: {
    rpcData: null as Array<{ role: "kol" | "agent" | null; registered: boolean }> | null,
    rpcError: null as { code: string; message: string } | null,
    rpc: vi.fn(),
  },
}));

vi.mock("../../config.js", () => ({
  supabase: {
    rpc: state.rpc,
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { error: vi.fn() },
}));

import { checkEmail } from "./check-email.controller.js";

function makeReqRes(options: {
  email?: unknown;
  token?: string;
  ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers["x-turnstile-token"] = options.token;
  if (options.ip) headers["cf-connecting-ip"] = options.ip;

  const req = {
    query: options.email === undefined ? {} : { email: options.email },
    ip: "127.0.0.1",
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
  const res: MockResponse = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return { req, res: res as MockResponse & Response };
}

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
  state.rpcData = null;
  state.rpcError = null;
  state.rpc.mockReset();
  state.rpc.mockImplementation(async () => ({ data: state.rpcData, error: state.rpcError }));
  vi.stubGlobal("fetch", vi.fn(async () => ({
    json: async () => ({ success: true }),
  })));
});

describe("checkEmail", () => {
  it("returns 400 for a missing email", async () => {
    const { req, res } = makeReqRes({ token: "token" });

    await checkEmail(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid email" },
    });
  });

  it("returns 400 for a malformed email", async () => {
    const { req, res } = makeReqRes({ email: "not-an-email", token: "token" });

    await checkEmail(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid email" },
    });
  });

  it("returns 403 when the Turnstile token is missing", async () => {
    const { req, res } = makeReqRes({ email: "kol@example.com" });

    await checkEmail(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: { code: "TURNSTILE_FAILED", message: "Turnstile token required" },
    });
  });

  it("returns 403 when Turnstile verification fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({ success: false }),
    })));
    const { req, res } = makeReqRes({ email: "kol@example.com", token: "invalid" });

    await checkEmail(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: { code: "TURNSTILE_FAILED", message: "Turnstile verification failed" },
    });
  });

  it("returns the anti-enumeration response for an unregistered email", async () => {
    state.rpcData = [{ role: null, registered: false }];
    const { req, res } = makeReqRes({ email: "unknown@example.com", token: "valid" });

    await checkEmail(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ exists: false, role: null, registered: false });
  });

  it("returns a registered KOL match", async () => {
    state.rpcData = [{ role: "kol", registered: true }];
    const { req, res } = makeReqRes({ email: "kol@example.com", token: "valid" });

    await checkEmail(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ exists: true, role: "kol", registered: true });
  });
});
