import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSessionFromThread: vi.fn(),
  toPdf: vi.fn(),
  browserState: vi.fn(),
  hasCustomRenderer: vi.fn(),
  specializedOverlayFallback: vi.fn(),
}));

vi.mock("@qingagent/core", () => ({
  loadSessionFromThread: mocks.loadSessionFromThread,
  redactSensitiveText: (value: string) => value,
}));

vi.mock("@qingagent/doc-render", () => ({
  BrowserCapabilityUnavailableError: class extends Error {},
  getBrowserCapabilityState: mocks.browserState,
  hasHtmlToPdfRenderer: mocks.hasCustomRenderer,
  hasSpecializedDiagramOverlayFallback: mocks.specializedOverlayFallback,
  SPECIALIZED_DIAGRAM_OVERLAY_NOTICE: "specialized-diagram-overlay",
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
    mocks.specializedOverlayFallback.mockReturnValue(false);
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

  it.each([
    {
      code: "EXPORT_BUSY",
      status: 503,
      expected: { code: "EXPORT_BUSY", retryable: true },
    },
    {
      code: "EXPORT_DEADLINE_EXCEEDED",
      status: 504,
      expected: { code: "EXPORT_DEADLINE_EXCEEDED", retryable: true },
    },
  ])("PDF 的 $code 返回可区分错误而非泛化 500", async ({ code, status, expected }) => {
    mocks.browserState.mockReturnValue({
      status: "available",
      sandbox: "required",
      reason: null,
    });
    mocks.loadSessionFromThread.mockResolvedValue({
      sessionId: "session-1",
      title: "导出测试",
      doc: null,
      legacySections: [{ kind: "p", data: { text: "正文" } }],
    });
    mocks.toPdf.mockRejectedValue(Object.assign(new Error(code), { code }));
    const { exportRoutes } = await import("../routes/export.js");
    const app = new Hono().route("/api/v1", exportRoutes);

    const response = await app.request("/api/v1/export/session-1?format=pdf");

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject(expected);
    if (code === "EXPORT_BUSY") expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("专有语义图回退官方布局时在导出响应附提示", async () => {
    mocks.browserState.mockReturnValue({
      status: "available",
      sandbox: "required",
      reason: null,
    });
    mocks.specializedOverlayFallback.mockReturnValue(true);
    mocks.loadSessionFromThread.mockResolvedValue({
      sessionId: "session-1",
      title: "导出测试",
      doc: null,
      legacySections: [{ kind: "p", data: { text: "正文" } }],
    });
    mocks.toPdf.mockResolvedValue(Buffer.from("pdf"));
    const { exportRoutes } = await import("../routes/export.js");
    const app = new Hono().route("/api/v1", exportRoutes);

    const response = await app.request("/api/v1/export/session-1?format=pdf");

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Qingagent-Export-Notice")).toBe("specialized-diagram-overlay");
  });
});
