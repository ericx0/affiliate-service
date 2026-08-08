import { describe, it, expect, vi } from "vitest";

const { toBufferMock } = vi.hoisted(() => ({
  toBufferMock: vi.fn(async (_text: string, _opts: unknown) => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
}));

vi.mock("qrcode", () => ({
  default: { toBuffer: toBufferMock },
}));

import { generateQrPngBuffer } from "./qr.service.js";

describe("generateQrPngBuffer", () => {
  it("delegates to qrcode.toBuffer with type=png, width=512, margin=2", async () => {
    await generateQrPngBuffer("https://example.com/?ref=ABC12345");
    expect(toBufferMock).toHaveBeenCalledWith(
      "https://example.com/?ref=ABC12345",
      { type: "png", width: 512, margin: 2 },
    );
  });

  it("returns the buffer produced by qrcode.toBuffer", async () => {
    const buf = await generateQrPngBuffer("x");
    expect(buf.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });
});