import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrRestoreSessionReadOnly: vi.fn(),
}));

vi.mock("../gateway/sessionLifecycle", () => ({
  getOrRestoreSessionReadOnly: mocks.getOrRestoreSessionReadOnly,
}));

import { uploadRoutes } from "../routes/upload";

describe("内部素材全文端点", () => {
  beforeEach(() => {
    mocks.getOrRestoreSessionReadOnly.mockReset();
    mocks.getOrRestoreSessionReadOnly.mockImplementation(async (sessionId: string) => {
      if (sessionId !== "persisted-session") {
        return { materials: new Map() };
      }
      return {
        materials: new Map([
          [
            "persisted-material",
            {
              text: "冷启动后恢复的素材全文",
              summary: "持久化素材摘要",
            },
          ],
        ]),
      };
    });
  });

  it("内存未命中时从只读会话快照读取素材，并保持会话隔离", async () => {
    const app = new Hono();
    app.route("/api/v1", uploadRoutes);

    const restored = await app.request(
      "/api/v1/materials/persisted-material/text?sessionId=persisted-session",
    );
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toEqual({
      text: "冷启动后恢复的素材全文",
      summary: "持久化素材摘要",
    });

    const isolated = await app.request(
      "/api/v1/materials/persisted-material/text?sessionId=other-session",
    );
    expect(isolated.status).toBe(404);
    expect(mocks.getOrRestoreSessionReadOnly).toHaveBeenNthCalledWith(
      1,
      "persisted-session",
    );
    expect(mocks.getOrRestoreSessionReadOnly).toHaveBeenNthCalledWith(
      2,
      "other-session",
    );
  });
});
