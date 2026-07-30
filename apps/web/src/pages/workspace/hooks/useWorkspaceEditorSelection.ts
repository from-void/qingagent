import { useCallback, useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import { useWorkspaceEditorSelectionCache } from "../../../system/WorkspaceEditorSelectionCache";
import type { StoredWorkspaceEditorSelection } from "../../../system/WorkspaceEditorSelectionCache";

type EditorReadyHandler = (editor: Editor | null) => void;
type EditorContentReadyHandler = (editor: Editor, revision: string) => void;

interface TrackedEditor {
  editor: Editor;
  selectionScopeId: string;
  remember: () => void;
  contentReady: boolean;
  appliedRevision: string | null;
  stored: StoredWorkspaceEditorSelection | null;
  restoreScheduled: boolean;
}

export interface WorkspaceEditorSelectionHandlers {
  handleEditorReady: EditorReadyHandler;
  handleEditorContentReady: EditorContentReadyHandler;
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
  selectionScopeId: string | null,
  onEditorReady: EditorReadyHandler,
  restoreReady: boolean,
  expectedRevision: string | null,
): WorkspaceEditorSelectionHandlers {
  const selectionCache = useWorkspaceEditorSelectionCache();
  const latestOnEditorReadyRef = useRef(onEditorReady);
  const readinessRef = useRef({
    selectionScopeId,
    restoreReady,
    expectedRevision,
  });
  const trackedEditorRef = useRef<TrackedEditor | null>(null);
  latestOnEditorReadyRef.current = onEditorReady;
  readinessRef.current = {
    selectionScopeId,
    restoreReady,
    expectedRevision,
  };

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
      let restored = false;
      try {
        const selection = Selection.fromJSON(
          tracked.editor.state.doc,
          stored.json,
        );
        tracked.editor.view.dispatch(
          tracked.editor.state.tr.setSelection(selection),
        );
        restored = true;
      } catch {
        // 同文档离屏期间若正文结构已大改，旧位置可能越界；保留新实例的安全默认选区。
        selectionCache.delete(tracked.selectionScopeId);
      } finally {
        tracked.stored = null;
        tracked.restoreScheduled = false;
        if (restored) tracked.remember();
      }
    });
  }, [selectionCache]);

  useEffect(() => {
    const tracked = trackedEditorRef.current;
    if (
      !tracked ||
      tracked.selectionScopeId !== selectionScopeId
    ) {
      return;
    }
    tracked.contentReady =
      restoreReady &&
      expectedRevision !== null &&
      tracked.appliedRevision === expectedRevision;
    if (tracked.contentReady && tracked.stored) {
      restoreTrackedSelection(tracked);
    }
  }, [
    expectedRevision,
    restoreReady,
    restoreTrackedSelection,
    selectionScopeId,
  ]);

  const handleEditorReady = useCallback(
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
      if (!editor || !selectionScopeId || editor.isDestroyed) return;

      const stored = selectionCache.get(selectionScopeId);
      const currentReadiness = readinessRef.current;
      const tracked: TrackedEditor = {
        editor,
        selectionScopeId,
        contentReady: false,
        appliedRevision: null,
        stored: stored ?? null,
        restoreScheduled: false,
        remember: () => {
          if (
            !tracked.contentReady ||
            tracked.stored ||
            editor.isDestroyed ||
            editor.state.selection.empty
          ) {
            return;
          }
          selectionCache.set(selectionScopeId, {
            json: editor.state.selection.toJSON(),
          });
        },
      };
      tracked.contentReady =
        currentReadiness.selectionScopeId === selectionScopeId &&
        currentReadiness.restoreReady &&
        currentReadiness.expectedRevision !== null &&
        tracked.appliedRevision === currentReadiness.expectedRevision;
      trackedEditorRef.current = tracked;
      editor.on("selectionUpdate", tracked.remember);
    },
    [selectionCache, selectionScopeId],
  );

  const handleEditorContentReady = useCallback(
    (editor: Editor, revision: string) => {
      const tracked = trackedEditorRef.current;
      if (
        !tracked ||
        tracked.editor !== editor ||
        tracked.selectionScopeId !== selectionScopeId ||
        editor.isDestroyed
      ) {
        return;
      }
      tracked.appliedRevision = revision;
      const currentReadiness = readinessRef.current;
      tracked.contentReady =
        currentReadiness.selectionScopeId === selectionScopeId &&
        currentReadiness.restoreReady &&
        currentReadiness.expectedRevision !== null &&
        revision === currentReadiness.expectedRevision;
      if (tracked.contentReady && tracked.stored) {
        restoreTrackedSelection(tracked);
      }
    },
    [restoreTrackedSelection, selectionScopeId],
  );

  return { handleEditorReady, handleEditorContentReady };
}
