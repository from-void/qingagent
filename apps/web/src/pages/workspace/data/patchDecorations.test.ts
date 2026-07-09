// @vitest-environment jsdom

import type { DocSuggestion } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import type { AppliedPatch } from "./protocol";
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
  ],
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
});
