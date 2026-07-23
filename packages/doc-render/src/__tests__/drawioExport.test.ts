import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmDoc } from "@qingagent/pm-schema";
import { setDocRenderLogger } from "../renderLogger.js";
import { withRenderedDiagrams } from "../export/mermaidServer.js";
import { toHtml } from "../export/toHtml.js";

const DRAWIO_SOURCE = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const DRAWIO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60"><rect width="120" height="60"/><text x="10" y="30">架构</text></svg>';

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

  it("HTML 内联经加固的客户端 SVG 缓存", () => {
    const html = toHtml(drawioDoc(DRAWIO_SVG));
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
    expect(input.content[0]?.type === "diagram" ? input.content[0].attrs.svg : "unexpected").toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Drawio export cache missing"),
      expect.objectContaining({ sourceBytes: expect.any(Number) }),
    );
    const html = toHtml(prepared);
    expect(html).toContain("&lt;mxGraphModel&gt;");
  });
});
