import { useEffect, useRef, useState } from "react";
import { isPoisonedMermaidSvg } from "@qingagent/pm-schema";
import { renderMermaid } from "./mermaidRender";
import { isEmptyDrawioSource, renderDrawio } from "./drawioRender";
import { MediaZoomFullscreen } from "./MediaZoomFullscreen";
import "./DiagramView.css";

const MAX_DIAGRAM_SCALE = 5;
const clampScale = (s: number) => Math.min(MAX_DIAGRAM_SCALE, Math.max(1, s));

/**
 * 图表 svg 的展示外壳(编辑态节点视图与只读/审阅态共用):
 * - 默认放大到合适尺寸(svg 填充容器宽度,见 css 覆盖 mermaid 内联 max-width)。
 * - 容器支持上下形变(resize: vertical),svg 内部按比例自适应(preserveAspectRatio)。
 * - 就地双指缩放:触屏双指 pinch / 触控板 ctrl+滚轮 缩放;放大后单指或鼠标拖拽平移;
 *   缩回 1 倍自动复位。不再有 hover 出的「全屏 / 编辑」棕字钮(编辑走双击)。
 */
export function DiagramSvgView({
  svg,
  align,
  onAlignChange,
  onFullscreen,
  showToolbar = false,
}: {
  svg: string;
  title?: string;
  align?: "left" | "center" | "right";
  onAlignChange?: (align: "left" | "center" | "right") => void;
  onFullscreen?: () => void;
  showToolbar?: boolean;
}) {
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const pinchRef = useRef<{ dist: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number; captured: boolean } | null>(null);

  // 工具栏「放大/缩小」按钮:以容器中心为锚点缩放(与 ctrl+滚轮/捏合同一套 zoomAround)。
  const zoomByButton = (factor: number) => {
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  // 以 (clientX,clientY) 为锚点缩放,保持光标/捏合中心下的内容不漂移。
  const zoomAround = (clientX: number, clientY: number, factor: number) => {
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setT((cur) => {
      const ns = clampScale(cur.scale * factor);
      if (ns === cur.scale) return cur;
      if (ns <= 1) return { scale: 1, x: 0, y: 0 };
      const lx = clientX - rect.left;
      const ly = clientY - rect.top;
      const contentX = (lx - cur.x) / cur.scale;
      const contentY = (ly - cur.y) / cur.scale;
      return { scale: ns, x: lx - contentX * ns, y: ly - contentY * ns };
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    // 普通滚轮留给文档滚动;触控板双指捏合 = ctrl+wheel,才用于缩放。
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    zoomAround(e.clientX, e.clientY, e.deltaY < 0 ? 1.08 : 1 / 1.08);
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      pinchRef.current = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
    } else if (e.touches.length === 1 && t.scale > 1) {
      // 触屏平移不走 setPointerCapture,captured 置 true 即可(仅用于满足类型/避免捕获分支)。
      dragRef.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, ox: t.x, oy: t.y, captured: true };
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const cx = (a.clientX + b.clientX) / 2;
      const cy = (a.clientY + b.clientY) / 2;
      if (pinchRef.current.dist > 0) zoomAround(cx, cy, dist / pinchRef.current.dist);
      pinchRef.current.dist = dist;
    } else if (e.touches.length === 1 && dragRef.current) {
      e.preventDefault();
      // 同 onPointerMove:快照后再进 updater,避免 touchend 置空 dragRef 后 updater NPE 崩页。
      const drag = dragRef.current;
      const nx = drag.ox + (e.touches[0]!.clientX - drag.x);
      const ny = drag.oy + (e.touches[0]!.clientY - drag.y);
      setT((cur) => ({ ...cur, x: nx, y: ny }));
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) pinchRef.current = null;
    if (e.touches.length === 0) dragRef.current = null;
  };

  // 放大态下鼠标拖拽平移(桌面);1 倍时不拦截,保留双击编辑 / 选区。
  const onPointerDown = (e: React.PointerEvent) => {
    if (t.scale <= 1 || e.button !== 0) return;
    e.stopPropagation();
    // 关键:这里【不】立刻 setPointerCapture。容器内同时挂着工具栏按钮,若一按下就捕获指针,
    // 紧随的 click/dblclick 会被【重定向到容器】(target 不再是按钮)→ 绕过工具栏的 stopPropagation
    // 和"按钮落点"守卫 → 放大态下点两下减号就误进 Mermaid 编辑(用户反馈)。
    // 改为"真正拖动起来(越过阈值)再捕获":纯点击(按下即抬起、不移动)永不捕获,click/dblclick 正常落到按钮。
    dragRef.current = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y, captured: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    // 先把 dragRef 快照成局部值再算位移:setT 的 updater 是异步执行的,若期间 pointerup/cancel
    // 把 dragRef.current 置空,updater 里再读 dragRef.current!.ox 就会 NPE → 整轮渲染抛错被
    // ErrorBoundary 接住整页崩(用户反馈"放大两下往左拖拽就崩")。外层 if 守不住延后执行的 updater。
    const drag = dragRef.current;
    if (!drag || t.scale <= 1) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.captured) {
      // 未越过拖动阈值:既不平移也不捕获,让这次手势可能是"纯点击"→ click/dblclick 落到按钮上。
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.captured = true;
      // 真拖动了再捕获:光标移出容器也能继续平移。setPointerCapture 在某些 Chromium 上对带 transform
      // 的元素会抛 InvalidStateError,失败就降级为容器内平移,绝不炸。
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* 忽略:不影响容器内平移 */
      }
    }
    const nx = drag.ox + dx;
    const ny = drag.oy + dy;
    setT((cur) => ({ ...cur, x: nx, y: ny }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const zoomed = t.scale > 1;
  return (
    <div
      ref={boxRef}
      className="pm-diagram-svg"
      style={{ touchAction: zoomed ? "none" : "pan-y", cursor: zoomed ? "grab" : undefined }}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="pm-diagram-svg-inner"
        style={{
          // 未缩放时不加 transform / will-change:否则 SVG 被提升成合成层栅格化,文字发糊(用户反馈甘特图"好糊")。
          // 仅缩放/平移态(zoomed)才上变换层,此时栅格化无所谓且能让缩放更顺。
          transform: zoomed || t.x !== 0 || t.y !== 0 ? `translate(${t.x}px, ${t.y}px) scale(${t.scale})` : undefined,
          transformOrigin: "0 0",
          willChange: zoomed ? "transform" : undefined,
          transition: pinchRef.current || dragRef.current ? "none" : "transform .12s ease",
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {showToolbar && (
        <div
          className="pm-diagram-svg-viewbar pm-diagram-chrome"
          // 工具栏点击/双击不冒泡:不触发图表块双击进编辑,也不触发画布平移。
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {onAlignChange &&
            (["left", "center", "right"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`pm-diagram-tool${align === opt ? " is-active" : ""}`}
                aria-pressed={align === opt}
                title={opt === "left" ? "左对齐" : opt === "center" ? "居中" : "右对齐"}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onAlignChange(opt);
                }}
              >
                {opt === "left" ? "左" : opt === "center" ? "中" : "右"}
              </button>
            ))}
          {onAlignChange && <span className="pm-diagram-tool-sep" aria-hidden="true" />}
          <button type="button" className="pm-diagram-tool" title="缩小" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); zoomByButton(1 / 1.25); }}>
            −
          </button>
          <button type="button" className="pm-diagram-tool" title="放大" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); zoomByButton(1.25); }}>
            ＋
          </button>
          {onFullscreen && (
            <>
              <span className="pm-diagram-tool-sep" aria-hidden="true" />
              <button type="button" className="pm-diagram-tool pm-diagram-tool--wide" title="全屏查看" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); onFullscreen(); }}>
                ⛶ 全屏
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 只读/审阅态图表预览:有缓存 svg 用缓存,否则按 lang 在客户端渲染 source。
 * 用于审阅/历史/聊天快照等"非可编辑"场景,确保审核态也看到可视化的图而不是源码字符。
 */
export function MermaidPreview({
  source,
  cachedSvg,
  lang = "mermaid",
  readOnly = true,
  align = "center",
  onAlignChange,
}: {
  source: string;
  cachedSvg?: string | null;
  lang?: string;
  readOnly?: boolean;
  align?: "left" | "center" | "right";
  onAlignChange?: (align: "left" | "center" | "right") => void;
}) {
  const emptyDrawio = lang === "drawio" && isEmptyDrawioSource((source ?? "").trim());
  const cachedSvgIsPoisoned = lang === "mermaid" && isPoisonedMermaidSvg(cachedSvg, source);
  const usableCachedSvg = cachedSvgIsPoisoned ? null : cachedSvg;
  const [svg, setSvg] = useState<string | null>(usableCachedSvg ?? null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const mountedRef = useRef(true);
  const tokenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const trimmed = (source ?? "").trim();
    if (!trimmed) {
      setSvg(null);
      setError(null);
      return;
    }
    if (emptyDrawio) {
      setSvg(null);
      setError(null);
      return;
    }
    if (usableCachedSvg) {
      setSvg(usableCachedSvg);
      setError(null);
      return;
    }
    if (lang !== "mermaid" && lang !== "drawio") {
      setError(`暂不支持的图表语言:${lang}`);
      return;
    }
    const token = ++tokenRef.current;
    const render = lang === "drawio" ? renderDrawio : renderMermaid;
    void render(trimmed)
      .then((out) => {
        if (!mountedRef.current || token !== tokenRef.current) return;
        setSvg(out);
        setError(null);
      })
      .catch((e) => {
        if (!mountedRef.current || token !== tokenRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [source, cachedSvg, lang, emptyDrawio]);

  if (error) {
    return (
      <pre className="pm-diagram-error">
        图表渲染失败:{error}
        {"\n\n"}
        {source}
      </pre>
    );
  }
  if (!svg) {
    return <div className="pm-diagram-empty">{emptyDrawio || !source ? "空图表" : "渲染中…"}</div>;
  }
  const editable = !readOnly;
  return (
    <div className="pm-diagram-view pm-diagram-view--readonly">
      <DiagramSvgView
        svg={svg}
        showToolbar={editable}
        align={align}
        onAlignChange={editable ? onAlignChange : undefined}
        onFullscreen={editable ? () => setFullscreen(true) : undefined}
      />
      <MediaZoomFullscreen open={fullscreen} onClose={() => setFullscreen(false)} ariaLabel="图表全屏查看">
        <div className="pm-diagram-zoom-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      </MediaZoomFullscreen>
    </div>
  );
}
