// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import type { Node as PmModelNode } from "@tiptap/pm/model";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateColumnResizeRatios,
  ColumnCM,
  ColumnListCM,
  snapBoundaryRatio,
} from "../../components/ColumnView";

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

function columnPointerEvent(type: string, clientX: number): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    clientX,
  });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: 1 },
    pointerType: { configurable: true, value: "mouse" },
  });
  return event;
}

interface MountedEditor {
  editor: Editor;
  root: Root;
  container: HTMLElement;
}

async function mountEditor(content: PmDoc, editable = true): Promise<MountedEditor> {
  const editor = new Editor({
    editable,
    extensions: createQingagentExtensions({
      columnListExtension: ColumnListCM,
      columnExtension: ColumnCM,
    }),
    content: content as never,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(EditorContent, { editor }));
  });
  await flush();
  return { editor, root, container };
}

async function unmount(mounted: MountedEditor) {
  await act(async () => {
    mounted.root.unmount();
  });
  mounted.container.remove();
  mounted.editor.destroy();
}

async function flush(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

function columnDoc(ratios: [number, number] = [0.3, 0.7]): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "columnList",
        attrs: { blockId: "cl-1" },
        content: [
          {
            type: "column",
            attrs: { blockId: "col-1", widthRatio: ratios[0] },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "p-left" },
                content: [{ type: "text", text: "左栏正文" }],
              },
            ],
          },
          {
            type: "column",
            attrs: { blockId: "col-2", widthRatio: ratios[1] },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "p-right" },
                content: [{ type: "text", text: "右栏正文" }],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as PmDoc;
}

function columnPositions(editor: Editor): Array<{ node: PmModelNode; pos: number }> {
  const positions: Array<{ node: PmModelNode; pos: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "column") positions.push({ node, pos });
    return true;
  });
  return positions;
}

function columnRatios(editor: Editor): number[] {
  return columnPositions(editor).map(({ node }) => Number(node.attrs.widthRatio));
}

describe("分栏 NodeView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("正文是原生 PM contentDOM,column NodeView renderer 挂在 columnList contentDOM 下", async () => {
    const mounted = await mountEditor(columnDoc());
    try {
      const columnList = mounted.container.querySelector<HTMLElement>(".pm-column-list[data-pm-node='columnList']");
      expect(columnList).not.toBeNull();
      const listContent = Array.from(columnList!.children).find((child) =>
        child.classList.contains("pm-column-list-content"),
      ) as HTMLElement | undefined;
      expect(listContent).toBeTruthy();
      const contentDom = listContent!.querySelector<HTMLElement>(":scope > [data-node-view-content-react]");
      expect(contentDom).toBeTruthy();
      const directColumnRenderers = Array.from(contentDom!.children).filter((child) =>
        child.classList.contains("node-column"),
      );
      expect(directColumnRenderers).toHaveLength(2);
      expect(directColumnRenderers.every((child) => child.querySelector(":scope > .pm-column"))).toBe(true);
      expect(listContent!.querySelector(".pm-column-body")?.textContent).toContain("左栏正文");
      expect(listContent!.querySelectorAll(".pm-column-body textarea")).toHaveLength(0);
      expect(listContent!.querySelectorAll(".pm-column-body .ProseMirror")).toHaveLength(0);
    } finally {
      await unmount(mounted);
    }
  });

  it("resize 把手只渲染在编辑态非末列,只读态不渲染 chrome", async () => {
    const mounted = await mountEditor(columnDoc(), true);
    try {
      const columns = Array.from(mounted.container.querySelectorAll<HTMLElement>(".pm-column[data-pm-node='column']"));
      expect(columns).toHaveLength(2);
      expect(columns[0]!.querySelector(".pm-column-resize-handle")).toBeTruthy();
      expect(columns[1]!.querySelector(".pm-column-resize-handle")).toBeNull();
      expect(mounted.container.querySelectorAll(".pm-column-resize-handle")).toHaveLength(1);
    } finally {
      await unmount(mounted);
    }

    const readonly = await mountEditor(columnDoc(), false);
    try {
      expect(readonly.container.querySelectorAll(".pm-column-resize-handle")).toHaveLength(0);
    } finally {
      await unmount(readonly);
    }
  });

  it("resize 计算保持相邻 pair-sum,提交为一个 setNodeMarkup 事务且 undo 一步回退", async () => {
    const next = calculateColumnResizeRatios({
      ratios: [0.3, 0.7],
      index: 0,
      deltaPx: 150,
      availableWidth: 1000,
    });
    expect(next).toEqual([0.45, 0.55]);
    expect(Number((next[0]! + next[1]!).toFixed(4))).toBe(1);

    const clamped = calculateColumnResizeRatios({
      ratios: [0.3, 0.7],
      index: 0,
      deltaPx: 1000,
      availableWidth: 1000,
    });
    expect(clamped).toEqual([0.88, 0.12]);

    const mounted = await mountEditor(columnDoc());
    try {
      const [left, right] = columnPositions(mounted.editor);
      expect(left).toBeTruthy();
      expect(right).toBeTruthy();
      await act(async () => {
        const tr = mounted.editor.state.tr
          .setNodeMarkup(left!.pos, undefined, { ...left!.node.attrs, widthRatio: next[0] })
          .setNodeMarkup(right!.pos, undefined, { ...right!.node.attrs, widthRatio: next[1] });
        mounted.editor.view.dispatch(tr);
      });
      await flush(2);
      expect(columnRatios(mounted.editor)).toEqual([0.45, 0.55]);
      expect(Number(columnRatios(mounted.editor).reduce((sum, ratio) => sum + ratio, 0).toFixed(4))).toBe(1);

      await act(async () => {
        expect(mounted.editor.commands.undo()).toBe(true);
      });
      await flush(2);
      expect(columnRatios(mounted.editor)).toEqual([0.3, 0.7]);
    } finally {
      await unmount(mounted);
    }
  });

  describe("snapBoundaryRatio 松手吸附", () => {
    it("阈值内吸到好看比例(1/2、1/3),范围外的候选不参与", () => {
      // 接近 1/2 → 吸到 0.5
      expect(snapBoundaryRatio(0.515, 1, 0.12)).toBe(0.5);
      // 接近 1/3 → 吸到 0.3333
      expect(snapBoundaryRatio(0.35, 1, 0.12)).toBe(0.3333);
      // pairSum=0.6 时 0.5 超出 [0.12, 0.48] 范围 → 不吸,落整数百分比
      expect(snapBoundaryRatio(0.46, 0.6, 0.12)).toBe(0.46);
    });

    it("都不够近时对齐到整数百分比", () => {
      expect(snapBoundaryRatio(0.444, 1, 0.12)).toBe(0.44);
      expect(snapBoundaryRatio(0.567, 1, 0.12)).toBe(0.57);
    });

    it("拖动预览吸附回原比例时显式回滚 DOM,无需事务也不残留原始比例", async () => {
      const mounted = await mountEditor(columnDoc([0.5, 0.5]));
      try {
        const columns = Array.from(
          mounted.container.querySelectorAll<HTMLElement>(".pm-column[data-pm-node='column']"),
        );
        const handle = columns[0]?.querySelector<HTMLElement>(".pm-column-resize-handle");
        expect(columns).toHaveLength(2);
        expect(handle).not.toBeNull();
        vi.spyOn(columns[0]!.parentElement!, "getBoundingClientRect").mockReturnValue(
          DOMRect.fromRect({ width: 1000 }),
        );
        Object.defineProperties(handle!, {
          setPointerCapture: { configurable: true, value: vi.fn() },
          releasePointerCapture: { configurable: true, value: vi.fn() },
        });

        await act(async () => {
          handle!.dispatchEvent(columnPointerEvent("pointerdown", 0));
          document.dispatchEvent(columnPointerEvent("pointermove", 20));
        });
        expect(columns[0]!.style.flex).toBe("0.52 1 0%");
        expect(columns[1]!.style.flex).toBe("0.48 1 0%");

        await act(async () => {
          document.dispatchEvent(columnPointerEvent("pointerup", 20));
        });
        expect(columnRatios(mounted.editor)).toEqual([0.5, 0.5]);
        expect(columns[0]!.style.flex).toBe("0.5 1 0%");
        expect(columns[1]!.style.flex).toBe("0.5 1 0%");
      } finally {
        await unmount(mounted);
      }
    });
  });
});
