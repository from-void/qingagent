import { afterEach, describe, expect, it } from "vitest";
import { getHtmlToPdfRenderer, setHtmlToPdfRenderer } from "./pdfRenderer.js";
import { htmlToPdf } from "./htmlToPdf.js";

// PDF 渲染器可注入缝:默认无渲染器(回退 Playwright),注册后 htmlToPdf 优先走自定义渲染器
// 且不触碰 Playwright(桌面端据此复用 Electron printToPDF)。
describe("pdfRenderer 可注入缝", () => {
  afterEach(() => setHtmlToPdfRenderer(null));

  it("默认未注册时 get 返回 null(回退 Playwright)", () => {
    expect(getHtmlToPdfRenderer()).toBeNull();
  });

  it("注册后 htmlToPdf 优先走自定义渲染器,拿到原始 HTML、返回其字节,不启动 Playwright", async () => {
    let received: string | null = null;
    setHtmlToPdfRenderer(async (html) => {
      received = html;
      return Buffer.from("CUSTOM-PDF-BYTES");
    });
    const out = await htmlToPdf("<html><body>测试</body></html>");
    expect(received).toBe("<html><body>测试</body></html>");
    expect(out.toString("utf8")).toBe("CUSTOM-PDF-BYTES");
  });

  it("注销(set null)后回退,get 再次为 null", () => {
    setHtmlToPdfRenderer(async () => Buffer.from(""));
    expect(getHtmlToPdfRenderer()).not.toBeNull();
    setHtmlToPdfRenderer(null);
    expect(getHtmlToPdfRenderer()).toBeNull();
  });
});
