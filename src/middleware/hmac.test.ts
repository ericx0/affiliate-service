import { describe, it, expect, vi } from "vitest";
import { Request, Response } from "express";
import crypto from "node:crypto";

// Mock supabase - HMAC nonce dedup hits the hmac_nonces table (AS-P0-2).
// Without this the middleware tries to INSERT against a real DB.
vi.mock("../config.js", () => ({
  env: { LOG_LEVEL: "info", NODE_ENV: "test" },
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
    })),
  },
}));

import { hmacMiddleware } from "./hmac.js";

function mockReq(headers: Record<string, string>, body: string = ""): Request {
  return {
    headers,
    rawBody: body,
  } as unknown as Request;
}

function mockRes(): Response {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as Response;
}

const SECRET = "test-secret-32-chars-long-xxxxx";

function sign(body: string, ts: number, nonce: string): string {
  // Signed payload is `${ts}.${nonce}.${rawBody}` (AS-P0-2).
  return crypto.createHmac("sha256", SECRET).update(`${ts}.${nonce}.${body}`).digest("hex");
}

describe("hmacMiddleware", () => {
  it("accepts valid signature with timestamp + nonce", async () => {
    const body = '{"orderId":"abc"}';
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "a".repeat(32);
    const req = mockReq({
      "x-lcm-signature": `sha256=${sign(body, ts, nonce)}`,
      "x-lcm-timestamp": String(ts),
      "x-lcm-nonce": nonce,
    }, body);
    const res = mockRes();
    const next = vi.fn();

    await hmacMiddleware(SECRET)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects invalid signature", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "b".repeat(32);
    const req = mockReq({
      "x-lcm-signature": "sha256=invalid",
      "x-lcm-timestamp": String(ts),
      "x-lcm-nonce": nonce,
    }, '{"orderId":"abc"}');
    const res = mockRes();
    const next = vi.fn();

    await hmacMiddleware(SECRET)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects missing signature", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "c".repeat(32);
    const req = mockReq({
      "x-lcm-timestamp": String(ts),
      "x-lcm-nonce": nonce,
    }, '{"orderId":"abc"}');
    const res = mockRes();

    await hmacMiddleware(SECRET)(req, res, (() => {}) as any);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects missing X-LCM-Timestamp", async () => {
    const body = '{"orderId":"abc"}';
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "d".repeat(32);
    const req = mockReq({
      "x-lcm-signature": `sha256=${sign(body, ts, nonce)}`,
      "x-lcm-nonce": nonce,
    }, body);
    const res = mockRes();
    const next = vi.fn();

    await hmacMiddleware(SECRET)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects stale timestamp (>5min)", async () => {
    const body = '{"orderId":"abc"}';
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const nonce = "e".repeat(32);
    const req = mockReq({
      "x-lcm-signature": `sha256=${sign(body, staleTs, nonce)}`,
      "x-lcm-timestamp": String(staleTs),
      "x-lcm-nonce": nonce,
    }, body);
    const res = mockRes();
    const next = vi.fn();

    await hmacMiddleware(SECRET)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
