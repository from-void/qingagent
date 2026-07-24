// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent } from "@tiptap/react";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { DEFAULT_DRAWIO_SOURCE, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pmDocToViewDocumentSnapshot } from "../../data/protocol";

// mermaid 在 jsdom 里无法真渲染(缺 getBBox 等 SVG 测量),用确定性桩替身:
// render(id, source) → 回一个可识别 svg。这样测的是【我们的接缝】(diagram 节点 →
// DiagramComponent 挂载 → 调 renderMermaid → 注入 svg DOM + 回写 node.attrs.svg),
// 真 mermaid 库本身的渲染是它自己久经考验的事,不在本测范围。
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => ({
      svg: `<svg data-mmd="1" data-src="${encodeURIComponent(source)}"><g/></svg>`,
    })),
  },
}));

vi.mock("../../components/drawioEditorLauncher", () => ({
  openDrawioEditor: vi.fn(async () => null),
}));

// DiagramCM 依赖样式文件;jsdom 下 import css 由 vitest 处理为空。
import { DiagramCM } from "../../components/DiagramView";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";
import { openDrawioEditor } from "../../components/drawioEditorLauncher";

const graphDiagramCss = readFileSync(path.join(process.cwd(), "src/pages/workspace/components/diagram/graphDiagram.css"), "utf8");
const diagramViewCss = readFileSync(path.join(process.cwd(), "src/pages/workspace/components/DiagramView.css"), "utf8");

// jsdom 不实现布局测量;ProseMirror 在 focus/scrollIntoView 时会调
// getClientRects/getBoundingClientRect,缺失会抛 unhandled error。补空实现。
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
  const raf = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
  const caf = (id: number) => window.clearTimeout(id);
  (globalThis as unknown as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame ??= raf as typeof requestAnimationFrame;
  (globalThis as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame ??= caf as typeof cancelAnimationFrame;
  if (!Element.prototype.getClientRects || Element.prototype.getClientRects.toString().includes("not")) {
    // noop
  }
  Element.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Element.prototype.getBoundingClientRect = empty as unknown as () => DOMRect;
  Range.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = empty as unknown as () => DOMRect;
  // ProseMirror 的 mousedown 处理会调 document.elementFromPoint(jsdom 没有)。
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;
  (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
}
polyfillLayout();

// React NodeView 的 portal 只有当 editor 被 React 的 <EditorContent> 托管
// (editor.contentComponent 被设置)时才会真正渲染到 DOM。所以必须用 react-dom
// 真挂载 EditorContent,而不是裸 new Editor()。
let mounted: { root: Root; container: HTMLElement } | null = null;

async function mountEditor(content: PmDoc, editable = true): Promise<Editor> {
  const editor = new Editor({
    editable,
    extensions: createQingagentExtensions({ diagramExtension: DiagramCM }),
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

function diagramDoc(source: string, svg: string | null = null): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      { type: "diagram", attrs: { blockId: "d-1", lang: "mermaid", source, svg } },
    ],
  } as unknown as PmDoc;
}

function drawioDoc(svg: string | null = null): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "diagram",
        attrs: {
          blockId: "drawio-1",
          lang: "drawio",
          source: DEFAULT_DRAWIO_SOURCE,
          svg,
        },
      },
    ],
  } as unknown as PmDoc;
}

function linkDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "p-link" },
      content: [{
        type: "text",
        text: "官网",
        marks: [{ type: "link", attrs: { href: "https://example.com" } }],
      }],
    }],
  } as unknown as PmDoc;
}

function paragraphDoc(text = "正文"): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "p-handle" },
      content: [{ type: "text", text }],
    }],
  } as unknown as PmDoc;
}

function listDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "bulletList",
        attrs: { blockId: "list-handle" },
        content: [
          {
            type: "listItem",
            attrs: { blockId: "li-handle" },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "p-li-handle" },
                content: [{ type: "text", text: "列表项" }],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as PmDoc;
}

function columnDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "columnList",
      attrs: { blockId: "columns-readonly" },
      content: [
        {
          type: "column",
          attrs: { blockId: "column-readonly-left", widthRatio: 0.3 },
          content: [{
            type: "paragraph",
            attrs: { blockId: "column-readonly-left-p" },
            content: [{ type: "text", text: "左栏只读" }],
          }],
        },
        {
          type: "column",
          attrs: { blockId: "column-readonly-right", widthRatio: 0.7 },
          content: [{
            type: "paragraph",
            attrs: { blockId: "column-readonly-right-p" },
            content: [{ type: "text", text: "右栏只读" }],
          }],
        },
      ],
    }],
  } as unknown as PmDoc;
}

// 等 React NodeView 挂载 + renderMermaid 异步 promise 落地(包在 act 里避免漏提交)。
async function flush(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

async function waitForSelector(selector: string, root: ParentNode = document.body): Promise<Element> {
  for (let i = 0; i < 30; i += 1) {
    const el = root.querySelector(selector);
    if (el) return el;
    await flush(1);
  }
  throw new Error(`selector not found: ${selector}`);
}

function firstDiagramAttrs(editor: Editor): { lang: string; source: string; svg: string | null } | null {
  const doc = editor.getJSON() as {
    content?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  };
  const block = doc.content?.find((node) => node.type === "diagram");
  if (!block?.attrs) return null;
  return {
    lang: String(block.attrs.lang ?? ""),
    source: String(block.attrs.source ?? ""),
    svg: typeof block.attrs.svg === "string" ? block.attrs.svg : null,
  };
}

function diagramAttrsFromDoc(doc: PmDoc): Record<string, unknown> | null {
  const block = doc.content.find((node) => node.type === "diagram");
  return block?.type === "diagram" ? block.attrs as unknown as Record<string, unknown> : null;
}

function updateFirstDiagramAttrs(editor: Editor, attrs: Record<string, unknown>): void {
  editor.commands.command(({ tr }) => {
    let diagramPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (diagramPos < 0 && node.type.name === "diagram") {
        diagramPos = pos;
        return false;
      }
      return true;
    });
    if (diagramPos < 0) return false;
    const node = editor.state.doc.nodeAt(diagramPos);
    if (!node) return false;
    tr.setNodeMarkup(diagramPos, undefined, { ...node.attrs, ...attrs });
    return true;
  });
}

async function waitForFirstDiagramSvg(editor: Editor): Promise<{ source: string; svg: string | null } | null> {
  for (let i = 0; i < 20; i++) {
    const attrs = firstDiagramAttrs(editor);
    if (attrs?.svg) return attrs;
    await flush(1);
  }
  return firstDiagramAttrs(editor);
}

describe("diagram 节点视图(mermaid 渲染接缝)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(openDrawioEditor).mockResolvedValue(null);
  });
  afterEach(() => {
    document.body.innerHTML = "";
    mounted = null;
  });

  it("含 diagram 节点的文档会挂载 NodeView 并把 mermaid 源码渲染成 svg 注入 DOM", async () => {
    const source = "sequenceDiagram\n  A->>B: 你好";
    const editor = await mountEditor(diagramDoc(source));
    try {
      const root = editor.view.dom.querySelector("[data-pm-node='diagram']");
      expect(root).not.toBeNull();
      const svgHost = editor.view.dom.querySelector(".pm-diagram-svg svg");
      expect(svgHost).not.toBeNull();
      // 桩 svg 里回填了我们传进去的源码,证明 source 真的流到了 mermaid.render。
      expect(svgHost!.getAttribute("data-src")).toBe(encodeURIComponent(source));
    } finally {
      await unmount(editor);
    }
  });

  it("R2-04 只读快照无缓存 svg 时也渲染 Mermaid 图，而不是停留在源码块", async () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    const snap = pmDocToViewDocumentSnapshot(diagramDoc(source, null), 1);
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

      const svgHost = container.querySelector(".pm-diagram-svg svg");
      expect(svgHost).not.toBeNull();
      expect(svgHost!.getAttribute("data-src")).toBe(encodeURIComponent(source));
      expect(container.querySelector(".pm-diagram-code")).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("只读快照按 widthRatio 渲染 columnList,且列内文本不丢", async () => {
    const snap = pmDocToViewDocumentSnapshot(columnDoc(), 1);
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

      const columnList = container.querySelector<HTMLElement>(".pm-column-list[data-pm-node='columnList']");
      const columns = Array.from(container.querySelectorAll<HTMLElement>(".pm-column[data-pm-node='column']"));
      expect(columnList).not.toBeNull();
      expect(columnList?.style.display).toBe("flex");
      expect(columns).toHaveLength(2);
      expect(columns[0]?.style.flexBasis).toBe("30%");
      expect(columns[1]?.style.flexBasis).toBe("70%");
      expect(columns[0]?.textContent).toContain("左栏只读");
      expect(columns[1]?.textContent).toContain("右栏只读");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("渲染出的 svg 会回写进 node.attrs.svg(导出 PDF/Word 走这条缓存)", async () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    const editor = await mountEditor(diagramDoc(source, null));
    try {
      const attrs = await waitForFirstDiagramSvg(editor);
      expect(attrs).not.toBeNull();
      expect(attrs!.svg).toContain('data-mmd="1"');
      expect(attrs!.svg).toContain(encodeURIComponent(source));
    } finally {
      await unmount(editor);
    }
  });

  it("只读生成态已渲染的 drawio 在转为可编辑后会补写 SVG 导出缓存", async () => {
    const editor = await mountEditor(drawioDoc(), false);
    try {
      await waitForSelector(".pm-diagram-svg svg", editor.view.dom);
      expect(firstDiagramAttrs(editor)?.svg).toBeNull();

      await act(async () => {
        editor.setEditable(true);
      });

      const attrs = await waitForFirstDiagramSvg(editor);
      expect(attrs?.svg).toMatch(/^<svg\b/);
      expect(normalizePmDoc(editor.getJSON()).content[0]).toMatchObject({
        type: "diagram",
        attrs: { lang: "drawio", svg: expect.stringMatching(/^<svg\b/) },
      });
    } finally {
      await unmount(editor);
    }
  });

  it("用户拖拽改的高度持久化进 node.attrs.height,刷新(序列化往返)不丢", async () => {
    // 回归:diagram 之前没有 height 属性,resize:vertical 只改 DOM 内联 style,不落 attrs → 刷新就恢复。
    const editor = await mountEditor(diagramDoc("graph TD;A-->B;", null));
    try {
      // 模拟用户拖拽后的持久化:写入 height attr
      let diagramPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "diagram") diagramPos = pos;
        return true;
      });
      expect(diagramPos).toBeGreaterThanOrEqual(0);
      editor.commands.command(({ tr }) => {
        tr.setNodeMarkup(diagramPos, undefined, {
          ...editor.state.doc.nodeAt(diagramPos)!.attrs,
          height: 360,
        });
        return true;
      });
      // getJSON(=持久化形态)带上 height
      const json = editor.getJSON() as { content?: { type: string; attrs?: { height?: number } }[] };
      const diagram = json.content?.find((n) => n.type === "diagram");
      expect(diagram?.attrs?.height).toBe(360);
    } finally {
      await unmount(editor);
    }
  });

  it("diagram source/overlay attrs 编辑会进入 debounced 文档保存链路", async () => {
    const source = "flowchart TD\n  A[开始] --> B[结束]\n";
    const snap = pmDocToViewDocumentSnapshot(diagramDoc(source, null), 1);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onEditorChange = vi.fn();
    let editor: Editor | null = null;

    try {
      await act(async () => {
        root.render(createElement(DocumentSnapshotView, {
          doc: snap,
          docId: "doc-diagram-save",
          editable: true,
          showPatches: false,
          acceptedPatches: new Set<string>(),
          rejectedPatches: new Set<string>(),
          onEditorChange,
          onEditorReady: (next: Editor | null) => {
            editor = next;
          },
        }));
      });
      await flush();
      onEditorChange.mockClear();
      expect(editor).not.toBeNull();

      await act(async () => {
        updateFirstDiagramAttrs(editor!, {
          source: "flowchart TD\n  A[开始] --> B[结束]\n  C[新节点]\n",
          svg: null,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
      });

      const sourceSave = onEditorChange.mock.calls
        .map(([doc]) => doc as PmDoc)
        .find((doc) => String(diagramAttrsFromDoc(doc)?.source ?? "").includes("新节点"));
      expect(sourceSave).toBeDefined();
      onEditorChange.mockClear();

      await act(async () => {
        updateFirstDiagramAttrs(editor!, {
          overlay: { styles: { A: { fill: "#efe3cc" } } },
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
      });

      const overlaySave = onEditorChange.mock.calls
        .map(([doc]) => doc as PmDoc)
        .find((doc) => {
          const overlay = diagramAttrsFromDoc(doc)?.overlay as { styles?: Record<string, unknown> } | undefined;
          return Boolean(overlay?.styles?.A);
        });
      expect(overlaySave).toBeDefined();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("R2-05 编辑态普通点击链接只弹气泡，Ctrl/Cmd 点击才打开", async () => {
    const snap = pmDocToViewDocumentSnapshot(linkDoc(), 1);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    try {
      await act(async () => {
        root.render(createElement(DocumentSnapshotView, {
          doc: snap,
          editable: true,
          showPatches: false,
          acceptedPatches: new Set<string>(),
          rejectedPatches: new Set<string>(),
        }));
      });
      await flush();

      const anchor = container.querySelector<HTMLAnchorElement>('a[href="https://example.com"]');
      expect(anchor).not.toBeNull();

      let allowed = true;
      await act(async () => {
        allowed = anchor!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(allowed).toBe(false);
      expect(openSpy).not.toHaveBeenCalled();
      expect(container.querySelector(".link-hover-card")).not.toBeNull();

      await act(async () => {
        anchor!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
      });
      expect(openSpy).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    } finally {
      openSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("R4-012 块手柄可键盘唤起并补齐菜单语义", async () => {
    const snap = pmDocToViewDocumentSnapshot(paragraphDoc(), 1);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    try {
      await act(async () => {
        root.render(createElement(DocumentSnapshotView, {
          doc: snap,
          editable: true,
          showPatches: false,
          acceptedPatches: new Set<string>(),
          rejectedPatches: new Set<string>(),
        }));
      });
      await flush();

      const editorDom = container.querySelector<HTMLElement>(".ProseMirror");
      const paragraph = editorDom?.querySelector<HTMLElement>("p");
      expect(editorDom).not.toBeNull();
      expect(paragraph).not.toBeNull();
      editorDom!.getBoundingClientRect = () => ({
        top: 10,
        left: 20,
        right: 820,
        bottom: 610,
        width: 800,
        height: 600,
        x: 20,
        y: 10,
        toJSON: () => ({}),
      }) as DOMRect;
      paragraph!.getBoundingClientRect = () => ({
        top: 40,
        left: 84,
        right: 300,
        bottom: 64,
        width: 216,
        height: 24,
        x: 84,
        y: 40,
        toJSON: () => ({}),
      }) as DOMRect;

      await act(async () => {
        editorDom!.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }));
      });
      await flush();

      const button = container.querySelector<HTMLButtonElement>(".block-handle-btn");
      expect(button?.getAttribute("aria-label")).toBe("块操作菜单(转换格式 / 插入)");
      expect(button?.getAttribute("aria-haspopup")).toBe("menu");
      expect(button?.getAttribute("aria-expanded")).toBe("true");
      const menu = container.querySelector(".block-handle-menu");
      expect(menu?.getAttribute("role")).toBe("menu");
      const items = menu?.querySelectorAll('[role="menuitem"]') ?? [];
      expect(items.length).toBeGreaterThan(0);
      expect(document.activeElement).toBe(items[0]);
    } finally {
      rafSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("列表行手柄渲染圆角拖拽点,点击不打开块菜单", async () => {
    const snap = pmDocToViewDocumentSnapshot(listDoc(), 1);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(DocumentSnapshotView, {
          doc: snap,
          editable: true,
          showPatches: false,
          acceptedPatches: new Set<string>(),
          rejectedPatches: new Set<string>(),
        }));
      });
      await flush();

      const editorDom = container.querySelector<HTMLElement>(".ProseMirror");
      const item = editorDom?.querySelector<HTMLElement>('li[data-block-id="li-handle"]');
      const paragraph = item?.querySelector<HTMLElement>("p");
      expect(editorDom).not.toBeNull();
      expect(item).not.toBeNull();
      expect(paragraph).not.toBeNull();

      editorDom!.getBoundingClientRect = () => ({
        top: 10,
        left: 20,
        right: 820,
        bottom: 610,
        width: 800,
        height: 600,
        x: 20,
        y: 10,
        toJSON: () => ({}),
      }) as DOMRect;
      item!.getBoundingClientRect = () => ({
        top: 40,
        left: 76,
        right: 300,
        bottom: 64,
        width: 224,
        height: 24,
        x: 76,
        y: 40,
        toJSON: () => ({}),
      }) as DOMRect;
      paragraph!.getBoundingClientRect = () => ({
        top: 40,
        left: 100,
        right: 300,
        bottom: 64,
        width: 200,
        height: 24,
        x: 100,
        y: 40,
        toJSON: () => ({}),
      }) as DOMRect;

      await act(async () => {
        item!.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true,
          cancelable: true,
          clientX: 104,
          clientY: 48,
        }));
      });
      await flush();

      const button = container.querySelector<HTMLButtonElement>(".block-handle-btn");
      // 飞书式 chip:左侧格式图标(无序列表用 .bh-type-svg) + 右侧六点抓手(.bh-grip)
      expect(button?.classList.contains("is-chip")).toBe(true);
      expect(button?.classList.contains("is-plus")).toBe(false);
      expect(button?.getAttribute("aria-label")).toBe("拖拽列表行");
      expect(button?.hasAttribute("aria-haspopup")).toBe(false);
      expect(button?.getAttribute("style") ?? "").not.toContain("width");

      // 无序列表行手柄:格式图标是列表 svg(.bh-type-svg)
      expect(button?.querySelector(".bh-type .bh-type-svg")).not.toBeNull();
      // 抓手是六点
      const grip = button?.querySelector<SVGSVGElement>("svg.bh-grip");
      const dots = grip?.querySelectorAll("circle") ?? [];
      expect(dots).toHaveLength(6);
      expect(grip?.getAttribute("viewBox")).toBe("0 0 7 13");

      await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(container.querySelector(".block-handle-menu")).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("已有缓存 svg 时优先复用、不重复调用 mermaid.render", async () => {
    const mermaid = (await import("mermaid")).default;
    const source = 'pie\n  "A": 1\n  "B": 2';
    const cached = '<svg data-cached="1"></svg>';
    const editor = await mountEditor(diagramDoc(source, cached));
    try {
      const svgHost = editor.view.dom.querySelector(".pm-diagram-svg svg");
      expect(svgHost).not.toBeNull();
      expect(svgHost!.getAttribute("data-cached")).toBe("1");
      expect(mermaid.render as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    } finally {
      await unmount(editor);
    }
  });

  it("insertDiagram 命令能在文档里插入一个 diagram 块", async () => {
    const editor = await mountEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "正文" }] }],
    } as unknown as PmDoc);
    try {
      await act(async () => {
        editor.chain().focus().insertDiagram().run();
      });
      await flush();
      const attrs = firstDiagramAttrs(editor);
      expect(attrs).not.toBeNull();
      expect(attrs!.source).toContain("flowchart TD");
      expect(editor.view.dom.querySelector(".graph-diagram")).not.toBeNull();
    } finally {
      await unmount(editor);
    }
  });

  it("insertDiagram(drawio) 插入最小 XML，离线渲染并可反复编辑源码", async () => {
    const editor = await mountEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "正文" }] }],
    } as unknown as PmDoc);
    try {
      await act(async () => {
        editor.chain().focus().insertDiagram({ lang: "drawio" }).run();
      });
      const rendered = await waitForSelector(".pm-diagram-svg svg", editor.view.dom);
      const inserted = firstDiagramAttrs(editor);
      expect(inserted).toMatchObject({ lang: "drawio", source: DEFAULT_DRAWIO_SOURCE });
      expect(rendered.outerHTML).not.toMatch(/foreignObject|script|onload/i);

      const buttons = Array.from(
        editor.view.dom.querySelectorAll<HTMLButtonElement>(".pm-diagram-view-actions button"),
      ).map((button) => button.textContent?.trim());
      expect(buttons).toEqual(["可视化编辑", "编辑 drawio XML"]);
      const editButton = Array.from(
        editor.view.dom.querySelectorAll<HTMLButtonElement>(".pm-diagram-view-actions button"),
      ).find((button) => button.textContent?.trim() === "编辑 drawio XML")!;
      await act(async () => {
        editButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      const textarea = await waitForSelector(".pm-diagram-source", editor.view.dom) as HTMLTextAreaElement;
      const nextSource = textarea.value.replace('value="开始"', 'value="入口"');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      await act(async () => {
        setter?.call(textarea, nextSource);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const complete = Array.from(editor.view.dom.querySelectorAll<HTMLButtonElement>(".pm-diagram-actions button"))
        .find((button) => button.textContent?.trim() === "完成")!;
      await act(async () => {
        complete.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      await flush(20);
      expect(firstDiagramAttrs(editor)?.source).toContain('value="入口"');
      expect(firstDiagramAttrs(editor)?.svg).toMatch(/^<svg\b/);
      const persisted = normalizePmDoc(editor.getJSON());
      const persistedBlock = persisted.content.find((block) => block.type === "diagram");
      expect(persistedBlock?.type === "diagram" ? persistedBlock.attrs.svg : null).toMatch(/^<svg\b/);
    } finally {
      await unmount(editor);
    }
  });

  it("drawio 可视化编辑保存才通过节点更新链回写 source+svg，取消不改文档", async () => {
    const editor = await mountEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "正文" }] }],
    } as unknown as PmDoc);
    try {
      await act(async () => {
        editor.chain().focus().insertDiagram({ lang: "drawio" }).run();
      });
      await waitForSelector(".pm-diagram-svg svg", editor.view.dom);
      const nextSource = DEFAULT_DRAWIO_SOURCE.replace('value="开始"', 'value="画布保存"');
      const nextSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>画布保存</text></svg>';
      vi.mocked(openDrawioEditor).mockResolvedValueOnce({ source: nextSource, svg: nextSvg });

      const visualButton = Array.from(
        editor.view.dom.querySelectorAll<HTMLButtonElement>(".pm-diagram-view-actions button"),
      ).find((button) => button.textContent?.trim() === "可视化编辑");
      expect(visualButton).not.toBeNull();
      await act(async () => visualButton?.click());
      await flush(4);
      expect(openDrawioEditor).toHaveBeenCalledWith(DEFAULT_DRAWIO_SOURCE, "drawio 图编辑");
      expect(firstDiagramAttrs(editor)).toMatchObject({ source: nextSource, svg: nextSvg });

      vi.mocked(openDrawioEditor).mockResolvedValueOnce(null);
      await act(async () => visualButton?.click());
      await flush(4);
      expect(firstDiagramAttrs(editor)).toMatchObject({ source: nextSource, svg: nextSvg });
    } finally {
      await unmount(editor);
    }
  });

  it("flowchart 外层双击进入可视化全屏,右上角同时提供可视化编辑和 Mermaid 源码编辑", async () => {
    const editor = await mountEditor(diagramDoc(`flowchart TD
  A[开始] --> B[结束]
`));
    try {
      const diagramView = await waitForSelector(".pm-diagram-view", editor.view.dom) as HTMLElement;
      const buttons = Array.from(editor.view.dom.querySelectorAll<HTMLButtonElement>(".pm-diagram-view-actions button")).map((button) => button.textContent?.trim());
      expect(buttons).toEqual(["可视化编辑", "编辑 Mermaid"]);
      expect(diagramViewCss).toMatch(/\.pm-diagram-view-actions\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
      expect(diagramViewCss).toContain(".pm-diagram-view:hover .pm-diagram-view-actions");

      await act(async () => {
        diagramView.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
      await flush(20);
      expect(document.body.querySelector(".graph-diagram-editor")).not.toBeNull();
      expect(editor.view.dom.querySelector(".pm-diagram-source")).toBeNull();
      expect(graphDiagramCss).toMatch(/\.graph-diagram-editor\s*\{[^}]*z-index:\s*2147483000;[^}]*pointer-events:\s*auto;/s);
      expect(graphDiagramCss).toMatch(/\.graph-diagram-editor\s*\{[^}]*background:\s*rgba\(246,\s*241,\s*231,\s*0\.98\);/s);

      const doneButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".graph-diagram-editor button"))
        .find((button) => button.textContent?.trim() === "完成");
      expect(doneButton).not.toBeNull();
      await act(async () => {
        doneButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flush(4);
      expect(document.body.querySelector(".graph-diagram-editor")).toBeNull();
      expect(document.body.querySelector(".graph-diagram-editor .react-flow__pane")).toBeNull();

      const visualButton = Array.from(editor.view.dom.querySelectorAll<HTMLButtonElement>(".pm-diagram-view-actions button"))
        .find((button) => button.textContent?.trim() === "可视化编辑");
      expect(visualButton).not.toBeNull();
      await act(async () => {
        visualButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flush(20);
      expect(document.body.querySelectorAll(".graph-diagram-editor")).toHaveLength(1);
    } finally {
      await unmount(editor);
    }
  });

  it("单击图内部会选中整个 diagram 块,不是只响应深色边缘", async () => {
    const editor = await mountEditor(diagramDoc(`flowchart TD
  A[开始] --> B[结束]
`));
    try {
      const graph = await waitForSelector(".graph-diagram", editor.view.dom) as HTMLElement;
      await act(async () => {
        graph.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      });
      await flush(20);
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      const selectedNode = editor.state.selection instanceof NodeSelection ? editor.state.selection.node : null;
      expect(selectedNode?.type.name).toBe("diagram");
      expect(editor.view.dom.querySelector(".pm-diagram.is-selected")).not.toBeNull();
    } finally {
      await unmount(editor);
    }
  });

  it("冷双击未选中的图表只选中、不进编辑;块已选中后再双击才进编辑(防快速点击误触)", async () => {
    // 段落 + 图表:把选区放在段落,确保图表初始未选中(diagram-only 文档会默认选中图表块)。
    const editor = await mountEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        { type: "paragraph", attrs: { blockId: "p-0" }, content: [{ type: "text", text: "前导" }] },
        { type: "diagram", attrs: { blockId: "d-1", lang: "mermaid", source: "flowchart TD\n  A[开始] --> B[结束]\n", svg: null } },
      ],
    } as unknown as PmDoc);
    try {
      const graph = await waitForSelector(".graph-diagram", editor.view.dom) as HTMLElement;
      const diagramView = editor.view.dom.querySelector<HTMLElement>(".pm-diagram-view")!;
      await act(async () => {
        editor.chain().setTextSelection(1).run();
      });
      await flush(8);
      expect(editor.view.dom.querySelector(".pm-diagram.is-selected")).toBeNull();
      // 冷双击:浏览器里 dblclick 之前必有 click;首击(detail:1)先选中块。
      await act(async () => {
        graph.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      });
      await flush(8);
      expect(editor.view.dom.querySelector(".pm-diagram.is-selected")).not.toBeNull();
      // 紧随的 dblclick 不应进编辑(只是来选中的)。
      await act(async () => {
        diagramView.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
      await flush(20);
      expect(document.body.querySelector(".graph-diagram-editor")).toBeNull();
      expect(editor.view.dom.querySelector(".pm-diagram-source")).toBeNull();
      // 块已选中后再双击(此次 click 不再改选区 → 不置 justSelected)→ 进编辑。
      await act(async () => {
        diagramView.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
      await flush(20);
      expect(document.body.querySelector(".graph-diagram-editor")).not.toBeNull();
    } finally {
      await unmount(editor);
    }
  });

  it("预览态右上角统一工具栏:对齐(左中右)+缩放/全屏齐全,点对齐回写 node.attrs.align", async () => {
    const editor = await mountEditor(diagramDoc(`flowchart TD
  A[开始] --> B[结束]
`));
    try {
      await waitForSelector(".graph-diagram", editor.view.dom);
      const viewbar = await waitForSelector(".graph-diagram-viewbar", editor.view.dom) as HTMLElement;
      const labels = Array.from(viewbar.querySelectorAll<HTMLButtonElement>(".pm-diagram-tool")).map((b) => b.textContent?.trim());
      // 对齐 左/中/右 + 缩小/放大 + 全屏 都在(无「适应」按钮)
      expect(labels).toEqual(expect.arrayContaining(["左", "中", "右", "−", "＋", "⛶ 全屏"]));
      expect(labels).not.toContain("⤢");
      const rightBtn = Array.from(viewbar.querySelectorAll<HTMLButtonElement>(".pm-diagram-tool")).find((b) => b.textContent?.trim() === "右")!;
      await act(async () => {
        rightBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      await flush(8);
      const json = editor.getJSON() as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> };
      expect(json.content?.find((n) => n.type === "diagram")?.attrs?.align).toBe("right");
      expect(editor.view.dom.querySelector('.pm-diagram[data-align="right"]')).not.toBeNull();
    } finally {
      await unmount(editor);
    }
  });

  it("选中图表按 Enter:图表后插入空段、光标落在新段(不跳文末、不删图表)", async () => {
    const editor = await mountEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        { type: "paragraph", attrs: { blockId: "p-0" }, content: [{ type: "text", text: "前导" }] },
        { type: "diagram", attrs: { blockId: "d-1", lang: "mermaid", source: "flowchart TD\n  A-->B\n", svg: null } },
      ],
    } as unknown as PmDoc);
    try {
      await waitForSelector(".pm-diagram", editor.view.dom);
      let diagPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "diagram") diagPos = pos;
        return true;
      });
      expect(diagPos).toBeGreaterThanOrEqual(0);
      const childrenBefore = editor.state.doc.childCount;
      await act(async () => {
        editor.commands.setNodeSelection(diagPos);
      });
      expect(editor.state.selection instanceof NodeSelection).toBe(true);
      // 触发 Enter 键映射(经 handleKeyDown,jsdom 下比 dispatchEvent 可靠)
      await act(async () => {
        editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "Enter" })));
      });
      await flush(8);
      // 图表仍在,且其后多了一个段落
      expect(editor.state.doc.childCount).toBe(childrenBefore + 1);
      const json = editor.getJSON() as { content?: Array<{ type?: string }> };
      expect((json.content ?? []).some((n) => n.type === "diagram")).toBe(true);
      // 光标是文本选区、落在图表之后的段落里(不是整块选中、不在文末更远处)
      const sel = editor.state.selection;
      expect(sel instanceof NodeSelection).toBe(false);
      expect(sel.$from.parent.type.name).toBe("paragraph");
      expect(sel.$from.pos).toBeGreaterThan(diagPos);
    } finally {
      await unmount(editor);
    }
  });

  it("SVG 图表(时序图/饼图等)同样有右上角统一工具栏:对齐+缩放+全屏,点对齐回写 align", async () => {
    // 提供 cachedSvg 让 MermaidPreview 直接渲染(不走 mermaid 异步),source 检测为非图(时序图)→ SVG 路径。
    const editor = await mountEditor(
      diagramDoc("sequenceDiagram\n  A->>B: hi\n", "<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='40'/></svg>"),
    );
    try {
      const viewbar = await waitForSelector(".pm-diagram-svg-viewbar", editor.view.dom) as HTMLElement;
      const labels = Array.from(viewbar.querySelectorAll<HTMLButtonElement>(".pm-diagram-tool")).map((b) => b.textContent?.trim());
      expect(labels).toEqual(expect.arrayContaining(["左", "中", "右", "−", "＋", "⛶ 全屏"]));
      expect(labels).not.toContain("⤢");
      const leftBtn = Array.from(viewbar.querySelectorAll<HTMLButtonElement>(".pm-diagram-tool")).find((b) => b.textContent?.trim() === "左")!;
      await act(async () => {
        leftBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      await flush(8);
      const json = editor.getJSON() as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> };
      expect(json.content?.find((n) => n.type === "diagram")?.attrs?.align).toBe("left");
    } finally {
      await unmount(editor);
    }
  });

  it("SVG 图表放大后拖拽:pointerup 置空 dragRef 后批量 setT 不解引用 null(防整页崩溃回归)", async () => {
    // 复现「放大两下往左拖拽整页崩到 ErrorBoundary」:旧实现里 onPointerMove 的 setT updater
    // 内联读 dragRef.current!.ox,而同一批次的 pointerup 已把 dragRef 置空 → updater flush 时 NPE。
    const editor = await mountEditor(
      diagramDoc("sequenceDiagram\n  A->>B: hi\n", "<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='40'/></svg>"),
    );
    try {
      const box = (await waitForSelector(".pm-diagram-svg", editor.view.dom)) as HTMLElement;
      const viewbar = (await waitForSelector(".pm-diagram-svg-viewbar", editor.view.dom)) as HTMLElement;
      const plus = Array.from(viewbar.querySelectorAll<HTMLButtonElement>(".pm-diagram-tool")).find(
        (b) => b.textContent?.trim() === "＋",
      )!;
      // 放大两次:scale>1 才进入拖拽平移路径。
      await act(async () => {
        plus.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        plus.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      await flush(8);
      // jsdom 没有 PointerEvent;用 MouseEvent 冒充对应类型即可(React 按事件 type 分发,
      // 处理器只读 button/buttons/clientX;pointerId 缺失会让 setPointerCapture 抛 → 已被 try/catch 吞)。
      const pe = (type: string, x: number) =>
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: 120,
        });
      // 同一 act 批次:pointerdown → 多次 pointermove → pointerup(置空 dragRef)。
      await act(async () => {
        box.dispatchEvent(pe("pointerdown", 200));
        box.dispatchEvent(pe("pointermove", 180));
        box.dispatchEvent(pe("pointermove", 150));
        box.dispatchEvent(pe("pointerup", 120));
      });
      await flush(8);
      // 没崩:容器与工具栏都还在。
      expect(editor.view.dom.querySelector(".pm-diagram-svg")).not.toBeNull();
      expect(editor.view.dom.querySelector(".pm-diagram-svg-viewbar")).not.toBeNull();
    } finally {
      await unmount(editor);
    }
  });

  it("SVG 工具栏按钮上双击不进入 Mermaid 源码编辑(防误触回归)", async () => {
    const editor = await mountEditor(
      diagramDoc("sequenceDiagram\n  A->>B: hi\n", "<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='40'/></svg>"),
    );
    try {
      const viewbar = (await waitForSelector(".pm-diagram-svg-viewbar", editor.view.dom)) as HTMLElement;
      const plus = Array.from(viewbar.querySelectorAll<HTMLButtonElement>(".pm-diagram-tool")).find(
        (b) => b.textContent?.trim() === "＋",
      )!;
      // 在工具栏按钮上双击:不应冒泡触发图表块的双击进编辑。
      await act(async () => {
        plus.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
        plus.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
      });
      await flush(20);
      expect(editor.view.dom.querySelector(".pm-diagram-source")).toBeNull();
      expect(document.body.querySelector(".graph-diagram-editor")).toBeNull();
    } finally {
      await unmount(editor);
    }
  });

  it("放大态下纯点击(不移动)不触发平移/指针捕获:真拖动才平移(防点两下减号误进编辑回归)", async () => {
    const editor = await mountEditor(
      diagramDoc("sequenceDiagram\n  A->>B: hi\n", "<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='40'/></svg>"),
    );
    try {
      const box = (await waitForSelector(".pm-diagram-svg", editor.view.dom)) as HTMLElement;
      const inner = box.querySelector<HTMLElement>(".pm-diagram-svg-inner")!;
      const viewbar = (await waitForSelector(".pm-diagram-svg-viewbar", editor.view.dom)) as HTMLElement;
      const plus = Array.from(viewbar.querySelectorAll<HTMLButtonElement>(".pm-diagram-tool")).find(
        (b) => b.textContent?.trim() === "＋",
      )!;
      await act(async () => {
        plus.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        plus.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      await flush(8);
      const me = (type: string, x: number) =>
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: 120 });
      const beforeT = inner.style.transform;
      // 纯点击:按下即抬起、不移动 → 不应平移(=不当拖动、不捕获指针 → click/dblclick 正常落到按钮)。
      await act(async () => {
        box.dispatchEvent(me("pointerdown", 200));
        box.dispatchEvent(me("pointerup", 200));
      });
      await flush(8);
      expect(inner.style.transform).toBe(beforeT);
      // 真正拖动(>4px)才平移。
      await act(async () => {
        box.dispatchEvent(me("pointerdown", 200));
        box.dispatchEvent(me("pointermove", 150));
        box.dispatchEvent(me("pointerup", 150));
      });
      await flush(8);
      expect(inner.style.transform).not.toBe(beforeT);
    } finally {
      await unmount(editor);
    }
  });

  it("Mermaid 源码编辑中外部旧 attrs 回灌不会覆盖本地粘贴内容", async () => {
    const original = `flowchart TD
  A[开始] --> B[结束]
`;
    const pasted = `flowchart TD
  A[粘贴后] --> B[结束]
  B --> C[新增]
`;
    const stale = `flowchart TD
  A[旧回灌] --> B[结束]
`;
    const editor = await mountEditor(diagramDoc(original));
    try {
      const sourceButton = Array.from(editor.view.dom.querySelectorAll<HTMLButtonElement>(".pm-diagram-view-actions button"))
        .find((button) => button.textContent?.trim() === "编辑 Mermaid");
      expect(sourceButton).not.toBeNull();
      await act(async () => {
        sourceButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flush();
      const textarea = editor.view.dom.querySelector<HTMLTextAreaElement>(".pm-diagram-source");
      expect(textarea).not.toBeNull();

      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      await act(async () => {
        setValue.call(textarea, pasted);
        textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flush();
      expect(textarea!.value).toBe(pasted);

      await act(async () => {
        updateFirstDiagramAttrs(editor, { source: stale, svg: "<svg data-stale='1'></svg>" });
      });
      await flush(4);
      expect(editor.view.dom.querySelector<HTMLTextAreaElement>(".pm-diagram-source")?.value).toBe(pasted);

      const doneBtn = editor.view.dom.querySelector<HTMLButtonElement>(".pm-diagram-btn");
      await act(async () => {
        doneBtn!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      await flush(4);
      expect(firstDiagramAttrs(editor)?.source).toBe(pasted);
    } finally {
      await unmount(editor);
    }
  });

  it("编辑时把源码清空再完成 → 删除整个 diagram 节点(不留空源码炸 PM 校验)", async () => {
    const editor = await mountEditor(diagramDoc("sequenceDiagram\n  A->>B: hi"));
    try {
      const buttons = Array.from(editor.view.dom.querySelectorAll<HTMLButtonElement>(".pm-diagram-view-actions button")).map((button) => button.textContent?.trim());
      expect(buttons).toEqual(["编辑 Mermaid"]);
      // 非节点-边图没有 GraphDiagramView,双击仍进入 Mermaid 源码编辑。
      const diagramView = editor.view.dom.querySelector<HTMLElement>(".pm-diagram-view");
      expect(diagramView).not.toBeNull();
      await act(async () => {
        diagramView!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
      await flush();
      const textarea = editor.view.dom.querySelector<HTMLTextAreaElement>(".pm-diagram-source");
      expect(textarea).not.toBeNull();
      // 清空源码(走 React 受控 setter 触发 onChange)
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      await act(async () => {
        setValue.call(textarea, "");
        textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flush();
      // 点「完成」
      const doneBtn = editor.view.dom.querySelector<HTMLButtonElement>(".pm-diagram-btn");
      await act(async () => {
        doneBtn!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      await flush();
      // diagram 节点应已被删除
      expect(firstDiagramAttrs(editor)).toBeNull();
    } finally {
      await unmount(editor);
    }
  });

  it("渲染失败(mermaid 抛错)时显示错误回退而不是崩溃", async () => {
    const mermaid = (await import("mermaid")).default;
    (mermaid.render as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Parse error: bad"));
    const editor = await mountEditor(diagramDoc("sequenceDiagram\n  A->>", null));
    try {
      await flush();
      const err = editor.view.dom.querySelector(".pm-diagram-error");
      expect(err).not.toBeNull();
      // dev 图表重构后:失败态显友好兜底文案 + 保留源码(不暴露原始 mermaid 报错,也不崩、不丢内容)。
      expect(err!.textContent).toContain("图表生成失败");
      expect(err!.textContent).toContain("sequenceDiagram");
    } finally {
      await unmount(editor);
    }
  });
});
