import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { NEW_SESSION_TEMPLATES } from "../data/templates";
import type { TemplateEntry, TemplateIconId } from "../data/templates";
import { TemplateIcon } from "./TemplateIcons";

const CARD_W = 300;
const CARD_H = 380;
const VGAP = 58;
const SKEW = 7;
const STEP_DELAY = 2100;
const IDX_LABEL = ["壹", "贰", "叁", "肆"];

function slotTransform(depth: number): string {
  const ty = -CARD_H / 2 + depth * VGAP * 0.42;
  const tx = -CARD_W / 2 + depth * 16;
  const tz = -depth * 60;
  const sk = depth * SKEW * 0.4;
  const sc = 1 - depth * 0.045;
  return `translate(${tx}px,${ty}px) translateZ(${tz}px) rotateX(4deg) skewY(${-sk}deg) scale(${sc})`;
}

export interface FlyRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CardSwapHandle {
  /** 量出顶层卡当前屏幕 rect(用于 morph 飞入落点)。会瞬时禁过渡 reflow 后测量再还原。 */
  topCardRect: () => DOMRect | null;
  pause: () => void;
  resume: () => void;
  /**
   * 提交转场:真实顶卡先快速淡出文字/边框 → 干净纸面,再「掀页」翻转放大到文档落点 `target`,
   * 其余叠卡淡出。返回 Promise,翻转结束后 resolve(由调用方接力切到工作区)。
   */
  flyTopCard: (target: FlyRect) => Promise<void>;
}

export interface CardSwapProps {
  textures: { noise: string; inkTex: string };
  /** 点击顶层卡 → 回填到左侧输入框。 */
  onFill: (tpl: TemplateEntry) => void;
  /** 飞入动画期间隐藏叠卡(morph 接管),完成后显形。 */
  hidden?: boolean;
}

/**
 * 右侧 card-swap 叠卡(4 模板,reactbits 风:3D skew + 垂直错位 + 自动轮换)。
 * hover 顶层卡出说明 ribbon、暂停轮换;点顶层卡回填,点非顶层卡提升到顶。
 */
export const CardSwap = forwardRef<CardSwapHandle, CardSwapProps>(function CardSwap(
  { textures, onFill, hidden },
  ref,
) {
  const swapRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const orderRef = useRef<number[]>([0, 1, 2, 3]);
  const pausedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const cycleLayoutTimerRef = useRef<number | null>(null);
  const cycleFinishTimerRef = useRef<number | null>(null);
  const cyclingCardRef = useRef<number | null>(null);
  // 仅用于强制重渲染 ribbon 的 top 标记(布局本身走命令式 transform)
  const [, force] = useState(0);

  const layout = useCallback(() => {
    orderRef.current.forEach((cardIdx, depth) => {
      const el = cardRefs.current[cardIdx];
      if (!el) return;
      el.style.transform = slotTransform(depth);
      el.style.zIndex = String(40 - depth);
      el.style.opacity = String(1 - depth * 0.12);
      el.classList.toggle("top", depth === 0);
    });
  }, []);

  const cancelCycleTransition = useCallback(
    (restore: boolean) => {
      if (cycleLayoutTimerRef.current != null) {
        window.clearTimeout(cycleLayoutTimerRef.current);
        cycleLayoutTimerRef.current = null;
      }
      if (cycleFinishTimerRef.current != null) {
        window.clearTimeout(cycleFinishTimerRef.current);
        cycleFinishTimerRef.current = null;
      }
      const cyclingCard = cyclingCardRef.current;
      cyclingCardRef.current = null;
      if (!restore || cyclingCard == null) return;
      if (!orderRef.current.includes(cyclingCard)) {
        orderRef.current = [...orderRef.current, cyclingCard];
      }
      const el = cardRefs.current[cyclingCard];
      if (el) el.style.transition = "";
      layout();
    },
    [layout],
  );

  const cycle = useCallback(() => {
    cancelCycleTransition(true);
    const [top, ...rest] = orderRef.current;
    if (top == null) return;
    orderRef.current = rest;
    const el = cardRefs.current[top];
    if (!el) {
      orderRef.current = [...orderRef.current, top];
      return;
    }
    cyclingCardRef.current = top;
    el.classList.remove("top");
    el.style.zIndex = "0";
    el.style.transition = "transform .6s cubic-bezier(.4,0,.55,1), opacity .42s ease";
    el.style.transform = `translate(${-CARD_W / 2}px,${-CARD_H / 2 + 150}px) translateZ(-220px) rotateX(12deg) skewY(0deg) scale(.9)`;
    el.style.opacity = "0";
    cycleLayoutTimerRef.current = window.setTimeout(() => {
      cycleLayoutTimerRef.current = null;
      layout();
    }, 30);
    cycleFinishTimerRef.current = window.setTimeout(() => {
      cycleFinishTimerRef.current = null;
      cyclingCardRef.current = null;
      if (!orderRef.current.includes(top)) {
        orderRef.current = [...orderRef.current, top];
      }
      el.style.transition = "none";
      layout();
      requestAnimationFrame(() => {
        el.style.transition = "";
      });
    }, 420);
  }, [cancelCycleTransition, layout]);

  const startSwap = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      if (!pausedRef.current) cycle();
    }, STEP_DELAY);
  }, [cycle]);

  const stopSwap = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const promoteTo = useCallback(
    (cardIdx: number) => {
      cancelCycleTransition(true);
      orderRef.current = [cardIdx, ...orderRef.current.filter((x) => x !== cardIdx)];
      cardRefs.current.forEach((c) => {
        if (c) c.style.transition = "";
      });
      layout();
      force((n) => n + 1);
    },
    [cancelCycleTransition, layout],
  );

  useImperativeHandle(
    ref,
    (): CardSwapHandle => ({
      topCardRect() {
        const swap = swapRef.current;
        if (!swap) return null;
        cancelCycleTransition(true);
        const topIdx = orderRef.current[0];
        const top = topIdx == null ? null : cardRefs.current[topIdx];
        return top ? top.getBoundingClientRect() : null;
      },
      pause() {
        pausedRef.current = true;
      },
      resume() {
        pausedRef.current = false;
      },
      flyTopCard(target) {
        return new Promise<void>((resolve) => {
          pausedRef.current = true;
          stopSwap();
          cancelCycleTransition(true);
          const swap = swapRef.current;
          const topIdx = orderRef.current[0];
          const el = topIdx == null ? null : cardRefs.current[topIdx];
          if (!swap || !el) {
            resolve();
            return;
          }
          const r = el.getBoundingClientRect(); // 视口 rect(reparent 前测)
          // 1) 其余叠卡淡出 + 顶卡文字/边框/纹理快速淡出 → 干净纸面
          swap.classList.add("is-flying");
          el.classList.add("flying", "content-out");
          // 2) ⚠️ 祖先 .ccx-right 有 perspective → position:fixed 的包含块会变成它,大屏 + 3D 变换下
          //    落点算崩。直接把卡片挂到 document.body(脱离 perspective),position:fixed 即纯视口坐标。
          document.body.appendChild(el);
          el.style.transition = "none";
          el.style.position = "fixed";
          el.style.margin = "0";
          el.style.left = `${r.left}px`;
          el.style.top = `${r.top}px`;
          el.style.width = `${r.width}px`;
          el.style.height = `${r.height}px`;
          el.style.transform = "none";
          el.style.transformOrigin = "50% 50%";
          el.style.zIndex = "60";
          el.style.opacity = "1";
          // 掀页:从卡片态(translate 回原位 + 缩小 + 绕纵轴翻面)→ 文档态(归位铺平,纯视口坐标)
          const p = target;
          const us = r.height / p.height;
          const pcx = p.left + p.width / 2;
          const pcy = p.top + p.height / 2;
          const ux = r.left + r.width / 2 - pcx;
          const uy = r.top + r.height / 2 - pcy;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
            // 落地后清理孤儿卡(编辑页同位奶白纸已接管;延迟移除避免切路由瞬间露空)
            window.setTimeout(() => {
              try {
                el.remove();
              } catch {
                /* 已被移除 */
              }
            }, 650);
          };
          // 等文字淡净(.15s)后再把卡片铺到文档落点并翻转
          window.setTimeout(() => {
            if (!(el as HTMLElement).animate) {
              finish();
              return;
            }
            el.style.transition = "none";
            el.style.left = `${p.left}px`;
            el.style.top = `${p.top}px`;
            el.style.width = `${p.width}px`;
            el.style.height = `${p.height}px`;
            const anim = el.animate(
              [
                {
                  transform: `translate(${ux}px,${uy}px) perspective(1400px) rotateY(-95deg) scale(${us})`,
                  opacity: 0.85,
                },
                {
                  transform: `translate(${ux * 0.3}px,${uy * 0.3}px) perspective(1400px) rotateY(-32deg) scale(${us + (1 - us) * 0.6})`,
                  opacity: 1,
                  offset: 0.5,
                },
                {
                  transform: "translate(0,0) perspective(1400px) rotateY(5deg) scale(1.02)",
                  offset: 0.82,
                },
                {
                  transform: "translate(0,0) perspective(1400px) rotateY(0deg) scale(1)",
                },
              ],
              { duration: 1000, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" },
            );
            anim.onfinish = finish;
            // 兜底:动画异常未触发 onfinish 时也放行
            window.setTimeout(finish, 1100);
          }, 160);
        });
      },
    }),
    [cancelCycleTransition, stopSwap],
  );

  useEffect(() => {
    layout();
    startSwap();
    return () => {
      stopSwap();
      cancelCycleTransition(false);
    };
  }, [cancelCycleTransition, layout, startSwap, stopSwap]);

  return (
    <div
      ref={swapRef}
      className="ccx-swap"
      style={{ visibility: hidden ? "hidden" : "visible" }}
    >
      {NEW_SESSION_TEMPLATES.map((tpl, i) => (
        <div
          key={tpl.name}
          ref={(el) => {
            cardRefs.current[i] = el;
          }}
          className="ccx-tcard"
          data-i={i}
          onMouseEnter={() => {
            pausedRef.current = true;
          }}
          onMouseLeave={() => {
            pausedRef.current = false;
          }}
          onClick={() => {
            const el = cardRefs.current[i];
            if (el?.classList.contains("top")) onFill(tpl);
            else promoteTo(i);
          }}
        >
          <div
            className="ccx-tx"
            style={{ background: `${textures.noise} repeat` }}
          />
          <div className="ccx-fr" />
          <i className="ccx-cn tl" />
          <i className="ccx-cn br" />
          <div className="ccx-bd">
            <div className="ccx-top">
              <span className="ccx-idx">{IDX_LABEL[i]}</span>
              <span className="ccx-ticon">
                <TemplateIcon id={tpl.icon as TemplateIconId} />
              </span>
            </div>
            <div className="ccx-meta">
              <div className="ccx-sub">{tpl.sub}</div>
              <div className="ccx-desc">{tpl.use}</div>
              <button
                type="button"
                className="ccx-adopt"
                onClick={(e) => {
                  e.stopPropagation();
                  onFill(tpl);
                }}
              >
                采用
              </button>
            </div>
          </div>
          <div className="ccx-tname">{tpl.name}</div>
        </div>
      ))}
    </div>
  );
});
