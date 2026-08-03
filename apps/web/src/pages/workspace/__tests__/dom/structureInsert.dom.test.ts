// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { DEFAULT_DRAWIO_SOURCE, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultColumnListNode,
  createDefaultTableNode,
  insertStructureNodeAtSelection,
  insertStructureNodeAfterBlock,
} from "../../components/DocumentSnapshotView";

let editor: Editor | null = null;

describe("block handle structural insert", () => {
  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
  });

  it("结构块绕过 seedInsertChain,标题后插公式不产生中间空段", () => {
    editor = createHeadingEditor();
    const ok = insertStructureNodeAfterBlock(editor, 0, { type: "blockMath", attrs: { latex: "E = mc^2" } });

    expect(ok).toBe(true);
    const content = normalizePmDoc(editor.getJSON()).content;
    expect(content.map((node) => node.type).slice(0, 2)).toEqual(["heading", "blockMath"]);
  });

  it("分栏结构块落在当前块之后，并聚焦第一栏首个可编辑位置", () => {
    editor = createHeadingEditor();
    const ok = insertStructureNodeAfterBlock(editor, 0, createDefaultColumnListNode());

    expect(ok).toBe(true);
    const content = normalizePmDoc(editor.getJSON()).content;
    expect(content.map((node) => node.type).slice(0, 2)).toEqual(["heading", "columnList"]);
    const columns = content[1];
    expect(columns?.type === "columnList" ? columns.content : []).toHaveLength(2);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.node(-1).type.name).toBe("column");
    expect(editor.state.selection.$from.index(-2)).toBe(0);
    expect(editor.view.hasFocus()).toBe(true);
  });

  it("默认表格按指定尺寸生成且默认无标题行", () => {
    editor = createHeadingEditor();
    expect(insertStructureNodeAfterBlock(editor, 0, createDefaultTableNode(2, 4))).toBe(true);
    const table = normalizePmDoc(editor.getJSON()).content[1];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") return;
    expect(table.content).toHaveLength(2);
    expect(table.content.every((row) => row.content.length === 4)).toBe(true);
    expect(table.content.flatMap((row) => row.content).every((tableCell) => tableCell.type === "tableCell")).toBe(true);
  });

  it.each([
    ["Mermaid 图表", { type: "diagram", attrs: { lang: "mermaid", source: "flowchart TD\nA-->B", svg: null } }],
    ["drawio 图表", { type: "diagram", attrs: { lang: "drawio", source: DEFAULT_DRAWIO_SOURCE, svg: null } }],
    ["公式块", { type: "blockMath", attrs: { latex: "E = mc^2" } }],
    ["分隔线", { type: "horizontalRule" }],
  ])("%s 与表格共用块边界插入，不劈开标题", (_label, node) => {
    editor = createHeadingEditor();
    editor.commands.setTextSelection(2);

    expect(insertStructureNodeAtSelection(editor, node)).toBe(true);

    const content = normalizePmDoc(editor.getJSON()).content;
    expect(content.map((item) => item.type).slice(0, 2)).toEqual(["heading", node.type]);
    const heading = content[0];
    expect(heading?.type === "heading"
      ? heading.content?.map((inline) => inline.type === "text" ? inline.text : "").join("")
      : "")
      .toBe("标题");
  });
});

function createHeadingEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { blockId: "h", level: 1 },
          content: [{ type: "text", text: "标题" }],
        },
      ],
    } satisfies PmDoc,
  });
}
