import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";

const rasterMocks = vi.hoisted(() => ({
  rasterizeMathBatch: vi.fn(),
}));

vi.mock("../export/rasterize.js", () => ({
  rasterizeMathBatch: rasterMocks.rasterizeMathBatch,
  rasterizeSvgToPng: vi.fn(),
}));

import { toDocx } from "../export/toDocx.js";

const DOCX_EMUS_PER_TWIP = 635;
const DOCX_EMUS_PER_PIXEL = 9_525;
const LONG_INLINE_LATEX = String.raw`a_1+a_2+a_3+a_4+a_5+a_6+a_7+a_8+a_9+a_{10}+a_{11}+a_{12}`;
const LONG_BLOCK_LATEX = String.raw`\sum_{i=1}^{20} a_i x_i + \sum_{j=1}^{20} b_j y_j = c`;
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

describe("DOCX 公式尺寸", () => {
  beforeEach(() => {
    rasterMocks.rasterizeMathBatch.mockReset();
  });

  it("窄栏长行内公式限制 cx 且保持可读 cy", async () => {
    rasterMocks.rasterizeMathBatch.mockResolvedValueOnce([
      { data: PNG_1X1, width: 400, height: 28 },
    ]);
    const doc = narrowColumnDoc([
      {
        type: "paragraph",
        attrs: { blockId: "narrow-math-paragraph" },
        content: [{ type: "inlineMath", attrs: { latex: LONG_INLINE_LATEX } }],
      },
    ]);

    const extents = await drawingExtents(doc);

    expect(rasterMocks.rasterizeMathBatch).toHaveBeenCalledWith([
      { latex: LONG_INLINE_LATEX, displayMode: false },
    ]);
    expect(extents).toEqual([{
      cx: narrowColumnWidthTwips() * DOCX_EMUS_PER_TWIP,
      cy: 16 * DOCX_EMUS_PER_PIXEL,
    }]);
  });

  it("窄栏长块级公式也保持块级可读高度", async () => {
    rasterMocks.rasterizeMathBatch.mockResolvedValueOnce([
      { data: PNG_1X1, width: 800, height: 50 },
    ]);
    const doc = narrowColumnDoc([
      {
        type: "blockMath",
        attrs: { blockId: "narrow-block-math", latex: LONG_BLOCK_LATEX },
      },
    ]);

    const extents = await drawingExtents(doc);

    expect(rasterMocks.rasterizeMathBatch).toHaveBeenCalledWith([
      { latex: LONG_BLOCK_LATEX, displayMode: true },
    ]);
    expect(extents).toEqual([{
      cx: narrowColumnWidthTwips() * DOCX_EMUS_PER_TWIP,
      cy: 32 * DOCX_EMUS_PER_PIXEL,
    }]);
  });
});

function narrowColumnDoc(content: PmBlockNode[]): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "columnList",
        attrs: { blockId: "narrow-math-columns" },
        content: [
          {
            type: "column",
            attrs: { blockId: "narrow-math-column", widthRatio: 0.2 },
            content,
          },
          {
            type: "column",
            attrs: { blockId: "wide-text-column", widthRatio: 0.8 },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "wide-text-paragraph" },
                content: [{ type: "text", text: "宽栏" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function narrowColumnWidthTwips(): number {
  return Math.round((11_906 - 1_440 * 2 - 720) * 0.2);
}

async function drawingExtents(doc: PmDoc): Promise<Array<{ cx: number; cy: number }>> {
  const documentXml = await docxXml(await toDocx(doc), "word/document.xml");
  return [...documentXml.matchAll(/<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/g)]
    .map((match) => ({ cx: Number(match[1]), cy: Number(match[2]) }));
}

async function docxXml(buffer: Buffer, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(path);
  if (!file) throw new Error(`missing ${path}`);
  return file.async("string");
}
