// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { DEFAULT_DRAWIO_SOURCE, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDrawioEditor } from "../../components/drawioEditorLauncher";
import { BlockHandle } from "../../components/doc/BlockHandle";
import { resolveDocumentPositionSafely } from "../../components/doc/blockHandlePosition";
import {
  readTableBlockMenuState,
  setEvenTableColumnWidths,
  toggleTableHeader,
} from "../../components/doc/blockHandleTable";
import { glyphForBlock } from "../../components/doc/blockHandleGeometry";
import { TableAxisSelectionExtension } from "../../data/tableToolbar";

const { writeBlockClipboardPayload } = vi.hoisted(() => ({
  writeBlockClipboardPayload: vi.fn(),
}));

vi.mock("../../components/drawioEditorLauncher", () => ({
  openDrawioEditor: vi.fn(async () => null),
}));

vi.mock("../../components/doc/blockClipboard", () => ({
  writeBlockClipboardPayload,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let editor: Editor | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
  writeBlockClipboardPayload.mockReset();
});

describe("BlockHandle 表格专属菜单", () => {
  it("插入 drawio 打开失败时透传具体原因到 toast", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, paragraph("empty"));
    editor.commands.setTextSelection(1);
    const onToast = vi.fn();
    vi.mocked(openDrawioEditor).mockRejectedValueOnce(new Error("已有 drawio 编辑器正在打开"));
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} onToast={onToast} />));
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });

    const insertDrawio = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("插入 drawio 工程图"));
    await act(async () => insertDrawio?.click());

    expect(onToast).toHaveBeenCalledWith("已有 drawio 编辑器正在打开");
    expect(editor.getJSON().content?.find((node) => node.type === "diagram")?.attrs).toMatchObject({
      blockId: expect.stringMatching(/^drawio-/),
      lang: "drawio",
      source: DEFAULT_DRAWIO_SOURCE,
      svg: null,
    });
  });

  it("空表仍显示完整表格菜单，且隐藏转换格式", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, basicTable());
    editor.commands.setTextSelection(4);
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));

    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    const menu = workspace.querySelector<HTMLElement>(".block-handle-menu");
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("剪切复制删除标题行标题列均分列宽在下方添加");
    expect(menu?.textContent).not.toContain("转换为");
  });

  it("块菜单尺寸浮层在当前表格下方插入指定大小的无标题行表格", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, basicTable());
    editor.commands.setTextSelection(4);
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });

    const addBelow = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("在下方添加"));
    await act(async () => addBelow?.focus());
    const insertTable = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("插入表格"));
    expect(insertTable).not.toBeUndefined();
    await act(async () => insertTable?.click());
    await act(async () => {
      workspace.querySelector<HTMLButtonElement>('[data-row="2"][data-col="3"]')?.click();
    });

    const doc = editor.getJSON() as { content?: Array<{ type?: string; content?: Array<{ content?: Array<{ type?: string }> }> }> };
    const inserted = doc.content?.[1];
    expect(inserted?.type).toBe("table");
    expect(inserted?.content).toHaveLength(2);
    expect(inserted?.content?.every((row) => row.content?.length === 3)).toBe(true);
    expect(inserted?.content?.flatMap((row) => row.content ?? []).every((tableCell) => tableCell.type === "tableCell")).toBe(true);
  });

  it("空段落入口通过尺寸浮层插入指定大小的无标题行表格", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, paragraph("empty"));
    editor.commands.setTextSelection(1);
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });

    const insertTable = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("插入表格"));
    expect(insertTable).not.toBeUndefined();
    await act(async () => insertTable?.click());
    await act(async () => {
      workspace.querySelector<HTMLButtonElement>('[data-row="4"][data-col="2"]')?.click();
    });

    const doc = editor.getJSON() as { content?: Array<{ type?: string; content?: Array<{ content?: Array<{ type?: string }> }> }> };
    const inserted = doc.content?.[1];
    expect(inserted?.type).toBe("table");
    expect(inserted?.content).toHaveLength(4);
    expect(inserted?.content?.every((row) => row.content?.length === 2)).toBe(true);
    expect(inserted?.content?.flatMap((row) => row.content ?? []).every((tableCell) => tableCell.type === "tableCell")).toBe(true);
  });

  it("尺寸浮层可跨菜单间隙抵达，hover 同级其他项时立即收起", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, paragraph("empty"));
    editor.commands.setTextSelection(1);
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });

    const menu = workspace.querySelector<HTMLElement>(".block-handle-menu")!;
    const insertTable = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("插入表格"))!;
    const inlineMath = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("行内公式"))!;

    await act(async () => {
      insertTable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const picker = workspace.querySelector<HTMLElement>(".table-size-picker")!;
    expect(picker).not.toBeNull();

    await act(async () => {
      menu.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: picker }));
      picker.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: menu }));
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(workspace.querySelector(".table-size-picker")).not.toBeNull();

    await act(async () => {
      inlineMath.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: insertTable }));
    });
    expect(workspace.querySelector(".table-size-picker")).toBeNull();

    await act(async () => {
      insertTable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(workspace.querySelector(".block-handle-menu")).toBeNull();
    expect(workspace.querySelector(".table-size-picker")).toBeNull();

    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
    const reopenedTable = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("插入表格"))!;
    await act(async () => {
      reopenedTable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(workspace.querySelector(".block-handle-menu")).toBeNull();
    expect(workspace.querySelector(".table-size-picker")).toBeNull();
  });

  it("标题行列状态按真实 cell 类型读取，并由 Tiptap 命令写回", () => {
    editor = createEditor(undefined, basicTable());
    const table = () => editor!.state.doc.nodeAt(0)!;
    expect(readTableBlockMenuState(table())).toEqual({ hasHeaderRow: false, hasHeaderColumn: false });

    expect(toggleTableHeader(editor, 0, "row")).toBe(true);
    expect(readTableBlockMenuState(table())).toEqual({ hasHeaderRow: true, hasHeaderColumn: false });
    expect(toggleTableHeader(editor, 0, "column")).toBe(true);
    expect(readTableBlockMenuState(table())).toEqual({ hasHeaderRow: true, hasHeaderColumn: true });
  });

  it("rowspan 覆盖行仍按逻辑第 0 列识别标题列", () => {
    editor = createEditor(undefined, rowspanHeaderColumnTable());
    expect(readTableBlockMenuState(editor.state.doc.nodeAt(0))).toEqual({
      hasHeaderRow: false,
      hasHeaderColumn: true,
    });
  });

  it("开关标题行列保留数据格类型与自定义底色", () => {
    editor = createEditor(undefined, coloredTable());
    const table = () => editor!.state.doc.nodeAt(0)!;
    const dataCell = () => table().child(1).child(1);

    expect(dataCell().type.name).toBe("tableCell");
    expect(dataCell().attrs.backgroundColor).toBe("green");
    expect(toggleTableHeader(editor, 0, "row")).toBe(true);
    expect(toggleTableHeader(editor, 0, "column")).toBe(true);
    expect(dataCell().type.name).toBe("tableCell");
    expect(dataCell().attrs.backgroundColor).toBe("green");
    expect(table().child(1).child(0).attrs.backgroundColor).toBe("amber");

    expect(toggleTableHeader(editor, 0, "column")).toBe(true);
    expect(toggleTableHeader(editor, 0, "row")).toBe(true);
    expect(dataCell().type.name).toBe("tableCell");
    expect(dataCell().attrs.backgroundColor).toBe("green");
  });

  it("均分列宽为 span cell 写入与 colspan 等长的 colwidth，并通过 PM 校验", () => {
    editor = createEditor(undefined, spanTable());
    expect(setEvenTableColumnWidths(editor, 0, 603)).toBe(true);

    const table = editor.state.doc.nodeAt(0)!;
    const firstRow = table.child(0);
    expect(firstRow.child(0).attrs.colwidth).toEqual([201, 201]);
    expect(firstRow.child(1).attrs.colwidth).toEqual([201]);
    for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
      const row = table.child(rowIndex);
      for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
        const cell = row.child(cellIndex);
        expect(cell.attrs.colwidth).toHaveLength(cell.attrs.colspan);
      }
    }
    expect(() => editor!.state.doc.check()).not.toThrow();
  });

  it("无 DOM 可用宽度时沿用现有逻辑列总宽，表格 glyph 使用专属图标标识", () => {
    editor = createEditor(undefined, spanTable());
    expect(setEvenTableColumnWidths(editor, 0)).toBe(true);
    const table = editor.state.doc.nodeAt(0)!;
    expect(table.child(1).child(0).attrs.colwidth).toEqual([200]);
    expect(glyphForBlock(table)).toBe("table");
  });

  it("格内 Ctrl+A 只替换当前单元格，不提升为整篇选区", () => {
    editor = createEditor(
      undefined,
      valueTable(),
      [paragraph("tail", "表格后的图表说明必须保留")],
    );
    const cellTextPos = findTextPosition(editor, "120");
    editor.commands.setTextSelection(cellTextPos + 1);

    const event = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    editor.commands.insertContent("300");
    const json = editor.getJSON() as PmDoc;
    expect(json.content.map((node) => node.type)).toEqual(["table", "paragraph"]);
    expect(JSON.stringify(json)).toContain('"text":"300"');
    expect(JSON.stringify(json)).not.toContain('"text":"120"');
    expect(JSON.stringify(json)).toContain("表格后的图表说明必须保留");
  });

  it("过期坐标越过当前 fragment 时安全放弃，不再抛 RangeError", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, valueTable());
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));

    const stalePosition = editor.state.doc.content.size - 1;
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({
      pos: stalePosition,
      inside: -1,
    });
    editor.commands.setContent({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "heading",
        attrs: { blockId: "damaged", level: 1 },
        content: [{ type: "text", text: "300" }],
      }],
    });

    expect(stalePosition).toBeGreaterThan(editor.state.doc.content.size);
    expect(
      resolveDocumentPositionSafely(editor.state.doc, stalePosition),
    ).toBeNull();
    await act(async () => {
      expect(() => {
        editor!.view.dom.dispatchEvent(new MouseEvent("mousemove", {
          clientX: 0,
          clientY: 0,
          bubbles: true,
        }));
      }).not.toThrow();
    });
  });

  it("剪贴板等待期间块坐标漂移时按 blockId 删除原块", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(
      editorElement,
      paragraph("cut-target", "待剪切"),
      [paragraph("tail", "保留尾段")],
    );
    editor.commands.setTextSelection(1);
    let finishClipboardWrite: (() => void) | null = null;
    writeBlockClipboardPayload.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishClipboardWrite = resolve;
      }),
    );
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    const cut = Array.from(
      workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes("剪切"));
    expect(cut).toBeTruthy();
    await act(async () => {
      cut!.click();
      await Promise.resolve();
    });

    await act(async () => {
      editor!.commands.insertContentAt(0, paragraph("inserted", "等待期间插入"));
    });
    await act(async () => {
      finishClipboardWrite?.();
      await Promise.resolve();
    });

    const content = (editor.getJSON() as PmDoc).content;
    expect(content.map((node) => node.attrs.blockId)).toEqual([
      "inserted",
      "tail",
    ]);
    expect(content.map((node) =>
      node.type === "paragraph" && node.content?.[0]?.type === "text"
        ? node.content[0].text
        : "",
    )).toEqual(["等待期间插入", "保留尾段"]);
  });
});

describe("BlockHandle 末尾空白悬停", () => {
  function mountWithGeometry(blocks: Record<string, unknown>[], lastBlockBottom: number) {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const surface = document.createElement("div");
    surface.className = "ws-paper-surface";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    surface.appendChild(editorElement);
    workspace.append(surface, reactHost);
    document.body.appendChild(workspace);
    const created = new Editor({
      element: editorElement,
      extensions: [...createQingagentExtensions(), TableAxisSelectionExtension],
      content: { type: "doc", attrs: { schemaVersion: 1 }, content: blocks } as PmDoc,
    });
    // jsdom 没有布局:给正文根与最后一块喂确定几何,末尾留白 = 最后一块底边之下。
    const paperRect = { left: 100, right: 700, top: 40, bottom: 900, width: 600, height: 860, x: 100, y: 40, toJSON: () => ({}) } as DOMRect;
    const lastRect = { left: 120, right: 680, top: lastBlockBottom - 30, bottom: lastBlockBottom, width: 560, height: 30, x: 120, y: lastBlockBottom - 30, toJSON: () => ({}) } as DOMRect;
    created.view.dom.getBoundingClientRect = () => paperRect;
    const lastEl = created.view.dom.lastElementChild as HTMLElement;
    lastEl.getBoundingClientRect = () => lastRect;
    return { editor: created, workspace, reactHost, surface, lastRect };
  }

  it("指针落在最后一块下方的留白里也浮出手柄,锚定最后一块", async () => {
    const mounted = mountWithGeometry(
      [paragraph("p-1", "第一段"), paragraph("p-last", "最后一段")],
      500,
    );
    editor = mounted.editor;
    root = createRoot(mounted.reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} onToast={vi.fn()} />));

    await act(async () => {
      editor!.view.dom.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, clientX: 400, clientY: 580,
      }));
    });
    const handle = mounted.workspace.querySelector<HTMLElement>("[data-block-handle-id]");
    expect(handle).not.toBeNull();
    expect(handle?.getAttribute("data-block-handle-id")).toBe("p-last");
  });

  it("留白落在正文根之外(纸面容器上)同样能出手柄", async () => {
    const mounted = mountWithGeometry([paragraph("p-only", "唯一一段")], 300);
    editor = mounted.editor;
    root = createRoot(mounted.reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} onToast={vi.fn()} />));

    await act(async () => {
      mounted.surface.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, clientX: 400, clientY: 380,
      }));
    });
    expect(mounted.workspace.querySelector("[data-block-handle-id]")?.getAttribute("data-block-handle-id")).toBe("p-only");
  });

  it("空文档的空段落也能从下方留白唤出手柄", async () => {
    const mounted = mountWithGeometry([paragraph("p-empty")], 200);
    editor = mounted.editor;
    root = createRoot(mounted.reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} onToast={vi.fn()} />));

    await act(async () => {
      mounted.surface.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, clientX: 400, clientY: 320,
      }));
    });
    expect(mounted.workspace.querySelector("[data-block-handle-id]")?.getAttribute("data-block-handle-id")).toBe("p-empty");
  });

  it("横向落在正文带之外不出手柄", async () => {
    const mounted = mountWithGeometry([paragraph("p-1", "正文")], 300);
    editor = mounted.editor;
    root = createRoot(mounted.reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} onToast={vi.fn()} />));

    await act(async () => {
      mounted.surface.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, clientX: 900, clientY: 400,
      }));
    });
    expect(mounted.workspace.querySelector("[data-block-handle-id]")).toBeNull();
  });
});

function createEditor(
  element: HTMLElement | undefined,
  table: Record<string, unknown>,
  trailingBlocks: Record<string, unknown>[] = [],
): Editor {
  const editorElement = element ?? document.body.appendChild(document.createElement("div"));
  return new Editor({
    element: editorElement,
    extensions: [...createQingagentExtensions(), TableAxisSelectionExtension],
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [table, ...trailingBlocks],
    } as PmDoc,
  });
}

function paragraph(blockId: string, text?: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    ...(text ? { content: [{ type: "text", text }] } : {}),
  };
}

function cell(blockId: string, attrs?: Record<string, unknown>) {
  return { type: "tableCell", attrs, content: [paragraph(blockId)] };
}

function basicTable() {
  return {
    type: "table",
    attrs: { blockId: "table-basic" },
    content: [
      { type: "tableRow", content: [cell("a"), cell("b")] },
      { type: "tableRow", content: [cell("c"), cell("d")] },
    ],
  };
}

function valueTable() {
  return {
    type: "table",
    attrs: { blockId: "table-values" },
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [paragraph("q1", "Q1")] },
          { type: "tableCell", content: [paragraph("sales", "120")] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [paragraph("q2", "Q2")] },
          { type: "tableCell", content: [paragraph("sales-2", "180")] },
        ],
      },
    ],
  };
}

function findTextPosition(instance: Editor, text: string): number {
  let found = -1;
  instance.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`找不到文本：${text}`);
  return found;
}

function coloredTable() {
  return {
    type: "table",
    attrs: { blockId: "table-colored" },
    content: [
      { type: "tableRow", content: [cell("a"), cell("b"), cell("c")] },
      { type: "tableRow", content: [cell("d", { backgroundColor: "amber" }), cell("e", { backgroundColor: "green" }), cell("f")] },
      { type: "tableRow", content: [cell("g"), cell("h"), cell("i")] },
    ],
  };
}

function spanTable() {
  return {
    type: "table",
    attrs: { blockId: "table-span" },
    content: [
      {
        type: "tableRow",
        content: [
          cell("a", { colspan: 2, rowspan: 1, colwidth: [120, 180] }),
          cell("b", { colspan: 1, rowspan: 1, colwidth: [300] }),
        ],
      },
      {
        type: "tableRow",
        content: [
          cell("c", { colspan: 1, rowspan: 1, colwidth: [120] }),
          cell("d", { colspan: 1, rowspan: 1, colwidth: [180] }),
          cell("e", { colspan: 1, rowspan: 1, colwidth: [300] }),
        ],
      },
    ],
  };
}

function rowspanHeaderColumnTable() {
  return {
    type: "table",
    attrs: { blockId: "table-rowspan-header" },
    content: [
      {
        type: "tableRow",
        content: [
          { ...cell("a", { rowspan: 2 }), type: "tableHeader" },
          cell("b"),
        ],
      },
      { type: "tableRow", content: [cell("c")] },
      {
        type: "tableRow",
        content: [
          { ...cell("d"), type: "tableHeader" },
          cell("e"),
        ],
      },
    ],
  };
}
