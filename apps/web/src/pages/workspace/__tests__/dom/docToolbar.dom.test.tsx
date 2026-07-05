// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeSelection } from "@tiptap/pm/state";
import {
  DocToolbar,
  resolveDiagramSourceForInsert,
  resolveSelectedBlockNode,
  isEditorRangeSingleAtomBlock,
  reportToolbarCommandResult,
  toolbarTitle,
} from "../../components/DocToolbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let editor: Editor | null = null;

describe("DocToolbar round-1 regressions", () => {
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
        onAiModify={() => undefined}
      />,
    );

    await act(async () => {
      getButtonByText("插入").click();
    });

    expect(host?.textContent).toContain("插入表格");
    expect(host?.textContent).toContain("插入分栏");
    expect(host?.textContent).toContain("代码块");
    expect(host?.textContent).toContain("分隔线");
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
        onAiModify={() => undefined}
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
        onAiModify={() => undefined}
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
        onAiModify={() => undefined}
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
        onAiModify={() => undefined}
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
        onAiModify={() => undefined}
        onToast={onToast}
      />,
    );

    await act(async () => {
      getButtonByText("插入").click();
    });
    await act(async () => {
      getButtonByText("插入表格").click();
    });

    expect(onToast).toHaveBeenCalledWith("无法执行：插入表格");
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
        onAiModify={() => undefined}
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
        onAiModify={() => undefined}
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
        onAiModify={() => undefined}
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
    run: vi.fn(() => runResult),
  });
  return {
    isEditable: true,
    isFocused: false,
    isDestroyed: false,
    isActive: () => false,
    getAttributes: () => ({}),
    chain: () => chain,
    state: {
      selection: { from: 0, to: 0, empty: true },
      doc: { textBetween: () => "", content: { size: 0 } },
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
