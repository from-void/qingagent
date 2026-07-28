// @vitest-environment jsdom

// 回归:含图表的文档"纯读"(打开→全选→复制)后弹「文档已被更新，请重载」且重载后反复复现。
// 病根不在复制链路:图表块挂载时会把渲染好的 svg 回写进 attrs(供导出),这是文档的一次真实写入;
// 而写入基线曾按【装载侧安全网变换后的正文】计算(mermaid 代码块被升级成图表块),与服务端
// canonical 的 contentHash 永远对不上 → 必冲突,且重载拿回同一份 canonical → 死循环。
// 本测同时守住两条:纯读手势零写入;挂载写入的基线必须等于服务端 canonical 哈希。

import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { getPmContentHash, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { pmDocToViewDocumentSnapshot } from "../../data/protocol";
import type { DocWriteBaseline } from "../../data/docWriteBaseline";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => ({
      svg: `<svg data-mmd="1" data-src="${encodeURIComponent(source)}"><text>标签</text></svg>`,
    })),
  },
}));
vi.mock("../../components/drawioEditorLauncher", () => ({
  openDrawioEditor: vi.fn(async () => null),
}));

import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";

function polyfillLayout() {
  const empty = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class DOMMatrixReadOnlyStub {
    m22 = 1;
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
  (window as unknown as { DOMMatrixReadOnly: typeof DOMMatrixReadOnlyStub }).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
  (globalThis as unknown as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame ??=
    ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0)) as typeof requestAnimationFrame;
  (globalThis as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame ??=
    ((id: number) => window.clearTimeout(id)) as typeof cancelAnimationFrame;
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
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 服务端 canonical:一个仍以 mermaid 代码块形态存着的图表(装载侧会升级成图表块)。
function canonicalDocWithMermaidCodeBlock(): PmDoc {
  return normalizePmDoc({
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      { type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "正文一段" }] },
      {
        type: "codeBlock",
        attrs: { blockId: "c-1", language: "mermaid" },
        content: [{ type: "text", text: "flowchart TD\n  A[开始] --> B[结束]" }],
      },
    ],
  } as unknown as PmDoc);
}

async function flush(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("含图表文档的写入基线", () => {
  it("挂载写入按服务端 canonical 记基线,纯读手势(全选/复制)不再产生写入", async () => {
    const canonical = canonicalDocWithMermaidCodeBlock();
    const canonicalHash = getPmContentHash(canonical);
    const snapshot = pmDocToViewDocumentSnapshot(canonical, 7);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const baselines: Array<DocWriteBaseline | undefined> = [];
    const onEditorChange = vi.fn((_doc: PmDoc, baseline?: DocWriteBaseline) => {
      baselines.push(baseline);
    });
    let editor: Editor | null = null;

    try {
      await act(async () => {
        root.render(createElement(DocumentSnapshotView, {
          doc: snapshot,
          docId: "doc-conflict-loop",
          editable: true,
          showPatches: false,
          acceptedPatches: new Set<string>(),
          rejectedPatches: new Set<string>(),
          onEditorChange,
          onEditorReady: (next: Editor | null) => {
            editor = next;
          },
        } as never));
      });
      await flush(800);

      // 图表块补写 attrs.svg 是文档的真实写入;基线必须对齐服务端 canonical,否则必冲突。
      expect(baselines.length).toBeGreaterThan(0);
      for (const baseline of baselines) {
        expect(baseline?.expectedDocumentSnapshot).toBe(7);
        expect(baseline?.baseContentHash).toBe(canonicalHash);
      }

      baselines.length = 0;
      onEditorChange.mockClear();
      await act(async () => {
        editor!.commands.selectAll();
      });
      await flush(200);
      await act(async () => {
        editor!.view.dom.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
      });
      await flush(800);
      expect(onEditorChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
