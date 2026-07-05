// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";
import { ImageCM } from "../../components/ImageView";
import { pmDocToViewDocumentSnapshot } from "../../data/protocol";

const IMAGE_SRC = "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png";

function polyfillDom() {
  const rect = (width = 0, height = 0) => ({
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Element.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Element.prototype.getBoundingClientRect = function () {
    return rect() as DOMRect;
  };
  Range.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function () {
    return rect() as DOMRect;
  };
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;
  (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
  if (!("PointerEvent" in window)) {
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
  }
}

polyfillDom();

let mounted: { root: Root; container: HTMLElement } | null = null;

async function mountEditor(content: PmDoc): Promise<Editor> {
  const editor = new Editor({
    editable: true,
    extensions: createQingagentExtensions({ imageExtension: ImageCM }),
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

function imageDoc(attrs: Partial<Extract<PmDoc["content"][number], { type: "image" }>["attrs"]> = {}): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "image",
      attrs: {
        blockId: "img-1",
        src: IMAGE_SRC,
        alt: "示意图",
        caption: "图 1",
        width: 240,
        height: null,
        align: "right",
        ...attrs,
      },
    }],
  } as PmDoc;
}

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function firstImageAttrs(editor: Editor): Record<string, unknown> {
  const json = editor.getJSON() as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> };
  const image = json.content?.find((node) => node.type === "image");
  return image?.attrs ?? {};
}

describe("ImageView", () => {
  beforeEach(() => {
    polyfillDom();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    mounted = null;
    vi.unstubAllGlobals();
  });

  it("按 align 渲染,对齐按钮会写回 attrs", async () => {
    const editor = await mountEditor(imageDoc());
    try {
      const frame = editor.view.dom.querySelector<HTMLElement>(".pm-image-frame");
      expect(frame).not.toBeNull();
      expect(frame!.style.width).toBe("240px");
      expect(frame!.style.marginLeft).toBe("auto");
      expect(frame!.style.marginRight).toBe("0px");

      const leftButton = editor.view.dom.querySelector<HTMLButtonElement>('button[title="左对齐"]');
      expect(leftButton).not.toBeNull();
      await act(async () => {
        leftButton!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      await flush();

      expect(firstImageAttrs(editor).align).toBe("left");
    } finally {
      await unmount(editor);
    }
  });

  it("拖拽 resize 手柄只在松手后写回 width", async () => {
    const editor = await mountEditor(imageDoc({ align: "center" }));
    try {
      const wrapper = editor.view.dom.querySelector<HTMLElement>(".pm-image");
      wrapper!.getBoundingClientRect = () => ({
        top: 0,
        left: 0,
        right: 520,
        bottom: 260,
        width: 520,
        height: 260,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

      const handle = editor.view.dom.querySelector<HTMLButtonElement>(".pm-image-resize-handle");
      expect(handle).not.toBeNull();
      await act(async () => {
        handle!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100, button: 0, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientX: 180, pointerId: 1 }));
      });
      expect(firstImageAttrs(editor).width).toBe(240);

      await act(async () => {
        window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: 180, pointerId: 1 }));
      });
      await flush();

      expect(firstImageAttrs(editor).width).toBe(320);
    } finally {
      await unmount(editor);
    }
  });

  it("图片工具条是 toolbar 语义且 chrome 不可被选中", async () => {
    const editor = await mountEditor(imageDoc());
    try {
      const toolbar = editor.view.dom.querySelector<HTMLElement>(".pm-image-toolbar.pm-image-chrome");
      expect(toolbar).not.toBeNull();
      expect(toolbar?.getAttribute("role")).toBe("toolbar");
      expect(toolbar?.getAttribute("aria-label")).toBe("图片操作");
      expect(toolbar?.getAttribute("aria-hidden")).toBeNull();
      expect(toolbar?.classList.contains("pm-image-chrome")).toBe(true);
      expect(editor.view.dom.querySelector<HTMLButtonElement>('button[aria-label="全屏查看图片"]')).not.toBeNull();
    } finally {
      await unmount(editor);
    }
  });

  it("上传中图片显示可见占位遮罩和进度", async () => {
    const editor = await mountEditor(imageDoc({ uploading: true, progress: 42, error: false } as never));
    try {
      const overlay = editor.view.dom.querySelector<HTMLElement>(".pm-image-upload-overlay");
      expect(overlay).not.toBeNull();
      expect(overlay?.textContent).toContain("上传中 42%");
    } finally {
      await unmount(editor);
    }
  });

  it("审阅/只读态按 align 和 width 渲染,并提供全屏入口", async () => {
    const snap = pmDocToViewDocumentSnapshot(imageDoc({ align: "right", width: 260 }), 1);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(DocumentSnapshotView, {
          doc: snap,
          editable: false,
          showPatches: false,
          acceptedPatches: new Set<string>(),
          rejectedPatches: new Set<string>(),
        }));
      });
      await flush();

      const figure = container.querySelector<HTMLElement>(".pm-image-readonly");
      expect(figure).not.toBeNull();
      expect(figure!.dataset.align).toBe("right");
      expect(figure!.style.width).toBe("260px");
      expect(figure!.style.marginLeft).toBe("auto");
      expect(container.querySelector<HTMLButtonElement>(".pm-image-fullscreen-btn")).not.toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
