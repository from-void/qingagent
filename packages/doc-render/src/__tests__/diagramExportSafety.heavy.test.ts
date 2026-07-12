import { describe, expect, it } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { toDocx } from "../export/toDocx.js";
import { toHtml } from "../export/toHtml.js";
import { toPdf } from "../export/toPdf.js";
import { withRenderedDiagrams } from "../export/mermaidServer.js";
import { hasChromium } from "./browserTestGate.js";

// round-1 端到端实测回归:含问题 svg 的图表块不得让整篇 docx/pdf 导出崩溃。
function docWithDiagram(svg: string | null): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      { type: "paragraph", attrs: { blockId: "p" }, content: [{ type: "text", text: "前言" }] },
      { type: "diagram", attrs: { blockId: "d", lang: "mermaid", source: "flowchart TD\n A-->B", svg } },
    ],
  } as unknown as PmDoc;
}

const NO_DIM_SVG = '<svg onload="alert(1)"><script>x()</script></svg>'; // 无尺寸 → 曾让 pdfmake 崩
const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60"><rect width="120" height="60"/></svg>';

describe("diagram 导出崩溃安全", () => {
  it("无尺寸/恶意 svg:docx 不崩,HTML 回退源码且不内联恶意 svg", async () => {
    const doc = docWithDiagram(NO_DIM_SVG);
    await expect(toDocx(doc, { title: "T" })).resolves.toBeInstanceOf(Buffer);
    const html = toHtml(doc, { title: "T" });
    // 坏 svg(无尺寸)必须回退成源码代码块,绝不原样内联恶意标记
    expect(html).not.toContain("onload");
    expect(html).not.toContain("<script>");
    expect(html).toContain("flowchart TD");
  });

  it("合法 svg:HTML 内联进 .pm-diagram", () => {
    const doc = docWithDiagram(GOOD_SVG);
    const html = toHtml(doc, { title: "T" });
    expect(html).toContain("pm-diagram");
    expect(html).toContain("<svg");
    expect(html).toContain("viewBox");
  });

  it("无 svg(仅源码):HTML 回退源码代码块", () => {
    const doc = docWithDiagram(null);
    const html = toHtml(doc, { title: "T" });
    expect(html).toContain("code-block");
    expect(html).toContain("flowchart TD");
  });

  it.skipIf(!hasChromium)("各种 svg 的图表块都能渲染出 PDF 不崩", async () => {
    for (const svg of [NO_DIM_SVG, GOOD_SVG, null]) {
      const pdf = await toPdf(docWithDiagram(svg), { title: "T" });
      expect(pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
    }
  });

  // 根因回归:图表 svg 缓存不持久化(导出读到 svg=null),必须服务端渲染 mermaid 源码,
  // 否则图表导出成源码代码块(用户实测发现)。
  it.skipIf(!hasChromium)("withRenderedDiagrams 服务端把 svg=null 的 mermaid 源码渲染成 SVG", async () => {
    const prepared = (await withRenderedDiagrams(docWithDiagram(null))) as PmDoc;
    const diagram = prepared.content.find((b) => b.type === "diagram") as { attrs: { svg: string | null } };
    expect(typeof diagram.attrs.svg).toBe("string");
    expect(diagram.attrs.svg).toContain("<svg");
    // 渲染后 toHtml 内联进 .pm-diagram,而非回退源码代码块
    const html = toHtml(prepared, { title: "T" });
    expect(html).toContain("pm-diagram");
    expect(html).toContain("<svg");
  });
});
