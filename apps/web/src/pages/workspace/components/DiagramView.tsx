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
import { useToast } from "../../../system";
import { renderMermaid } from "./mermaidRender";
import { renderDrawio } from "./drawioRender";
import { openDrawioEditor } from "./drawioEditorLauncher";
import { DiagramSvgView } from "./MermaidPreview";
import { DiagramRenderer } from "./diagram/DiagramRenderer";
import "./DiagramView.css";

// 图表块(diagram)的 Tiptap 节点 + 节点视图:
// - 承载 { lang:"mermaid"|"drawio", source, svg };客户端离线渲染并回写安全 svg(供导出)。
// - 用户可双击进入源码编辑(textarea + 实时预览),"完成"后持久化 source+svg。
// - 渲染失败显示错误 + 源码,绝不让坏图表把编辑器搞崩。
// - 渲染口径与只读/审阅态共用 mermaidRender + DiagramSvgView(全屏/尺寸一致)。

function DiagramComponent({ node, updateAttributes, deleteNode, editor, selected, getPos }: NodeViewProps) {
  const toast = useToast();
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
  const [drawioEditorOpening, setDrawioEditorOpening] = useState(false);
  const [svg, setSvg] = useState<string | null>(cachedSvg);
  const [error, setError] = useState<string | null>(null);
  const [editable, setEditable] = useState(editor?.isEditable ?? false);
  const editableRef = useRef(editable);
  const mountedRef = useRef(true);
  const renderTokenRef = useRef(0);
  const renderedSourceRef = useRef<string | null>(cachedSvg ? attrSource.trim() : null);
  const editingRef = useRef(false);
  const viewRef = useRef<HTMLDivElement>(null);
  // 双击手势第一次按下前,本块是否已经是 NodeSelection。diagram 可拖拽,ProseMirror 会在
  // mousedown 阶段先完成选中;若等 click 再看当前选区,会丢失"冷双击前未选中"这个事实。
  const selectedBeforeMouseDownRef = useRef(false);
  const diagramType = lang === "mermaid" ? detectType(source) : null;
  const supportsVisualEdit = editable && (lang === "drawio" || isVisualDiagramType(diagramType));
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
    if (!editor) return;
    const syncEditable = () => {
      const next = editor.isEditable;
      if (editableRef.current === next) return;
      editableRef.current = next;
      setEditable(next);
    };
    syncEditable();
    // TipTap setEditable() 会发 update 而不是 transaction；NodeView 本身不会因这次
    // options 变化重渲染，所以显式订阅，才能在生成/审阅只读态结束后补写 SVG 缓存。
    editor.on("update", syncEditable);
    return () => {
      editor.off("update", syncEditable);
    };
  }, [editor]);

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
        renderedSourceRef.current = null;
        setSvg(null);
        setError(null);
        return;
      }
      try {
        const out = await (lang === "drawio" ? renderDrawio(trimmed) : renderMermaid(trimmed));
        if (!mountedRef.current || token !== renderTokenRef.current) return;
        renderedSourceRef.current = trimmed;
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
  // 生成/审阅期间 editor 常为只读：那时可以显示 SVG，但不能持久化。切回可编辑态后
  // 必须再跑一次并补写 attrs.svg，否则服务端 HTML/PDF/Word 导出只能拿到 null 并回退源码。
  useEffect(() => {
    if (editing) return;
    if (cachedSvg && source === draft) {
      renderedSourceRef.current = source.trim();
      setSvg(cachedSvg);
      return;
    }
    // 只读态已经为同一份源码渲染成功时直接复用内存中的安全 SVG；切回可编辑的
    // 当拍就写 attrs，避免为了持久化再跑一遍 maxGraph，也消除用户立即导出时的竞态。
    if (editable && svg && renderedSourceRef.current === source.trim()) {
      if (svg !== node.attrs.svg) updateAttributes({ svg });
      return;
    }
    void renderInto(source, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, editing, editable]);

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
    if (lang === "drawio") {
      if (drawioEditorOpening) return;
      setDrawioEditorOpening(true);
      setError(null);
      void openDrawioEditor(source, "drawio 图编辑", (result) => {
        if (!result || !mountedRef.current) return;
        // 「保存」不会关闭 draw.io；每轮原生 SVG 完成加固后立即回写 attrs，并让它
        // 成为本次 source 的首选缓存，避免 view effect 用 maxGraph 结果覆盖高保真导出。
        renderTokenRef.current += 1;
        setSource(result.source);
        setDraft(result.source);
        setSvg(result.svg);
        updateAttributes({ source: result.source, svg: result.svg });
        if (result.warning) {
          toast.show({ message: result.warning, tone: "warn" });
        }
      })
        .catch((openError) => {
          if (mountedRef.current) setError(openError instanceof Error ? openError.message : String(openError));
        })
        .finally(() => {
          if (mountedRef.current) setDrawioEditorOpening(false);
        });
      return;
    }
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
      editor.view.dispatch(editor.state.tr.setSelection(nextSelection));
    }
  };

  const captureSelectionBeforeMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    // 原生双击的第二次 mousedown detail=2;只在第一次按下时取样,避免被 PM 已更新的选区覆盖。
    if (event.detail !== 1) return;
    const pos = typeof getPos === "function" ? getPos() : null;
    const selection = editor.state.selection;
    selectedBeforeMouseDownRef.current =
      typeof pos === "number" && selection instanceof NodeSelection && selection.from === pos;
  };

  return (
    <NodeViewWrapper
      className={`pm-diagram${selected ? " is-selected" : ""}`}
      data-pm-node="diagram"
      data-lang={node.attrs.lang ?? "mermaid"}
      data-align={align}
      onMouseDownCapture={captureSelectionBeforeMouseDown}
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
            // 冷双击开始前块未选中时,本次手势只负责选中;已选中的块才允许双击进编辑。
            if (!selectedBeforeMouseDownRef.current) return;
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
                  disabled={drawioEditorOpening}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={openVisualEdit}
                >
                  {drawioEditorOpening ? "正在打开…" : "可视化编辑"}
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
      insertDiagram: (attrs?: { lang?: PmDiagramLang; source?: string; svg?: string | null }) => ReturnType;
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
              attrs: { lang, source, svg: attrs?.svg ?? null },
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
