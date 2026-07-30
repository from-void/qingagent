import { useCallback, useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import { useWorkspaceEditorSelectionCache } from "../../../system/WorkspaceEditorSelectionCache";
import type { StoredWorkspaceEditorSelection } from "../../../system/WorkspaceEditorSelectionCache";

type EditorReadyHandler = (editor: Editor | null) => void;

interface TrackedEditor {
  editor: Editor;
  documentId: string;
  remember: () => void;
  contentReady: boolean;
  stored: StoredWorkspaceEditorSelection | null;
  restoreScheduled: boolean;
}

function scheduleSelectionRestore(callback: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }
  setTimeout(callback, 0);
}

/**
 * 主稿与衍生稿互斥挂载、Workspace 路由卸载都会销毁主稿 EditorView。DOM 节点引用无法
 * 跨实例复用，因此按文档保存 ProseMirror 的位置表示，并在正文 hydration 完成后恢复。
 */
export function useWorkspaceEditorSelection(
  documentId: string | null,
  onEditorReady: EditorReadyHandler,
  restoreReady: boolean,
): EditorReadyHandler {
  const selectionCache = useWorkspaceEditorSelectionCache();
  const latestOnEditorReadyRef = useRef(onEditorReady);
  const readinessRef = useRef({ documentId, restoreReady });
  const trackedEditorRef = useRef<TrackedEditor | null>(null);
  latestOnEditorReadyRef.current = onEditorReady;
  readinessRef.current = { documentId, restoreReady };

  const restoreTrackedSelection = useCallback((tracked: TrackedEditor) => {
    if (
      !tracked.contentReady ||
      !tracked.stored ||
      tracked.restoreScheduled
    ) {
      return;
    }
    tracked.restoreScheduled = true;
    const stored = tracked.stored;
    scheduleSelectionRestore(() => {
      if (
        trackedEditorRef.current !== tracked ||
        tracked.editor.isDestroyed ||
        !tracked.contentReady
      ) {
        tracked.restoreScheduled = false;
        return;
      }
      try {
        const selection = Selection.fromJSON(
          tracked.editor.state.doc,
          stored.json,
        );
        tracked.editor.view.dispatch(
          tracked.editor.state.tr.setSelection(selection),
        );
      } catch {
        // 同文档离屏期间若正文结构已大改，旧位置可能越界；保留新实例的安全默认选区。
      } finally {
        tracked.stored = null;
        tracked.restoreScheduled = false;
        tracked.remember();
      }
    });
  }, []);

  useEffect(() => {
    const tracked = trackedEditorRef.current;
    if (!tracked || tracked.documentId !== documentId) return;
    tracked.contentReady = restoreReady;
    if (!restoreReady) return;
    if (tracked.stored) {
      restoreTrackedSelection(tracked);
    } else {
      tracked.remember();
    }
  }, [documentId, restoreReady, restoreTrackedSelection]);

  return useCallback(
    (editor: Editor | null) => {
      const previous = trackedEditorRef.current;
      if (previous) {
        if (
          previous.contentReady &&
          !previous.stored &&
          !previous.editor.isDestroyed
        ) {
          previous.remember();
        }
        previous.editor.off("selectionUpdate", previous.remember);
        trackedEditorRef.current = null;
      }

      latestOnEditorReadyRef.current(editor);
      if (!editor || !documentId || editor.isDestroyed) return;

      const stored = selectionCache.get(documentId);
      const currentReadiness = readinessRef.current;
      const tracked: TrackedEditor = {
        editor,
        documentId,
        contentReady:
          currentReadiness.documentId === documentId &&
          currentReadiness.restoreReady,
        stored: stored ?? null,
        restoreScheduled: false,
        remember: () => {
          if (
            !tracked.contentReady ||
            tracked.stored ||
            editor.isDestroyed
          ) {
            return;
          }
          selectionCache.set(documentId, {
            json: editor.state.selection.toJSON(),
          });
        },
      };
      trackedEditorRef.current = tracked;
      editor.on("selectionUpdate", tracked.remember);

      if (!tracked.contentReady) return;
      if (!tracked.stored) {
        tracked.remember();
        return;
      }
      restoreTrackedSelection(tracked);
    },
    [documentId, restoreTrackedSelection, selectionCache],
  );
}
