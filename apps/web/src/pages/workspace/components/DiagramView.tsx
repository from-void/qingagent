import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Node } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { detectType, type DiagramType } from "@qingagent/diagram-engine";
import {
  DEFAULT_DRAWIO_SOURCE,
  normalizeDrawioSource,
  type PmDiagramLang,
} from "@qingagent/pm-schema";
import { renderMermaid } from "./mermaidRender";
import { renderDrawio } from "./drawioRender";
import { DiagramSvgView } from "./MermaidPreview";
import { DiagramRenderer } from "./diagram/DiagramRenderer";
import "./DiagramView.css";

// 图表块(diagram)的 Tiptap 节点 + 节点视图:
// - 承载 { lang:"mermaid"|"drawio", source, svg };客户端离线渲染并回写安全 svg(供导出)。
// - 用户可双击进入源码编辑(textarea + 实时预览),"完成"后持久化 source+svg。
// - 渲染失败显示错误 + 源码,绝不让坏图表把编辑器搞崩。
// - 渲染口径与只读/审阅态共用 mermaidRender + DiagramSvgView(全屏/尺寸一致)。

function DiagramComponent({ node, updateAttributes, deleteNode, editor, selected, getPos }: NodeViewProps) {
  const attrSource = (node.attrs.source as string) ?? "";
  const lang: PmDiagramLang = node.attrs.lang === "drawio" ? "drawio" : "mermaid";
  const cachedSvg = (node.attrs.svg as string | null) ?? null;
  const overlay = (node.attrs.overlay as Parameters<typeof DiagramRenderer>[0]["overlay"]) ?? null;
  const align: "left" | "center" | "right" =
    node.attrs.align === "left" || node.attrs.align === "right" ? node.attrs.align : "center";
  const [source, setSource] = useState(attrSource);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  const [visualEditSignal, setVisualEditSignal] = useState(0);
  const [svg, setSvg] = useState<string | null>(cachedSvg);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const renderTokenRef = useRef(0);
  const editingRef = useRef(false);
  const editable = editor?.isEditable ?? false;
  const viewRef = useRef<HTMLDivElement>(null);
  // 本次点击手势是否"刚把块选中"(块此前未选中):用于拦"快速点选未选中图表 → 误触双击直接进编辑"。
  // 冷双击只选中、不进编辑;块已选中时再双击才进编辑。纯状态判据、无定时器,确定可测。
  const justSelectedRef = useRef(false);
  const diagramType = lang === "mermaid" ? detectType(source) : null;
  const supportsVisualEdit = editable && isVisualDiagramType(diagramType);
  const storedHeight =
    typeof node.attrs.height === "number" && node.attrs.height > 0 ? Math.round(node.attrs.height) : null;
  const storedWidth =
    typeof node.attrs.width === "number" && node.attrs.width > 0 ? Math.round(node.attrs.width) : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!editing) setSource(attrSource);
  }, [attrSource, editing]);

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  // 持久化用户拖拽改的高度:resize:vertical 句柄会把内联 style.height 写到 .pm-diagram-view 上,
  // 但不落进 node.attrs → 刷新就丢。这里用 ResizeObserver 监听,只在【内联 height 被设过】
  // (即用户真拖了,而非 svg 内容撑高——内容撑高不写内联 style)且与已存值不同时,防抖回写 attrs。
  useEffect(() => {
    if (!editable || editing) return;
    const el = viewRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      const inlineH = el.style.height;
      if (!inlineH) return; // 没有内联高度 = 内容撑高,不是用户拖的,不持久化
      const h = Math.round(parseFloat(inlineH));
      if (!Number.isFinite(h) || h <= 0 || h === storedHeight) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (mountedRef.current) updateAttributes({ height: h });
      }, 300);
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [editable, editing, storedHeight, updateAttributes]);

  // 渲染当前要展示的源码(view 态用 node.source,edit 态用 draft);成功则缓存,并在与持久 svg 不同时回写。
  const renderInto = useCallback(
    async (text: string, persist: boolean) => {
      const trimmed = text.trim();
      // 竞态护栏:每次渲染领一个递增 token,慢渲染(旧 source)若在新渲染之后才落地则丢弃,
      // 避免把过期 svg setState / 写回 node.attrs(否则新 source 下会缓存旧图)。
      const token = ++renderTokenRef.current;
      if (!trimmed) {
        setSvg(null);
        setError(null);
        return;
      }
      try {
        const out = await (lang === "drawio" ? renderDrawio(trimmed) : renderMermaid(trimmed));
        if (!mountedRef.current || token !== renderTokenRef.current) return;
        setSvg(out);
        setError(null);
        // 持久化 svg 到 node(导出 PDF/Word 用);仅在内容真变化且可编辑时写,避免循环。
        if (persist && editable && !editingRef.current && out !== node.attrs.svg) {
          updateAttributes({ svg: out });
        }
      } catch (e) {
        if (!mountedRef.current || token !== renderTokenRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [editable, lang, node.attrs.svg, updateAttributes],
  );

  // view 态:source 变了(或首次且无缓存 svg)就渲染并回写缓存。
  useEffect(() => {
    if (editing) return;
    if (cachedSvg && source === draft) {
      setSvg(cachedSvg);
      return;
    }
    void renderInto(source, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, editing]);

  // edit 态:draft 变化防抖实时预览(不持久化,完成时才写)。
  useEffect(() => {
    if (!editing) return;
    const t = setTimeout(() => void renderInto(draft, false), 250);
    return () => clearTimeout(t);
  }, [draft, editing, renderInto]);

  const startEdit = () => {
    if (!editable) return;
    setDraft(source);
    setEditing(true);
  };

  const openVisualEdit = () => {
    if (!editable) return;
    if (!supportsVisualEdit) {
      startEdit();
      return;
    }
    setVisualEditSignal((value) => value + 1);
  };

  const commit = () => {
    // 空源码不能留:PM 校验要求 diagram.source 非空,留空会让随后的 normalizePmDoc 抛错、
    // 阻断保存流。源码被清空 = 用户想删掉这个图表,直接删节点。
    if (!draft.trim()) {
      setEditing(false);
      deleteNode?.();
      return;
    }
    let nextSource = draft;
    if (lang === "drawio") {
      try {
        nextSource = normalizeDrawioSource(draft);
      } catch (commitError) {
        setError(commitError instanceof Error ? commitError.message : String(commitError));
        return;
      }
    }
    setEditing(false);
    if (nextSource !== source) {
      setDraft(nextSource);
      setSource(nextSource);
      updateAttributes({ source: nextSource, svg: null }); // svg 置空,view useEffect 会按新 source 重渲并回写
    }
  };

  const cancel = () => {
    setEditing(false);
    setDraft(source);
  };

  // 自定义"圆点"右下角拖拽改尺寸:替代原生 resize:vertical 的双斜线句柄(用户嫌它像"两个拖拽点")。
  // 右下角同时调宽+高:横向拖→宽度,纵向拖→高度。拖动时直接改内联 style(顺滑),松手时落进 attrs 持久化。
  // 宽度上限为父级(占满栏宽)实测宽度,避免拖出栏外溢出。
  const resizeDragRef = useRef<{ startX: number; startY: number; startW: number; startH: number; maxW: number } | null>(null);
  const onResizeHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) return;
    const el = viewRef.current;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = el.getBoundingClientRect();
    const maxW = el.parentElement?.clientWidth ?? rect.width;
    resizeDragRef.current = { startX: event.clientX, startY: event.clientY, startW: rect.width, startH: rect.height, maxW };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    const el = viewRef.current;
    if (!drag || !el) return;
    const nextH = Math.max(160, Math.round(drag.startH + (event.clientY - drag.startY)));
    const nextW = Math.min(drag.maxW, Math.max(200, Math.round(drag.startW + (event.clientX - drag.startX))));
    el.style.height = `${nextH}px`;
    el.style.width = `${nextW}px`;
  };
  const onResizeHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    const el = viewRef.current;
    resizeDragRef.current = null;
    if (!drag || !el) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 指针已释放,忽略 */
    }
    const rect = el.getBoundingClientRect();
    const h = Math.round(rect.height);
    const w = Math.round(rect.width);
    const patch: { height?: number; width?: number } = {};
    if (h > 0 && h !== storedHeight) patch.height = h;
    // 宽度接近父级满宽时视为"不限宽",回写 null 让其继续占满栏(响应式)。
    const maxW = el.parentElement?.clientWidth ?? drag.maxW;
    const nextWidth = w > 0 && w < maxW - 8 ? w : null;
    if (nextWidth !== storedWidth) patch.width = nextWidth ?? (null as unknown as number);
    if (Object.keys(patch).length > 0) updateAttributes(patch);
  };

  const selectDiagramBlock = (event: ReactMouseEvent<HTMLElement>) => {
    if (!editable || editing || event.defaultPrevented || event.detail > 1) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".pm-diagram-edit") || target?.closest(".pm-diagram-view-actions")) return;
    const pos = typeof getPos === "function" ? getPos() : null;
    if (typeof pos !== "number") return;
    const nextSelection = NodeSelection.create(editor.state.doc, pos);
    if (!nextSelection.eq(editor.state.selection)) {
      // 选区真的变了 = 块此前未被选中 → 标记"本次手势是来选中的",紧随其后的 dblclick 不进编辑。
      justSelectedRef.current = true;
      editor.view.dispatch(editor.state.tr.setSelection(nextSelection));
    }
  };

  return (
    <NodeViewWrapper
      className={`pm-diagram${selected ? " is-selected" : ""}`}
      data-pm-node="diagram"
      data-lang={node.attrs.lang ?? "mermaid"}
      data-align={align}
      onClickCapture={selectDiagramBlock}
    >
      {editing ? (
        <div className="pm-diagram-edit">
          <div className="pm-diagram-preview">
            {error ? (
              <pre className="pm-diagram-error">{error}</pre>
            ) : svg ? (
              <DiagramSvgView svg={svg} />
            ) : (
              <div className="pm-diagram-empty">
                {lang === "drawio" ? "输入 mxGraph XML 以预览…" : "输入 Mermaid 源码以预览…"}
              </div>
            )}
          </div>
          <textarea
            className="pm-diagram-source"
            value={draft}
            spellCheck={false}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
              // Cmd/Ctrl+Enter 完成
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            placeholder={lang === "drawio" ? DEFAULT_DRAWIO_SOURCE : DEFAULT_MERMAID_SOURCE}
          />
          <div className="pm-diagram-actions">
            <button type="button" className="pm-diagram-btn" onMouseDown={(e) => { e.preventDefault(); commit(); }}>
              完成
            </button>
            <button type="button" className="pm-diagram-btn pm-diagram-btn--ghost" onMouseDown={(e) => { e.preventDefault(); cancel(); }}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div
          ref={viewRef}
          className="pm-diagram-view"
          style={
            storedHeight || storedWidth
              ? { ...(storedHeight ? { height: storedHeight } : {}), ...(storedWidth ? { width: storedWidth } : {}) }
              : undefined
          }
          onDoubleClick={(event) => {
            if (!editable) return;
            // 防误触:工具栏/操作区等"图表 chrome"和任何按钮上的双击绝不进编辑。
            // 这是兜底——即便 stopPropagation 被某条路径绕过(捕获相、放大态指针捕获重定向等),
            // 也按"双击落点"判定:落在 chrome/按钮上就直接返回(用户反馈"工具栏慢点两下误进编辑")。
            const target = event.target as HTMLElement | null;
            if (
              target?.closest(
                ".pm-diagram-chrome, .pm-diagram-svg-viewbar, .graph-diagram-viewbar, .pm-diagram-view-actions, button",
              )
            ) {
              return;
            }
            // 若本次手势刚把块选中(冷双击未选中的图表),只选中、不进编辑 —— 清掉标记后返回。
            // 块此前已选中时 justSelectedRef 为 false,双击照常进编辑。
            if (justSelectedRef.current) {
              justSelectedRef.current = false;
              return;
            }
            event.preventDefault();
            if (supportsVisualEdit) {
              openVisualEdit();
            } else {
              startEdit();
            }
          }}
        >
          {editable && (
            <div
              className="pm-diagram-view-actions"
              aria-label="图表操作"
              onDoubleClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              {supportsVisualEdit && (
                <button
                  type="button"
                  className="pm-diagram-view-btn"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={openVisualEdit}
                >
                  可视化编辑
                </button>
              )}
              <button
                type="button"
                className="pm-diagram-view-btn pm-diagram-view-btn--ghost"
                onMouseDown={(event) => event.preventDefault()}
                onClick={startEdit}
              >
                {lang === "drawio" ? "编辑 drawio XML" : "编辑 Mermaid"}
              </button>
            </div>
          )}
          {error ? (
            <pre className="pm-diagram-error">图表生成失败，请检查内容后重试{"\n\n"}{source}</pre>
          ) : (
            <DiagramRenderer
              source={source}
              cachedSvg={svg}
              lang={lang}
              overlay={overlay}
              readOnly={!editable}
              align={align}
              onAlignChange={editable ? (next) => updateAttributes({ align: next }) : undefined}
              openVisualSignal={visualEditSignal}
              onOverlayChange={(nextOverlay) => {
                if (!editable) return;
                updateAttributes({ overlay: nextOverlay });
              }}
              onSourceChange={(nextSource) => {
                if (!editable || !nextSource.trim()) return;
                setSource(nextSource);
                updateAttributes({ source: nextSource, svg: null });
              }}
            />
          )}
          {editable && (
            <div
              className="pm-diagram-resize-handle"
              role="separator"
              aria-label="拖拽调整图表尺寸"
              aria-orientation="horizontal"
              onPointerDown={onResizeHandleDown}
              onPointerMove={onResizeHandleMove}
              onPointerUp={onResizeHandleUp}
              onDoubleClick={(event) => event.stopPropagation()}
            />
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    diagram: {
      /** 在当前位置插入一个图表块(默认 mermaid 流程图模板)。 */
      insertDiagram: (attrs?: { lang?: PmDiagramLang; source?: string }) => ReturnType;
    };
  }
}

export const DEFAULT_MERMAID_SOURCE = "flowchart TD\n  A[开始] --> B[结束]";

export const DiagramCM = Node.create({
  name: "diagram",
  group: "block",
  atom: true,
  // 可被左侧块手柄拖拽排序(对齐 image 节点);拖拽由外层覆盖手柄经 view.dragging 驱动,
  // 节点自身不挂 data-drag-handle,故画布内的 react-flow 交互不受影响。
  draggable: true,

  addAttributes() {
    return {
      lang: {
        default: "mermaid",
        parseHTML: (element) => element.getAttribute("data-lang") ?? "mermaid",
        renderHTML: (attributes) => ({ "data-lang": (attributes.lang as string) ?? "mermaid" }),
      },
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-source") ?? element.textContent ?? "",
        renderHTML: (attributes) => ({ "data-source": (attributes.source as string) ?? "" }),
      },
      svg: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      height: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-height");
          const n = raw ? Number(raw) : NaN;
          return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
        },
        renderHTML: (attributes) =>
          typeof attributes.height === "number" && attributes.height > 0
            ? { "data-height": String(Math.round(attributes.height as number)) }
            : {},
      },
      width: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-width");
          const n = raw ? Number(raw) : NaN;
          return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
        },
        renderHTML: (attributes) =>
          typeof attributes.width === "number" && attributes.width > 0
            ? { "data-width": String(Math.round(attributes.width as number)) }
            : {},
      },
      align: {
        default: "center",
        parseHTML: (element) => {
          const raw = element.getAttribute("data-align");
          return raw === "left" || raw === "right" || raw === "center" ? raw : "center";
        },
        renderHTML: (attributes) => {
          const a = attributes.align;
          return a === "left" || a === "right" || a === "center" ? { "data-align": a } : {};
        },
      },
      overlay: {
        default: null,
        parseHTML: (element) => parseJsonAttr(element.getAttribute("data-overlay")),
        renderHTML: (attributes) => {
          const value = stringifyJsonAttr(attributes.overlay);
          return value ? { "data-overlay": value } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-pm-node='diagram']" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ["div", { ...HTMLAttributes, "data-pm-node": "diagram", class: "pm-diagram" }, String(node.attrs.source ?? "")];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DiagramComponent as never, {
      stopEvent: ({ event }) => {
        // 编辑态:让 textarea/按钮独占键鼠事件,别被 PM 抢走。
        const target = event.target as HTMLElement | null;
        if (target?.closest(".pm-diagram-edit") || target?.closest(".pm-diagram-view-actions")) {
          if (event.type.startsWith("key") || event.type.startsWith("mouse") || event.type === "input" || event.type === "click" || event.type === "focus" || event.type === "blur" || event.type.startsWith("composition")) {
            return true;
          }
        }
        return false;
      },
    });
  },

  addCommands() {
    return {
      insertDiagram:
        (attrs) =>
        ({ commands }) =>
          {
            const lang = attrs?.lang ?? "mermaid";
            const source = attrs?.source ?? (lang === "drawio" ? DEFAULT_DRAWIO_SOURCE : DEFAULT_MERMAID_SOURCE);
            return commands.insertContent({
              type: "diagram",
              attrs: { lang, source, svg: null },
            });
          },
    };
  },

  addKeyboardShortcuts() {
    return {
      // 整块选中图表(NodeSelection)时按 Enter:在图表后插入空段并把光标放进去。
      // 治"选中图表回车打字、光标跳到文末"——atom 块的默认 Enter 处理不稳,这里显式接管。
      Enter: () => {
        const editor = this.editor;
        const { selection } = editor.state;
        if (!(selection instanceof NodeSelection) || selection.node.type.name !== this.name) {
          return false; // 非"选中本图表"态,交回默认处理
        }
        const insertPos = selection.to; // 图表块之后
        return editor
          .chain()
          .insertContentAt(insertPos, { type: "paragraph" })
          .setTextSelection(insertPos + 1)
          .scrollIntoView()
          .run();
      },
    };
  },
});

function parseJsonAttr(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyJsonAttr(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function isVisualDiagramType(type: DiagramType | null): boolean {
  return type === "flowchart" || type === "state" || type === "er" || type === "class" || type === "mindmap";
}
