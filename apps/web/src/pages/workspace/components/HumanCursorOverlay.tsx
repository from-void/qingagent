import { useEffect, useRef, useState } from "react";
import {
  approach,
  computeCursorAnchor,
  edgeBubbleX,
  type RectLike,
} from "../data/humanCursorGeometry";
import {
  getHumanCursorConfig,
  subscribeHumanCursorConfig,
  type HumanCursorRuntimeConfig,
} from "../data/humanCursorConfig";
import { laneColor, laneName } from "../data/humanCursorLanes";
import { usePerfTier } from "../../../system/perf/motionTier";

interface HumanCursorOverlayProps {
  /**
   * 当前是否处于"有光标在打字"的阶段(局部修改 reveal 或全文生成 drafting)。
   * 为 true 时启动 rAF,每帧扫描 DOM 上的 `data-hc-lane` 元素自发现光标。
   */
  active: boolean;
  /** 文档滚动容器(.ws-right) */
  scrollRef: React.RefObject<HTMLElement>;
}

/**
 * 一个 lane = 一个"人"= 屏幕上唯一的一只鼠标(同一 lane 同时只出现一次)。
 * 鼠标按 lane 持久存在,平滑滑向该 lane 当前正在编辑的光标(像真人把手移过去);
 * 该 lane 不再有光标时延迟淡出。
 */
interface LaneCursor {
  lane: number;
  /** 当前平滑屏幕坐标(指数趋近目标,逐帧更新) */
  x: number;
  y: number;
  /** 颜色/名字(从光标 DOM 的 data-hc-* 读;局部修改场景回退到 lane 映射) */
  color: string;
  name: string;
  /** 非 null = 已开始淡出,值为淡出起始时间(= 空闲时刻 + fadeDelay) */
  fadingAt: number | null;
}

interface CursorFrame {
  lane: number;
  x: number;
  y: number;
  color: string;
  name: string;
  opacity: number;
}
interface EdgeFrame {
  lane: number;
  color: string;
  name: string;
}

const FADE_MS = 420;
const LOW_MOTION_FRAME_INTERVAL_MS = 33;

function rectOf(r: DOMRect | RectLike): RectLike {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * 本帧"渲染输出"签名:低端档据此判断输出是否真变(变了才 forceTick),避免漏渲染冻结。
 * 必须覆盖一切影响渲染的量:vp(edge bubble 位置依赖)、每个 cursor 的 lane/取整坐标/颜色/名字/透明度、
 * edge 数组(顺序+lane+颜色+名字,edge x 由索引/长度/vp 在渲染期算)。坐标取整 → 亚像素变化不触发重渲(低端可接受)。
 */
function frameSignature(frame: {
  cursors: CursorFrame[];
  edgeTop: EdgeFrame[];
  edgeBottom: EdgeFrame[];
  vp: RectLike;
}): string {
  const { vp, cursors, edgeTop, edgeBottom } = frame;
  const c = cursors
    .map((x) => `${x.lane}:${Math.round(x.x)}:${Math.round(x.y)}:${x.color}:${x.name}:${x.opacity.toFixed(2)}`)
    .join(",");
  const et = edgeTop.map((e) => `${e.lane}:${e.color}:${e.name}`).join(",");
  const eb = edgeBottom.map((e) => `${e.lane}:${e.color}:${e.name}`).join(",");
  return `${Math.round(vp.left)}:${Math.round(vp.top)}:${Math.round(vp.width)}:${Math.round(vp.height)}|${c}|${et}|${eb}`;
}

/** 从光标 DOM 读出 lane/锚点/颜色/名字。返回 null = 该元素无有效 lane。 */
function readCursorTarget(
  el: Element,
  vp: RectLike,
): { lane: number; anchor: ReturnType<typeof computeCursorAnchor>; color: string; name: string } | null {
  const raw = (el as HTMLElement).dataset.hcLane;
  const lane = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(lane) || lane < 1) return null;
  const anchor = computeCursorAnchor(rectOf(el.getBoundingClientRect()), vp);
  const color = (el as HTMLElement).dataset.hcColor || laneColor(lane);
  const name = (el as HTMLElement).dataset.hcName || laneName(lane);
  return { lane, anchor, color, name };
}

/**
 * 0603 — 拟人鼠标叠加层。覆盖两种场景:局部修改(reveal)+ 全文生成(drafting)。
 * 不依赖 props 传位置,而是每帧扫描文档内带 `data-hc-lane` 的光标 DOM 自发现;
 * 按 lane(人)管理 → 每个名字同时只出现一只;approach 指数趋近 → 丝滑滑向当前编辑处;
 * 该 lane 没光标时延迟淡出,active 结束后全部淡出(不残留)。
 *
 * 性能/正确性:rect 读取与几何全在 rAF 回调里做、结果存 ref,**render 纯函数**;
 * 关闭开关(enabled=false)或非 active 且无残留时 rAF 真正停止。
 */
export function HumanCursorOverlay({ active, scrollRef }: HumanCursorOverlayProps) {
  const perfTier = usePerfTier();
  const [config, setConfig] = useState<HumanCursorRuntimeConfig>(() => getHumanCursorConfig());
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
  );
  useEffect(() => subscribeHumanCursorConfig(setConfig), []);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;

    const onChange = () => setReducedMotion(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // 按 lane 唯一键:保证一个名字同时只有一只鼠标
  const activeRef = useRef<Map<number, LaneCursor>>(new Map());
  const activePropRef = useRef(active);
  activePropRef.current = active;
  const degradedMotionRef = useRef(false);
  degradedMotionRef.current = perfTier === "low" || reducedMotion;
  const frameRef = useRef<{
    cursors: CursorFrame[];
    edgeTop: EdgeFrame[];
    edgeBottom: EdgeFrame[];
    vp: RectLike;
  }>({ cursors: [], edgeTop: [], edgeBottom: [], vp: { left: 0, top: 0, width: 0, height: 0 } });
  const [, forceTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastNowRef = useRef<number | null>(null);
  const lastLowMotionPaintRef = useRef<number | null>(null);
  // 低端档:上一次"已渲染"输出签名。本帧签名与之相同则跳过 forceTick(纯静止),变了才重渲。
  const lastPaintedSigRef = useRef<string | null>(null);

  const startRaf = () => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(tickLoop);
  };

  const tickLoop = () => {
    const cfg = getHumanCursorConfig();
    const scrollEl = scrollRef.current;
    if (!cfg.enabled || !scrollEl) {
      rafRef.current = null;
      return;
    }
    const now = performance.now();
    const degradedMotion = degradedMotionRef.current;
    if (degradedMotion) {
      const lastLowMotionPaintAt = lastLowMotionPaintRef.current;
      if (lastLowMotionPaintAt != null && now - lastLowMotionPaintAt < LOW_MOTION_FRAME_INTERVAL_MS) {
        rafRef.current = requestAnimationFrame(tickLoop);
        return;
      }
      lastLowMotionPaintRef.current = now;
    }
    const lanes = activeRef.current;
    const vp = rectOf(scrollEl.getBoundingClientRect());
    const scanning = activePropRef.current;

    // 1) 扫描当前光标 DOM(仅 active 时找新光标),建立 lane → 目标
    const present = new Map<
      number,
      { anchor: ReturnType<typeof computeCursorAnchor>; color: string; name: string }
    >();
    if (scanning) {
      const els = scrollEl.querySelectorAll("[data-hc-lane]");
      for (const el of els) {
        const t = readCursorTarget(el, vp);
        if (t) present.set(t.lane, { anchor: t.anchor, color: t.color, name: t.name });
      }
    }

    // 2) reconcile:出现的 lane → 建/更新目标并取消淡出;消失的 → 进入淡出
    const vw = vp.width || (typeof window !== "undefined" ? window.innerWidth : 1280);
    const vh = vp.height || (typeof window !== "undefined" ? window.innerHeight : 720);
    for (const [lane, t] of present) {
      const cur = lanes.get(lane);
      if (!cur) {
        // 新鼠标从可视区随机一点丝滑滑入
        lanes.set(lane, {
          lane,
          x: vp.left + Math.random() * vw,
          y: vp.top + Math.random() * vh,
          color: t.color,
          name: t.name,
          fadingAt: null,
        });
      } else {
        cur.color = t.color;
        cur.name = t.name;
        cur.fadingAt = null;
      }
    }
    for (const cur of lanes.values()) {
      if (!present.has(cur.lane) && cur.fadingAt == null) cur.fadingAt = now + cfg.fadeDelayMs;
    }

    // 3) 几何:平滑趋近 + 轻微手抖,输出本帧
    // follow 帧率无关:以 60fps 每帧比例 p0 为基准,按实际 dt 归一化(高刷不会更快、低刷不会更慢);
    // dt 夹到 0.1s 上限 → 后台切回/掉帧时不会一下子瞬移过去(无突兀 snap)。
    const p0 = Math.min(0.32, Math.max(0.012, cfg.driftSpeed * 0.05));
    const dt = lastNowRef.current == null ? 1 / 60 : Math.min(0.1, (now - lastNowRef.current) / 1000);
    lastNowRef.current = now;
    const follow = 1 - Math.pow(1 - p0, dt * 60);
    const wobbleAmp = degradedMotion ? 0 : cfg.jitter * 1.2;
    const cursors: CursorFrame[] = [];
    const edgeTop: EdgeFrame[] = [];
    const edgeBottom: EdgeFrame[] = [];
    for (const [lane, cur] of lanes) {
      // 清理淡出完成
      if (cur.fadingAt != null && now > cur.fadingAt + FADE_MS) {
        lanes.delete(lane);
        continue;
      }
      const opacity =
        cur.fadingAt != null && now > cur.fadingAt
          ? Math.max(0, 1 - (now - cur.fadingAt) / FADE_MS)
          : 1;
      const target = present.get(lane)?.anchor ?? null;
      if (target) {
        cur.x = approach(cur.x, target.x, follow);
        cur.y = approach(cur.y, target.y, follow);
        if (!target.visible) {
          (target.edge === "top" ? edgeTop : edgeBottom).push({
            lane,
            color: cur.color,
            name: cur.name,
          });
          continue;
        }
      }
      const wx = Math.sin(now / 300 + lane) * wobbleAmp;
      const wy = Math.cos(now / 360 + lane * 1.7) * wobbleAmp;
      cursors.push({ lane, x: cur.x + wx, y: cur.y + wy, color: cur.color, name: cur.name, opacity });
    }
    frameRef.current = { cursors, edgeTop, edgeBottom, vp };
    // high 档:每帧 forceTick(逐帧零改)。低端档:仅当"渲染输出"相对上一已渲染帧真变了才 forceTick,
    // 用输出签名比对(而非内部 cur→target 距离),避免慢速小步移动 / visible↔edge 切换被漏渲染冻结。
    if (!degradedMotion) {
      forceTick((t) => (t + 1) % 1_000_000);
    } else {
      const sig = frameSignature(frameRef.current);
      if (sig !== lastPaintedSigRef.current) {
        lastPaintedSigRef.current = sig;
        forceTick((t) => (t + 1) % 1_000_000);
      }
    }

    // 仍 active,或还有残留鼠标(淡出中)→ 继续;否则停
    rafRef.current =
      activePropRef.current || lanes.size > 0 ? requestAnimationFrame(tickLoop) : null;
  };

  // active / enabled 变化 → 起停 rAF
  useEffect(() => {
    if (config.enabled && (active || activeRef.current.size > 0)) startRaf();
    else if (!config.enabled && rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, config.enabled]);

  // 卸载清理
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  if (!config.enabled) return null;
  // 渲染纯函数:只读 frameRef(含 rAF 里算好的 vp),不在渲染相做任何 DOM 读取/getBoundingClientRect。
  const { cursors, edgeTop, edgeBottom, vp } = frameRef.current;
  if (cursors.length === 0 && edgeTop.length === 0 && edgeBottom.length === 0) return null;

  return (
    <div className="human-cursor-layer" aria-hidden="true">
      {cursors.map((c) => (
        <div
          key={`lane-${c.lane}`}
          className="hc-cursor"
          style={{ left: c.x, top: c.y, opacity: c.opacity } as React.CSSProperties}
        >
          <svg className="hc-arrow" width="18" height="18" viewBox="0 0 18 18">
            <path
              d="M2 2 L2 14 L6 10.5 L8.5 16 L10.5 15 L8 9.5 L13 9 Z"
              fill={c.color}
              stroke="#fff"
              strokeWidth="0.8"
            />
          </svg>
          <span className="hc-name" style={{ background: c.color }}>
            {c.name}
          </span>
        </div>
      ))}
      {config.edgeBubble &&
        edgeTop.map((e, i) => (
          <EdgeBubble key={`t-${e.lane}`} frame={e} edge="top" x={edgeBubbleX(i, edgeTop.length, vp)} y={vp.top + 8} />
        ))}
      {config.edgeBubble &&
        edgeBottom.map((e, i) => (
          <EdgeBubble key={`b-${e.lane}`} frame={e} edge="bottom" x={edgeBubbleX(i, edgeBottom.length, vp)} y={vp.top + vp.height - 8} />
        ))}
    </div>
  );
}

function EdgeBubble({
  frame,
  edge,
  x,
  y,
}: {
  frame: EdgeFrame;
  edge: "top" | "bottom";
  x: number;
  y: number;
}) {
  return (
    <div
      className={`hc-edge hc-edge-${edge}`}
      style={{ left: x, top: y, ["--hc"]: frame.color } as React.CSSProperties}
      title={`${frame.name} 在${edge === "top" ? "上方" : "下方"}(超出可视区)`}
    >
      <span className="hc-edge-num">{frame.lane}</span>
    </div>
  );
}
