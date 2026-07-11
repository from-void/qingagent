import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, type PmDoc, type PmMark } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import { CellSelection } from "@tiptap/pm/tables";
import {
  applyTableToolbarFormat,
  readTableAxisSelection,
  selectTableColumns,
  selectTableRows,
  setTableCellSelectionFromDom,
  type TableToolbarFormatCommand,
} from "../../data/tableToolbar";
import { handleQingagentPaste, writeSelectionToClipboard } from "../../components/doc/clipboardPaste";
import { resolveWorkspaceFloatingPortalTarget } from "../../components/DocumentSnapshotView";

function createTableEditor() {
  return new Editor({
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "table",
          attrs: { blockId: "table-1" },
          content: [
            {
              type: "tableRow",
              content: [
                cell("a1"),
                cell("a2"),
              ],
            },
            {
              type: "tableRow",
              content: [
                cell("b1"),
                cell("b2"),
              ],
            },
          ],
        },
      ],
    } satisfies PmDoc,
  });
}

function createTwoTableEditor() {
  return new Editor({
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        table("table-1", [["a1", "a2"], ["b1", "b2"]]),
        table("table-2", [["c1", "c2"], ["d1", "d2"]]),
      ],
    } satisfies PmDoc,
  });
}

function table(blockId: string, rows: string[][]) {
  return {
    type: "table" as const,
    attrs: { blockId },
    content: rows.map((row) => ({
      type: "tableRow" as const,
      content: row.map(cell),
    })),
  };
}

function cell(text: string) {
  return {
    type: "tableCell" as const,
    content: [
      {
        type: "paragraph" as const,
        attrs: { blockId: `p-${text}` },
        content: [{ type: "text" as const, text }],
      },
    ],
  };
}

function allCellMarks(editor: Editor): PmMark[][] {
  const doc = normalizePmDoc(editor.getJSON());
  const table = doc.content[0];
  if (table?.type !== "table") return [];
  return table.content.flatMap((row) =>
    row.content.map((tableCell) => {
      const paragraph = tableCell.content[0];
      if (paragraph?.type !== "paragraph") return [];
      const text = paragraph.content?.[0];
      return text?.type === "text" ? text.marks ?? [] : [];
    }),
  );
}

function allCellBackgrounds(editor: Editor): Array<string | null | undefined> {
  const doc = normalizePmDoc(editor.getJSON());
  const table = doc.content[0];
  if (table?.type !== "table") return [];
  return table.content.flatMap((row) => row.content.map((tableCell) => tableCell.attrs?.backgroundColor));
}

function rowCellTexts(editor: Editor, rowIndex: number): string[] {
  type JsonNode = { text?: string; content?: JsonNode[] };
  const tableNode = (editor.getJSON() as JsonNode).content?.[0];
  const row = tableNode?.content?.[rowIndex];
  const textOf = (node: JsonNode): string =>
    node.text ?? node.content?.map(textOf).join("") ?? "";
  return row?.content?.map(textOf) ?? [];
}

describe("tableToolbar PM-010", () => {
  it("按 TableMap 建立整行/整列 CellSelection，并可从真实选区反推范围", () => {
    const editor = createTableEditor();
    try {
      expect(selectTableColumns(editor, "table-1", 0, 1)).toBe(true);
      expect(editor.state.selection).toBeInstanceOf(CellSelection);
      expect((editor.state.selection as CellSelection).isColSelection()).toBe(true);
      expect(readTableAxisSelection(editor, "table-1")).toEqual({
        axis: "column",
        startIndex: 0,
        endIndex: 1,
      });

      expect(selectTableRows(editor, "table-1", 1, 0)).toBe(true);
      expect((editor.state.selection as CellSelection).isRowSelection()).toBe(true);
      expect(readTableAxisSelection(editor, "table-1")).toEqual({
        axis: "row",
        startIndex: 0,
        endIndex: 1,
      });
      expect(selectTableRows(editor, "table-1", 1, 0)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it("两张表选列时 selectedCell 装饰只落到目标表", () => {
    const editor = createTwoTableEditor();
    try {
      expect(selectTableColumns(editor, "table-2", 0, 0)).toBe(true);
      const tables = editor.view.dom.querySelectorAll("table");
      expect(tables).toHaveLength(2);
      expect(tables[0]!.querySelectorAll(".selectedCell")).toHaveLength(0);
      expect(tables[1]!.querySelectorAll(".selectedCell")).toHaveLength(2);
    } finally {
      editor.destroy();
    }
  });

  it("整行 CellSelection 的 Delete 由表格插件清空所选单元格", () => {
    const editor = createTableEditor();
    try {
      expect(selectTableRows(editor, "table-1", 0, 0)).toBe(true);
      editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      expect(rowCellTexts(editor, 0)).toEqual(["", ""]);
      expect(rowCellTexts(editor, 1)).toEqual(["b1", "b2"]);
    } finally {
      editor.destroy();
    }
  });

  it("矩形 CellSelection 的 copy/cut/paste 直接放行 PM 表格插件", () => {
    const editor = createTableEditor();
    try {
      expect(selectTableColumns(editor, "table-1", 0, 0)).toBe(true);
      const clipboardData = {
        files: [],
        getData: () => "",
        setData: () => undefined,
      } as unknown as DataTransfer;
      const event = {
        clipboardData,
        preventDefault: () => undefined,
      } as unknown as ClipboardEvent;
      expect(writeSelectionToClipboard(editor.view, event, false)).toBe(false);
      expect(writeSelectionToClipboard(editor.view, event, true)).toBe(false);
      expect(handleQingagentPaste(editor.view, event)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it("表格浮动控件挂到 workspace 根层,脱离文档纸局部层叠上下文", () => {
    const root = document.createElement("div");
    root.id = "view-workspace";
    document.body.appendChild(root);
    try {
      expect(resolveWorkspaceFloatingPortalTarget()).toBe(root);
    } finally {
      root.remove();
    }
  });

  it("表格选择条 B/I/U/S 对选中 cell 内容写入 PM marks", () => {
    const cases: Array<[TableToolbarFormatCommand, PmMark["type"]]> = [
      ["bold", "bold"],
      ["italic", "italic"],
      ["underline", "underline"],
      ["strike", "strike"],
    ];

    for (const [command, mark] of cases) {
      const editor = createTableEditor();
      try {
        const cells = editor.view.dom.querySelectorAll("td");
        expect(cells.length).toBe(4);
        const selected = setTableCellSelectionFromDom(
          editor,
          cells[0] as HTMLTableCellElement,
          cells[3] as HTMLTableCellElement,
        );
        expect(selected).toBe(true);
        expect(applyTableToolbarFormat(editor, command)).toBe(true);
        expect(allCellMarks(editor).every((marks) => marks.some((item) => item.type === mark))).toBe(true);
      } finally {
        editor.destroy();
      }
    }
  });

  it("表格选择条支持文字颜色和单元格底色", () => {
    const editor = createTableEditor();
    try {
      const cells = editor.view.dom.querySelectorAll("td");
      expect(cells.length).toBe(4);
      const selected = setTableCellSelectionFromDom(
        editor,
        cells[0] as HTMLTableCellElement,
        cells[3] as HTMLTableCellElement,
      );
      expect(selected).toBe(true);
      expect(applyTableToolbarFormat(editor, "textColor", "red")).toBe(true);
      expect(allCellMarks(editor).every((marks) =>
        marks.some((item) => item.type === "textColor" && item.attrs.color === "red"),
      )).toBe(true);

      expect(setTableCellSelectionFromDom(editor, cells[0] as HTMLTableCellElement, cells[3] as HTMLTableCellElement)).toBe(true);
      expect(applyTableToolbarFormat(editor, "cellBackground", "rose")).toBe(true);
      expect(allCellBackgrounds(editor)).toEqual(["rose", "rose", "rose", "rose"]);
    } finally {
      editor.destroy();
    }
  });
});
