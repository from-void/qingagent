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
      recoverPdfTextFromOperators: async ({ primaryText }: { primaryText: string }) => primaryText,
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

  it("PDF 超过页数上限时只解析前 N 页并在正文显式提示", async () => {
    const getText = vi.fn(async (_parameters?: { first?: number }) => ({
      text: "上限内正文",
      total: 501,
    }));
    const PDFParse = class {
      async getText(parameters?: { first?: number }) {
        return getText(parameters);
      }

      async getInfo() {
        return { total: 501, info: { Title: "超长报告" } };
      }

      async destroy() {}
    };
    vi.doMock("@qingagent/doc-render/browser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@qingagent/doc-render/browser")>()),
      loadPdfParseConstructor: async () => PDFParse,
      recoverPdfTextFromOperators: async ({ primaryText }: { primaryText: string }) => primaryText,
    }));
    const { parseFileBuffer, PDF_TEXT_PAGE_LIMIT } = await import("../tools/parseFile.js");

    const result = await parseFileBuffer({
      buffer: Buffer.from("%PDF-1.4 mocked"),
      filename: "超长报告.pdf",
      mimeType: "application/pdf",
    });

    expect(result.ok).toBe(true);
    expect(getText).toHaveBeenCalledWith({ first: PDF_TEXT_PAGE_LIMIT });
    expect(result.text).toContain(`该 PDF 共 501 页，仅解析前 ${PDF_TEXT_PAGE_LIMIT} 页`);
    expect(result.text).toContain("上限内正文");
    expect(result.metadata.pages).toBe(501);
  });

  it("只有截断提示而无正文时仍判为无文字层", async () => {
    const getText = vi.fn(async () => ({ text: "", total: 501 }));
    const PDFParse = class {
      async getText() {
        return getText();
      }

      async getInfo() {
        return { total: 501, info: {} };
      }

      async destroy() {}
    };
    vi.doMock("@qingagent/doc-render/browser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@qingagent/doc-render/browser")>()),
      loadPdfParseConstructor: async () => PDFParse,
      recoverPdfTextFromOperators: async ({ primaryText }: { primaryText: string }) => primaryText,
    }));
    const { parseFileBuffer, PDF_TEXT_PAGE_LIMIT } = await import("../tools/parseFile.js");

    const result = await parseFileBuffer({
      buffer: Buffer.from("%PDF-1.4 mocked"),
      filename: "扫描件.pdf",
      mimeType: "application/pdf",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain(`仅解析前 ${PDF_TEXT_PAGE_LIMIT} 页`);
    expect(result.metadata.indexable).toBe(false);
    expect(getText).toHaveBeenCalledTimes(2);
  });
});
