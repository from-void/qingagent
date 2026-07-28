// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { afterEach, describe, expect, it } from "vitest";
import { BlockHandle } from "./BlockHandle";
import { glyphForBlock } from "./blockHandleGeometry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BlockHandle 分隔线菜单", () => {
  let editor: Editor | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
  });

  it("无文本的 horizontalRule 仍显示剪切、复制、删除和分隔线徽标", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = new Editor({
      element: editorElement,
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{ type: "horizontalRule", attrs: { blockId: "divider" } }],
      },
    });
    editor.commands.setNodeSelection(0);
    root = createRoot(reactHost);
    await act(async () => {
      root?.render(<BlockHandle editor={editor!} />);
    });
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    const menu = workspace.querySelector<HTMLElement>(".block-handle-menu");
    expect(menu?.textContent).toContain("剪切");
    expect(menu?.textContent).toContain("复制");
    expect(menu?.textContent).toContain("删除");
    expect(workspace.querySelector(".block-handle-btn.is-chip .bh-type .bh-svg path")?.getAttribute("stroke-dasharray"))
      .toBe("1.8 2.4");
    expect(glyphForBlock(editor.state.doc.firstChild)).toBe("divider");
  });
});
