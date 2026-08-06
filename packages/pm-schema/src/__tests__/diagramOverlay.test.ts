import { describe, expect, it } from "vitest";
import { applyBlockEdits } from "../ai-ir/applyBlockEdits";
import { pmToAiIr } from "../ai-ir/pmToAiIr";
import { getPmContentHash } from "../hash";
import type { PmDiagramNode, PmDoc } from "../types";
import { safeParsePmDoc } from "../validators";

function docWithOverlay(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "diagram",
        attrs: {
          blockId: "diagram-1",
          lang: "mermaid",
          source: "flowchart TD\n  A[开始] --> B[结束]\n",
          svg: null,
          overlay: {
            positions: {
              A: { x: 10, y: 20 },
              B: { x: 210, y: 20 },
              ORPHAN: { x: 999, y: 999 },
            },
            styles: {
              A: { fill: "#fff3a3", fontSize: 16, width: 240, height: 112 },
              ORPHAN: { fill: "#000000" },
            },
            edgeHandles: {
              [stableEdgeId("flow", { source: "A", target: "B", syntaxKind: "-->" }, 0)]: { sourceHandle: "r", targetHandle: "l" },
              ORPHAN: { sourceHandle: "b" },
            },
          },
        },
      },
    ],
  };
}

function firstDiagram(doc: PmDoc): PmDiagramNode {
  const block = doc.content[0];
  if (block?.type !== "diagram") throw new Error("expected diagram block");
  return block;
}

describe("diagram overlay 数据域", () => {
  it("overlay 不进入 AI-IR", () => {
    const ai = pmToAiIr(docWithOverlay());
    const block = ai.blocks[0];
    expect(block?.type).toBe("diagram");
    expect(block && "overlay" in block).toBe(false);
  });

  it("overlay 进入 content hash,overlay-only 变更会产生新 hash", () => {
    const base: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "diagram",
        attrs: { blockId: "diagram-1", lang: "mermaid", source: "flowchart TD\n  A --> B\n", svg: null },
      }],
    };
    const baseDiagram = firstDiagram(base);
    const withOverlay: PmDoc = {
      ...base,
      content: [{
        type: "diagram",
        attrs: { ...baseDiagram.attrs, overlay: { positions: { A: { x: 1, y: 2 } } } },
      }],
    };
    expect(getPmContentHash(withOverlay)).not.toBe(getPmContentHash(base));
    expect(safeParsePmDoc(withOverlay).success).toBe(true);
    const withEdgeHandles: PmDoc = {
      ...base,
      content: [{
        type: "diagram",
        attrs: {
          ...baseDiagram.attrs,
          overlay: {
            edgeHandles: {
              [stableEdgeId("flow", { source: "A", target: "B", syntaxKind: "-->" }, 0)]: { sourceHandle: "r", targetHandle: "l" },
            },
          },
        },
      }],
    };
    expect(getPmContentHash(withEdgeHandles)).not.toBe(getPmContentHash(base));
    expect(safeParsePmDoc(withEdgeHandles).success).toBe(true);
  });

  it("replaceBlock 继承稳定 id overlay 并清理孤儿", () => {
    const result = applyBlockEdits(docWithOverlay(), [
      {
        action: "replaceBlock",
        ref: "diagram-1",
        block: {
          type: "diagram",
          lang: "mermaid",
          source: "flowchart TD\n  A[新开始] --> B[结束]\n  B --> C[完成]\n",
        },
      },
    ]);
    expect(result.ok).toBe(true);
    const block = firstDiagram(result.doc!);
    expect(block.attrs.overlay?.positions?.A).toEqual({ x: 10, y: 20 });
    expect(block.attrs.overlay?.positions?.B).toEqual({ x: 210, y: 20 });
    expect(block.attrs.overlay?.positions?.ORPHAN).toBeUndefined();
    expect(block.attrs.overlay?.styles?.A).toEqual({ fill: "#fff3a3", fontSize: 16, width: 240, height: 112 });
    expect(block.attrs.overlay?.styles?.ORPHAN).toBeUndefined();
    const edgeId = stableEdgeId("flow", { source: "A", target: "B", syntaxKind: "-->" }, 0);
    expect(block.attrs.overlay?.edgeHandles?.[edgeId]).toEqual({ sourceHandle: "r", targetHandle: "l" });
    expect(block.attrs.overlay?.edgeHandles?.ORPHAN).toBeUndefined();
  });

  it.each([false, true])("replaceBlock 在 overlay=%s 时均继承图表持久化布局", (withOverlay) => {
    const source: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "diagram",
        attrs: {
          blockId: "diagram-height",
          lang: "mermaid",
          source: "flowchart TD\n  A --> B\n",
          svg: null,
          height: 360,
          width: 480,
          align: "right",
          ...(withOverlay ? { overlay: { positions: { A: { x: 10, y: 20 } } } } : {}),
        },
      }],
    };

    const result = applyBlockEdits(source, [{
      action: "replaceBlock",
      ref: "diagram-height",
      block: {
        type: "diagram",
        lang: "mermaid",
        source: "flowchart TD\n  A[新开始] --> B[结束]\n",
      },
    }]);

    expect(result.ok).toBe(true);
    const block = firstDiagram(result.doc!);
    expect(block.attrs.height).toBe(360);
    expect(block.attrs.width).toBe(480);
    expect(block.attrs.align).toBe("right");
    expect(block.attrs.overlay?.positions?.A).toEqual(withOverlay ? { x: 10, y: 20 } : undefined);
  });

  it("deleteBlock + insertBlock 移动同一张图时承接用户布局且允许 blockId 断链", () => {
    const source = docWithOverlay();
    const original = firstDiagram(source);
    original.attrs.height = 645;
    original.attrs.width = 654;
    original.attrs.align = "left";
    source.content.push({
      type: "paragraph",
      attrs: { blockId: "paragraph-after" },
      content: [{ type: "text", text: "图后正文" }],
    });

    const result = applyBlockEdits(source, [
      { action: "deleteBlock", ref: "diagram-1" },
      {
        action: "insertBlock",
        position: "end",
        blocks: [{
          type: "diagram",
          lang: "mermaid",
          source: original.attrs.source,
        }],
      },
    ]);

    expect(result.ok).toBe(true);
    const moved = result.doc!.content.at(-1);
    expect(moved?.type).toBe("diagram");
    if (moved?.type !== "diagram") throw new Error("expected moved diagram");
    expect(moved.attrs.blockId).not.toBe("diagram-1");
    expect(moved.attrs.overlay).toEqual({
      positions: {
        A: { x: 10, y: 20 },
        B: { x: 210, y: 20 },
      },
      styles: {
        A: { fill: "#fff3a3", fontSize: 16, width: 240, height: 112 },
      },
      edgeHandles: {
        [stableEdgeId("flow", { source: "A", target: "B", syntaxKind: "-->" }, 0)]: {
          sourceHandle: "r",
          targetHandle: "l",
        },
      },
    });
    expect(moved.attrs.width).toBe(654);
    expect(moved.attrs.height).toBe(645);
    expect(moved.attrs.align).toBe("left");
  });

  it("deleteBlock + insertBlock 内容不同的两张图不会串用用户布局", () => {
    const source = docWithOverlay();
    const original = firstDiagram(source);
    original.attrs.height = 645;
    original.attrs.width = 654;
    original.attrs.align = "left";

    const result = applyBlockEdits(source, [
      { action: "deleteBlock", ref: "diagram-1" },
      {
        action: "insertBlock",
        position: "end",
        blocks: [{
          type: "diagram",
          lang: "mermaid",
          source: "flowchart TD\n  X[另一张图] --> Y[结束]\n",
        }],
      },
    ]);

    expect(result.ok).toBe(true);
    const inserted = firstDiagram(result.doc!);
    expect(inserted.attrs.overlay).toBeUndefined();
    expect(inserted.attrs.width).toBeUndefined();
    expect(inserted.attrs.height).toBeUndefined();
    expect(inserted.attrs.align).toBeUndefined();
  });

  it("两张同内容旧图只插入一张时因配对不唯一而不承接", () => {
    const source = docWithOverlay();
    const first = firstDiagram(source);
    first.attrs.width = 654;
    source.content.push({
      ...first,
      attrs: {
        ...first.attrs,
        blockId: "diagram-2",
        width: 777,
        overlay: { positions: { A: { x: 50, y: 60 } } },
      },
    });

    const result = applyBlockEdits(source, [
      { action: "deleteBlock", ref: "diagram-1" },
      { action: "deleteBlock", ref: "diagram-2" },
      {
        action: "insertBlock",
        position: "end",
        blocks: [{ type: "diagram", lang: "mermaid", source: first.attrs.source }],
      },
    ]);

    expect(result.ok).toBe(true);
    const inserted = firstDiagram(result.doc!);
    expect(inserted.attrs.overlay).toBeUndefined();
    expect(inserted.attrs.width).toBeUndefined();
  });

  it("replaceBlock 删除无关早序边后继承未改边 edgeStyles", () => {
    const styledEdgeId = stableEdgeId("flow", { source: "B", target: "C", syntaxKind: "-->" }, 0);
    const base: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "diagram",
        attrs: {
          blockId: "diagram-1",
          lang: "mermaid",
          source: "flowchart TD\n  A[起点] --> B[处理]\n  B --> C[结束]\n",
          svg: null,
          overlay: {
            edgeStyles: {
              [styledEdgeId]: { stroke: "#d14", strokeWidth: 3 },
            },
            edgeHandles: {
              [styledEdgeId]: { sourceHandle: "b", targetHandle: "t" },
            },
          },
        },
      }],
    };

    const result = applyBlockEdits(base, [
      {
        action: "replaceBlock",
        ref: "diagram-1",
        block: {
          type: "diagram",
          lang: "mermaid",
          source: "flowchart TD\n  B[处理] --> C[结束]\n",
        },
      },
    ]);

    expect(result.ok).toBe(true);
    const block = firstDiagram(result.doc!);
    expect(block.attrs.overlay?.edgeStyles?.[styledEdgeId]).toEqual({ stroke: "#d14", strokeWidth: 3 });
    expect(block.attrs.overlay?.edgeHandles?.[styledEdgeId]).toEqual({ sourceHandle: "b", targetHandle: "t" });
  });
});

function stableEdgeId(
  prefix: string,
  input: { source: string; target: string; syntaxKind: string; label?: string },
  occurrence: number,
): string {
  return `${prefix}-edge-${hashText(JSON.stringify([input.source, input.target, input.syntaxKind, input.label ?? null, occurrence]))}`;
}

function hashText(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
