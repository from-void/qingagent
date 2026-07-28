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

  it("全部替换独立重扫超过装饰上限的所有命中,并保持单次撤销", async () => {
    const source = Array.from({ length: 1001 }, () => "a").join(" ");
    const editor = editorWithText(source);
    const onToast = vi.fn();
    try {
      await renderDocFind(
        <Harness editor={editor} mode="full" onToast={onToast} />,
      );
      await inputText(findInput(), "a");
      await flushSearch();

      expect(countText()).toBe("1/1000+");
      expect(editor.view.dom.querySelectorAll(".ws-find-hit")).toHaveLength(1000);

      await openReplaceWith("omega");
      await click(buttonByText("全部替换"));

      expect(onToast).toHaveBeenCalledWith("已替换 1001 处");
      expect(editor.getText().split(" ")).toEqual(
        Array.from({ length: 1001 }, () => "omega"),
      );
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getText()).toBe(source);
    } finally {
      editor.destroy();
    }
  });

  it("find-only 模式不出替换入口(⇄ 与替换行都不渲染)", async () => {
    const editor = editorWithText("alpha");
    try {
      await renderDocFind(<Harness editor={editor} mode="find-only" />);

      const replaceToggle = Array.from(
        host?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find((node) => node.title === "替换");
      expect(replaceToggle).toBeUndefined();
      expect(replaceRow().hidden).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("切换新旧版(editor 实例更换)保留关键词并直出新结果", async () => {
    const oldEditor = editorWithText("alpha beta alpha");
    const newEditor = editorWithText("alpha");
    try {
      await renderDocFind(<Harness editor={oldEditor} mode="find-only" />);
      await inputText(findInput(), "alpha");
      await flushSearch();
      expect(countText()).toBe("1/2");

      // 模拟审阅态切新/旧版:wdr-swap key 变 → DocumentSnapshotView 整体重挂 →
      // editor 实例更换。DocFindBar 不卸载,query 保留,应对新 doc 直出结果。
      await renderDocFind(<Harness editor={newEditor} mode="find-only" />);
      await flushSearch();

      expect(findInput().value).toBe("alpha");
      expect(countText()).toBe("1/1");
      expect(newEditor.view.dom.querySelectorAll(".ws-find-hit")).toHaveLength(1);
    } finally {
      oldEditor.destroy();
      newEditor.destroy();
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

  it("查询词改变后的防抖窗口内替换只消费当前关键词", async () => {
    const editor = editorWithText("alpha beta alpha");
    try {
      await renderDocFind(<Harness editor={editor} mode="full" />);
      await inputText(findInput(), "alpha");
      await flushSearch();
      await openReplaceWith("omega");

      await inputText(findInput(), "beta");
      await click(buttonByText("替换"));

      expect(editor.getText()).toBe("alpha omega alpha");
      expect(countText()).toBe("0/0");
    } finally {
      editor.destroy();
    }
  });

  it("正文事务后的防抖窗口内替换会按当前文档重算位置", async () => {
    const editor = editorWithText("alpha tail");
    try {
      await renderDocFind(<Harness editor={editor} mode="full" />);
      await inputText(findInput(), "alpha");
      await flushSearch();
      await openReplaceWith("omega");

      await act(async () => {
        editor.commands.setContent({
          type: "doc",
          attrs: { schemaVersion: 1 },
          content: [{
            type: "paragraph",
            attrs: { blockId: "p-1" },
            content: [{ type: "text", text: "xxxxx alpha tail" }],
          }],
        } satisfies PmDoc);
        await Promise.resolve();
      });
      await click(buttonByText("替换"));

      expect(editor.getText()).toBe("xxxxx omega tail");
    } finally {
      editor.destroy();
    }
  });
});

function Harness({
  editor,
  mode,
  onToast = vi.fn(),
}: {
  editor: Editor;
  mode: "full" | "find-only";
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

async function openReplaceWith(value: string): Promise<void> {
  await click(buttonByTitle("替换"));
  await inputText(replaceInput(), value);
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
