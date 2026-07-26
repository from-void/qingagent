// 方案4:首页一侧的「核心动效」舞台。
// 卡飞(morph)+ 墨水渗染/退去(inkWipe)+ 玄青夜空/墨尘(space/dust)整段在首页跑完;
// forward 跑到「卡落定 + 背景已深」的静止帧后回调 → 调用方此刻才切路由(#/new);
// return 由首页挂载后跑反向(卡飞回新建卡固定位 + 墨退回宣纸)settle 成正常首页。
//
// 复用与新建页完全相同的引擎(inkWipe/dust)与 CSS class(ccx-space/ccx-dust/ccx-ink/
// ccx-morph),所以首页最后一帧的卡盒/背景深度 = 新建页第一帧 → 切换肉眼无缝。

import { createInkWipe } from "./inkWipe";
import type { InkWipeHandle } from "./inkWipe";
import { createDust } from "./dust";
import type { DustController } from "./dust";
import { buildCardTextures } from "./textures";

export interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type StageRectTarget = StageRect | (() => StageRect);

export interface HomeTransitionStage {
  /**
   * forward:首页跑核心动效(墨渗 + 卡从 from 飞到 to + 背景变深),
   * 到达「卡落定 + 背景已深」静止帧时 resolve。调用方 resolve 后再切路由。
   */
  playForward: (
    from: StageRect,
    to: StageRectTarget,
    inkOrigin: { x: number; y: number },
    // plain=true:点击瞬间先把飞卡切成纯净(去噪点/边框/角标),与工作区文档纸一致,再形变
    plain?: boolean,
  ) => Promise<StageRect>;
  /**
   * return:首页挂载即「到达态」(卡在 from=落点、背景已深),跑反向核心动效
   * (卡飞回 to=新建卡固定位 + 墨退回宣纸),到达正常首页静止帧时 resolve。
   */
  playReturn: (
    from: StageRect,
    to: StageRect,
    inkOrigin: { x: number; y: number },
    // animate=true(从新建页返回):保留「卡飞回新建卡位 + 墨退回宣纸」的形变动效;
    // animate=false(从文档编辑页返回):不做形变,就地淡出。
    animate?: boolean,
  ) => Promise<void>;
  /**
   * 立即把背景置深、卡静帧停在 rect(返回到达态首帧,零入场动画)。
   * plain=true(从文档编辑页返回):这一帧起就是纯净纸 —— 否则会先 paint 出一两帧
   * 新建卡皮(噪点/棕框/朱砂角标)再被 playReturn 切掉。
   */
  snapArrived: (rect: StageRect, plain?: boolean) => void;
  dispose: () => void;
}

const EASE_CUBIC = (p: number) =>
  p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
const INK_HANDOFF_MS = 180;
// 背景置深的兜底时刻(去程)。正常路径由墨渗进度触发(easeInOutCubic 到 0.82 约在 710ms),
// 这里略晚一点点,正常时不改变观感;墨渗因任何原因没推进(WebGL 首帧卡在驱动编译、掉帧、
// 上下文丢失、GPU 不可用)时就由它把背景置深 —— 否则会出现「纸已飞到落点、背景还是首页浅底」。
const DARK_FALLBACK_MS = 780;
// 文档编辑页返回:纸下滑收起的时长(位移略长于淡出,收尾时纸已透明、动势仍在)。
// 收起是「离开」动作,要利落 —— 520ms 实测偏拖沓,收到 340ms。
const RETURN_SLIDE_MS = 340;
const RETURN_SLIDE_FADE_MS = 300;

/**
 * 在 host(首页根容器)内挂出固定覆盖层(space/dust/ink/morph),返回过渡控制器。
 * 这些层与新建页同名同样式,position:fixed 覆盖整屏,脱离首页画框。
 */
export function createHomeTransitionStage(host: HTMLElement): HomeTransitionStage {
  const textures = buildCardTextures();

  // —— 玄青夜空背景 ——
  const space = document.createElement("div");
  space.className = "ccx-space";
  // —— 墨尘 canvas ——
  const dustCanvas = document.createElement("canvas");
  dustCanvas.className = "ccx-dust";
  // —— 墨水 reveal canvas ——
  const inkCanvas = document.createElement("canvas");
  inkCanvas.className = "ccx-ink";
  // —— morph 飞卡(与新建页 .ccx-morph 同构) ——
  const morph = document.createElement("div");
  morph.className = "ccx-morph";
  morph.innerHTML =
    `<div class="ccx-morph-noise"></div>` +
    `<div class="ccx-morph-frame"></div>` +
    `<i class="ccx-morph-corner tl"></i>` +
    `<i class="ccx-morph-corner br"></i>`;
  const noiseEl = morph.querySelector<HTMLElement>(".ccx-morph-noise");
  if (noiseEl) noiseEl.style.background = `${textures.noise} repeat`;

  // host 上加 ccx-page 状态钩子(复用 is-dark / is-ink-wipe 的 CSS 切换)。
  // ⚠️ 这一句只是防御(幂等):若 host 的 className 由 React 用整串模板控制,光靠这里挂不住 ——
  // 任何一次重渲染都会把它擦掉,而深底规则 .qj-root.ccx-stage-host.is-dark .ccx-space 就此
  // 永不匹配(背景不再变深,露出首页浅底)。调用方必须把 ccx-stage-host 写进自己的 className,
  // 见 QingjianScroll 根元素。
  host.classList.add("ccx-stage-host");
  host.appendChild(space);
  host.appendChild(dustCanvas);
  host.appendChild(inkCanvas);
  host.appendChild(morph);

  let ink: InkWipeHandle | null = null;
  function ensureInk() {
    if (ink) return ink;
    try {
      ink = createInkWipe(inkCanvas);
    } catch {
      ink = null;
    }
    return ink;
  }
  let dust: DustController | null = null;
  try {
    dust = createDust(dustCanvas);
  } catch {
    dust = null;
  }

  function setMorphRect(r: StageRect, lift = 0, extra = "") {
    morph.style.transition = "none";
    morph.style.width = r.width + "px";
    morph.style.height = r.height + "px";
    morph.style.transform = `translate(${r.left}px,${r.top + lift}px)${extra}`;
    morph.style.opacity = "1";
  }

  // morph 飞行补间(与新建页 runMorph 同款弧线:升起 + 透视微转 + skew)
  function tweenMorph(
    from: StageRect,
    to: StageRect,
    dur: number,
    onDone?: () => void,
  ) {
    morph.style.transition = "none";
    morph.style.width = from.width + "px";
    morph.style.height = from.height + "px";
    morph.style.opacity = "1";
    const t0 = performance.now();
    const tick = (now: number) => {
      let p = (now - t0) / dur;
      if (p > 1) p = 1;
      const e = EASE_CUBIC(p);
      const x = from.left + (to.left - from.left) * e;
      const y = from.top + (to.top - from.top) * e;
      const w = from.width + (to.width - from.width) * e;
      const h = from.height + (to.height - from.height) * e;
      const sx = w / from.width;
      const sy = h / from.height;
      const arc = Math.sin(p * Math.PI);
      const rotY = arc * (to.left > from.left ? 14 : -14);
      const skY = arc * -3.5;
      const lift = -arc * 46;
      morph.style.transform =
        `translate(${x}px,${y + lift}px) scale(${sx},${sy}) ` +
        `perspective(1100px) rotateX(4deg) rotateY(${rotY}deg) skewY(${skY}deg)`;
      if (p < 1) requestAnimationFrame(tick);
      else onDone?.();
    };
    requestAnimationFrame(tick);
  }

  // 去程「背景置深」的兜底定时器。放 stage 作用域(而非 playForward 局部)是为了 dispose 能取消 ——
  // 否则转场中途卸载首页,定时器仍会把 is-dark 加回已清理的 host 上。
  let darkFallbackTimer = 0;
  function cancelDarkFallback() {
    if (darkFallbackTimer) {
      window.clearTimeout(darkFallbackTimer);
      darkFallbackTimer = 0;
    }
  }

  function darkOn(animate = false) {
    host.classList.toggle("is-dark-anim", animate);
    host.classList.add("is-dark");
    dust?.start();
  }
  function darkOff() {
    host.classList.remove("is-dark", "is-dark-anim");
    dust?.stop();
  }

  function fadeOutForwardInk(): Promise<void> {
    const renderedInk = inkCanvas.nextElementSibling;
    if (!(renderedInk instanceof HTMLCanvasElement) || !renderedInk.classList.contains("ccx-ink")) {
      ink?.hide();
      return Promise.resolve();
    }

    // 共享引擎把真实 WebGL canvas 接在占位 canvas 后；仅去程在同色 CSS 桌面上淡出交接。
    renderedInk.style.transition = `opacity ${INK_HANDOFF_MS}ms ease`;
    void renderedInk.offsetWidth;
    renderedInk.classList.remove("active");
    return new Promise((resolve) => {
      window.setTimeout(() => {
        ink?.hide();
        renderedInk.style.transition = "";
        resolve();
      }, INK_HANDOFF_MS);
    });
  }

  function playForward(
    from: StageRect,
    to: StageRectTarget,
    inkOrigin: { x: number; y: number },
    plain = false,
  ): Promise<StageRect> {
    return new Promise((resolve) => {
      // plain:点击那一瞬间先把飞卡切成纯净(无噪点/边框/角标),和工作区文档纸一致,再开始形变
      morph.classList.toggle("ccx-morph-plain", plain);
      // morph 起点 = 新建卡固定位
      setMorphRect(from);
      const ox = inkOrigin.x / window.innerWidth;
      const oy = inkOrigin.y / window.innerHeight;

      let morphDone = false;
      let inkDone = false;
      const readTarget = () => (typeof to === "function" ? to() : to);
      // 起飞前先实测一次。终帧还会再测一次，覆盖 1100ms 转场期间的 resize。
      const initialTarget = readTarget();
      // 到点无条件置深,与墨渗进度触发取先到者(详见 DARK_FALLBACK_MS)。
      cancelDarkFallback();
      darkFallbackTimer = window.setTimeout(() => {
        darkFallbackTimer = 0;
        darkOn(true);
      }, DARK_FALLBACK_MS);
      const tryResolve = () => {
        if (morphDone && inkDone) {
          cancelDarkFallback();
          // 卡落定 + 背景已深的静止帧:重新实测目标纸壳，确保 resize 后仍与
          // 工作区首帧逐像素同位；setMorphRect 保持 transition:none，不靠动画糊对齐。
          const settledTarget = readTarget();
          setMorphRect(settledTarget);
          resolve(settledTarget);
        }
      };

      const inkHandle = ensureInk();
      if (inkHandle && inkHandle.ok) {
        host.classList.add("is-ink-wipe");
        inkHandle
          .play([ox, oy], 1100, false, (e) => {
            if (e > 0.82) {
              cancelDarkFallback();
              darkOn(true);
            }
          })
          .then(async () => {
            cancelDarkFallback();
            darkOn(true);
            await fadeOutForwardInk();
            inkDone = true;
            tryResolve();
          });
      } else {
        // WebGL 不可用:直接置深背景(无墨)
        cancelDarkFallback();
        darkOn(true);
        inkDone = true;
      }

      tweenMorph(from, initialTarget, 1100, () => {
        morphDone = true;
        tryResolve();
      });
    });
  }

  function snapArrived(rect: StageRect, plain = false) {
    // 返回到达态首帧(必须在 paint 前调):背景瞬时已深(is-ink-wipe 让 .ccx-space 无慢渐显,
    // is-dark 令其 opacity:1 立即满深,纯 CSS 渐变即可,无需 WebGL 墨层)、卡静停落点。
    // 这一帧 = 离开前的最后一帧(卡同 rect + 深背景)→ 切换瞬间不跳、不闪、不漏白。
    // plain 必须在这里定:双 rAF 之后才跑的 playReturn 已经晚了一两帧,那两帧会 paint 出
    // 新建卡皮。从文档编辑页返回时 morph 只当文档纸用,故首帧即纯净纸。
    host.classList.remove("is-dark-anim");
    host.classList.add("is-ink-wipe");
    host.classList.add("is-dark");
    dust?.start();
    morph.classList.toggle("ccx-morph-plain", plain);
    setMorphRect(rect);
  }

  // 返回首页,按来源分流:
  //  · animate=false(文档编辑页返回):不做"卡飞回卡片位置"的形变(落点常不稳/找不到),
  //    纸停在工作区文档落点、往下滑出视口收起,深背景与墨层同步平滑退去,首页内容随后淡入。
  //  · animate=true(新建页返回):保留原动效——卡飞回新建卡固定位 + 墨退回宣纸。
  function playReturn(
    from: StageRect,
    to: StageRect,
    _inkOrigin: { x: number; y: number },
    animate = false,
  ): Promise<void> {
    return new Promise((resolve) => {
      cancelDarkFallback(); // 返程要变浅,别让去程遗留的兜底又把背景置深
      host.classList.remove("is-ink-wipe");
      ensureInk()?.hide(); // 收起墨层,不再播放渗墨锋面
      darkOff(); // 深背景平滑退去(.ccx-space 自带过渡)

      if (!animate) {
        // 文档编辑页返回:纸停在原文档纸落点,往下滑出视口收起(纸被收走的动向)。
        //
        // 纯净纸兜底(幂等)。返程的 morph 是首页重新挂载时新建的元素 —— 去程那次
        // playForward(plain=true) 的 class 随旧 stage 一起销毁了,不带 plain 就会露出
        // .ccx-morph 的新建卡皮(#efe9dd 底 + 噪点 + 棕色双边框 + 朱砂角标)。
        // 正常路径由 snapArrived(rect, true) 在到达态首帧就切好,这里只兜「没走 snapArrived」。
        morph.classList.add("ccx-morph-plain");
        setMorphRect(from);
        void morph.offsetWidth; // setMorphRect 写了 transition:none,强制回流让下面的过渡真的生效
        morph.style.transition =
          `transform ${RETURN_SLIDE_MS}ms cubic-bezier(0.32, 0, 0.67, 0),` +
          ` opacity ${RETURN_SLIDE_FADE_MS}ms ease`;
        requestAnimationFrame(() => {
          // 纸顶滑到视口下沿 = 整张纸滑出屏幕;与 darkOff() 的背景转浅同时进行。
          morph.style.transform = `translate(${from.left}px,${window.innerHeight}px)`;
          morph.style.opacity = "0";
        });
        window.setTimeout(resolve, RETURN_SLIDE_MS + 20);
        return;
      }

      // 新建页返回:卡从落点飞回新建卡固定位(与去程同款弧线),落定后淡出。
      tweenMorph(from, to, 760, () => {
        setMorphRect(to); // 精确停在新建卡位(去弧线残留)
        morph.style.transition = "opacity 0.34s ease";
        requestAnimationFrame(() => {
          morph.style.opacity = "0";
        });
        window.setTimeout(resolve, 360);
      });
    });
  }

  function dispose() {
    cancelDarkFallback();
    ink?.dispose();
    dust?.dispose();
    host.classList.remove("ccx-stage-host", "is-dark", "is-dark-anim", "is-ink-wipe");
    space.remove();
    dustCanvas.remove();
    inkCanvas.remove();
    morph.remove();
  }

  return { playForward, playReturn, snapArrived, dispose };
}
