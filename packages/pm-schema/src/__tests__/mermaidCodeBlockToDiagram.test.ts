import { describe, expect, it } from "vitest";
import { compileAiDocumentToPm, detectMermaidSource, upgradeMermaidCodeBlocksToDiagram } from "../ai-ir/aiIrToPm";
import type { AiDocument } from "../ai-ir/aiIrSchema";

// round-1 端到端实测发现:writeDraft 走 flash 档模型,常无视"严禁用 codeBlock 写 mermaid",
// 把图表写成代码块 → 前端渲染成代码块而非活图。安全网:入口把 mermaid 代码块转成 diagram。

describe("detectMermaidSource", () => {
  it("language=mermaid 命中", () => {
    expect(detectMermaidSource("mermaid", "flowchart TD\n A-->B")).toContain("flowchart TD");
    expect(detectMermaidSource("MMD", "anything")).toBe("anything");
  });
  it("正文图头命中(各图类型)", () => {
    expect(detectMermaidSource(null, "flowchart TD\n A-->B")).toContain("flowchart");
    expect(detectMermaidSource("plaintext", "sequenceDiagram\n A->>B: hi")).toContain("sequenceDiagram");
    expect(detectMermaidSource(null, "graph LR\n A-->B")).toContain("graph LR");
    expect(detectMermaidSource(null, "pie title 占比\n \"A\": 1")).toContain("pie");
    expect(detectMermaidSource(null, "stateDiagram-v2\n [*]-->S")).toContain("stateDiagram");
  });
  it("普通代码不误判", () => {
    expect(detectMermaidSource("ts", "const x = 1;")).toBeNull();
    expect(detectMermaidSource("python", "graph = {}\nprint(graph)")).toBeNull(); // graph 后无方向
    expect(detectMermaidSource(null, "")).toBeNull();
    expect(detectMermaidSource("js", "function pie() {}")).toBeNull();
  });
});

describe("AI-IR 把 mermaid 代码块转成 diagram", () => {
  it("AI-IR codeBlock(language=mermaid)→ diagram", () => {
    const ir: AiDocument = {
      title: "t",
      blocks: [{ type: "codeBlock", language: "mermaid", text: "flowchart TD\n A-->B" } as never],
    };
    const r = compileAiDocumentToPm(ir);
    const block = r.doc!.content[0];
    expect(block?.type).toBe("diagram");
    expect(block?.type === "diagram" ? block.attrs.source : "").toContain("flowchart TD");
  });

  it("AI-IR codeBlock(无 language 但正文是图头)→ diagram", () => {
    const ir: AiDocument = {
      title: "t",
      blocks: [{ type: "codeBlock", text: "sequenceDiagram\n A->>B: hi" } as never],
    };
    const r = compileAiDocumentToPm(ir);
    expect(r.doc!.content[0]?.type).toBe("diagram");
  });

  it("AI-IR 普通代码块保持 codeBlock", () => {
    const ir: AiDocument = {
      title: "t",
      blocks: [{ type: "codeBlock", language: "ts", text: "const x = 1;" } as never],
    };
    const r = compileAiDocumentToPm(ir);
    expect(r.doc!.content[0]?.type).toBe("codeBlock");
  });

});

// 装载侧安全网:已落盘文档里"伪装成 codeBlock 的 mermaid"装载到编辑器前要升级回 diagram,
// 否则渲染成死代码、丢可视化编辑入口(用户报的「Mermaid 退回代码格式」;e2e 实测 doc 225ca665 复现)。
describe("upgradeMermaidCodeBlocksToDiagram(装载侧 PM 文档安全网)", () => {
  const mermaidCodeBlock = (blockId: string, language: string | null, text: string) => ({
    type: "codeBlock",
    attrs: language === null ? { blockId } : { blockId, language },
    content: text ? [{ type: "text", text }] : [],
  });

  it("codeBlock(language=mermaid)→ diagram 并保留 blockId、source", () => {
    const doc = {
      type: "doc",
      content: [mermaidCodeBlock("blk-1", "mermaid", "flowchart TD\n  A -->|中文边标签| B\n  A <--> n_新节点")],
    };
    const out = upgradeMermaidCodeBlocksToDiagram(doc) as { content: Array<{ type: string; attrs: Record<string, unknown> }> };
    expect(out.content[0]?.type).toBe("diagram");
    expect(out.content[0]?.attrs.blockId).toBe("blk-1");
    expect(out.content[0]?.attrs.lang).toBe("mermaid");
    expect(String(out.content[0]?.attrs.source)).toContain("flowchart TD");
    expect(out.content[0]?.attrs.svg).toBeNull();
  });

  it("codeBlock(无 language 但正文是图头)→ diagram", () => {
    const doc = { type: "doc", content: [mermaidCodeBlock("blk-2", null, "stateDiagram-v2\n  [*] --> S")] };
    const out = upgradeMermaidCodeBlocksToDiagram(doc) as { content: Array<{ type: string }> };
    expect(out.content[0]?.type).toBe("diagram");
  });

  it("普通代码块(非 mermaid)原样保留为 codeBlock", () => {
    const doc = { type: "doc", content: [mermaidCodeBlock("blk-3", "ts", "const x = 1;")] };
    const out = upgradeMermaidCodeBlocksToDiagram(doc) as { content: Array<{ type: string; attrs: Record<string, unknown> }> };
    expect(out.content[0]?.type).toBe("codeBlock");
    expect(out.content[0]?.attrs.language).toBe("ts");
  });

  it("命中 0 处时不改其它块(段落原样)", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "正文" }] },
        mermaidCodeBlock("blk-4", "python", "print(1)"),
      ],
    };
    const out = upgradeMermaidCodeBlocksToDiagram(doc);
    expect(out).toEqual(doc);
  });
});
