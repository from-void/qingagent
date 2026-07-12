import { afterEach, describe, expect, it, vi } from "vitest";

describe("parseFileBuffer PDF cold-start retry", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@qingagent/doc-render/browser");
  });

  it("PDF 首次返回空文本时会内部重试并使用第二次正文", async () => {
    let getTextCalls = 0;
    const destroy = vi.fn(async () => undefined);
    // parseFile 经 interop 安全加载器 loadPdfParseConstructor 拿到 PDFParse(#11 桌面打包修复),
    // 故 mock 该 util 而非裸 pdf-parse
    const PDFParse = class {
      async getText() {
        getTextCalls += 1;
        return getTextCalls === 1
          ? { text: "", total: 1 }
          : { text: "第二次解析出的正文", total: 1 };
      }

      async getInfo() {
        return { info: { Title: "逐宁简历" } };
      }

      async destroy() {
        await destroy();
      }
    };
    vi.doMock("@qingagent/doc-render/browser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@qingagent/doc-render/browser")>()),
      loadPdfParseConstructor: async () => PDFParse,
    }));
    const { parseFileBuffer } = await import("../tools/parseFile.js");

    const result = await parseFileBuffer({
      buffer: Buffer.from("%PDF-1.4 mocked"),
      filename: "逐宁简历.pdf",
      mimeType: "application/pdf",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("第二次解析出的正文");
    expect(result.metadata.title).toBe("逐宁简历");
    expect(getTextCalls).toBe(2);
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
