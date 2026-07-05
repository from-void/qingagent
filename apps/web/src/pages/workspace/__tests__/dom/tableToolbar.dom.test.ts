import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, type PmDoc, type PmMark } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import {
  applyTableToolbarFormat,
  setTableCellSelectionFromDom,
  type TableToolbarFormatCommand,
} from "../../data/tableToolbar";
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

describe("tableToolbar PM-010", () => {
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
