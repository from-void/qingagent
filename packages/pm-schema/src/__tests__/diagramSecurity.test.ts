import { describe, expect, it } from "vitest";
import { compileAiDocumentToPm } from "../ai-ir/aiIrToPm";
import { legacySectionsToPm } from "../legacy/legacySectionsToPm";
import { pmToClipboardHtml } from "../clipboard/pmToClipboardHtml";
import { normalizePmDoc } from "../validators";
import type { AiDocument } from "../ai-ir/aiIrSchema";
import type { PmDoc } from "../types";

// 安全回归:diagram.svg 绝不能信任模型/legacy 来源(会被 dangerouslySetInnerHTML 注入 +
// 内嵌导出 → 存储型 XSS)。入口转换必须把 svg 一律置 null,只让前端 mermaid 渲染回写。
const EVIL_SVG = '<svg onload="alert(1)"><script>alert(2)</script></svg>';

describe("diagram svg 入口剥离(防存储型 XSS)", () => {
  it("AI-IR → PM:模型给的 svg 被丢弃,置 null", () => {
    const ir: AiDocument = {
      title: "t",
      blocks: [
        { type: "diagram", lang: "mermaid", source: "flowchart TD\n A-->B", svg: EVIL_SVG } as never,
      ],
    };
    const result = compileAiDocumentToPm(ir);
    expect(result.ok).toBe(true);
    const block = result.doc!.content.find((b) => b.type === "diagram");
    expect(block?.type).toBe("diagram");
    // svg 必须不是模型给的恶意串(null/undefined 都算已剥离)
    expect((block?.type === "diagram" ? block.attrs.svg : "x") ?? null).toBeNull();
    expect(block?.type === "diagram" ? block.attrs.source : "").toContain("flowchart TD");
  });

  it("legacy section → PM:section.data.svg 被丢弃,置 null", () => {
    const doc = legacySectionsToPm([
      { kind: "diagram", data: { lang: "mermaid", source: "pie\n \"A\": 1", svg: EVIL_SVG } },
    ] as never);
    const block = doc.content.find((b) => b.type === "diagram");
    expect((block?.type === "diagram" ? block.attrs.svg : "x") ?? null).toBeNull();
  });

  it("PM 直写归一化:updateDoc 入口传入的 diagram.svg 被置空", () => {
    const doc = normalizePmDoc({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "diagram",
          attrs: {
            blockId: "diagram-1",
            lang: "mermaid",
            source: "flowchart TD\n A-->B",
            svg: EVIL_SVG,
          },
        },
      ],
    });

    const block = doc.content[0];
    expect(block?.type).toBe("diagram");
    expect(block?.type === "diagram" ? block.attrs.svg : "x").toBeNull();
  });

  it("剪贴板 HTML:diagram 降级为源码代码块(非空、转义)", () => {
    const doc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        { type: "diagram", attrs: { blockId: "d", lang: "mermaid", source: "flowchart TD\n A-->B", svg: null } },
      ],
    } as unknown as PmDoc;
    const html = pmToClipboardHtml(doc);
    expect(html).toContain('<pre data-language="mermaid">');
    expect(html).toContain('<code class="language-mermaid">');
    expect(html).toContain("flowchart TD");
    // 不得出现裸 svg / script
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<script");
  });
});
