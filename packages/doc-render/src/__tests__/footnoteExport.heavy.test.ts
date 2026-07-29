import type { PmDoc } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import { getBrowser } from "../browser/pool.js";
import { loadPdfParseConstructor } from "../browser/pdfParse.js";
import { toHtml, toPdf } from "../export/index.js";
import { hasChromium } from "./browserTestGate.js";

const doc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [{
    type: "paragraph",
    attrs: { blockId: "p" },
    content: [
      { type: "text", text: "正文甲" },
      { type: "footnoteReference", attrs: { id: "a", note: "文末脚注甲" } },
      { type: "text", text: "正文乙" },
      { type: "footnoteReference", attrs: { id: "b", note: "文末脚注乙" } },
    ],
  }],
};

async function extractPdfText(pdf: Buffer): Promise<string> {
  const PDFParse = await loadPdfParseConstructor();
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

describe.skipIf(!hasChromium)("脚注 HTML/PDF 真浏览器验收", () => {
  it("HTML 引用在真实布局中可命中，pointer-events 与 elementFromPoint 同时通过", async () => {
    const browser = await getBrowser();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(toHtml(doc), { waitUntil: "load" });
      const result = await page.locator(".footnote-ref a").first().evaluate((anchor) => {
        const rect = anchor.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        return {
          pointerEvents: getComputedStyle(anchor).pointerEvents,
          width: rect.width,
          height: rect.height,
          hitIsAnchor: hit === anchor || Boolean(hit?.closest(".footnote-ref a")),
        };
      });
      expect(result.pointerEvents).not.toBe("none");
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(result.hitIsAnchor).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("PDF 保留正文数字引用和文末脚注区，不伪装成分页页底脚注", async () => {
    const pdf = await toPdf(doc, { title: "脚注 PDF 验收" });
    expect(pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
    // Chromium 的 CJK 字体子集可能把“文/乙”等映射为兼容字形，NFKC 后再验语义文本。
    const text = (await extractPdfText(pdf)).normalize("NFKC");
    expect(text).toContain("正文甲");
    expect(text).toContain("正文乙");
    expect(text).toContain("文末脚注甲");
    expect(text).toContain("文末脚注乙");
    expect(text.indexOf("文末脚注甲")).toBeGreaterThan(text.indexOf("正文乙"));
  });
});
