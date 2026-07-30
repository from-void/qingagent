// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pmDocToViewDocumentSnapshot } from "../data/protocol";
import { viewDocumentSyncRevision } from "../data/viewDocHtml";
import { DocumentSnapshotView } from "../components/DocumentSnapshotView";
import { WorkspaceEditorSelectionProvider } from "../../../system/WorkspaceEditorSelectionCache";
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
  restoreReady = true,
  doc = documentSnapshot,
  selectionRevision = viewDocumentSyncRevision(doc),
}: {
  activeTab: "main" | "derivative";
  documentId: string;
  onEditorReady: (editor: Editor | null) => void;
  restoreReady?: boolean;
  doc?: typeof documentSnapshot;
  selectionRevision?: string;
}) {
  const {
    handleEditorReady,
    handleEditorContentReady,
  } = useWorkspaceEditorSelection(
    documentId,
    onEditorReady,
    restoreReady,
    selectionRevision,
  );
  return (
    <>
      {activeTab === "main" ? (
        <DocumentSnapshotView
          doc={doc}
          docId={documentId}
          editable
          interactiveEditable
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={handleEditorReady}
          onEditorContentReady={handleEditorContentReady}
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
          <WorkspaceEditorSelectionProvider>
            <SelectionHarness
              activeTab={activeTab}
              documentId="main-document"
              onEditorReady={handleEditorReady}
            />
          </WorkspaceEditorSelectionProvider>,
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
        <WorkspaceEditorSelectionProvider>
          <SelectionHarness
            activeTab="main"
            documentId="main-document"
            onEditorReady={handleEditorReady}
          />
        </WorkspaceEditorSelectionProvider>,
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

  it("非空选区缓存不会被随后到达的折叠 selectionUpdate 覆盖", async () => {
    let editor: Editor | null = null;
    const handleEditorReady = (nextEditor: Editor | null) => {
      editor = nextEditor;
    };
    const render = (activeTab: "main" | "derivative") => {
      act(() => {
        root.render(
          <WorkspaceEditorSelectionProvider>
            <SelectionHarness
              activeTab={activeTab}
              documentId="collapsed-update-document"
              onEditorReady={handleEditorReady}
            />
          </WorkspaceEditorSelectionProvider>,
        );
      });
    };

    render("main");
    await flush();
    const firstEditor = requireEditor(editor);
    act(() => {
      firstEditor.commands.setTextSelection({ from: 2, to: 6 });
      // 模拟选中文字后由失焦/DOM 同步补发的一次折叠 selectionUpdate。
      firstEditor.commands.setTextSelection(1);
    });
    expect(firstEditor.state.selection.empty).toBe(true);

    render("derivative");
    await flush();
    render("main");
    await flush();

    const remountedEditor = requireEditor(editor);
    act(() => {
      remountedEditor.view.focus();
    });
    expect(window.getSelection()?.toString()).toBe("乙丙丁戊");
  });

  it("A → B 不串选区，返回 A 后恢复 A 的原选区", async () => {
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
          <WorkspaceEditorSelectionProvider>
            <SelectionHarness
              activeTab={activeTab}
              documentId={documentId}
              onEditorReady={handleEditorReady}
            />
          </WorkspaceEditorSelectionProvider>,
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

    act(() => {
      secondEditor.commands.setTextSelection({ from: 6, to: 9 });
    });
    render("derivative", "second-document");
    await flush();
    render("main", "first-document");
    await flush();

    const restoredFirstEditor = requireEditor(editor);
    expect(restoredFirstEditor).not.toBe(firstEditor);
    act(() => {
      restoredFirstEditor.view.focus();
    });
    const restoredSelection = window.getSelection();
    expect(restoredSelection?.toString()).toBe("乙丙丁戊");
    expect(
      selectionBelongsTo(restoredSelection!, restoredFirstEditor.view.dom),
    ).toBe(true);
  });

  it("Workspace 路由完整卸载后再回来，仍从应用级缓存恢复原文档选区", async () => {
    let editor: Editor | null = null;
    const handleEditorReady = (nextEditor: Editor | null) => {
      editor = nextEditor;
    };
    const render = (
      route: "home" | "workspace",
      documentId: string,
    ) => {
      act(() => {
        root.render(
          <WorkspaceEditorSelectionProvider>
            {route === "workspace" ? (
              <SelectionHarness
                activeTab="main"
                documentId={documentId}
                onEditorReady={handleEditorReady}
              />
            ) : (
              <main data-testid="home-route" />
            )}
          </WorkspaceEditorSelectionProvider>,
        );
      });
    };

    render("workspace", "route-document-a");
    await flush();
    const firstEditor = requireEditor(editor);
    const firstEditorDom = firstEditor.view.dom;
    act(() => {
      firstEditor.commands.setTextSelection({ from: 2, to: 6 });
      firstEditor.view.focus();
    });
    expect(window.getSelection()?.toString()).toBe("乙丙丁戊");

    render("home", "route-document-a");
    await flush();
    expect(firstEditorDom.isConnected).toBe(false);

    render("workspace", "route-document-b");
    await flush();
    const secondEditor = requireEditor(editor);
    expect(secondEditor.state.selection.empty).toBe(true);
    act(() => {
      secondEditor.commands.setTextSelection({ from: 6, to: 9 });
    });

    render("home", "route-document-b");
    await flush();
    render("workspace", "route-document-a");
    await flush();

    const restoredEditor = requireEditor(editor);
    expect(restoredEditor).not.toBe(firstEditor);
    act(() => {
      restoredEditor.view.focus();
    });
    const restoredSelection = window.getSelection();
    expect(restoredSelection?.toString()).toBe("乙丙丁戊");
    expect(restoredSelection?.rangeCount).toBe(1);
    expect(selectionBelongsTo(restoredSelection!, restoredEditor.view.dom)).toBe(
      true,
    );
  });

  it("hydration 先 ready、正文 setContent 后到时，旧选区仍在真实内容落地后恢复", async () => {
    const hydratingDocumentSnapshot = pmDocToViewDocumentSnapshot(
      {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "hydrating-paragraph" },
            content: [{ type: "text", text: "甲" }],
          },
        ],
      },
      1,
    );
    const hydratedDocumentSnapshot = pmDocToViewDocumentSnapshot(
      documentSnapshot.pmDoc!,
      2,
    );
    const hydratedRevision = viewDocumentSyncRevision(
      hydratedDocumentSnapshot,
    );
    let editor: Editor | null = null;
    const handleEditorReady = (nextEditor: Editor | null) => {
      editor = nextEditor;
    };
    const render = (
      activeTab: "main" | "derivative",
      restoreReady: boolean,
      doc = hydratedDocumentSnapshot,
      selectionRevision = viewDocumentSyncRevision(doc),
    ) => {
      act(() => {
        root.render(
          <WorkspaceEditorSelectionProvider>
            <SelectionHarness
              activeTab={activeTab}
              documentId="hydrated-document"
              onEditorReady={handleEditorReady}
              restoreReady={restoreReady}
              doc={doc}
              selectionRevision={selectionRevision}
            />
          </WorkspaceEditorSelectionProvider>,
        );
      });
    };

    render("main", true);
    await flush();
    const firstEditor = requireEditor(editor);
    act(() => {
      firstEditor.commands.setTextSelection({ from: 2, to: 6 });
    });
    render("derivative", false);
    await flush();

    render("main", false, hydratingDocumentSnapshot);
    await flush();
    const remountedEditor = requireEditor(editor);
    expect(remountedEditor.state.selection.empty).toBe(true);

    // hydration 门先打开，但最终 canonical 正文尚未 setContent；不能在短正文上
    // 提前消费旧选区，也不能让默认 caret 覆盖缓存。
    render(
      "main",
      true,
      hydratingDocumentSnapshot,
      hydratedRevision,
    );
    await flush();
    expect(remountedEditor.state.selection.empty).toBe(true);

    // 最终正文后到并触发真实 setContent，恢复必须排在它完成之后。
    render(
      "main",
      true,
      hydratedDocumentSnapshot,
      hydratedRevision,
    );
    await flush();
    expect(remountedEditor.getText()).toBe("甲乙丙丁戊己庚辛壬癸");
    act(() => {
      remountedEditor.view.focus();
    });
    const restoredSelection = window.getSelection();
    expect(restoredSelection?.toString()).toBe("乙丙丁戊");
    expect(
      selectionBelongsTo(restoredSelection!, remountedEditor.view.dom),
    ).toBe(true);
  });
});
