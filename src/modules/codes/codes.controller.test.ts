import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as Array<Record<string, any>>,
    nextError: null as { message: string } | null,
    lastQuery: null as { id: string; promoterId: string } | null,
    qrInput: null as string | null,
    qrBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    qrError: null as Error | null,
  },
}));

vi.mock("../../config.js", () => ({
  env: { LOG_LEVEL: "warn", NODE_ENV: "test", WEB_URL: "https://example.test" },
  affiliateSupabase: {
    from: (table: string) => {
      if (table !== "referral_codes") throw new Error("unmocked table " + table);
      return {
        select: () => ({
          eq: (_col: string, val: string) => ({
            eq: (_col2: string, val2: string) => ({
              maybeSingle: async () => {
                state.lastQuery = { id: val, promoterId: val2 };
                if (state.nextError) return { data: null, error: state.nextError };
                const row = state.rows.find((r) => r.id === val && r.promoter_id === val2);
                return { data: row ?? null, error: null };
              },
            }),
          }),
        }),
      };
    },
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock("./qr.service.js", () => ({
  generateQrPngBuffer: async (text: string) => {
    state.qrInput = text;
    if (state.qrError) throw state.qrError;
    return state.qrBuffer;
  },
}));

import { getCodeQr } from "./codes.controller.js";

function makeReqRes(promoterId: string | undefined, codeId: string) {
  const req: any = {
    promoter: promoterId ? { id: promoterId, email: "kol@example.com", status: "active" } : undefined,
    params: { codeId },
  };
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
    send(buf: Buffer) {
      this.body = buf;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
  };
  return { req, res };
}

beforeEach(() => {
  state.rows = [];
  state.nextError = null;
  state.lastQuery = null;
  state.qrInput = null;
  state.qrBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  state.qrError = null;
});

describe("getCodeQr", () => {
  const VALID_UUID = "11111111-1111-1111-1111-111111111111";

  it("returns a PNG buffer with image/png content-type for a valid code", async () => {
    state.rows = [{ id: VALID_UUID, promoter_id: "p1", code: "ABC12345" }];
    const { req, res } = makeReqRes("p1", VALID_UUID);
    await getCodeQr(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/png");
    expect(res.headers["Cache-Control"]).toBe("public, max-age=86400");
    expect(res.body.equals(state.qrBuffer)).toBe(true);
    expect(state.qrInput).toBe("https://example.test/?ref=ABC12345");
  });

  it("returns 404 CODE_NOT_FOUND when the code belongs to another promoter", async () => {
    state.rows = [{ id: VALID_UUID, promoter_id: "other-p", code: "ABC12345" }];
    const { req, res } = makeReqRes("p1", VALID_UUID);
    await getCodeQr(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe("CODE_NOT_FOUND");
    expect(state.qrInput).toBeNull();
  });

  it("returns 404 CODE_NOT_FOUND when the code does not exist", async () => {
    state.rows = [];
    const { req, res } = makeReqRes("p1", VALID_UUID);
    await getCodeQr(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe("CODE_NOT_FOUND");
  });

  it("returns 401 when no promoter is attached to the request", async () => {
    const { req, res } = makeReqRes(undefined, VALID_UUID);
    await getCodeQr(req, res);
    expect(res.statusCode).toBe(401);
    expect(state.qrInput).toBeNull();
  });

  it("returns 400 when codeId is not a uuid", async () => {
    const { req, res } = makeReqRes("p1", "not-a-uuid");
    await getCodeQr(req, res);
    expect(res.statusCode).toBe(400);
    expect(state.lastQuery).toBeNull();
  });

  it("encodes the actual code into the landing URL passed to the QR service", async () => {
    state.rows = [{ id: VALID_UUID, promoter_id: "p1", code: "ZZZZ9999" }];
    const { req, res } = makeReqRes("p1", VALID_UUID);
    await getCodeQr(req, res);
    expect(state.qrInput).toBe("https://example.test/?ref=ZZZZ9999");
  });

  it("returns 500 with a generic message when the QR service throws", async () => {
    state.rows = [{ id: VALID_UUID, promoter_id: "p1", code: "ABC12345" }];
    state.qrError = new Error("renderer exploded");
    const { req, res } = makeReqRes("p1", VALID_UUID);
    await getCodeQr(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("QR_GENERATION_FAILED");
    expect(res.body.error.message).toBe("Internal server error");
  });

  it("returns 500 with a generic message when the lookup errors", async () => {
    state.nextError = { message: "permission denied for table referral_codes" };
    const { req, res } = makeReqRes("p1", VALID_UUID);
    await getCodeQr(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("QUERY_FAILED");
    // Internal error helper must NOT leak the underlying message
    expect(res.body.error.message).toBe("Internal server error");
  });
});