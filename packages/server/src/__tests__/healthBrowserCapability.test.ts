import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  browserState: vi.fn(),
  hasCustomRenderer: vi.fn(),
}));

vi.mock("@qingagent/doc-render", () => ({
  getBrowserCapabilityState: mocks.browserState,
  hasHtmlToPdfRenderer: mocks.hasCustomRenderer,
}));

describe("健康状态中的浏览器能力", () => {
  beforeEach(() => {
    mocks.browserState.mockReturnValue({
      status: "unavailable",
      sandbox: "required",
      reason: "浏览器无法在当前环境启动；PDF 导出等浏览器能力已禁用",
    });
    mocks.hasCustomRenderer.mockReturnValue(false);
  });

  it("启动探测失败时明示浏览器禁用与 PDF 不可用", async () => {
    const { healthRoutes } = await import("../routes/health.js");
    const response = await healthRoutes.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      capabilities: {
        browser: {
          status: "unavailable",
          sandbox: "required",
          reason: "浏览器无法在当前环境启动；PDF 导出等浏览器能力已禁用",
        },
        pdfExport: {
          enabled: false,
          renderer: "playwright",
        },
      },
    });
  });
});
