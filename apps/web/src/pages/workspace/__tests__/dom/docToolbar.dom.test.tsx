// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { DEFAULT_DRAWIO_SOURCE, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { setTableCellSelectionFromDom } from "../../data/tableToolbar";
import { readFileSync } from "node:fs";
import path from "node:path";

const workspaceCss = readFileSync(path.join(process.cwd(), "src/pages/workspace/workspace.css"), "utf8");

vi.mock("../../components/drawioEditorLauncher", () => ({
  openDrawioEditor: vi.fn(async () => null),
}));

import {
  DocToolbar,
  captureToolbarSelection,
  resolveDiagramSourceForInsert,
  resolveSelectedBlockNode,
  isEditorRangeSingleAtomBlock,
  reportToolbarCommandResult,
  restoreToolbarSelection,
  toolbarTitle,
} from "../../components/DocToolbar";
import { openDrawioEditor } from "../../components/drawioEditorLauncher";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let editor: Editor | null = null;

describe("DocToolbar round-1 regressions", () => {
  beforeEach(() => {
    vi.mocked(openDrawioEditor).mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    editor?.destroy();
    editor = null;
    vi.restoreAllMocks();
  });

  it("插入菜单补齐表格、代码块、分隔线入口", async () => {
    await render(
      <DocToolbar
        active
        editor={null}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    await act(async () => {
      getButtonByText("插入").click();
    });

    expect(host?.textContent).toContain("插入表格");
    expect(host?.textContent).toContain("插入分栏");
    expect(host?.textContent).toContain("插入 Mermaid 图表");
    expect(host?.textContent).toContain("插入 drawio 工程图");
    expect(host?.textContent).toContain("代码块");
    expect(host?.textContent).toContain("分隔线");
  });

  it("工具栏尺寸浮层按所选行列插入无标题行表格", async () => {
    editor = createTextEditor("正文");
    vi.spyOn(editor.view as unknown as { scrollToSelection: () => void }, "scrollToSelection")
      .mockImplementation(() => undefined);
    editor.commands.setTextSelection(3);
    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    await act(async () => getButtonByText("插入").click());
    await act(async () => getButtonByText("插入表格").click());
    const sizeCell = document.querySelector<HTMLButtonElement>('[data-row="2"][data-col="4"]');
    expect(sizeCell).not.toBeNull();
    await act(async () => sizeCell?.click());

    const table = normalizePmDoc(editor.getJSON()).content.find((node) => node.type === "table");
    expect(table?.type).toBe("table");
    if (table?.type !== "table") return;
    expect(table.content).toHaveLength(2);
    expect(table.content.every((row) => row.content.length === 4)).toBe(true);
    expect(table.content.flatMap((row) => row.content).every((tableCell) => tableCell.type === "tableCell")).toBe(true);
  });

  it("工具栏 title 用稳定 command 映射拼快捷键", () => {
    expect(toolbarTitle("加粗", "bold")).toMatch(/加粗 \((?:⌘|Ctrl)\+B\)/);
    expect(toolbarTitle("插入", "insert")).toBe("插入");
  });

  it("命令反馈只在 run 返回 false 时 toast", () => {
    const onToast = vi.fn();
    expect(reportToolbarCommandResult(true, "无变化命令", onToast)).toBe(true);
    expect(onToast).not.toHaveBeenCalled();
    expect(reportToolbarCommandResult(false, "插入表格", onToast)).toBe(false);
    expect(onToast).toHaveBeenCalledWith("无法执行：插入表格");
  });

  it("插入菜单不会被工具栏点击引发的 selectionchange 立即关闭", async () => {
    await render(
      <DocToolbar
        active
        editor={null}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    const insertButton = getButtonByText("插入");
    await act(async () => {
      insertButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      document.dispatchEvent(new Event("selectionchange"));
      insertButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      insertButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(insertButton.getAttribute("aria-expanded")).toBe("true");
    expect(host?.querySelector(".dt-menu")).not.toBeNull();
    expect(host?.textContent).toContain("插入表格");
  });

  it("CellSelection 不渲染正文工具栏，格内 TextSelection 仍渲染", async () => {
    editor = createTableEditor();
    const cells = editor.view.dom.querySelectorAll<HTMLTableCellElement>("td");
    expect(setTableCellSelectionFromDom(editor, cells[0]!, cells[1]!)).toBe(true);

    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(host?.querySelector('[aria-label="文档格式工具栏"]')).toBeNull();

    const textNode = cells[0]!.querySelector("p")?.firstChild;
    if (!textNode) throw new Error("table cell text not found");
    const from = editor.view.posAtDOM(textNode, 0);
    await act(async () => {
      editor!.commands.setTextSelection({ from, to: from + 2 });
    });
    // 只靠 TipTap selectionUpdate 即解除抑制，不依赖下一次 DOM selectionchange 才恢复节点。
    expect(host?.querySelector('[aria-label="文档格式工具栏"]')).not.toBeNull();

    await act(async () => {
      editor!.view.focus();
      const range = window.getSelection()?.getRangeAt(0);
      if (!range) throw new Error("text selection range not found");
      Object.defineProperty(range, "getBoundingClientRect", {
        configurable: true,
        value: () => DOMRect.fromRect({ x: 120, y: 80, width: 32, height: 18 }),
      });
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(editor.state.selection).not.toBeInstanceOf(CellSelection);
    expect(host?.querySelector('[aria-label="文档格式工具栏"]')?.classList.contains("on")).toBe(true);
  });

  it("切换 editor 时不会沿用旧 CellSelection 抑制态", async () => {
    const tableEditor = createTableEditor();
    editor = tableEditor;
    const cells = tableEditor.view.dom.querySelectorAll<HTMLTableCellElement>("td");
    expect(setTableCellSelectionFromDom(tableEditor, cells[0]!, cells[1]!)).toBe(true);
    await render(
      <DocToolbar
        active
        editor={tableEditor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );
    expect(host?.querySelector('[aria-label="文档格式工具栏"]')).toBeNull();

    const textEditor = createTextEditor("新编辑器正文");
    editor = textEditor;
    await act(async () => {
      root?.render(
        <DocToolbar
          active
          editor={textEditor}
          containerSelector="body"
          onAiModify={async () => true}
        />,
      );
    });
    tableEditor.destroy();

    expect(host?.querySelector('[aria-label="文档格式工具栏"]')).not.toBeNull();
  });

  it("链接按钮打开就地输入气泡并写入 link mark,不再调用 window.prompt", async () => {
    editor = createSelectedEditor();
    vi.spyOn(editor.view as unknown as { scrollToSelection: () => void }, "scrollToSelection")
      .mockImplementation(() => undefined);
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("https://bad.example");

    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    await act(async () => {
      getButtonByText("链接").click();
    });

    expect(promptSpy).not.toHaveBeenCalled();
    const input = host?.querySelector<HTMLInputElement>(".link-hover-card .lhc-input");
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input!, "https://example.com/doc");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    const paragraph = normalizePmDoc(editor.getJSON()).content[0];
    expect(paragraph?.type).toBe("paragraph");
    const firstText = paragraph?.type === "paragraph" ? paragraph.content?.[0] : undefined;
    expect(firstText?.type === "text" ? firstText.marks : []).toContainEqual({
      type: "link",
      attrs: { href: "https://example.com/doc" },
    });
  });

  it("insertDiagram 只在选区是合法 Mermaid 时沿用源码", async () => {
    await expect(resolveDiagramSourceForInsert("普通正文，不是 mermaid")).resolves.toBeUndefined();
    await expect(resolveDiagramSourceForInsert("flowchart LR\nA-->B")).resolves.toBe("flowchart LR\nA-->B");
  });

  it("R2-08 选区转行内公式会剥 $ 定界符并替换原文", async () => {
    editor = createTextEditor("$E=mc^2$");
    editor.commands.setTextSelection({ from: 1, to: 9 });

    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    await act(async () => {
      getButtonByText("插入").click();
    });
    await act(async () => {
      getButtonByText("行内公式").click();
    });

    const paragraph = normalizePmDoc(editor.getJSON()).content[0];
    expect(paragraph?.type).toBe("paragraph");
    const content = paragraph?.type === "paragraph" ? paragraph.content ?? [] : [];
    expect(content).toEqual([{ type: "inlineMath", attrs: { latex: "E=mc^2" } }]);
    expect(JSON.stringify(paragraph)).not.toContain("$E=mc^2$");
  });

  it("编辑器只读时格式按钮禁用,程序化点击也不改正文", async () => {
    editor = createSelectedEditor();
    editor.setEditable(false);
    const before = normalizePmDoc(editor.getJSON());

    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    const boldButton = getButtonByText("加粗");
    expect(boldButton.disabled).toBe(true);
    expect(getButtonByText("文字和背景颜色").disabled).toBe(true);

    await act(async () => {
      boldButton.click();
    });

    expect(normalizePmDoc(editor.getJSON())).toEqual(before);
  });

  it("DocToolbar.runCommand 在 TipTap run 返回 false 时给 toast", async () => {
    const onToast = vi.fn();
    const fakeEditor = createCommandEditor(false);
    await render(
      <DocToolbar
        active
        editor={fakeEditor}
        containerSelector="body"
        onAiModify={async () => true}
        onToast={onToast}
      />,
    );

    await act(async () => {
      getButtonByText("插入").click();
    });
    await act(async () => {
      getButtonByText("插入表格").click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-row="3"][data-col="3"]')?.click();
    });

    expect(onToast).toHaveBeenCalledWith("无法执行：插入表格");
  });

  it("块样式下拉在编辑器选区已塌陷时恢复 savedSelRef 后再执行命令", async () => {
    editor = createTwoParagraphEditor();
    vi.spyOn(editor.view as unknown as { scrollToSelection: () => void }, "scrollToSelection")
      .mockImplementation(() => undefined);
    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    await act(async () => {
      editor!.commands.setTextSelection({ from: 1, to: 5 });
      document.dispatchEvent(new Event("selectionchange"));
      // 模拟下拉菜单接管焦点后 PM 选区掉到文档尾段；savedSelRef 仍指向第一段。
      editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      getButtonByText("标题和块样式").click();
    });
    await act(async () => {
      getButtonByText("引用").click();
    });

    const doc = normalizePmDoc(editor.getJSON());
    expect(doc.content.map((block) => block.type)).toEqual(["blockquote", "paragraph"]);
    expect(doc.content[0]?.type === "blockquote" ? doc.content[0].content[0]?.attrs.blockId : null)
      .toBe("p-first");
  });

  it("跨两个段落恢复选区后，加粗、对齐和块类型命令作用于完整范围", async () => {
    editor = createTwoParagraphEditor();
    vi.spyOn(editor.view as unknown as { scrollToSelection: () => void }, "scrollToSelection")
      .mockImplementation(() => undefined);
    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    const selectBothParagraphsThenLoseFocus = async () => {
      await act(async () => {
        editor!.commands.setTextSelection({ from: 1, to: 9 });
        document.dispatchEvent(new Event("selectionchange"));
        editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
      });
    };
    const expectFullSelection = () => {
      expect(editor!.state.selection).toBeInstanceOf(TextSelection);
      expect(editor!.state.selection).toMatchObject({ anchor: 1, head: 9 });
    };

    await selectBothParagraphsThenLoseFocus();
    await act(async () => getButtonByText("加粗").click());
    expectFullSelection();
    const boldDoc = normalizePmDoc(editor.getJSON());
    expect(boldDoc.content.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
    expect(boldDoc.content.every((block) =>
      block.type === "paragraph" && block.content?.every((node) =>
        node.type !== "text" || node.marks?.some((mark) => mark.type === "bold"),
      ),
    )).toBe(true);

    await selectBothParagraphsThenLoseFocus();
    await act(async () => getButtonByText("对齐方式").click());
    await act(async () => getButtonByText("居中").click());
    expectFullSelection();
    const alignedDoc = normalizePmDoc(editor.getJSON());
    expect(alignedDoc.content.every((block) =>
      block.type === "paragraph" && block.attrs.textAlign === "center",
    )).toBe(true);

    await selectBothParagraphsThenLoseFocus();
    await act(async () => getButtonByText("标题和块样式").click());
    await act(async () => getButtonByText("二级标题").click());
    expectFullSelection();
    const headingDoc = normalizePmDoc(editor.getJSON());
    expect(headingDoc.content.every((block) =>
      block.type === "heading" && block.attrs.level === 2,
    )).toBe(true);
  });

  it("工具栏选区快照按 anchor/head 恢复跨块反向 TextSelection", () => {
    editor = createTwoParagraphEditor();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 9, 1)));

    const saved = captureToolbarSelection(editor);
    expect(saved).toEqual({ kind: "text", anchor: 9, head: 1 });
    editor.commands.setTextSelection(2);

    expect(saved && restoreToolbarSelection(editor, saved)).toBe(true);
    expect(editor.state.selection).toMatchObject({ anchor: 9, head: 1 });
  });

  it("块样式命令 run 返回 false 时不静默吞掉，给出 toast", async () => {
    const onToast = vi.fn();
    const fakeEditor = createCommandEditor(false);
    await render(
      <DocToolbar
        active
        editor={fakeEditor}
        containerSelector="body"
        onAiModify={async () => true}
        onToast={onToast}
      />,
    );

    await act(async () => {
      getButtonByText("标题和块样式").click();
    });
    await act(async () => {
      getButtonByText("引用").click();
    });

    expect(onToast).toHaveBeenCalledWith("无法执行：引用");
  });

  it("工具栏新建 drawio 会先插入默认块，再把实时回调绑定到该块", async () => {
    const fakeEditor = createCommandEditor(true);
    const insertDiagram = vi.mocked(fakeEditor.chain().insertDiagram);
    const onToast = vi.fn();
    await render(
      <DocToolbar
        active
        editor={fakeEditor}
        containerSelector="body"
        onAiModify={async () => true}
        onToast={onToast}
      />,
    );

    await act(async () => getButtonByText("插入").click());
    await act(async () => getButtonByText("插入 drawio 工程图").click());
    expect(insertDiagram).toHaveBeenCalledWith(expect.objectContaining({
      blockId: expect.stringMatching(/^drawio-/),
      lang: "drawio",
      source: DEFAULT_DRAWIO_SOURCE,
      svg: null,
    }));
    expect(openDrawioEditor).toHaveBeenCalledWith(
      DEFAULT_DRAWIO_SOURCE,
      "新建 drawio 工程图",
      expect.any(Function),
    );

    const source = "<mxGraphModel><root><mxCell id=\"0\"/></root></mxGraphModel>";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    vi.mocked(openDrawioEditor).mockResolvedValueOnce({ source, svg });
    await act(async () => getButtonByText("插入").click());
    await act(async () => getButtonByText("插入 drawio 工程图").click());
    expect(insertDiagram).toHaveBeenLastCalledWith(expect.objectContaining({
      blockId: expect.stringMatching(/^drawio-/),
      lang: "drawio",
      source: DEFAULT_DRAWIO_SOURCE,
      svg: null,
    }));
    expect(onToast).not.toHaveBeenCalled();
  });

  it("工具栏插入分栏会写入 columnList 节点", async () => {
    editor = createTextEditor("正文");
    vi.spyOn(editor.view as unknown as { scrollToSelection: () => void }, "scrollToSelection")
      .mockImplementation(() => undefined);
    editor.commands.setTextSelection(3);
    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    await act(async () => {
      getButtonByText("插入").click();
    });
    await act(async () => {
      getButtonByText("插入分栏").click();
    });

    const doc = normalizePmDoc(editor.getJSON());
    const columns = doc.content.find((node) => node.type === "columnList");
    expect(columns?.type).toBe("columnList");
    expect(columns?.type === "columnList" ? columns.content : []).toHaveLength(2);
    // 回归门:插分栏不得在顶层留多余空段(原始正文段 + columnList,顶层恰好 2 节点;
    // 空段只允许出现在列内作为必需占位内容。e2e v09/v15/v16 三次把"空列视觉"误报成"多余空段")。
    expect(doc.content).toHaveLength(2);
    expect(doc.content.filter((n) => n.type === "paragraph" && !((n as { content?: unknown[] }).content?.length))).toHaveLength(0);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.node(-1).type.name).toBe("column");
    expect(editor.state.selection.$from.index(-2)).toBe(0);
    expect(editor.view.hasFocus()).toBe(true);
  });

  it("工具栏可以切换有序列表序号样式", async () => {
    editor = createOrderedListEditor();
    vi.spyOn(editor.view as unknown as { scrollToSelection: () => void }, "scrollToSelection")
      .mockImplementation(() => undefined);
    editor.commands.setTextSelection(3);
    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    await act(async () => {
      getButtonByText("标题和块样式").click();
    });
    await act(async () => {
      getButtonByText("小写字母序号").click();
    });

    const list = normalizePmDoc(editor.getJSON()).content[0];
    expect(list?.type === "orderedList" ? list.attrs.listStyle : null).toBe("lower-alpha");
  });

  it("R4-004/R4-011 工具栏有可访问语义且下拉支持方向键与 Esc", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    await render(
      <DocToolbar
        active
        editor={null}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );

    const toolbar = host?.querySelector('[role="toolbar"][aria-label="文档格式工具栏"]');
    expect(toolbar).not.toBeNull();
    for (const label of ["加粗", "删除线", "斜体", "下划线", "链接", "行内代码"]) {
      expect(host?.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    }

    const headingButton = host?.querySelector<HTMLButtonElement>('.dt-group[data-dd="heading"] button');
    expect(headingButton?.getAttribute("aria-haspopup")).toBe("menu");
    expect(headingButton?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      headingButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });

    const menu = host?.querySelector('[role="menu"].dt-menu');
    expect(menu).not.toBeNull();
    expect(headingButton?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(menu?.querySelector('[role="menuitem"]'));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement?.textContent).toContain("二级标题");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(host?.querySelector(".dt-menu")).toBeNull();
    expect(document.activeElement).toBe(headingButton);
  });
});

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

function createSelectedEditor() {
  const instance = createTextEditor("链接文本", "p-link");
  instance.commands.setTextSelection({ from: 1, to: 3 });
  return instance;
}

describe("DocToolbar 块节点选中(原子块走 AI 引用,不出文本工具栏)", () => {
  it("图片/图表 AI 修改按钮不再用 title 复述可见文案，aria-label 保留", async () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          { type: "diagram", attrs: { blockId: "d-tooltip", lang: "mermaid", source: "graph TD;A-->B;", svg: null } },
        ],
      } satisfies PmDoc,
    });
    document.body.appendChild(editor.view.dom);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));

    await render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={async () => true}
      />,
    );
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    const aiButton = document.querySelector<HTMLButtonElement>(".dt-block-ai");
    expect(aiButton?.textContent).toContain("让 AI 修改这个图表");
    expect(aiButton?.hasAttribute("title")).toBe(false);
    expect(aiButton?.getAttribute("aria-label")).toBe("让 AI 修改这个图表");
  });

  it.each([
    ["图表", { type: "diagram", attrs: { blockId: "d-1", lang: "mermaid", source: "graph TD;A-->B;", svg: null } }],
    ["图片", { type: "image", attrs: { blockId: "i-1", src: "https://example.com/a.png", alt: "图" } }],
  ])("取消选中%s后文本工具栏不闪现(显隐以 PM 选区为准)", async (label, blockNode) => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const atomEditor = new Editor({
      element,
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          { type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "前面一段文字" }] },
          blockNode,
        ],
      } as unknown as PmDoc,
    });
    editor = atomEditor;
    try {
      let atomPos = -1;
      atomEditor.state.doc.descendants((node, pos) => {
        if (node.type.isAtom && node.isBlock) atomPos = pos;
        return true;
      });
      expect(atomPos).toBeGreaterThanOrEqual(0);
      await act(async () => {
        atomEditor.view.dispatch(atomEditor.state.tr.setSelection(NodeSelection.create(atomEditor.state.doc, atomPos)));
      });
      await render(
        <DocToolbar
          active
          editor={atomEditor}
          containerSelector="body"
          onAiModify={async () => true}
        />,
      );
      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
      });
      expect(host?.querySelector(`[aria-label="让 AI 修改这个${label}"]`)).not.toBeNull();

      // 取消选中:PM 选区回到折叠文本选区,但浏览器原生选区还残留着原子块那一段(非折叠、有高度)。
      const paragraphText = atomEditor.view.dom.querySelector("p")?.firstChild;
      if (!paragraphText) throw new Error("paragraph text not found");
      // 闪帧发生在"编辑器已聚焦、PM 选区已不是块选、原生选区还没跟上"的那一拍。
      Object.defineProperty(atomEditor, "isFocused", { configurable: true, get: () => true });
      await act(async () => {
        atomEditor.view.dispatch(atomEditor.state.tr.setSelection(TextSelection.create(atomEditor.state.doc, 1)));
        const range = document.createRange();
        range.setStart(paragraphText, 0);
        range.setEnd(paragraphText, 3);
        Object.defineProperty(range, "getBoundingClientRect", {
          configurable: true,
          value: () => DOMRect.fromRect({ x: 40, y: 60, width: 60, height: 18 }),
        });
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });

      expect(host?.querySelector(`[aria-label="让 AI 修改这个${label}"]`)).toBeNull();
      // 关键:PM 选区已折叠,文本工具栏不能靠残留的原生选区闪出来
      expect(host?.querySelector('[aria-label="文档格式工具栏"]')?.classList.contains("on")).not.toBe(true);
    } finally {
      atomEditor.destroy();
      element.remove();
      editor = null;
    }
  });

  it("选中分隔线不弹「让 AI 修改」气泡,选中态视觉也不描边", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const hrEditor = new Editor({
      element,
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          { type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "前" }] },
          { type: "horizontalRule", attrs: { blockId: "hr-1" } },
        ],
      } as unknown as PmDoc,
    });
    try {
      let hrPos = -1;
      hrEditor.state.doc.descendants((node, pos) => {
        if (node.type.name === "horizontalRule") hrPos = pos;
        return true;
      });
      expect(hrPos).toBeGreaterThanOrEqual(0);
      hrEditor.view.dispatch(hrEditor.state.tr.setSelection(NodeSelection.create(hrEditor.state.doc, hrPos)));
      expect(resolveSelectedBlockNode(hrEditor)).toBeNull();
      // 图表等真正可改的原子块不受影响(同文件另有用例覆盖)
      expect(workspaceCss).toMatch(/hr\.ProseMirror-selectednode\{[^}]*outline:none;/s);
    } finally {
      hrEditor.destroy();
      element.remove();
    }
  });

  it("选中图表(原子块)→ resolveSelectedBlockNode 给出 图表 标签 + 单原子块范围放行", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          { type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "前" }] },
          { type: "diagram", attrs: { blockId: "d-1", lang: "mermaid", source: "graph TD;A-->B;", svg: null } },
        ],
      } satisfies PmDoc,
    });
    try {
      // 定位 diagram 节点并设 NodeSelection
      let diagramPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "diagram") diagramPos = pos;
        return true;
      });
      expect(diagramPos).toBeGreaterThanOrEqual(0);
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, diagramPos)));

      const block = resolveSelectedBlockNode(editor);
      expect(block).toMatchObject({ type: "diagram", label: "图表" });
      expect(isEditorRangeSingleAtomBlock(editor, block!.from, block!.to)).toBe(true);

      // 普通段落文本范围不算原子块
      expect(isEditorRangeSingleAtomBlock(editor, 1, 2)).toBe(false);
    } finally {
      editor.destroy();
      element.remove();
    }
  });
});

function createTextEditor(text: string, blockId = "p-text") {
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
          type: "paragraph",
          attrs: { blockId },
          content: [{ type: "text", text }],
        },
      ],
    } satisfies PmDoc,
  });
}

function createTwoParagraphEditor() {
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
          type: "paragraph",
          attrs: { blockId: "p-first" },
          content: [{ type: "text", text: "目标段落" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "p-tail" },
          content: [{ type: "text", text: "尾段" }],
        },
      ],
    } satisfies PmDoc,
  });
}

function createTableEditor() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "table",
        attrs: { blockId: "table-toolbar" },
        content: [{
          type: "tableRow",
          content: ["甲乙", "丙丁"].map((text, index) => ({
            type: "tableCell",
            content: [{
              type: "paragraph",
              attrs: { blockId: `cell-${index}` },
              content: [{ type: "text", text }],
            }],
          })),
        }],
      }],
    } satisfies PmDoc,
  });
}

function createOrderedListEditor() {
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
          type: "orderedList",
          attrs: { blockId: "ol", start: 1 },
          content: [
            {
              type: "listItem",
              attrs: { blockId: "li" },
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "li-p" },
                  content: [{ type: "text", text: "甲" }],
                },
              ],
            },
          ],
        },
      ],
    } satisfies PmDoc,
  });
}

function createCommandEditor(runResult: boolean): Editor {
  const chain: Record<string, unknown> = {};
  const chainMethod = () => chain;
  Object.assign(chain, {
    focus: chainMethod,
    insertTable: chainMethod,
    toggleBlockquote: chainMethod,
    insertDiagram: vi.fn(chainMethod),
    run: vi.fn(() => runResult),
  });
  return {
    isEditable: true,
    isFocused: false,
    isDestroyed: false,
    isActive: () => false,
    getAttributes: () => ({}),
    on: vi.fn(),
    off: vi.fn(),
    chain: () => chain,
    state: {
      selection: { from: 0, to: 0, empty: true },
      doc: {
        textBetween: () => "",
        descendants: () => undefined,
        content: { size: 0 },
      },
    },
    view: {
      dom: document.createElement("div"),
      coordsAtPos: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    },
  } as unknown as Editor;
}

function getButtonByText(text: string): HTMLButtonElement {
  const menuItem = Array.from(host?.querySelectorAll('[role="menuitem"]') ?? []).find((item) =>
    item.textContent?.includes(text) ||
    item.getAttribute("aria-label")?.includes(text) ||
    item.getAttribute("title")?.includes(text),
  );
  const button = menuItem ?? Array.from(host?.querySelectorAll("button") ?? []).find((item) =>
    item.textContent?.includes(text) ||
    item.getAttribute("aria-label")?.includes(text) ||
    item.getAttribute("title")?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}
