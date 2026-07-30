import { describe, it, expect, vi } from "vitest";

vi.mock("../../config.js", () => ({
  env: { LOG_LEVEL: "warn", NODE_ENV: "test" },
  affiliateSupabase: {
    from: (table: string) => {
      if (table !== "tax_forms") throw new Error("unmocked table " + table);
      return {
        select: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      };
    },
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { getMyTaxDocs } from "./tax-docs.controller.js";

function makeReqRes() {
  const req: any = {};
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) {
      if (this.statusCode === 0) this.statusCode = 200;
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

describe("GET /me/tax-docs — pending state", () => {
  it("returns 5 years descending, all status=pending (tax service not yet integrated)", async () => {
    const { req, res } = makeReqRes();
    await getMyTaxDocs(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(5);
    const currentYear = new Date().getUTCFullYear();
    expect(res.body.data.map((d: any) => d.year)).toEqual([
      currentYear, currentYear - 1, currentYear - 2, currentYear - 3, currentYear - 4,
    ]);
    for (const d of res.body.data) {
      expect(d.form_type).toBe("1099-NEC");
      expect(d.status).toBe("pending");
      expect(d.url).toBeNull();
      expect(d.generated_at).toBeNull();
    }
  });
});