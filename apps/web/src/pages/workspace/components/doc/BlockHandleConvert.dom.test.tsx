// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockHandle } from "./BlockHandle";
import { resolveInlineInsertPos } from "./blockHandlePosition";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 没有 Range.getClientRects;chain().focus() 的 scrollIntoView 会经 prosemirror 调到它。
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
const zeroRect = () => ({
  top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
}) as DOMRect;
Range.prototype.getClientRects = emptyRects;
Range.prototype.getBoundingClientRect = zeroRect;

/** tiptap 的 Content 类型对测试夹具过严(与 pm Node 联合),这里只关心 JSON 结构。 */
type DocContent = Record<string, unknown>;

function doc(...content: unknown[]): DocContent {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

const paragraph = (text?: string) => ({
  type: "paragraph",
  attrs: { blockId: "p1" },
  ...(text ? { content: [{ type: "text", text }] } : {}),
});

describe("BlockHandle 转换为", () => {
  let editor: Editor | null = null;
  let root: Root | null = null;
  let workspace: HTMLElement | null = null;
  const onToast = vi.fn();

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    editor?.destroy();
    editor = null;
    workspace = null;
    onToast.mockClear();
    document.body.innerHTML = "";
  });

  async function openBlockMenu(content: DocContent): Promise<void> {
    workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = new Editor({ element: editorElement, extensions: createQingagentExtensions(), content: content as never });
    editor.commands.setNodeSelection(0);
    root = createRoot(reactHost);
    await act(async () => {
      root?.render(<BlockHandle editor={editor!} onToast={onToast} />);
    });
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
  }

  async function clickConvert(label: string): Promise<void> {
    const button = workspace!.querySelector<HTMLElement>(`.bh-grid-btn[aria-label="${label}"]`);
    expect(button, `「${label}」按钮应存在`).not.toBeNull();
    await act(async () => {
      button!.click();
    });
  }

  it("叶子块(分隔线)整排不出「转换为」——不给点了必然失败的死按钮", async () => {
    await openBlockMenu(doc({ type: "horizontalRule", attrs: { blockId: "hr" } }));

    const menu = workspace!.querySelector<HTMLElement>(".block-handle-menu");
    expect(menu).not.toBeNull();
    expect(menu!.textContent).not.toContain("转换为");
    expect(menu!.querySelector(".bh-grid")).toBeNull();
    // 仍保留剪切/复制/删除这些对叶子块成立的操作。
    expect(menu!.textContent).toContain("删除");
  });

  it("普通段落照常出宫格,「代码块」转换成功且不弹提示", async () => {
    await openBlockMenu(doc(paragraph()));
    await clickConvert("代码块");

    expect(onToast).not.toHaveBeenCalled();
    expect(editor!.state.doc.firstChild?.type.name).toBe("codeBlock");
  });

  it("转换项按六列连续补位,第一排由正文紧跟 H5 填满", async () => {
    await openBlockMenu(doc(paragraph()));

    const items = Array.from(
      workspace!.querySelectorAll<HTMLElement>(".bh-grid > [role=menuitem]"),
      (item) => item.getAttribute("aria-label"),
    );
    expect(items).toEqual([
      "一级标题",
      "二级标题",
      "三级标题",
      "四级标题",
      "五级标题",
      "正文",
      "六级标题",
      "无序列表",
      "有序列表",
      "引用",
      "代码块",
      "待办清单",
      "高亮块",
    ]);
  });

  it("菜单打开后光标移出高亮块,再点「高亮块」仍能取消包裹(不吃旧选区)", async () => {
    await openBlockMenu(doc(
      { type: "callout", content: [paragraph("提示")] },
      { type: "paragraph", attrs: { blockId: "p2" }, content: [{ type: "text", text: "外面" }] },
    ));
    // 菜单已按 callout 打开;此时光标漂到块外 —— 旧实现读 editor.isActive 会误判成"要包裹",
    // 对已经是 callout 的块执行 wrapIn 必然失败并弹提示。
    await act(async () => {
      editor!.commands.setTextSelection(8);
    });
    expect(editor!.isActive("callout")).toBe(false);

    await clickConvert("高亮块");
    expect(onToast).not.toHaveBeenCalled();
    expect(editor!.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("schema 真不允许时,提示说清是「当前块」不支持", async () => {
    // callout 的 content 是 paragraph+,包不住 codeBlock —— 真实的 schema 限制。
    await openBlockMenu(doc({
      type: "codeBlock",
      attrs: { blockId: "c1" },
      content: [{ type: "text", text: "const a = 1" }],
    }));
    await clickConvert("高亮块");

    expect(onToast).toHaveBeenCalledWith("当前块不支持「高亮块」");
    expect(editor!.state.doc.firstChild?.type.name).toBe("codeBlock");
  });
});

describe("高亮块开关按链上状态判定", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function makeEditor(): Editor {
    // [callout[paragraph "提示"], paragraph "外面"]:callout 占 0..6,内层行内位置 = 2。
    return new Editor({
      extensions: createQingagentExtensions(),
      content: doc(
        { type: "callout", content: [paragraph("提示")] },
        { type: "paragraph", attrs: { blockId: "p2" }, content: [{ type: "text", text: "外面" }] },
      ) as never,
    });
  }

  it("光标在高亮块外、命令目标在块内时,旧的 editor.isActive 分支会误判成 wrapIn 并失败", () => {
    editor = makeEditor();
    editor.commands.setTextSelection(8);
    expect(editor.isActive("callout")).toBe(false);

    // 旧实现:isActive 读的是命令执行前的旧选区 → 走 wrapIn → 嵌套 callout 不成立 → false → 弹提示。
    expect(editor.chain().focus().setTextSelection(2).wrapIn("callout").run()).toBe(false);
    expect(editor.state.doc.firstChild?.type.name).toBe("callout");
  });

  it("toggleWrap 在链上状态里判 active,同一场景正确取消包裹", () => {
    editor = makeEditor();
    editor.commands.setTextSelection(8);

    expect(editor.chain().focus().setTextSelection(2).toggleWrap("callout").run()).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
  });
});

describe("resolveInlineInsertPos", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function makeEditor(content: DocContent): Editor {
    editor = new Editor({ extensions: createQingagentExtensions(), content: content as never });
    return editor;
  }

  it("块边界位置被归一到块内行内位置", () => {
    const pmDoc = makeEditor(doc(paragraph("文字"))).state.doc;

    expect(pmDoc.resolve(0).parent.inlineContent).toBe(false);
    expect(resolveInlineInsertPos(pmDoc, 0, 0)).toBe(1);
    // 已经是行内位置时原样返回,不挪动用户的落点。
    expect(resolveInlineInsertPos(pmDoc, 0, 2)).toBe(2);
  });

  it("容器块(高亮块)的 blockPos+1 被归一到内层段落里", () => {
    const pmDoc = makeEditor(doc({ type: "callout", content: [paragraph("提示")] })).state.doc;

    expect(pmDoc.resolve(1).parent.inlineContent).toBe(false);
    const anchor = resolveInlineInsertPos(pmDoc, 0, 1);
    expect(anchor).toBe(2);
    expect(pmDoc.resolve(anchor!).parent.inlineContent).toBe(true);
  });

  it("没有正文的叶子块返回 null(转换本就不成立)", () => {
    const pmDoc = makeEditor(doc({ type: "horizontalRule", attrs: { blockId: "hr" } })).state.doc;

    expect(resolveInlineInsertPos(pmDoc, 0, 0)).toBeNull();
  });
});
