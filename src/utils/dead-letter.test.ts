import { describe, it, expect, vi } from "vitest";
import { retryDeadLetterEvent } from "./dead-letter.js";

describe("dead-letter retry", () => {
  it("marks event as resolved when handler succeeds", async () => {
    // Mock the supabase calls
    vi.mock("../config.js", () => ({
      env: {
        LOG_LEVEL: "silent",
        NODE_ENV: "test",
      },
      supabase: {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: "evt1", payload: { foo: "bar" }, retry_count: 0, status: "pending" },
            error: null,
          }),
          update: vi.fn().mockReturnThis(),
        }),
      },
    }));

    const handler = vi.fn().mockResolvedValue(undefined);
    const result = await retryDeadLetterEvent("evt1", handler);

    expect(handler).toHaveBeenCalledWith({ foo: "bar" });
    expect(result.success).toBe(true);
    expect(result.status).toBe("resolved");
  });
});