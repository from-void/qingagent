import { useCallback, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";

type EditorReadyHandler = (editor: Editor | null) => void;

interface StoredEditorSelection {
  documentId: string;
  json: unknown;
}

interface TrackedEditor {
  editor: Editor;
  documentId: string;
  remember: () => void;
  restoring: boolean;
}

function scheduleSelectionRestore(callback: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }
  setTimeout(callback, 0);
}

/**
 * 主稿与衍生稿互斥挂载，切 tab 会销毁主稿 EditorView。DOM 节点引用无法跨实例复用，
 * 因此只保存 ProseMirror 的文档位置表示，并在同一文档的新实例就绪后恢复。
 */
export function useWorkspaceEditorSelection(
  documentId: string | null,
  onEditorReady: EditorReadyHandler,
): EditorReadyHandler {
  const latestOnEditorReadyRef = useRef(onEditorReady);
  const storedSelectionRef = useRef<StoredEditorSelection | null>(null);
  const trackedEditorRef = useRef<TrackedEditor | null>(null);
  latestOnEditorReadyRef.current = onEditorReady;

  return useCallback(
    (editor: Editor | null) => {
      const previous = trackedEditorRef.current;
      if (previous) {
        if (!previous.restoring && !previous.editor.isDestroyed) {
          previous.remember();
        }
        previous.editor.off("selectionUpdate", previous.remember);
        trackedEditorRef.current = null;
      }

      latestOnEditorReadyRef.current(editor);
      if (!editor || !documentId || editor.isDestroyed) return;

      const stored = storedSelectionRef.current;
      const shouldRestore = stored?.documentId === documentId;
      const tracked: TrackedEditor = {
        editor,
        documentId,
        restoring: shouldRestore,
        remember: () => {
          if (tracked.restoring || editor.isDestroyed) return;
          storedSelectionRef.current = {
            documentId,
            json: editor.state.selection.toJSON(),
          };
        },
      };
      trackedEditorRef.current = tracked;
      editor.on("selectionUpdate", tracked.remember);

      if (!shouldRestore) {
        tracked.remember();
        return;
      }

      scheduleSelectionRestore(() => {
        if (
          trackedEditorRef.current !== tracked ||
          editor.isDestroyed
        ) {
          return;
        }
        try {
          const selection = Selection.fromJSON(editor.state.doc, stored.json);
          editor.view.dispatch(editor.state.tr.setSelection(selection));
        } catch {
          // 同文档离屏期间若正文结构已大改，旧位置可能越界；保留新实例的安全默认选区。
        } finally {
          tracked.restoring = false;
          tracked.remember();
        }
      });
    },
    [documentId],
  );
}
