import React, { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";

export interface MathEditTarget {
  kind: "inline" | "block";
  latex: string;
  /** PM 文档位置(node 起点),用于 updateInlineMath/updateBlockMath 定位 */
  pos: number;
  /** 浮层锚点(视口坐标) */
  anchorX: number;
  anchorY: number;
}

/**
 * 公式编辑浮层:点击公式节点弹出,LaTeX 源码 + 实时 KaTeX 预览。
 * Enter 保存(Shift+Enter 换行)、Esc 取消;保存/删除由调用方落到编辑器命令。
 */
export function MathEditPopover({
  target,
  onSave,
  onDelete,
  onClose,
}: {
  target: MathEditTarget;
  onSave: (latex: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [latex, setLatex] = useState(target.latex);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setLatex(target.latex);
    // 弹出即聚焦并全选,便于直接重写
    const timer = window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [target]);

  // 点击浮层外关闭
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  const preview = useMemo(() => {
    const trimmed = latex.trim();
    if (!trimmed) return { ok: false as const, html: "", error: "输入 LaTeX 源码,例如 E = mc^2" };
    try {
      return {
        ok: true as const,
        html: katex.renderToString(trimmed, { displayMode: target.kind === "block", throwOnError: true }),
        error: "",
      };
    } catch (err) {
      return { ok: false as const, html: "", error: err instanceof Error ? err.message : String(err) };
    }
  }, [latex, target.kind]);

  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(target.anchorX, window.innerWidth - 356)),
    top: Math.min(target.anchorY + 8, window.innerHeight - 220),
  };

  const save = () => {
    const trimmed = latex.trim();
    if (!trimmed) return;
    onSave(trimmed);
  };

  return (
    <div ref={rootRef} className="math-edit-popover" style={style} data-wf="MathEditPopover">
      <textarea
        ref={textareaRef}
        value={latex}
        placeholder="LaTeX 源码,如 \frac{a}{b}"
        onChange={(event) => setLatex(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className={`math-edit-preview${preview.ok ? "" : " is-error"}`}>
        {preview.ok ? (
          <span dangerouslySetInnerHTML={{ __html: preview.html }} />
        ) : (
          <span>{preview.error}</span>
        )}
      </div>
      <div className="math-edit-actions">
        <button type="button" onClick={onDelete}>删除</button>
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" className="primary" disabled={!preview.ok} onClick={save}>保存</button>
      </div>
    </div>
  );
}
