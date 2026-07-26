import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { PmDoc } from "@qingagent/pm-schema";
import { setDocRenderLogger } from "../renderLogger.js";
import { withRenderedDiagrams } from "../export/mermaidServer.js";
import { isDrawioExportSourceNormalized } from "../export/shared.js";
import { toDocx } from "../export/toDocx.js";
import { toHtml } from "../export/toHtml.js";

const DRAWIO_SOURCE = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const MULTI_PAGE_DRAWIO_SOURCE = `<mxfile>
  <diagram id="page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>
  <diagram id="page-2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>
</mxfile>`;
const DRAWIO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60"><rect width="120" height="60"/><text x="10" y="30">架构</text></svg>';
// 线上真实回归样本：document_suggestions/diff-hunk-e15b1cdd0d280391 的完整 draw.io source。
const REAL_PERCENT_ENCODED_COLOR_XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="zone-wan" value="外网区" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23EDF2F7;strokeColor=%234A6FA5;strokeWidth=2;dashed=1;fontColor=%231F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="600" height="120" as="geometry"/></mxCell><mxCell id="zone-app" value="应用区" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23D4E0ED;strokeColor=%234A6FA5;strokeWidth=2;dashed=1;fontColor=%231F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;" vertex="1" parent="1"><mxGeometry x="40" y="200" width="600" height="120" as="geometry"/></mxCell><mxCell id="zone-data" value="数据区" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23E8EDF3;strokeColor=%235A7B9A;strokeWidth=2;dashed=1;fontColor=%231F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;" vertex="1" parent="1"><mxGeometry x="40" y="360" width="600" height="120" as="geometry"/></mxCell><mxCell id="client" value="客户端" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23FFFFFF;strokeColor=%234A6FA5;strokeWidth=2;fontColor=%231F2329;fontSize=14;spacing=8;" vertex="1" parent="zone-wan"><mxGeometry x="80" y="30" width="160" height="60" as="geometry"/></mxCell><mxCell id="app-server" value="应用服务器" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23FFFFFF;strokeColor=%235A7B9A;strokeWidth=2;fontColor=%231F2329;fontSize=14;spacing=8;" vertex="1" parent="zone-app"><mxGeometry x="220" y="30" width="160" height="60" as="geometry"/></mxCell><mxCell id="db-server" value="数据库服务器" style="rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=%23FFFFFF;strokeColor=%238895A7;strokeWidth=2;fontColor=%231F2329;fontSize=14;spacing=8;" vertex="1" parent="zone-data"><mxGeometry x="360" y="30" width="160" height="60" as="geometry"/></mxCell><mxCell id="edge-c2a" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=%23718BAE;strokeWidth=2;labelBackgroundColor=%23FFFFFF;fontColor=%235E6C7B;fontSize=13;" edge="1" parent="1" source="client" target="app-server"><mxGeometry relative="1" as="geometry"><mxPoint x="0" y="-12" as="offset"/></mxGeometry></mxCell><mxCell id="edge-a2d" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=%23718BAE;strokeWidth=2;labelBackgroundColor=%23FFFFFF;fontColor=%235E6C7B;fontSize=13;" edge="1" parent="1" source="app-server" target="db-server"><mxGeometry relative="1" as="geometry"><mxPoint x="0" y="-12" as="offset"/></mxGeometry></mxCell></root></mxGraphModel>';

function drawioDoc(svg: string | null): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "diagram",
      attrs: { blockId: "drawio-1", lang: "drawio", source: DRAWIO_SOURCE, svg },
    }],
  };
}

describe("drawio 导出缓存与服务端兜底", () => {
  afterEach(() => {
    setDocRenderLogger(console);
  });

  it("HTML 导出预处理链保留并内联经加固的客户端 SVG 缓存", async () => {
    const prepared = await withRenderedDiagrams(drawioDoc(DRAWIO_SVG));
    const html = toHtml(prepared);
    expect(html).toContain('<div class="pm-diagram"><svg');
    expect(html).toContain("架构");
    expect(html).not.toContain("&lt;mxGraphModel");
  });

  it("服务端无缓存时不把 drawio XML 错送 Mermaid，给出明确警告并回退源码", async () => {
    const warn = vi.fn();
    setDocRenderLogger({ warn });
    const input = drawioDoc(null);
    const prepared = await withRenderedDiagrams(input) as PmDoc;
    const block = prepared.content[0];
    expect(block?.type).toBe("diagram");
    expect(block?.type === "diagram" ? block.attrs.svg : "unexpected").toBeNull();
    expect(block?.type === "diagram" && isDrawioExportSourceNormalized(block.attrs)).toBe(true);
    expect(input.content[0]?.type === "diagram" ? input.content[0].attrs.svg : "unexpected").toBeNull();
    expect(input.content[0]?.type === "diagram" && isDrawioExportSourceNormalized(input.content[0].attrs)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Drawio export cache missing"),
      expect.objectContaining({
        blockId: "drawio-1",
        sourceBytes: expect.any(Number),
        sourceSummary: expect.stringContaining("<mxGraphModel>"),
      }),
    );
    const html = toHtml(prepared);
    expect(html).toContain("draw.io 图表数据已按安全边界归一化，可能与原图有差异");
    expect(html).not.toContain("以下为图表源码（可复制到 draw.io 查看）");
    expect(html).toContain("&lt;mxGraphModel&gt;");
  });

  it("drawio 源码归一化失败时保留原件，并使用诚实的 HTML 回退文案", async () => {
    const warn = vi.fn();
    setDocRenderLogger({ warn });
    const input = drawioDoc(null);
    const brokenSource = "<mxGraphModel><broken>";
    if (input.content[0]?.type === "diagram") {
      input.content[0].attrs.source = brokenSource;
    }

    const prepared = await withRenderedDiagrams(input) as PmDoc;

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Drawio export source normalization failed"),
      expect.objectContaining({
        blockId: "drawio-1",
        sourceSummary: brokenSource,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Drawio export cache missing"),
      expect.objectContaining({
        blockId: "drawio-1",
        sourceSummary: brokenSource,
      }),
    );
    expect(prepared.content[0]?.type === "diagram" ? prepared.content[0].attrs.source : "").toBe(brokenSource);
    expect(prepared.content[0]?.type === "diagram" && isDrawioExportSourceNormalized(prepared.content[0].attrs)).toBe(false);
    expect(input.content[0]?.type === "diagram" ? input.content[0].attrs.source : "").toBe(brokenSource);

    const html = toHtml(prepared);
    expect(html).toContain("以下为图表源码（可复制到 draw.io 查看）");
    expect(html).not.toContain("已按安全边界归一化");
  });

  it("服务端缺缓存回退也复用共享归一化，真实百分号颜色源码可复制使用", async () => {
    setDocRenderLogger({ warn: vi.fn() });
    const input = drawioDoc(null);
    if (input.content[0]?.type === "diagram") {
      input.content[0].attrs.source = REAL_PERCENT_ENCODED_COLOR_XML;
    }

    const prepared = await withRenderedDiagrams(input) as PmDoc;
    const block = prepared.content[0];
    expect(block?.type).toBe("diagram");
    if (block?.type !== "diagram") return;
    expect(block.attrs.source).toContain("fillColor=#EDF2F7");
    expect(block.attrs.source).toContain("fillColor=#D4E0ED");
    expect(block.attrs.source).toContain("fillColor=#E8EDF3");
    expect(block.attrs.source).not.toContain("%23");
    expect(input.content[0]?.type === "diagram" ? input.content[0].attrs.source : "").toBe(
      REAL_PERCENT_ENCODED_COLOR_XML,
    );

    const html = toHtml(prepared);
    expect(html).toContain("fillColor=#EDF2F7");
    expect(html).not.toContain("%23");
  });

  it("mxfile 多页保留完整原件，并使用源码回退文案", async () => {
    setDocRenderLogger({ warn: vi.fn() });
    const input = drawioDoc(null);
    if (input.content[0]?.type === "diagram") {
      input.content[0].attrs.source = MULTI_PAGE_DRAWIO_SOURCE;
    }

    const prepared = await withRenderedDiagrams(input) as PmDoc;
    expect(prepared.content[0]?.type === "diagram" ? prepared.content[0].attrs.source : "").toBe(
      MULTI_PAGE_DRAWIO_SOURCE,
    );
    expect(prepared.content[0]?.type === "diagram" && isDrawioExportSourceNormalized(prepared.content[0].attrs)).toBe(false);
    const html = toHtml(prepared);
    expect(html).toContain("以下为图表源码（可复制到 draw.io 查看）");
    expect(html).not.toContain("已按安全边界归一化");
    expect(html).toContain("page-2");
  });

  it("DOCX 已归一化分支沿用安全边界提示", async () => {
    setDocRenderLogger({ warn: vi.fn() });
    const xml = await new JSZip()
      .loadAsync(await toDocx(drawioDoc(null)))
      .then((zip) => zip.file("word/document.xml")!.async("string"));

    expect(xml).toContain("draw.io 图表数据已按安全边界归一化，可能与原图有差异");
    expect(xml).toContain("&lt;mxGraphModel&gt;");
  });

  it("DOCX 归一化失败分支说明以下为图表源码", async () => {
    setDocRenderLogger({ warn: vi.fn() });
    const input = drawioDoc(null);
    if (input.content[0]?.type === "diagram") {
      input.content[0].attrs.source = "<mxGraphModel><broken>";
    }

    const xml = await new JSZip()
      .loadAsync(await toDocx(input))
      .then((zip) => zip.file("word/document.xml")!.async("string"));

    expect(xml).toContain("以下为图表源码（可复制到 draw.io 查看）");
    expect(xml).not.toContain("已按安全边界归一化");
    expect(xml).toContain("&lt;mxGraphModel&gt;&lt;broken&gt;");
  });
});
