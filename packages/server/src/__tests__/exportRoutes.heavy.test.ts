import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";

const mocks = vi.hoisted(() => ({
  document: {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "export-route-body" },
      content: [{ type: "text", text: "Route export body" }],
    }],
  } as PmDoc,
  renderedDocument: {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "export-route-rendered" },
      content: [{ type: "text", text: "Rendered route body" }],
    }],
  } as PmDoc,
  toPdf: vi.fn(async () => Buffer.from("%PDF-route")),
  toDocx: vi.fn(async () => Buffer.from("PK-route")),
  toTxt: vi.fn(() => "TXT-route"),
  toMarkdown: vi.fn(() => "MD-route"),
  toHtml: vi.fn(() => "<html>HTML-route</html>"),
  withRenderedDiagrams: vi.fn(),
}));

vi.mock("@qingagent/core", () => ({
  hasCanonicalDoc: (session: { doc?: PmDoc }) => Boolean(session.doc?.content.length),
  loadSessionFromThread: vi.fn(async () => undefined),
  redactSensitiveText: (value: string) => value,
}));

vi.mock("@qingagent/doc-render", () => ({
  getBrowserCapabilityState: vi.fn(() => ({ status: "available" })),
  hasSpecializedDiagramOverlayFallback: vi.fn(() => false),
  hasHtmlToPdfRenderer: vi.fn(() => true),
  SPECIALIZED_DIAGRAM_OVERLAY_NOTICE: "图表提示",
  toPdf: mocks.toPdf,
  toDocx: mocks.toDocx,
  toTxt: mocks.toTxt,
  toMarkdown: mocks.toMarkdown,
  toHtml: mocks.toHtml,
  withRenderedDiagrams: mocks.withRenderedDiagrams,
}));

vi.mock("../gateway/bridgeHandler", () => ({
  getSession: vi.fn(() => ({
    sessionId: "export-route-session",
    title: "Route Export",
    doc: mocks.document,
  })),
}));

const CASES = [
  {
    format: "pdf",
    contentType: "application/pdf",
    body: "%PDF-route",
    renderer: mocks.toPdf,
  },
  {
    format: "docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: "PK-route",
    renderer: mocks.toDocx,
  },
  {
    format: "txt",
    contentType: "text/plain; charset=utf-8",
    body: "TXT-route",
    renderer: mocks.toTxt,
  },
  {
    format: "markdown",
    contentType: "text/markdown; charset=utf-8",
    body: "MD-route",
    renderer: mocks.toMarkdown,
  },
  {
    format: "html",
    contentType: "text/html; charset=utf-8",
    body: "<html>HTML-route</html>",
    renderer: mocks.toHtml,
  },
] as const;

describe("GET /export 五格式 PM 路由分派", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withRenderedDiagrams.mockResolvedValue(mocks.renderedDocument);
  });

  it.each(CASES)("format=$format 只调用对应渲染器", async ({
    format,
    contentType,
    body,
    renderer,
  }) => {
    const { exportRoutes } = await import("../routes/export");
    const app = new Hono().route("/api/v1", exportRoutes);
    const response = await app.request(
      `http://localhost/api/v1/export/export-route-session?format=${format}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(await response.text()).toBe(body);
    expect(renderer).toHaveBeenCalledTimes(1);

    const expectedDocument = format === "html" ? mocks.renderedDocument : mocks.document;
    expect(renderer).toHaveBeenCalledWith(
      expectedDocument,
      expect.objectContaining({
        title: "Route Export",
        baseUrl: "http://localhost",
      }),
    );
    if (format === "html") {
      expect(mocks.withRenderedDiagrams).toHaveBeenCalledOnce();
      expect(mocks.withRenderedDiagrams).toHaveBeenCalledWith(mocks.document);
    } else {
      expect(mocks.withRenderedDiagrams).not.toHaveBeenCalled();
    }
    expect(CASES.filter(({ renderer: candidate }) =>
      candidate !== renderer && candidate.mock.calls.length > 0,
    )).toEqual([]);
  });
});
