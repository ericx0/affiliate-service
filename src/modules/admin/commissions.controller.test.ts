import { describe, it, expect, vi, beforeEach } from "vitest";

// Drive postDisputeResolve via a mocked payouts.service.resolveDispute.
// The controller is the unit under test; payouts.service is its only
// collaborator (audit log is on req.adminUser which the controller reads
// via adminCtx).

const mockState = vi.hoisted(() => ({
  resolveDispute: vi.fn(),
  auditLogs: [] as Array<any>,
}));

vi.mock("../payouts/payouts.service.js", () => ({
  resolveDispute: (...args: any[]) => mockState.resolveDispute(...args),
}));

vi.mock("./audit.service.js", () => ({
  writeAuditLog: async (input: any) => {
    mockState.auditLogs.push(input);
    return true;
  },
}));

import { postDisputeResolve } from "./commissions.controller.js";

beforeEach(() => {
  mockState.resolveDispute.mockReset();
  mockState.auditLogs = [];
});

function fakeReq(body: any = {}, adminUser?: { id: string; email: string }) {
  return { params: { id: "c1" }, body, adminUser } as any;
}
function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  return res;
}

describe("postDisputeResolve — admin controller (Task 3 r1)", () => {
  it("(a) returns 401 when req.adminUser is missing", async () => {
    const req = fakeReq({ action: "won" }, undefined);
    const res = fakeRes();
    await postDisputeResolve(req as any, res as any);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(mockState.resolveDispute).not.toHaveBeenCalled();
  });

  it("(b1) returns 400 INVALID_BODY when action is missing", async () => {
    const req = fakeReq({}, { id: "admin_1", email: "ops@example.com" });
    const res = fakeRes();
    await postDisputeResolve(req as any, res as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BODY");
    expect(mockState.resolveDispute).not.toHaveBeenCalled();
  });

  it("(b2) returns 400 INVALID_BODY when action is not won/lost", async () => {
    const req = fakeReq({ action: "maybe" }, { id: "admin_1", email: "ops@example.com" });
    const res = fakeRes();
    await postDisputeResolve(req as any, res as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BODY");
  });

  it("(c) returns 200 on 'won' and calls resolveDispute with adminCtx id/email (no fallback)", async () => {
    mockState.resolveDispute.mockResolvedValue({ success: true });
    const req = fakeReq(
      { action: "won", note: "evidence accepted" },
      { id: "admin_real", email: "real@linkchinamed.com" },
    );
    const res = fakeRes();
    await postDisputeResolve(req as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockState.resolveDispute).toHaveBeenCalledWith(
      "c1",
      "won",
      "evidence accepted",
      "admin_real",
      "real@linkchinamed.com",
    );
  });

  it("(d) returns 404 COMMISSION_NOT_FOUND when service reports not found", async () => {
    mockState.resolveDispute.mockResolvedValue({ success: false, error: "COMMISSION_NOT_FOUND" });
    const req = fakeReq({ action: "won" }, { id: "admin_1", email: "ops@example.com" });
    const res = fakeRes();
    await postDisputeResolve(req as any, res as any);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe("COMMISSION_NOT_FOUND");
  });

  it("(e) returns 409 COMMISSION_NOT_DISPUTED on lost-update race", async () => {
    mockState.resolveDispute.mockResolvedValue({ success: false, error: "COMMISSION_NOT_DISPUTED" });
    const req = fakeReq({ action: "won" }, { id: "admin_1", email: "ops@example.com" });
    const res = fakeRes();
    await postDisputeResolve(req as any, res as any);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("COMMISSION_NOT_DISPUTED");
  });

  it("(f) does NOT call stripe.createReversal even on the 'lost' path through the controller", async () => {
    // The controller delegates to resolveDispute which itself does not
    // touch Stripe; this test guards against future regressions where
    // someone wires createReversal into the controller.
    mockState.resolveDispute.mockResolvedValue({ success: true });
    const req = fakeReq({ action: "lost" }, { id: "admin_1", email: "ops@example.com" });
    const res = fakeRes();
    await postDisputeResolve(req as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(mockState.resolveDispute).toHaveBeenCalledWith(
      "c1",
      "lost",
      undefined,
      "admin_1",
      "ops@example.com",
    );
    // The controller must not import / call stripe.* directly.
    expect((postDisputeResolve as any).toString()).not.toMatch(/createReversal/);
  });

  it("(g) returns 500 DB_ERROR when service reports a DB-level error", async () => {
    mockState.resolveDispute.mockResolvedValue({ success: false, error: "DB_ERROR" });
    const req = fakeReq({ action: "won" }, { id: "admin_1", email: "ops@example.com" });
    const res = fakeRes();
    await postDisputeResolve(req as any, res as any);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("DB_ERROR");
  });

  it("returns 500 INTERNAL when resolveDispute throws (unhandled exception)", async () => {
    mockState.resolveDispute.mockRejectedValue(new Error("supabase is down"));
    const req = fakeReq({ action: "won" }, { id: "admin_1", email: "ops@example.com" });
    const res = fakeRes();
    await postDisputeResolve(req as any, res as any);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
  });

  it("returns 400 MISSING_ID when :id route param is absent", async () => {
    const req: any = { params: {}, body: { action: "won" }, adminUser: { id: "admin_1", email: "ops@example.com" } };
    const res = fakeRes();
    await postDisputeResolve(req, res as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("MISSING_ID");
  });
});