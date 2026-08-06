import { describe, expect, it } from "vitest";
import {
  applyBlockEdits,
  carryOverMovedBlockUserAttrs,
  detectMovedBlockUserAttrLosses,
} from "../ai-ir/applyBlockEdits";
import { pmToAiIr } from "../ai-ir/pmToAiIr";
import { getPmContentHash } from "../hash";
import type { PmBlockNode, PmDiagramNode, PmDiagramOverlay, PmDoc } from "../types";
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
            zOrders: { A: 1, B: 0, ORPHAN: 9 },
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

function diagramBlock(
  blockId: string,
  source: string,
  overlay?: PmDiagramOverlay,
): PmDiagramNode {
  return {
    type: "diagram",
    attrs: {
      blockId,
      lang: "mermaid",
      source,
      svg: null,
      ...(overlay ? { overlay } : {}),
    },
  };
}

function paragraphBlock(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [{ type: "text", text }],
  };
}

function diagramById(doc: PmDoc, blockId: string): PmDiagramNode {
  const block = doc.content.find((item) => item.attrs.blockId === blockId);
  if (block?.type !== "diagram") throw new Error(`expected diagram block ${blockId}`);
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
    expect(block.attrs.overlay?.zOrders).toEqual({ A: 1, B: 0 });
    const edgeId = stableEdgeId("flow", { source: "A", target: "B", syntaxKind: "-->" }, 0);
    expect(block.attrs.overlay?.edgeHandles?.[edgeId]).toEqual({ sourceHandle: "r", targetHandle: "l" });
    expect(block.attrs.overlay?.edgeHandles?.ORPHAN).toBeUndefined();
  });

  it("无空格 A-->B 在 replaceBlock 与移动路径都提取 A/B，且不把 A-- 当节点", () => {
    const source = "flowchart TD\n  A-->B\n";
    const overlay: PmDiagramOverlay = {
      positions: {
        A: { x: 10, y: 20 },
        B: { x: 210, y: 20 },
        "A--": { x: 999, y: 999 },
      },
    };
    const spacer = paragraphBlock("paragraph-1", "间隔");
    const oldDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [diagramBlock("diagram-old", source, overlay), spacer],
    };

    const replaced = applyBlockEdits(oldDoc, [{
      action: "replaceBlock",
      ref: "diagram-old",
      block: { type: "diagram", lang: "mermaid", source: "flowchart TD\n  A --> B\n" },
    }]);
    expect(replaced.ok).toBe(true);
    expect(firstDiagram(replaced.doc!).attrs.overlay?.positions).toEqual({
      A: { x: 10, y: 20 },
      B: { x: 210, y: 20 },
    });

    const moved = carryOverMovedBlockUserAttrs(oldDoc, {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [spacer, diagramBlock("diagram-new", source)],
    });
    expect(moved.carriedCount).toBe(1);
    expect(diagramById(moved.doc, "diagram-new").attrs.overlay?.positions).toEqual({
      A: { x: 10, y: 20 },
      B: { x: 210, y: 20 },
    });
  });

  it("中文 id 的无空格箭头保留两端节点 overlay", () => {
    const source = "flowchart TD\n  n_新节点_1-->n_新节点_2\n";
    const oldDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [diagramBlock("diagram-unicode-no-space", source, {
        positions: {
          n_新节点_1: { x: 20, y: 40 },
          n_新节点_2: { x: 240, y: 40 },
        },
      })],
    };

    const result = applyBlockEdits(oldDoc, [{
      action: "replaceBlock",
      ref: "diagram-unicode-no-space",
      block: { type: "diagram", lang: "mermaid", source },
    }]);

    expect(result.ok).toBe(true);
    expect(firstDiagram(result.doc!).attrs.overlay?.positions).toEqual({
      n_新节点_1: { x: 20, y: 40 },
      n_新节点_2: { x: 240, y: 40 },
    });
  });

  it.each([
    { arrow: "-->", shapeName: "rect", oldShape: "[旧标签]", newShape: "[新标签]" },
    { arrow: "-.->", shapeName: "rect", oldShape: "[旧标签]", newShape: "[新标签]" },
    { arrow: "==>", shapeName: "rect", oldShape: "[旧标签]", newShape: "[新标签]" },
    { arrow: "-->", shapeName: "round", oldShape: "(旧标签)", newShape: "(新标签)" },
    { arrow: "-.->", shapeName: "round", oldShape: "(旧标签)", newShape: "(新标签)" },
    { arrow: "==>", shapeName: "round", oldShape: "(旧标签)", newShape: "(新标签)" },
    { arrow: "-->", shapeName: "diamond", oldShape: "{旧标签}", newShape: "{新标签}" },
    { arrow: "-.->", shapeName: "diamond", oldShape: "{旧标签}", newShape: "{新标签}" },
    { arrow: "==>", shapeName: "diamond", oldShape: "{旧标签}", newShape: "{新标签}" },
  ])("无空格 $arrow + $shapeName 形状保留节点与边 overlay", ({ arrow, shapeName, oldShape, newShape }) => {
    const sourceId = `source-${shapeName}`;
    const targetId = `target-${shapeName}`;
    const oldSource = `flowchart TD\n  ${sourceId}${oldShape}${arrow}${targetId}\n`;
    const newSource = `flowchart TD\n  ${sourceId}${newShape}${arrow}${targetId}\n`;
    const edgeId = stableEdgeId("flow", {
      source: sourceId,
      target: targetId,
      syntaxKind: arrow,
    }, 0);
    const oldDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [diagramBlock(`diagram-${shapeName}-${arrow}`, oldSource, {
        positions: {
          [sourceId]: { x: 10, y: 20 },
          [targetId]: { x: 210, y: 20 },
        },
        edgeStyles: { [edgeId]: { stroke: "#d14", strokeWidth: 3 } },
      })],
    };

    const result = applyBlockEdits(oldDoc, [{
      action: "replaceBlock",
      ref: `diagram-${shapeName}-${arrow}`,
      block: { type: "diagram", lang: "mermaid", source: newSource },
    }]);

    expect(result.ok).toBe(true);
    const overlay = firstDiagram(result.doc!).attrs.overlay;
    expect(overlay?.positions).toEqual({
      [sourceId]: { x: 10, y: 20 },
      [targetId]: { x: 210, y: 20 },
    });
    expect(overlay?.edgeStyles?.[edgeId]).toEqual({ stroke: "#d14", strokeWidth: 3 });
  });

  it("同一 blockId 的图表换位且 overlay 丢失时仍承接", () => {
    const source = "flowchart TD\n  A --> B\n";
    const spacer = paragraphBlock("paragraph-same-id", "间隔");
    const oldDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [diagramBlock("diagram-same-id", source, {
        positions: { A: { x: 10, y: 20 }, B: { x: 210, y: 20 } },
      }), spacer],
    };
    const newDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [spacer, diagramBlock("diagram-same-id", source)],
    };

    const carried = carryOverMovedBlockUserAttrs(oldDoc, newDoc);

    expect(carried.carriedCount).toBe(1);
    expect(diagramById(carried.doc, "diagram-same-id").attrs.overlay?.positions).toEqual({
      A: { x: 10, y: 20 },
      B: { x: 210, y: 20 },
    });
  });

  it("同一 blockId 的承接结果确实缺 overlay 时，损失检测仍以结果事实报告", () => {
    const source = "flowchart TD\n  A-->B\n";
    const spacer = paragraphBlock("paragraph-loss", "间隔");
    const oldDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [diagramBlock("diagram-loss", source, {
        positions: { A: { x: 10, y: 20 }, B: { x: 210, y: 20 } },
      }), spacer],
    };
    const failedResult: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [spacer, diagramBlock("diagram-loss", source)],
    };

    expect(detectMovedBlockUserAttrLosses(oldDoc, failedResult)).toEqual(["diagram"]);
  });

  it("重复图与一对多移动继续放弃承接", () => {
    const source = "flowchart TD\n  A --> B\n";
    const overlay: PmDiagramOverlay = { positions: { A: { x: 10, y: 20 } } };
    const duplicateOld: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        diagramBlock("duplicate-old-1", source, overlay),
        diagramBlock("duplicate-old-2", source, overlay),
      ],
    };
    const duplicateNew: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        diagramBlock("duplicate-new-1", source),
        diagramBlock("duplicate-new-2", source),
      ],
    };
    const duplicateResult = carryOverMovedBlockUserAttrs(duplicateOld, duplicateNew);
    expect(duplicateResult.carriedCount).toBe(0);
    expect(duplicateResult.doc.content.every((block) => block.type !== "diagram" || block.attrs.overlay == null)).toBe(true);

    const oneToManyOld: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [diagramBlock("one-old", source, overlay)],
    };
    const oneToManyNew: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [diagramBlock("many-new-1", source), diagramBlock("many-new-2", source)],
    };
    const oneToManyResult = carryOverMovedBlockUserAttrs(oneToManyOld, oneToManyNew);
    expect(oneToManyResult.carriedCount).toBe(0);
    expect(oneToManyResult.doc.content.every((block) => block.type !== "diagram" || block.attrs.overlay == null)).toBe(true);

    const stationaryDuplicate = diagramBlock("stationary-duplicate", source);
    const spacer = paragraphBlock("duplicate-spacer", "间隔");
    const partiallyMovedOld: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [diagramBlock("moved-duplicate", source, overlay), spacer, stationaryDuplicate],
    };
    const partiallyMovedNew: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [spacer, diagramBlock("moved-duplicate", source), stationaryDuplicate],
    };
    const stationaryDuplicateResult = carryOverMovedBlockUserAttrs(partiallyMovedOld, partiallyMovedNew);
    expect(stationaryDuplicateResult.carriedCount).toBe(0);
    expect(diagramById(stationaryDuplicateResult.doc, "moved-duplicate").attrs.overlay).toBeUndefined();
  });

  it("replaceBlock 跳过单行、多行及连续 init 指令，并保留节点、分区与层级 overlay", () => {
    const oldSource = [
      "%%{init: {",
      "  'theme': 'base',",
      "  'themeVariables': {'clusterBkg':'#EFE7D6','clusterBorder':'#2F2A22'}",
      "}}%%",
      "%%{wrap: true}%%",
      "flowchart LR",
      '  subgraph Front["前端"]',
      "    Web[Web]",
      "  end",
      "  Web --> Api[API]",
      "",
    ].join("\n");
    const nextSource = oldSource.replace("Web[Web]", "Web[Web 应用]");
    const source: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "diagram",
        attrs: {
          blockId: "diagram-init",
          lang: "mermaid",
          source: oldSource,
          svg: null,
          overlay: {
            positions: {
              Front: { x: 417, y: 11 },
              Web: { x: 447, y: 77 },
              Api: { x: 680, y: 77 },
            },
            zOrders: { Web: 1, Api: 0 },
          },
        },
      }],
    };

    const result = applyBlockEdits(source, [{
      action: "replaceBlock",
      ref: "diagram-init",
      block: { type: "diagram", lang: "mermaid", source: nextSource },
    }]);

    expect(result.ok).toBe(true);
    const overlay = firstDiagram(result.doc!).attrs.overlay;
    expect(overlay?.positions).toEqual({
      Front: { x: 417, y: 11 },
      Web: { x: 447, y: 77 },
      Api: { x: 680, y: 77 },
    });
    expect(overlay?.zOrders).toEqual({ Web: 1, Api: 0 });
    expect(overlay).toStrictEqual({
      positions: {
        Front: { x: 417, y: 11 },
        Web: { x: 447, y: 77 },
        Api: { x: 680, y: 77 },
      },
      zOrders: { Web: 1, Api: 0 },
    });
    expect(safeParsePmDoc(result.doc).success).toBe(true);
  });

  it("replaceBlock 保留产品生成及存量中文 Mermaid id 的 overlay", () => {
    const oldSource = [
      "flowchart TD",
      '  A[开始] --> n_新节点_1["新节点"]',
      '  n_新节点_1 --> 存量节点["存量节点"]',
      "",
    ].join("\n");
    const source: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "diagram",
        attrs: {
          blockId: "diagram-unicode-id",
          lang: "mermaid",
          source: oldSource,
          svg: null,
          overlay: {
            positions: {
              n_新节点_1: { x: 220, y: 80 },
              存量节点: { x: 440, y: 80 },
            },
          },
        },
      }],
    };

    const result = applyBlockEdits(source, [{
      action: "replaceBlock",
      ref: "diagram-unicode-id",
      block: {
        type: "diagram",
        lang: "mermaid",
        source: oldSource.replace('["新节点"]', '["新节点（已更新）"]'),
      },
    }]);

    expect(result.ok).toBe(true);
    expect(firstDiagram(result.doc!).attrs.overlay?.positions).toEqual({
      n_新节点_1: { x: 220, y: 80 },
      存量节点: { x: 440, y: 80 },
    });
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
