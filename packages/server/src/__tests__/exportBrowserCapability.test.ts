import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSessionFromThread: vi.fn(),
  toPdf: vi.fn(),
  browserState: vi.fn(),
  hasCustomRenderer: vi.fn(),
}));

vi.mock("@qingagent/core", () => ({
  loadSessionFromThread: mocks.loadSessionFromThread,
  redactSensitiveText: (value: string) => value,
}));

vi.mock("@qingagent/doc-render", () => ({
  BrowserCapabilityUnavailableError: class extends Error {},
  getBrowserCapabilityState: mocks.browserState,
  hasHtmlToPdfRenderer: mocks.hasCustomRenderer,
  toDocx: vi.fn(),
  toHtml: vi.fn(),
  toMarkdown: vi.fn(),
  toPdf: mocks.toPdf,
  toTxt: vi.fn(),
  withRenderedDiagrams: vi.fn(),
}));

vi.mock("../gateway/bridgeHandler", () => ({
  getSession: vi.fn(() => undefined),
}));

describe("PDF 导出浏览器能力门", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.browserState.mockReturnValue({
      status: "unavailable",
      sandbox: "required",
      reason: "浏览器无法在当前环境启动；PDF 导出等浏览器能力已禁用",
    });
    mocks.hasCustomRenderer.mockReturnValue(false);
  });

  it("启动探测失败后返回可读 503，不进入渲染也不裸 500", async () => {
    const { exportRoutes } = await import("../routes/export.js");
    const app = new Hono().route("/api/v1", exportRoutes);
    const response = await app.request("/api/v1/export/session-1?format=pdf");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining("PDF 导出能力不可用"),
      code: "BROWSER_CAPABILITY_UNAVAILABLE",
    });
    expect(mocks.loadSessionFromThread).not.toHaveBeenCalled();
    expect(mocks.toPdf).not.toHaveBeenCalled();
  });
});
