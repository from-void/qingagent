import { useEffect, useMemo, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import type { DocDimensions } from "../data/docDimensions";
import type { NativePresentationRun } from "../data/nativeDiffAnimation";
import {
  resolveFindBarMode,
  shouldInterceptFindShortcut,
} from "../data/docFindModel";

export function useWorkspaceFind(input: {
  dim: DocDimensions;
  viewingVersion: number | null;
  presentationRun: NativePresentationRun | null;
  editorRef: RefObject<Editor | null>;
}) {
  const [findOpen, setFindOpen] = useState(false);
  const [findInitialQuery, setFindInitialQuery] = useState("");
  const findMode = useMemo(
    () =>
      resolveFindBarMode(
        input.dim,
        input.viewingVersion,
        input.presentationRun,
      ),
    [input.dim, input.presentationRun, input.viewingVersion],
  );

  useEffect(() => {
    if (findMode === "hidden") setFindOpen(false);
  }, [findMode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const isFindChord =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === "f" || event.key === "F");
      if (!isFindChord) return;

      const active = document.activeElement as HTMLElement | null;
      if (active?.closest?.("#view-workspace .ws-left")) return;

      const shouldOpen = shouldInterceptFindShortcut(event, false, findMode);
      event.preventDefault();
      if (!shouldOpen) return;

      const editor = input.editorRef.current;
      let selectedText = "";
      if (editor && !editor.isDestroyed) {
        const { from, to } = editor.state.selection;
        if (from !== to) {
          const text = editor.state.doc.textBetween(from, to, "\n", "\n");
          if (text.trim() !== "") selectedText = text;
        }
      }
      setFindInitialQuery(selectedText);
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findMode, input.editorRef]);

  return {
    findInitialQuery,
    findMode,
    findOpen,
    setFindInitialQuery,
    setFindOpen,
  };
}
