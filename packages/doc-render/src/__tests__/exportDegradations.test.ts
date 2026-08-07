import { describe, expect, it, vi } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { toDocx, toMarkdown, toTxt } from "../export/index.js";
import type { ExportOptions } from "../export/shared.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

vi.mock("../export/rasterize.js", () => ({
  rasterizeMathBatch: vi.fn(async () => []),
  rasterizeSvgToPng: vi.fn(async () => ({ data: PNG_1X1, width: 1, height: 1 })),
}));

type CapturedDegradation = {
  kind: string;
  description: string;
};

type CaptureOptions = ExportOptions & {
  onDegradation: (degradation: CapturedDegradation) => void;
};

function captureDegradations(): {
  degradations: CapturedDegradation[];
  options: CaptureOptions;
} {
  const degradations: CapturedDegradation[] = [];
  return {
    degradations,
    options: {
      onDegradation: (degradation) => degradations.push(degradation),
    },
  };
}

describe("导出有损降级上报", () => {
  it("DOCX 顶层真分栏不作任何降级上报", async () => {
    const capture = captureDegradations();

    await toDocx(columnDoc(), capture.options);

    expect(capture.degradations).toEqual([]);
  });

  it("DOCX 嵌套分栏拍平时上报稳定 kind", async () => {
    const capture = captureDegradations();

    await toDocx(nestedColumnDoc(), capture.options);

    expect(capture.degradations.map(({ kind }) => kind)).toContain("docx-columns-flattened");
  });

  it("DOCX 把 SVG 栅格化成功后上报稳定 kind", async () => {
    const capture = captureDegradations();

    await toDocx(svgDoc(), capture.options);

    expect(capture.degradations.map(({ kind }) => kind)).toContain("svg-rasterized");
  });

  it("Markdown 原生水平线不作任何降级上报", () => {
    const markdownCapture = captureDegradations();

    const markdown = toMarkdown(horizontalRuleDoc(), markdownCapture.options);

    expect(markdown).toBe("---");
    expect(markdownCapture.degradations).toEqual([]);
  });

  it("TXT 水平线不单独作降级上报", () => {
    const capture = captureDegradations();

    toTxt(horizontalRuleDoc(), capture.options);

    expect(capture.degradations).toEqual([]);
  });

  it("Markdown 分栏拍平由导出发生点上报，而非交给 UI 猜测", () => {
    const capture = captureDegradations();

    toMarkdown(columnDoc(), capture.options);

    expect(capture.degradations.map(({ kind }) => kind)).toContain("markdown-columns-flattened");
  });

  it("没有发生降级时不作任何上报", async () => {
    const docxCapture = captureDegradations();
    const markdownCapture = captureDegradations();
    const txtCapture = captureDegradations();
    const plain = plainDoc();

    await toDocx(plain, docxCapture.options);
    toMarkdown(plain, markdownCapture.options);
    toTxt(plain, txtCapture.options);

    expect(docxCapture.degradations).toEqual([]);
    expect(markdownCapture.degradations).toEqual([]);
    expect(txtCapture.degradations).toEqual([]);
  });
});

function plainDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "plain" },
        content: [{ type: "text", text: "正文" }],
      },
    ],
  };
}

function horizontalRuleDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      { type: "horizontalRule", attrs: { blockId: "rule" } },
    ],
  };
}

function svgDoc(): PmDoc {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "image",
        attrs: {
          blockId: "svg",
          src: `data:image/svg+xml,${encodeURIComponent(svg)}`,
          alt: "SVG",
          width: 8,
          height: 8,
        },
      },
    ],
  };
}

function columnDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [columnList()],
  };
}

function nestedColumnDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "blockquote",
      attrs: { blockId: "quote" },
      content: [columnList()],
    }],
  };
}

function columnList(): Extract<PmDoc["content"][number], { type: "columnList" }> {
  return {
    type: "columnList",
    attrs: { blockId: "columns" },
    content: [
      {
        type: "column",
        attrs: { blockId: "left", widthRatio: 0.5 },
        content: [{
          type: "paragraph",
          attrs: { blockId: "left-p" },
          content: [{ type: "text", text: "左栏" }],
        }],
      },
      {
        type: "column",
        attrs: { blockId: "right", widthRatio: 0.5 },
        content: [{
          type: "paragraph",
          attrs: { blockId: "right-p" },
          content: [{ type: "text", text: "右栏" }],
        }],
      },
    ],
  };
}
