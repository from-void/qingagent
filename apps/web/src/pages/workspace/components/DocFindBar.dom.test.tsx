// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorContent } from "@tiptap/react";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocFindDecorations } from "../data/docFindPm";
import { DocFindBar } from "./DocFindBar";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DocFindBar", () => {
  it("full 模式可展开替换行,用 decorations 标记命中,全部替换是单次撤销", async () => {
    const editor = editorWithText("alpha beta alpha");
    const onToast = vi.fn();
    try {
      await renderDocFind(
        <Harness editor={editor} mode="full" onToast={onToast} />,
      );

      await inputText(findInput(), "alpha");
      await flushSearch();

      expect(countText()).toBe("1/2");
      expect(editor.view.dom.querySelectorAll(".ws-find-hit")).toHaveLength(2);
      expect(editor.view.dom.querySelectorAll(".ws-find-hit.is-current")).toHaveLength(1);

      await click(buttonByTitle("替换"));
      expect(replaceRow().hidden).toBe(false);
      expect(buttonByText("替换").disabled).toBe(false);

      await inputText(replaceInput(), "omega");
      await click(buttonByText("全部替换"));

      expect(onToast).toHaveBeenCalledWith("已替换 2 处");
      expect(editor.getText()).toBe("omega beta omega");
      expect(countText()).toBe("0/0");

      expect(editor.commands.undo()).toBe(true);
      expect(editor.getText()).toBe("alpha beta alpha");
    } finally {
      editor.destroy();
    }
  });

  it("find-only 模式禁用替换入口并显示 badge", async () => {
    const editor = editorWithText("alpha");
    try {
      await renderDocFind(
        <Harness
          editor={editor}
          mode="find-only"
          badgeText="审阅中 · 仅查找"
        />,
      );

      expect(buttonByTitle("审阅中不可替换,先处理完修改建议").disabled).toBe(true);
      expect(host?.querySelector(".ws-find-mode-badge")?.textContent).toBe("审阅中 · 仅查找");
      expect(replaceRow().hidden).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("0 命中时显示 0/0 且输入框进入描红态", async () => {
    const editor = editorWithText("alpha");
    try {
      await renderDocFind(<Harness editor={editor} mode="full" />);

      await inputText(findInput(), "missing");
      await flushSearch();

      expect(countText()).toBe("0/0");
      expect(findInput().classList.contains("is-nohit")).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});

function Harness({
  editor,
  mode,
  badgeText,
  onToast = vi.fn(),
}: {
  editor: Editor;
  mode: "full" | "find-only";
  badgeText?: string;
  onToast?: (msg: string) => void;
}) {
  return (
    <div id="view-workspace">
      <div className="ws-right">
        <div className="wf-doc">
          <EditorContent editor={editor} />
        </div>
        <DocFindBar
          editor={editor}
          mode={mode}
          docVersion={1}
          badgeText={badgeText}
          onClose={() => undefined}
          onToast={onToast}
        />
      </div>
    </div>
  );
}

function editorWithText(text: string): Editor {
  return new Editor({
    extensions: [...createQingagentExtensions(), DocFindDecorations],
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "p-1" },
          content: [{ type: "text", text }],
        },
      ],
    } satisfies PmDoc,
  });
}

async function renderDocFind(element: ReactNode): Promise<void> {
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
  });
}

async function flushSearch(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(160);
    await Promise.resolve();
  });
}

async function inputText(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function findInput(): HTMLInputElement {
  return inputByLabel("查找");
}

function replaceInput(): HTMLInputElement {
  return inputByLabel("替换为");
}

function inputByLabel(label: string): HTMLInputElement {
  const input = host?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`input not found: ${label}`);
  return input;
}

function countText(): string {
  return host?.querySelector(".ws-find-count")?.textContent ?? "";
}

function replaceRow(): HTMLDivElement {
  const row = host?.querySelector<HTMLDivElement>(".ws-find-replace-row");
  if (!row) throw new Error("replace row not found");
  return row;
}

function buttonByTitle(title: string): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((node) => node.title === title);
  if (!button) throw new Error(`button not found: ${title}`);
  return button;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((node) => node.textContent === text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}
