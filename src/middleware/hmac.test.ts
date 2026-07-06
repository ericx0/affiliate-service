import { describe, it, expect, vi } from "vitest";
import { Request, Response } from "express";
import crypto from "node:crypto";
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

describe("hmacMiddleware", () => {
  const SECRET = "test-secret-32-chars-long-xxxxx";

  it("accepts valid signature", () => {
    const body = '{"orderId":"abc"}';
    const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    const req = mockReq({ "x-lcm-signature": `sha256=${sig}` }, body);
    const res = mockRes();
    const next = vi.fn();

    hmacMiddleware(SECRET)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects invalid signature", () => {
    const req = mockReq({ "x-lcm-signature": "sha256=invalid" }, '{"orderId":"abc"}');
    const res = mockRes();
    const next = vi.fn();

    hmacMiddleware(SECRET)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects missing signature", () => {
    const req = mockReq({}, '{"orderId":"abc"}');
    const res = mockRes();
    const next = vi.fn();

    hmacMiddleware(SECRET)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});