// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { EditorView } from "@tiptap/pm/view";
import type { PmDoc } from "@qingagent/pm-schema";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";
import type { NativePresentationRun } from "../../data/nativeDiffAnimation";
import { nativePresentationDecorationKey } from "../../data/nativePresentationPm";
import { pmDocToViewDocumentSnapshot, type ViewDocumentSnapshot } from "../../data/protocol";
import { shouldRetainPresentationRun } from "../../data/reviewActions";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafSeq = 0;
let frameTime = 0;

function polyfillDomGeometry() {
  const rect = {
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;

  Element.prototype.getClientRects = function () {
    return Object.assign([rect], { item: () => rect }) as unknown as DOMRectList;
  };
  Element.prototype.getBoundingClientRect = function () {
    return rect;
  };
  Range.prototype.getClientRects = function () {
    return Object.assign([rect], { item: () => rect }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function () {
    return rect;
  };
}

function pmParagraph(blockId: string, text: string): PmDoc["content"][number] {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function pmDoc(text: string): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [pmParagraph("p-1", text)],
  };
}

function presentationRunFor(doc: ViewDocumentSnapshot): NativePresentationRun {
  return {
    id: 1,
    docVersion: doc.version,
    sessionId: "session-presentation",
    mode: "whole",
    finalDoc: doc.pmDoc,
    baselineSections: [],
    finalSections: doc.sections,
  };
}

function editorText(editor: Editor): string {
  return editor.state.doc.textContent;
}

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  });
}

async function drainAnimationFrames(done: () => boolean, stepMs = 1000) {
  for (let i = 0; i < 200 && !done(); i++) {
    const callbacks = Array.from(rafCallbacks.values());
    rafCallbacks.clear();
    expect(callbacks.length).toBeGreaterThan(0);
    await act(async () => {
      frameTime += stepMs;
      callbacks.forEach((callback) => callback(frameTime));
    });
    await flush(1);
  }
}

describe("presentationRun editable unlock", () => {
  beforeEach(() => {
    polyfillDomGeometry();
    rafCallbacks = new Map();
    rafSeq = 0;
    frameTime = typeof performance !== "undefined" ? performance.now() : 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++rafSeq;
      rafCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      rafCallbacks.delete(id);
    });
    vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({
      top: 0,
      left: 0,
      right: 100,
      bottom: 20,
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    rafCallbacks.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("presentationRun 期间即使 editable=false 也挂 TipTap 播放动画，完成后无需刷新恢复编辑", async () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc("写完即可编辑"), 7, "t");
    const initialRun = presentationRunFor(doc);
    const onPresentationFinish = vi.fn();
    const editorRef: { current: Editor | null } = { current: null };

    function Harness() {
      const [run, setRun] = useState<NativePresentationRun | null>(initialRun);
      const userCanEdit = run === null;
      return createElement(DocumentSnapshotView, {
        doc,
        editable: userCanEdit,
        interactiveEditable: userCanEdit,
        showPatches: false,
        acceptedPatches: new Set<string>(),
        rejectedPatches: new Set<string>(),
        onEditorReady: (editor) => {
          editorRef.current = editor;
        },
        presentationRun: run,
        presentationReducedMotion: false,
        onPresentationFinish: () => {
          onPresentationFinish();
          setRun(null);
        },
      });
    }

    await act(async () => {
      root?.render(createElement(Harness));
    });
    await flush(2);

    const activeShell = container?.querySelector<HTMLElement>(".native-presentation-active");
    expect(activeShell).not.toBeNull();
    expect(activeShell?.dataset.nativePresentationRunId).toBe("1");
    expect(editorRef.current?.isEditable).toBe(false);
    expect(container?.querySelector<HTMLElement>(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    expect(onPresentationFinish).not.toHaveBeenCalled();

    await drainAnimationFrames(() => onPresentationFinish.mock.calls.length > 0);
    expect(onPresentationFinish).toHaveBeenCalledTimes(1);
    await flush(2);

    expect(container?.querySelector(".native-presentation-active")).toBeNull();
    expect(container?.querySelector<HTMLElement>(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
    expect(editorRef.current?.isEditable).toBe(true);
    expect(container?.textContent).toContain("写完即可编辑");
  });

  it("doc.version 与 presentationRun 同时到达时主 effect 让渡，正文经多帧单调揭示", async () => {
    const oldDoc = pmDocToViewDocumentSnapshot(pmDoc("旧稿"), 1, "t1");
    const finalText = "逐字揭示必须经过多帧，不能被成品直接覆盖";
    const nextDoc = pmDocToViewDocumentSnapshot(pmDoc(finalText), 2, "t2");
    const writes: string[] = [];
    let editor: Editor | null = null;

    const renderView = async (
      doc: ViewDocumentSnapshot,
      presentationRun: NativePresentationRun | null,
    ) => {
      await act(async () => {
        root?.render(createElement(DocumentSnapshotView, {
          doc,
          editable: false,
          interactiveEditable: false,
          showPatches: false,
          acceptedPatches: new Set<string>(),
          rejectedPatches: new Set<string>(),
          onEditorReady: (nextEditor) => {
            if (!nextEditor) {
              editor = null;
              return;
            }
            if (editor === nextEditor) return;
            editor = nextEditor;
            nextEditor.on("transaction", () => writes.push(editorText(nextEditor)));
          },
          presentationRun,
          presentationReducedMotion: false,
        }));
      });
      await flush(2);
    };

    await renderView(oldDoc, null);
    writes.length = 0;
    await renderView(nextDoc, presentationRunFor(nextDoc));
    await drainAnimationFrames(() => Boolean(editor && editorText(editor).includes(finalText)), 20);

    const revealWrites = writes.filter((text, index) => index === 0 || text !== writes[index - 1]);
    const lengths = revealWrites.map((text) => text.length);
    expect(revealWrites.length).toBeGreaterThan(2);
    expect(lengths.some((length) => length > 0 && length < finalText.length)).toBe(true);
    expect(lengths.every((length, index) => index === 0 || length >= lengths[index - 1]!)).toBe(true);
    expect(revealWrites.at(-1)).toBe(finalText);
    expect(revealWrites.indexOf(finalText)).toBe(revealWrites.length - 1);
  });

  it("首帧超 deadline 后每批提交间恰有一次 rAF 让渡", async () => {
    const finalText = "逐帧可见连续性".repeat(80);
    const doc = pmDocToViewDocumentSnapshot(pmDoc(finalText), 24, "deadline");
    const run = presentationRunFor(doc);
    const onPresentationFinish = vi.fn();
    const batchFrames: number[] = [];
    const batchTexts: string[] = [];
    let editor: Editor | null = null;
    let rafTurn = 0;

    await act(async () => {
      root?.render(createElement(DocumentSnapshotView, {
        doc,
        editable: false,
        interactiveEditable: false,
        showPatches: false,
        acceptedPatches: new Set<string>(),
        rejectedPatches: new Set<string>(),
        onEditorReady: (nextEditor) => {
          if (!nextEditor || nextEditor === editor) return;
          editor = nextEditor;
          nextEditor.on("transaction", ({ transaction }) => {
            const decorationMeta = transaction.getMeta(
              nativePresentationDecorationKey,
            ) as { kind?: string } | undefined;
            if (decorationMeta?.kind !== "set") return;
            batchFrames.push(rafTurn);
            batchTexts.push(nextEditor.state.doc.textContent);
          });
        },
        presentationRun: run,
        presentationReducedMotion: false,
        onPresentationFinish,
      }));
    });
    await flush(2);

    expect(editor).not.toBeNull();
    expect(onPresentationFinish).not.toHaveBeenCalled();

    const runNextFrame = async (advanceMs: number) => {
      const callbacks = Array.from(rafCallbacks.values());
      rafCallbacks.clear();
      expect(callbacks.length).toBeGreaterThan(0);
      rafTurn += 1;
      await act(async () => {
        frameTime += advanceMs;
        callbacks.forEach((callback) => callback(frameTime));
      });
      await flush(1);
    };

    // 首个浏览器帧直接越过允许的最大 deadline，强制走逐帧 drain。
    await runNextFrame(60_001);
    for (let i = 0; i < 20 && onPresentationFinish.mock.calls.length === 0; i++) {
      await runNextFrame(16);
    }

    expect(onPresentationFinish).toHaveBeenCalledTimes(1);
    expect(batchFrames.length).toBeGreaterThanOrEqual(3);
    expect(batchFrames[0]).toBe(1);
    expect(
      batchFrames.every(
        (frame, index) => index === 0 || frame === batchFrames[index - 1]! + 1,
      ),
    ).toBe(true);
    expect(batchTexts.at(-1)).toBe(finalText);
    expect(
      batchTexts.every(
        (text, index) => index === 0 || text.length >= batchTexts[index - 1]!.length,
      ),
    ).toBe(true);
  });

  it("generation_finished 后异步标题的 locked 空窗保留 run，并最终完成揭示", async () => {
    const doc = pmDocToViewDocumentSnapshot(pmDoc("标题生成期间也要继续写完正文"), 2, "t");
    const initialRun = presentationRunFor(doc);
    const onPresentationFinish = vi.fn();

    function Harness() {
      const [run, setRun] = useState<NativePresentationRun | null>(initialRun);
      const [projection, setProjection] = useState<"locked" | "editing">("locked");
      return createElement("div", null,
        createElement("button", { onClick: () => setProjection("editing") }, "project-editing"),
        createElement("output", { "data-projection": projection }, projection),
        createElement(DocumentSnapshotView, {
          doc,
          editable: projection === "editing" && run === null,
          interactiveEditable: projection === "editing" && run === null,
          showPatches: false,
          acceptedPatches: new Set<string>(),
          rejectedPatches: new Set<string>(),
          presentationRun: run,
          presentationReducedMotion: false,
          onPresentationFinish: () => {
            onPresentationFinish();
            setRun(null);
          },
        }),
        createElement("output", { "data-run-retained": String(Boolean(run && shouldRetainPresentationRun({
          reducedMotion: false,
          runDocVersion: run.docVersion,
          currentDocVersion: doc.version,
          runSessionId: run.sessionId,
          currentSessionId: "session-presentation",
        }))) }),
      );
    }

    await act(async () => root?.render(createElement(Harness)));
    await flush(2);
    expect(container?.querySelector("[data-projection]")?.textContent).toBe("locked");
    expect(container?.querySelector("[data-run-retained]")?.getAttribute("data-run-retained")).toBe("true");
    expect(container?.querySelector(".native-presentation-active")).not.toBeNull();

    await act(async () => {
      container?.querySelector<HTMLButtonElement>("button")?.click();
    });
    await flush(1);
    expect(container?.querySelector("[data-projection]")?.textContent).toBe("editing");
    expect(container?.querySelector(".native-presentation-active")).not.toBeNull();

    await drainAnimationFrames(() => onPresentationFinish.mock.calls.length > 0);
    expect(onPresentationFinish).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("标题生成期间也要继续写完正文");
  });
});
