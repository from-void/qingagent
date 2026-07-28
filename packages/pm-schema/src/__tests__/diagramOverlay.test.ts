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

  it.each([false, true])("replaceBlock 在 overlay=%s 时均继承图表持久化高度", (withOverlay) => {
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
    expect(block.attrs.overlay?.positions?.A).toEqual(withOverlay ? { x: 10, y: 20 } : undefined);
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
