// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pmDocToViewDocumentSnapshot } from "../data/protocol";
import { DocumentSnapshotView } from "../components/DocumentSnapshotView";
import { useWorkspaceEditorSelection } from "./useWorkspaceEditorSelection";

const documentSnapshot = pmDocToViewDocumentSnapshot(
  {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "selection-paragraph" },
        content: [{ type: "text", text: "甲乙丙丁戊己庚辛壬癸" }],
      },
    ],
  },
  1,
);

function polyfillLayout(): void {
  const emptyRect = () => ({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Element.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Element.prototype.getBoundingClientRect =
    emptyRect as unknown as () => DOMRect;
  Range.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect =
    emptyRect as unknown as () => DOMRect;
  (
    document as unknown as { elementFromPoint: () => Element | null }
  ).elementFromPoint = () => null;
}

function SelectionHarness({
  activeTab,
  documentId,
  onEditorReady,
}: {
  activeTab: "main" | "derivative";
  documentId: string;
  onEditorReady: (editor: Editor | null) => void;
}) {
  const handleEditorReady = useWorkspaceEditorSelection(
    documentId,
    onEditorReady,
  );
  return (
    <>
      {activeTab === "main" ? (
        <DocumentSnapshotView
          doc={documentSnapshot}
          docId={documentId}
          editable
          interactiveEditable
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={handleEditorReady}
        />
      ) : (
        <article data-testid="derivative-document">另一篇文档</article>
      )}
      <input data-testid="chat-input" />
    </>
  );
}

async function flush(times = 6): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function selectionBelongsTo(
  selection: globalThis.Selection,
  editorDom: HTMLElement,
): boolean {
  const anchor =
    selection.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? (selection.anchorNode as Element)
      : selection.anchorNode?.parentElement;
  const focus =
    selection.focusNode?.nodeType === Node.ELEMENT_NODE
      ? (selection.focusNode as Element)
      : selection.focusNode?.parentElement;
  return Boolean(
    anchor &&
      focus &&
      editorDom.contains(anchor) &&
      editorDom.contains(focus),
  );
}

function requireEditor(editor: Editor | null): Editor {
  expect(editor).not.toBeNull();
  if (!editor) throw new Error("编辑器尚未就绪");
  return editor;
}

polyfillLayout();

describe("useWorkspaceEditorSelection", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("主稿跨文档 tab 重挂载后，用 focus 恢复原选区到新 EditorView", async () => {
    let editor: Editor | null = null;
    const handleEditorReady = (nextEditor: Editor | null) => {
      editor = nextEditor;
    };
    const render = (activeTab: "main" | "derivative") => {
      act(() => {
        root.render(
          <SelectionHarness
            activeTab={activeTab}
            documentId="main-document"
            onEditorReady={handleEditorReady}
          />,
        );
      });
    };

    render("main");
    await flush();
    const firstEditor = requireEditor(editor);
    const firstEditorDom = firstEditor.view.dom;

    act(() => {
      firstEditor.commands.setTextSelection({ from: 2, to: 6 });
      firstEditor.view.focus();
    });
    expect(window.getSelection()?.toString()).toBe("乙丙丁戊");

    act(() => {
      host
        .querySelector<HTMLInputElement>('[data-testid="chat-input"]')!
        .focus();
    });
    render("derivative");
    await flush();
    expect(firstEditorDom.isConnected).toBe(false);

    render("main");
    await flush();
    const remountedEditor = requireEditor(editor);
    expect(remountedEditor).not.toBe(firstEditor);

    act(() => {
      remountedEditor.view.focus();
    });
    const restoredSelection = window.getSelection();
    expect(restoredSelection?.toString()).toBe("乙丙丁戊");
    expect(restoredSelection?.rangeCount).toBe(1);
    expect(
      selectionBelongsTo(restoredSelection!, remountedEditor.view.dom),
    ).toBe(true);
  });

  it("同一实例转到聊天输入框再 focus 回正文，仍保持原 selection", async () => {
    let editor: Editor | null = null;
    const handleEditorReady = (nextEditor: Editor | null) => {
      editor = nextEditor;
    };
    act(() => {
      root.render(
        <SelectionHarness
          activeTab="main"
          documentId="main-document"
          onEditorReady={handleEditorReady}
        />,
      );
    });
    await flush();
    const mountedEditor = requireEditor(editor);

    act(() => {
      mountedEditor.commands.setTextSelection({ from: 2, to: 6 });
      mountedEditor.view.focus();
    });
    const chatInput = host.querySelector<HTMLInputElement>(
      '[data-testid="chat-input"]',
    )!;
    act(() => {
      chatInput.focus();
      mountedEditor.view.focus();
    });

    const restoredSelection = window.getSelection();
    expect(restoredSelection?.toString()).toBe("乙丙丁戊");
    expect(selectionBelongsTo(restoredSelection!, mountedEditor.view.dom)).toBe(
      true,
    );
  });

  it("文档 ID 改变时不把上一文档的 selection 带进新实例", async () => {
    let editor: Editor | null = null;
    const handleEditorReady = (nextEditor: Editor | null) => {
      editor = nextEditor;
    };
    const render = (
      activeTab: "main" | "derivative",
      documentId: string,
    ) => {
      act(() => {
        root.render(
          <SelectionHarness
            activeTab={activeTab}
            documentId={documentId}
            onEditorReady={handleEditorReady}
          />,
        );
      });
    };

    render("main", "first-document");
    await flush();
    const firstEditor = requireEditor(editor);
    act(() => {
      firstEditor.commands.setTextSelection({ from: 2, to: 6 });
    });

    render("derivative", "first-document");
    await flush();
    render("main", "second-document");
    await flush();

    const secondEditor = requireEditor(editor);
    expect(secondEditor).not.toBe(firstEditor);
    expect(secondEditor.state.selection.empty).toBe(true);
    expect(secondEditor.state.selection.from).toBe(1);
  });
});
