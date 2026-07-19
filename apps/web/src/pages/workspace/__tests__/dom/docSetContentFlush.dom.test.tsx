// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { applyBlockEdits, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pmDocToViewDocumentSnapshot } from "../../data/protocol";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";
import type { NativePresentationRun } from "../../data/nativeDiffAnimation";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => ({
      svg: `<svg data-mmd="1" data-src="${encodeURIComponent(source)}"><g/></svg>`,
    })),
  },
}));

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

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function renderDoc(doc: PmDoc, version: number, onEditorReady?: (editor: Editor | null) => void) {
  act(() => {
    root.render(
      <DocumentSnapshotView
        doc={pmDocToViewDocumentSnapshot(doc, version)}
        editable
        showPatches={false}
        acceptedPatches={new Set()}
        rejectedPatches={new Set()}
        onEditorReady={onEditorReady}
      />,
    );
  });
}

async function flush(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function flushQueuedMicrotasks(tasks: Array<() => void>) {
  await act(async () => {
    while (tasks.length > 0) {
      const task = tasks.shift();
      task?.();
      await Promise.resolve();
    }
  });
}

function paragraphDoc(text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "p-1" },
        content: [{ type: "text", text }],
      },
    ],
  } as PmDoc;
}

function listDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "p-intro" },
        content: [{ type: "text", text: "列表前言" }],
      },
      {
        type: "bulletList",
        attrs: { blockId: "list-1" },
        content: [
          {
            type: "listItem",
            attrs: { blockId: "li-1" },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "li-1-p" },
                content: [{ type: "text", text: "第一项" }],
              },
            ],
          },
          {
            type: "listItem",
            attrs: { blockId: "li-2" },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "li-2-p" },
                content: [{ type: "text", text: "第二项" }],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        attrs: { blockId: "p-tail" },
        content: [{ type: "text", text: "列表结尾" }],
      },
    ],
  } as PmDoc;
}

function collectBlockIdsByType(doc: unknown, type: string): Array<string | null> {
  const blockIds: Array<string | null> = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as { type?: unknown; attrs?: { blockId?: unknown }; content?: unknown };
    if (record.type === type) {
      blockIds.push(typeof record.attrs?.blockId === "string" ? record.attrs.blockId : null);
    }
    if (!Array.isArray(record.content)) return;
    for (const child of record.content) visit(child);
  };
  visit(doc);
  return blockIds;
}

function collectAllBlockIds(doc: unknown): string[] {
  const blockIds: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as { attrs?: { blockId?: unknown }; content?: unknown };
    if (typeof record.attrs?.blockId === "string") blockIds.push(record.attrs.blockId);
    if (!Array.isArray(record.content)) return;
    for (const child of record.content) visit(child);
  };
  visit(doc);
  return blockIds;
}

function duplicateTableDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "table",
        attrs: { blockId: "table-dup" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [{
                  type: "paragraph",
                  attrs: { blockId: "cell-dup" },
                  content: [{ type: "text", text: "A" }],
                }],
              },
              {
                type: "tableCell",
                content: [{
                  type: "paragraph",
                  attrs: { blockId: "cell-dup" },
                  content: [{ type: "text", text: "B" }],
                }],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        attrs: { blockId: "tail" },
        content: [{ type: "text", text: "尾段" }],
      },
    ],
  } as PmDoc;
}

function nodeViewDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "codeBlock",
        attrs: { blockId: "code-1", language: "typescript" },
        content: [{ type: "text", text: "const answer = 42;" }],
      },
      {
        type: "diagram",
        attrs: {
          blockId: "diagram-1",
          lang: "mermaid",
          source: "flowchart LR\n  A --> B",
          svg: null,
        },
      },
      {
        type: "columnList",
        attrs: { blockId: "columns-1" },
        content: [
          {
            type: "column",
            attrs: { blockId: "column-left", widthRatio: 0.45 },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "column-left-p" },
                content: [{ type: "text", text: "左栏内容" }],
              },
            ],
          },
          {
            type: "column",
            attrs: { blockId: "column-right", widthRatio: 0.55 },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "column-right-p" },
                content: [{ type: "text", text: "右栏内容" }],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as PmDoc;
}

describe("DocumentSnapshotView setContent 延迟装载", () => {
  it("400ms 防抖未到时卸载会补发当前编辑内容", async () => {
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async (_doc: PmDoc) => undefined);
    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(paragraphDoc("初始正文"), 1)}
          editable
          interactiveEditable
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={(readyEditor) => {
            editor = readyEditor;
          }}
          onEditorChange={onEditorChange}
        />,
      );
    });
    await flush();
    expect(editor).not.toBeNull();
    onEditorChange.mockClear();
    vi.useFakeTimers();

    act(() => {
      editor!.commands.setContent(paragraphDoc("卸载前新内容"));
    });
    expect(onEditorChange).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<div />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onEditorChange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onEditorChange.mock.calls[0]?.[0])).toContain(
      "卸载前新内容",
    );
  });

  it("载入含重复 blockId 的存量 PmDoc 后只自愈并保存一次，随后 AI 编辑可用", async () => {
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async (_doc: PmDoc) => undefined);
    const duplicateDoc = duplicateTableDoc();

    const render = (doc: PmDoc, version: number) => {
      act(() => {
        root.render(
          <DocumentSnapshotView
            doc={pmDocToViewDocumentSnapshot(doc, version)}
            docId="session-duplicate-load"
            editable
            interactiveEditable
            showPatches={false}
            acceptedPatches={new Set()}
            rejectedPatches={new Set()}
            onEditorReady={(readyEditor) => {
              editor = readyEditor;
            }}
            onEditorChange={onEditorChange}
          />,
        );
      });
    };

    render(duplicateDoc, 7);
    await flush();

    expect(editor).not.toBeNull();
    const healed = normalizePmDoc(editor!.getJSON());
    const ids = collectAllBlockIds(healed);
    expect(ids).toEqual(["table-dup", "cell-dup", "cell-dup~1", "tail"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(onEditorChange).toHaveBeenCalledTimes(1);
    expect(collectAllBlockIds(onEditorChange.mock.calls[0]![0])).toEqual(ids);

    // 服务器把自愈保存以 version+1 原样回显时，应命中 pendingSelfDocKeys，既不 setContent
    // 重设正文/选区，也不再次触发保存。
    let echoedDocChanges = 0;
    editor!.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) echoedDocChanges += 1;
    });
    render(onEditorChange.mock.calls[0]![0], 8);
    await flush();
    expect(echoedDocChanges).toBe(0);
    expect(onEditorChange).toHaveBeenCalledTimes(1);

    const editable = applyBlockEdits(healed, [
      {
        action: "replaceBlock",
        ref: "tail",
        block: { type: "paragraph", runs: [{ text: "尾段已改" }] },
      },
      {
        action: "insertTableRow",
        ref: "table-dup",
        at: "end",
        cells: [{ blocks: [{ type: "paragraph", runs: [{ text: "AI 新行" }] }] }],
      },
    ]);
    expect(editable.ok, editable.error).toBe(true);
  });

  it("播放 presentationRun 时即使用户不可编辑也挂载 TipTap,结束后可切回编辑态", async () => {
    let editor: Editor | null = null;
    const handleEditorReady = (readyEditor: Editor | null) => {
      editor = readyEditor;
    };
    const onPresentationFinish = vi.fn();
    const doc = paragraphDoc("生成后的正文");
    const snapshot = pmDocToViewDocumentSnapshot(doc, 2);
    const run: NativePresentationRun = {
      id: 1,
      docVersion: 2,
      sessionId: "session-presentation-lock",
      mode: "whole",
      finalDoc: doc,
      baselineSections: [],
      finalSections: snapshot.sections,
    };

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={snapshot}
          editable={false}
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={handleEditorReady}
          presentationRun={run}
          presentationReducedMotion
          onPresentationFinish={onPresentationFinish}
        />,
      );
    });
    await flush();

    expect(editor).not.toBeNull();
    const playingEditorDom = host.querySelector<HTMLElement>(".ProseMirror");
    expect(playingEditorDom).not.toBeNull();
    expect(playingEditorDom?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector("article.wf-doc")).toBeNull();
    expect(host.querySelector(".native-presentation-active")).not.toBeNull();
    expect(onPresentationFinish).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={snapshot}
          editable
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={handleEditorReady}
          presentationRun={null}
        />,
      );
    });
    await flush();

    const editableEditorDom = host.querySelector<HTMLElement>(".ProseMirror");
    expect(editableEditorDom).not.toBeNull();
    expect(editableEditorDom?.getAttribute("contenteditable")).toBe("true");
    expect(host.textContent).toContain("生成后的正文");
  });

  it("presentationRun 终态用 PM 回灌并保留 paragraph/listItem blockId", async () => {
    let editor: Editor | null = null;
    const handleEditorReady = (readyEditor: Editor | null) => {
      editor = readyEditor;
    };
    const onPresentationFinish = vi.fn();
    const doc = listDoc();
    const snapshot = pmDocToViewDocumentSnapshot(doc, 3);
    const run: NativePresentationRun = {
      id: 2,
      docVersion: 3,
      sessionId: "session-presentation-blockid",
      mode: "whole",
      finalDoc: doc,
      baselineSections: [],
      finalSections: snapshot.sections,
    };

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={snapshot}
          editable={false}
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={handleEditorReady}
          presentationRun={run}
          presentationReducedMotion
          onPresentationFinish={onPresentationFinish}
        />,
      );
    });
    await flush();

    expect(onPresentationFinish).toHaveBeenCalledTimes(1);
    expect(editor).not.toBeNull();
    expect(collectBlockIdsByType(editor!.getJSON(), "listItem")).toEqual(["li-1", "li-2"]);
    expect(collectBlockIdsByType(editor!.getJSON(), "paragraph")).toEqual([
      "p-intro",
      "li-1-p",
      "li-2-p",
      "p-tail",
    ]);
    expect(
      Array.from(host.querySelectorAll(".ProseMirror li")).map((li) =>
        li.getAttribute("data-block-id"),
      ),
    ).toEqual(["li-1", "li-2"]);

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={snapshot}
          editable
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={handleEditorReady}
          presentationRun={null}
        />,
      );
    });
    await flush();

    expect(collectBlockIdsByType(editor!.getJSON(), "listItem")).toEqual(["li-1", "li-2"]);
    expect(collectBlockIdsByType(editor!.getJSON(), "paragraph")).toEqual([
      "p-intro",
      "li-1-p",
      "li-2-p",
      "p-tail",
    ]);
    expect(host.querySelector<HTMLElement>(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
  });

  it("切换到含 code/diagram/column NodeView 的文档时不在同步 effect 栈内 setContent", async () => {
    let editor: Editor | null = null;
    const handleEditorReady = (readyEditor: Editor | null) => {
      editor = readyEditor;
    };
    renderDoc(paragraphDoc("旧内容"), 1, handleEditorReady);
    await flush();
    expect(editor).not.toBeNull();

    const queuedMicrotasks: Array<() => void> = [];
    const originalQueueMicrotask = globalThis.queueMicrotask;
    vi.stubGlobal("queueMicrotask", (callback: () => void) => {
      queuedMicrotasks.push(callback);
    });

    try {
      renderDoc(nodeViewDoc(), 2, handleEditorReady);
      expect(JSON.stringify(editor!.getJSON())).toContain("旧内容");
      expect(JSON.stringify(editor!.getJSON())).not.toContain("codeBlock");
      expect(queuedMicrotasks.length).toBeGreaterThan(0);
    } finally {
      vi.stubGlobal("queueMicrotask", originalQueueMicrotask);
    }

    await flushQueuedMicrotasks(queuedMicrotasks);
    await flush();

    expect(JSON.stringify(editor!.getJSON())).toContain("codeBlock");
    expect(JSON.stringify(editor!.getJSON())).toContain("diagram");
    expect(JSON.stringify(editor!.getJSON())).toContain("columnList");
    expect(host.textContent).toContain("const answer = 42;");
    expect(host.textContent).toContain("左栏内容");
    expect(host.textContent).toContain("右栏内容");
    expect(host.querySelector("[data-pm-node='diagram']")).not.toBeNull();
  });
});
