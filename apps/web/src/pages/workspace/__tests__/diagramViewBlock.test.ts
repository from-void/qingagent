import { describe, expect, it } from "vitest";
import { pmDocToViewDocumentSnapshot } from "../data/protocol";
import { viewSectionsToHtml } from "../components/doc/viewDocHtml";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";

// round-1 真机端到端发现的根因回归:生成的图表在编辑器里显示成代码块。
// 根因是 PM→ViewBlock 把 diagram 降级成 code,而编辑器经 viewSectionsToHtml(sections)
// 播种内容,于是图表变代码块。修复:ViewBlock 保留 diagram 语义(只读渲染处才降级)。

function docWithDiagram(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      { type: "paragraph", attrs: { blockId: "p" }, content: [{ type: "text", text: "前言" }] },
      { type: "diagram", attrs: { blockId: "d", lang: "mermaid", source: "flowchart TD\n A-->B", svg: null } },
    ],
  } as unknown as PmDoc;
}

describe("ViewBlock 保留 diagram(不降级为 code)", () => {
  it("pmDocToViewDocumentSnapshot:diagram 节点 → diagram ViewBlock,且 pmDoc 原样保留", () => {
    const snap = pmDocToViewDocumentSnapshot(docWithDiagram(), 1);
    const kinds = snap.sections.map((s) => s.kind);
    expect(kinds).toContain("diagram");
    expect(kinds).not.toContain("code");
    const dg = snap.sections.find((s) => s.kind === "diagram");
    expect(dg && dg.kind === "diagram" ? dg.source : "").toContain("flowchart TD");
    // pmDoc 原样(编辑器优先用 pmDoc)
    expect(snap.pmDoc?.content.some((b) => b.type === "diagram")).toBe(true);
  });
});

describe("viewSectionsToHtml 审阅态行内 patch 保真", () => {
  it("quote 带 patch inlineMath 时不被原始 pm 节点序列化吞掉", () => {
    const latex = String.raw`\sqrt{\sigma^{}} & x < y`;
    const html = viewSectionsToHtml([{
      kind: "quote",
      text: "旧引文",
      node: {
        type: "blockquote",
        attrs: { blockId: "q-node" },
        content: [{ type: "paragraph", attrs: { blockId: "q-p" }, content: [{ type: "text", text: "旧引文" }] }],
      } as PmBlockNode,
      spans: [
        { kind: "text", text: "引用 " },
        { kind: "patchInsMath", latex, patchId: "q-math" },
      ],
    }]);

    expect(html).toContain("data-type=\"inline-math\"");
    expect(html).toContain("data-latex=\"\\sqrt{\\sigma^{}} &amp; x &lt; y\"");
    expect(html).not.toContain("旧引文");
  });
});
