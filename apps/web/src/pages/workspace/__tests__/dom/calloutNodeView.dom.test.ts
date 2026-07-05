// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePmDoc } from "@qingagent/pm-schema";
import { CalloutCM } from "../../components/CalloutView";

// jsdom 不实现布局测量;ProseMirror focus 时会调 getClientRects 等,补空实现避免抛错。
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
  (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
}
polyfillLayout();

// React NodeView 的 portal 只有当 editor 被 <EditorContent> 托管时才真渲染到 DOM,
// 所以必须用 react-dom 真挂载,而不是裸 new Editor()。
let mounted: { root: Root; container: HTMLElement } | null = null;

async function mountEditor(content: PmDoc, editable = true): Promise<Editor> {
  const editor = new Editor({
    editable,
    extensions: createQingagentExtensions({ calloutExtension: CalloutCM }),
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
  await flush(2);
}

function calloutDoc(opts: { emoji?: string | null; tone?: string; text?: string } = {}): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "callout",
        attrs: { blockId: "c-1", emoji: opts.emoji ?? "💡", tone: opts.tone ?? "info" },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "p-1" },
            content: opts.text ? [{ type: "text", text: opts.text }] : [],
          },
        ],
      },
    ],
  } as unknown as PmDoc;
}

function firstCalloutAttrs(editor: Editor): { emoji: string | null; tone: string } | null {
  const doc = editor.getJSON() as {
    content?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  };
  const block = doc.content?.find((n) => n.type === "callout");
  if (!block?.attrs) return null;
  return {
    emoji: typeof block.attrs.emoji === "string" ? block.attrs.emoji : null,
    tone: String(block.attrs.tone ?? ""),
  };
}

describe("callout 高亮块节点视图(emoji 选择器 + 主题切换)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    mounted = null;
  });

  it("挂载 NodeView:正文是原生 PM 文本(无嵌入式 textarea/子编辑器,IME 安全),emoji 与 5 主题 chrome 在位", async () => {
    const editor = await mountEditor(calloutDoc({ emoji: "💡", tone: "info", text: "提示正文" }));
    const container = mounted!.container;
    const callout = container.querySelector(".pm-callout");
    expect(callout).toBeTruthy();
    expect(callout!.classList.contains("pm-callout--info")).toBe(true);
    expect(container.querySelector(".pm-callout-body")?.textContent).toContain("提示正文");
    // IME 安全:正文不是内嵌 textarea/子编辑器(代码块迁移那次的教训)
    expect(container.querySelector(".pm-callout-body textarea")).toBeNull();
    // chrome 在位:emoji 按钮 + 主题触发钮(点开为 10 主题色板)
    expect(container.querySelector("button.pm-callout-emoji")).toBeTruthy();
    expect(container.querySelector(".pm-callout-theme-trigger")).toBeTruthy();
    await click(container.querySelector(".pm-callout-theme-trigger") as HTMLElement);
    expect(container.querySelectorAll(".pm-callout-theme-opt").length).toBe(10);
    await unmount(editor);
  });

  it("点 emoji 按钮弹选择器,选一个 emoji 写入 node.attrs.emoji", async () => {
    const editor = await mountEditor(calloutDoc({ emoji: "💡", tone: "info" }));
    const container = mounted!.container;
    await click(container.querySelector("button.pm-callout-emoji") as HTMLElement);
    expect(container.querySelector(".pm-callout-emoji-pop")).toBeTruthy();
    const opts = Array.from(
      container.querySelectorAll(".pm-callout-emoji-opt"),
    ) as HTMLElement[];
    const star = opts.find((o) => o.textContent === "⭐");
    expect(star).toBeTruthy();
    await click(star!);
    expect(firstCalloutAttrs(editor)?.emoji).toBe("⭐");
    await unmount(editor);
  });

  it("「无图标」把 emoji 设为空串(非 null)→ 经 normalize 不被 strip,重载仍无图标(不复活 💡)", async () => {
    const editor = await mountEditor(calloutDoc({ emoji: "💡" }));
    const container = mounted!.container;
    await click(container.querySelector("button.pm-callout-emoji") as HTMLElement);
    await click(container.querySelector(".pm-callout-emoji-none") as HTMLElement);
    // 用 "" 而非 null:normalizeAttrsShape 删 null 值 attr,会让重载回落 base 默认 💡;"" 不被删。
    expect(firstCalloutAttrs(editor)?.emoji).toBe("");
    // 复现持久化:落盘走 normalizePmDoc,确认 emoji "" 仍在(不被 strip → 重载不复活 💡)
    const saved = normalizePmDoc(editor.getJSON()) as {
      content?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
    };
    const calloutAttrs = saved.content?.find((n) => n.type === "callout")?.attrs;
    expect(calloutAttrs?.emoji).toBe("");
    await unmount(editor);
  });

  it("点主题色板切换 tone(背景主题)并反映到 .pm-callout--{tone} class", async () => {
    const editor = await mountEditor(calloutDoc({ tone: "info" }));
    const container = mounted!.container;
    // 打开主题色板,选「藕荷」= mauve(新扩主题之一)
    await click(container.querySelector(".pm-callout-theme-trigger") as HTMLElement);
    const opts = Array.from(
      container.querySelectorAll(".pm-callout-theme-opt"),
    ) as HTMLElement[];
    const mauve = opts.find((o) => o.getAttribute("aria-label") === "藕荷");
    expect(mauve).toBeTruthy();
    await click(mauve!);
    expect(firstCalloutAttrs(editor)?.tone).toBe("mauve");
    await flush(2);
    expect(
      container.querySelector(".pm-callout")?.classList.contains("pm-callout--mauve"),
    ).toBe(true);
    await unmount(editor);
  });

  it("编辑器只读时 callout 图标和主题按钮禁用,点击不改 attrs", async () => {
    const editor = await mountEditor(calloutDoc({ emoji: "💡", tone: "info" }), false);
    const container = mounted!.container;
    const themeTrigger = container.querySelector<HTMLButtonElement>(".pm-callout-theme-trigger");
    const emojiTrigger = container.querySelector<HTMLButtonElement>("button.pm-callout-emoji");

    expect(themeTrigger?.disabled).toBe(true);
    expect(emojiTrigger?.disabled).toBe(true);

    await click(themeTrigger!);
    await click(emojiTrigger!);

    expect(container.querySelector(".pm-callout-theme-pop")).toBeNull();
    expect(container.querySelector(".pm-callout-emoji-pop")).toBeNull();
    expect(firstCalloutAttrs(editor)).toEqual({ emoji: "💡", tone: "info" });
    await unmount(editor);
  });

  it("再点 emoji 按钮可收起选择器(触发钮在 wrap 内不被当点空白)", async () => {
    const editor = await mountEditor(calloutDoc({ emoji: "💡" }));
    const container = mounted!.container;
    const btn = container.querySelector("button.pm-callout-emoji") as HTMLElement;
    await click(btn);
    expect(container.querySelector(".pm-callout-emoji-pop")).toBeTruthy();
    await click(btn); // 二次点击应收起
    expect(container.querySelector(".pm-callout-emoji-pop")).toBeNull();
    await unmount(editor);
  });
});
