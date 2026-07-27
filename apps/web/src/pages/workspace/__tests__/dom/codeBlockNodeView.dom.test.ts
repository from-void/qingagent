// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it } from "vitest";
import { CodeBlockCM } from "../../components/CodeBlockView";

// jsdom 不实现布局测量;ProseMirror/getBoundingClientRect 补空实现避免抛错。
function polyfillLayout() {
  const empty = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Element.prototype.getBoundingClientRect = empty as unknown as () => DOMRect;
  Range.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = empty as unknown as () => DOMRect;
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;
}
polyfillLayout();

let mounted: { root: Root; container: HTMLElement } | null = null;

async function mountEditor(content: PmDoc, editable = true): Promise<Editor> {
  const editor = new Editor({
    editable,
    extensions: createQingagentExtensions({ codeBlockExtension: CodeBlockCM }),
    content: content as never,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(EditorContent, { editor }));
  });
  await flush();
  mounted = { root, container };
  return editor;
}

async function unmount(editor: Editor) {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => {
      root.unmount();
    });
    container.remove();
    mounted = null;
  }
  editor.destroy();
}

async function flush(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush(3);
}

function codeDoc(language: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "codeBlock",
        attrs: { blockId: "cb-1", language },
        content: [{ type: "text", text: "echo hi" }],
      },
    ],
  } as unknown as PmDoc;
}

function firstCodeLanguage(editor: Editor): string | null {
  const doc = editor.getJSON() as {
    content?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  };
  const block = doc.content?.find((n) => n.type === "codeBlock");
  return block?.attrs && typeof block.attrs.language === "string"
    ? (block.attrs.language as string)
    : null;
}

describe("代码块语言选择器(自定义下拉,非原生 select):闭合不污染正文 + 点选真更新语言", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    mounted = null;
  });

  it("闭合态:正文不含未选语言标签列表(只有当前语言按钮),消除原生 select option 污染", async () => {
    const editor = await mountEditor(codeDoc("yaml"));
    const container = mounted!.container;
    const btn = container.querySelector(".code-block-language-select") as HTMLElement;
    expect(btn).toBeTruthy();
    // 按钮显示当前语言名(yaml 是内置语言,显示其 label "YAML")
    expect(btn.textContent).toBe("YAML");
    // 闭合态:没有菜单 portal,正文里不出现其它语言名(如 TypeScript/Python/Plain Text)
    expect(document.querySelector(".code-block-language-menu")).toBeNull();
    const codeNodeText = container.querySelector(".code-block-node")?.textContent ?? "";
    expect(codeNodeText).not.toContain("TypeScript");
    expect(codeNodeText).not.toContain("Python");
    expect(codeNodeText).not.toContain("Plain Text");
    await unmount(editor);
  });

  it("点语言按钮弹菜单(portal 到 body),点某语言 → node.attrs.language 真更新(回归 R23-c1)", async () => {
    const editor = await mountEditor(codeDoc("yaml"));
    const container = mounted!.container;
    const btn = container.querySelector(".code-block-language-select") as HTMLElement;
    await click(btn);
    // 菜单 portal 到 document.body
    const menu = document.querySelector(".code-block-language-menu");
    expect(menu).toBeTruthy();
    const opts = Array.from(
      document.querySelectorAll(".code-block-language-option"),
    ) as HTMLElement[];
    const bash = opts.find((o) => o.textContent === "Bash/Shell");
    expect(bash).toBeTruthy();
    await click(bash!);
    // 关键断言:语言真更新到节点 attrs(自动化回归报"菜单关闭但语言未更新")
    expect(firstCodeLanguage(editor)).toBe("bash");
    // 菜单点选后关闭
    expect(document.querySelector(".code-block-language-menu")).toBeNull();
    // 按钮文本更新为新语言 label
    expect(container.querySelector(".code-block-language-select")?.textContent).toBe(
      "Bash/Shell",
    );
    await unmount(editor);
  });

  it("非内置语言(groovy)菜单里置顶可见可选回", async () => {
    const editor = await mountEditor(codeDoc("groovy"));
    const container = mounted!.container;
    expect(
      (container.querySelector(".code-block-language-select") as HTMLElement).textContent,
    ).toBe("groovy");
    await click(container.querySelector(".code-block-language-select") as HTMLElement);
    const opts = Array.from(
      document.querySelectorAll(".code-block-language-option"),
    ) as HTMLElement[];
    // 置顶一条 groovy 自身
    expect(opts[0]?.textContent).toBe("groovy");
    // 选回内置 python 也生效
    const py = opts.find((o) => o.textContent === "Python");
    await click(py!);
    expect(firstCodeLanguage(editor)).toBe("python");
    await unmount(editor);
  });

  it("语言菜单自身滚动不触发全局滚动关闭", async () => {
    const editor = await mountEditor(codeDoc("python"));
    const container = mounted!.container;
    await click(container.querySelector(".code-block-language-select") as HTMLElement);

    const menu = document.querySelector(".code-block-language-menu") as HTMLElement | null;
    expect(menu).toBeTruthy();

    await act(async () => {
      menu!.scrollTop = 96;
      menu!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await flush(2);

    expect(document.querySelector(".code-block-language-menu")).toBe(menu);
    expect(menu!.scrollTop).toBe(96);
    await unmount(editor);
  });

  it("只读态禁用语言菜单且不产生属性事务", async () => {
    const editor = await mountEditor(codeDoc("python"), false);
    const button = mounted!.container.querySelector(
      ".code-block-language-select",
    ) as HTMLButtonElement;
    const before = editor.state;

    expect(button.disabled).toBe(true);
    await click(button);

    expect(document.querySelector(".code-block-language-menu")).toBeNull();
    expect(firstCodeLanguage(editor)).toBe("python");
    expect(editor.state).toBe(before);
    await unmount(editor);
  });

  it("菜单展开后切为只读时阻止已挂载选项更新属性", async () => {
    const editor = await mountEditor(codeDoc("python"));
    const button = mounted!.container.querySelector(
      ".code-block-language-select",
    ) as HTMLButtonElement;
    await click(button);
    const bash = Array.from(
      document.querySelectorAll<HTMLElement>(".code-block-language-option"),
    ).find((option) => option.textContent === "Bash/Shell");
    expect(bash).toBeTruthy();

    editor.setEditable(false);
    const before = editor.state;
    await click(bash!);

    expect(firstCodeLanguage(editor)).toBe("python");
    expect(editor.state).toBe(before);
    await unmount(editor);
  });
});
