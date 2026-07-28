// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockHandle } from "./BlockHandle";
import { pickFile } from "./pickFile";

vi.mock("./pickFile", () => ({
  pickFile: vi.fn(async () => null),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BlockHandle 上传入口", () => {
  let editor: Editor | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
    vi.mocked(pickFile).mockReset();
    vi.mocked(pickFile).mockResolvedValue(null);
  });

  for (const label of ["插入图片", "插入文件"]) {
    it(`取消“${label}”选择时不留下空段`, async () => {
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
          content: [{
            type: "paragraph",
            attrs: { blockId: "source" },
            content: [{ type: "text", text: "正文" }],
          }],
        },
      });
      editor.commands.setTextSelection(1);
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

      const button = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((item) => item.textContent?.includes(label));
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });

      expect(pickFile).toHaveBeenCalledOnce();
      expect(editor.getJSON().content).toHaveLength(1);
      expect(editor.getText()).toBe("正文");
    });
  }

  it("选择文件期间插入锚点失效时走既有失败 toast", async () => {
    let resolveFile!: (file: File) => void;
    vi.mocked(pickFile).mockReturnValueOnce(
      new Promise<File>((resolve) => {
        resolveFile = resolve;
      }),
    );
    const onToast = vi.fn();
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
        content: [{
          type: "paragraph",
          attrs: { blockId: "source" },
          content: [{ type: "text", text: "正文" }],
        }],
      },
    });
    editor.commands.setTextSelection(1);
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
    const button = Array.from(
      workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes("插入文件"));
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    await act(async () => {
      editor!.commands.setContent({
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{
          type: "paragraph",
          attrs: { blockId: "external" },
          content: [{ type: "text", text: "外部正文" }],
        }],
      });
      resolveFile(
        new File(["data"], "report.pdf", { type: "application/pdf" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onToast).toHaveBeenCalledWith("文件上传失败，请重试");
    expect(editor.getText()).toBe("外部正文");
  });
});
