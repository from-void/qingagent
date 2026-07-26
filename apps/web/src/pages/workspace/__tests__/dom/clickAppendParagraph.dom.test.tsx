// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";
import { pmDocToViewDocumentSnapshot } from "../../data/protocol";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: "<svg><g/></svg>" })),
  },
}));

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  host.remove();
});

function paragraph(text: string, blockId: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    ...(text ? { content: [{ type: "text", text }] } : {}),
  };
}

function paragraphDoc(text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [paragraph(text, "p-1")],
  } as PmDoc;
}

function columnDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "columnList",
      attrs: { blockId: "columns-1" },
      content: [
        {
          type: "column",
          attrs: { blockId: "column-left", widthRatio: 0.5 },
          content: [paragraph("左栏", "p-left")],
        },
        {
          type: "column",
          attrs: { blockId: "column-right", widthRatio: 0.5 },
          content: [paragraph("右栏", "p-right")],
        },
      ],
    }],
  } as unknown as PmDoc;
}

function tableDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "table",
      attrs: { blockId: "table-1" },
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          content: [paragraph("单元格", "p-cell")],
        }],
      }],
    }],
  } as PmDoc;
}

async function mountEditor(doc: PmDoc): Promise<Editor> {
  let editor: Editor | null = null;
  act(() => {
    root.render(
      <DocumentSnapshotView
        doc={pmDocToViewDocumentSnapshot(doc, 1)}
        editable
        interactiveEditable
        showPatches={false}
        acceptedPatches={new Set()}
        rejectedPatches={new Set()}
        onEditorReady={(readyEditor) => {
          editor = readyEditor;
        }}
      />,
    );
  });
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  if (!editor) throw new Error("编辑器未挂载");
  return editor;
}

function rect(
  left: number,
  top: number,
  right: number,
  bottom: number,
): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function mockPaperLayout(editor: Editor): void {
  const paper = editor.view.dom;
  const lastBlock = paper.lastElementChild;
  if (!lastBlock) throw new Error("正文末块 DOM 不存在");
  vi.spyOn(paper, "getBoundingClientRect").mockReturnValue(
    rect(0, 0, 800, 600),
  );
  vi.spyOn(lastBlock, "getBoundingClientRect").mockReturnValue(
    rect(64, 52, 736, 180),
  );
}

function dispatchPaperEvent(
  editor: Editor,
  type: "mousedown" | "click",
): MouseEvent {
  const paper = editor.view.dom;
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 400,
    clientY: 320,
  });
  paper.dispatchEvent(event);
  return event;
}

function clickPaperBelowLastBlock(editor: Editor): MouseEvent {
  mockPaperLayout(editor);
  return dispatchPaperEvent(editor, "click");
}

function removeSchemaTrailingParagraphForTableCase(editor: Editor): void {
  const firstBlock = editor.state.doc.firstChild;
  const lastBlock = editor.state.doc.lastChild;
  if (
    editor.state.doc.childCount !== 2 ||
    firstBlock?.type.name !== "table" ||
    lastBlock?.type.name !== "paragraph" ||
    lastBlock.content.size !== 0
  ) {
    throw new Error("表格测试未得到预期的 schema 尾随空段");
  }
  // StarterKit 会在纯表格初次挂载时自动补尾段。这里直接更新到合法的 table-only
  // EditorState，构造用户施工单要求的“末块确为表格”现场；随后点击仍走生产事件链。
  const pluginsWithoutTrailingNode = editor.state.plugins.filter(
    (plugin) => {
      const key = (
        plugin.spec.key as unknown as { key?: string } | undefined
      )?.key;
      return !key?.toLowerCase().includes("trailingnode");
    },
  );
  if (pluginsWithoutTrailingNode.length === editor.state.plugins.length) {
    throw new Error("未找到 StarterKit trailingNode 插件");
  }
  const stateWithoutTrailingNode = editor.state.reconfigure({
    plugins: pluginsWithoutTrailingNode,
  });
  editor.view.updateState(
    stateWithoutTrailingNode.apply(
      stateWithoutTrailingNode.tr.delete(
        firstBlock.nodeSize,
        stateWithoutTrailingNode.doc.content.size,
      ),
    ),
  );
}

describe("正文末块下方点击追加行", () => {
  it.each([
    ["分栏", columnDoc],
    ["表格", tableDoc],
    ["非空段落", () => paragraphDoc("已有正文")],
  ])("末块为%s时插入空段并聚焦", async (_label, buildDoc) => {
    const editor = await mountEditor(buildDoc());
    if (_label === "表格") {
      act(() => removeSchemaTrailingParagraphForTableCase(editor));
    }
    expect(editor.state.doc.childCount).toBe(1);

    const event = clickPaperBelowLastBlock(editor);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.lastChild?.content.size).toBe(0);
    expect(editor.state.doc.lastChild?.attrs.blockId).toMatch(/^block-inserted/);
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("真空文档点击末行下方无动作", async () => {
    const editor = await mountEditor(paragraphDoc(""));
    const before = editor.state.doc.toJSON();

    mockPaperLayout(editor);
    const mouseDown = dispatchPaperEvent(editor, "mousedown");
    const click = dispatchPaperEvent(editor, "click");

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(editor.state.doc.childCount).toBe(1);
    expect(document.activeElement).not.toBe(editor.view.dom);
  });

  it("末块已是空段时只把光标落入该段，不再新增", async () => {
    const editor = await mountEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        paragraph("已有正文", "p-body"),
        paragraph("", "p-tail"),
      ],
    } as PmDoc);
    expect(editor.state.selection.from).not.toBe(
      editor.state.doc.content.size - 1,
    );

    const event = clickPaperBelowLastBlock(editor);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("块内点击与非空选区拖拽后的点击均不触发追加", async () => {
    const editor = await mountEditor(paragraphDoc("已有正文"));
    const paper = editor.view.dom;
    const block = paper.lastElementChild!;
    const childClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    block.dispatchEvent(childClick);
    expect(editor.state.doc.childCount).toBe(1);

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 3 });
    });
    const paperClick = clickPaperBelowLastBlock(editor);
    expect(paperClick.defaultPrevented).toBe(false);
    expect(editor.state.doc.childCount).toBe(1);
  });
});
