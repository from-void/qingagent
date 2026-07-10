// @vitest-environment jsdom

import type { DocSuggestion } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import type { AppliedPatch, BlockPatchInput, ViewBlock } from "./protocol";
import { buildPatchDecorations } from "./patchDecorations";

const baselineDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "p-1" },
      content: [{ type: "text", text: "abcdef" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "p-2" },
      content: [{ type: "text", text: "ghij" }],
    },
  ],
};

const insertedBlock: ViewBlock = {
  kind: "p",
  blockId: "p-new",
  spans: [{ kind: "text", text: "新增段落" }],
};

function suggestion(
  id: string,
  pmFrom: number,
  pmTo: number,
  deleteText: string,
  insertText: string,
  stepType = "replace",
): DocSuggestion {
  return {
    id,
    docId: "doc-1",
    baseVersion: 1,
    baseSchemaVersion: 1,
    status: "reviewing",
    anchor: {
      blockId: "p-1",
      pmFrom,
      pmTo,
      quote: deleteText || insertText,
      textHash: "hash",
    },
    patch: {
      kind: "prosemirror_steps",
      steps: [{ stepType, from: pmFrom, to: pmTo }],
    },
    preview: { deleteText, insertText },
    summary: "测试补丁",
  };
}

function applied(
  id: string,
  index: number,
  kind: AppliedPatch["kind"],
  before: string,
  after: string,
): AppliedPatch {
  return {
    id,
    reviewBatchId: id,
    groupMode: "independent",
    before,
    after,
    kind,
    index,
  };
}

function className(decoration: unknown): string {
  return String((decoration as { type: { attrs?: { class?: string } } }).type.attrs?.class ?? "");
}

function spec(decoration: unknown): Record<string, unknown> {
  return (decoration as { spec: Record<string, unknown> }).spec;
}

function attrs(decoration: unknown): Record<string, unknown> {
  return (decoration as { type: { attrs?: Record<string, unknown> } }).type.attrs ?? {};
}

function widgetDom(decoration: unknown): HTMLElement {
  const widget = decoration as { type: { toDOM: unknown } };
  return (widget.type.toDOM as () => HTMLElement)();
}

describe("buildPatchDecorations", () => {
  it("把新增补丁构建为 pmFrom 处的 widget decoration", () => {
    const { decorations, dropped } = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-ins", 4, 4, "", "X", "replace")],
      applied: [applied("p-ins", 1, "insert", "", "X")],
    });

    expect(dropped).toEqual([]);
    expect(decorations).toHaveLength(1);
    expect(decorations[0]?.from).toBe(4);
    expect(decorations[0]?.to).toBe(4);
    expect(spec(decorations[0])).toMatchObject({
      "data-patch-id": "p-ins",
      "data-patch-index": 1,
      patchKind: "insert",
    });
  });

  it("未入场的补丁不产出 decoration", () => {
    const { decorations, dropped } = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-hidden", 4, 4, "", "X", "replace")],
      applied: [applied("p-hidden", 1, "insert", "", "X")],
      revealedPatchIds: new Set(),
    });

    expect(decorations).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("按 typedByPatch 用 grapheme 截断新增 widget 文本", () => {
    const { decorations } = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-type", 4, 4, "", "中😀文", "replace")],
      applied: [applied("p-type", 1, "insert", "", "中😀文")],
      typedByPatch: new Map([["p-type", 2]]),
    });

    expect(decorations).toHaveLength(1);
    expect(widgetDom(decorations[0]).querySelector(".wf-patch-ins")?.textContent).toBe("中😀");
  });

  it("打字数为 0 时可只渲染 nativePresentationPm 游标 widget", () => {
    const { decorations } = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-cursor", 4, 4, "", "新增", "replace")],
      applied: [applied("p-cursor", 1, "insert", "", "新增")],
      typedByPatch: new Map([["p-cursor", 0]]),
      revealCursors: new Map([["p-cursor", 1]]),
    });

    expect(decorations).toHaveLength(1);
    const dom = widgetDom(decorations[0]);
    expect(dom.className).toContain("native-presentation-cursor");
    expect(dom.className).toContain("ai-cursor");
  });

  it("revealCursors 命中的游标 widget 带 data-hc-lane 锚点(供拟人鼠标画出小赵/小钱名)", () => {
    // 回归:二次修改揭示时光标必须打 lane 锚点,否则 HumanCursorOverlay 扫不到、无名字。
    const { decorations } = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-cursor", 4, 4, "", "新增", "replace")],
      applied: [applied("p-cursor", 1, "insert", "", "新增")],
      typedByPatch: new Map([["p-cursor", 0]]),
      revealCursors: new Map([["p-cursor", 2]]),
    });

    const dom = widgetDom(decorations[0]);
    expect(dom.getAttribute("data-hc-lane")).toBe("2");
    expect(dom.getAttribute("data-hc-name")).toBe("小钱");
  });

  it("把删除补丁构建为覆盖 pmFrom..pmTo 的 wf-patch-del inline decoration 加光标 widget", () => {
    const { decorations } = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-del", 2, 4, "bc", "", "replace")],
      applied: [applied("p-del", 2, "delete", "bc", "")],
    });

    expect(decorations).toHaveLength(2);
    expect(decorations[0]?.from).toBe(2);
    expect(decorations[0]?.to).toBe(4);
    expect(className(decorations[0])).toContain("wf-patch-del");
    expect(attrs(decorations[0]).style).toBeUndefined();
    expect(attrs(decorations[0])["data-patch-state"]).toBe("delete");
    expect(spec(decorations[0])["data-patch-id"]).toBe("p-del");
    expect(decorations[1]?.from).toBe(2);
    expect(decorations[1]?.to).toBe(2);
    expect(spec(decorations[1])).toMatchObject({
      "data-patch-id": "p-del",
      patchKind: "delete",
    });
    expect(widgetDom(decorations[1]).className).toContain("wf-patch-del-marker");
    expect(widgetDom(decorations[1]).querySelector(".patch-del-cursor")).not.toBeNull();
  });

  it("把替换补丁构建为删除 inline 加红光标 widget 加新增 widget", () => {
    const { decorations } = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-replace", 3, 5, "cd", "XY", "replace")],
      applied: [applied("p-replace", 3, "replace", "cd", "XY")],
    });

    expect(decorations).toHaveLength(3);
    expect(decorations[0]?.from).toBe(3);
    expect(decorations[0]?.to).toBe(5);
    expect(className(decorations[0])).toContain("wf-patch-del");
    expect(attrs(decorations[0]).style).toBeUndefined();
    expect(decorations[1]?.from).toBe(3);
    expect(decorations[1]?.to).toBe(3);
    expect(spec(decorations[1])).toMatchObject({
      "data-patch-id": "p-replace",
      patchKind: "replace",
    });
    expect(widgetDom(decorations[1]).className).toContain("wf-patch-del-marker");
    expect(widgetDom(decorations[1]).querySelector(".patch-del-cursor")).not.toBeNull();
    expect(decorations[2]?.from).toBe(3);
    expect(decorations[2]?.to).toBe(3);
    expect(spec(decorations[2])).toMatchObject({
      "data-patch-id": "p-replace",
      patchKind: "replace",
    });
    expect(widgetDom(decorations[2]).className).toContain("wf-patch-replace-wrap");
    expect(widgetDom(decorations[2]).querySelector(".wf-patch-ins")).not.toBeNull();
  });

  it("把 markChange 构建为 wf-patch-mark inline decoration", () => {
    const { decorations } = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-mark", 2, 3, "b", "b", "addMark")],
      applied: [applied("p-mark", 4, "markAdd", "b", "b")],
    });

    expect(decorations).toHaveLength(1);
    expect(decorations[0]?.from).toBe(2);
    expect(decorations[0]?.to).toBe(3);
    expect(className(decorations[0])).toContain("wf-patch-mark");
    expect(spec(decorations[0])).toMatchObject({
      "data-patch-id": "p-mark",
      "data-patch-index": 4,
      patchKind: "markAdd",
    });
  });

  it("当前补丁追加 is-current class", () => {
    const { decorations } = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-del", 2, 4, "bc", "", "replace")],
      applied: [applied("p-del", 2, "delete", "bc", "")],
      activePatchId: "p-del",
    });

    expect(className(decorations[0])).toContain("is-current");
  });

  it("坏锚点越界时进入 dropped 且不抛错、不产出 decoration", () => {
    const result = buildPatchDecorations({
      baselineDoc,
      suggestions: [suggestion("p-bad", 2, 999, "bc", "", "replace")],
      applied: [applied("p-bad", 5, "delete", "bc", "")],
    });

    expect(result.decorations).toEqual([]);
    expect(result.dropped).toEqual(["p-bad"]);
  });

  it("把块级新增构建为块边界处的 widget decoration，并复用 viewSectionsToHtml 输出块 DOM", () => {
    const { decorations, dropped } = buildPatchDecorations({
      baselineDoc,
      blockPatches: [blockPatch("block-ins", "insert", { anchorBlockId: "p-1", gravity: "after" })],
      applied: [applied("block-ins", 6, "insert", "", "新增段落")],
    });

    expect(dropped).toEqual([]);
    expect(decorations).toHaveLength(1);
    expect(decorations[0]?.from).toBe(8);
    expect(spec(decorations[0])).toMatchObject({
      "data-patch-id": "block-ins",
      "data-patch-index": 6,
      patchKind: "insert",
    });
    const dom = widgetDom(decorations[0]);
    expect(dom.className).toContain("wf-blockmark insert");
    expect(dom.dataset.patchId).toBe("block-ins");
    expect(dom.querySelector(".wf-patch-ins p")?.textContent).toBe("新增段落");
  });

  it("把块级删除构建为覆盖整块的 node decoration 加红色块标记 widget", () => {
    const { decorations, dropped } = buildPatchDecorations({
      baselineDoc,
      blockPatches: [blockPatch("block-del", "delete", { anchorBlockId: "p-2", blockCount: 1 })],
      applied: [applied("block-del", 7, "delete", "ghij", "")],
    });

    expect(dropped).toEqual([]);
    expect(decorations).toHaveLength(2);
    expect(decorations[0]?.from).toBe(8);
    expect(decorations[0]?.to).toBe(14);
    expect(className(decorations[0])).toContain("wf-blockmark delete");
    expect(attrs(decorations[0])["data-patch-id"]).toBe("block-del");
    expect(attrs(decorations[0])["data-patch-state"]).toBe("delete");
    expect(widgetDom(decorations[1]).querySelector(".wf-blockmark-del-line")).not.toBeNull();
  });

  it("把块级替换构建为删除旧块 node decoration 加新增块 widget", () => {
    const { decorations, dropped } = buildPatchDecorations({
      baselineDoc,
      blockPatches: [blockPatch("block-rep", "replace", { anchorBlockId: "p-1" })],
      applied: [applied("block-rep", 8, "replace", "abcdef", "新增段落")],
    });

    expect(dropped).toEqual([]);
    expect(decorations).toHaveLength(3);
    expect(className(decorations[0])).toContain("wf-blockmark delete");
    expect(widgetDom(decorations[2]).className).toContain("wf-blockmark insert");
    expect(widgetDom(decorations[2]).dataset.patchState).toBe("replace");
  });

  it("块级坏锚点进入 dropped 且不产出 decoration", () => {
    const result = buildPatchDecorations({
      baselineDoc,
      blockPatches: [blockPatch("block-bad", "insert", { anchorBlockId: "missing" })],
      applied: [applied("block-bad", 9, "insert", "", "新增段落")],
    });

    expect(result.decorations).toEqual([]);
    expect(result.dropped).toEqual(["block-bad"]);
  });
});

function blockPatch(
  patchId: string,
  op: BlockPatchInput["op"],
  overrides: Partial<BlockPatchInput> = {},
): BlockPatchInput {
  return {
    patchId,
    op,
    anchorBlockId: "p-1",
    blocks: [insertedBlock],
    blockCount: 1,
    ...overrides,
  };
}
