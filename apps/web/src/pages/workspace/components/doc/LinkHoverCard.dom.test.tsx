// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { afterEach, describe, expect, it } from "vitest";
import { LinkHoverCard } from "./LinkHoverCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("LinkHoverCard 实时锚点", () => {
  let editor: Editor | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
  });

  it("链接前方插入文本后仍修改原链接，而不是复用旧坐标", async () => {
    const mounted = await mountLinkCard();
    editor = mounted.editor;
    root = mounted.root;

    const anchor = editor.view.dom.querySelector<HTMLAnchorElement>('a[href="https://old.example"]')!;
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    editor.commands.insertContentAt(1, "新增");
    await act(async () => {
      mounted.host.querySelector<HTMLButtonElement>(".lhc-view .lhc-btn")!.click();
    });
    const input = mounted.host.querySelector<HTMLInputElement>(".lhc-input")!;
    await act(async () => {
      setInputValue(input, "https://new.example");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });

    const json = JSON.stringify(editor.getJSON());
    expect(editor.getText()).toBe("新增前文链接后文");
    expect(json).toContain('"href":"https://new.example"');
    expect(json).not.toContain('"href":"https://old.example"');
  });

  it("锚点被文档替换后移除操作静默关闭，不修改新正文", async () => {
    const mounted = await mountLinkCard();
    editor = mounted.editor;
    root = mounted.root;

    const anchor = editor.view.dom.querySelector<HTMLAnchorElement>('a[href="https://old.example"]')!;
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    editor.commands.setContent({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "replacement" },
        content: [{ type: "text", text: "替换后的正文" }],
      }],
    });

    const remove = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>(".lhc-btn"))
      .find((button) => button.textContent === "移除");
    await act(async () => {
      expect(() => remove?.click()).not.toThrow();
    });

    expect(mounted.host.querySelector(".link-hover-card")).toBeNull();
    expect(editor.getText()).toBe("替换后的正文");
  });
});

async function mountLinkCard(): Promise<{ editor: Editor; root: Root; host: HTMLElement }> {
  const editorElement = document.createElement("div");
  const host = document.createElement("div");
  document.body.append(editorElement, host);
  const editor = new Editor({
    element: editorElement,
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "p" },
        content: [
          { type: "text", text: "前文" },
          {
            type: "text",
            text: "链接",
            marks: [{ type: "link", attrs: { href: "https://old.example" } }],
          },
          { type: "text", text: "后文" },
        ],
      }],
    },
  });
  const root = createRoot(host);
  await act(async () => {
    root.render(<LinkHoverCard editor={editor} />);
  });
  return { editor, root, host };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
}
