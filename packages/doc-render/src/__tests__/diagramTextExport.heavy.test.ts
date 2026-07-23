import { graphToSvg, type DiagramOverlay } from "@qingagent/diagram-engine";
import type { PmDoc } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import { getBrowser, withBrowserContextSlot } from "../browser/pool.js";
import { loadPdfParseConstructor } from "../browser/pdfParse.js";
import { renderDiagramSvgs } from "../export/mermaidServer.js";
import { prepareSvgForRasterization, rasterizeSvgToPng } from "../export/rasterize.js";
import { toPdf } from "../export/toPdf.js";
import { barCardTemplate } from "../svgTemplates/index.js";
import { hasChromium } from "./browserTestGate.js";

const DIAGRAM_SOURCE = [
  "flowchart TD",
  "  A[需求分析] --> B[设计]",
  "  B --> C[编码]",
  "  C --> D[测试]",
  "  D --> E[上线]",
  "",
].join("\n");

const DIAGRAM_LABELS = ["需求分析", "设计", "编码", "测试", "上线"] as const;
const DIAGRAM_OVERLAY: DiagramOverlay = {
  // graphToSvg 的独立覆盖；r44 真实文档没有 overlay，服务端导出实际走 renderDiagramSvgs。
  positions: { A: { x: 40, y: 40 } },
};

function mermaidDiagramDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "diagram",
      attrs: {
        blockId: "diagram-text-regression",
        lang: "mermaid",
        source: DIAGRAM_SOURCE,
        svg: null,
      },
    }],
  } as unknown as PmDoc;
}

function illustrationDoc(svg: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "image",
      attrs: {
        blockId: "generate-svg-regression",
        src: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
        alt: "季度销售额柱状图",
        caption: null,
        width: 800,
        height: 450,
      },
    }],
  } as unknown as PmDoc;
}

function withoutSvgText(svg: string): string {
  return svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/gi, "");
}

async function differingPngPixels(first: Buffer, second: Buffer): Promise<{
  different: number;
  total: number;
}> {
  return withBrowserContextSlot(async () => {
    const browser = await getBrowser();
    const context = await browser.newContext();
    // Vitest/esbuild 开 keepNames 时，evaluate 内的命名函数可能引用 node 侧 __name helper。
    await context.addInitScript(() => {
      (globalThis as unknown as { __name?: (fn: unknown) => unknown }).__name ||= (fn) => fn;
    });
    const page = await context.newPage();
    try {
      await page.setContent("<!doctype html><meta charset=\"utf-8\"><canvas></canvas>", {
        waitUntil: "load",
        timeout: 30_000,
      });
      return await page.evaluate(async ({ firstUrl, secondUrl }) => {
        const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("PNG decode failed"));
          image.src = src;
        });
        const [firstImage, secondImage] = await Promise.all([load(firstUrl), load(secondUrl)]);
        if (
          firstImage.naturalWidth !== secondImage.naturalWidth ||
          firstImage.naturalHeight !== secondImage.naturalHeight
        ) {
          throw new Error("PNG dimensions differ");
        }

        const canvas = document.querySelector("canvas");
        const drawing = canvas?.getContext("2d", { willReadFrequently: true });
        if (!canvas || !drawing) throw new Error("Canvas unavailable");
        canvas.width = firstImage.naturalWidth;
        canvas.height = firstImage.naturalHeight;
        drawing.drawImage(firstImage, 0, 0);
        const firstPixels = drawing.getImageData(0, 0, canvas.width, canvas.height).data;
        drawing.clearRect(0, 0, canvas.width, canvas.height);
        drawing.drawImage(secondImage, 0, 0);
        const secondPixels = drawing.getImageData(0, 0, canvas.width, canvas.height).data;

        let different = 0;
        for (let index = 0; index < firstPixels.length; index += 4) {
          const delta = Math.max(
            Math.abs(firstPixels[index]! - secondPixels[index]!),
            Math.abs(firstPixels[index + 1]! - secondPixels[index + 1]!),
            Math.abs(firstPixels[index + 2]! - secondPixels[index + 2]!),
            Math.abs(firstPixels[index + 3]! - secondPixels[index + 3]!),
          );
          if (delta >= 12) different++;
        }
        return { different, total: canvas.width * canvas.height };
      }, {
        firstUrl: `data:image/png;base64,${first.toString("base64")}`,
        secondUrl: `data:image/png;base64,${second.toString("base64")}`,
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

async function expectRasterizedTextPixels(svg: string): Promise<void> {
  const [withText, withoutText] = await Promise.all([
    rasterizeSvgToPng(svg),
    rasterizeSvgToPng(withoutSvgText(svg)),
  ]);
  expect(withText).not.toBeNull();
  expect(withoutText).not.toBeNull();
  if (!withText || !withoutText) throw new Error("SVG rasterization unavailable");
  expect(withText.width).toBe(withoutText.width);
  expect(withText.height).toBe(withoutText.height);

  // 两张图唯一的内容差异是 <text>；PNG 像素差因此就是服务端 Chromium 实际画出的字形，
  // 不是只检查 DOM 中仍有文字节点。
  const pixels = await differingPngPixels(withText.data, withoutText.data);
  expect(pixels.different).toBeGreaterThan(100);
  expect(pixels.different / pixels.total).toBeGreaterThan(0.0002);
}

async function extractPdfText(pdf: Buffer): Promise<string> {
  const PDFParse = await loadPdfParseConstructor();
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

describe.skipIf(!hasChromium)("Mermaid / Graph SVG 中文文字导出", () => {
  it("无 overlay Mermaid 节点经安全净化与 rasterizeSvgToPng 后保留中文像素", async () => {
    const [svg] = await renderDiagramSvgs([DIAGRAM_SOURCE]);
    expect(svg).not.toBeNull();
    expect(svg).not.toContain("<foreignObject");
    expect(svg).toContain("<text");

    // r44 真根因：Mermaid 默认 foreignObject 标签会被 hardenInlineSvg 整块删除。
    // 这里必须验证进入真实栅格化前的净化结果仍保留五个标签，而非只查原始 SVG。
    const safeSvg = prepareSvgForRasterization(svg!);
    expect(safeSvg).not.toBeNull();
    for (const label of DIAGRAM_LABELS) expect(safeSvg).toContain(label);

    await expectRasterizedTextPixels(svg!);
  });

  it("graphToSvg 中文 text 经 rasterizeSvgToPng 后确有字形像素", async () => {
    const svg = graphToSvg(DIAGRAM_SOURCE, DIAGRAM_OVERLAY);
    expect(svg).not.toBeNull();
    expect(svg).toContain('font-family="sans-serif"');
    await expectRasterizedTextPixels(svg!);
  });

  it("toPdf 的无 overlay Mermaid server 路径保留全部节点文字", async () => {
    const text = await extractPdfText(await toPdf(mermaidDiagramDoc()));
    for (const label of DIAGRAM_LABELS) expect(text).toContain(label);
  });

  it("generateSvg 条形图的 sans-serif PNG 与 PDF 文字路径不回归", async () => {
    const svg = barCardTemplate.render({
      title: "季度销售额",
      unit: "万元",
      bars: [
        { label: "Q1", value: 20 },
        { label: "Q2", value: 35 },
        { label: "Q3", value: 28 },
        { label: "Q4", value: 45 },
      ],
    }, { width: 800, height: 450 });

    expect(svg).toContain('font-family="sans-serif"');
    await expectRasterizedTextPixels(svg);
    const text = await extractPdfText(await toPdf(illustrationDoc(svg)));
    for (const label of ["季度销售额", "Q1", "Q2", "Q3", "Q4", "20万元", "45万元"]) {
      expect(text).toContain(label);
    }
  });
});
