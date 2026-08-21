import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { PmDoc } from "@qingagent/pm-schema";
import type { ExportDegradation } from "../export/shared.js";

const mocks = vi.hoisted(() => ({
  renderSucceeds: true,
  renderedSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60"/><text x="10" y="30">开始</text></svg>',
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
}));

vi.mock("../export/mermaidServer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../export/mermaidServer.js")>();
  return {
    ...actual,
    withRenderedDiagrams: vi.fn(async (document: PmDoc) => {
      const clone = structuredClone(document);
      for (const block of clone.content) {
        if (block.type === "diagram" && block.attrs.lang === "mermaid") {
          block.attrs.svg = mocks.renderSucceeds ? mocks.renderedSvg : null;
        }
      }
      return clone;
    }),
  };
});

vi.mock("../export/rasterize.js", () => ({
  rasterizeMathBatch: vi.fn(async () => []),
  rasterizeSvgToPng: vi.fn(async () => ({ data: mocks.png, width: 120, height: 60 })),
}));

import { toDocx } from "../export/toDocx.js";
import { toTxt } from "../export/toTxt.js";

const SOURCE = "flowchart TD\n  A[开始] --> B[结束]";

afterEach(() => {
  mocks.renderSucceeds = true;
});

describe("DOCX 图表降级按实际产物上报", () => {
  it("Mermaid 渲染成功并写成 PNG 时不申报源码降级", async () => {
    const degradations: ExportDegradation[] = [];

    const archive = await JSZip.loadAsync(await toDocx(mermaidDoc(), {
      onDegradation: (item) => degradations.push(item),
    }));
    const documentXml = await archive.file("word/document.xml")!.async("string");
    const mediaNames = Object.keys(archive.files).filter((name) => /^word\/media\/.+/.test(name));

    expect(mediaNames).toEqual([expect.stringMatching(/\.png$/)]);
    expect(documentXml).not.toContain("flowchart TD");
    expect(degradations).not.toContainEqual(expect.objectContaining({
      kind: "diagram-source-fallback",
    }));
  });

  it("mock Mermaid 渲染失败并真实写入源码时才申报降级", async () => {
    mocks.renderSucceeds = false;
    const degradations: ExportDegradation[] = [];

    const archive = await JSZip.loadAsync(await toDocx(mermaidDoc(), {
      onDegradation: (item) => degradations.push(item),
    }));
    const documentXml = await archive.file("word/document.xml")!.async("string");
    const mediaNames = Object.keys(archive.files).filter((name) => /^word\/media\/.+/.test(name));

    expect(mediaNames).toEqual([]);
    expect(documentXml).toContain("flowchart TD");
    expect(documentXml).toContain("开始");
    expect(degradations).toEqual([{
      kind: "diagram-source-fallback",
      description: "未能生成预览的图表已改为可复制的源码",
    }]);
  });

  it("TXT 按格式本性保留图表源码但不申报 DOCX 式降级", () => {
    const degradations: ExportDegradation[] = [];

    const text = toTxt(mermaidDoc(), {
      onDegradation: (item) => degradations.push(item),
    });

    expect(text).toContain(SOURCE);
    expect(degradations).toEqual([]);
  });
});

function mermaidDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "diagram",
      attrs: {
        blockId: "mermaid-degradation",
        lang: "mermaid",
        source: SOURCE,
        svg: null,
      },
    }],
  };
}
