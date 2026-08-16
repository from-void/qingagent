// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { applyBlockEdits, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { APPLYING_REMOTE_META } from "@qingagent/pm-schema/tiptap";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pmDocToViewDocumentSnapshot } from "../../data/protocol";
import {
  appliedDocVersionFromBroadcastFrame,
  decideBroadcastDocumentFrame,
} from "../../data/docWriteResultOwnership";
import {
  DocumentSnapshotView,
  type DocumentSnapshotViewHandle,
} from "../../components/DocumentSnapshotView";
import { DIAGRAM_VISUAL_WRITE_META } from "../../components/DiagramView";
import type { DocWriteBaseline } from "../../data/docWriteBaseline";
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

function manualFormattingDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: ["高亮文本", "引用文本", "列表文本", "二级标题"].map((text, index) => ({
      type: "paragraph" as const,
      attrs: { blockId: `manual-format-${index + 1}` },
      content: [{ type: "text" as const, text }],
    })),
  };
}

function selectText(editor: Editor, text: string, whole = false) {
  let from: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (from !== null || !node.isText || node.text !== text) return;
    from = pos;
  });
  expect(from).not.toBeNull();
  editor.commands.setTextSelection({
    from: from!,
    to: whole ? from! + text.length : from!,
  });
}

function longParagraphDoc(charCount: number): PmDoc {
  const paragraphChars = 50;
  const content = Array.from(
    { length: Math.ceil(charCount / paragraphChars) },
    (_, index) => {
      const remaining = charCount - index * paragraphChars;
      return {
        type: "paragraph",
        attrs: { blockId: `long-p-${index}` },
        content: [{ type: "text", text: "长".repeat(Math.min(paragraphChars, remaining)) }],
      };
    },
  );
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content,
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

function orderedListEndingDoc(itemTexts: readonly string[]): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "orderedList",
      attrs: { blockId: "list-settlement", start: 1 },
      content: itemTexts.map((text, index) => ({
        type: "listItem" as const,
        attrs: { blockId: `list-settlement-item-${index + 1}` },
        content: [{
          type: "paragraph" as const,
          attrs: { blockId: `list-settlement-item-${index + 1}-p` },
          content: [{ type: "text" as const, text }],
        }],
      })),
    }],
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

function diagramEchoDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "before-echo" },
        content: [{ type: "text", text: "前文" }],
      },
      {
        type: "diagram",
        attrs: {
          blockId: "diagram-echo",
          lang: "mermaid",
          source: "flowchart LR\n  A --> B",
          svg: '<svg data-r9="cached"><g /></svg>',
        },
      },
      {
        type: "paragraph",
        attrs: { blockId: "tail-echo" },
        content: [{ type: "text", text: "文末" }],
      },
    ],
  } as PmDoc;
}

function nodePosition(editor: Editor, type: string): number {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === type) {
      found = pos;
      return false;
    }
    return true;
  });
  expect(found).not.toBeNull();
  return found!;
}

function pressEnter(editor: Editor): boolean {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  let handled = false;
  editor.view.someProp("handleKeyDown", (handler) => {
    const result = handler(editor.view, event);
    handled = handled || result === true;
    return result === true;
  });
  return handled;
}

describe("DocumentSnapshotView setContent 延迟装载", () => {
  it("真实手动高亮与块级快捷键经自动保存、重新挂载后全部保留", async () => {
    let editor: Editor | null = null;
    let saved: PmDoc | null = null;
    const onEditorChange = vi.fn(async (doc: PmDoc) => {
      saved = doc;
    });

    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(manualFormattingDoc(), 1)}
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
      selectText(editor!, "高亮文本", true);
      expect(editor!.commands.keyboardShortcut("Mod-Shift-h")).toBe(true);
      selectText(editor!, "引用文本");
      expect(editor!.commands.keyboardShortcut("Mod-Shift-b")).toBe(true);
      selectText(editor!, "列表文本");
      expect(editor!.commands.keyboardShortcut("Mod-Shift-8")).toBe(true);
      selectText(editor!, "二级标题");
      expect(editor!.commands.keyboardShortcut("Mod-Alt-2")).toBe(true);
    });

    const liveHtml = editor!.getHTML();
    expect(liveHtml).toContain("<mark");
    expect(liveHtml).toContain("<blockquote ");
    expect(liveHtml).toContain("<ul ");
    expect(liveHtml).toContain("<h2");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(401);
    });
    expect(onEditorChange).toHaveBeenCalledTimes(1);
    expect(saved).not.toBeNull();

    vi.useRealTimers();
    act(() => root.render(<div />));
    await flush();
    editor = null;
    renderDoc(saved!, 2, (readyEditor) => {
      editor = readyEditor;
    });
    await flush();

    const reopened = normalizePmDoc(editor!.getJSON());
    expect(reopened.content.map((block) => block.type)).toEqual([
      "paragraph",
      "blockquote",
      "bulletList",
      "heading",
    ]);
    expect(reopened.content[3]).toMatchObject({
      type: "heading",
      attrs: { level: 2 },
    });
    const highlighted = reopened.content[0];
    expect(highlighted?.type).toBe("paragraph");
    expect(highlighted?.type === "paragraph" ? highlighted.content?.[0] : null)
      .toMatchObject({
        type: "text",
        marks: [{ type: "highlight", attrs: { color: "yellow" } }],
      });
  });

  it("13,250 字多段正文外部 setContent 与重新挂载均保持完整页面", async () => {
    let editor: Editor | null = null;
    const longDoc = longParagraphDoc(13_250);
    const handleEditorReady = (readyEditor: Editor | null) => {
      editor = readyEditor;
    };

    renderDoc(paragraphDoc("短稿"), 1, handleEditorReady);
    await flush();
    const externalLoadStartedAt = performance.now();
    renderDoc(longDoc, 2, handleEditorReady);
    await flush();
    const externalLoadMs = performance.now() - externalLoadStartedAt;

    expect(editor).not.toBeNull();
    expect(editor!.state.doc.textContent.length).toBe(13_250);
    expect(host.querySelector(".ProseMirror")?.textContent?.length).toBe(13_250);
    expect(document.body.textContent?.length).toBeGreaterThanOrEqual(13_250);
    expect(externalLoadMs).toBeLessThan(2_000);

    act(() => root.render(<div />));
    await flush();
    renderDoc(longDoc, 2, handleEditorReady);
    await flush();

    expect(editor).not.toBeNull();
    expect(editor!.state.doc.textContent.length).toBe(13_250);
    expect(host.querySelector(".ProseMirror")?.textContent?.length).toBe(13_250);
  });

  it("同一 version 的流式草稿内容变化会持续刷新已挂载编辑器", async () => {
    let editor: Editor | null = null;
    const handleEditorReady = (readyEditor: Editor | null) => {
      editor = readyEditor;
    };

    renderDoc(paragraphDoc("首帧"), 7, handleEditorReady);
    await flush();
    expect(editor).not.toBeNull();
    expect(editor!.state.doc.textContent).toBe("首帧");

    renderDoc(paragraphDoc("首帧和后续帧"), 7, handleEditorReady);
    await flush();

    expect(editor!.state.doc.textContent).toBe("首帧和后续帧");
  });

  it("用户显式清空多块长文档时保留空稿并转发保存", async () => {
    let editor: Editor | null = null;
    const baseline = listDoc();
    const onEditorChange = vi.fn(async (_doc: PmDoc) => undefined);
    const onToast = vi.fn();
    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(baseline, 1)}
          editable
          interactiveEditable
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={(readyEditor) => {
            editor = readyEditor;
          }}
          onEditorChange={onEditorChange}
          onToast={onToast}
        />,
      );
    });
    await flush();
    expect(editor).not.toBeNull();
    onEditorChange.mockClear();
    onToast.mockClear();
    vi.useFakeTimers();

    act(() => {
      editor!.commands.setContent({
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [],
      });
    });

    expect(editor!.state.doc.textContent).toBe("");
    expect(onToast).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(401);
    });
    expect(onEditorChange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onEditorChange.mock.calls[0]?.[0])).not.toContain(
      "第一项",
    );
  });

  it("图表视觉编辑保存失败时保留本地修改并立即给出可见反馈", async () => {
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async () => {
      throw new Error("HTTP 422");
    });
    const onToast = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
          onToast={onToast}
        />,
      );
    });
    await flush();
    expect(editor).not.toBeNull();

    act(() => {
      const end = editor!.state.doc.content.size;
      editor!.view.dispatch(
        editor!.state.tr
          .insertText("（拖拽后）", end - 1)
          .setMeta(DIAGRAM_VISUAL_WRITE_META, true),
      );
    });
    await flush();

    expect(onEditorChange).toHaveBeenCalledTimes(1);
    expect(editor!.state.doc.textContent).toContain("拖拽后");
    expect(onToast).toHaveBeenCalledWith("图表修改未保存，请重试");
    expect(consoleError).toHaveBeenCalled();
  });

  it("普通防抖编辑保存失败时保留本地修改并给出可见反馈", async () => {
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async () => {
      throw new Error("HTTP 422");
    });
    const onToast = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
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
          onToast={onToast}
        />,
      );
    });
    await flush();
    expect(editor).not.toBeNull();
    vi.useFakeTimers();

    act(() => {
      const end = editor!.state.doc.content.size;
      editor!.view.dispatch(editor!.state.tr.insertText("（继续编辑）", end - 1));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(401);
    });

    expect(onEditorChange).toHaveBeenCalledTimes(1);
    expect(editor!.state.doc.textContent).toContain("继续编辑");
    expect(onToast).toHaveBeenCalledWith("文档修改未保存，请重试");
  });

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

  it("新建块防抖回写后，blockId 自我回声不重投影也不甩走选区", async () => {
    let editor: Editor | null = null;
    let savedDoc: PmDoc | null = null;
    let version = 1;
    const viewRef = createRef<DocumentSnapshotViewHandle>();
    const baseDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "p-first" },
          content: [{ type: "text", text: "前段" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "p-tail" },
          content: [{ type: "text", text: "尾段" }],
        },
      ],
    } as PmDoc;

    const renderEcho = (doc: PmDoc) => {
      root.render(
        <DocumentSnapshotView
          ref={viewRef}
          doc={pmDocToViewDocumentSnapshot(doc, version)}
          docId="session-local-block-id"
          editable
          interactiveEditable
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={(readyEditor) => {
            editor = readyEditor;
          }}
          onEditorChange={async (nextDoc) => {
            savedDoc = nextDoc;
            version += 1;
            renderEcho({
              ...nextDoc,
              content: nextDoc.content.map((block, index) =>
                index === 1
                  ? { ...block, attrs: { ...block.attrs, blockId: "canonical-new-block" } }
                  : block,
              ),
            } as PmDoc);
          }}
        />,
      );
    };

    act(() => renderEcho(baseDoc));
    await flush();
    expect(editor).not.toBeNull();

    await act(async () => {
      expect(
        editor!.chain()
          .insertContentAt(4, {
            type: "paragraph",
            content: [{ type: "text", text: "新块" }],
          })
          .setTextSelection(7)
          .run(),
      ).toBe(true);
    });
    const selectionBeforeSave = {
      anchor: editor!.state.selection.anchor,
      head: editor!.state.selection.head,
    };
    expect(selectionBeforeSave.anchor).toBeLessThan(editor!.state.doc.content.size);
    // main 的 dedupeBlockIds 插件已在本地插入事务中补齐临时 ID；这里继续验证
    // canonical 只替换该 ID 时走 attrs 同步，而不是 setContent。
    expect(collectBlockIdsByType(editor!.getJSON(), "paragraph")).not.toContain(null);

    const replaceSteps: unknown[] = [];
    editor!.on("transaction", ({ transaction }) => {
      for (const step of transaction.steps) {
        if (step.toJSON().stepType === "replace") replaceSteps.push(step.toJSON());
      }
    });
    await act(async () => {
      await viewRef.current?.flushPendingDocSave();
    });
    await flush();

    expect(savedDoc).not.toBeNull();
    expect(collectBlockIdsByType(savedDoc, "paragraph")).not.toContain(null);
    expect(collectBlockIdsByType(editor!.getJSON(), "paragraph")).not.toContain(null);
    expect(collectBlockIdsByType(editor!.getJSON(), "paragraph")).toContain("canonical-new-block");
    expect({
      anchor: editor!.state.selection.anchor,
      head: editor!.state.selection.head,
    }).toEqual(selectionBeforeSave);
    expect(replaceSteps).toHaveLength(0);
  });

  it("载入含重复 blockId 的存量 PmDoc 后只自愈并保存一次，随后 AI 编辑可用", async () => {
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async (
      _doc: PmDoc,
      _baseline?: DocWriteBaseline,
    ) => undefined);
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
    expect(onEditorChange.mock.calls[0]![1]?.expectedDocumentSnapshot).toBe(7);

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

  it("blockId 自愈遇到编辑器尚未同步的最新版本时跳过保存", async () => {
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async (
      _doc: PmDoc,
      _baseline?: DocWriteBaseline,
    ) => undefined);
    const duplicateDoc = duplicateTableDoc();
    const render = (version: number, deferBlockIdNormalization: boolean) => {
      act(() => {
        root.render(
          <DocumentSnapshotView
            doc={pmDocToViewDocumentSnapshot(duplicateDoc, version)}
            docId="session-stale-repair"
            editable
            interactiveEditable
            deferBlockIdNormalization={deferBlockIdNormalization}
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

    // 先用 defer 保留 v7 的重复 ID，再让 v8 的远端 apply 与自愈同时排队。
    render(7, true);
    await flush();
    expect(editor).not.toBeNull();
    expect(new Set(collectAllBlockIds(editor!.getJSON())).size)
      .toBeLessThan(collectAllBlockIds(editor!.getJSON()).length);

    const queuedMicrotasks: Array<() => void> = [];
    const originalQueueMicrotask = globalThis.queueMicrotask;
    vi.stubGlobal("queueMicrotask", (callback: () => void) => {
      queuedMicrotasks.push(callback);
    });
    try {
      render(8, false);
      expect(queuedMicrotasks).toHaveLength(2);

      // 故意让自愈早于远端正文 apply：latest=v8，但编辑器仍停在 v7。
      const repairBeforeRemoteApply = queuedMicrotasks.pop();
      await act(async () => {
        repairBeforeRemoteApply?.();
        await Promise.resolve();
      });
      expect(onEditorChange).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("queueMicrotask", originalQueueMicrotask);
    }
  });

  it("R9：图表后的新增段落保存回声不会重设选区或把后续输入移到文末", async () => {
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async (_doc: PmDoc) => undefined);
    const render = (doc: PmDoc, version: number) => {
      act(() => {
        root.render(
          <DocumentSnapshotView
            doc={pmDocToViewDocumentSnapshot(doc, version)}
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

    render(diagramEchoDoc(), 1);
    await flush();
    expect(editor).not.toBeNull();
    onEditorChange.mockClear();
    vi.useFakeTimers();

    const diagramPos = nodePosition(editor!, "diagram");
    act(() => {
      editor!.commands.focus();
      editor!.view.dispatch(editor!.state.tr.setSelection(NodeSelection.create(editor!.state.doc, diagramPos)));
      expect(pressEnter(editor!)).toBe(true);
      expect(editor!.state.selection).toBeInstanceOf(TextSelection);
      editor!.view.dispatch(editor!.state.tr.insertText("紧跟输入", editor!.state.selection.from));
    });

    const selectionBeforeEcho = editor!.state.selection;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(401);
    });
    expect(onEditorChange).toHaveBeenCalledTimes(1);
    const saved = onEditorChange.mock.calls[0]![0] as PmDoc;
    expect(normalizePmDoc(editor!.getJSON())).toEqual(saved);

    let echoDocChanges = 0;
    editor!.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) echoDocChanges += 1;
    });
    render(saved, 2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editor!.state.selection).toBeInstanceOf(TextSelection);
    expect(editor!.state.selection.eq(selectionBeforeEcho)).toBe(true);
    expect(editor!.state.doc.textContent).toContain("紧跟输入");
    expect(editor!.state.doc.textContent).toContain("文末");
    expect(echoDocChanges).toBe(0);
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

  it("presentation 逐帧写入不冒充本地 dirty，terminal canonical 可直接收敛", async () => {
    const viewRef = createRef<DocumentSnapshotViewHandle>();
    const doc = paragraphDoc("正在逐帧揭示的 canonical 正文");
    const snapshot = pmDocToViewDocumentSnapshot(doc, 3);
    const run: NativePresentationRun = {
      id: 2,
      docVersion: 3,
      sessionId: "session-presentation-dirty",
      mode: "whole",
      finalDoc: doc,
      baselineSections: [],
      finalSections: snapshot.sections,
    };
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 99);

    act(() => {
      root.render(
        <DocumentSnapshotView
          ref={viewRef}
          doc={snapshot}
          editable
          interactiveEditable={false}
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          presentationRun={run}
          presentationReducedMotion={false}
        />,
      );
    });
    await flush(2);

    expect(requestAnimationFrame).toHaveBeenCalled();
    expect(host.querySelector(".native-presentation-active")).not.toBeNull();
    expect(viewRef.current?.hasLocalDocumentChanges()).toBe(false);
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

  it("纯焦点/选区/空事务不 dirty，改后撤销在保存结算前仍不放行候选基线", async () => {
    const viewRef = createRef<DocumentSnapshotViewHandle>();
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async (_doc: PmDoc) => undefined);
    const canonical = paragraphDoc("副歌第二行");

    act(() => {
      root.render(
        <DocumentSnapshotView
          ref={viewRef}
          doc={pmDocToViewDocumentSnapshot(canonical, 7)}
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

    act(() => {
      editor!.commands.focus();
      editor!.view.dispatch(
        editor!.state.tr.setSelection(
          TextSelection.create(editor!.state.doc, 1, 3),
        ),
      );
      editor!.view.dispatch(editor!.state.tr);
      editor!.view.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      editor!.view.dom.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
    });
    expect(viewRef.current?.hasLocalDocumentChanges()).toBe(false);
    expect(viewRef.current?.canSafelyApplyIncomingDocument(canonical)).toBe(true);
    expect(onEditorChange).not.toHaveBeenCalled();

    vi.useFakeTimers();
    act(() => {
      const noNetChange = editor!.state.tr
        .insertText("临", 1)
        .delete(1, 2);
      expect(noNetChange.docChanged).toBe(true);
      expect(noNetChange.doc.eq(editor!.state.doc)).toBe(true);
      editor!.view.dispatch(noNetChange);
    });
    expect(viewRef.current?.hasLocalDocumentChanges()).toBe(false);
    expect(viewRef.current?.canSafelyApplyIncomingDocument(canonical)).toBe(true);

    act(() => {
      editor!.commands.insertContentAt(1, "临");
      expect(editor!.commands.undo()).toBe(true);
    });
    expect(viewRef.current?.hasLocalDocumentChanges()).toBe(true);
    expect(viewRef.current?.canSafelyApplyIncomingDocument(canonical)).toBe(false);
    expect(normalizePmDoc(editor!.getJSON())).toEqual(normalizePmDoc(canonical));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(401);
    });
    expect(onEditorChange).toHaveBeenCalledTimes(1);
    expect(viewRef.current?.hasLocalDocumentChanges()).toBe(false);
    expect(viewRef.current?.canSafelyApplyIncomingDocument(canonical)).toBe(true);
  });

  it("迟到的 APPLYING_REMOTE_META 正文事务不登记 dirty 或触发保存", async () => {
    const viewRef = createRef<DocumentSnapshotViewHandle>();
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async (_doc: PmDoc) => undefined);
    const initial = paragraphDoc("旧正文");
    const remote = paragraphDoc("远端正文");
    const render = (doc: PmDoc, version: number) => {
      act(() => {
        root.render(
          <DocumentSnapshotView
            ref={viewRef}
            doc={pmDocToViewDocumentSnapshot(doc, version)}
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

    render(initial, 7);
    await flush();
    expect(editor).not.toBeNull();
    onEditorChange.mockClear();
    vi.useFakeTimers();

    // 此时 isApplyingRemote ref 已复位；只有事务自身 meta 能证明它来自远端。
    act(() => {
      editor!.chain()
        .setMeta(APPLYING_REMOTE_META, true)
        .setContent(remote)
        .run();
    });
    render(remote, 8);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(401);
    });

    expect(viewRef.current?.hasLocalDocumentChanges()).toBe(false);
    expect(onEditorChange).not.toHaveBeenCalled();
  });

  it("dirty 兜底按语义口径忽略仅 blockId 的本地自愈漂移", async () => {
    const viewRef = createRef<DocumentSnapshotViewHandle>();
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async (_doc: PmDoc) => undefined);
    const canonical = paragraphDoc("正文未变");

    act(() => {
      root.render(
        <DocumentSnapshotView
          ref={viewRef}
          doc={pmDocToViewDocumentSnapshot(canonical, 7)}
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

    // 直接推进 EditorView state，隔离测试 debounce 已结算后的 dirty 兜底比较。
    const paragraph = editor!.state.doc.child(0);
    const blockIdOnly = editor!.state.tr.setNodeMarkup(
      0,
      undefined,
      { ...paragraph.attrs, blockId: "p-1-repaired" },
      paragraph.marks,
    );
    act(() => {
      editor!.view.updateState(editor!.state.apply(blockIdOnly));
    });

    expect(normalizePmDoc(editor!.getJSON())).not.toEqual(normalizePmDoc(canonical));
    expect(viewRef.current?.compareIncomingDocument(canonical)).toBe("equivalent");
    expect(viewRef.current?.hasLocalDocumentChanges()).toBe(false);
    expect(onEditorChange).not.toHaveBeenCalled();
  });

  it("P27：列表结尾文档贯穿结算乐观帧、canonical 与下轮审阅均保持干净且不冲突", async () => {
    const viewRef = createRef<DocumentSnapshotViewHandle>();
    let editor: Editor | null = null;
    const onEditorChange = vi.fn(async (_doc: PmDoc) => undefined);
    const oldCanonical = orderedListEndingDoc(["旧条目一", "旧条目二"]);
    const settledCanonical = orderedListEndingDoc(["新条目一", "新条目二"]);
    const decisions: Array<ReturnType<typeof decideBroadcastDocumentFrame>> = [];

    const render = (doc: PmDoc, version: number, reviewActive = false) => {
      act(() => {
        root.render(
          <DocumentSnapshotView
            ref={viewRef}
            doc={pmDocToViewDocumentSnapshot(doc, version)}
            editable
            interactiveEditable
            deferBlockIdNormalization={reviewActive}
            showPatches={reviewActive}
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
    const expectCleanCheckpoint = (label: string) => {
      expect(viewRef.current?.hasLocalDocumentChanges(), label).toBe(false);
      expect(onEditorChange, label).not.toHaveBeenCalled();
    };
    const decideIncoming = (frame: BridgeFrame, reviewActive = false) => {
      const applied = appliedDocVersionFromBroadcastFrame(frame);
      expect(applied).not.toBeNull();
      const comparison = viewRef.current!.compareIncomingDocument(applied!.pmDoc);
      const decision = decideBroadcastDocumentFrame({
        frame,
        editorDirty: viewRef.current!.hasLocalDocumentChanges(),
        pendingDocWrite: false,
        queuedDocWrite: false,
        scheduledDocWrite: false,
        incomingDocumentMatchesEditor: comparison === "equivalent",
        incomingDocumentComparisonUnavailable: comparison === "unavailable",
        reviewActive,
        reviewBaseVersion: reviewActive ? applied!.version : null,
      });
      decisions.push(decision);
      expect(decision.kind).not.toBe("conflict");
      return decision;
    };

    render(oldCanonical, 3);
    await flush();
    expect(editor).not.toBeNull();
    expectCleanCheckpoint("初次挂载 list-ending canonical");

    const optimisticFrame: BridgeFrame = {
      kind: "docGenerationEvent",
      data: {
        kind: "generation_finished",
        data: {
          generationId: "p27-settlement",
          seq: 1,
          prevSeq: null,
          doc: oldCanonical,
          finalVersion: 4,
          contentHash: "optimistic-old-content",
        },
      },
    };
    expect(decideIncoming(optimisticFrame)).toEqual({ kind: "apply" });
    render(oldCanonical, 4);
    await flush();
    expectCleanCheckpoint("结算乐观帧：旧正文@v+1");

    const canonicalFrame: BridgeFrame = {
      kind: "documentSnapshotWritten",
      data: { doc: { version: 4, ts: "p27-canonical", doc: settledCanonical } },
    };
    expect(decideIncoming(canonicalFrame)).toEqual({ kind: "apply" });
    render(settledCanonical, 4);
    await flush();
    expectCleanCheckpoint("权威 canonical v+1");

    const nextReviewFrame: BridgeFrame = {
      kind: "docDiffReady",
      data: {
        baseVersion: 4,
        suggestions: [],
        previewDoc: settledCanonical,
        editedDoc: settledCanonical,
      },
    };
    expect(decideIncoming(nextReviewFrame)).toEqual({ kind: "apply" });
    render(settledCanonical, 4, true);
    await flush();
    expectCleanCheckpoint("下轮 review 帧");
    expect(decisions.some((decision) => decision.kind === "conflict")).toBe(false);
  });
});
