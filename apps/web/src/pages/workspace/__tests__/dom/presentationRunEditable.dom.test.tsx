// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { EditorView } from "@tiptap/pm/view";
import type { PmDoc } from "@qingagent/pm-schema";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";
import type { NativePresentationRun } from "../../data/nativeDiffAnimation";
import { pmDocToViewDocumentSnapshot, type ViewDocumentSnapshot } from "../../data/protocol";

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

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  });
}

async function drainAnimationFrames(done: () => boolean) {
  for (let i = 0; i < 20 && !done(); i++) {
    const callbacks = Array.from(rafCallbacks.values());
    rafCallbacks.clear();
    expect(callbacks.length).toBeGreaterThan(0);
    await act(async () => {
      frameTime += 1000;
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
});
