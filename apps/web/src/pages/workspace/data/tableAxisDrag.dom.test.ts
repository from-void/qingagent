// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { describe, expect, it } from "vitest";
import { applyTableAxisDrop, inspectTableAxisDrop, type TableAxisDropInput } from "./tableAxisDrag";

function createEditor(table = tableJson()): Editor {
  return new Editor({
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: "before" }, content: [{ type: "text", text: "正文" }] },
        table,
      ],
    },
  });
}

function tableJson() {
  return {
    type: "table",
    attrs: { blockId: "table-drag" },
    content: [
      row([cell("H1", "h1", "tableHeader", 80, "#fff3a3"), cell("H2", "h2", "tableHeader", 90), cell("H3", "h3", "tableHeader", 100)]),
      row([cell("A1", "a1", "tableCell", 80, "#eef7e8"), cell("A2", "a2", "tableCell", 90), cell("A3", "a3", "tableCell", 100)]),
      row([cell("B1", "b1", "tableCell", 80), cell("B2", "b2", "tableCell", 90), cell("B3", "b3", "tableCell", 100)]),
    ],
  };
}

function tableWithLeafNode(kind: "inlineMath" | "image") {
  const table = tableJson();
  table.content[0]!.content[0]!.content = (kind === "inlineMath"
    ? [{
        type: "paragraph",
        attrs: { blockId: "leaf-inline-paragraph" },
        content: [
          { type: "text", text: "H1" },
          { type: "inlineMath", attrs: { latex: "x^2" } },
        ],
      }]
    : [{
        type: "image",
        attrs: {
          blockId: "leaf-image",
          src: "https://example.com/image.png",
          alt: "H1",
          caption: "H1",
        },
      }]) as never;
  return table;
}

function row(content: ReturnType<typeof cell>[]) {
  return { type: "tableRow", content };
}

function cell(
  text: string,
  id: string,
  type: "tableCell" | "tableHeader",
  width: number,
  backgroundColor: string | null = null,
) {
  return {
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: [width], backgroundColor },
    content: [{ type: "paragraph", attrs: { blockId: id }, content: [{ type: "text", text }] }],
  };
}

function texts(editor: Editor): string[][] {
  const table = editor.state.doc.child(1);
  return Array.from({ length: table.childCount }, (_, rowIndex) => {
    const rowNode = table.child(rowIndex);
    return Array.from({ length: rowNode.childCount }, (_, cellIndex) => rowNode.child(cellIndex).textContent);
  });
}

function apply(editor: Editor, patch: Partial<TableAxisDropInput>): boolean {
  return applyTableAxisDrop(editor, {
    blockId: "table-drag",
    axis: "row",
    sourceStart: 1,
    sourceEnd: 1,
    dropBoundary: 3,
    clone: false,
    ...patch,
  });
}

describe("table axis drag transaction", () => {
  it.each([
    [{ axis: "row", sourceStart: 1, sourceEnd: 1, dropBoundary: 3 }, [["H1", "H2", "H3"], ["B1", "B2", "B3"], ["A1", "A2", "A3"]]],
    [{ axis: "row", sourceStart: 2, sourceEnd: 2, dropBoundary: 1 }, [["H1", "H2", "H3"], ["B1", "B2", "B3"], ["A1", "A2", "A3"]]],
    [{ axis: "column", sourceStart: 0, sourceEnd: 0, dropBoundary: 3 }, [["H2", "H3", "H1"], ["A2", "A3", "A1"], ["B2", "B3", "B1"]]],
    [{ axis: "column", sourceStart: 2, sourceEnd: 2, dropBoundary: 0 }, [["H3", "H1", "H2"], ["A3", "A1", "A2"], ["B3", "B1", "B2"]]],
  ] as const)("普通表前移/后移/首尾保持物理内容", (patch, expected) => {
    const editor = createEditor();
    try {
      expect(apply(editor, patch)).toBe(true);
      expect(texts(editor)).toEqual(expected);
    } finally {
      editor.destroy();
    }
  });

  it("列迁移携带 header/colwidth/bg，undo 一步还原", () => {
    const editor = createEditor();
    const beforeTable = editor.state.doc.child(1).toJSON();
    try {
      expect(apply(editor, { axis: "column", sourceStart: 0, sourceEnd: 0, dropBoundary: 3 })).toBe(true);
      const table = editor.state.doc.child(1);
      const movedHeader = table.child(0).child(2);
      const movedBody = table.child(1).child(2);
      expect(movedHeader.type.name).toBe("tableHeader");
      expect(movedHeader.attrs.colwidth).toEqual([80]);
      expect(movedHeader.attrs.backgroundColor).toBe("#fff3a3");
      expect(movedBody.attrs.backgroundColor).toBe("#eef7e8");
      expect(editor.commands.undo()).toBe(true);
      // StarterKit 会对文末 table 另补不进历史的 trailing paragraph；表格本体须一次 undo 精确还原。
      expect(editor.state.doc.child(1).toJSON()).toEqual(beforeTable);
    } finally {
      editor.destroy();
    }
  });

  it.each(["inlineMath", "image"] as const)("前置单元格含 %s 叶子节点时列迁移仍按真实 nodeSize 定位", (kind) => {
    const editor = createEditor(tableWithLeafNode(kind));
    try {
      expect(apply(editor, {
        axis: "column",
        sourceStart: 0,
        sourceEnd: 0,
        dropBoundary: 3,
      })).toBe(true);
      expect(texts(editor)[0]?.slice(0, 2)).toEqual(["H2", "H3"]);
      const movedCell = editor.state.doc.child(1).child(0).child(2);
      expect(kind === "inlineMath"
        ? movedCell.firstChild?.child(1).type.name
        : movedCell.firstChild?.type.name).toBe(kind);
    } finally {
      editor.destroy();
    }
  });

  it.each(["row", "column"] as const)("Alt 克隆 %s 并深度重写后代 blockId", (axis) => {
    const editor = createEditor();
    try {
      expect(apply(editor, {
        axis,
        sourceStart: 1,
        sourceEnd: 1,
        dropBoundary: 3,
        clone: true,
      })).toBe(true);
      const ids: string[] = [];
      editor.state.doc.descendants((node) => {
        if (typeof node.attrs.blockId === "string") ids.push(node.attrs.blockId);
        return true;
      });
      expect(new Set(ids).size).toBe(ids.length);
      expect(axis === "row" ? texts(editor).length : texts(editor)[0]?.length).toBe(4);
    } finally {
      editor.destroy();
    }
  });

  it("跨 rowspan/colspan 的源集合与落点全部 fail-closed", () => {
    const merged = {
      type: "table",
      attrs: { blockId: "table-drag" },
      content: [
        row([
          { ...cell("M", "m", "tableCell", 160), attrs: { colspan: 2, rowspan: 2, colwidth: [80, 80], backgroundColor: null } },
          cell("X", "x", "tableCell", 80),
        ]),
        row([cell("Y", "y", "tableCell", 80)]),
        row([cell("Z1", "z1", "tableCell", 80), cell("Z2", "z2", "tableCell", 80), cell("Z3", "z3", "tableCell", 80)]),
      ],
    };
    const editor = createEditor(merged);
    try {
      expect(inspectTableAxisDrop(editor, {
        blockId: "table-drag", axis: "row", sourceStart: 0, sourceEnd: 0, dropBoundary: 3,
      })).toMatchObject({ allowed: false, reason: "source-cuts-span" });
      expect(inspectTableAxisDrop(editor, {
        blockId: "table-drag", axis: "row", sourceStart: 2, sourceEnd: 2, dropBoundary: 1,
      })).toMatchObject({ allowed: false, reason: "drop-cuts-span" });
      expect(inspectTableAxisDrop(editor, {
        blockId: "table-drag", axis: "column", sourceStart: 0, sourceEnd: 0, dropBoundary: 3,
      })).toMatchObject({ allowed: false, reason: "source-cuts-span" });
      expect(inspectTableAxisDrop(editor, {
        blockId: "table-drag", axis: "column", sourceStart: 2, sourceEnd: 2, dropBoundary: 1,
      })).toMatchObject({ allowed: false, reason: "drop-cuts-span" });
    } finally {
      editor.destroy();
    }
  });
});
