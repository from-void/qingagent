// 首页 ⇄ 工作区的过场到达态交接:核心动效(纸飞+墨水变深)在一侧跑完后,
// 把「已到达态」经 sessionStorage 交给另一侧直接静帧渲染,切页肉眼无缝。
// home-arrive = 返回到达态(首页挂载即:纸在落点、背景已深,再由首页跑反向核心动效)。
// workspace-arrive = 进场到达态(工作区挂载即静帧,零入场动画)。
import {
  measureWorkspacePaperRect,
  WORKSPACE_PAPER_GEOMETRY,
} from "../workspacePaperGeometry";

const HOME_ARRIVE_KEY = "qingagent:home-arrive";
const WORKSPACE_ARRIVE_KEY = "qingagent:workspace-arrive";
export interface ReturnRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ───────────────────────────────────────────────────────────────────────────
// 到达态交接
// ───────────────────────────────────────────────────────────────────────────

/** 返回:工作区淡出额外元素、只留纸+深背景后调用,把到达态交回首页。 */
export interface HomeArrive {
  /** 当前顶层卡的屏幕 rect(返回核心动效的起点)。 */
  rect: ReturnRect;
  /** 墨退中心(viewport 像素)。 */
  x: number;
  y: number;
  /** 从编辑页返回时，用来找回首页里对应的文章卡。 */
  sessionId?: string;
  source?: "workspace";
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

/**
 * 计算编辑页奶白文档纸的 viewport rect。
 *
 * 主路径不再闭式猜测：无显式 viewport 参数时，直接实测真实纸壳或同构 DOM 探针，
 * 把浏览器实际 scrollbar-gutter 计入 width/left。显式传 vw/vh 仅供无 DOM 环境与
 * 纯函数测试兜底，数值同样来自 WORKSPACE_PAPER_GEOMETRY 单源。
 */
export function computeWorkspaceDocRect(
  vw?: number,
  vh?: number,
): ReturnRect {
  if (vw === undefined && vh === undefined) {
    const measured = measureWorkspacePaperRect();
    if (measured) return measured;
  }

  const viewportWidth =
    vw ?? (typeof window === "undefined" ? 1280 : window.innerWidth);
  const viewportHeight =
    vh ?? (typeof window === "undefined" ? 720 : window.innerHeight);
  const {
    bodyPaddingInline,
    chatColumnWidth,
    columnGap,
    paperColumnWidth,
    paperTopOffset,
  } = WORKSPACE_PAPER_GEOMETRY;

  if (
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0 ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= paperTopOffset
  ) {
    // 极端冷载/测试环境拿不到有效 viewport 时，退到屏幕中央的可见纸面，避免交接 rect 为 NaN/负高。
    const safeVw =
      Number.isFinite(viewportWidth) && viewportWidth > 0
        ? viewportWidth
        : 1280;
    const safeVh =
      Number.isFinite(viewportHeight) && viewportHeight > 0
        ? viewportHeight
        : 720;
    const width = Math.min(
      paperColumnWidth,
      Math.max(1, safeVw - bodyPaddingInline * 2),
    );
    const top = Math.min(
      paperTopOffset,
      Math.max(0, Math.round(safeVh * 0.08)),
    );
    return {
      left: Math.round((safeVw - width) / 2),
      top,
      width,
      height: Math.max(1, safeVh - top),
    };
  }
  // 无 DOM 的兜底仍复刻 CSS safe-center：放得下居中，放不下靠左由 .ws-body 横向滚动。
  const groupW = chatColumnWidth + columnGap + paperColumnWidth;
  const avail = viewportWidth - bodyPaddingInline * 2;
  const leftMargin =
    bodyPaddingInline + Math.max(0, (avail - groupW) / 2);
  return {
    left: Math.round(leftMargin + chatColumnWidth + columnGap),
    top: paperTopOffset,
    width: paperColumnWidth,
    height: viewportHeight - paperTopOffset,
  };
}
