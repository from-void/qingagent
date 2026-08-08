import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSessionFromThread: vi.fn(),
  degradation: null as null | { kind: string; description: string },
  toTxt: vi.fn((_document: unknown, options?: {
    onDegradation?: (degradation: { kind: string; description: string }) => void;
  }) => {
    if (mocks.degradation) options?.onDegradation?.(mocks.degradation);
    return "正文";
  }),
  toDocx: vi.fn(async (_document: unknown, options?: {
    onDegradation?: (degradation: { kind: string; description: string }) => void;
  }) => {
    if (mocks.degradation) options?.onDegradation?.(mocks.degradation);
    return Buffer.from("PK");
  }),
}));

vi.mock("@qingagent/core", () => ({
  hasCanonicalDoc: (value: { doc?: { content?: unknown[] } }) => Boolean(value.doc?.content?.length),
  loadSessionFromThread: mocks.loadSessionFromThread,
  redactSensitiveText: (value: string) => value,
}));

vi.mock("@qingagent/doc-render", () => ({
  getBrowserCapabilityState: vi.fn(),
  hasSpecializedDiagramOverlayFallback: vi.fn(() => false),
  hasHtmlToPdfRenderer: vi.fn(),
  SPECIALIZED_DIAGRAM_OVERLAY_NOTICE: "图表提示",
  toDocx: mocks.toDocx,
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
    mocks.degradation = null;
  });

  it("标题在第 80 个字素附近含 emoji 时仍返回安全 Content-Disposition", async () => {
    mocks.loadSessionFromThread.mockResolvedValue({
      sessionId: "unicode-export",
      title: `${"甲".repeat(79)}😀𠮷尾`,
      doc: { type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }] },
    });
    const { exportRoutes } = await import("../routes/export");
    const app = new Hono().route("/api/v1", exportRoutes);

    const response = await app.request("/api/v1/export/unicode-export?format=txt");

    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain(encodeURIComponent(`${"甲".repeat(79)}😀.txt`));
    expect(disposition).not.toContain("%EF%BF%BD");
    expect(response.headers.get("X-Qingagent-Export-Degradations")).toBeNull();
  });

  it("把导出发生点上报的结构化降级项写入响应头", async () => {
    mocks.degradation = {
      kind: "docx-columns-flattened",
      description: "分栏已拍平为纵向，原并排版式无法保留",
    };
    mocks.loadSessionFromThread.mockResolvedValue({
      sessionId: "degraded-export",
      title: "降级导出",
      doc: { type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "horizontalRule" }] },
    });
    const { exportRoutes } = await import("../routes/export");
    const app = new Hono().route("/api/v1", exportRoutes);

    const response = await app.request("/api/v1/export/degraded-export?format=docx");

    expect(response.status).toBe(200);
    const encoded = response.headers.get("X-Qingagent-Export-Degradations");
    expect(encoded).not.toBeNull();
    expect(JSON.parse(decodeURIComponent(encoded ?? ""))).toEqual([mocks.degradation]);
  });
});
