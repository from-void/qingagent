import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { resolveAnchoredBubblePosition, type FloatingAnchorRect } from "../../data/floatingPosition";
import { sanitizeToolbarLinkHref } from "../../data/toolbarUnlock";

interface LinkEditBubble {
  top: number;
  left: number;
  from: number;
  to: number;
}

function isValidLinkRange(editor: Editor, range: Pick<LinkEditBubble, "from" | "to">): boolean {
  const { from, to } = range;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > editor.state.doc.content.size) {
    return false;
  }
  try {
    editor.state.doc.resolve(from);
    editor.state.doc.resolve(to);
    return true;
  } catch {
    return false;
  }
}

export function useToolbarLinkEditor({
  editor,
  onToast,
  ignoreRef,
}: {
  editor: Editor | null;
  onToast?: (message: string) => void;
  ignoreRef?: RefObject<HTMLElement | null>;
}) {
  const [bubble, setBubble] = useState<LinkEditBubble | null>(null);
  const [draft, setDraft] = useState("");
  const bubbleRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const closeLinkEditor = useCallback(() => setBubble(null), []);
  const openLinkEditor = useCallback((anchor: FloatingAnchorRect, range?: { from: number; to: number }) => {
    if (!editor || !editor.isEditable) return false;
    const current = editor.getAttributes("link").href;
    const selection = range ?? editor.state.selection;
    const position = resolveAnchoredBubblePosition(
      anchor,
      { width: 320, height: 42 },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setDraft(typeof current === "string" ? current : "https://");
    setBubble({ ...position, from: selection.from, to: selection.to });
    return true;
  }, [editor]);

  useEffect(() => {
    if (!bubble) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [bubble]);

  useEffect(() => {
    if (!bubble) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (bubbleRef.current?.contains(target) || ignoreRef?.current?.contains(target)) return;
      setBubble(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBubble(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [bubble, ignoreRef]);

  useEffect(() => {
    if (!editor?.isEditable) setBubble(null);
  }, [editor, editor?.isEditable]);

  useEffect(() => {
    if (!editor || !bubble) return;
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) setBubble(null);
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [bubble, editor]);

  const applyLink = useCallback(() => {
    if (!editor || !bubble || !editor.isEditable) return;
    if (!isValidLinkRange(editor, bubble)) {
      setBubble(null);
      return;
    }
    const value = draft.trim();
    const chain = editor.chain().focus().setTextSelection({ from: bubble.from, to: bubble.to }).extendMarkRange("link");
    if (!value) {
      chain.unsetLink().run();
      setBubble(null);
      return;
    }
    const href = sanitizeToolbarLinkHref(value);
    if (!href) {
      onToast?.("链接只支持 http(s)、/ 开头或 # 开头");
      return;
    }
    chain.setLink({ href }).run();
    setBubble(null);
  }, [bubble, draft, editor, onToast]);

  const linkEditor = bubble ? (
    <div
      ref={bubbleRef}
      className="link-hover-card"
      style={{ position: "fixed", top: bubble.top, left: bubble.left, zIndex: 99999 }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="lhc-edit">
        <input
          ref={inputRef}
          className="lhc-input"
          value={draft}
          placeholder="输入链接地址"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyLink();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setBubble(null);
            }
          }}
        />
        <button type="button" className="lhc-btn primary" onMouseDown={(event) => event.preventDefault()} onClick={applyLink}>
          保存
        </button>
      </div>
    </div>
  ) : null;

  return { openLinkEditor, closeLinkEditor, linkEditor, linkEditorOpen: Boolean(bubble) };
}

export function floatingAnchorFromElement(element: HTMLElement): FloatingAnchorRect {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
}
