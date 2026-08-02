import React, { useCallback, useEffect, useRef, useState } from "react";
import { getMarkRange } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { resolveAnchoredBubblePosition } from "../../data/floatingPosition";
import { sanitizeToolbarLinkHref } from "../../data/toolbarUnlock";

/* ───────────── 链接 hover 浮层:显示地址 + 打开/编辑/移除(编辑态链接改用此浮层 + 选区工具栏) ───────────── */

interface LinkCardState {
  top: number;
  left: number;
  href: string;
  anchor: HTMLAnchorElement;
}

function resolveLiveLinkRange(
  editor: Editor,
  anchor: HTMLAnchorElement,
  expectedHref: string,
): { from: number; to: number } | null {
  const root = editor.view.dom;
  if (!anchor.isConnected || !root.contains(anchor)) return null;
  const linkType = editor.schema.marks.link;
  if (!linkType) return null;
  try {
    const pos = editor.view.posAtDOM(anchor, 0);
    const range = getMarkRange(editor.state.doc.resolve(pos), linkType);
    if (!range) return null;
    const linkedNode = editor.state.doc.nodeAt(range.from);
    const mark = linkedNode ? linkType.isInSet(linkedNode.marks) : null;
    if (!mark || mark.attrs.href !== expectedHref) return null;
    return range;
  } catch {
    return null;
  }
}

export function LinkHoverCard({ editor, onToast }: { editor: Editor; onToast?: (message: string) => void }) {
  const [card, setCard] = useState<LinkCardState | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingRef = useRef(false);
  editingRef.current = editing;

  const clearHide = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showForAnchor = useCallback(
    (a: HTMLAnchorElement) => {
      clearHide();
      let pos: number;
      try {
        pos = editor.view.posAtDOM(a, 0);
      } catch {
        return;
      }
      const rect = a.getBoundingClientRect();
      const resolved = resolveAnchoredBubblePosition(
        { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
        { width: 320, height: 42 },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setCard({
        top: resolved.top,
        left: resolved.left,
        href: a.getAttribute("href") ?? "",
        anchor: a,
      });
    },
    [clearHide, editor],
  );

  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    const onOver = (e: MouseEvent) => {
      if (!editor.isEditable || editingRef.current) return;
      const target = e.target instanceof Element ? e.target : null;
      const a = target?.closest("a");
      if (!a || !dom.contains(a)) return;
      showForAnchor(a);
    };
    const onClick = (e: MouseEvent) => {
      if (!editor.isEditable || editingRef.current || e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      const a = target?.closest("a");
      if (!a || !dom.contains(a)) return;
      e.preventDefault();
      e.stopPropagation();
      const href = a.getAttribute("href") ?? "";
      if (e.metaKey || e.ctrlKey) {
        if (href) window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      showForAnchor(a);
    };
    const onOut = (e: MouseEvent) => {
      if (editingRef.current) return;
      if (ref.current?.contains(e.relatedTarget as Node)) return;
      hideTimer.current = setTimeout(() => setCard(null), 220);
    };
    dom.addEventListener("mouseover", onOver);
    dom.addEventListener("click", onClick);
    dom.addEventListener("mouseout", onOut);
    return () => {
      dom.removeEventListener("mouseover", onOver);
      dom.removeEventListener("click", onClick);
      dom.removeEventListener("mouseout", onOut);
      clearHide();
    };
  }, [editor, clearHide, showForAnchor]);

  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setEditing(false);
        setCard(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editing]);

  if (!card) return null;

  const apply = () => {
    if (!editor.isEditable) return;
    const href = sanitizeToolbarLinkHref(draft);
    if (!href) {
      onToast?.("链接地址无效");
      return;
    }
    const range = resolveLiveLinkRange(editor, card.anchor, card.href);
    if (!range) {
      setEditing(false);
      setCard(null);
      return;
    }
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setTextSelection(range)
      .extendMarkRange("link")
      .setLink({ href })
      .run();
    setEditing(false);
    setCard(null);
  };
  const remove = () => {
    if (!editor.isEditable) return;
    const range = resolveLiveLinkRange(editor, card.anchor, card.href);
    if (!range) {
      setEditing(false);
      setCard(null);
      return;
    }
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setTextSelection(range)
      .extendMarkRange("link")
      .unsetLink()
      .run();
    setEditing(false);
    setCard(null);
  };

  return (
    <div
      ref={ref}
      className="link-hover-card"
      style={{ position: "fixed", top: card.top, left: card.left, zIndex: 99999 }}
      onMouseEnter={clearHide}
      onMouseLeave={() => {
        if (editingRef.current) return;
        // 离开卡片一律延时隐藏(去掉"relatedTarget 在编辑器内就不隐藏"的判断——那会在从卡片移回
        // 正文非链接区时让卡片常驻)。若移回的是链接,编辑器 onOver 会重新 clearHide+show。
        hideTimer.current = setTimeout(() => setCard(null), 200);
      }}
    >
      {editing ? (
        <div className="lhc-edit">
          <input
            className="lhc-input"
            value={draft}
            autoFocus
            placeholder="输入链接地址"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
          />
          <button type="button" className="lhc-btn primary" onMouseDown={(e) => e.preventDefault()} onClick={apply}>
            保存
          </button>
        </div>
      ) : (
        <div className="lhc-view">
          <a className="lhc-url" href={card.href} target="_blank" rel="noopener noreferrer" title={card.href}>
            {card.href || "（空链接）"}
          </a>
          <span className="lhc-sep" />
          <button
            type="button"
            className="lhc-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setDraft(card.href);
              setEditing(true);
            }}
          >
            编辑
          </button>
          <button type="button" className="lhc-btn" onMouseDown={(e) => e.preventDefault()} onClick={remove}>
            移除
          </button>
        </div>
      )}
    </div>
  );
}
