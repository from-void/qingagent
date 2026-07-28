import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSessionFromThread: vi.fn(),
  toTxt: vi.fn(() => "正文"),
}));

vi.mock("@qingagent/core", () => ({
  loadSessionFromThread: mocks.loadSessionFromThread,
  redactSensitiveText: (value: string) => value,
}));

vi.mock("@qingagent/doc-render", () => ({
  getBrowserCapabilityState: vi.fn(),
  hasSpecializedDiagramOverlayFallback: vi.fn(() => false),
  hasHtmlToPdfRenderer: vi.fn(),
  SPECIALIZED_DIAGRAM_OVERLAY_NOTICE: "图表提示",
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

describe("导出文件名 Unicode 边界", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("标题在第 80 个字素附近含 emoji 时仍返回安全 Content-Disposition", async () => {
    mocks.loadSessionFromThread.mockResolvedValue({
      sessionId: "unicode-export",
      title: `${"甲".repeat(79)}😀𠮷尾`,
      doc: null,
      legacySections: [{ kind: "p", data: { text: "正文" } }],
    });
    const { exportRoutes } = await import("../routes/export");
    const app = new Hono().route("/api/v1", exportRoutes);

    const response = await app.request("/api/v1/export/unicode-export?format=txt");

    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain(encodeURIComponent(`${"甲".repeat(79)}😀.txt`));
    expect(disposition).not.toContain("%EF%BF%BD");
  });
});
