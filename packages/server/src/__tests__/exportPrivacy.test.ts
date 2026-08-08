import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSessionFromThread: vi.fn(),
  redactSensitiveText: vi.fn(() => "api_key=*** sk-live-export-secret"),
  toTxt: vi.fn(),
}));

vi.mock("@qingagent/core", () => ({
  hasCanonicalDoc: (value: { doc?: { content?: unknown[] } }) => Boolean(value.doc?.content?.length),
  loadSessionFromThread: mocks.loadSessionFromThread,
  redactSensitiveText: mocks.redactSensitiveText,
}));

vi.mock("@qingagent/doc-render", () => ({
  toDocx: vi.fn(),
  toHtml: vi.fn(),
  toMarkdown: vi.fn(),
  toPdf: vi.fn(),
  toTxt: mocks.toTxt,
  withRenderedDiagrams: vi.fn(),
}));

vi.mock("../gateway/bridgeHandler", () => ({
  getSession: vi.fn(() => undefined),
}));

describe("export 错误信息边界", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSessionFromThread.mockResolvedValue({
      sessionId: "export-private-error",
      title: "导出测试",
      doc: { type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }] },
    });
    mocks.toTxt.mockImplementation(() => {
      throw new Error("api_key=private-export-key sk-live-export-secret");
    });
  });

  it("500 响应只含统一中文提示和错误码，脱敏细节仅写日志", async () => {
    const { exportRoutes } = await import("../routes/export");
    const app = new Hono().route("/api/v1", exportRoutes);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await app.request(
        "/api/v1/export/export-private-error?format=txt",
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "导出失败，请重试",
        code: "EXPORT_RENDER_FAILED",
      });
      expect(mocks.redactSensitiveText).toHaveBeenCalledWith(
        expect.stringContaining("api_key=private-export-key sk-live-export-secret"),
      );
      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).toContain("EXPORT_RENDER_FAILED");
      expect(logged).not.toContain("private-export-key");
      expect(logged).not.toContain("sk-live-export-secret");
    } finally {
      consoleError.mockRestore();
    }
  });
});
