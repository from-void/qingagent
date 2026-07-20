// 方案4:核心动效(卡飞+墨水变深)在首页跑完后,把「已到达态」交给新建页直接静帧渲染。
// arrive = 进场到达态(新建页挂载即:背景已深、卡在落点,零入场动画,只淡入额外元素)。
// home-arrive = 返回到达态(首页挂载即:卡在落点、背景已深,再由首页跑反向核心动效)。
const NP_ARRIVE_KEY = "qingagent:np-arrive";
const HOME_ARRIVE_KEY = "qingagent:home-arrive";
const WORKSPACE_ARRIVE_KEY = "qingagent:workspace-arrive";
// 新建页右侧顶层模板卡的「落点 rect」。首次由首页用 CSS 几何解析推算,
// 新建页挂载后用真实测量值回写(覆盖解析估计)→ 之后每次进场都像素级对齐。
const NP_LANDING_KEY = "qingagent:np-landing-rect";
export interface ReturnRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ───────────────────────────────────────────────────────────────────────────
// 方案4:到达态交接 + 落点 rect 确定化
// ───────────────────────────────────────────────────────────────────────────

/** 进场到达态载荷:落点 rect + 墨水起点(点击点)。新建页挂载时静帧渲染用。 */
export interface NpArrive {
  rect: ReturnRect;
  /** 墨水渗染中心(viewport 像素),用于返回时墨退起点对齐。 */
  x: number;
  y: number;
}

/** 首页核心动效跑完、卡落定+背景已深的那一刻调用:把到达态交给新建页。 */
export function setNpArrive(arrive: NpArrive): void {
  try {
    sessionStorage.setItem(NP_ARRIVE_KEY, JSON.stringify(arrive));
  } catch {
    /* ignore */
  }
}

/**
 * 读取进场到达态。⚠️ peek 语义:**不**清除 —— 避开 StrictMode 双挂载时
 * 第一次(被丢弃的)挂载就把到达态消费掉、真正存活的第二次挂载读到 null 退回兜底。
 * 清除交给 clearNpArrive,在到达态编排真正提交后再调。
 */
export function peekNpArrive(): NpArrive | null {
  try {
    const raw = sessionStorage.getItem(NP_ARRIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NpArrive;
    if (!parsed?.rect || typeof parsed.rect.left !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearNpArrive(): void {
  try {
    sessionStorage.removeItem(NP_ARRIVE_KEY);
  } catch {
    /* ignore */
  }
}

/** 返回:新建页淡出额外元素、只留卡+深背景后调用,把到达态交回首页。 */
export interface HomeArrive {
  /** 当前顶层卡的屏幕 rect(返回核心动效的起点)。 */
  rect: ReturnRect;
  /** 墨退中心(viewport 像素)。 */
  x: number;
  y: number;
  /** 从编辑页返回时，用来找回首页里对应的文章卡。 */
  sessionId?: string;
  source?: "new-session" | "workspace";
}

export function setHomeArrive(arrive: HomeArrive): void {
  try {
    sessionStorage.setItem(HOME_ARRIVE_KEY, JSON.stringify(arrive));
  } catch {
    /* ignore */
  }
}

/**
 * 读取返回到达态。⚠️ peek 语义(同上,防 StrictMode 双挂载误消费)。
 * 清除交给 clearHomeArrive,在反向核心动效真正启动后再调。
 */
export function peekHomeArrive(): HomeArrive | null {
  try {
    const raw = sessionStorage.getItem(HOME_ARRIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HomeArrive;
    if (!parsed?.rect || typeof parsed.rect.left !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearHomeArrive(): void {
  try {
    sessionStorage.removeItem(HOME_ARRIVE_KEY);
  } catch {
    /* ignore */
  }
}

export interface WorkspaceArrive {
  rect: ReturnRect;
  x: number;
  y: number;
  sessionId?: string | null;
}

export function setWorkspaceArrive(arrive: WorkspaceArrive): void {
  try {
    sessionStorage.setItem(WORKSPACE_ARRIVE_KEY, JSON.stringify(arrive));
  } catch {
    /* ignore */
  }
}

export function peekWorkspaceArrive(): WorkspaceArrive | null {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_ARRIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceArrive;
    if (
      !parsed?.rect ||
      typeof parsed.rect.left !== "number" ||
      (parsed.sessionId != null && typeof parsed.sessionId !== "string")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearWorkspaceArrive(): void {
  try {
    sessionStorage.removeItem(WORKSPACE_ARRIVE_KEY);
  } catch {
    /* ignore */
  }
}

/** 回写新建页真实测得的落点 rect(覆盖首页解析估计)→ 下次进场像素级对齐。 */
export function setNpLandingRect(rect: ReturnRect): void {
  try {
    sessionStorage.setItem(NP_LANDING_KEY, JSON.stringify(rect));
  } catch {
    /* ignore */
  }
}

function readStoredLandingRect(): ReturnRect | null {
  try {
    const raw = sessionStorage.getItem(NP_LANDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReturnRect;
    if (!parsed || typeof parsed.left !== "number" || typeof parsed.width !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// —— 新建页右侧顶层模板卡的版面常量(与 new-session-qing.css / CardSwap 对齐)——
const LANDING_LEFT_W = 440; // .ccx-left 宽
const LANDING_RIGHT_W = 330; // .ccx-right 宽
const LANDING_CARD_W = 300; // .ccx-tcard 宽(slotTransform 以中心 translate(-150,-190))
const LANDING_CARD_H = 380;

function clampPx(min: number, vwFrac: number, max: number, vw: number): number {
  return Math.max(min, Math.min(max, (vwFrac / 100) * vw));
}

/**
 * 计算新建页右侧顶层模板卡的「落点 rect」(viewport 坐标)。
 * 优先用新建页回写的真实测量值(像素级);否则按 .ccx-newpage 网格 CSS 解析推算:
 *   padding 0 clamp(24px,4vw,56px) / gap clamp(40px,5vw,76px),
 *   内容块 [left 440 | gap | right 330] 在 padding 盒内 place-content:center 居中,
 *   顶层卡以右列中心为锚 translate(-150,-190)。
 * 首页(morph 飞行终点)与新建页(到达态静帧)用同一函数 → 两端落点同值,切换不跳。
 */
// —— 编辑页(工作区)奶白文档纸的落点几何(与 workspace-ink-skin.css 严格对齐)——
// 居中左右组:[左对话 chatW | gap 48 | 右文档纸 docW],整组在 (vw - 80) 内水平居中;
// 纸顶距视口 52(ws-right padding-top),纸宽宽屏封顶 800、窄屏收窄到 360,纸高自顶铺到底(出血)。
// 新建页提交转场用它当顶卡翻转落点 → 翻完结束帧 = 编辑页这张纸初始帧,严丝合缝。
const WS_CHAT_MAX = 400;
const WS_GAP = 48;
const WS_PAD = 40;
const WS_DOC_W = 800;
const WS_DOC_TOP = 52; // = demo TOP_MARGIN:纸顶留一行带,放 doc-topbar 按钮

/** 计算编辑页奶白文档纸的 viewport rect(闭式,匹配 workspace-ink-skin.css 的 flex 居中)。 */
export function computeWorkspaceDocRect(
  vw = window.innerWidth,
  vh = window.innerHeight,
): ReturnRect {
  if (!Number.isFinite(vw) || vw <= 0 || !Number.isFinite(vh) || vh <= WS_DOC_TOP) {
    // 极端冷载/测试环境拿不到有效 viewport 时，退到屏幕中央的可见纸面，避免交接 rect 为 NaN/负高。
    const safeVw = Number.isFinite(vw) && vw > 0 ? vw : 1280;
    const safeVh = Number.isFinite(vh) && vh > 0 ? vh : 720;
    const width = Math.min(WS_DOC_W, Math.max(1, safeVw - WS_PAD * 2));
    const top = Math.min(WS_DOC_TOP, Math.max(0, Math.round(safeVh * 0.08)));
    return {
      left: Math.round((safeVw - width) / 2),
      top,
      width,
      height: Math.max(1, safeVh - top),
    };
  }
  // 左右栏已定宽(workspace-ink-skin.css:.ws-left=400 / .ws-right=800,不再随 vw 收窄)。
  // 这里同步成定宽,保证翻转落点 = 编辑页纸的真实 rect;下面 max(0,(avail-groupW)/2) 即
  // CSS 的 `justify-content: safe center`(放得下居中、放不下靠左由 .ws-body 横向滚动)。
  const chatW = WS_CHAT_MAX;
  const docW = WS_DOC_W;
  const groupW = chatW + WS_GAP + docW;
  const avail = vw - WS_PAD * 2;
  const leftMargin = WS_PAD + Math.max(0, (avail - groupW) / 2);
  return {
    left: Math.round(leftMargin + chatW + WS_GAP),
    top: WS_DOC_TOP,
    width: docW,
    height: vh - WS_DOC_TOP,
  };
}

export function computeNewCardLandingRect(
  vw = window.innerWidth,
  vh = window.innerHeight,
): ReturnRect {
  const stored = readStoredLandingRect();
  if (stored) return stored;
  const pad = clampPx(24, 4, 56, vw);
  const gap = clampPx(40, 5, 76, vw);
  const contentW = LANDING_LEFT_W + gap + LANDING_RIGHT_W;
  const avail = vw - pad * 2;
  const contentLeft = pad + Math.max(0, (avail - contentW) / 2);
  const rightCenterX = contentLeft + LANDING_LEFT_W + gap + LANDING_RIGHT_W / 2;
  const centerY = vh / 2;
  return {
    left: rightCenterX - LANDING_CARD_W / 2,
    top: centerY - LANDING_CARD_H / 2,
    width: LANDING_CARD_W,
    height: LANDING_CARD_H,
  };
}
